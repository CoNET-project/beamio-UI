/**
 * Writes a peer's key and route onto the chat row (BCHAT field test, sections 34-36).
 *
 * The chat page holds a shallow copy of the stored row (initMessage returns the stored row object and the page copies it), so the copy's
 * `chatData` is the same object as the stored row's `chatData`. A write that changes that object in place before it compares the stored row
 * finds no difference: nothing is persisted, and the trust written by "Verified, continue" or "Verify and send" lasts only until the page is reloaded.
 *
 * The rules here never mutate the object they are given. A write builds a new `chatData`, reports whether any route field moved compared with
 * the object before the write, and the stored rows are replaced where the fields differ or where the write moved them.
 */
import { storedKeyFingerprint, readStoredKeyFingerprint } from '../utils/pgpFingerprint'

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
		// Never a downgrade (BCHAT 43): an untrusted write carries no verified fingerprint of its own. An empty value keeps the row's trust.
		if (!next.verifiedFingerprint && row.chatData?.verifiedFingerprint) written.verifiedFingerprint = row.chatData.verifiedFingerprint
		return { ...row, chatData: written }
	})
	return { rows: changed ? out : rows, changed }
}


/**
 * a first pinned value recorded outside the chat page (payment, call, group, gift, receipt) goes to the stored record in services/chat.ts. The page's React `profiles`
 * state is a separate copy that later writes can persist, so it must see the pin too. The stored write therefore announces itself with this event and the profile provider applies the same pin to its state.
 */
export const FIRST_PIN_APPLIED_EVENT = 'beamio:first-pin-applied'
export type FirstPinAppliedDetail = { address: string; pinned: PeerRouteIncoming }

type ProfileWithChats = { chats?: PeerRouteRow[] } & Record<string, unknown>

/**
 * The profiles with the first pinned value written to the row of `address` in the first profile: only a row that exists and holds no verified value is written (a stranger gets
 * no row; a verified value is never replaced). Returns the same array when nothing changes. Pure.
 */
export function applyPinnedToProfiles<T extends ProfileWithChats>(profiles: T[] | null | undefined, address: string, pinned: PeerRouteIncoming): T[] | null | undefined {
	if (!Array.isArray(profiles) || profiles.length === 0) return profiles
	const first = profiles[0]
	const rows = Array.isArray(first?.chats) ? first.chats : []
	const want = String(address ?? '').trim().toLowerCase()
	const row = rows.find((r) => String(r?.address ?? '').toLowerCase() === want)
	if (!want || !row) return profiles
	if (readStoredKeyFingerprint(row.chatData?.verifiedFingerprint)) return profiles
	const next = nextPeerChatData(row.chatData ?? null, pinned, true)
	const { rows: written, changed } = applyPeerRouteToRows(rows, address, next, true)
	if (!changed) return profiles
	const out = [...profiles]
	out[0] = { ...first, chats: written }
	return out
}

/**
 * the chat page that is open holds its own `chatData` copy (the frozen object from the route state). A first pin written elsewhere
 * (a call or payment started from this page, a gift, a receipt) reaches the stored record and the profile provider's state, but not this copy,
 * which would then read "first contact" again (a second fresh chain read, a fingerprint prompt). The page applies the same pin to its copy on
 * FIRST_PIN_APPLIED_EVENT. Only the open contact's copy, only when it holds no verified value (a verified value is never replaced); a new object, never an in-place change.
 * Returns the new chatData, or null when nothing changes.
 */
export function pinnedChatDataForOpenChat(open: { address?: string; chatData?: PeerRouteFields | null } | null | undefined, address: string, pinned: PeerRouteIncoming): PeerRouteFields | null {
	const want = String(address ?? '').trim().toLowerCase()
	if (!open || !want || String(open.address ?? '').trim().toLowerCase() !== want) return null
	if (readStoredKeyFingerprint(open.chatData?.verifiedFingerprint)) return null
	const next = nextPeerChatData(open.chatData ?? null, pinned, true)
	return routeFieldsDiffer(open.chatData, next) ? next : null
}
