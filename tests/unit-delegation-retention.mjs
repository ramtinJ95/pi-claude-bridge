import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MODEL_RESULT_MAX_CHARS,
	PROMPT_MAX_CHARS,
	RETAINED_LIST_MAX_ITEMS,
	THINKING_MAX_CHARS,
	TIMELINE_MAX_CHARS,
	TIMELINE_MAX_EVENTS,
	TOOL_FIELD_MAX_CHARS,
	redactSensitiveText,
	retainText,
	retainToolValue,
} from "../src/delegation-retention.js";
import { createDelegationSnapshot, reduceDelegationEvent } from "../src/delegation-events.js";
import { retainDelegationSnapshot } from "../src/askclaude-ui.js";

describe("delegation retention", () => {
	it("pins each independently adjustable retention choice", () => {
		assert.deepEqual(
			{ MODEL_RESULT_MAX_CHARS, TOOL_FIELD_MAX_CHARS, TIMELINE_MAX_CHARS, TIMELINE_MAX_EVENTS, RETAINED_LIST_MAX_ITEMS, THINKING_MAX_CHARS, PROMPT_MAX_CHARS },
			{ MODEL_RESULT_MAX_CHARS: 16_000, TOOL_FIELD_MAX_CHARS: 2_000, TIMELINE_MAX_CHARS: 32_000, TIMELINE_MAX_EVENTS: 100, RETAINED_LIST_MAX_ITEMS: 100, THINKING_MAX_CHARS: 4_000, PROMPT_MAX_CHARS: 8_000 },
		);
	});

	it("redacts common credentials before retaining text", () => {
		const text = 'Authorization: Bearer abcdefghijklmnop api_key=secret-value "access_token": "json-secret" https://me:hunter2@example.test sk-ant-abcdefghijklmnop';
		const retained = redactSensitiveText(text);

		assert.doesNotMatch(retained, /abcdefghijklmnop|secret-value|json-secret|hunter2/);
		assert.match(retained, /\[REDACTED\]/);
	});

	it("redacts structured tool fields and visibly truncates oversized values", () => {
		const structured = retainToolValue({ apiKey: "super-secret", nested: { command: "echo ok" } });
		assert.equal(structured.apiKey, "[REDACTED]");
		assert.equal(structured.nested.command, "echo ok");

		const oversized = retainToolValue({ output: "x".repeat(TOOL_FIELD_MAX_CHARS * 2) });
		assert.equal(typeof oversized, "string");
		assert.ok(oversized.length <= TOOL_FIELD_MAX_CHARS);
		assert.match(oversized, /truncated/);
	});

	it("bounds streamed response, thinking, and timeline retention", () => {
		let snapshot = createDelegationSnapshot(0);
		snapshot = reduceDelegationEvent(snapshot, { type: "text_delta", at: 1, text: "a".repeat(MODEL_RESULT_MAX_CHARS + 50) });
		snapshot = reduceDelegationEvent(snapshot, { type: "thinking_delta", at: 2, text: "b".repeat(THINKING_MAX_CHARS + 20) });
		for (let i = 0; i < TIMELINE_MAX_EVENTS + 20; i++) {
			snapshot = reduceDelegationEvent(snapshot, { type: "diagnostic", at: 3 + i, kind: "unhandled_sdk_message", label: `frame-${i}` });
		}

		assert.equal(snapshot.responseText.length, MODEL_RESULT_MAX_CHARS);
		assert.equal(snapshot.responseOmittedChars, 50);
		assert.equal(snapshot.thinkingText.length, THINKING_MAX_CHARS);
		assert.equal(snapshot.thinkingOmittedChars, 20);
		assert.ok(snapshot.timeline.length <= TIMELINE_MAX_EVENTS);
		assert.ok(JSON.stringify(snapshot.timeline).length <= TIMELINE_MAX_CHARS);
		assert.equal(snapshot.timelineOmitted, 20);
	});

	it("redacts assembled streamed text and makes truncation visible before persistence", () => {
		const snapshot = {
			...createDelegationSnapshot(0),
			responseText: "Authorization: Bearer assembled-secret-value",
			responseOmittedChars: 25,
		};
		const retained = retainDelegationSnapshot(snapshot);

		assert.doesNotMatch(retained.responseText, /assembled-secret-value/);
		assert.match(retained.responseText, /REDACTED/);
		assert.match(retained.responseText, /truncated/);
		assert.equal(retained.responseOmittedChars, 0);
	});

	it("keeps an accurate omission count when a reducer-capped field needs a marker", () => {
		const snapshot = {
			...createDelegationSnapshot(0),
			responseText: "x".repeat(MODEL_RESULT_MAX_CHARS),
			responseOmittedChars: 5_000,
		};
		const retained = retainDelegationSnapshot(snapshot);
		const match = retained.responseText.match(/\n\[… truncated (\d+) chars\]$/);

		assert.ok(retained.responseText.length <= MODEL_RESULT_MAX_CHARS);
		assert.ok(match);
		const visibleChars = retained.responseText.indexOf("\n[… truncated");
		assert.equal(Number(match[1]), 5_000 + MODEL_RESULT_MAX_CHARS - visibleChars);
	});

	it("caps retained state lists and records what was omitted", () => {
		const snapshot = createDelegationSnapshot(0);
		snapshot.tools = Array.from({ length: RETAINED_LIST_MAX_ITEMS + 3 }, (_, index) => ({
			id: `tool-${index}`, name: "Read", status: "succeeded", startedAt: index, updatedAt: index, parentToolUseId: null,
		}));
		snapshot.permissionDenials = Array.from({ length: RETAINED_LIST_MAX_ITEMS + 2 }, (_, index) => ({
			toolName: "Read", toolUseId: `tool-${index}`, message: "denied",
		}));
		snapshot.diagnostics = Array.from({ length: RETAINED_LIST_MAX_ITEMS + 1 }, (_, index) => ({
			kind: "unhandled_sdk_message", label: `frame-${index}`, at: index,
		}));

		const retained = retainDelegationSnapshot(snapshot);
		assert.equal(retained.tools.length, RETAINED_LIST_MAX_ITEMS);
		assert.equal(retained.toolsOmitted, 3);
		assert.equal(retained.permissionDenials.length, RETAINED_LIST_MAX_ITEMS);
		assert.equal(retained.permissionDenialsOmitted, 2);
		assert.equal(retained.diagnostics.length, RETAINED_LIST_MAX_ITEMS);
		assert.equal(retained.diagnosticsOmitted, 1);
	});

	it("keeps visible text truncation within its field limit", () => {
		const retained = retainText("x".repeat(100), 40);
		assert.equal(retained.length, 40);
		assert.match(retained, /truncated/);
	});
});
