// Extraction and view-model helpers for the AskClaude details overlay.
//
// Everything here is pure over already-persisted session-branch entries or the
// single in-memory live call slot. The overlay component (askclaude-overlay.ts)
// owns keyboard/scroll state; this module owns what a call record is and which
// lines it renders to. Header metadata comes exclusively from the Claude
// delegation record — a missing value renders as "unavailable" rather than
// falling back to the active Pi session's model, cwd, or permission settings.

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type { DelegationSnapshot, DelegationToolCall } from "./delegation-events.js";
import {
	formatToolDuration,
	toolStatusIcon,
	valueMarkdown,
	type AskClaudeResultDetails,
	type RenderTheme,
} from "./askclaude-ui.js";
import { managedPolicyLabels } from "./query-policy.js";

export type AskClaudeCallStatus = "running" | "completed" | "failed" | "cancelled" | "unresolved";

export interface AskClaudeCallRecord {
	toolCallId: string;
	/** ISO timestamp of the tool-call entry, when known. */
	timestamp?: string;
	/** Full original prompt from the persisted tool-call arguments (or live memory). */
	prompt?: string;
	details?: AskClaudeResultDetails;
	isError?: boolean;
	status: AskClaudeCallStatus;
	/** True when this record comes from the in-memory live slot, not the session branch. */
	live?: boolean;
}

export interface LiveAskClaudeCall {
	toolCallId: string;
	startedAt: number;
	prompt: string;
	details: AskClaudeResultDetails;
}

interface BranchEntryLike {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
}

function deriveCallStatus(details: AskClaudeResultDetails | undefined, isError: boolean | undefined): AskClaudeCallStatus {
	if (!details) return "unresolved";
	if (details.cancelled || details.snapshot?.status === "cancelled") return "cancelled";
	if (details.error || details.snapshot?.status === "failed" || isError) return "failed";
	if (details.snapshot?.status === "running") return "running";
	return "completed";
}

/**
 * Read AskClaude tool-call/result pairs from real session-branch entries.
 *
 * The assistant message's persisted `toolCall` arguments are the source for the
 * full original prompt; the paired `toolResult` message's `details` carry the
 * retained snapshot. Both survive session restore, so completed calls are
 * inspectable without any second persistence format.
 */
export function extractAskClaudeCalls(entries: readonly unknown[], toolName: string): AskClaudeCallRecord[] {
	const records: AskClaudeCallRecord[] = [];
	const byId = new Map<string, AskClaudeCallRecord>();
	for (const raw of entries) {
		const entry = raw as BranchEntryLike;
		if (entry?.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
				if (call.type !== "toolCall" || call.name !== toolName || typeof call.id !== "string") continue;
				const record: AskClaudeCallRecord = {
					toolCallId: call.id,
					timestamp: entry.timestamp,
					prompt: typeof call.arguments?.prompt === "string" ? call.arguments.prompt : undefined,
					status: "unresolved",
				};
				records.push(record);
				byId.set(call.id, record);
			}
			continue;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const record = byId.get(message.toolCallId);
			if (!record) continue;
			record.details = message.details as AskClaudeResultDetails | undefined;
			record.isError = message.isError === true;
			record.status = deriveCallStatus(record.details, record.isError);
		}
	}
	return records;
}

/** Shape the in-memory live slot as a call record. */
export function liveCallRecord(live: LiveAskClaudeCall): AskClaudeCallRecord {
	return {
		toolCallId: live.toolCallId,
		timestamp: new Date(live.startedAt).toISOString(),
		prompt: live.prompt,
		details: live.details,
		// A live slot without a snapshot yet is a call that just started.
		status: live.details.snapshot ? deriveCallStatus(live.details, false) : "running",
		live: true,
	};
}

/**
 * Merge the live slot into branch records. The session branch is authoritative:
 * once a persisted result exists for the same tool call, the live copy is
 * dropped. A branch entry for a still-running call (tool call persisted, no
 * result yet) is replaced by the live record so the overlay updates.
 */
export function mergeLiveCall(records: AskClaudeCallRecord[], live: LiveAskClaudeCall | null): AskClaudeCallRecord[] {
	if (!live) return records;
	const index = records.findIndex((record) => record.toolCallId === live.toolCallId);
	if (index < 0) return [...records, liveCallRecord(live)];
	if (records[index].details) return records;
	const merged = [...records];
	merged[index] = { ...liveCallRecord(live), prompt: records[index].prompt ?? live.prompt, timestamp: records[index].timestamp };
	return merged;
}

/** Resolve a 1-based requested call number to an index; defaults to the latest call. */
export function selectCallIndex(recordCount: number, requested?: number): number {
	if (recordCount <= 0) return -1;
	if (requested === undefined || !Number.isFinite(requested)) return recordCount - 1;
	return Math.max(0, Math.min(recordCount - 1, Math.floor(requested) - 1));
}

export function clampScrollTop(top: number, totalLines: number, viewportLines: number): number {
	return Math.max(0, Math.min(top, Math.max(0, totalLines - viewportLines)));
}

const UNAVAILABLE = "unavailable";

function statusPresentation(status: AskClaudeCallStatus): { icon: string; color: string } {
	switch (status) {
		case "running": return { icon: "◉", color: "mdLink" };
		case "completed": return { icon: "✓", color: "success" };
		case "failed": return { icon: "✗", color: "error" };
		case "cancelled": return { icon: "⊘", color: "warning" };
		case "unresolved": return { icon: "•", color: "muted" };
	}
}

function usageText(snapshot: DelegationSnapshot | undefined): string {
	const usage = snapshot?.usage;
	if (!usage) return `tokens: ${UNAVAILABLE}`;
	const cache = ` · cache ${usage.cacheReadInputTokens.toLocaleString()} read / ${usage.cacheCreationInputTokens.toLocaleString()} write`;
	return `tokens: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out${cache} · ${usage.turns} turns · $${usage.totalCostUsd.toFixed(4)}`;
}

function permissionText(details: AskClaudeResultDetails | undefined): string {
	if (details?.permission) {
		return details.permission.overridden
			? `${details.permission.requested} → ${details.permission.effective}`
			: details.permission.effective;
	}
	return details?.snapshot?.runtimePermissionMode ?? UNAVAILABLE;
}

/**
 * Pinned header lines. Every value is taken from the Claude delegation record;
 * when the record lacks one, it reads "unavailable" instead of borrowing the
 * corresponding value from the active Pi session.
 */
export function buildOverlayHeaderLines(
	record: AskClaudeCallRecord,
	position: { index: number; total: number },
	theme: RenderTheme,
): string[] {
	const details = record.details;
	const snapshot = details?.snapshot;
	const status = statusPresentation(record.status);
	const when = record.timestamp ? new Date(record.timestamp).toLocaleString() : UNAVAILABLE;
	const elapsed = details?.executionTime != null ? ` · ${(details.executionTime / 1000).toFixed(1)}s` : "";
	const lines: string[] = [];

	lines.push(
		theme.fg(status.color, `${status.icon} ${theme.bold("AskClaude details")}`) +
		theme.fg("muted", ` · call ${position.index + 1}/${position.total} · ${record.status}${record.live ? " (live)" : ""}${elapsed} · ${when}`),
	);
	const model = snapshot?.model
		? `${snapshot.model}${details?.requestedModel ? ` (requested ${details.requestedModel})` : ""}`
		: details?.requestedModel
			? `${UNAVAILABLE} (requested ${details.requestedModel})`
			: UNAVAILABLE;
	lines.push(theme.fg("dim", `model: ${model} · session: ${snapshot?.sessionId ?? UNAVAILABLE} · permission: ${permissionText(details)}`));
	lines.push(theme.fg("dim", `cwd: ${snapshot?.cwd ?? UNAVAILABLE}`));
	lines.push(theme.fg("dim", usageText(snapshot)));
	lines.push(theme.fg("dim", [
		`capability: ${details?.capabilityMode ?? UNAVAILABLE}`,
		`conversation: ${details?.isolated == null ? UNAVAILABLE : details.isolated ? "isolated" : "shared"}`,
		details?.thinking ? `thinking: ${details.thinking}` : undefined,
	].filter(Boolean).join(" · ")));

	const policyLabels = managedPolicyLabels(details?.managedPolicy);
	if (policyLabels.length) lines.push(theme.fg("warning", `managed policy: ${policyLabels.join(", ")}`));
	if (details?.permissionDenials?.length) {
		const omitted = snapshot?.permissionDenialsOmitted ? ` (${snapshot.permissionDenialsOmitted} earlier omitted)` : "";
		lines.push(theme.fg("warning", `permission denials${omitted}: ${details.permissionDenials.map((item) => item.toolName).join(", ")}`));
	}
	if (snapshot?.retry) lines.push(theme.fg("warning", `retry ${snapshot.retry.attempt}/${snapshot.retry.maxRetries}: ${snapshot.retry.error}`));
	if (snapshot?.rateLimit) lines.push(theme.fg("warning", `rate limit: ${snapshot.rateLimit.status}`));
	return lines;
}

export interface OverlaySection {
	title: string;
	line: number;
}

export interface OverlayBody {
	lines: string[];
	sections: OverlaySection[];
}

function markdownLines(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(10, width));
}

function toolDepth(tool: DelegationToolCall, byId: Map<string, DelegationToolCall>): number {
	let depth = 0;
	let parent = tool.parentToolUseId;
	const visited = new Set<string>();
	while (parent && byId.has(parent) && !visited.has(parent) && depth < 8) {
		visited.add(parent);
		depth++;
		parent = byId.get(parent)?.parentToolUseId ?? null;
	}
	return depth;
}

/**
 * Scrollable body lines plus the section jump table. All content is the already
 * retained/redacted record — truncation and omission notices are shown as
 * persisted, never re-expanded — except the prompt, which is displayed from the
 * persisted tool-call arguments (or the live call's in-memory prompt).
 */
export function buildOverlayBodyLines(record: AskClaudeCallRecord, theme: RenderTheme, width: number): OverlayBody {
	const details = record.details;
	const snapshot = details?.snapshot;
	const lines: string[] = [];
	const sections: OverlaySection[] = [];

	const section = (title: string, omittedNote?: string) => {
		if (lines.length > 0) lines.push("");
		sections.push({ title, line: lines.length });
		lines.push(theme.fg("muted", `── ${title}${omittedNote ?? ""} ──`));
	};

	section("Prompt");
	const prompt = record.prompt ?? details?.prompt;
	if (prompt) {
		if (!record.prompt && details?.prompt) lines.push(theme.fg("dim", "(retained copy — original tool-call arguments unavailable)"));
		lines.push(...markdownLines(prompt, width));
	} else {
		lines.push(theme.fg("dim", UNAVAILABLE));
	}

	section("Thinking");
	if (snapshot?.thinkingText) lines.push(...markdownLines(snapshot.thinkingText, width));
	else lines.push(theme.fg("dim", "no thinking summary emitted"));

	section("Tools", snapshot?.toolsOmitted ? ` (${snapshot.toolsOmitted} earlier omitted)` : "");
	if (snapshot?.tools.length) {
		const byId = new Map(snapshot.tools.map((tool) => [tool.id, tool]));
		for (const tool of snapshot.tools) {
			const indent = "  ".repeat(toolDepth(tool, byId));
			const duration = formatToolDuration(tool);
			lines.push(`${indent}${toolStatusIcon(tool, theme)} ${theme.bold(tool.name)} ${theme.fg("muted", tool.status)}${duration ? ` ${theme.fg("dim", duration)}` : ""}`);
			if (tool.input !== undefined) {
				lines.push(`${indent}${theme.fg("muted", "input:")}`);
				lines.push(...markdownLines(valueMarkdown(tool.input), Math.max(10, width - indent.length)).map((line) => indent + line));
			}
			if (tool.output) {
				lines.push(`${indent}${theme.fg("muted", "output:")}`);
				lines.push(...markdownLines(tool.output, Math.max(10, width - indent.length)).map((line) => indent + line));
			} else if (tool.error) {
				lines.push(`${indent}${theme.fg("error", tool.error)}`);
			}
		}
	} else {
		lines.push(theme.fg("dim", record.details ? "no retained tool calls" : UNAVAILABLE));
	}

	section("Timeline", snapshot?.timelineOmitted ? ` (${snapshot.timelineOmitted} earlier omitted)` : "");
	if (snapshot?.timeline.length) {
		for (const entry of snapshot.timeline) {
			const elapsed = Math.max(0, entry.at - snapshot.startedAt) / 1000;
			lines.push(`${theme.fg("dim", `${elapsed.toFixed(1)}s`)} ${theme.bold(entry.kind)} ${entry.label}`);
		}
	} else {
		lines.push(theme.fg("dim", record.details ? "no retained timeline" : UNAVAILABLE));
	}

	section("Response");
	const failed = record.status === "failed";
	const failureText = failed ? snapshot?.error ?? (details?.error ? "Claude Code reported an error" : undefined) : undefined;
	if (failureText) lines.push(theme.fg("error", failureText.startsWith("Error:") ? failureText : `Error: ${failureText}`));
	if (record.status === "cancelled") lines.push(theme.fg("warning", "Cancelled — partial response below, if any."));
	const body = snapshot?.resultText ?? snapshot?.responseText;
	if (body) lines.push(...markdownLines(body, width));
	else if (!failureText) lines.push(theme.fg("dim", record.details ? "no response text retained" : "no result recorded for this call"));

	if (snapshot?.diagnostics.length) {
		section("Diagnostics", snapshot.diagnosticsOmitted ? ` (${snapshot.diagnosticsOmitted} earlier omitted)` : "");
		for (const diagnostic of snapshot.diagnostics) lines.push(theme.fg("warning", `${diagnostic.kind}: ${diagnostic.label}`));
	}

	return { lines, sections };
}
