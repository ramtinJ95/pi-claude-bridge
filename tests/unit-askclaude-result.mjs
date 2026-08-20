/**
 * AskClaude finalization contract.
 *
 * runDelegation resolves — rather than throws — on cancellation so the partial
 * answer and tool activity survive. That makes this glue the only thing standing
 * between an interrupted delegation and a result the model reads as a complete
 * (often empty) answer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { finalizeAskClaudeResult, askClaudeResultIsError } = __test;

function runResult(overrides = {}) {
	return {
		responseText: "",
		stopReason: "stop",
		permissionDenials: [],
		snapshot: {},
		messageCount: 1,
		...overrides,
	};
}

function finalize(overrides = {}, extras = {}) {
	return finalizeAskClaudeResult({
		result: runResult(overrides),
		prompt: "why?",
		actions: "",
		executionTime: 1200,
		...extras,
	});
}

describe("AskClaude finalization", () => {
	it("returns Claude's answer and its actions on a normal stop", () => {
		const { content, details } = finalize({ responseText: "ANSWER" }, { actions: "Read(a.ts)" });

		assert.equal(content[0].text, "ANSWER\n\n[Claude Code actions: Read(a.ts)]");
		assert.equal(details.cancelled, undefined);
		assert.equal(details.error, undefined);
		assert.deepEqual(
			{ prompt: details.prompt, executionTime: details.executionTime, actions: details.actions },
			{ prompt: "why?", executionTime: 1200, actions: "Read(a.ts)" },
		);
	});

	it("tells the model a cancelled run was cancelled and keeps its partial work", () => {
		const { content, details } = finalize(
			{ stopReason: "cancelled", responseText: "half an ans" },
			{ actions: "Read(a.ts)" },
		);

		assert.match(content[0].text, /^Cancelled by user\./);
		assert.match(content[0].text, /half an ans/);
		assert.match(content[0].text, /\[Claude Code actions: Read\(a\.ts\)\]/);
		assert.equal(details.cancelled, true);
		assert.equal(details.error, true);
		assert.equal(details.actions, "Read(a.ts)");
	});

	it("never reports an empty success when cancellation produced nothing", () => {
		const { content, details } = finalize({ stopReason: "cancelled" });

		assert.equal(content[0].text, "Cancelled by user before Claude Code produced a response.");
		assert.equal(details.cancelled, true);
		assert.equal(details.error, true);
	});

	it("still surfaces permission overrides and denials after cancellation", () => {
		const { content } = finalize({
			stopReason: "cancelled",
			permission: { requested: "auto", effective: "default", overridden: true },
			permissionDenials: [{ toolName: "Bash", toolUseId: "t1", reasonType: "rule", message: "denied" }],
		});

		assert.match(content[0].text, /requested auto, runtime default/);
		assert.match(content[0].text, /permission denials: Bash \(rule\)/);
	});

	it("promotes the failure detail to pi's toolResult.isError", () => {
		const cancelled = finalize({ stopReason: "cancelled" }).details;

		assert.deepEqual(
			askClaudeResultIsError({ toolName: "AskClaude", isError: false, details: cancelled }),
			{ isError: true },
		);
		assert.equal(
			askClaudeResultIsError({ toolName: "AskClaude", isError: false, details: finalize({ responseText: "ANSWER" }).details }),
			undefined,
		);
		assert.equal(askClaudeResultIsError({ toolName: "bash", isError: false, details: cancelled }), undefined);
		assert.equal(askClaudeResultIsError({ toolName: "AskClaude", isError: true, details: cancelled }), undefined);
	});
});
