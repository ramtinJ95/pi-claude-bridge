import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDelegationQueryOptions } from "../src/delegation-options.js";
import { resolveDelegationPolicy } from "../src/query-policy.js";

function build(overrides = {}) {
	const { mode = "read", permissionMode, ...inputs } = overrides;
	return buildDelegationQueryOptions({
		policy: resolveDelegationPolicy(mode, { permissionMode }),
		cwd: "/tmp/project",
		env: { PATH: "/bin" },
		settings: { autoMemoryEnabled: false },
		cliModel: "claude-opus-test",
		isolated: true,
		...inputs,
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

	it("never resumes a session for an isolated call", () => {
		assert.equal("resume" in build().options, false);
		assert.equal("resume" in build({ isolated: false }).options, false);
		assert.equal(build({ isolated: false, resumeSessionId: null }).options.resume, undefined);
	});

	// The isolated/resume conflict is a type error rather than a runtime check, so
	// this pins the shape the caller relies on: .mjs tests are not typechecked and
	// cannot observe the invariant themselves.
	it("makes an isolated resume unrepresentable rather than defended against", () => {
		const options = readFileSync(new URL("../src/delegation-options.ts", import.meta.url), "utf8");
		assert.match(options, /\{\s*isolated:\s*true;\s*resumeSessionId\?:\s*never\s*\}/,
			"an isolated input can still carry a resume session id");
		assert.match(options, /\{\s*isolated:\s*false;\s*resumeSessionId\?:\s*string\s*\|\s*null\s*\}/,
			"a shared input cannot carry a resume session id");

		const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
		assert.match(index, /buildDelegationQueryOptions\(isolated\s*\n?\s*\?\s*\{[^}]*isolated:\s*true\s*\}/,
			"the delegation caller does not branch on isolation");
		assert.doesNotMatch(index, /buildDelegationQueryOptions\([^;]*\bas\b[^;]*\)/,
			"the delegation caller casts the isolation invariant away");
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
