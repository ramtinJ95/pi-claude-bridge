// Claude Sessions overlay: one Pi-native centered overlay for deep inspection
// of every Claude delegation in the session — blocking AskClaude calls,
// foreground SpawnClaudeAgent calls, and background SpawnClaudeAgent jobs —
// opened with /claude-details (canonical), /askclaude-details (compatibility
// alias), /claude-jobs, or ctrl+n.
//
// AskClaude records are read from the current session branch's persisted
// tool-call/result pairs (askclaude-details.ts) plus a single in-memory live
// slot for the running call. Background records come from persisted
// `claude-background-job` completion entries merged with the
// BackgroundJobManager's bounded records (claude-sessions.ts). Everything is
// already retained/redacted — no second viewer framework or retention path.
//
// One overlay at most: the toggle closes and reopens rather than hiding, which
// keeps focus and lifecycle state trivial. This module is the only overlay
// owner; background-job-ui delegates its TUI open through the returned handle
// instead of registering a competing overlay.

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clampScrollTop,
	extractAskClaudeCalls,
	mergeLiveCall,
	type LiveAskClaudeCall,
	type OverlayBody,
} from "./askclaude-details.js";
import {
	askClaudeOverlayFocus,
	backgroundJobsOverlayFocus,
	buildSessionBodyLines,
	buildSessionHeaderLines,
	defaultOverlayFocus,
	extractBackgroundJobRecords,
	isRunningBackground,
	mergeBackgroundJobRecords,
	mergeClaudeSessionRecords,
	requestedOverlayFocus,
	type ClaudeSessionRecord,
	type OverlayFocus,
} from "./claude-sessions.js";
import type { RenderTheme } from "./askclaude-ui.js";
import type { BackgroundJobManager } from "./background-jobs.js";

// --- Live AskClaude call slot ---
//
// One slot, latest call only. Updated from the AskClaude execute path with the
// same retained details object it publishes to Pi partial updates; replaced by
// the next call and shadowed by the persisted record once the branch has it.

let liveCall: LiveAskClaudeCall | null = null;
const liveListeners = new Set<() => void>();

function notifyLiveListeners(): void {
	for (const listener of [...liveListeners]) listener();
}

export function updateLiveAskClaudeCall(call: LiveAskClaudeCall): void {
	liveCall = call;
	notifyLiveListeners();
}

/** Clear the slot; with an id, only when it still holds that call. */
export function clearLiveAskClaudeCall(toolCallId?: string): void {
	if (!liveCall) return;
	if (toolCallId !== undefined && liveCall.toolCallId !== toolCallId) return;
	liveCall = null;
	notifyLiveListeners();
}

export function getLiveAskClaudeCall(): LiveAskClaudeCall | null {
	return liveCall;
}

export function subscribeLiveAskClaudeCall(listener: () => void): () => void {
	liveListeners.add(listener);
	return () => liveListeners.delete(listener);
}

// @internal
export const __overlayTest = {
	liveListenerCount: () => liveListeners.size,
};

// --- Overlay component ---

interface OverlayTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

interface OverlayKeybindings {
	matches(data: string, keybinding: string): boolean;
}

/** The manager surface the overlay observes for background-job updates. */
export type OverlayJobSource = Pick<BackgroundJobManager, "subscribe" | "list" | "running">;

const MIN_OVERLAY_HEIGHT = 8;
const HEIGHT_FRACTION = 0.85;

type TickScheduler = (onTick: () => void) => () => void;

const defaultTickScheduler: TickScheduler = (onTick) => {
	const timer = setInterval(onTick, 1_000);
	timer.unref?.();
	return () => clearInterval(timer);
};

export class ClaudeSessionsOverlay {
	private records: ClaudeSessionRecord[] = [];
	private recordIndex = -1;
	/** Explicit selection; null follows the latest record across reloads. */
	private selectedRecordId: string | null = null;
	scrollTop = 0;
	private bodyCache: { width: number; body: OverlayBody } | null = null;
	private lastBodyWidth = 76;
	private unsubscribeLive: () => void;
	private unsubscribeJobs: () => void;
	private stopTicking: () => void;
	private disposed = false;

	constructor(
		private tui: OverlayTui,
		private theme: RenderTheme,
		private keybindings: OverlayKeybindings,
		private done: () => void,
		private loadRecords: () => ClaudeSessionRecord[],
		focus?: (records: readonly ClaudeSessionRecord[]) => OverlayFocus,
		jobs?: Pick<BackgroundJobManager, "subscribe">,
		scheduleTick: TickScheduler = defaultTickScheduler,
	) {
		this.records = loadRecords();
		const resolved = (focus ?? defaultOverlayFocus)(this.records);
		// A focus rule that resolves to nothing (records changed between the
		// caller's check and this load) falls back to the latest record.
		this.recordIndex = this.records.length === 0
			? -1
			: resolved.index >= 0
				? Math.min(this.records.length - 1, resolved.index)
				: this.records.length - 1;
		if (resolved.pinned && this.recordIndex >= 0) {
			this.selectedRecordId = this.records[this.recordIndex].id;
		}
		// The overlay subscribes to both live sources while open and releases
		// both on dispose: the AskClaude live slot and the background manager.
		this.unsubscribeLive = subscribeLiveAskClaudeCall(() => this.reload());
		this.unsubscribeJobs = jobs?.subscribe(() => this.reload()) ?? (() => {});
		// Manager snapshots are event-driven, so a quiet background job may not
		// update for seconds or minutes. Repaint the live header once per second
		// to keep its elapsed time truthful without invalidating the cached body.
		this.stopTicking = scheduleTick(() => {
			if (!this.disposed && this.current && isRunningBackground(this.current)) this.tui.requestRender();
		});
	}

	private get current(): ClaudeSessionRecord | undefined {
		return this.recordIndex >= 0 ? this.records[this.recordIndex] : undefined;
	}

	private reload(): void {
		if (this.disposed) return;
		const previous = this.current;
		this.records = this.loadRecords();
		const pinned = this.selectedRecordId
			? this.records.findIndex((record) => record.id === this.selectedRecordId)
			: -1;
		this.recordIndex = pinned >= 0 ? pinned : this.records.length - 1;
		const current = this.current;
		// A live update can add or update the latest record while this overlay is
		// pinned to an older, immutable record. Keep its parsed Markdown body in
		// that case; rebuilding retained tool output on every live tick is costly.
		if (!sameRenderIdentity(previous, current)) {
			this.bodyCache = null;
		}
		this.tui.requestRender();
	}

	private body(width: number): OverlayBody {
		const record = this.current;
		if (!record) return { lines: [], sections: [] };
		if (!this.bodyCache || this.bodyCache.width !== width) {
			this.bodyCache = { width, body: buildSessionBodyLines(record, this.theme, width) };
		}
		return this.bodyCache.body;
	}

	/** Fit header/body/footer into ~85% of the terminal height, shrinking the pinned header first on tiny terminals. */
	private layout(headerLines: number): { headerShown: number; viewport: number } {
		const rows = this.tui.terminal?.rows || 24;
		const total = Math.max(MIN_OVERLAY_HEIGHT, Math.min(Math.floor(rows * HEIGHT_FRACTION), rows - 2));
		// Fixed chrome: borders (2) + two dividers (2) + footer (2) + at least one body line.
		const headerShown = Math.max(1, Math.min(headerLines, total - 7));
		const viewport = Math.max(1, total - 2 - headerShown - 1 - 2 - 1);
		return { headerShown, viewport };
	}

	private moveRecord(direction: 1 | -1): void {
		if (this.records.length === 0) return;
		const next = Math.max(0, Math.min(this.records.length - 1, this.recordIndex + direction));
		if (next === this.recordIndex) return;
		this.recordIndex = next;
		// Landing on the latest record resumes following it across live reloads.
		this.selectedRecordId = next === this.records.length - 1 ? null : this.records[next].id;
		this.scrollTop = 0;
		this.bodyCache = null;
		this.tui.requestRender();
	}

	private scrollBy(delta: number, viewport: number, totalLines: number): void {
		this.scrollTop = clampScrollTop(this.scrollTop + delta, totalLines, viewport);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+n") || data === "q") {
			this.done();
			return;
		}
		const record = this.current;
		if (!record) return;
		const body = this.body(this.lastBodyWidth);
		const header = buildSessionHeaderLines(record, { index: this.recordIndex, total: this.records.length }, this.theme);
		const { viewport } = this.layout(header.length);
		const page = Math.max(1, viewport - 1);

		if (matchesKey(data, "up") || data === "k") this.scrollBy(-1, viewport, body.lines.length);
		else if (matchesKey(data, "down") || data === "j") this.scrollBy(1, viewport, body.lines.length);
		else if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.select.pageUp")) this.scrollBy(-page, viewport, body.lines.length);
		else if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.select.pageDown")) this.scrollBy(page, viewport, body.lines.length);
		else if (matchesKey(data, "home")) { this.scrollTop = 0; this.tui.requestRender(); }
		else if (matchesKey(data, "end")) { this.scrollTop = clampScrollTop(body.lines.length, body.lines.length, viewport); this.tui.requestRender(); }
		else if (matchesKey(data, "left") || data === "p") this.moveRecord(-1);
		else if (matchesKey(data, "right") || data === "n") this.moveRecord(1);
		else if (/^[1-9]$/.test(data)) {
			const section = body.sections[Number(data) - 1];
			if (section) {
				this.scrollTop = clampScrollTop(section.line, body.lines.length, viewport);
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const innerWidth = Math.max(20, width) - 2;
		const border = (text: string) => theme.fg("border", text);
		const boxLine = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "…", true);
			return border("│") + truncated + border("│");
		};
		const divider = () => border(`├${"─".repeat(innerWidth)}┤`);
		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerWidth)}╮`));

		const record = this.current;
		if (!record) {
			lines.push(boxLine(theme.fg("dim", " No Claude sessions in this session branch.")));
			lines.push(boxLine(theme.fg("dim", " Press q, Esc, or Ctrl+N to close.")));
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		}

		const header = buildSessionHeaderLines(record, { index: this.recordIndex, total: this.records.length }, theme);
		this.lastBodyWidth = Math.max(10, innerWidth - 2);
		const body = this.body(this.lastBodyWidth);
		const { headerShown, viewport } = this.layout(header.length);
		this.scrollTop = clampScrollTop(this.scrollTop, body.lines.length, viewport);

		for (const line of header.slice(0, headerShown)) lines.push(boxLine(` ${line}`));
		lines.push(divider());

		const visible = body.lines.slice(this.scrollTop, this.scrollTop + viewport);
		for (const line of visible) lines.push(boxLine(` ${line}`));
		for (let i = visible.length; i < viewport; i++) lines.push(boxLine(""));

		lines.push(divider());
		const first = body.lines.length === 0 ? 0 : this.scrollTop + 1;
		const last = Math.min(body.lines.length, this.scrollTop + viewport);
		const percent = body.lines.length <= viewport ? 100 : Math.round((last / body.lines.length) * 100);
		const sectionHints = body.sections.map((section, i) => `${i + 1}:${section.title}`).join(" ");
		lines.push(boxLine(` ${theme.fg("muted", `lines ${first}-${last}/${body.lines.length} (${percent}%)`)}  ${theme.fg("dim", sectionHints)}`));
		lines.push(boxLine(` ${theme.fg("dim", "↑↓/jk scroll · PgUp/PgDn · Home/End · ←→ prev/next record · 1-9 section · q/Esc/Ctrl+N close")}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		// Rendered body lines contain theme-specific ANSI styling.
		this.bodyCache = null;
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeLive();
		this.unsubscribeJobs();
		this.stopTicking();
	}
}

/**
 * Whether the previously shown record and the reloaded current record would
 * render the same body, so the parsed Markdown cache can survive a reload.
 */
function sameRenderIdentity(previous: ClaudeSessionRecord | undefined, current: ClaudeSessionRecord | undefined): boolean {
	if (previous === undefined || current === undefined) return previous === current;
	if (previous.kind !== current.kind || previous.id !== current.id) return false;
	if (previous.kind === "askclaude" && current.kind === "askclaude") {
		return previous.call.details === current.call.details
			&& previous.call.prompt === current.call.prompt
			&& previous.call.status === current.call.status
			&& previous.call.live === current.call.live;
	}
	if (previous.kind === "background" && current.kind === "background") {
		return previous.data === current.data
			&& previous.malformed === current.malformed
			&& previous.live === current.live;
	}
	return false;
}

// --- Registration ---

export interface ClaudeSessionsUIHandle {
	/**
	 * `/claude-jobs` TUI behavior: open the unified overlay focused on the
	 * running background job, else the latest background job; notify honestly
	 * when the session has none.
	 */
	openBackgroundJobs(ctx: ExtensionContext): Promise<void>;
}

export function registerClaudeSessionsUI(
	pi: ExtensionAPI,
	options: { toolName: string; spawnToolName?: string; jobs: OverlayJobSource },
): ClaudeSessionsUIHandle {
	const { toolName, spawnToolName, jobs } = options;
	let closeActive: (() => void) | null = null;

	const loadRecordsFor = (ctx: ExtensionContext) => () => {
		const entries = ctx.sessionManager.getBranch();
		// Foreground SpawnClaudeAgent calls are extracted as foreground Claude
		// records alongside AskClaude compatibility calls; background spawns are
		// covered by the job records below.
		const calls = mergeLiveCall(extractAskClaudeCalls(entries, toolName, spawnToolName), getLiveAskClaudeCall());
		const background = mergeBackgroundJobRecords(extractBackgroundJobRecords(entries), jobs.list());
		return mergeClaudeSessionRecords(calls, background);
	};

	const open = async (
		ctx: ExtensionContext,
		focus?: (records: readonly ClaudeSessionRecord[]) => OverlayFocus,
	): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui?.notify?.("The Claude sessions overlay requires the interactive TUI.", "warning");
			return;
		}
		closeActive?.();
		const loadRecords = loadRecordsFor(ctx);
		if (loadRecords().length === 0) {
			ctx.ui.notify(`No ${toolName} calls or background Claude jobs in this session branch yet.`, "info");
			return;
		}
		let finishForThisOpen: (() => void) | null = null;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					const finish = () => {
						if (closeActive === finish) closeActive = null;
						done(undefined);
					};
					finishForThisOpen = finish;
					closeActive = finish;
					return new ClaudeSessionsOverlay(tui, theme, keybindings, finish, loadRecords, focus, jobs);
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 40, maxHeight: "85%" },
				},
			);
		} finally {
			// A replacement overlay may already own the global toggle by the time
			// the previous custom() promise settles.
			if (closeActive === finishForThisOpen) closeActive = null;
		}
	};

	const parseIndex = (args: string): number | undefined => {
		const requested = Number.parseInt(args.trim(), 10);
		return Number.isFinite(requested) && requested > 0 ? requested : undefined;
	};

	pi.registerCommand("claude-details", {
		description: `Inspect Claude sessions — ${toolName} calls and background jobs (optionally: /claude-details <record number>)`,
		handler: async (args, ctx) => {
			const requested = parseIndex(args);
			await open(ctx, requested === undefined ? undefined : (records) => requestedOverlayFocus(records, requested));
		},
	});

	// Compatibility alias: same unfiltered overlay, focused on the latest
	// AskClaude record; <n> is resolved among AskClaude calls only, preserving
	// this command's original numbering semantics.
	pi.registerCommand("askclaude-details", {
		description: `Alias of /claude-details focused on ${toolName} calls (optionally: /askclaude-details <call number>)`,
		handler: async (args, ctx) => {
			const requested = parseIndex(args);
			const focus = askClaudeOverlayFocus(loadRecordsFor(ctx)(), requested);
			if (focus.index < 0) {
				ctx.ui.notify(`No ${toolName} calls in this session branch yet.`, "info");
				return;
			}
			await open(ctx, (records) => askClaudeOverlayFocus(records, requested));
		},
	});

	pi.registerShortcut("ctrl+n", {
		description: "Toggle the Claude sessions overlay",
		handler: async (ctx) => {
			if (closeActive) {
				closeActive();
				return;
			}
			await open(ctx);
		},
	});

	return {
		openBackgroundJobs: async (ctx) => {
			if (ctx.mode === "tui") {
				const focus = backgroundJobsOverlayFocus(loadRecordsFor(ctx)());
				if (focus.index < 0) {
					ctx.ui.notify("No background Claude jobs in this session. Start one with the SpawnClaudeAgent tool.", "info");
					return;
				}
			}
			await open(ctx, backgroundJobsOverlayFocus);
		},
	};
}
