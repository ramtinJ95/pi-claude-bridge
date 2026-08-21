import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROFILES, AGENT_PROFILE_IDS, buildAgentJobPrompt } from "../src/agent-profiles.js";
import { resolveDelegationPolicy } from "../src/query-policy.js";

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
	it("exposes exactly the explorer and reviewer profiles", () => {
		assert.deepEqual([...AGENT_PROFILE_IDS], ["explorer", "reviewer"]);
		assert.deepEqual(Object.keys(AGENT_PROFILES).sort(), ["explorer", "reviewer"]);
		for (const id of AGENT_PROFILE_IDS) assert.equal(AGENT_PROFILES[id].id, id);
	});

	it("resolves both profiles to the explicit read inventory with no mutation or nested-agent tools", () => {
		for (const id of AGENT_PROFILE_IDS) {
			const profile = AGENT_PROFILES[id];
			assert.equal(profile.capabilityMode, "read");
			const policy = resolveDelegationPolicy(profile.capabilityMode);
			assert.deepEqual(policy.tools, READ_INVENTORY);
			for (const tool of FORBIDDEN) {
				assert.ok(!policy.tools.includes(tool), `${id} inventory must not include ${tool}`);
			}
		}
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
