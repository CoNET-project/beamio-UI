/**
 * Store accessors for the inbound dedupe markers. The markers live on the wallet store object (`CoNET_Data`), so the next
 * store commit writes them. Only armor hashes are kept; see `inboundDedupeMarkers.ts`.
 */
import { CoNET_Data } from './globals'
import { addDedupeMarkers, hasDedupeMarker, normalizeArmorHash } from './inboundDedupeMarkers'

/**
 * Adds markers to the store object and returns the hashes that were not marked before. The caller commits the store; this function
 * writes nothing itself. The caller uses the returned list to roll back its own markers when the commit fails.
 */
export function recordInboundDedupeMarkers(armorHashes: readonly string[]): string[] {
	if (!CoNET_Data || !armorHashes.length) return []
	const before = CoNET_Data.inboundDedupeMarkers ?? []
	const known = new Set(before.map(normalizeArmorHash))
	const next = addDedupeMarkers(before, armorHashes)
	CoNET_Data.inboundDedupeMarkers = next
	const added: string[] = []
	for (const raw of armorHashes) {
		const hash = normalizeArmorHash(raw)
		if (hash && !known.has(hash) && next.includes(hash) && !added.includes(hash)) added.push(hash)
	}
	return added
}

/** Removes the given markers from the store object (a failed commit rolls back the markers it added). */
export function forgetInboundDedupeMarkers(armorHashes: readonly string[]): void {
	if (!CoNET_Data?.inboundDedupeMarkers?.length || !armorHashes.length) return
	const drop = new Set(armorHashes.map(normalizeArmorHash))
	CoNET_Data.inboundDedupeMarkers = CoNET_Data.inboundDedupeMarkers.filter((m) => !drop.has(normalizeArmorHash(m)))
}

/** True when the store already has a marker for this armor hash. */
export function hasInboundDedupeMarker(armorHash: string): boolean {
	return hasDedupeMarker(CoNET_Data?.inboundDedupeMarkers, armorHash)
}
