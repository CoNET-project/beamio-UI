/**
 * Writes a peer's key and route onto the chat row.
 *
 * The chat page holds a shallow copy of the stored row (initMessage returns the stored row object and the page copies it), so the copy's
 * `chatData` is the same object as the stored row's `chatData`. A write that changes that object in place before it compares the stored row
 * finds no difference: nothing is persisted, and the trust written by "Verified, continue" or "Verify and send" lasts only until the page is reloaded.
 *
 * The rules here never mutate the object they are given. A write builds a new `chatData`, reports whether any route field moved compared with
 * the object before the write, and the stored rows are replaced where the fields differ or where the write moved them.
 */
import { storedKeyFingerprint } from '../utils/pgpFingerprint'

export interface PeerRouteFields {
	publicArmored?: string
	routersArmoreds?: string
	routePgpKeyID?: string
	keyFingerprint?: string
	verifiedFingerprint?: string
	[key: string]: unknown
}

/** A key and route to write. `fingerprint` is the OpenPGP fingerprint of `publicArmored`. */
export interface PeerRouteIncoming {
	publicArmored: string
	routersArmoreds: string
	routePgpKeyID?: string
	fingerprint?: string
}

export interface PeerRouteRow {
	address?: string
	chatData?: PeerRouteFields | null
}

/** The fields a route write can change. */
export const PEER_ROUTE_KEYS = ['publicArmored', 'routersArmoreds', 'routePgpKeyID', 'keyFingerprint', 'verifiedFingerprint'] as const

/** The new `chatData` for a write. `before` is not changed. Only `trusted` writes the verified fingerprint. */
export function nextPeerChatData(before: PeerRouteFields | null | undefined, r: PeerRouteIncoming, trusted: boolean): PeerRouteFields {
	const next: PeerRouteFields = { publicArmored: '', routersArmoreds: '', online: false, routePgpKeyID: '', ...(before ?? {}) }
	next.publicArmored = r.publicArmored
	next.routersArmoreds = r.routersArmoreds
	if (r.routePgpKeyID) next.routePgpKeyID = r.routePgpKeyID
	if (r.fingerprint) next.keyFingerprint = storedKeyFingerprint(r.fingerprint)
	// Only the user's own verification (trusted) writes the verified fingerprint.
	if (trusted && r.fingerprint) next.verifiedFingerprint = storedKeyFingerprint(r.fingerprint)
	return next
}

/** True when a route field differs between the two objects (an absent field and an empty one are the same). */
export function routeFieldsDiffer(a: PeerRouteFields | null | undefined, b: PeerRouteFields | null | undefined): boolean {
	return PEER_ROUTE_KEYS.some((key) => (a?.[key] ?? '') !== (b?.[key] ?? ''))
}

/**
 * Returns the rows with `next` written into every row of `address` that differs from it, or that `force` marks (the write moved
 * the route compared with the object before it). Rows of other contacts are returned as they are. A written row gets a new `chatData`.
 */
export function applyPeerRouteToRows<T extends PeerRouteRow>(rows: T[], address: string, next: PeerRouteFields, force: boolean): { rows: T[]; changed: boolean } {
	const addrLower = (address || '').trim().toLowerCase()
	let changed = false
	const out = rows.map((row) => {
		if (String(row?.address || '').toLowerCase() !== addrLower) return row
		if (!force && !routeFieldsDiffer(row.chatData, next)) return row
		changed = true
		const written: PeerRouteFields = { ...(row.chatData ?? {}) }
		for (const key of PEER_ROUTE_KEYS) written[key] = next[key]
		// Never a downgrade: an untrusted write carries no verified fingerprint of its own. An empty value keeps the row's trust.
		if (!next.verifiedFingerprint && row.chatData?.verifiedFingerprint) written.verifiedFingerprint = row.chatData.verifiedFingerprint
		return { ...row, chatData: written }
	})
	return { rows: changed ? out : rows, changed }
}
