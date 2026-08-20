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

	it("turns unrecognized SDK frames into visible diagnostics", () => {
		const events = normalizeDelegationMessage({ type: "future_event" }, 7);
		const snapshot = events.reduce((state, event) => reduceDelegationEvent(state, event), createDelegationSnapshot(0));

		assert.deepEqual(snapshot.diagnostics, [{ kind: "unknown_sdk_message", label: "future_event", at: 7 }]);
	});
});
