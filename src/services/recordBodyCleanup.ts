/**
 * take the message bodies out of the account record AFTER the library has confirmed that it holds them.
 *
 * Why it is needed: when the purged flag was lost (a SIGKILL drops localStorage), writes made before the library state was read put bodies back into the account record. The record then keeps them for
 * ever (the flag is only restored while the record holds none). They may be the ONLY copy of a message, so nothing is removed on a guess:
 *   1. per conversation, ask the library which of the record's sendIds it holds (`libraryHas`); a conversation the library cannot answer for keeps everything;
 *   2. only the messages the library confirmed are removed, one by one (a message without a sendId, or one the library did not confirm, stays);
 *   3. the stripped record is written and READ BACK: the confirmed messages must be gone from the stored copy, every other message must still be there, and the non-chat fields must be byte-identical;
 *   4. any failure (write, read-back, mismatch) puts the original record back in memory and in storage: the only copy is never lost.
 * The original profile objects are never mutated.
 */
import { countChatMessages, nonChatFingerprint, profileEoaOf } from './chatLocalPurge'

export interface CleanupDeps {
	liveProfiles(): unknown[]
	setLiveProfiles(profiles: unknown[]): void
	/** the sendIds (of those asked) that the library holds for this contact; null when it cannot say (worker not ready, refused) */
	libraryHas(peer: string, sendIds: string[]): Promise<Set<string> | null>
	persistProfiles(): Promise<boolean>
	readStoredProfiles(): Promise<unknown[] | null>
}

export type CleanupResult =
	| { ok: true; stripped: number; kept: number; skippedChats: number }
	| { ok: false; reason: 'nothing_to_do' | 'persist_failed' | 'readback_missing' | 'fingerprint_mismatch' | 'readback_mismatch' | 'exception'; kept?: number }

type Loose = Record<string, unknown>
const isObject = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

const sendIdsOf = (messages: unknown[]): string[] => {
	const out: string[] = []
	for (const m of messages) if (isObject(m) && typeof m.sendId === 'string' && m.sendId) out.push(m.sendId)
	return out
}

export async function cleanRecordBodies(deps: CleanupDeps): Promise<CleanupResult> {
	const original = deps.liveProfiles()
	if (countChatMessages(original) === 0) return { ok: false, reason: 'nothing_to_do' }
	const eoa = profileEoaOf(original)
	const fingerprintBefore = nonChatFingerprint(original)
	const stripped = new Set<string>() // `${peer}|${sendId}`
	let skippedChats = 0
	let kept = 0
	let next: unknown[]
	try {
		next = []
		for (const p of original) {
			if (!isObject(p) || !Array.isArray(p.chats)) { next.push(p); continue }
			const chats: unknown[] = []
			for (const c of p.chats) {
				if (!isObject(c) || !Array.isArray(c.messages) || c.messages.length === 0) { chats.push(c); continue }
				const peer = typeof c.address === 'string' ? c.address.toLowerCase() : ''
				const ids = sendIdsOf(c.messages)
				let confirmed: Set<string> | null = null
				if (peer && ids.length) confirmed = await deps.libraryHas(peer, ids)
				if (!confirmed || confirmed.size === 0) {
					skippedChats += confirmed === null ? 1 : 0
					kept += c.messages.length
					chats.push(c)
					continue
				}
				const left = c.messages.filter((m) => !(isObject(m) && typeof m.sendId === 'string' && confirmed!.has(m.sendId)))
				for (const id of confirmed) stripped.add(`${peer}|${id}`)
				kept += left.length
				const row: Loose = { ...c, messages: left }
				// the previews go with the bodies only when no body is left in this conversation
				if (left.length === 0) for (const f of ['preview', 'lastMessage', 'messagePreview']) delete row[f]
				chats.push(row)
			}
			next.push({ ...p, chats })
		}
	} catch {
		return { ok: false, reason: 'exception' }
	}
	if (stripped.size === 0) return { ok: true, stripped: 0, kept, skippedChats }

	const rollback = async () => {
		deps.setLiveProfiles(original)
		try { await deps.persistProfiles() } catch { /* the next start retries; memory holds the original */ }
	}
	try {
		deps.setLiveProfiles(next)
		if (!(await deps.persistProfiles())) { await rollback(); return { ok: false, reason: 'persist_failed' } }
		const stored = await deps.readStoredProfiles()
		if (!stored) { await rollback(); return { ok: false, reason: 'readback_missing' } }
		if (nonChatFingerprint(stored) !== fingerprintBefore) { await rollback(); return { ok: false, reason: 'fingerprint_mismatch' } }
		// the read-back: every confirmed message gone, every other message still there
		const storedKeys = new Set<string>()
		for (const p of stored) {
			if (!isObject(p) || !Array.isArray(p.chats)) continue
			for (const c of p.chats) {
				if (!isObject(c) || !Array.isArray(c.messages)) continue
				const peer = typeof c.address === 'string' ? c.address.toLowerCase() : ''
				for (const id of sendIdsOf(c.messages)) storedKeys.add(`${peer}|${id}`)
			}
		}
		for (const k of stripped) if (storedKeys.has(k)) { await rollback(); return { ok: false, reason: 'readback_mismatch', kept } }
		if (countChatMessages(stored) !== kept) { await rollback(); return { ok: false, reason: 'readback_mismatch', kept } }
	} catch {
		await rollback()
		return { ok: false, reason: 'exception' }
	}
	void eoa
	return { ok: true, stripped: stripped.size, kept, skippedChats }
}
