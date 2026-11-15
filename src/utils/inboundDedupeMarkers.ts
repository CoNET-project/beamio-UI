/**
 * Dedupe markers for inbound lines the browser page consumed without showing.
 *
 * A marker is the mailbox armor hash and nothing else: no line, no body, no sender. It is written into the store before the store
 * commit that precedes the browser mailbox ACK. A line the page already handled (voice control, a delivery receipt, a malformed or a
 * duplicate copy) is then not handled again when the mailbox redelivers it after a lost ACK.
 *
 * Pure functions only; the store accessors are in `inboundDedupeStore.ts`.
 */

/** Newest markers kept. The oldest go first. */
export const INBOUND_DEDUPE_MARKER_MAX = 500

const ARMOR_HASH = /^0x[0-9a-f]{64}$/

/** The armor hash in canonical form (trimmed, lower case), or '' when the value is not one. */
export function normalizeArmorHash(raw: unknown): string {
	const hash = String(raw ?? '').trim().toLowerCase()
	return ARMOR_HASH.test(hash) ? hash : ''
}

/**
 * Adds the hashes to the markers. A hash that is already there moves to the newest place. Values that are not armor hashes
 * (for example a whole line) are dropped, so a marker can never hold a body. Keeps the newest `INBOUND_DEDUPE_MARKER_MAX`.
 */
export function addDedupeMarkers(current: readonly string[] | undefined, hashes: readonly string[]): string[] {
	const merged = [...(current ?? []), ...hashes].map(normalizeArmorHash).filter((h) => h !== '')
	const lastIndex = new Map<string, number>()
	merged.forEach((h, i) => lastIndex.set(h, i))
	const unique = merged.filter((h, i) => lastIndex.get(h) === i)
	return unique.length > INBOUND_DEDUPE_MARKER_MAX ? unique.slice(unique.length - INBOUND_DEDUPE_MARKER_MAX) : unique
}

/** True when this armor hash has a marker. A value that is not an armor hash never matches. */
export function hasDedupeMarker(markers: readonly string[] | undefined, armorHash: string): boolean {
	const hash = normalizeArmorHash(armorHash)
	if (!hash || !markers?.length) return false
	return markers.some((m) => normalizeArmorHash(m) === hash)
}
