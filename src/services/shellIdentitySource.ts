/**
 * The shell's identity source after a restart (of the interface).
 *
 * - After a restore or a create answers `ok`, the public EOA is kept in non-secret storage: the address only, never a key,
 *   passphrase or backup. After a restart it is the EOA input of `init`; the native layer checks it against its record.
 * - It is an input for that check, not an identity basis and not an entry basis. The app entry reads `walletStatus` (G2).
 * - When it is gone, nothing is guessed: the chat shows a retry state (`pending`) until the next start finds the identity.
 */
const STORAGE_KEY = 'beamio.shellPublicEoa.v1'
const EOA_RE = /^0x[0-9a-f]{40}$/

/** Keeps the public address of an `ok` restore or create. False when the value is not a canonical address (nothing is kept). */
export function persistShellEoa(eoa: string): boolean {
	const value = String(eoa || '').toLowerCase()
	if (!EOA_RE.test(value) || typeof window === 'undefined') return false
	try {
		window.localStorage.setItem(STORAGE_KEY, value)
		return true
	} catch {
		return false
	}
}

/** The kept public address, or '' when there is none or the stored value is not a canonical address. */
export function readPersistedShellEoa(): string {
	if (typeof window === 'undefined') return ''
	try {
		const value = window.localStorage.getItem(STORAGE_KEY) || ''
		return EOA_RE.test(value) ? value : ''
	} catch {
		return ''
	}
}

// "Retry later" state: the key is present but no identity source is known.
let pending = false
const listeners = new Set<(value: boolean) => void>()

export function getShellIdentityPending(): boolean {
	return pending
}

export function setShellIdentityPending(next: boolean): void {
	if (next === pending) return
	pending = next
	for (const listener of [...listeners]) listener(next)
}

export function subscribeShellIdentityPending(listener: (value: boolean) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

// "First identity" state: no chain record and no backup. The page shows the entry; nothing is generated
// without the user's click and the native confirmation.
let firstIdentity = false
const firstIdentityListeners = new Set<(value: boolean) => void>()

export function getShellFirstIdentity(): boolean {
	return firstIdentity
}

export function setShellFirstIdentity(next: boolean): void {
	if (next === firstIdentity) return
	firstIdentity = next
	for (const listener of [...firstIdentityListeners]) listener(next)
}

export function subscribeShellFirstIdentity(listener: (value: boolean) => void): () => void {
	firstIdentityListeners.add(listener)
	return () => {
		firstIdentityListeners.delete(listener)
	}
}
