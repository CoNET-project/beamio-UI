/**
 * Plaintext chat-body purge helpers (D8; rule: only chat body fields are removed).
 *
 * Pure functions and one localStorage flag. No imports from beamio.ts, so beamio.ts can use these without a cycle.
 * The profile holds the wallet blob: every non-chat field is kept byte-for-byte (checked by nonChatFingerprint).
 */
import { keccak256, toUtf8Bytes } from 'ethers'

/** localStorage key prefix; the value is the lowercase EOA whose profile was purged. */
export const CHAT_BODIES_PURGED_KEY = 'beamio.chat.local.purged'

/** Chat-level fields that carry message text or previews (removes them with the messages). */
const CHAT_TEXT_FIELDS = ['preview', 'lastMessage', 'messagePreview'] as const

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function profileEoaOf(profiles: unknown): string {
	const first = Array.isArray(profiles) ? (profiles[0] as { keyID?: unknown } | undefined) : undefined
	return typeof first?.keyID === 'string' ? first.keyID.toLowerCase() : ''
}

/** True when this account's profile was purged (done). Storage failures read as "not purged". */
export function isChatBodiesPurgedFor(eoa: string): boolean {
	if (!eoa) return false
	try {
		return globalThis.localStorage?.getItem(CHAT_BODIES_PURGED_KEY) === eoa.toLowerCase()
	} catch {
		return false
	}
}

export function markChatBodiesPurged(eoa: string): void {
	if (!eoa) throw new Error('markChatBodiesPurged: eoa required')
	globalThis.localStorage?.setItem(CHAT_BODIES_PURGED_KEY, eoa.toLowerCase())
}

/** Remove message bodies and previews from one chat entry; every other field is kept. */
function stripChat(chat: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...chat, messages: [] }
	for (const f of CHAT_TEXT_FIELDS) if (f in next) delete next[f]
	return next
}

/** Profiles with chat bodies removed. Non-chat fields are the same values, not copies of secrets. */
export function stripChatBodiesFromProfiles<T>(profiles: T): T {
	if (!Array.isArray(profiles)) return profiles
	return profiles.map((p) => {
		if (!p || typeof p !== 'object') return p
		const profile = p as Record<string, unknown>
		if (!Array.isArray(profile.chats)) return p
		return { ...profile, chats: profile.chats.map((c) => (c && typeof c === 'object' ? stripChat(c as Record<string, unknown>) : c)) }
	}) as unknown as T
}

/**
 * what the persisted account record may hold for this account, judged like the sender's copy is (senderCopy.ts), not by the localStorage flag alone (a SIGKILL drops the flag while the library database stays).
 *  - `library` the flag is set (the purge ran and was verified): the record keeps NO bodies and the floor does not bring stored bodies back.
 *  - `guarded` the flag is NOT set but the library says switched / purged, or the browser worker library exists and did not answer within the bound (unknown): NEW bodies are not written into the record,
 *               and what is ALREADY stored is kept (the floor keeps it). A body that an earlier write put back after the flag was lost may be the only copy of that message; it is removed only after the
 *               library confirms it has it (not done yet: see the receipt), never on a guess.
 *  - `record` the library is record-based (none / running / complete), or there is no library on this client (a native shell has none: its migrationState throws "unavailable"), or nothing has been read yet:
 *               bodies are persisted as before. WITHOUT this rule a shell or a record-based user would lose their chat bodies.
 * Evidence is per account; it is set by the reads that already happen (migration start, every library decision of the chat page), never cleared from the absence of anything.
 */
export type LibraryPersistMode = 'library' | 'guarded' | 'record'
interface LibraryEvidence { eoa: string; capable: boolean; state: string | null }
let libraryEvidence: LibraryEvidence | null = null
/** `capable`: the active client is the browser worker with a library (not a native shell). `state`: its migration state, null when it was asked and did not answer. */
export function noteLibraryEvidence(input: { eoa: string; capable: boolean; state: string | null }): void {
	if (!input.eoa) return
	const eoa = input.eoa.toLowerCase()
	// an UNKNOWN read (a worker that is slow, a timeout) never overwrites what was known for this account: the last known state stays until a read says otherwise. Without this one slow answer turned a record-based
	// account into `guarded` (no bodies in the record) and could turn a known library back into unknown.
	const prev = libraryEvidence
	if (input.state === null && input.capable && prev && prev.eoa === eoa && prev.capable && prev.state !== null) return
	libraryEvidence = { eoa, capable: input.capable, state: input.state }
}
export function resetLibraryEvidenceForTest(): void {
	libraryEvidence = null
}
export function libraryPersistModeFor(eoa: string): LibraryPersistMode {
	if (!eoa) return 'record'
	if (isChatBodiesPurgedFor(eoa)) return 'library'
	const e = libraryEvidence
	if (!e || e.eoa !== eoa.toLowerCase() || !e.capable) return 'record'
	if (e.state === 'switched' || e.state === 'purged' || e.state === null) return 'guarded'
	return 'record'
}

/**
 * (read-only, for the QA hook): WHY `libraryPersistModeFor` answers what it answers. `mode` is the answer of libraryPersistModeFor itself (never recomputed here, so the two cannot disagree); the rest is what the
 * decision was made from: `flag` (the purged flag of this account is in place), `capable` (the active client is the browser worker with a library; null when there is no evidence for this account), `state` (the library's
 * migration state word; null = asked and not answered, or no evidence), `evidence` (none: nothing noted yet; other_account: the noted evidence belongs to another account; present; no_account). Reads only; changes nothing.
 */
export interface LibraryPersistExplain { mode: LibraryPersistMode; flag: boolean; capable: boolean | null; state: string | null; evidence: 'no_account' | 'none' | 'other_account' | 'present' }
export function libraryPersistExplain(eoa: string): LibraryPersistExplain {
	const mode = libraryPersistModeFor(eoa)
	const e = libraryEvidence
	const evidence = !eoa ? 'no_account' : !e ? 'none' : e.eoa !== eoa.toLowerCase() ? 'other_account' : 'present'
	return { mode, flag: isChatBodiesPurgedFor(eoa), capable: evidence === 'present' && e ? e.capable : null, state: evidence === 'present' && e ? e.state : null, evidence }
}

/**
 * an EXACT write: the record is written as it is (bodies included) and the chats floor does not bring stored messages back. Only the cleanup of bodies that the library has confirmed
 * (recordBodyCleanup.ts) uses it, around its one persist; any other write is judged by libraryPersistModeFor.
 */
let exactWriteDepth = 0
export const isExactRecordWrite = (): boolean => exactWriteDepth > 0
export async function withExactRecordWrite<T>(fn: () => Promise<T>): Promise<T> {
	exactWriteDepth += 1
	try {
		return await fn()
	} finally {
		exactWriteDepth -= 1
	}
}

/** Profiles as they are persisted: no bodies in `library` and `guarded` mode (libraryPersistModeFor), except in an exact write. The input is never mutated. */
export function profilesForPersist<T>(profiles: T): T {
	if (exactWriteDepth > 0) return profiles
	return libraryPersistModeFor(profileEoaOf(profiles)) !== 'record' ? stripChatBodiesFromProfiles(profiles) : profiles
}

/** Number of chat messages still held in profiles (0 after ). */
export function countChatMessages(profiles: unknown): number {
	if (!Array.isArray(profiles)) return 0
	let n = 0
	for (const p of profiles) {
		const chats = (p as { chats?: unknown } | undefined)?.chats
		if (!Array.isArray(chats)) continue
		for (const c of chats) {
			const msgs = (c as { messages?: unknown } | undefined)?.messages
			if (Array.isArray(msgs)) n += msgs.length
		}
	}
	return n
}

/** Canonical JSON: object keys sorted at every level, arrays in order. */
export function canonicalJson(value: unknown): string {
	const norm = (v: unknown): Json => {
		if (v === null || typeof v === 'boolean' || typeof v === 'string') return v as Json
		if (typeof v === 'number') return Number.isFinite(v) ? v : (null as unknown as Json)
		if (Array.isArray(v)) return v.map(norm)
		if (typeof v === 'object') {
			const out: { [k: string]: Json } = {}
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				const item = (v as Record<string, unknown>)[k]
				if (item === undefined || typeof item === 'function') continue
				out[k] = norm(item)
			}
			return out
		}
		return null
	}
	return JSON.stringify(norm(value))
}

/**
 * keccak256 over the canonical JSON of the profiles with every chat body removed. Equal fingerprints before and
 * after mean the wallet and every other non-chat field is unchanged.
 */
export function nonChatFingerprint(profiles: unknown): string {
	const stripped = stripChatBodiesFromProfiles(profiles)
	return keccak256(toUtf8Bytes(canonicalJson(stripped)))
}

export interface MigrationExtraRow {
	peer: string
	dir: 'in' | 'out'
	ts: number
	sendId?: string
	body: string
	pending?: boolean
}

/**
 * Profile message copies handed to the library import. Each row is the same JSON the history mirror stores.
 * Messages without a finite createdAt are skipped (no timestamp, so no stable order).
 */
export function migrationExtraFromProfiles(profiles: unknown): MigrationExtraRow[] {
	const rows: MigrationExtraRow[] = []
	if (!Array.isArray(profiles)) return rows
	for (const p of profiles) {
		const chats = (p as { chats?: unknown } | undefined)?.chats
		if (!Array.isArray(chats)) continue
		for (const c of chats) {
			const chat = c as { address?: unknown; messages?: unknown } | undefined
			const peer = typeof chat?.address === 'string' ? chat.address.toLowerCase() : ''
			const messages = chat?.messages
			if (!peer || !Array.isArray(messages)) continue
			for (const m of messages as Array<Record<string, unknown>>) {
				const ts = Number(m?.createdAt)
				if (!m || !Number.isFinite(ts)) continue
				let body: string
				try {
					body = JSON.stringify(m)
				} catch {
					continue
				}
				rows.push({
					peer,
					dir: m.from === 'me' ? 'out' : 'in',
					ts,
					sendId: typeof m.sendId === 'string' && m.sendId ? m.sendId : undefined,
					body,
					pending: m.status !== 'sent' && typeof m.id === 'string' && m.id.startsWith('tmp_'),
				})
			}
		}
	}
	return rows
}
