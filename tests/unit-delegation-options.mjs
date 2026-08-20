import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDelegationQueryOptions } from "../src/delegation-options.js";

function build(overrides = {}) {
	return buildDelegationQueryOptions({
		mode: "read",
		cwd: "/tmp/project",
		env: { PATH: "/bin" },
		settings: { autoMemoryEnabled: false },
		cliModel: "claude-opus-test",
		isolated: true,
		...overrides,
	});
}

describe("delegation query options", () => {
	it("builds the safe isolated read default without lifecycle state", () => {
		const { options, policy } = build();

		assert.equal(policy.capabilityMode, "read");
		assert.equal(policy.requestedPermissionMode, "auto");
		assert.deepEqual(options.tools, ["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
		assert.equal(options.permissionMode, "auto");
		assert.equal(options.persistSession, false);
		assert.deepEqual(options.skills, []);
		assert.deepEqual(options.settingSources, ["user", "project"]);
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: undefined });
		assert.deepEqual(options.extraArgs, { "strict-mcp-config": null, model: "claude-opus-test" });
		assert.equal("canUseTool" in options, false);
	});

	it("keeps shared resume, effort, executable, and debug inputs explicit", () => {
		const stderr = () => {};
		const { options } = build({
			isolated: false,
			resumeSessionId: "session-1",
			effort: "high",
			systemPromptAppend: "skills",
			pathToClaudeCodeExecutable: "/opt/claude",
			debugOptions: { debug: true, debugFile: "/tmp/debug.log", stderr },
		});

		assert.equal(options.resume, "session-1");
		assert.equal("persistSession" in options, false);
		assert.equal(options.effort, "high");
		assert.equal(options.extraArgs["thinking-display"], "summarized");
		assert.equal(options.pathToClaudeCodeExecutable, "/opt/claude");
		assert.equal(options.debug, true);
		assert.equal(options.stderr, stderr);
		assert.equal(options.systemPrompt.append, "skills");
	});

	it("only acknowledges dangerous bypass when explicitly configured", () => {
		const { options, policy } = build({ mode: "full", permissionMode: "bypassPermissions" });

		assert.equal(policy.requestedPermissionMode, "bypassPermissions");
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.allowDangerouslySkipPermissions, true);
		assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" });
		assert.ok(options.disallowedTools.includes("AskUserQuestion"));
	});
});
