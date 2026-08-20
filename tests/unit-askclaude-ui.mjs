import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createDelegationSnapshot } from "../src/delegation-events.js";
import { buildAskClaudePartialUpdate, renderAskClaudeResult } from "../src/askclaude-ui.js";

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

	it("renders expanded metadata, thinking, nested tools, timeline, usage, and Markdown response", () => {
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
		assert.match(rendered, /Agent/);
		assert.match(rendered, /Read 200ms/);
		assert.match(rendered, /Timeline/);
		assert.match(rendered, /Current answer/);
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
