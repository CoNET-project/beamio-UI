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

/** Profiles as they are persisted: stripped once this account's bodies were purged. */
export function profilesForPersist<T>(profiles: T): T {
	return isChatBodiesPurgedFor(profileEoaOf(profiles)) ? stripChatBodiesFromProfiles(profiles) : profiles
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
