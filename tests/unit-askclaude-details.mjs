import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDelegationSnapshot } from "../src/delegation-events.js";
import { PROMPT_MAX_CHARS } from "../src/delegation-retention.js";
import {
	buildOverlayBodyLines,
	buildOverlayHeaderLines,
	clampScrollTop,
	extractAskClaudeCalls,
	liveCallRecord,
	mergeLiveCall,
	selectCallIndex,
} from "../src/askclaude-details.js";
import {
	ClaudeSessionsOverlay,
	clearLiveAskClaudeCall,
	getLiveAskClaudeCall,
	registerClaudeSessionsUI,
	subscribeLiveAskClaudeCall,
	updateLiveAskClaudeCall,
	__overlayTest,
} from "../src/claude-sessions-overlay.js";
import { mergeClaudeSessionRecords, requestedOverlayFocus } from "../src/claude-sessions.js";

initTheme("dark", false);

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

// --- Fixtures over the real session-branch entry shapes ---

function messageEntry(message, timestamp = "2026-08-20T10:00:00.000Z") {
	return { type: "message", id: `id-${Math.random()}`, parentId: null, timestamp, message };
}

function callEntry(id, prompt, name = "AskClaude", timestamp) {
	return messageEntry(
		{ role: "assistant", content: [{ type: "text", text: "delegating" }, { type: "toolCall", id, name, arguments: { prompt, mode: "read" } }] },
		timestamp,
	);
}

function resultEntry(id, details, isError = false) {
	return messageEntry({ role: "toolResult", toolCallId: id, toolName: "AskClaude", content: [{ type: "text", text: "answer" }], isError, details });
}

function completedSnapshot(overrides = {}) {
	return {
		...createDelegationSnapshot(1000),
		status: "succeeded",
		updatedAt: 5000,
		model: "claude-opus-runtime",
		sessionId: "claude-session-1234",
		cwd: "/claude/delegation/cwd",
		runtimePermissionMode: "default",
		responseText: "streamed narration",
		resultText: "Authoritative **answer**",
		thinkingText: "emitted thinking\n[… truncated 120 chars]",
		tools: [
			{ id: "t1", name: "Read", status: "succeeded", input: { file_path: "src/a.ts" }, output: "file text\n[… truncated 500 chars]", startedAt: 1100, updatedAt: 1300, completedAt: 1300, durationMs: 200, parentToolUseId: null },
			{ id: "t2", name: "Grep", status: "failed", input: { pattern: "x" }, error: "no matches", startedAt: 1400, updatedAt: 1500, completedAt: 1500, durationMs: 100, parentToolUseId: "t1" },
		],
		toolsOmitted: 2,
		timeline: [
			{ at: 1100, kind: "tool_start", label: "Read", toolUseId: "t1" },
			{ at: 1300, kind: "tool_succeeded", label: "completed", toolUseId: "t1" },
		],
		timelineOmitted: 3,
		usage: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900, cacheCreationInputTokens: 50, totalCostUsd: 0.1234, turns: 3, durationMs: 4000, durationApiMs: 3500, modelUsage: {} },
		...overrides,
	};
}

function completedDetails(overrides = {}) {
	return {
		prompt: "retained prompt copy",
		executionTime: 4200,
		actions: "Read(src/a.ts)",
		capabilityMode: "read",
		requestedModel: "opus",
		thinking: "high",
		isolated: true,
		permission: { requested: "auto", effective: "default", overridden: true },
		snapshot: completedSnapshot(),
		...overrides,
	};
}

function branchWithCalls(name = "AskClaude") {
	return [
		messageEntry({ role: "user", content: "hello" }),
		callEntry("call-1", "First prompt", name, "2026-08-20T09:00:00.000Z"),
		resultEntry("call-1", completedDetails()),
		messageEntry({ role: "assistant", content: [{ type: "text", text: "narration" }] }),
		callEntry("call-2", "Second prompt", name, "2026-08-20T09:30:00.000Z"),
		resultEntry("call-2", completedDetails({ cancelled: true, error: true, snapshot: completedSnapshot({ status: "cancelled" }) })),
		callEntry("call-3", "Third prompt", name, "2026-08-20T10:00:00.000Z"),
	];
}

function stubTui(rows = 30, columns = 100) {
	return { renders: 0, requestRender() { this.renders++; }, terminal: { rows, columns } };
}

const kb = { matches: () => false };

// The unified overlay consumes merged Claude-session records; these AskClaude
// tests wrap the call records with no background jobs present.
function asSessionRecords(records) {
	return () => mergeClaudeSessionRecords(records(), []);
}

function makeOverlay(records, { rows = 30, columns = 100, requestedIndex, onDone } = {}) {
	const tui = stubTui(rows, columns);
	let doneCalls = 0;
	const overlay = new ClaudeSessionsOverlay(
		tui,
		theme,
		kb,
		() => { doneCalls++; onDone?.(); },
		asSessionRecords(records),
		requestedIndex === undefined ? undefined : (merged) => requestedOverlayFocus(merged, requestedIndex),
	);
	return { overlay, tui, doneCount: () => doneCalls };
}

beforeEach(() => clearLiveAskClaudeCall());

describe("AskClaude details extraction", () => {
	it("pairs tool calls with results from session-branch entries, in order", () => {
		const records = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		assert.equal(records.length, 3);
		assert.deepEqual(records.map((record) => record.toolCallId), ["call-1", "call-2", "call-3"]);
		assert.deepEqual(records.map((record) => record.status), ["completed", "cancelled", "unresolved"]);
		assert.equal(records[0].timestamp, "2026-08-20T09:00:00.000Z");
	});

	it("extracts calls under a custom AskClaude tool name and ignores other tools", () => {
		const entries = [
			...branchWithCalls("AskExpert"),
			messageEntry({ role: "assistant", content: [{ type: "toolCall", id: "other", name: "bash", arguments: { command: "ls" } }] }),
		];
		assert.equal(extractAskClaudeCalls(entries, "AskClaude").length, 0);
		const records = extractAskClaudeCalls(entries, "AskExpert");
		assert.equal(records.length, 3);
		assert.ok(!records.some((record) => record.toolCallId === "other"));
	});

	it("recovers the full original prompt from persisted tool-call arguments", () => {
		const longPrompt = `${"x".repeat(PROMPT_MAX_CHARS + 500)}END_OF_PROMPT`;
		const entries = [callEntry("call-long", longPrompt), resultEntry("call-long", completedDetails())];
		const [record] = extractAskClaudeCalls(entries, "AskClaude");
		assert.equal(record.prompt, longPrompt);

		const body = buildOverlayBodyLines(record, theme, 200000);
		const rendered = body.lines.join("\n");
		assert.match(rendered, /END_OF_PROMPT/);
		assert.doesNotMatch(rendered, /retained copy/);
	});

	it("falls back to the retained prompt copy when tool-call arguments are missing", () => {
		const entries = [
			messageEntry({ role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "AskClaude", arguments: {} }] }),
			resultEntry("call-x", completedDetails()),
		];
		const [record] = extractAskClaudeCalls(entries, "AskClaude");
		assert.equal(record.prompt, undefined);
		const rendered = buildOverlayBodyLines(record, theme, 100).lines.join("\n");
		assert.match(rendered, /retained copy — original tool-call arguments unavailable/);
		assert.match(rendered, /retained prompt copy/);
	});

	it("marks failed results from details or toolResult isError", () => {
		const entries = [
			callEntry("call-f", "p"),
			resultEntry("call-f", completedDetails({ error: true, snapshot: completedSnapshot({ status: "failed", error: "request overloaded" }) }), true),
		];
		assert.equal(extractAskClaudeCalls(entries, "AskClaude")[0].status, "failed");
	});
});

describe("AskClaude call selection", () => {
	it("selects the latest call by default and clamps requested indexes", () => {
		assert.equal(selectCallIndex(3), 2);
		assert.equal(selectCallIndex(3, 2), 1);
		assert.equal(selectCallIndex(3, 99), 2);
		assert.equal(selectCallIndex(3, 0), 0);
		assert.equal(selectCallIndex(0), -1);
	});

	it("navigates previous/next records with reset scroll and shows the record position", () => {
		const records = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		const { overlay } = makeOverlay(() => records);
		let rendered = overlay.render(100).join("\n");
		assert.match(rendered, /record 3\/3/);

		overlay.scrollTop = 3;
		overlay.handleInput("\x1b[D"); // left → previous record
		assert.equal(overlay.scrollTop, 0);
		assert.match(overlay.render(100).join("\n"), /record 2\/3/);

		overlay.handleInput("p");
		assert.match(overlay.render(100).join("\n"), /record 1\/3/);
		overlay.handleInput("p"); // clamped at the first record
		assert.match(overlay.render(100).join("\n"), /record 1\/3/);

		overlay.handleInput("n");
		overlay.handleInput("\x1b[C"); // right → next record
		rendered = overlay.render(100).join("\n");
		assert.match(rendered, /record 3\/3/);
	});
});

describe("AskClaude details header is Claude-only", () => {
	it("shows delegation metadata from the retained snapshot", () => {
		const [record] = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", completedDetails())], "AskClaude");
		const header = buildOverlayHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
		assert.match(header, /model: claude-opus-runtime \(requested opus\)/);
		assert.match(header, /session: claude-session-1234/);
		assert.match(header, /cwd: \/claude\/delegation\/cwd/);
		assert.match(header, /permission: auto → default/);
		assert.match(header, /tokens: 1,200 in \/ 340 out · cache 900 read \/ 50 write · 3 turns · \$0\.1234/);
		assert.match(header, /capability: read · conversation: isolated · thinking: high/);
		assert.match(header, /completed/);
	});

	it("says unavailable instead of substituting Pi session values", () => {
		const [record] = extractAskClaudeCalls([callEntry("c", "p")], "AskClaude");
		const header = buildOverlayHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
		assert.match(header, /model: unavailable/);
		assert.match(header, /session: unavailable/);
		assert.match(header, /cwd: unavailable/);
		assert.match(header, /permission: unavailable/);
		assert.match(header, /tokens: unavailable/);
		assert.match(header, /capability: unavailable/);
		assert.match(header, /conversation: unavailable/);
		// Never inherit the Pi process working directory.
		assert.ok(!header.includes(process.cwd()));
	});
});

describe("AskClaude details body", () => {
	it("shows retained tools, timeline, truncation markers and omission notices verbatim", () => {
		const [record] = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", completedDetails())], "AskClaude");
		const body = buildOverlayBodyLines(record, theme, 120);
		const rendered = body.lines.join("\n");
		assert.match(rendered, /Tools \(2 earlier omitted\)/);
		assert.match(rendered, /Timeline \(3 earlier omitted\)/);
		assert.match(rendered, /\[… truncated 500 chars\]/); // tool output stays capped
		assert.match(rendered, /\[… truncated 120 chars\]/); // thinking stays capped
		assert.match(rendered, /no matches/);
		assert.match(rendered, /200ms/);
		assert.match(rendered, /Authoritative answer/); // authoritative result wins over narration
		assert.deepEqual(body.sections.map((section) => section.title), ["Prompt", "Thinking", "Tools", "Timeline", "Response"]);
	});

	it("reports an unresolved call without inventing content", () => {
		const [record] = extractAskClaudeCalls([callEntry("c", "p")], "AskClaude");
		const rendered = buildOverlayBodyLines(record, theme, 100).lines.join("\n");
		assert.match(rendered, /no result recorded for this call/);
	});

	it("surfaces failure text and cancellation notices", () => {
		const failed = liveCallRecord({
			toolCallId: "f",
			startedAt: 0,
			prompt: "p",
			details: completedDetails({ error: true, snapshot: completedSnapshot({ status: "failed", error: "request overloaded", resultText: undefined, responseText: "" }) }),
		});
		assert.match(buildOverlayBodyLines(failed, theme, 100).lines.join("\n"), /Error: request overloaded/);

		const cancelled = liveCallRecord({
			toolCallId: "c",
			startedAt: 0,
			prompt: "p",
			details: completedDetails({ cancelled: true, error: true, snapshot: completedSnapshot({ status: "cancelled" }) }),
		});
		assert.match(buildOverlayBodyLines(cancelled, theme, 100).lines.join("\n"), /Cancelled — partial response below/);
	});
});

describe("AskClaude overlay scrolling", () => {
	it("clamps scroll positions", () => {
		assert.equal(clampScrollTop(-5, 100, 10), 0);
		assert.equal(clampScrollTop(50, 100, 10), 50);
		assert.equal(clampScrollTop(500, 100, 10), 90);
		assert.equal(clampScrollTop(5, 3, 10), 0);
	});

	it("scrolls by line, page, home, end, and jumps to sections", () => {
		const details = completedDetails({ snapshot: completedSnapshot({ resultText: Array.from({ length: 80 }, (_, i) => `response line ${i}`).join("\n\n") }) });
		const records = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", details)], "AskClaude");
		const { overlay } = makeOverlay(() => records, { rows: 24 });
		overlay.render(100); // establish body width and viewport

		overlay.handleInput("\x1b[B"); // down
		assert.equal(overlay.scrollTop, 1);
		overlay.handleInput("j");
		assert.equal(overlay.scrollTop, 2);
		overlay.handleInput("k");
		assert.equal(overlay.scrollTop, 1);
		overlay.handleInput("\x1b[A"); // up
		assert.equal(overlay.scrollTop, 0);
		overlay.handleInput("\x1b[A"); // clamped at top
		assert.equal(overlay.scrollTop, 0);

		overlay.handleInput("\x1b[6~"); // pageDown
		const afterPage = overlay.scrollTop;
		assert.ok(afterPage > 1);
		overlay.handleInput("\x1b[5~"); // pageUp
		assert.equal(overlay.scrollTop, 0);

		overlay.handleInput("\x1b[F"); // end
		const atEnd = overlay.scrollTop;
		assert.ok(atEnd > afterPage);
		overlay.handleInput("\x1b[6~"); // pageDown clamped at bottom
		assert.equal(overlay.scrollTop, atEnd);
		overlay.handleInput("\x1b[H"); // home
		assert.equal(overlay.scrollTop, 0);

		overlay.handleInput("5"); // jump to Response section
		const body = overlay.render(100).join("\n");
		assert.ok(overlay.scrollTop > 0);
		assert.match(body, /5:Response/);
	});

	it("honors the user's configured select page bindings", () => {
		const details = completedDetails({ snapshot: completedSnapshot({ resultText: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n") }) });
		const records = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", details)], "AskClaude");
		const customKb = { matches: (data, binding) => data === "CUSTOM_PAGE_DOWN" && binding === "tui.select.pageDown" };
		const tui = stubTui();
		const overlay = new ClaudeSessionsOverlay(tui, theme, customKb, () => {}, asSessionRecords(() => records));
		overlay.render(100);
		overlay.handleInput("CUSTOM_PAGE_DOWN");
		assert.ok(overlay.scrollTop > 1);
	});
});

describe("AskClaude overlay close keys and rendering", () => {
	it("closes on escape, q, and ctrl+n", () => {
		const records = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		for (const key of ["\x1b", "q", "\x0e"]) {
			const { overlay, doneCount } = makeOverlay(() => records);
			overlay.handleInput(key);
			assert.equal(doneCount(), 1, `expected close for ${JSON.stringify(key)}`);
		}
	});

	it("renders a scroll-position indicator and the key map footer", () => {
		const records = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		const { overlay } = makeOverlay(() => records);
		const rendered = overlay.render(100).join("\n");
		assert.match(rendered, /lines \d+-\d+\/\d+ \(\d+%\)/);
		assert.match(rendered, /↑↓\/jk scroll/);
		assert.match(rendered, /prev\/next record/);
		assert.match(rendered, /q\/Esc\/Ctrl\+N close/);
	});

	it("stays within the terminal budget and width on small terminals", () => {
		const records = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		const { overlay } = makeOverlay(() => records, { rows: 10, columns: 44 });
		const lines = overlay.render(40);
		assert.ok(lines.length <= 8, `rendered ${lines.length} lines for a 10-row terminal`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${JSON.stringify(line)}`);
		}
		overlay.dispose();
	});
});

describe("AskClaude live call state", () => {
	it("keeps a single latest-call slot and derives a running record before any snapshot", () => {
		updateLiveAskClaudeCall({ toolCallId: "a", startedAt: 1000, prompt: "first", details: { prompt: "first" } });
		updateLiveAskClaudeCall({ toolCallId: "b", startedAt: 2000, prompt: "second", details: { prompt: "second" } });
		assert.equal(getLiveAskClaudeCall().toolCallId, "b");

		const record = liveCallRecord(getLiveAskClaudeCall());
		assert.equal(record.status, "running");
		assert.equal(record.live, true);
		assert.equal(record.prompt, "second");

		clearLiveAskClaudeCall("a"); // wrong id: slot unchanged
		assert.equal(getLiveAskClaudeCall().toolCallId, "b");
		clearLiveAskClaudeCall("b");
		assert.equal(getLiveAskClaudeCall(), null);

		updateLiveAskClaudeCall({ toolCallId: "c", startedAt: 3000, prompt: "third", details: { prompt: "third" } });
		clearLiveAskClaudeCall(); // unconditional clear (session lifecycle)
		assert.equal(getLiveAskClaudeCall(), null);
	});

	it("appends the live call and drops it once the branch holds the persisted result", () => {
		const persisted = extractAskClaudeCalls([callEntry("call-1", "p1"), resultEntry("call-1", completedDetails())], "AskClaude");
		const live = { toolCallId: "call-2", startedAt: 1, prompt: "live prompt", details: { prompt: "live prompt" } };
		const merged = mergeLiveCall(persisted, live);
		assert.equal(merged.length, 2);
		assert.equal(merged[1].toolCallId, "call-2");
		assert.equal(merged[1].status, "running");

		// The branch already persisted call-1's result: the live copy is shadowed.
		const shadowed = mergeLiveCall(persisted, { ...live, toolCallId: "call-1" });
		assert.equal(shadowed.length, 1);
		assert.equal(shadowed[0].live, undefined);
		assert.equal(shadowed[0].status, "completed");

		// A persisted tool call without a result yet is replaced by the live view.
		const pending = extractAskClaudeCalls([callEntry("call-3", "branch prompt")], "AskClaude");
		const enriched = mergeLiveCall(pending, { ...live, toolCallId: "call-3" });
		assert.equal(enriched.length, 1);
		assert.equal(enriched[0].status, "running");
		assert.equal(enriched[0].prompt, "branch prompt");
		assert.equal(enriched[0].live, true);
	});

	it("re-renders the open overlay on live updates, follows the latest call, and unsubscribes on dispose", () => {
		const base = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		const loadRecords = () => mergeLiveCall(base, getLiveAskClaudeCall());
		const listenersBefore = __overlayTest.liveListenerCount();
		const { overlay, tui } = makeOverlay(loadRecords);
		assert.equal(__overlayTest.liveListenerCount(), listenersBefore + 1);
		assert.match(overlay.render(100).join("\n"), /record 3\/3/);

		updateLiveAskClaudeCall({ toolCallId: "call-4", startedAt: Date.parse("2026-08-20T10:30:00.000Z"), prompt: "live", details: { prompt: "live", snapshot: completedSnapshot({ status: "running" }) } });
		assert.ok(tui.renders >= 1);
		assert.match(overlay.render(100).join("\n"), /record 4\/4.*running \(live\)/);

		const rendersBeforeDispose = tui.renders;
		overlay.dispose();
		assert.equal(__overlayTest.liveListenerCount(), listenersBefore);
		updateLiveAskClaudeCall({ toolCallId: "call-5", startedAt: Date.parse("2026-08-20T10:31:00.000Z"), prompt: "later", details: { prompt: "later" } });
		assert.equal(tui.renders, rendersBeforeDispose);
	});

	it("keeps an explicitly selected earlier call pinned across live updates", () => {
		const base = extractAskClaudeCalls(branchWithCalls(), "AskClaude");
		const loadRecords = () => mergeLiveCall(base, getLiveAskClaudeCall());
		let bodyHeadings = 0;
		const countingTheme = {
			fg: (color, text) => {
				if (color === "muted" && String(text).startsWith("──")) bodyHeadings++;
				return text;
			},
			bold: (text) => text,
		};
		const tui = stubTui();
		const overlay = new ClaudeSessionsOverlay(tui, countingTheme, kb, () => {}, asSessionRecords(loadRecords), (merged) => requestedOverlayFocus(merged, 1));
		assert.match(overlay.render(100).join("\n"), /record 1\/3/);
		const headingsAfterInitialRender = bodyHeadings;

		updateLiveAskClaudeCall({ toolCallId: "call-4", startedAt: Date.parse("2026-08-20T10:30:00.000Z"), prompt: "live", details: { prompt: "live" } });
		assert.match(overlay.render(100).join("\n"), /record 1\/4/);
		assert.equal(bodyHeadings, headingsAfterInitialRender, "a live update must not rebuild a pinned call's Markdown body");
		overlay.dispose();
	});

	it("invalidates cached themed body lines", () => {
		const records = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", completedDetails())], "AskClaude");
		let marker = "before:";
		const changingTheme = {
			fg: (color, text) => color === "muted" && String(text).startsWith("──") ? `${marker}${text}` : text,
			bold: (text) => text,
		};
		const tui = stubTui();
		const overlay = new ClaudeSessionsOverlay(tui, changingTheme, kb, () => {}, asSessionRecords(() => records));
		assert.match(overlay.render(100).join("\n"), /before:── Prompt/);
		marker = "after:";
		overlay.invalidate();
		const rendered = overlay.render(100).join("\n");
		assert.match(rendered, /after:── Prompt/);
		assert.doesNotMatch(rendered, /before:── Prompt/);
		overlay.dispose();
	});
});

describe("AskClaude overlay registration", () => {
	it("does not let a closing overlay clear the replacement overlay's toggle owner", async () => {
		const commands = new Map();
		const shortcuts = new Map();
		registerClaudeSessionsUI({
			registerCommand: (name, command) => commands.set(name, command),
			registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
		}, { toolName: "AskClaude", jobs: { list: () => [], running: () => undefined, subscribe: () => () => {} } });

		let customCalls = 0;
		const ctx = {
			mode: "tui",
			sessionManager: { getBranch: () => [callEntry("call-1", "prompt"), resultEntry("call-1", completedDetails())] },
			ui: {
				notify: () => {},
				custom: (factory) => new Promise((resolve) => {
					customCalls++;
					let component;
					const done = (value) => {
						component?.dispose();
						resolve(value);
					};
					component = factory(stubTui(), theme, kb, done);
				}),
			},
		};

		const first = commands.get("askclaude-details").handler("", ctx);
		const second = commands.get("askclaude-details").handler("", ctx);
		await Promise.resolve(); // let the first overlay's finally run
		await shortcuts.get("ctrl+n").handler(ctx); // closes the replacement
		await Promise.all([first, second]);

		assert.equal(customCalls, 2, "Ctrl+N must close the replacement instead of opening a third overlay");
	});
});

// --- Foreground SpawnClaudeAgent records ---

function spawnCallEntry(id, args, timestamp) {
	return messageEntry(
		{ role: "assistant", content: [{ type: "toolCall", id, name: "SpawnClaudeAgent", arguments: args }] },
		timestamp,
	);
}

function spawnResultEntry(id, details, isError = false) {
	return messageEntry({ role: "toolResult", toolCallId: id, toolName: "SpawnClaudeAgent", content: [{ type: "text", text: "answer" }], isError, details });
}

describe("foreground SpawnClaudeAgent extraction and labels", () => {
	it("extracts foreground spawn calls as foreground records alongside AskClaude calls", () => {
		const entries = [
			callEntry("ask-1", "ask prompt", "AskClaude", "2026-08-20T09:00:00.000Z"),
			resultEntry("ask-1", completedDetails()),
			spawnCallEntry("spawn-1", { task: "fix the bug", mode: "full", execution: "foreground" }, "2026-08-20T09:30:00.000Z"),
			spawnResultEntry("spawn-1", completedDetails({ origin: "spawn-foreground", profile: "worker", capabilityMode: "full" })),
		];
		const records = extractAskClaudeCalls(entries, "AskClaude", "SpawnClaudeAgent");
		assert.equal(records.length, 2);
		assert.equal(records[0].origin, undefined);
		assert.equal(records[1].origin, "spawn-foreground");
		assert.equal(records[1].profile, "worker");
		assert.equal(records[1].prompt, "fix the bug", "the spawn call's prompt is its task argument");
		assert.equal(records[1].status, "completed");
	});

	it("ignores background spawn calls and everything without a spawn tool name", () => {
		const background = [
			spawnCallEntry("spawn-bg", { task: "explore", mode: "read" }),
			spawnCallEntry("spawn-bg2", { task: "explore", mode: "read", execution: "background" }),
			spawnCallEntry("spawn-fg", { task: "fix", mode: "full", execution: "foreground" }),
		];
		assert.equal(extractAskClaudeCalls(background, "AskClaude", "SpawnClaudeAgent").length, 1);
		// Without the spawn tool name (restored sessions of older versions), only AskClaude records appear.
		assert.equal(extractAskClaudeCalls(background, "AskClaude").length, 0);
	});

	it("labels spawn-foreground records distinctly from AskClaude compatibility calls", () => {
		const [record] = extractAskClaudeCalls([
			spawnCallEntry("spawn-1", { task: "fix", mode: "full", execution: "foreground" }),
			spawnResultEntry("spawn-1", completedDetails({ origin: "spawn-foreground", profile: "worker" })),
		], "AskClaude", "SpawnClaudeAgent");
		const header = buildOverlayHeaderLines(record, { index: 0, total: 1 }, theme).join("\n");
		assert.match(header, /SpawnClaudeAgent worker \(foreground\)/);
		assert.ok(!header.includes("AskClaude call"));

		const [ask] = extractAskClaudeCalls([callEntry("c", "p"), resultEntry("c", completedDetails())], "AskClaude");
		assert.match(buildOverlayHeaderLines(ask, { index: 0, total: 1 }, theme).join("\n"), /AskClaude call/);
	});

	it("carries the labels through the live slot for a running foreground spawn call", () => {
		updateLiveAskClaudeCall({
			toolCallId: "spawn-live",
			startedAt: Date.parse("2026-08-20T10:00:00.000Z"),
			prompt: "live task",
			details: { prompt: "live task", executionTime: 0, origin: "spawn-foreground", profile: "explorer" },
		});
		const record = liveCallRecord(getLiveAskClaudeCall());
		assert.equal(record.origin, "spawn-foreground");
		assert.equal(record.profile, "explorer");
		assert.equal(record.status, "running");

		// The live record also merges into a branch that already persisted the tool call.
		const pending = extractAskClaudeCalls([
			spawnCallEntry("spawn-live", { task: "live task", mode: "read", execution: "foreground" }),
		], "AskClaude", "SpawnClaudeAgent");
		const merged = mergeLiveCall(pending, getLiveAskClaudeCall());
		assert.equal(merged.length, 1);
		assert.equal(merged[0].live, true);
		assert.equal(merged[0].origin, "spawn-foreground");
	});

	it("derives advisor and reviewer labels from mode plus review while retaining legacy profile labels", () => {
		const records = extractAskClaudeCalls([
			spawnCallEntry("advisor", { task: "advise", mode: "none", execution: "foreground" }),
			spawnCallEntry("review", { task: "review", mode: "read", review: {}, execution: "foreground" }),
			spawnCallEntry("legacy", { task: "old", profile: "explorer", execution: "foreground" }),
		], "AskClaude", "SpawnClaudeAgent");
		assert.deepEqual(records.map((record) => record.profile), ["advisor", "reviewer", "explorer"]);
	});
});
