import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	createDelegationSnapshot,
	normalizeDelegationMessage,
	reduceDelegationEvent,
	reduceDelegationMessage,
} from "../src/delegation-events.js";

function fixture(name) {
	const path = new URL(`./fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function replay(name) {
	let snapshot = createDelegationSnapshot(0);
	let at = 0;
	for (const message of fixture(name)) snapshot = reduceDelegationMessage(snapshot, message, ++at);
	return snapshot;
}

describe("normalized delegation events", () => {
	it("replays emitted text, thinking, session metadata, and final usage", () => {
		const snapshot = replay("text");

		assert.equal(snapshot.responseText.trim(), "ALPHA");
		assert.match(snapshot.thinkingText, /The user is asking/);
		assert.match(snapshot.sessionId, /^[0-9a-f-]{36}$/);
		assert.equal(snapshot.model, "claude-haiku-4-5");
		assert.ok(snapshot.usage.outputTokens > 0);
		assert.ok(snapshot.usage.cacheCreationInputTokens > 0);
		assert.equal(snapshot.usage.turns, 1);
		assert.equal(snapshot.resultSubtype, "success");
	});

	it("matches a tool result to its call and records output and duration", () => {
		const snapshot = replay("single-tool");

		assert.equal(snapshot.tools.length, 1);
		assert.equal(snapshot.tools[0].name, "mcp__custom-tools__read");
		assert.equal(snapshot.tools[0].status, "succeeded");
		assert.match(snapshot.tools[0].output, /ONE/);
		assert.ok(snapshot.tools[0].input);
		assert.ok(snapshot.tools[0].durationMs >= 0);
	});

	it("deduplicates denial sources and marks the tool denied", () => {
		const denial = {
			type: "system",
			subtype: "permission_denied",
			tool_name: "Read",
			tool_use_id: "tool-1",
			decision_reason_type: "rule",
			decision_reason: "managed deny",
			message: "Permission denied",
		};
		const result = {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
			stop_reason: "end_turn",
			permission_denials: [{ tool_name: "Read", tool_use_id: "tool-1", tool_input: {} }],
			usage: {},
			modelUsage: {},
		};

		let snapshot = createDelegationSnapshot(0);
		snapshot = reduceDelegationMessage(snapshot, denial, 1);
		snapshot = reduceDelegationMessage(snapshot, result, 2);

		assert.equal(snapshot.permissionDenials.length, 1);
		assert.equal(snapshot.permissionDenials[0].reasonType, "rule");
		assert.equal(snapshot.tools[0].status, "denied");
	});

	it("ignores tool results replayed from a resumed session", () => {
		const replay = {
			type: "user",
			isReplay: true,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "old-tool", content: "old output" }],
			},
		};

		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), replay, 1);

		assert.deepEqual(snapshot.tools, []);
	});

	it("does not treat a success-shaped error result as response text", () => {
		const result = {
			type: "result",
			subtype: "success",
			is_error: true,
			result: "capacity exhausted",
			stop_reason: null,
			permission_denials: [],
			usage: {},
			modelUsage: {},
		};

		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), result, 1);

		assert.equal(snapshot.responseText, "");
	});

	it("keeps the authoritative final result separate from earlier streamed narration", () => {
		let snapshot = createDelegationSnapshot(0);
		snapshot = reduceDelegationEvent(snapshot, { type: "text_delta", at: 1, text: "I will inspect the files first." });
		snapshot = reduceDelegationEvent(snapshot, {
			type: "result", at: 2, subtype: "success", stopReason: "end_turn", resultText: "FINAL ANSWER",
		});

		assert.equal(snapshot.responseText, "I will inspect the files first.");
		assert.equal(snapshot.resultText, "FINAL ANSWER");
		assert.equal(snapshot.resultOmittedChars, 0);
	});

	it("keeps every parallel tool result matched to its own call", () => {
		const snapshot = replay("parallel-tools");

		assert.equal(snapshot.tools.length, 3);
		const byPath = new Map(snapshot.tools.map((tool) => [tool.input.path, tool]));
		assert.deepEqual([...byPath.keys()].sort(), ["one.txt", "three.txt", "two.txt"]);
		assert.match(byPath.get("one.txt").output, /ONE/);
		assert.match(byPath.get("two.txt").output, /TWO/);
		assert.match(byPath.get("three.txt").output, /THREE/);
		assert.ok(snapshot.tools.every((tool) => tool.status === "succeeded"));
		assert.ok(snapshot.tools.every((tool) => tool.parentToolUseId === null));
	});

	it("records an orphan tool result rather than dropping it", () => {
		const orphan = {
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_orphan", content: "boom", is_error: true }],
			},
		};

		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), orphan, 5);

		assert.equal(snapshot.tools.length, 1);
		assert.deepEqual(
			{ id: snapshot.tools[0].id, name: snapshot.tools[0].name, status: snapshot.tools[0].status },
			{ id: "toolu_orphan", name: "unknown", status: "failed" },
		);
		assert.equal(snapshot.tools[0].error, "boom");
		assert.equal(snapshot.tools[0].durationMs, 0);
	});

	it("preserves the subagent parent relation across a nested call's frames", () => {
		const parent = "toolu_agent";
		const messages = [
			// Synthetic reducer coverage: the installed runtime's live contract probe
			// currently emits completed nested messages, not nested stream_event frames.
			{
				type: "stream_event",
				parent_tool_use_id: parent,
				event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_nested", name: "Read" } },
			},
			{
				type: "assistant",
				parent_tool_use_id: parent,
				message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_nested", name: "Read", input: { file_path: "a.ts" } }] },
			},
			{ type: "tool_progress", tool_use_id: "toolu_nested", tool_name: "Read", parent_tool_use_id: parent, elapsed_time_seconds: 2 },
			{
				type: "user",
				parent_tool_use_id: parent,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nested", content: "ok" }] },
			},
		];

		let snapshot = createDelegationSnapshot(0);
		let at = 0;
		for (const message of messages) snapshot = reduceDelegationMessage(snapshot, message, ++at);

		assert.equal(snapshot.tools.length, 1);
		assert.equal(snapshot.tools[0].parentToolUseId, parent);
		assert.equal(snapshot.tools[0].status, "succeeded");
		assert.equal(snapshot.tools[0].elapsedSeconds, 2);
	});

	it("does not let a top-level frame flatten an already nested call", () => {
		const start = {
			type: "assistant",
			parent_tool_use_id: "toolu_agent",
			message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_nested", name: "Read", input: {} }] },
		};
		const result = {
			type: "user",
			parent_tool_use_id: null,
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nested", content: "ok" }] },
		};

		let snapshot = reduceDelegationMessage(createDelegationSnapshot(0), start, 1);
		snapshot = reduceDelegationMessage(snapshot, result, 2);

		assert.equal(snapshot.tools[0].parentToolUseId, "toolu_agent");
	});

	it("keeps an assistant error visible without ending the run", () => {
		const message = { type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { role: "assistant", content: [] } };

		assert.deepEqual(normalizeDelegationMessage(message, 3), [{ type: "assistant_error", at: 3, error: "rate_limit" }]);

		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), message, 3);
		assert.equal(snapshot.assistantError, "rate_limit");
		assert.equal(snapshot.status, "running");
		assert.equal(snapshot.error, undefined);
	});

	it("normalizes an api_retry system frame into retry state", () => {
		const retry = {
			type: "system",
			subtype: "api_retry",
			attempt: 2,
			max_retries: 5,
			retry_delay_ms: 1500,
			error_status: 529,
			error: "overloaded_error",
		};

		assert.deepEqual(normalizeDelegationMessage(retry, 4), [
			{ type: "retry", at: 4, attempt: 2, maxRetries: 5, delayMs: 1500, status: 529, error: "overloaded_error" },
		]);

		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), retry, 4);
		assert.deepEqual(snapshot.retry, { attempt: 2, maxRetries: 5, delayMs: 1500, status: 529, error: "overloaded_error" });
		assert.deepEqual(snapshot.diagnostics, []);
	});

	// The SDK documents far more frames than delegation consumes. Calling those
	// "unknown" would misreport a known-but-unused frame as an SDK surprise, and an
	// ignore list would go stale silently, so they stay visible under a name that
	// only claims this reducer did not handle them.
	it("turns unhandled SDK frames into visible diagnostics", () => {
		const events = normalizeDelegationMessage({ type: "future_event" }, 7);
		const snapshot = events.reduce((state, event) => reduceDelegationEvent(state, event), createDelegationSnapshot(0));

		assert.deepEqual(snapshot.diagnostics, [{ kind: "unhandled_sdk_message", label: "future_event", at: 7 }]);
	});

	it("names an unhandled system subtype without claiming it is unknown", () => {
		const snapshot = reduceDelegationMessage(createDelegationSnapshot(0), { type: "system", subtype: "hook_started" }, 8);

		assert.deepEqual(snapshot.diagnostics, [{ kind: "unhandled_sdk_message", label: "system:hook_started", at: 8 }]);
	});
});
