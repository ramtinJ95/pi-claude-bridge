/**
 * Process-wide single-writer lease for Claude delegations that can mutate the
 * current checkout. A global symbol keeps the lease intact across Pi extension
 * reloads in the same process, so an unsettled background worker cannot be
 * forgotten and followed by a second writer from the replacement runtime.
 */

export interface CheckoutWriter {
	id: string;
	label: string;
}

export interface CheckoutWriteLeaseHandle {
	readonly owner: CheckoutWriter;
	release(): void;
}

interface CheckoutWriteLeaseState {
	held?: { owner: CheckoutWriter; token: symbol };
}

export class CheckoutWriteLease {
	constructor(private readonly state: CheckoutWriteLeaseState = {}) {}

	current(): CheckoutWriter | undefined {
		return this.state.held?.owner;
	}

	tryAcquire(owner: CheckoutWriter): CheckoutWriteLeaseHandle | undefined {
		if (this.state.held) return undefined;
		const token = Symbol(owner.id);
		this.state.held = { owner: { ...owner }, token };
		let released = false;
		return {
			owner: { ...owner },
			release: () => {
				if (released) return;
				released = true;
				if (this.state.held?.token === token) this.state.held = undefined;
			},
		};
	}
}

// Keep the original global key across the package/runtime rename. An unsettled
// worker launched by pi-claude-bridge must still block this package after a
// migration reload; changing this internal coordination key would silently
// create two independent writers in the same checkout.
const CHECKOUT_WRITE_LEASE_STATE_KEY = Symbol.for("pi-claude-bridge.checkout-write-lease-state");

export function globalCheckoutWriteLease(): CheckoutWriteLease {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[CHECKOUT_WRITE_LEASE_STATE_KEY];
	const state = existing && typeof existing === "object"
		? existing as CheckoutWriteLeaseState
		: {};
	globals[CHECKOUT_WRITE_LEASE_STATE_KEY] = state;
	return new CheckoutWriteLease(state);
}

export function checkoutWriteConflictText(lease: CheckoutWriteLease): string {
	const owner = lease.current();
	return owner
		? `Checkout write access is already held by ${owner.label} (${owner.id}). Wait for it to settle before starting another full-capability Claude writer.`
		: "Checkout write access is already held by another Claude delegation. Wait for it to settle before starting another full-capability Claude writer.";
}
