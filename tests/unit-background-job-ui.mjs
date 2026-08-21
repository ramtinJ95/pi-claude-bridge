import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BackgroundJobManager } from "../src/background-jobs.js";
import {
	BACKGROUND_JOB_ENTRY_TYPE,
	BACKGROUND_JOB_MESSAGE_TYPE,
	BACKGROUND_JOB_WIDGET_KEY,
	BackgroundJobLiveWidget,
	buildBackgroundJobWidgetLines,
	buildCompletionEntryData,
	buildCompletionMessageText,
	buildJobStatusLines,
	registerBackgroundJobUI,
	renderBackgroundJobCompletion,
} from "../src/background-job-ui.js";
import { createDelegationSnapshot } from "../src/delegation-events.js";

initTheme("dark", false);

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Minimal Pi extension API double: records registrations, replays events. */
function fakePi() {
	const handlers = new Map();
	const commands = new Map();
	const entryRenderers = new Map();
	const entries = [];
	const messages = [];
	return {
		handlers,
		commands,
		entryRenderers,
		entries,
		messages,
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		// Pi 0.84.2's extension runner awaits every handler; mirror that.
		async emit(type, event, ctx = {}) {
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerEntryRenderer(customType, renderer) {
			entryRenderers.set(customType, renderer);
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
	};
}

/** Minimal ExtensionUIContext double for the widget and notify surfaces. */
function fakeUI() {
	const widgets = new Map();
	const notifications = [];
	return {
		widgets,
		notifications,
		setWidget(key, content) {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		notify(message, type) {
			notifications.push({ message, type });
		},
	};
}

function snapshotWith(overrides = {}) {
	return { ...createDelegationSnapshot(0), ...overrides };
}

function runResult(stopReason = "stop", snapshot = snapshotWith({ status: "succeeded", responseText: "the findings" }), extras = {}) {
	return {
		responseText: snapshot.responseText,
		stopReason,
		permissionDenials: snapshot.permissionDenials ?? [],
		snapshot,
		messageCount: 1,
		...extras,
	};
}

/** Executor that stays pending until the test settles it. */
function pendingExecutor() {
	const state = {};
	let settle;
	const settled = new Promise((resolve, reject) => { settle = { resolve, reject }; });
	const execute = ({ signal, onSnapshot }) => {
		state.signal = signal;
		state.onSnapshot = onSnapshot;
		return settled;
	};
	return { execute, resolve: (value) => settle.resolve(value), reject: (error) => settle.reject(error), state };
}

function spawnInput(execute, overrides = {}) {
	return {
		profile: "explorer",
		task: "look around",
		requestedModel: "opus",
		launch: { cwd: "/tmp/project", capturedAt: 10 },
		execute,
		...overrides,
	};
}

async function wire(overrides = {}) {
	const pi = fakePi();
	const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
	const ui = fakeUI();
	registerBackgroundJobUI(pi, { enabled: true, jobs, now: () => 100_000, ...overrides });
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "tui", ui });
	return { pi, jobs, ui };
}

/** Instantiate the registered widget factory with a recording fake TUI. */
function mountWidget(ui) {
	const factory = ui.widgets.get(BACKGROUND_JOB_WIDGET_KEY);
	assert.equal(typeof factory, "function", "widget factory must be registered");
	const tui = { renders: 0, requestRender() { this.renders++; } };
	const widget = factory(tui, theme);
	return { widget, tui };
}

describe("background job UI registration", () => {
	it("keeps restored entries renderable when the AskClaude opt-in is off", async () => {
		const pi = fakePi();
		registerBackgroundJobUI(pi, { enabled: false, jobs: new BackgroundJobManager({ idPrefix: "t" }) });
		assert.equal(pi.handlers.size, 0);
		assert.equal(pi.commands.size, 0);
		assert.ok(pi.entryRenderers.has(BACKGROUND_JOB_ENTRY_TYPE));
		const renderer = pi.entryRenderers.get(BACKGROUND_JOB_ENTRY_TYPE);
		const fallback = renderer(
			{ type: "custom", customType: BACKGROUND_JOB_ENTRY_TYPE, data: { jobId: "partial" } },
			{ expanded: false },
			theme,
		).render(80).join("\n");
		assert.match(fallback, /entry unavailable/);
	});

	it("registers the entry renderer and the /claude-jobs command", async () => {
		const { pi } = await wire();
		assert.ok(pi.entryRenderers.has(BACKGROUND_JOB_ENTRY_TYPE));
		assert.ok(pi.commands.has("claude-jobs"));
		assert.match(pi.commands.get("claude-jobs").description, /cancel/);
	});
});

describe("background job live widget", () => {
	it("appears on spawn, live-updates from manager snapshots, and disappears on settlement", async () => {
		const { jobs, ui } = await wire();
		const pending = pendingExecutor();
		const record = jobs.spawn(spawnInput(pending.execute, { thinking: "high" }));
		assert.ok(ui.widgets.has(BACKGROUND_JOB_WIDGET_KEY), "widget appears while the job runs");

		const { widget, tui } = mountWidget(ui);
		try {
			let rendered = widget.render(120).join("\n");
			assert.match(rendered, /Claude explorer job/);
			assert.match(rendered, /running/);
			assert.match(rendered, new RegExp(record.id));
			assert.match(rendered, /model opus/);
			assert.match(rendered, /thinking high/);
			assert.match(rendered, /now: starting/);
			assert.match(rendered, /\/claude-jobs cancel/);

			// A manager snapshot update repaints the widget and refreshes its facts.
			const rendersBefore = tui.renders;
			pending.state.onSnapshot(snapshotWith({
				model: "claude-opus-runtime",
				runtimePermissionMode: "default",
				tools: [{ id: "r1", name: "Read", status: "running", input: { file_path: "/tmp/project/src/a.ts" }, startedAt: 1, updatedAt: 1, parentToolUseId: null }],
			}));
			assert.ok(tui.renders > rendersBefore, "snapshot transition requests a render");
			rendered = widget.render(120).join("\n");
			assert.match(rendered, /model claude-opus-runtime/);
			assert.match(rendered, /permission default/);
			assert.match(rendered, /now: Read\(src\/a\.ts\)/);
			assert.match(rendered, /1 tool/);
		} finally {
			widget.dispose();
		}

		pending.resolve(runResult());
		await jobs.settled(record.id);
		assert.equal(ui.widgets.has(BACKGROUND_JOB_WIDGET_KEY), false, "widget is removed at the terminal transition");
	});

	it("keeps every line inside the available width on small terminals", async () => {
		const record = {
			id: "claude-job-t-1",
			profile: "reviewer",
			task: "review",
			requestedModel: "claude-opus-5-with-a-long-name",
			thinking: "xhigh",
			status: "running",
			createdAt: 0,
			launch: { cwd: "/tmp/project", capturedAt: 0 },
			snapshot: snapshotWith({
				model: "claude-opus-5-with-a-long-name",
				runtimePermissionMode: "default",
				tools: [{ id: "r1", name: "Read", status: "running", input: { file_path: "/tmp/project/a-very/deeply/nested/path/file.ts" }, startedAt: 1, updatedAt: 1, parentToolUseId: null }],
				permissionDenials: [{ toolName: "WebFetch", toolUseId: "d1", message: "denied" }],
			}),
		};
		const visibleLength = (line) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].length;
		for (const width of [24, 40, 80]) {
			const lines = buildBackgroundJobWidgetLines(record, theme, width, 754_000);
			assert.ok(lines.length <= 3, "widget stays compact");
			for (const line of lines) {
				assert.ok(visibleLength(line) <= Math.max(10, width), `line fits ${width} cols: ${JSON.stringify(line)}`);
			}
		}
		// Elapsed time and denial count are visible at a comfortable width.
		const wide = buildBackgroundJobWidgetLines(record, theme, 200, 754_000).join("\n");
		assert.match(wide, /12m34s/);
		assert.match(wide, /1 denied/);
	});

	it("renders nothing and stops observing after dispose", async () => {
		const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
		const pending = pendingExecutor();
		jobs.spawn(spawnInput(pending.execute));

		const tui = { renders: 0, requestRender() { this.renders++; } };
		let tickStopped = false;
		let tick;
		const widget = new BackgroundJobLiveWidget(tui, theme, jobs, {
			now: () => 5_000,
			scheduleTick: (onTick) => { tick = onTick; return () => { tickStopped = true; }; },
		});
		assert.ok(widget.render(80).length > 0);
		tick();
		assert.equal(tui.renders, 1, "injected tick repaints");
		pending.state.onSnapshot(snapshotWith({ responseText: "progress" }));
		assert.equal(tui.renders, 2, "manager transition repaints");

		widget.dispose();
		assert.equal(tickStopped, true);
		pending.state.onSnapshot(snapshotWith({ responseText: "late" }));
		assert.equal(tui.renders, 2, "no repaint after dispose");
		pending.resolve(runResult());
		await jobs.settled("claude-job-t-1");
	});

	it("does not touch widgets outside the interactive TUI", async () => {
		const { jobs, ui } = await (async () => {
			const pi = fakePi();
			const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
			const ui = fakeUI();
			registerBackgroundJobUI(pi, { enabled: true, jobs, now: () => 0 });
			await pi.emit("session_start", { type: "session_start", reason: "startup" }, { mode: "print", ui });
			return { jobs, ui };
		})();
		const record = jobs.spawn(spawnInput(async () => runResult()));
		assert.equal(ui.widgets.size, 0);
		await jobs.settled(record.id);
	});
});

describe("/claude-jobs command", () => {
	it("reports an empty session honestly", async () => {
		const { pi } = await wire();
		const ctx = { ui: fakeUI() };
		await pi.commands.get("claude-jobs").handler("", ctx);
		assert.match(ctx.ui.notifications[0].message, /No background Claude jobs in this session/);
	});

	it("lists running and settled jobs with their terminal states", async () => {
		const { pi, jobs } = await wire();
		const done = jobs.spawn(spawnInput(async () => runResult()));
		await jobs.settled(done.id);
		const failed = jobs.spawn(spawnInput(async () => { throw new Error("exploded"); }));
		await jobs.settled(failed.id);
		const pending = pendingExecutor();
		const running = jobs.spawn(spawnInput(pending.execute, { thinking: "low" }));

		const ctx = { ui: fakeUI() };
		await pi.commands.get("claude-jobs").handler("", ctx);
		const listing = ctx.ui.notifications[0].message;
		assert.match(listing, new RegExp(`${done.id} — explorer · succeeded after`));
		assert.match(listing, new RegExp(`${failed.id} — explorer · failed after`));
		assert.match(listing, /error: exploded/);
		assert.match(listing, new RegExp(`${running.id} — explorer · running`));
		assert.match(listing, /thinking low/);
		assert.match(listing, /\/claude-jobs cancel/);

		pending.resolve(runResult());
		await jobs.settled(running.id);
	});

	it("rejects unknown arguments with usage guidance", async () => {
		const { pi } = await wire();
		const ctx = { ui: fakeUI() };
		await pi.commands.get("claude-jobs").handler("status", ctx);
		assert.equal(ctx.ui.notifications[0].type, "warning");
		assert.match(ctx.ui.notifications[0].message, /Unknown \/claude-jobs argument "status"/);
	});

	it("cancels the running job through the manager contract", async () => {
		const { pi, jobs } = await wire();
		const pending = pendingExecutor();
		const record = jobs.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(
			runResult("cancelled", snapshotWith({ status: "cancelled", responseText: "partial notes" })),
		), { once: true });

		const ctx = { ui: fakeUI() };
		await pi.commands.get("claude-jobs").handler("cancel", ctx);
		assert.equal(ctx.ui.notifications[0].type, "info");
		assert.match(ctx.ui.notifications[0].message, new RegExp(`Cancellation requested for ${record.id}`));

		await jobs.settled(record.id);
		assert.equal(jobs.get(record.id).status, "cancelled");
	});

	it("reports no-running, unknown, and already-terminal cancellations honestly", async () => {
		const { pi, jobs } = await wire();
		const command = pi.commands.get("claude-jobs");

		const none = { ui: fakeUI() };
		await command.handler("cancel", none);
		assert.equal(none.ui.notifications[0].type, "warning");
		assert.match(none.ui.notifications[0].message, /No background Claude job is running/);

		const unknown = { ui: fakeUI() };
		await command.handler("cancel claude-job-zz-9", unknown);
		assert.equal(unknown.ui.notifications[0].type, "warning");
		assert.match(unknown.ui.notifications[0].message, /Unknown background job claude-job-zz-9/);

		const record = jobs.spawn(spawnInput(async () => runResult()));
		await jobs.settled(record.id);
		const terminal = { ui: fakeUI() };
		await command.handler(`cancel ${record.id}`, terminal);
		assert.equal(terminal.ui.notifications[0].type, "warning");
		assert.match(terminal.ui.notifications[0].message, /not running \(status: succeeded\)/);
	});
});

describe("exactly-once completion delivery", () => {
	it("delivers one persisted entry and one non-triggering nextTurn message per succeeded job", async () => {
		const { pi, jobs, ui } = await wire();
		const record = jobs.spawn(spawnInput(async () => runResult("stop", snapshotWith({
			status: "succeeded",
			responseText: "the findings",
			model: "claude-opus-runtime",
		})), { thinking: "high" }));
		await jobs.settled(record.id);

		assert.equal(pi.entries.length, 1);
		const entry = pi.entries[0];
		assert.equal(entry.customType, BACKGROUND_JOB_ENTRY_TYPE);
		assert.equal(entry.data.jobId, record.id);
		assert.equal(entry.data.status, "succeeded");
		assert.equal(entry.data.snapshot.responseText, "the findings");

		assert.equal(pi.messages.length, 1);
		const { message, options } = pi.messages[0];
		assert.equal(message.customType, BACKGROUND_JOB_MESSAGE_TYPE);
		assert.equal(message.display, false);
		assert.deepEqual(message.details, { jobId: record.id, profile: "explorer", status: "succeeded" });
		assert.match(message.content, new RegExp(`Background Claude job ${record.id} \\(explorer\\) completed`));
		assert.match(message.content, /the findings/);
		// The exact Pi 0.84.2 non-triggering delivery contract.
		assert.deepEqual(options, { triggerTurn: false, deliverAs: "nextTurn" });

		assert.ok(ui.notifications.some((item) => item.message.includes(record.id) && item.message.includes("succeeded")));

		// Nothing delivers a second time for the same job.
		assert.equal(pi.entries.length, 1);
		assert.equal(pi.messages.length, 1);
	});

	it("delivers explicit failed and human-cancelled outcomes, never a successful-looking blank", async () => {
		const { pi, jobs } = await wire();

		const failed = jobs.spawn(spawnInput(async () => { throw new Error("exploded during review"); }));
		await jobs.settled(failed.id);
		assert.equal(pi.messages.length, 1);
		assert.match(pi.messages[0].message.content, /failed[^]*exploded during review/);
		assert.equal(pi.entries[0].data.status, "failed");
		assert.equal(pi.entries[0].data.error, "exploded during review");

		const pending = pendingExecutor();
		const cancelled = jobs.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(
			runResult("cancelled", snapshotWith({ status: "cancelled", responseText: "partial notes" })),
		), { once: true });
		jobs.cancel(cancelled.id);
		await jobs.settled(cancelled.id);
		assert.equal(pi.messages.length, 2);
		assert.match(pi.messages[1].message.content, /was cancelled/);
		assert.match(pi.messages[1].message.content, /Partial output before cancellation:[^]*partial notes/);
		assert.deepEqual(pi.messages[1].options, { triggerTurn: false, deliverAs: "nextTurn" });
	});

	it("says so explicitly when a success carries no output text", async () => {
		const { pi, jobs } = await wire();
		const record = jobs.spawn(spawnInput(async () => runResult("stop", snapshotWith({ status: "succeeded", responseText: "" }))));
		await jobs.settled(record.id);
		assert.match(pi.messages[0].message.content, /completed/);
		assert.match(pi.messages[0].message.content, /produced no output text/);
	});
});

describe("shutdown and reset suppression", () => {
	it("suppresses delivery and clears the widget when shutdown settles the job", async () => {
		const { pi, jobs, ui } = await wire();
		const pending = pendingExecutor();
		jobs.spawn(spawnInput(pending.execute));
		pending.state.signal.addEventListener("abort", () => pending.resolve(
			runResult("cancelled", snapshotWith({ status: "cancelled" })),
		), { once: true });
		assert.ok(ui.widgets.has(BACKGROUND_JOB_WIDGET_KEY));

		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await jobs.shutdown();
		assert.equal(pi.entries.length, 0, "no completion entry into a dying session");
		assert.equal(pi.messages.length, 0, "no completion message into a dying session");
		assert.equal(ui.widgets.has(BACKGROUND_JOB_WIDGET_KEY), false);
	});

	it("suppresses abandoned and reset settlements, then delivers normally for the next session's job", async () => {
		const { pi, jobs, ui } = await wire();
		const wedged = pendingExecutor();
		jobs.spawn(spawnInput(wedged.execute));

		// Session replacement: reset aborts, the executor never confirms, the job
		// is abandoned — and none of it is delivered into the replacement session.
		await jobs.reset();
		assert.equal(pi.entries.length, 0);
		assert.equal(pi.messages.length, 0);
		assert.equal(ui.widgets.has(BACKGROUND_JOB_WIDGET_KEY), false);

		// The replacement session starts fresh and its own jobs deliver again.
		const nextUI = fakeUI();
		await pi.emit("session_start", { type: "session_start", reason: "new" }, { mode: "tui", ui: nextUI });
		const record = jobs.spawn(spawnInput(async () => runResult()));
		await jobs.settled(record.id);
		assert.equal(pi.entries.length, 1);
		assert.equal(pi.messages.length, 1);
		assert.equal(pi.entries[0].data.jobId, record.id);

		// The wedged executor settling later changes nothing.
		wedged.resolve(runResult("cancelled", snapshotWith({ status: "cancelled" })));
		await Promise.resolve();
		assert.equal(pi.entries.length, 1);
		assert.equal(pi.messages.length, 1);
	});
});

describe("completion entry rendering", () => {
	async function settledEntryData(execute, spawnOverrides = {}) {
		const jobs = new BackgroundJobManager({ idPrefix: "t", sleep: () => Promise.resolve() });
		const record = jobs.spawn(spawnInput(execute, spawnOverrides));
		await jobs.settled(record.id);
		return buildCompletionEntryData(jobs.get(record.id));
	}

	it("renders a restored (JSON round-tripped) entry with collapsed and expanded views", async () => {
		const data = await settledEntryData(async () => runResult("stop", snapshotWith({
			status: "succeeded",
			responseText: "## Findings\nlooks solid",
			model: "claude-opus-runtime",
			sessionId: "abcdef1234567890",
			usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.0123, turns: 2, durationMs: 1500, durationApiMs: 1200, modelUsage: {} },
			tools: [{ id: "r1", name: "Read", status: "succeeded", input: { file_path: "src/a.ts" }, output: "text", startedAt: 1, updatedAt: 2, completedAt: 2, durationMs: 1, parentToolUseId: null }],
		}), {
			permission: { requested: "auto", effective: "default", overridden: true },
			managedPolicy: {
				origin: "managed-settings.json",
				disableBypassPermissions: true,
				permissionRulesOnly: false,
				denyRuleCount: 0,
				askRuleCount: 0,
				sandboxRequired: true,
				unsandboxedCommandsDisabled: false,
				managedDomainsOnly: false,
				managedReadPathsOnly: false,
			},
		}), { thinking: "high", task: "audit the module" });

		// Session restore hands the renderer plain persisted JSON, not live objects.
		const restored = JSON.parse(JSON.stringify(data));

		const collapsed = renderBackgroundJobCompletion(restored, false, theme).render(120).join("\n");
		assert.match(collapsed, /Claude explorer job succeeded/);
		assert.match(collapsed, /claude-job-t-1/);
		assert.match(collapsed, /1 tool/);
		assert.match(collapsed, /looks solid/);

		const expanded = renderBackgroundJobCompletion(restored, true, theme).render(200).join("\n");
		assert.match(expanded, /model=claude-opus-runtime/);
		assert.match(expanded, /thinking=high/);
		assert.match(expanded, /permission=auto → default/);
		assert.match(expanded, /session=abcdef123456/);
		assert.match(expanded, /cwd=\/tmp\/project/);
		assert.match(expanded, /100 in \/ 20 out/);
		assert.match(expanded, /Managed policy: sandbox required, bypass disabled/);
		assert.match(expanded, /── Task ──/);
		assert.match(expanded, /audit the module/);
		assert.match(expanded, /Read\(src\/a\.ts\)/);
		assert.match(expanded, /── Response ──/);
		assert.match(expanded, /Findings/);
	});

	it("keeps failed entries explicit and degrades malformed data visibly", async () => {
		const data = await settledEntryData(async () => { throw new Error("exploded"); });
		const rendered = renderBackgroundJobCompletion(JSON.parse(JSON.stringify(data)), true, theme).render(120).join("\n");
		assert.match(rendered, /Claude explorer job failed/);
		assert.match(rendered, /Error: exploded/);

		for (const malformed of [
			undefined,
			null,
			"junk",
			{},
			{ jobId: "partial" },
			{ ...data, status: "future-status" },
			{ ...data, snapshot: { responseText: "partial" } },
		]) {
			const fallback = renderBackgroundJobCompletion(malformed, true, theme).render(120).join("\n");
			assert.match(fallback, /entry unavailable/);
		}
	});

	it("routes rendering through the registered entry renderer", async () => {
		const { pi, jobs } = await wire();
		const record = jobs.spawn(spawnInput(async () => runResult()));
		await jobs.settled(record.id);
		const renderer = pi.entryRenderers.get(BACKGROUND_JOB_ENTRY_TYPE);
		const entry = { type: "custom", customType: BACKGROUND_JOB_ENTRY_TYPE, data: JSON.parse(JSON.stringify(pi.entries[0].data)) };
		const rendered = renderer(entry, { expanded: false }, theme).render(100).join("\n");
		assert.match(rendered, /Claude explorer job succeeded/);
	});
});

describe("completion message formatting", () => {
	function record(status, overrides = {}) {
		return {
			id: "claude-job-t-1",
			profile: "reviewer",
			task: "review",
			requestedModel: "opus",
			status,
			createdAt: 0,
			endedAt: 65_000,
			launch: { cwd: "/tmp/project", capturedAt: 0 },
			...overrides,
		};
	}

	it("keeps all four terminal outcomes explicit", () => {
		assert.match(
			buildCompletionMessageText(record("succeeded", { snapshot: snapshotWith({ status: "succeeded", resultText: "authoritative answer", responseText: "streamed" }) })),
			/completed after 1m05s\.\][^]*authoritative answer/,
		);
		assert.match(
			buildCompletionMessageText(record("failed", { error: "exploded" })),
			/failed after 1m05s: exploded\]/,
		);
		const cancelledText = buildCompletionMessageText(record("cancelled", { snapshot: snapshotWith({ status: "cancelled" }) }));
		assert.match(cancelledText, /was cancelled after 1m05s\.\]/);
		assert.match(cancelledText, /No output was produced before cancellation/);
		assert.match(
			buildCompletionMessageText(record("abandoned")),
			/was abandoned after 1m05s: its Claude Code process did not confirm termination and no result is available\.\]/,
		);
	});

	it("annotates permission overrides and denials without dropping them behind a long answer", () => {
		const text = buildCompletionMessageText(record("succeeded", {
			permission: { requested: "auto", effective: "default", overridden: true },
			managedPolicy: {
				origin: "managed-settings.json",
				disableBypassPermissions: true,
				permissionRulesOnly: false,
				denyRuleCount: 0,
				askRuleCount: 0,
				sandboxRequired: true,
				unsandboxedCommandsDisabled: false,
				managedDomainsOnly: false,
				managedReadPathsOnly: false,
			},
			snapshot: snapshotWith({
				status: "succeeded",
				responseText: "x".repeat(50_000),
				permissionDenials: [{ toolName: "WebFetch", toolUseId: "d1", reasonType: "rule", message: "denied" }],
				tools: [{ id: "r1", name: "Read", status: "succeeded", input: { file_path: "src/a.ts" }, startedAt: 1, updatedAt: 2, parentToolUseId: null }],
			}),
		}));
		assert.ok(text.length <= 16_000, "model-visible completion stays inside the retained budget");
		assert.match(text, /permission mode: requested auto, runtime default/);
		assert.match(text, /observed managed policy: sandbox required, bypass disabled/);
		assert.match(text, /permission denials: WebFetch \(rule\)/);
		assert.match(text, /Claude Code actions: Read\(src\/a\.ts\)/);
		assert.match(text, /\[… truncated \d+ chars\]/);
	});
});

describe("job status lines", () => {
	it("summarizes each record with elapsed time and the cancel hint only while running", () => {
		const running = {
			id: "claude-job-t-3",
			profile: "explorer",
			task: "t",
			requestedModel: "opus",
			status: "running",
			createdAt: 0,
			launch: { cwd: "/x", capturedAt: 0 },
		};
		const done = { ...running, id: "claude-job-t-2", status: "succeeded", endedAt: 30_000 };
		const lines = buildJobStatusLines([done, running], 90_000);
		assert.match(lines[0], /claude-job-t-2 — explorer · succeeded after 30s/);
		assert.match(lines[1], /claude-job-t-3 — explorer · running 1m30s/);
		assert.match(lines[2], /\/claude-jobs cancel/);

		const settledOnly = buildJobStatusLines([done], 90_000);
		assert.equal(settledOnly.length, 1);
	});
});
