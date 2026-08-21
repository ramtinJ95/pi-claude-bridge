// AskClaude details overlay: a Pi-native centered overlay for deep inspection
// of AskClaude calls, opened with /askclaude-details or ctrl+n.
//
// Completed calls are read from the current session branch's persisted
// tool-call/result records (askclaude-details.ts), so they remain inspectable
// after session restore. A single in-memory live slot lets the latest call
// update while it runs; it holds the same bounded, retained, redacted details
// the tool row streams — no second persistence format, no transcript buffer.
//
// One overlay at most: the toggle closes and reopens rather than hiding, which
// keeps focus and lifecycle state trivial.

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildOverlayBodyLines,
	buildOverlayHeaderLines,
	clampScrollTop,
	extractAskClaudeCalls,
	mergeLiveCall,
	selectCallIndex,
	type AskClaudeCallRecord,
	type LiveAskClaudeCall,
	type OverlayBody,
} from "./askclaude-details.js";
import type { RenderTheme } from "./askclaude-ui.js";

// --- Live call slot ---
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

const MIN_OVERLAY_HEIGHT = 8;
const HEIGHT_FRACTION = 0.85;

export class AskClaudeDetailsOverlay {
	private records: AskClaudeCallRecord[] = [];
	private callIndex = -1;
	/** Explicit selection; null follows the latest call across reloads. */
	private selectedToolCallId: string | null = null;
	scrollTop = 0;
	private bodyCache: { width: number; body: OverlayBody } | null = null;
	private lastBodyWidth = 76;
	private unsubscribeLive: () => void;
	private disposed = false;

	constructor(
		private tui: OverlayTui,
		private theme: RenderTheme,
		private keybindings: OverlayKeybindings,
		private done: () => void,
		private loadRecords: () => AskClaudeCallRecord[],
		requestedIndex?: number,
	) {
		this.records = loadRecords();
		this.callIndex = selectCallIndex(this.records.length, requestedIndex);
		if (requestedIndex !== undefined && this.callIndex >= 0 && this.callIndex < this.records.length - 1) {
			this.selectedToolCallId = this.records[this.callIndex].toolCallId;
		}
		this.unsubscribeLive = subscribeLiveAskClaudeCall(() => this.reload());
	}

	private get current(): AskClaudeCallRecord | undefined {
		return this.callIndex >= 0 ? this.records[this.callIndex] : undefined;
	}

	private reload(): void {
		if (this.disposed) return;
		const previous = this.current;
		this.records = this.loadRecords();
		const pinned = this.selectedToolCallId
			? this.records.findIndex((record) => record.toolCallId === this.selectedToolCallId)
			: -1;
		this.callIndex = pinned >= 0 ? pinned : this.records.length - 1;
		const current = this.current;
		// A live update can add or update the latest call while this overlay is
		// pinned to an older, immutable record. Keep its parsed Markdown body in
		// that case; rebuilding retained tool output on every live tick is costly.
		if (
			previous?.toolCallId !== current?.toolCallId ||
			previous?.details !== current?.details ||
			previous?.prompt !== current?.prompt ||
			previous?.status !== current?.status ||
			previous?.live !== current?.live
		) {
			this.bodyCache = null;
		}
		this.tui.requestRender();
	}

	private body(width: number): OverlayBody {
		const record = this.current;
		if (!record) return { lines: [], sections: [] };
		if (!this.bodyCache || this.bodyCache.width !== width) {
			this.bodyCache = { width, body: buildOverlayBodyLines(record, this.theme, width) };
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

	private moveCall(direction: 1 | -1): void {
		if (this.records.length === 0) return;
		const next = Math.max(0, Math.min(this.records.length - 1, this.callIndex + direction));
		if (next === this.callIndex) return;
		this.callIndex = next;
		// Landing on the latest call resumes following it across live reloads.
		this.selectedToolCallId = next === this.records.length - 1 ? null : this.records[next].toolCallId;
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
		const header = buildOverlayHeaderLines(record, { index: this.callIndex, total: this.records.length }, this.theme);
		const { viewport } = this.layout(header.length);
		const page = Math.max(1, viewport - 1);

		if (matchesKey(data, "up") || data === "k") this.scrollBy(-1, viewport, body.lines.length);
		else if (matchesKey(data, "down") || data === "j") this.scrollBy(1, viewport, body.lines.length);
		else if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.select.pageUp")) this.scrollBy(-page, viewport, body.lines.length);
		else if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.select.pageDown")) this.scrollBy(page, viewport, body.lines.length);
		else if (matchesKey(data, "home")) { this.scrollTop = 0; this.tui.requestRender(); }
		else if (matchesKey(data, "end")) { this.scrollTop = clampScrollTop(body.lines.length, body.lines.length, viewport); this.tui.requestRender(); }
		else if (matchesKey(data, "left") || data === "p") this.moveCall(-1);
		else if (matchesKey(data, "right") || data === "n") this.moveCall(1);
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
			lines.push(boxLine(theme.fg("dim", " No AskClaude calls in this session branch.")));
			lines.push(boxLine(theme.fg("dim", " Press q, Esc, or Ctrl+N to close.")));
			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines;
		}

		const header = buildOverlayHeaderLines(record, { index: this.callIndex, total: this.records.length }, theme);
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
		lines.push(boxLine(` ${theme.fg("dim", "↑↓/jk scroll · PgUp/PgDn · Home/End · ←→ prev/next call · 1-9 section · q/Esc/Ctrl+N close")}`));
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
	}
}

// --- Registration ---

export function registerAskClaudeDetailsUI(pi: ExtensionAPI, options: { toolName: string }): void {
	let closeActive: (() => void) | null = null;

	const open = async (ctx: ExtensionContext, requestedIndex?: number): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui?.notify?.("The AskClaude details overlay requires the interactive TUI.", "warning");
			return;
		}
		closeActive?.();
		const loadRecords = () =>
			mergeLiveCall(extractAskClaudeCalls(ctx.sessionManager.getBranch(), options.toolName), getLiveAskClaudeCall());
		if (loadRecords().length === 0) {
			ctx.ui.notify(`No ${options.toolName} calls in this session branch yet.`, "info");
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
					return new AskClaudeDetailsOverlay(tui, theme, keybindings, finish, loadRecords, requestedIndex);
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

	pi.registerCommand("askclaude-details", {
		description: `Inspect ${options.toolName} call details (optionally: /askclaude-details <call number>)`,
		handler: async (args, ctx) => {
			const requested = Number.parseInt(args.trim(), 10);
			await open(ctx, Number.isFinite(requested) && requested > 0 ? requested : undefined);
		},
	});

	pi.registerShortcut("ctrl+n", {
		description: `Toggle the ${options.toolName} details overlay`,
		handler: async (ctx) => {
			if (closeActive) {
				closeActive();
				return;
			}
			await open(ctx);
		},
	});
}
