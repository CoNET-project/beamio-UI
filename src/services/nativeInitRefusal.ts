/**
 * (interface ): in G2 the native layer answers `init`with `address_mismatch`when the account is not the one
 * the device holds the key for. The page does not show the import or lock page for it (that is `no_key`), and it does not
 * send `init` again and again for that account.
 *
 * The latch remembers the refused account for this session. It is cleared when the account is initialised, or by a wallet event
 * (a wallet became ready, so the account may now have its key). Another account is never blocked by it. A refusal for any other
 * reason is not latched. Kept apart from chatWorkerBridge so it can be tested without the bridge module.
 */
export const ADDRESS_MISMATCH = 'address_mismatch'

/**
 * the native layer closed the identity module. `clear_failed`(the module waits for a clearIdentity) and
 * `unregister_refused` (an account switch refused its recovery check). These are not latched for `init`: the page does not send `init`
 * again on its own. The start reports the closed reason once, and the closed notice takes over.
 */
export const IDENTITY_CLOSED_REASONS = ['clear_failed', 'unregister_refused'] as const
export type IdentityClosedInitReason = (typeof IDENTITY_CLOSED_REASONS)[number]

export interface InitRefusalLatch {
	/** True when `init` for this account must not be sent now: it was refused with address_mismatch and nothing has cleared it. */
	skipInit(eoa: string): boolean
	/** Records an init failure. Only address_mismatch is latched. Returns true when it was latched. */
	noteRefusal(eoa: string, reason: string): boolean
	/** Records an init failure that closed the identity module. Returns true for a closed reason. Not latched. */
	noteIdentityClosed(reason: string): boolean
	/** An init succeeded: nothing is latched any more, and no closed reason is pending. */
	noteReady(): void
	/** A wallet event: forget the latched account, so the next start may send init. */
	clear(): void
	/** The reason of the last refused start, returned once. Null when the last start was not refused. */
	takeRefusal(): string | null
	/** The closed reason of the last start, returned once. Null when the module was not closed by the last start. */
	takeIdentityClosed(): IdentityClosedInitReason | null
}

export function createInitRefusalLatch(): InitRefusalLatch {
	let latchedEoa: string | null = null
	let lastRefusal: string | null = null
	let closedReason: IdentityClosedInitReason | null = null
	return {
		skipInit(eoa: string): boolean {
			if (latchedEoa === null || latchedEoa !== eoa) return false
			lastRefusal = ADDRESS_MISMATCH
			return true
		},
		noteRefusal(eoa: string, reason: string): boolean {
			if (reason !== ADDRESS_MISMATCH) return false
			latchedEoa = eoa
			lastRefusal = ADDRESS_MISMATCH
			return true
		},
		noteIdentityClosed(reason: string): boolean {
			const known = (IDENTITY_CLOSED_REASONS as readonly string[]).includes(reason)
			closedReason = known ? (reason as IdentityClosedInitReason) : null
			return known
		},
		noteReady(): void {
			latchedEoa = null
			closedReason = null
		},
		clear(): void {
			latchedEoa = null
		},
		takeRefusal(): string | null {
			const reason = lastRefusal
			lastRefusal = null
			return reason
		},
		takeIdentityClosed(): IdentityClosedInitReason | null {
			const reason = closedReason
			closedReason = null
			return reason
		},
	}
}
