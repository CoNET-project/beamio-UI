/**
 * @jest-environment node
 */
/** Peer armor is dropped from the persisted copy only; stored chat rows never become fewer. SYNTHETIC values. */
import { keepStoredChats, keepMemoryChats, withoutPeerArmorForShell, countPeerArmorRows, CHATS_FLOOR_REFUSED } from './chatsFloor'
import { buildShellRecordWriteCommand } from './shellRecordStore'
import { pgpPublicPaths } from './shellRecordSanitizer'

const EOA = '0x' + '11'.repeat(20)
const A = '0x' + 'aa'.repeat(20)
const B = '0x' + 'bb'.repeat(20)
const C = '0x' + 'cc'.repeat(20)
const row = (address: string, extra: Record<string, unknown> = {}, chatData: Record<string, unknown> = {}) => ({ address, messages: [], chatData, ...extra })
const rec = (chats: unknown[], keyID = EOA) => ({ profiles: [{ keyID, chats }] })

describe('the peer armor is dropped from the persisted copy only', () => {
	it('a row with publicArmored is refused by the shell write check; without it the check passes and verifiedFingerprint stays', () => {
		const memory = rec([row(A, {}, { publicArmored: 'SYNTHETIC-ARMOR', verifiedFingerprint: 'fp1', online: true })])
		expect(pgpPublicPaths(memory)).toEqual(['profiles[].chats[].chatData.publicArmored'])
		expect(() => buildShellRecordWriteCommand(0, memory as never, 0)).toThrow(/pgp_field_not_allowed/)
		const persisted = withoutPeerArmorForShell(memory)
		expect(() => buildShellRecordWriteCommand(0, persisted as never, 0)).not.toThrow()
		const cd = (persisted.profiles[0].chats[0] as { chatData: Record<string, unknown> }).chatData
		expect(cd.verifiedFingerprint).toBe('fp1')
		expect(cd.online).toBe(true)
		expect('publicArmored' in cd).toBe(false)
	})
	it('the in-memory record is not changed', () => {
		const memory = rec([row(A, {}, { publicArmored: 'SYNTHETIC-ARMOR' })])
		withoutPeerArmorForShell(memory)
		expect((memory.profiles[0].chats[0] as { chatData: Record<string, unknown> }).chatData.publicArmored).toBe('SYNTHETIC-ARMOR')
	})
	it('a record with nothing to drop is returned as it is', () => {
		const clean = rec([row(A, {}, { online: true })])
		expect(withoutPeerArmorForShell(clean)).toBe(clean)
	})
})

describe('the chats floor', () => {
	it('a new copy with no rows keeps the stored rows (count unchanged)', () => {
		const out = keepStoredChats(rec([]), rec([row(A), row(B)]))
		expect(out.profiles[0].chats).toHaveLength(2)
	})
	it('a new copy with more rows merges: union by address, the new fields win, the count is the union', () => {
		const stored = rec([row(A, { pin: false }), row(B)])
		const next = rec([row(A, { pin: true }), row(C)])
		const out = keepStoredChats(next, stored)
		const addrs = (out.profiles[0].chats as Array<{ address: string }>).map((r) => r.address).sort()
		expect(addrs).toEqual([A, B, C].sort())
		expect((out.profiles[0].chats as Array<{ address: string; pin: boolean }>).find((r) => r.address === A)?.pin).toBe(true)
	})
	it('a verifiedFingerprint is only added, never cleared', () => {
		const stored = rec([row(A, {}, { verifiedFingerprint: 'fp-old' })])
		const cleared = keepStoredChats(rec([row(A, {}, { verifiedFingerprint: '' })]), stored)
		expect((cleared.profiles[0].chats[0] as { chatData: Record<string, unknown> }).chatData.verifiedFingerprint).toBe('fp-old')
		const added = keepStoredChats(rec([row(A, {}, { verifiedFingerprint: 'fp-new' })]), stored)
		expect((added.profiles[0].chats[0] as { chatData: Record<string, unknown> }).chatData.verifiedFingerprint).toBe('fp-new')
	})
	it('a stored row keeps its messages when the new row has no messages array', () => {
		const stored = rec([row(A, { messages: [{ id: 'm1' }] })])
		const out = keepStoredChats(rec([{ address: A, chatData: {} }]), stored)
		expect((out.profiles[0].chats[0] as { messages: unknown[] }).messages).toHaveLength(1)
	})
	it('another account is not merged', () => {
		const out = keepStoredChats(rec([], '0x' + '22'.repeat(20)), rec([row(A)]))
		expect(out.profiles[0].chats).toHaveLength(0)
	})
	it('a stored rows value that is not an array, or no first profile in the new copy, is refused with chats_floor', () => {
		expect(() => keepStoredChats(rec([]), { profiles: [{ keyID: EOA, chats: 'x' }] })).toThrow(CHATS_FLOOR_REFUSED)
		expect(() => keepStoredChats({ profiles: [] }, rec([row(A)]))).toThrow(CHATS_FLOOR_REFUSED)
	})
	it('two stored copies are both kept by applying the floor once per copy', () => {
		const out = keepStoredChats(keepStoredChats(rec([]), rec([row(A)])), rec([row(B)]))
		expect(out.profiles[0].chats).toHaveLength(2)
	})
	it('the messages of a row are the union by message key: an empty or shorter new list never drops a stored message', () => {
		const stored = rec([row(A, { messages: [{ sendId: 's1', text: 'a', createdAt: 1 }, { id: 'i2', text: 'b', createdAt: 2 }] })])
		const empty = keepStoredChats(rec([row(A, { messages: [] })]), stored)
		expect((empty.profiles[0].chats[0] as { messages: unknown[] }).messages).toHaveLength(2)
		const more = keepStoredChats(rec([row(A, { messages: [{ sendId: 's1', text: 'a2', createdAt: 1 }, { sendId: 's3', text: 'c', createdAt: 3 }] })]), stored)
		const msgs = (more.profiles[0].chats[0] as { messages: Array<{ text: string }> }).messages
		expect(msgs.map((m) => m.text)).toEqual(['a2', 'b', 'c'])
	})
	it('with the plaintext purge in effect (keepMessages=false) the new empty bodies stand', () => {
		const stored = rec([row(A, { messages: [{ sendId: 's1', text: 'a', createdAt: 1 }] })])
		const out = keepStoredChats(rec([row(A, { messages: [] })]), stored, { keepMessages: false })
		expect((out.profiles[0].chats[0] as { messages: unknown[] }).messages).toHaveLength(0)
	})
	it('a stored row with no address is kept once and never appended again on repeated saves', () => {
		const noAddr = { messages: [], chatData: { online: true } }
		let record: ReturnType<typeof rec> = rec([noAddr])
		const stored = rec([noAddr])
		for (let i = 0; i < 4; i++) record = keepStoredChats(record, stored)
		expect(record.profiles[0].chats).toHaveLength(1)
	})
	it('two empty keyIDs are not the same account: nothing is merged', () => {
		const out = keepStoredChats(rec([], ''), rec([row(A)], ''))
		expect(out.profiles[0].chats).toHaveLength(0)
		const mem = keepMemoryChats(rec([row(B)], ''), rec([row(A)], ''))
		expect(mem.profiles[0].chats).toHaveLength(1)
	})
})

describe('the read feed-back keeps the memory rows (the disk copy never wipes them)', () => {
	it('the disk copy has no rows: the memory rows survive the replacement', () => {
		const out = keepMemoryChats(rec([]), rec([row(A), row(B)]))
		expect(out.profiles[0].chats).toHaveLength(2)
	})
	it('a row on both sides takes the memory fields (the memory is newer); a disk-only row is kept', () => {
		const disk = rec([row(A, { pin: false }), row(B)])
		const memory = rec([row(A, { pin: true })])
		const out = keepMemoryChats(disk, memory)
		const rows = out.profiles[0].chats as Array<{ address: string; pin?: boolean }>
		expect(rows.map((r) => r.address).sort()).toEqual([A, B].sort())
		expect(rows.find((r) => r.address === A)?.pin).toBe(true)
	})
	it('another account in memory is not merged; no memory rows returns the disk copy itself', () => {
		const disk = rec([row(B)])
		expect(keepMemoryChats(disk, rec([row(A)], '0x' + '22'.repeat(20)))).toBe(disk)
		expect(keepMemoryChats(disk, rec([]))).toBe(disk)
	})
	it('the other fields of the disk copy are kept as they are', () => {
		const disk = { ...rec([]), mnemonicPhrase: 'SYNTHETIC', other: 1 }
		const out = keepMemoryChats(disk, rec([row(A)]))
		expect((out as { other: number }).other).toBe(1)
		expect((out as { mnemonicPhrase: string }).mnemonicPhrase).toBe('SYNTHETIC')
	})
})

describe('peer armor rows are counted', () => {
	it('counts rows with the key, an empty string included', () => {
		expect(countPeerArmorRows(rec([row(A, {}, { publicArmored: '' }), row(B, {}, { publicArmored: 'x' }), row(C)]))).toBe(2)
	})
})

describe('Verified in a shell, end to end on the pure steps', () => {
	it('a trust write creates the row with the peer armor; the persisted copy passes the write check; a cold start reads the fingerprint back; a start-up read feed-back with empty memory keeps it', () => {
		// 1 trust write: the created row carries the peer's armor and the verified fingerprint (memory)
		const memory = rec([row(A, {}, { publicArmored: 'SYNTHETIC-ARMOR', verifiedFingerprint: 'fp-verified', keyFingerprint: 'fp-verified' })])
		// 2 persist: floor against the stored page copy (no rows yet), then drop the armor: the write check passes
		const persisted = withoutPeerArmorForShell(keepStoredChats(withoutPeerArmorForShell(memory), rec([])))
		expect(() => buildShellRecordWriteCommand(0, persisted as never, 0)).not.toThrow()
		// 3 cold start: the page copy is read back, the memory is empty; the gate reads the stored fingerprint from the page copy
		const afterColdStart = keepMemoryChats(persisted, rec([]))
		const stored = afterColdStart.profiles[0].chats[0] as { chatData: Record<string, unknown> }
		expect(stored.chatData.verifiedFingerprint).toBe('fp-verified')
		expect('publicArmored' in stored.chatData).toBe(false)
		// 4 a later save with an empty memory (feed-back wiped) never makes the stored rows fewer
		const later = keepStoredChats(rec([]), persisted)
		expect(later.profiles[0].chats).toHaveLength(1)
	})
})
