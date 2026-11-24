/**
 * Persistence helpers for the chat rows of the stored wallet record.
 *
 * 1. `withoutPeerArmorForShell`: the shell write whitelist refuses a copy whose chat rows carry the peer's PGP public armor
 *    (`profiles[].chats[].chatData.publicArmored`, shellRecordSanitizer.pgpPublicPaths). The copy that is persisted drops exactly that field; the
 *    in-memory record is not touched, and verifiedFingerprint and every other field stay.
 * 2. `keepStoredChats`: the chats floor. A copy for the same account never makes the stored chat rows fewer: rows are the union by peer
 *    address, a row present in both takes the new copy's fields, and a verifiedFingerprint is only ever added, never cleared.
 *    A record that cannot be merged safely is refused with `chats_floor` and nothing is written.
 *
 * Pure. No content is logged.
 *
 * NOTE: the page has no entry to delete a conversation today, so the union below never revives a deleted row. If a
 * delete-conversation feature is ever added, it MUST add a deletion marker (removed peer + time) in the same change, and `keepStoredChats` /
 * `keepMemoryChats` must skip marked rows; otherwise the floor brings a deleted row back.
 */
type Loose = Record<string, unknown>

const isObject = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v)
const addrOf = (row: unknown): string => (isObject(row) && typeof row.address === 'string' ? row.address.trim().toLowerCase() : '')
const keyOf = (p: unknown): string => (isObject(p) && typeof p.keyID === 'string' ? p.keyID.trim().toLowerCase() : '')
/** Two profiles are the same account only when both keyIDs are non-empty and equal (an empty keyID on either side is not a match). */
const sameAccount = (a: unknown, b: unknown): boolean => {
	const ka = keyOf(a)
	return ka !== '' && ka === keyOf(b)
}
const msgKeyOf = (m: unknown): string => {
	if (!isObject(m)) return ''
	const id = typeof m.sendId === 'string' && m.sendId ? `s:${m.sendId}` : typeof m.id === 'string' && m.id ? `i:${m.id}` : ''
	return id
}
const createdOf = (m: unknown): number => (isObject(m) && typeof m.createdAt === 'number' ? m.createdAt : 0)
const sameJson = (a: unknown, b: unknown): boolean => {
	try {
		return JSON.stringify(a) === JSON.stringify(b)
	} catch {
		return false
	}
}

export type FloorOptions = {
	/** Keep the stored messages of a row (union by message key). False only when the user's own plaintext purge is in effect (bodies are removed on purpose). */
	keepMessages?: boolean
}

/** The messages of a row: the union by message key (a new copy never makes them fewer); a message in both takes the new copy's fields. Order by createdAt. */
function mergeMessages(oldMsgs: unknown[], newMsgs: unknown[]): unknown[] {
	const out: unknown[] = []
	const index = new Map<string, number>()
	const put = (m: unknown): void => {
		const k = msgKeyOf(m)
		if (!k) {
			if (!out.some((o) => sameJson(o, m))) out.push(m)
			return
		}
		const at = index.get(k)
		if (at === undefined) {
			index.set(k, out.length)
			out.push(m)
		} else out[at] = m
	}
	for (const m of oldMsgs) put(m)
	for (const m of newMsgs) put(m)
	return out
		.map((m, i) => ({ m, i }))
		.sort((a, b) => createdOf(a.m) - createdOf(b.m) || a.i - b.i)
		.map((x) => x.m)
}

export const CHATS_FLOOR_REFUSED = 'chats_floor'

/** A copy of the record whose chat rows carry no peer PGP public armor. The input is not changed; the same object is returned when nothing is dropped. */
export function withoutPeerArmorForShell<T>(record: T): T {
	if (!isObject(record) || !Array.isArray(record.profiles)) return record
	let changed = false
	const profiles = (record.profiles as unknown[]).map((p) => {
		if (!isObject(p) || !Array.isArray(p.chats)) return p
		let rowsChanged = false
		const chats = (p.chats as unknown[]).map((c) => {
			if (!isObject(c) || !isObject(c.chatData) || c.chatData.publicArmored === undefined) return c
			rowsChanged = true
			const { publicArmored: _dropped, ...rest } = c.chatData as Loose
			void _dropped
			return { ...c, chatData: rest }
		})
		if (!rowsChanged) return p
		changed = true
		return { ...p, chats }
	})
	return (changed ? { ...record, profiles } : record) as T
}

function mergeRow(oldRow: Loose, newRow: Loose, keepMessages: boolean): Loose {
	const merged: Loose = { ...oldRow, ...newRow }
	const oldData = isObject(oldRow.chatData) ? oldRow.chatData : undefined
	const newData = isObject(newRow.chatData) ? newRow.chatData : undefined
	if (oldData || newData) {
		const data: Loose = { ...(oldData ?? {}), ...(newData ?? {}) }
		// a verified fingerprint is only added: an empty new value never clears the stored one
		const vf = (newData && newData.verifiedFingerprint) || (oldData && oldData.verifiedFingerprint)
		if (vf) data.verifiedFingerprint = vf
		merged.chatData = data
	}
	// a row of the new copy without a messages array keeps the stored one; otherwise the messages are the union by message key, so an empty or shorter
	// new list never drops a stored message (only the user's plaintext purge, passed as keepMessages=false, clears bodies)
	if (!Array.isArray(newRow.messages) && Array.isArray(oldRow.messages)) merged.messages = oldRow.messages
	else if (keepMessages && Array.isArray(oldRow.messages) && Array.isArray(newRow.messages)) merged.messages = mergeMessages(oldRow.messages, newRow.messages)
	return merged
}

/**
 * The new record with the stored chat rows kept. `existing` records of another account are ignored (the overwrite floor refuses those writes).
 * Throws `chats_floor` when the stored rows exist but cannot be merged (the new copy has no first profile, or a malformed rows value).
 */
export function keepStoredChats<T>(next: T, existing: unknown, opts: FloorOptions = {}): T {
	const keepMessages = opts.keepMessages !== false
	const existings = [existing]
	if (!isObject(next)) return next
	const nextProfiles = Array.isArray(next.profiles) ? (next.profiles as unknown[]) : null
	let result: Loose = next
	for (const existing of existings) {
		if (!isObject(existing) || !Array.isArray(existing.profiles)) continue
		const oldP = existing.profiles[0]
		if (!isObject(oldP) || oldP.chats === undefined) continue
		if (!Array.isArray(oldP.chats)) throw new Error(CHATS_FLOOR_REFUSED)
		if (oldP.chats.length === 0) continue
		const profiles = Array.isArray(result.profiles) ? (result.profiles as unknown[]) : nextProfiles
		const newP = profiles?.[0]
		if (!isObject(newP)) throw new Error(CHATS_FLOOR_REFUSED)
		if (!sameAccount(oldP, newP)) continue
		const newRows: unknown[] = Array.isArray(newP.chats) ? newP.chats : []
		const seen = new Set<string>()
		const rows: unknown[] = []
		for (const r of newRows) {
			const a = addrOf(r)
			const old = a ? (oldP.chats as unknown[]).find((o) => addrOf(o) === a) : undefined
			rows.push(old && isObject(old) && isObject(r) ? mergeRow(old, r, keepMessages) : r)
			if (a) seen.add(a)
		}
		for (const o of oldP.chats as unknown[]) {
			const a = addrOf(o)
			if (a) {
				if (!seen.has(a)) {
					rows.push(o)
					seen.add(a)
				}
			} else if (!rows.some((r) => !addrOf(r) && sameJson(r, o))) {
				// a stored row with no address is kept once, by content (never appended again on every save)
				rows.push(o)
			}
		}
		const outProfiles = [...(profiles as unknown[])]
		outProfiles[0] = { ...newP, chats: rows }
		result = { ...result, profiles: outProfiles }
	}
	return result as T
}

/** How many chat rows of the record carry the peer armor key (what `withoutPeerArmorForShell` would drop). */
export function countPeerArmorRows(record: unknown): number {
	if (!isObject(record) || !Array.isArray(record.profiles)) return 0
	let n = 0
	for (const p of record.profiles as unknown[]) {
		if (!isObject(p) || !Array.isArray(p.chats)) continue
		for (const c of p.chats as unknown[]) if (isObject(c) && isObject(c.chatData) && c.chatData.publicArmored !== undefined) n += 1
	}
	return n
}

/**
 * The stored copy `stored` (read from the page IndexedDB) with the in-memory chat rows kept: for the same account the rows are the union by peer
 * address and a row present in both takes the MEMORY fields (the memory is newer than the disk), a verifiedFingerprint is only added. Another account's
 * memory is ignored. Returns `stored` itself when the memory has nothing to add. Throws `chats_floor` for an unmergeable memory copy.
 */
export function keepMemoryChats<T>(stored: T, memory: unknown, opts: FloorOptions = {}): T {
	if (!isObject(stored) || !Array.isArray(stored.profiles) || !isObject(memory) || !Array.isArray(memory.profiles)) return stored
	const memP = memory.profiles[0]
	const stP = (stored.profiles as unknown[])[0]
	if (!isObject(memP) || !isObject(stP) || !Array.isArray(memP.chats) || memP.chats.length === 0) return stored
	if (!sameAccount(memP, stP)) return stored
	// memory as the new copy, the stored copy as the floor: memory fields win, stored-only rows are kept
	const merged = keepStoredChats({ profiles: [{ keyID: memP.keyID, chats: memP.chats }] }, { profiles: [{ keyID: stP.keyID, chats: stP.chats }] }, opts) as { profiles: Array<{ chats: unknown[] }> }
	const profiles = [...(stored.profiles as unknown[])]
	profiles[0] = { ...stP, chats: merged.profiles[0].chats }
	return { ...stored, profiles } as T
}
