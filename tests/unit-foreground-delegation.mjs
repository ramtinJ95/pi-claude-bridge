import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";
import { clearLiveAskClaudeCall, getLiveAskClaudeCall } from "../src/claude-sessions-overlay.js";

const { executeForegroundDelegation } = __test;

// The shared foreground execution implementation: blocking AskClaude calls and
// foreground SpawnClaudeAgent calls both run through it, so these tests cover
// success, failure, cancellation, live updates, the live overlay slot, and the
// wrapper-parity guarantee (label extras are the only difference between the
// two callers).

function fakeQuery(messages, hooks = {}) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (hooks.closed) return;
				yield message;
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		async interrupt() { hooks.interrupts = (hooks.interrupts ?? 0) + 1; },
		close() { hooks.closes = (hooks.closes ?? 0) + 1; hooks.closed = true; },
	};
}

const init = {
	type: "system",
	subtype: "init",
	session_id: "session-fg",
	cwd: "/tmp/project",
	model: "claude-test",
	permissionMode: "auto",
};

const success = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "ANSWER",
	stop_reason: "end_turn",
	duration_ms: 20,
	duration_api_ms: 10,
	num_turns: 1,
	total_cost_usd: 0.01,
	usage: { input_tokens: 2, output_tokens: 3 },
	modelUsage: {},
	permission_denials: [],
};

function run(overrides = {}) {
	return executeForegroundDelegation({
		toolCallId: "fg-call-1",
		displayPrompt: "the visible task",
		delegationPrompt: "role prompt\n\nTask:\nthe visible task",
		mode: "read",
		isolated: true,
		requestedModel: "opus",
		appendSkills: false,
		queryFactory: () => fakeQuery([init, success]),
		...overrides,
	});
}

describe("shared foreground delegation execution", () => {
	beforeEach(() => clearLiveAskClaudeCall());

	it("returns the bounded answer with the retained snapshot and publishes live updates", async () => {
		const updates = [];
		let received;
		const result = await run({
			queryFactory: (params) => { received = params; return fakeQuery([init, success]); },
			onUpdate: (update) => updates.push(update),
		});

		// The delegation prompt goes to Claude; the display prompt is what the
		// details and overlay retain.
		assert.equal(received.prompt, "role prompt\n\nTask:\nthe visible task");
		assert.equal(result.content[0].text, "ANSWER");
		assert.equal(result.details.prompt, "the visible task");
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.capabilityMode, "read");
		assert.equal(result.details.isolated, true);
		assert.equal(result.details.snapshot.status, "succeeded");
		assert.equal(result.details.snapshot.sessionId, "session-fg");
		assert.ok(updates.length >= 1, "live updates must reach the tool row");
		assert.ok(updates.every((update) => update.details.prompt === "the visible task"));
	});

	it("keeps the final details in the live overlay slot after completion", async () => {
		await run();
		const live = getLiveAskClaudeCall();
		assert.equal(live.toolCallId, "fg-call-1");
		assert.equal(live.prompt, "the visible task");
		assert.equal(live.details.snapshot.status, "succeeded");
	});

	it("promotes a delegation failure to an error result with the retained partial snapshot", async () => {
		const failure = { ...success, is_error: true, result: "capacity exhausted" };
		const result = await run({ queryFactory: () => fakeQuery([init, failure]) });

		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.startsWith("Error: capacity exhausted"));
		// The failure path persists the same bounded record as success.
		assert.equal(result.details.snapshot.status, "failed");
		assert.equal(getLiveAskClaudeCall().details.error, true);
	});

	it("resolves cancellation with the partial answer and cancelled+error details", async () => {
		const controller = new AbortController();
		// The abort lands mid-stream, deterministically between messages.
		const result = await run({
			signal: controller.signal,
			queryFactory: () => ({
				async *[Symbol.asyncIterator]() {
					yield init;
					yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial narration" } } };
					controller.abort();
					yield success; // never reaches the runner: the abort breaks the loop first
				},
				async interrupt() {},
				close() {},
			}),
		});

		assert.equal(result.details.cancelled, true);
		assert.equal(result.details.error, true);
		assert.ok(result.content[0].text.includes("Cancelled by user"));
		assert.ok(result.content[0].text.includes("partial narration"));
	});

	it("differs between AskClaude and SpawnClaudeAgent callers only by the persisted label extras", async () => {
		const askClaude = await run();
		clearLiveAskClaudeCall();
		const spawn = await run({
			mode: "full",
			detailExtras: { origin: "spawn-foreground", profile: "worker" },
		});

		assert.equal(askClaude.details.origin, undefined);
		assert.equal(spawn.details.origin, "spawn-foreground");
		assert.equal(spawn.details.profile, "worker");
		assert.equal(spawn.details.capabilityMode, "full");
		assert.equal(getLiveAskClaudeCall().details.origin, "spawn-foreground");
		// Same result/telemetry shape from the one implementation.
		assert.deepEqual(Object.keys(askClaude.details).sort(),
			Object.keys(spawn.details).sort().filter((key) => key !== "origin" && key !== "profile"));
		assert.equal(askClaude.content[0].text, spawn.content[0].text);
	});
});
