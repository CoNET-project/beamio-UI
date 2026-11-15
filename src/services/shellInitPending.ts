/**
 * / reviewer  (666dfed1): the App's init in a shell may skip for want of an account, and wait for the entry gate. The gate asks
 * the init to run again (dispatchBeamioWalletReady) only while such a skip is pending. A normal cold start, where the account is in memory
 * before the storage read ends, never sets it, so the init runs once.
 */
let pending = false

/** App's init: true when it skipped with no account and waits for the entry gate; false when it goes on with an account. */
export function setShellInitPending(value: boolean): void {
	pending = value
}

/** The entry gate: whether an init is waiting for the account to be entered. */
export function isShellInitPending(): boolean {
	return pending
}
