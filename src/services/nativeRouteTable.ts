/**
 * The contact routes the page hands to the native chat module, so the native layer can send the "delivered" receipt itself after `ackInbound`
 * (delivery-receipt protocol, 2026-11-24). The page keeps address -> {userPublicKeyArmored, routerArmoredPublicKey} in memory and sends the WHOLE
 * table with every `setRoutes` (the native side replaces its table). Rules:
 * - memory only: the table is never persisted and never logged (only its size); the peer keys do not enter the shell record copy;
 * - at most 256 entries (the oldest drops first); an armor is at most 32 KB and must be a PGP public key block; a bad entry is skipped;
 * - the send is debounced (at least 200 ms) and never blocks; the table is sent again when the native chat has (re)started;
 * - only a contact the user has VERIFIED, whose verified fingerprint equals the key just read, is offered (the same rule as a send); a stranger, an unverified
 *   contact, a changed key or an unconfirmed route is not, and is removed again if it had been (a route would tell that identity when a message arrived);
 * - the table is cleared on an account change or an identity clear, so another account's routes never reach the native session.
 * Pure apart from the injected timer and sender.
 */
export const ROUTE_TABLE_MAX_ENTRIES = 256
export const ROUTE_ARMOR_MAX_BYTES = 32 * 1024
export const ROUTE_SYNC_DEBOUNCE_MS = 200

export type RouteEntry = { address: string; userPublicKeyArmored: string; routerArmoredPublicKey: string }

export type RouteTableDeps = {
	/** Sends the whole table. Returns false when the native chat is not ready (the table is kept and sent later). */
	send: (routes: RouteEntry[]) => boolean
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (t: unknown) => void
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const isPgpPublic = (s: unknown): s is string =>
	typeof s === 'string' && s.length > 0 && s.length <= ROUTE_ARMOR_MAX_BYTES && s.includes('BEGIN PGP PUBLIC KEY') && s.includes('END PGP PUBLIC KEY')
/** A send that finds the native chat not ready is tried again after these waits (at most three times); the next change or the next chat start also sends. */
export const ROUTE_SYNC_RETRY_MS = [5_000, 15_000, 60_000] as const

export function createRouteTable(deps: RouteTableDeps) {
	const table = new Map<string, RouteEntry>()
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
	const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
	let timer: unknown = null
	let retries = 0

	const flush = (): boolean => {
		timer = null
		const ok = deps.send([...table.values()])
		if (ok) {
			retries = 0
		} else if (retries < ROUTE_SYNC_RETRY_MS.length) {
			timer = setTimer(flush, ROUTE_SYNC_RETRY_MS[retries])
			retries += 1
		}
		return ok
	}
	const schedule = (): void => {
		retries = 0
		if (timer !== null) return
		timer = setTimer(flush, ROUTE_SYNC_DEBOUNCE_MS)
	}
	return {
		/** Adds or refreshes a contact's route. False when the entry is not acceptable (nothing changes). */
		note(address: string, userPublicKeyArmored: string, routerArmoredPublicKey: string): boolean {
			const a = String(address ?? '').trim().toLowerCase()
			if (!ADDRESS_RE.test(a) || !isPgpPublic(userPublicKeyArmored) || !isPgpPublic(routerArmoredPublicKey)) return false
			const prev = table.get(a)
			if (prev && prev.userPublicKeyArmored === userPublicKeyArmored && prev.routerArmoredPublicKey === routerArmoredPublicKey) return true
			table.delete(a)
			table.set(a, { address: a, userPublicKeyArmored, routerArmoredPublicKey })
			if (table.size > ROUTE_TABLE_MAX_ENTRIES) table.delete(table.keys().next().value as string)
			schedule()
			return true
		},
		/**
		 * A contact is no longer eligible (not verified, the key changed, the route is unconfirmed): its route leaves the table and the whole table is sent
		 * again, even when it became empty (the native side replaces its table).
		 */
		remove(address: string): boolean {
			const a = String(address ?? '').trim().toLowerCase()
			if (!table.delete(a)) return false
			schedule()
			return true
		},
		has(address: string): boolean {
			return table.has(String(address ?? '').trim().toLowerCase())
		},
		size(): number {
			return table.size
		},
		/** The native chat has (re)started: its table is empty, so the whole table is sent again (debounced). */
		resend(): void {
			if (table.size > 0) schedule()
		},
		/** An account change or an identity clear: nothing of the old account is kept or sent. */
		clear(): void {
			table.clear()
			retries = 0
			if (timer !== null) {
				clearTimer(timer)
				timer = null
			}
		},
		flushNow: flush,
	}
}
export type RouteTable = ReturnType<typeof createRouteTable>

/**
 * Whether a contact's route may be offered, decided from the STORED verified fingerprint of the contact (the page's stored copy, the same source the send
 * gate uses), never from whichever copy of the contact the caller happened to hold:
 * - the contact has no row, or no key could be read now (network or internal error), or the stored copy could not be read: 'keep' (nothing changes, nothing new is offered);
 * - the chain definitively has no consistent valid key (no record, an invalid key): 'remove';
 * - a key was read and the stored copy has no verified fingerprint, or it differs from the key just read: 'remove';
 * - a key was read and the stored verified fingerprint equals it: 'offer'.
 */
export type RouteEligibility = 'offer' | 'keep' | 'remove'
export function routeEligibility(input: {
	rowKnown: boolean
	storedVerified: string | undefined
	freshFingerprint: string | undefined
	/** false: the stored copy could not be read (nothing can be concluded). Default true. */
	storedReadable?: boolean
	/** true: the chain definitively has no consistent valid key (no record, an invalid key): the contact is removed. */
	definitiveNoKey?: boolean
}): RouteEligibility {
	if (!input.rowKnown) return 'keep'
	if (input.definitiveNoKey && !input.freshFingerprint) return 'remove'
	if (!input.freshFingerprint) return 'keep'
	if (input.storedReadable === false) return 'keep'
	if (!input.storedVerified) return 'remove'
	return input.storedVerified === input.freshFingerprint ? 'offer' : 'remove'
}

/** The fingerprint and route of a trust decision, whichever way the decision went (a held decision carries the key that was read). */
export function readKeyOfDecision(
	decision:
		| { ok: true; fingerprint?: string; publicArmored: string; routersArmoreds: string }
		| { ok: false; held?: { fingerprint?: string; publicArmored: string; routersArmoreds: string } },
): { fingerprint: string | undefined; publicArmored: string; routersArmoreds: string } | undefined {
	const k = decision.ok ? decision : decision.held
	return k ? { fingerprint: k.fingerprint, publicArmored: k.publicArmored, routersArmoreds: k.routersArmoreds } : undefined
}

/** Applies an eligibility to the table; only while the native receipt path is active. Returns what happened. */
export function applyRouteEligibility(
	table: RouteTable,
	pathActive: () => boolean,
	address: string,
	eligibility: RouteEligibility,
	route: { publicArmored: string; routersArmoreds: string } | undefined,
): 'offered' | 'removed' | 'unchanged' {
	if (!pathActive()) return 'unchanged'
	if (eligibility === 'offer' && route) return table.note(address, route.publicArmored, route.routersArmoreds) ? 'offered' : 'unchanged'
	if (eligibility === 'remove') return table.remove(address) ? 'removed' : 'unchanged'
	return 'unchanged'
}
