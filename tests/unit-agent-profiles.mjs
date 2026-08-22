import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROFILES, AGENT_PROFILE_IDS, buildAgentJobPrompt, resolveAgentProfile } from "../src/agent-profiles.js";
import { ASKCLAUDE_FULL_DISALLOWED_TOOLS, resolveDelegationPolicy } from "../src/query-policy.js";

const READ_INVENTORY = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
const FORBIDDEN = ["Bash", "Edit", "Write", "NotebookEdit", "NotebookRead", "Agent", "Task", "MultiEdit"];

function reviewerDiff(overrides = {}) {
	return {
		cwd: "/tmp/project",
		capturedAt: 1_700_000_000_000,
		source: 'working tree at launch vs HEAD abcdef123456 (staged + unstaged changes)',
		headRef: "abcdef123456",
		statusText: " M src/app.ts",
		statusTruncated: false,
		diffText: "diff --git a/src/app.ts b/src/app.ts\n+added line",
		diffTruncated: false,
		...overrides,
	};
}

describe("agent profiles", () => {
	it("derives advisor, explorer, reviewer, and worker roles from capability plus review", () => {
		assert.deepEqual([...AGENT_PROFILE_IDS], ["advisor", "explorer", "reviewer", "worker"]);
		assert.deepEqual(Object.keys(AGENT_PROFILES).sort(), ["advisor", "explorer", "reviewer", "worker"]);
		for (const id of AGENT_PROFILE_IDS) assert.equal(AGENT_PROFILES[id].id, id);
		assert.equal(resolveAgentProfile("none", false).id, "advisor");
		assert.equal(resolveAgentProfile("read", false).id, "explorer");
		assert.equal(resolveAgentProfile("read", true).id, "reviewer");
		assert.equal(resolveAgentProfile("full", false).id, "worker");
		assert.throws(() => resolveAgentProfile("none", true), /requires mode="read"/);
		assert.throws(() => resolveAgentProfile("full", true), /requires mode="read"/);
	});

	it("resolves read-only roles to the explicit read inventory with no mutation or nested-agent tools", () => {
		for (const id of ["explorer", "reviewer"]) {
			const profile = AGENT_PROFILES[id];
			assert.equal(profile.capabilityMode, "read");
			const policy = resolveDelegationPolicy(profile.capabilityMode);
			assert.deepEqual(policy.tools, READ_INVENTORY);
			for (const tool of FORBIDDEN) {
				assert.ok(!policy.tools.includes(tool), `${id} inventory must not include ${tool}`);
			}
		}
	});

	it("resolves the advisor to an empty capability inventory and an honest no-access prompt", () => {
		const profile = AGENT_PROFILES.advisor;
		assert.equal(profile.capabilityMode, "none");
		assert.deepEqual(resolveDelegationPolicy(profile.capabilityMode).tools, []);
		assert.match(profile.rolePrompt, /no repository, filesystem, shell, agent, or web capabilities/i);
		assert.match(profile.rolePrompt, /Do not claim to have inspected/i);
	});

	it("resolves the worker profile to the existing full Claude Code capability policy without hard-coded bypass", () => {
		const profile = AGENT_PROFILES.worker;
		assert.equal(profile.capabilityMode, "full");
		assert.equal(profile.requiresDiffArtifact, false);
		const policy = resolveDelegationPolicy(profile.capabilityMode);
		// The same preset + disallowed list AskClaude full mode uses — no
		// worker-specific tool list.
		assert.deepEqual(policy.tools, { type: "preset", preset: "claude_code" });
		assert.deepEqual(policy.disallowedTools, [...ASKCLAUDE_FULL_DISALLOWED_TOOLS]);
		assert.equal(policy.requestedPermissionMode, "auto");
		assert.equal(policy.allowDangerouslySkipPermissions, undefined);
	});

	it("honors the configured delegation permission mode for the worker policy", () => {
		const policy = resolveDelegationPolicy("full", { permissionMode: "acceptEdits" });
		assert.equal(policy.requestedPermissionMode, "acceptEdits");
		assert.equal(policy.allowDangerouslySkipPermissions, undefined);
	});

	it("gives the worker an explicit current-checkout single-writer and no-git-side-effects contract", () => {
		const prompt = AGENT_PROFILES.worker.rolePrompt;
		assert.match(prompt, /current checkout/i);
		assert.match(prompt, /only writer/i);
		assert.match(prompt, /Do NOT commit, push, open pull requests/);
		assert.match(prompt, /destructive cleanup/i);
		assert.match(prompt, /unless the task explicitly authorizes/i);
	});

	it("builds a worker prompt with launch context and task but no diff section", () => {
		const prompt = buildAgentJobPrompt({
			profile: AGENT_PROFILES.worker,
			task: "Rename the helper",
			launch: { cwd: "/tmp/project", capturedAt: 1_700_000_000_000 },
		});
		assert.ok(prompt.includes(AGENT_PROFILES.worker.rolePrompt));
		assert.ok(prompt.includes("Working directory: /tmp/project"));
		assert.ok(prompt.includes("Task:\nRename the helper"));
		assert.ok(!prompt.includes("Diff artifact"));
	});

	it("gives the profiles distinct role prompts and only the reviewer a diff requirement", () => {
		assert.notEqual(AGENT_PROFILES.explorer.rolePrompt, AGENT_PROFILES.reviewer.rolePrompt);
		assert.match(AGENT_PROFILES.explorer.rolePrompt, /exploration/i);
		assert.match(AGENT_PROFILES.reviewer.rolePrompt, /review/i);
		assert.equal(AGENT_PROFILES.explorer.requiresDiffArtifact, false);
		assert.equal(AGENT_PROFILES.reviewer.requiresDiffArtifact, true);
	});

	it("builds an explorer prompt with launch context and task but no diff section", () => {
		const prompt = buildAgentJobPrompt({
			profile: AGENT_PROFILES.explorer,
			task: "Map the auth flow",
			launch: { cwd: "/tmp/project", capturedAt: 1_700_000_000_000 },
		});
		assert.ok(prompt.includes(AGENT_PROFILES.explorer.rolePrompt));
		assert.ok(prompt.includes("/tmp/project"));
		assert.ok(prompt.includes("Task:\nMap the auth flow"));
		assert.ok(prompt.includes("live working tree, which may have changed since launch"));
		assert.ok(!prompt.includes("Diff artifact"));
		assert.ok(!prompt.includes("```diff"));
	});

	it("builds a reviewer prompt embedding the frozen diff artifact and its source", () => {
		const diff = reviewerDiff();
		const prompt = buildAgentJobPrompt({
			profile: AGENT_PROFILES.reviewer,
			task: "Review the change",
			launch: { cwd: "/tmp/project", capturedAt: diff.capturedAt, diff },
		});
		assert.ok(prompt.includes(AGENT_PROFILES.reviewer.rolePrompt));
		assert.ok(prompt.includes(diff.diffText));
		assert.ok(prompt.includes(diff.statusText));
		assert.ok(prompt.includes(diff.source));
		// Honesty: the diff is frozen but Read/Glob/Grep see the live tree.
		assert.ok(prompt.includes("frozen at launch"));
		assert.ok(prompt.includes("may have changed since launch"));
	});

	it("marks truncated reviewer artifacts so omitted changes cannot read as reviewed", () => {
		const diff = reviewerDiff({ diffTruncated: true, statusTruncated: true });
		const prompt = buildAgentJobPrompt({
			profile: AGENT_PROFILES.reviewer,
			task: "Review",
			launch: { cwd: "/tmp/project", capturedAt: diff.capturedAt, diff },
		});
		assert.ok(prompt.includes("truncated"));
		assert.ok(prompt.includes("NOT captured"));
	});

	it("states honestly when the captured diff has no changes", () => {
		const diff = reviewerDiff({ diffText: "", statusText: "" });
		const prompt = buildAgentJobPrompt({
			profile: AGENT_PROFILES.reviewer,
			task: "Review",
			launch: { cwd: "/tmp/project", capturedAt: diff.capturedAt, diff },
		});
		assert.ok(prompt.includes("(no changes detected"));
		assert.ok(prompt.includes("(clean)"));
	});
});
