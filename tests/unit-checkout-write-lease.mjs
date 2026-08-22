import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CheckoutWriteLease, checkoutWriteConflictText, globalCheckoutWriteLease } from "../src/checkout-write-lease.js";

describe("checkout write lease", () => {
	it("grants exactly one writer atomically and reports the owner", () => {
		const lease = new CheckoutWriteLease();
		const first = lease.tryAcquire({ id: "worker-1", label: "background worker" });
		assert.ok(first);
		assert.deepEqual(lease.current(), { id: "worker-1", label: "background worker" });
		assert.equal(lease.tryAcquire({ id: "worker-2", label: "foreground worker" }), undefined);
		assert.match(checkoutWriteConflictText(lease), /background worker \(worker-1\)/);
	});

	it("releases only through the owning idempotent handle", () => {
		const lease = new CheckoutWriteLease();
		const first = lease.tryAcquire({ id: "worker-1", label: "first" });
		first.release();
		first.release();
		assert.equal(lease.current(), undefined);

		const second = lease.tryAcquire({ id: "worker-2", label: "second" });
		assert.ok(second);
		assert.deepEqual(lease.current(), { id: "worker-2", label: "second" });
		second.release();
	});

	it("shares state across global wrappers used by replacement extension runtimes", () => {
		const firstRuntime = globalCheckoutWriteLease();
		const handle = firstRuntime.tryAcquire({ id: "reload-worker", label: "old runtime worker" });
		assert.ok(handle);
		try {
			const replacementRuntime = globalCheckoutWriteLease();
			assert.deepEqual(replacementRuntime.current(), { id: "reload-worker", label: "old runtime worker" });
			assert.equal(replacementRuntime.tryAcquire({ id: "new-worker", label: "new runtime worker" }), undefined);
		} finally {
			handle.release();
		}
	});
});
