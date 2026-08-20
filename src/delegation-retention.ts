// Retention limits are deliberately product choices, not a persistence format.
// Keep them independent so a UI adjustment cannot silently enlarge every field.
export const MODEL_RESULT_MAX_CHARS = 16_000;
export const TOOL_FIELD_MAX_CHARS = 2_000;
export const TIMELINE_MAX_CHARS = 32_000;
export const TIMELINE_MAX_EVENTS = 100;
export const RETAINED_LIST_MAX_ITEMS = 100;
export const THINKING_MAX_CHARS = 4_000;
export const PROMPT_MAX_CHARS = 8_000;

const REDACTED = "[REDACTED]";

function sensitiveKey(key: string): boolean {
	return /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|session[-_]?token|cookie|private[-_]?key)/i.test(key);
}

/** Best-effort display/session redaction. This is not a substitute for tool policy. */
export function redactSensitiveText(text: string): string {
	return text
		.replace(/\b(sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{12,})\b/g, REDACTED)
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
		.replace(/(["']?(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|session[-_]?token|cookie|private[-_]?key)["']?\s*[=:]\s*["']?)([^\s,"'}]+)/gi, `$1${REDACTED}`)
		.replace(/(https?:\/\/[^\s/:@]+:)([^\s@/]+)(@)/gi, `$1${REDACTED}$3`);
}

export function truncateVisible(text: string, maxChars: number): string {
	return retainTextWithOmissions(text, maxChars, 0, false);
}

export function retainText(text: string, maxChars: number): string {
	return retainTextWithOmissions(text, maxChars);
}

/** Redact and fit one field plus a single accurate omission marker inside its cap. */
export function retainTextWithOmissions(
	text: string,
	maxChars: number,
	previouslyOmitted = 0,
	redact = true,
): string {
	const retained = redact ? redactSensitiveText(text) : text;
	if (retained.length <= maxChars && previouslyOmitted === 0) return retained;

	let newlyOmitted = Math.max(0, retained.length - maxChars);
	let marker = "";
	// The marker itself consumes retained space, which increases the number of
	// source characters omitted. Iterate until the digit width and slice agree.
	for (let i = 0; i < 5; i++) {
		marker = `\n[… truncated ${previouslyOmitted + newlyOmitted} chars]`;
		const next = Math.max(0, retained.length - Math.max(0, maxChars - marker.length));
		if (next === newlyOmitted) break;
		newlyOmitted = next;
	}
	marker = `\n[… truncated ${previouslyOmitted + newlyOmitted} chars]`;
	if (marker.length >= maxChars) return marker.slice(0, maxChars);
	return retained.slice(0, maxChars - marker.length) + marker;
}

export function appendRetainedText(
	current: string,
	delta: string,
	maxChars: number,
	previouslyOmitted = 0,
): { text: string; omittedChars: number } {
	if (previouslyOmitted > 0 || current.length >= maxChars) {
		return { text: current, omittedChars: previouslyOmitted + delta.length };
	}
	const room = maxChars - current.length;
	return {
		text: current + delta.slice(0, room),
		omittedChars: previouslyOmitted + Math.max(0, delta.length - room),
	};
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
	if (sensitiveKey(key)) return REDACTED;
	if (typeof value === "string") return redactSensitiveText(value);
	if (value == null || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, "", seen));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.map(([childKey, child]) => [childKey, redactValue(child, childKey, seen)]));
}

/** Retain structured input when it fits; otherwise retain a visibly truncated JSON rendering. */
export function retainToolValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	const redacted = redactValue(value);
	let serialized: string;
	try { serialized = JSON.stringify(redacted, null, 2) ?? String(redacted); } catch { serialized = String(redacted); }
	return serialized.length <= TOOL_FIELD_MAX_CHARS
		? redacted
		: truncateVisible(serialized, TOOL_FIELD_MAX_CHARS);
}
