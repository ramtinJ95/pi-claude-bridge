import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDelegation } from "../src/delegation-runner.js";

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
	session_id: "session-1",
	cwd: "/tmp/project",
	model: "claude-test",
	permissionMode: "default",
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

describe("delegation runner", () => {
	it("owns the query lifecycle and returns the normalized result", async () => {
		const hooks = {};
		const snapshots = [];
		let received;
		const result = await runDelegation({
			prompt: "question",
			options: { cwd: "/tmp/project" },
			requestedPermissionMode: "auto",
			managedPolicy: Promise.resolve({ sandboxRequired: true }),
			queryFactory: (params) => { received = params; return fakeQuery([init, success], hooks); },
			onSnapshot: (snapshot) => snapshots.push(snapshot),
			now: (() => { let n = 0; return () => ++n; })(),
		});

		assert.equal(received.prompt, "question");
		assert.deepEqual(received.options, { cwd: "/tmp/project" });
		assert.equal(result.responseText, "ANSWER");
		assert.equal(result.snapshot.status, "succeeded");
		assert.deepEqual(result.permission, { requested: "auto", effective: "default", overridden: true });
		assert.equal(result.managedPolicy.sandboxRequired, true);
		assert.ok(hooks.closes >= 1);
		assert.ok(snapshots.some((snapshot) => snapshot.status === "succeeded"));
	});

	it("publishes a failed terminal snapshot before propagating an SDK result error", async () => {
		const snapshots = [];
		const failure = { ...success, is_error: true, result: "capacity exhausted" };

		await assert.rejects(
			runDelegation({
				prompt: "question",
				options: {},
				requestedPermissionMode: "auto",
				queryFactory: () => fakeQuery([failure]),
				onSnapshot: (snapshot) => snapshots.push(snapshot),
			}),
			/capacity exhausted/,
		);
		assert.equal(snapshots.at(-1).status, "failed");
		assert.equal(snapshots.at(-1).error, "capacity exhausted");
	});

	it("interrupts, closes, and reports cancellation through the same lifecycle", async () => {
		const controller = new AbortController();
		const hooks = {};
		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => fakeQuery([init, success], hooks),
			onSnapshot: (snapshot) => {
				if (snapshot.sessionId) controller.abort();
			},
		});

		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
		assert.equal(hooks.interrupts, 1);
		assert.ok(hooks.closes >= 1);
	});

	it("reports a pre-aborted signal as cancelled without starting an SDK query", async () => {
		const controller = new AbortController();
		controller.abort();
		const snapshots = [];
		let queryStarted = false;

		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => {
				queryStarted = true;
				return fakeQuery([]);
			},
			onSnapshot: (snapshot) => snapshots.push(snapshot),
		});

		assert.equal(queryStarted, false);
		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
		assert.equal(result.messageCount, 0);
		assert.equal(snapshots.at(-1).status, "cancelled");
	});

	it("closes the query when interrupt rejects and still reports cancellation", async () => {
		const controller = new AbortController();
		const hooks = { interrupts: 0, closes: 0 };
		const query = {
			async *[Symbol.asyncIterator]() {
				yield init;
				// Give the rejected interrupt's handler its turns on the microtask queue.
				for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
				yield success;
			},
			async interrupt() { hooks.interrupts++; throw new Error("interrupt failed"); },
			close() { hooks.closes++; },
		};

		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => query,
			onSnapshot: (snapshot) => { if (snapshot.sessionId) controller.abort(); },
		});

		assert.equal(hooks.interrupts, 1);
		// One immediate hard close on abort, one from the runner's finally.
		assert.equal(hooks.closes, 2);
		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
	});

	it("hard-closes immediately when the cooperative interrupt never settles", async () => {
		const controller = new AbortController();
		const hooks = { interrupts: 0, closes: 0, closed: false };
		const query = {
			async *[Symbol.asyncIterator]() {
				yield init;
				while (!hooks.closed) await new Promise((resolve) => setImmediate(resolve));
			},
			interrupt() { hooks.interrupts++; return new Promise(() => {}); },
			close() { hooks.closes++; hooks.closed = true; },
		};

		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => query,
			onSnapshot: (snapshot) => { if (snapshot.sessionId) controller.abort(); },
		});

		assert.equal(hooks.interrupts, 1);
		assert.ok(hooks.closes >= 1, "abort must not wait for interrupt before closing");
		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
	});

	it("fails when the iterator ends without an authoritative result", async () => {
		const snapshots = [];

		await assert.rejects(
			runDelegation({
				prompt: "question",
				options: {},
				requestedPermissionMode: "auto",
				queryFactory: () => fakeQuery([init]),
				onSnapshot: (snapshot) => snapshots.push(snapshot),
			}),
			/ended without a result$/,
		);
		assert.equal(snapshots.at(-1).status, "failed");
		assert.equal(snapshots.at(-1).error, "Claude Code ended without a result");
	});

	it("fails on an empty stream instead of reporting an empty success", async () => {
		await assert.rejects(
			runDelegation({
				prompt: "question",
				options: {},
				requestedPermissionMode: "auto",
				queryFactory: () => fakeQuery([]),
			}),
			/ended without a result$/,
		);
	});

	it("explains a premature end with the assistant error it already saw", async () => {
		const assistantError = {
			type: "assistant",
			parent_tool_use_id: null,
			error: "rate_limit",
			message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
		};
		const snapshots = [];

		await assert.rejects(
			runDelegation({
				prompt: "question",
				options: {},
				requestedPermissionMode: "auto",
				queryFactory: () => fakeQuery([init, assistantError]),
				onSnapshot: (snapshot) => snapshots.push(snapshot),
			}),
			/assistant error: rate_limit/,
		);
		assert.equal(snapshots.at(-1).status, "failed");
		assert.equal(snapshots.at(-1).assistantError, "rate_limit");
	});

	it("keeps an assistant error out of the way when an authoritative result follows", async () => {
		const assistantError = {
			type: "assistant",
			parent_tool_use_id: null,
			error: "server_error",
			message: { role: "assistant", content: [] },
		};

		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			queryFactory: () => fakeQuery([init, assistantError, success]),
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(result.snapshot.status, "succeeded");
		assert.equal(result.snapshot.assistantError, "server_error");
		assert.equal(result.responseText, "ANSWER");
	});

	it("resolves as cancelled when the SDK iterator throws after interrupt", async () => {
		const controller = new AbortController();
		const hooks = {};
		const query = {
			async *[Symbol.asyncIterator]() {
				yield init;
				await new Promise((resolve) => setImmediate(resolve));
				if (hooks.interrupts) throw new Error("Claude Code process aborted by user");
				yield success;
			},
			async interrupt() { hooks.interrupts = (hooks.interrupts ?? 0) + 1; },
			close() { hooks.closes = (hooks.closes ?? 0) + 1; },
		};

		const result = await runDelegation({
			prompt: "question",
			options: {},
			requestedPermissionMode: "auto",
			signal: controller.signal,
			queryFactory: () => query,
			onSnapshot: (snapshot) => {
				if (snapshot.sessionId) controller.abort();
			},
		});

		assert.equal(result.stopReason, "cancelled");
		assert.equal(result.snapshot.status, "cancelled");
		assert.equal(result.snapshot.error, undefined);
		assert.equal(hooks.interrupts, 1);
		assert.ok(hooks.closes >= 1);
	});
});
