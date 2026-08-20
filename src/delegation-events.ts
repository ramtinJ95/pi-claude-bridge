import type {
	ModelUsage,
	PermissionMode,
	SDKMessage,
	SDKRateLimitInfo,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type DelegationStatus = "running" | "succeeded" | "failed" | "cancelled";
export type DelegationToolStatus = "running" | "succeeded" | "failed" | "denied";

export interface DelegationUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	turns: number;
	durationMs: number;
	durationApiMs: number;
	modelUsage: Record<string, ModelUsage>;
}

export interface DelegationToolCall {
	id: string;
	name: string;
	status: DelegationToolStatus;
	input?: unknown;
	output?: string;
	error?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	durationMs?: number;
	elapsedSeconds?: number;
}

export interface DelegationPermissionDenial {
	toolName: string;
	toolUseId: string;
	reasonType?: string;
	reason?: string;
	message: string;
}

export interface DelegationDiagnostic {
	kind: "unknown_sdk_message" | "unknown_stream_event";
	label: string;
	at: number;
}

export interface DelegationSnapshot {
	status: DelegationStatus;
	startedAt: number;
	updatedAt: number;
	responseText: string;
	thinkingText: string;
	tools: DelegationToolCall[];
	permissionDenials: DelegationPermissionDenial[];
	diagnostics: DelegationDiagnostic[];
	sessionId?: string;
	cwd?: string;
	model?: string;
	runtimePermissionMode?: PermissionMode;
	resultSubtype?: string;
	stopReason?: string | null;
	error?: string;
	usage?: DelegationUsage;
	rateLimit?: SDKRateLimitInfo;
	retry?: {
		attempt: number;
		maxRetries: number;
		delayMs: number;
		status: number | null;
		error: string;
	};
}

export type DelegationEvent =
	| { type: "session"; at: number; sessionId: string; cwd: string; model: string; permissionMode: PermissionMode }
	| { type: "text_delta"; at: number; text: string }
	| { type: "thinking_delta"; at: number; text: string }
	| { type: "tool_start"; at: number; id: string; name: string; input?: unknown }
	| { type: "tool_input"; at: number; id: string; name: string; input: unknown }
	| { type: "tool_progress"; at: number; id: string; name: string; elapsedSeconds: number }
	| { type: "tool_result"; at: number; id: string; output: string; isError: boolean }
	| { type: "permission_denial"; at: number; denial: DelegationPermissionDenial }
	| { type: "usage"; at: number; usage: DelegationUsage }
	| { type: "result"; at: number; subtype: string; stopReason: string | null; fallbackText?: string }
	| { type: "retry"; at: number; attempt: number; maxRetries: number; delayMs: number; status: number | null; error: string }
	| { type: "rate_limit"; at: number; info: SDKRateLimitInfo }
	| { type: "diagnostic"; at: number; kind: DelegationDiagnostic["kind"]; label: string };

export function createDelegationSnapshot(startedAt = Date.now()): DelegationSnapshot {
	return {
		status: "running",
		startedAt,
		updatedAt: startedAt,
		responseText: "",
		thinkingText: "",
		tools: [],
		permissionDenials: [],
		diagnostics: [],
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content.map((block) => {
		if (!block || typeof block !== "object") return String(block);
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") return item.text;
		if (item.type === "image") return "[image]";
		return JSON.stringify(item);
	}).join("\n");
}

function usageFromResult(message: Record<string, any>): DelegationUsage | undefined {
	if (!message.usage) return undefined;
	return {
		inputTokens: message.usage.input_tokens ?? 0,
		outputTokens: message.usage.output_tokens ?? 0,
		cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
		cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
		totalCostUsd: message.total_cost_usd ?? 0,
		turns: message.num_turns ?? 0,
		durationMs: message.duration_ms ?? 0,
		durationApiMs: message.duration_api_ms ?? 0,
		modelUsage: message.modelUsage ?? {},
	};
}

/** Convert one raw Agent SDK message into stable delegation events. */
export function normalizeDelegationMessage(message: SDKMessage, at = Date.now()): DelegationEvent[] {
	if (message.type === "stream_event") {
		const event = message.event as any;
		if (event?.type === "content_block_start") {
			if (event.content_block?.type === "tool_use") {
				return [{
					type: "tool_start",
					at,
					id: event.content_block.id,
					name: event.content_block.name,
					input: event.content_block.input,
				}];
			}
			return [];
		}
		if (event?.type === "content_block_delta") {
			if (event.delta?.type === "text_delta") {
				return [{ type: "text_delta", at, text: event.delta.text ?? "" }];
			}
			if (event.delta?.type === "thinking_delta") {
				return [{ type: "thinking_delta", at, text: event.delta.thinking ?? "" }];
			}
			if (event.delta?.type === "input_json_delta" || event.delta?.type === "signature_delta") return [];
			return [{ type: "diagnostic", at, kind: "unknown_stream_event", label: `content_block_delta:${event.delta?.type ?? "unknown"}` }];
		}
		if (["message_start", "message_delta", "message_stop", "content_block_stop"].includes(event?.type)) return [];
		return [{ type: "diagnostic", at, kind: "unknown_stream_event", label: event?.type ?? "unknown" }];
	}

	if (message.type === "assistant") {
		const events: DelegationEvent[] = [];
		for (const block of message.message?.content ?? []) {
			if (block.type === "tool_use") {
				events.push({ type: "tool_input", at, id: block.id, name: block.name, input: block.input });
			}
		}
		return events;
	}

	if (message.type === "user") {
		if ((message as { isReplay?: boolean }).isReplay) return [];
		const events: DelegationEvent[] = [];
		const content = Array.isArray(message.message?.content) ? message.message.content : [];
		for (const block of content) {
			if (block.type !== "tool_result") continue;
			events.push({
				type: "tool_result",
				at,
				id: block.tool_use_id,
				output: contentText(block.content),
				isError: block.is_error === true,
			});
		}
		return events;
	}

	if (message.type === "tool_progress") {
		return [{
			type: "tool_progress",
			at,
			id: message.tool_use_id,
			name: message.tool_name,
			elapsedSeconds: message.elapsed_time_seconds,
		}];
	}

	if (message.type === "result") {
		const raw = message as Record<string, any>;
		const events: DelegationEvent[] = [];
		for (const denial of message.permission_denials ?? []) {
			events.push({
				type: "permission_denial",
				at,
				denial: {
					toolName: denial.tool_name,
					toolUseId: denial.tool_use_id,
					message: "Denied by Claude Code permission policy",
				},
			});
		}
		const usage = usageFromResult(raw);
		if (usage) events.push({ type: "usage", at, usage });
		events.push({
			type: "result",
			at,
			subtype: message.subtype,
			stopReason: message.stop_reason,
			fallbackText: message.subtype === "success" && !message.is_error ? message.result : undefined,
		});
		return events;
	}

	if (message.type === "system") {
		if (message.subtype === "init") {
			return [{
				type: "session",
				at,
				sessionId: message.session_id,
				cwd: message.cwd,
				model: message.model,
				permissionMode: message.permissionMode,
			}];
		}
		if (message.subtype === "permission_denied") {
			return [{
				type: "permission_denial",
				at,
				denial: {
					toolName: message.tool_name,
					toolUseId: message.tool_use_id,
					reasonType: message.decision_reason_type,
					reason: message.decision_reason,
					message: message.message,
				},
			}];
		}
		if (message.subtype === "api_retry") {
			return [{
				type: "retry",
				at,
				attempt: message.attempt,
				maxRetries: message.max_retries,
				delayMs: message.retry_delay_ms,
				status: message.error_status,
				error: message.error,
			}];
		}
		if (["status", "compact_boundary"].includes(message.subtype)) return [];
		return [{ type: "diagnostic", at, kind: "unknown_sdk_message", label: `system:${message.subtype}` }];
	}

	if (message.type === "rate_limit_event") {
		return [{ type: "rate_limit", at, info: message.rate_limit_info }];
	}

	return [{ type: "diagnostic", at, kind: "unknown_sdk_message", label: message.type }];
}

function upsertTool(
	tools: DelegationToolCall[],
	id: string,
	create: () => DelegationToolCall,
	update: (tool: DelegationToolCall) => DelegationToolCall,
): DelegationToolCall[] {
	const index = tools.findIndex((tool) => tool.id === id);
	if (index < 0) return [...tools, create()];
	const next = [...tools];
	next[index] = update(next[index]);
	return next;
}

/** Apply one normalized event without mutating the prior snapshot. */
export function reduceDelegationEvent(
	snapshot: DelegationSnapshot,
	event: DelegationEvent,
): DelegationSnapshot {
	const base = { ...snapshot, updatedAt: event.at };
	switch (event.type) {
		case "session":
			return {
				...base,
				sessionId: event.sessionId,
				cwd: event.cwd,
				model: event.model,
				runtimePermissionMode: event.permissionMode,
			};
		case "text_delta":
			return { ...base, responseText: snapshot.responseText + event.text };
		case "thinking_delta":
			return { ...base, thinkingText: snapshot.thinkingText + event.text };
		case "tool_start":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", input: event.input, startedAt: event.at, updatedAt: event.at }),
					(tool) => ({ ...tool, name: event.name, input: event.input ?? tool.input, updatedAt: event.at })),
			};
		case "tool_input":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", input: event.input, startedAt: event.at, updatedAt: event.at }),
					(tool) => ({ ...tool, name: event.name, input: event.input, updatedAt: event.at })),
			};
		case "tool_progress":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({ id: event.id, name: event.name, status: "running", startedAt: event.at, updatedAt: event.at, elapsedSeconds: event.elapsedSeconds }),
					(tool) => ({ ...tool, updatedAt: event.at, elapsedSeconds: event.elapsedSeconds })),
			};
		case "tool_result":
			return {
				...base,
				tools: upsertTool(snapshot.tools, event.id,
					() => ({
						id: event.id,
						name: "unknown",
						status: event.isError ? "failed" : "succeeded",
						output: event.output,
						error: event.isError ? event.output : undefined,
						startedAt: event.at,
						updatedAt: event.at,
						completedAt: event.at,
						durationMs: 0,
					}),
					(tool) => ({
						...tool,
						status: event.isError ? "failed" : "succeeded",
						output: event.output,
						error: event.isError ? event.output : undefined,
						updatedAt: event.at,
						completedAt: event.at,
						durationMs: Math.max(0, event.at - tool.startedAt),
					})),
			};
		case "permission_denial": {
			const duplicate = snapshot.permissionDenials.some((item) => item.toolUseId === event.denial.toolUseId);
			return {
				...base,
				permissionDenials: duplicate ? snapshot.permissionDenials : [...snapshot.permissionDenials, event.denial],
				tools: upsertTool(snapshot.tools, event.denial.toolUseId,
					() => ({ id: event.denial.toolUseId, name: event.denial.toolName, status: "denied", error: event.denial.message, startedAt: event.at, updatedAt: event.at, completedAt: event.at, durationMs: 0 }),
					(tool) => ({ ...tool, status: "denied", error: event.denial.message, updatedAt: event.at, completedAt: event.at, durationMs: Math.max(0, event.at - tool.startedAt) })),
			};
		}
		case "usage":
			return { ...base, usage: event.usage };
		case "result":
			return {
				...base,
				resultSubtype: event.subtype,
				stopReason: event.stopReason,
				responseText: snapshot.responseText || event.fallbackText || "",
			};
		case "retry":
			return { ...base, retry: { attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs, status: event.status, error: event.error } };
		case "rate_limit":
			return { ...base, rateLimit: event.info };
		case "diagnostic":
			return { ...base, diagnostics: [...snapshot.diagnostics, { kind: event.kind, label: event.label, at: event.at }] };
	}
}

export function reduceDelegationMessage(
	snapshot: DelegationSnapshot,
	message: SDKMessage,
	at = Date.now(),
): DelegationSnapshot {
	return normalizeDelegationMessage(message, at)
		.reduce((current, event) => reduceDelegationEvent(current, event), snapshot);
}

/** Failure text for an SDK result, or undefined when it succeeded. */
export function sdkResultErrorText(message: SDKResultMessage): string | undefined {
	const result = message as SDKResultMessage & { error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}
