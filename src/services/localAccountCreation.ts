/**
 * The local creation record: an account this device created through the create-account flow (createRecover). It is a record on this
 * device only: it is never sent, never a chain value, and keyed by the EOA. Only the create flow writes it; a restored account never
 * gets one. It is one of the two conditions of the first PGP registration (the other is the user's own save): a chain with no PGP
 * identity is registered from the browser record only for an account this device created (R78 2.1 (b)).
 */

const KEY_PREFIX = 'beamio.localCreatedAccount.v1:'
const MARK = 'create'

export type LocalCreationStore = Pick<Storage, 'getItem' | 'setItem'>

function defaultStore(): LocalCreationStore | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

function keyOf(eoa: string): string | null {
	const a = String(eoa || '').trim().toLowerCase()
	return /^0x[0-9a-f]{40}$/.test(a) ? KEY_PREFIX + a : null
}

/** Writes the record after the create flow has succeeded. False when it cannot be written (the account is then not local-created). */
export function markLocallyCreatedAccount(eoa: string, store: LocalCreationStore | null = defaultStore()): boolean {
	const key = keyOf(eoa)
	if (!key || !store) return false
	try {
		store.setItem(key, MARK)
		return true
	} catch {
		return false
	}
}

/** True only when this device's create flow recorded the account. A read failure is false (the first registration is refused). */
export function isLocallyCreatedAccount(eoa: string, store: LocalCreationStore | null = defaultStore()): boolean {
	const key = keyOf(eoa)
	if (!key || !store) return false
	try {
		return store.getItem(key) === MARK
	} catch {
		return false
	}
}
