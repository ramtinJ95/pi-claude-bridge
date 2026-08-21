import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createDelegationSnapshot } from "../src/delegation-events.js";
import { buildAskClaudePartialUpdate, buildToolAggregateLine, renderAskClaudeResult } from "../src/askclaude-ui.js";

initTheme("dark", false);

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function details() {
	return {
		executionTime: 1500,
		prompt: "Inspect the change",
		actions: "Agent(review); Read(src/a.ts)",
		permission: { requested: "auto", effective: "auto", overridden: false },
		snapshot: {
			...createDelegationSnapshot(0),
			status: "running",
			updatedAt: 1500,
			model: "claude-opus-test",
			sessionId: "1234567890abcdef",
			cwd: "/tmp/project",
			responseText: "Current **answer**",
			thinkingText: "Emitted summary",
			tools: [
				{ id: "agent", name: "Agent", status: "running", input: { description: "review" }, startedAt: 100, updatedAt: 1500, parentToolUseId: null },
				{ id: "read", name: "Read", status: "succeeded", input: { file_path: "src/a.ts" }, output: "file text", startedAt: 200, updatedAt: 400, completedAt: 400, durationMs: 200, parentToolUseId: "agent" },
			],
			timeline: [
				{ at: 100, kind: "tool_start", label: "Agent", toolUseId: "agent" },
				{ at: 400, kind: "tool_succeeded", label: "completed", toolUseId: "read", parentToolUseId: "agent" },
			],
			usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80, cacheCreationInputTokens: 10, totalCostUsd: 0.0123, turns: 2, durationMs: 1500, durationApiMs: 1200, modelUsage: {} },
		},
	};
}

describe("AskClaude rich tool row", () => {
	it("builds Pi partial updates from the same retained snapshot the renderer receives", () => {
		const raw = details().snapshot;
		const update = buildAskClaudePartialUpdate(raw, {
			prompt: "Inspect access_token=super-secret-token",
			executionTime: 250,
			capabilityMode: "read",
			requestedModel: "opus",
			thinking: "high",
			isolated: true,
		});

		assert.equal(update.details.snapshot.responseText, raw.responseText);
		assert.equal(update.details.capabilityMode, "read");
		assert.equal(update.details.isolated, true);
		assert.doesNotMatch(update.details.prompt, /super-secret-token/);
		assert.match(update.content[0].text, /Agent\(review\)/);
	});

	it("renders a compact streaming summary", () => {
		const component = renderAskClaudeResult(
			{ content: [{ type: "text", text: "working" }], details: details() },
			{ expanded: false, isPartial: true },
			theme,
			{},
			"auto",
		);
		const rendered = component.render(120).join("\n");

		assert.match(rendered, /Claude Code running/);
		assert.match(rendered, /2 tools · 1 active/);
		assert.match(rendered, /Agent\(review\); Read\(src\/a\.ts\)/);
		assert.match(rendered, /Current \*\*answer\*\*/);
	});

	it("renders expanded metadata, thinking, grouped actions, aggregate status, usage, and Markdown response", () => {
		const context = {};
		const component = renderAskClaudeResult(
			{ content: [{ type: "text", text: "working" }], details: details() },
			{ expanded: true, isPartial: true },
			theme,
			context,
			"auto",
		);
		const rendered = component.render(120).join("\n");

		assert.match(rendered, /model=claude-opus-test/);
		assert.match(rendered, /100 in \/ 20 out/);
		assert.match(rendered, /Emitted thinking summary/);
		// Same grouped, path-aware action semantics as the collapsed view.
		assert.match(rendered, /Agent\(review\); Read\(src\/a\.ts\)/);
		assert.match(rendered, /2 tools: 1 running · 1 succeeded/);
		assert.match(rendered, /\/claude-details/);
		assert.match(rendered, /Current answer/);
	});

	it("keeps per-tool inputs/outputs and the raw timeline out of the expanded inline view", () => {
		const component = renderAskClaudeResult(
			{ content: [{ type: "text", text: "working" }], details: details() },
			{ expanded: true, isPartial: false },
			theme,
			{},
			"auto",
		);
		const rendered = component.render(120).join("\n");

		// Deep inspection is owned by the /claude-details overlay.
		assert.doesNotMatch(rendered, /── Tools/);
		assert.doesNotMatch(rendered, /── Timeline/);
		assert.doesNotMatch(rendered, /Input/);
		assert.doesNotMatch(rendered, /Output/);
		assert.doesNotMatch(rendered, /file text/); // tool output payload
		assert.doesNotMatch(rendered, /tool_start|tool_succeeded/);
		assert.doesNotMatch(rendered, /200ms/); // per-tool durations
	});

	it("counts omitted retained tools in the aggregate total without claiming their status", () => {
		const snapshot = details().snapshot;
		snapshot.toolsOmitted = 3;
		const line = buildToolAggregateLine(snapshot);

		assert.equal(line, "5 tools (details of 3 earlier no longer retained): 1 running · 1 succeeded");
		assert.equal(buildToolAggregateLine({ ...snapshot, tools: [], toolsOmitted: 0 }), "0 tools");
	});

	it("renders terminal failure text even when an empty snapshot is present", () => {
		const failed = details();
		failed.snapshot = { ...createDelegationSnapshot(0), status: "failed", error: "request overloaded" };
		failed.error = true;
		const result = { content: [{ type: "text", text: "Error: request overloaded" }], details: failed };

		const compact = renderAskClaudeResult(result, { expanded: false, isPartial: false }, theme, {}, "auto").render(120).join("\n");
		const expanded = renderAskClaudeResult(result, { expanded: true, isPartial: false }, theme, {}, "auto").render(120).join("\n");

		assert.match(compact, /Error: request overloaded/);
		assert.match(expanded, /Error: request overloaded/);
	});

	it("reuses Pi's prior stateful result component on partial updates", () => {
		const first = renderAskClaudeResult(
			{ content: [{ type: "text", text: "working" }], details: details() },
			{ expanded: false, isPartial: true }, theme, {}, "auto",
		);
		const second = renderAskClaudeResult(
			{ content: [{ type: "text", text: "working" }], details: details() },
			{ expanded: true, isPartial: true }, theme, { lastComponent: first }, "auto",
		);

		assert.equal(second, first);
	});
});
