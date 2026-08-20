import {
	query,
	type Options,
	type PermissionMode,
	type Query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createDelegationSnapshot,
	reduceDelegationMessage,
	sdkResultErrorText,
	type DelegationPermissionDenial,
	type DelegationSnapshot,
} from "./delegation-events.js";
import {
	observePermissionMode,
	type ManagedPolicySummary,
	type PermissionObservation,
} from "./query-policy.js";

export interface DelegationQuery extends AsyncIterable<SDKMessage> {
	interrupt(): Promise<void>;
	close(): void;
}

export type DelegationQueryFactory = (params: { prompt: string; options: Options }) => DelegationQuery;

export interface DelegationRunnerInput {
	prompt: string;
	options: Options;
	requestedPermissionMode: PermissionMode;
	signal?: AbortSignal;
	managedPolicy?: Promise<ManagedPolicySummary | undefined>;
	onSnapshot?: (snapshot: DelegationSnapshot) => void;
	queryFactory?: DelegationQueryFactory;
	now?: () => number;
}

export interface DelegationRunResult {
	responseText: string;
	stopReason: "stop" | "cancelled";
	permission?: PermissionObservation;
	permissionDenials: DelegationPermissionDenial[];
	managedPolicy?: ManagedPolicySummary;
	snapshot: DelegationSnapshot;
	messageCount: number;
}

const defaultQueryFactory: DelegationQueryFactory = (params) => query(params) as Query;

/**
 * Own one Claude-native Agent SDK query lifecycle.
 *
 * Provider QueryContext, MCP result routing, and Pi session synchronization do
 * not belong here. Blocking AskClaude uses this now; background jobs can reuse
 * the same lifecycle later.
 */
export async function runDelegation(input: DelegationRunnerInput): Promise<DelegationRunResult> {
	const now = input.now ?? Date.now;
	let snapshot = createDelegationSnapshot(now());
	let permission: PermissionObservation | undefined;
	let managedPolicy: ManagedPolicySummary | undefined;
	let messageCount = 0;
	let wasAborted = false;
	let sdkQuery: DelegationQuery | undefined;

	const publish = () => input.onSnapshot?.(snapshot);
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	if (input.signal?.aborted) throw new Error("Aborted");

	try {
		sdkQuery = (input.queryFactory ?? defaultQueryFactory)({
			prompt: input.prompt,
			options: input.options,
		});
		input.signal?.addEventListener("abort", onAbort, { once: true });
		publish();

		for await (const message of sdkQuery) {
			if (wasAborted) break;
			messageCount++;
			snapshot = reduceDelegationMessage(snapshot, message, now());

			if (message.type === "system" && message.subtype === "init") {
				managedPolicy ??= await input.managedPolicy;
				permission = observePermissionMode(
					input.requestedPermissionMode,
					message.permissionMode,
				);
			}

			const failure = message.type === "result" ? sdkResultErrorText(message) : undefined;
			if (failure) {
				snapshot = { ...snapshot, status: "failed", error: failure, updatedAt: now() };
				publish();
				throw new Error(failure);
			}
			publish();
		}

		if (wasAborted) {
			snapshot = { ...snapshot, status: "cancelled", updatedAt: now() };
		} else {
			snapshot = { ...snapshot, status: "succeeded", updatedAt: now() };
		}
		publish();

		return {
			responseText: snapshot.responseText,
			stopReason: wasAborted ? "cancelled" : "stop",
			permission,
			permissionDenials: snapshot.permissionDenials,
			managedPolicy,
			snapshot,
			messageCount,
		};
	} catch (error) {
		if (snapshot.status === "running") {
			snapshot = {
				...snapshot,
				status: wasAborted ? "cancelled" : "failed",
				error: error instanceof Error ? error.message : String(error),
				updatedAt: now(),
			};
			publish();
		}
		throw error;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}
