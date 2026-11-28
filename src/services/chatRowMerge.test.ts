// merging chat rows without replacing them from a snapshot (chatRowMerge.ts), and the persisted floor (chatsFloor.ts).
import { MAX_TOMBSTONES, markDeliveredFrom, mergeBatchIntoCurrent, mergeMessagesMonotonic, mergeOwnRowIntoCurrent, mergePhoneCalls, pickCurrentProfiles, tombstonesOf } from './chatRowMerge'
import { keepStoredChats, planBrowserWrite, STORED_RECORD_UNREADABLE } from './chatsFloor'
import { readPlainForFloor } from './passcode/walletVault'

const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const me = (sendId: string, status: string, t = 1, extra: Record<string, unknown> = {}) => ({ from: 'me', sendId, id: `tmp_${sendId}`, text: `t-${sendId}`, createdAt: t, status, ...extra })
const them = (sendId: string, t = 1) => ({ from: 'them', sendId, id: sendId, text: `in-${sendId}`, createdAt: t, status: 'sent' })
const row = (address: string, messages: unknown[], extra: Record<string, unknown> = {}) => ({ address, messages, unreadCount: 0, ...extra })
const msgs = (r: unknown) => ((r as { messages: Array<{ sendId: string; status: string }> }).messages)

describe('mergeMessagesMonotonic', () => {
	it('is the union by sendId; a message in both keeps the higher status whichever copy is the newer writer (a stale copy cannot take it back)', () => {
		const stored = [me('s1', 'delivered'), me('s2', 'sent')]
		const stale = [me('s1', 'sent'), me('s2', 'sending'), me('s3', 'sending', 3)]
		const out = mergeMessagesMonotonic(stored, stale, true) as Array<{ sendId: string; status: string }>
		expect(out.map((m) => [m.sendId, m.status])).toEqual([['s1', 'delivered'], ['s2', 'sent'], ['s3', 'sending']])
		const reversed = mergeMessagesMonotonic(stale, stored, true) as Array<{ sendId: string; status: string }>
		expect(reversed.map((m) => [m.sendId, m.status]).sort()).toEqual([['s1', 'delivered'], ['s2', 'sent'], ['s3', 'sending']])
	})
	it('a higher status brings its error with it; a lower one never overwrites the error of the higher one', () => {
		const out = mergeMessagesMonotonic([me('s1', 'failed', 1, { sendError: 'interrupted' })], [me('s1', 'sent', 1, { sendError: undefined })], true) as Array<Record<string, unknown>>
		expect(out[0].status).toBe('sent')
		const kept = mergeMessagesMonotonic([me('s1', 'sent')], [me('s1', 'failed', 1, { sendError: 'send_failed' })], true) as Array<Record<string, unknown>>
		expect(kept[0].status).toBe('sent')
	})
	it('a merge never brings the plaintext file manifest back into a persisted copy that carries only the encrypted one', () => {
		const out = mergeMessagesMonotonic([me('s1', 'sent', 1, { fileMessage: { name: 'secret' } })], [me('s1', 'sent', 1, { fileMessageCipher: 'iv.cipher' })], true) as Array<Record<string, unknown>>
		expect(out[0].fileMessageCipher).toBe('iv.cipher')
		expect('fileMessage' in out[0]).toBe(false)
	})
})

describe('mergeOwnRowIntoCurrent (the conversation writes its row)', () => {
	it('keeps the messages another writer added meanwhile, keeps the higher status, and takes the writer\'s own fields', () => {
		const current = row(A, [me('s1', 'delivered'), them('i1', 5)], { unreadCount: 1 })
		const own = row(A, [me('s1', 'sent'), me('s2', 'sending', 6)], { unreadCount: 0 })
		const merged = mergeOwnRowIntoCurrent(current, own) as { messages: Array<{ sendId: string; status: string }>; unreadCount: number }
		expect(merged.messages.map((m) => [m.sendId, m.status])).toEqual([['s1', 'delivered'], ['i1', 'sent'], ['s2', 'sending']])
		expect(merged.unreadCount).toBe(0)
	})
})

describe('markDeliveredFrom (only the chat of the receipt sender)', () => {
	it('marks the message in the sender\'s chat, not in another chat with the same sendId, and never lowers a status', () => {
		const chats = [row(A, [me('s1', 'sent')]), row(B, [me('s1', 'sent')])]
		const { chats: out, updated } = markDeliveredFrom(chats, 's1', A)
		expect(updated).toBe(true)
		expect(msgs(out[0])[0].status).toBe('delivered')
		expect(msgs(out[1])[0].status).toBe('sent')
		expect(markDeliveredFrom(out, 's1', A).updated).toBe(false) // idempotent
		expect(markDeliveredFrom([row(A, [me('s1', 'read')])], 's1', A).chats[0]).toEqual(row(A, [me('s1', 'read')]))
		expect(markDeliveredFrom(chats, 's1', '').updated).toBe(false)
	})
})

describe('mergeBatchIntoCurrent (the inbound batch writes only what it changed)', () => {
	it('a message the conversation added AFTER the batch took its snapshot survives, and the batch\'s inbound message and its delivered mark are applied to the current record', () => {
		const snapshot = [row(A, [me('s1', 'sent')])]
		const batchRow = { ...snapshot[0], messages: [me('s1', 'sent'), them('i1', 5)], unreadCount: 1 } // the batch added an inbound message
		const current = [row(A, [me('s1', 'sent'), me('s2', 'sending', 4)])] // meanwhile the conversation added s2
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: snapshot, batchChats: [batchRow], delivered: [{ sendId: 's2', from: A }] })
		expect(msgs(out[0]).map((m) => [m.sendId, m.status])).toEqual([['s1', 'sent'], ['s2', 'delivered'], ['i1', 'sent']])
		expect((out[0] as { unreadCount: number }).unreadCount).toBe(1)
	})
	it('a receipt for a message that is NOT in the batch snapshot is applied to the current record (it cannot be lost with the snapshot)', () => {
		const snapshot = [row(A, [])]
		const out = mergeBatchIntoCurrent({ currentChats: [row(A, [me('s9', 'sent')])], startChats: snapshot, batchChats: snapshot, delivered: [{ sendId: 's9', from: A }] })
		expect(msgs(out[0])[0].status).toBe('delivered')
	})
	it('rows the batch did not touch stay exactly as they are now; a conversation the batch created is added in front', () => {
		const snapshot = [row(A, [me('s1', 'sent')])]
		const current = [row(A, [me('s1', 'delivered')]), row(B, [me('b1', 'sent')])]
		const created = row('0xcccc000000000000000000000000000000000003', [them('c1')])
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: snapshot, batchChats: [created, ...snapshot], delivered: [] })
		expect(out[0]).toBe(created)
		expect(out[1]).toBe(current[0])
		expect(out[2]).toBe(current[1])
	})
	it('only the fields the batch changed are applied; the other fields stay as the current record has them', () => {
		const snapshot = [row(A, [], { unreadCount: 0, nickname: 'old' })]
		const batchRow = { ...snapshot[0], unreadCount: 3 } // the batch changed unreadCount only
		const current = [row(A, [], { unreadCount: 0, nickname: 'renamed-meanwhile' })]
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: snapshot, batchChats: [batchRow], delivered: [] })
		expect(out[0]).toMatchObject({ unreadCount: 3, nickname: 'renamed-meanwhile' })
	})
})

describe('mergePhoneCalls', () => {
	it('an unchanged batch leaves the current rows; a changed batch adds / replaces its own rows by session', () => {
		const cur = [{ sessionId: 'a', st: 1 }, { sessionId: 'b', st: 1 }]
		const start = [{ sessionId: 'a', st: 1 }]
		expect(mergePhoneCalls(cur, start, start)).toBe(cur)
		const out = mergePhoneCalls(cur, start, [{ sessionId: 'a', st: 2 }, { sessionId: 'c', st: 1 }]) as Array<{ sessionId: string; st: number }>
		expect(out.map((r) => [r.sessionId, r.st])).toEqual([['a', 2], ['b', 1], ['c', 1]])
	})
})

describe('the persisted floor never takes a status back', () => {
	it('a stale copy (sending / sent) cannot overwrite the stored delivered / sent; stored messages are never dropped', () => {
		const stored = { profiles: [{ keyID: 'k', chats: [row(A, [me('s1', 'delivered'), me('s2', 'sent')])] }] }
		const stale = { profiles: [{ keyID: 'k', chats: [row(A, [me('s1', 'sent'), me('s2', 'sending')])] }] }
		const floored = keepStoredChats(stale, stored) as typeof stale
		expect(msgs(floored.profiles[0].chats[0]).map((m) => [m.sendId, m.status])).toEqual([['s1', 'delivered'], ['s2', 'sent']])
		const shorter = { profiles: [{ keyID: 'k', chats: [row(A, [])] }] }
		expect(msgs((keepStoredChats(shorter, stored) as typeof stale).profiles[0].chats[0]).length).toBe(2)
	})
})

describe('the browser write plan: a stored record that cannot be read is never written over', () => {
	it('absent -> write without a floor (the first write of a new account); loaded -> write with the floor; unreadable -> refuse', () => {
		expect(planBrowserWrite({ status: 'absent' })).toEqual({ action: 'write', floorFrom: null })
		expect(planBrowserWrite({ status: 'loaded', data: { a: 1 } })).toEqual({ action: 'write', floorFrom: { a: 1 } })
		expect(planBrowserWrite({ status: 'unreadable', reason: 'locked' })).toEqual({ action: 'refuse', code: STORED_RECORD_UNREADABLE })
	})
	it('readPlainForFloor keeps the three answers apart: no record, a record, a read that throws', async () => {
		const fake = (probe: () => Promise<unknown>) => ({ readInit: probe, probeInit: probe }) as never
		expect(await readPlainForFloor(fake(async () => null))).toEqual({ status: 'absent' })
		const loaded = await readPlainForFloor(fake(async () => ({ profiles: [{ keyID: 'k' }] })))
		expect(loaded.status).toBe('loaded')
		const threw = await readPlainForFloor(fake(async () => { throw new Error('idb') }))
		expect(threw.status).toBe('unreadable')
	})
})

describe('tombstones: a message the user removed on purpose is not brought back by any merge (a union cannot express a deletion)', () => {
	const ids = (r: unknown) => msgs(r).map((m) => m.sendId)
	it('the review\'s probe: the current row [m1, m2], the writer\'s row [m2] that removed m1 -> [m2], and the tombstone stays in the row', () => {
		const current = row(A, [me('m1', 'failed', 1), me('m2', 'sent', 2)])
		const own = row(A, [me('m2', 'sent', 2)], { removedSendIds: ['m1'] })
		const out = mergeOwnRowIntoCurrent(current, own) as { removedSendIds?: string[] }
		expect(ids(out)).toEqual(['m2'])
		expect(out.removedSendIds).toEqual(['m1'])
		// without the tombstone the union brings it back (the regression this fixes)
		expect(ids(mergeOwnRowIntoCurrent(current, row(A, [me('m2', 'sent', 2)])))).toEqual(['m1', 'm2'])
	})
	it('a tombstone already in the CURRENT row is honoured by a writer that does not know it (an older copy)', () => {
		const current = row(A, [me('m2', 'sent', 2)], { removedSendIds: ['m1'] })
		const staleOwn = row(A, [me('m1', 'failed', 1), me('m2', 'sent', 2)])
		const out = mergeOwnRowIntoCurrent(current, staleOwn) as { removedSendIds?: string[] }
		expect(ids(out)).toEqual(['m2'])
		expect(out.removedSendIds).toEqual(['m1'])
	})
	it('the inbound batch: its snapshot still holds the removed message, the current record has the tombstone: the batch does not revive it', () => {
		const snapshot = [row(A, [me('m1', 'failed', 1), me('m2', 'sent', 2)])]
		const batchRow = { ...snapshot[0], messages: [me('m1', 'failed', 1), me('m2', 'sent', 2), them('i1', 5)] }
		const current = [row(A, [me('m2', 'sent', 2)], { removedSendIds: ['m1'] })]
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: snapshot, batchChats: [batchRow], delivered: [] })
		expect(ids(out[0])).toEqual(['m2', 'i1'])
		expect((out[0] as { removedSendIds?: string[] }).removedSendIds).toEqual(['m1'])
	})
	it('the persisted floor: the stored record still holds the removed message, the new copy carries the tombstone: it is not kept', () => {
		const stored = { profiles: [{ keyID: 'k', chats: [row(A, [me('m1', 'failed', 1), me('m2', 'sent', 2)])] }] }
		const next = { profiles: [{ keyID: 'k', chats: [row(A, [me('m2', 'sent', 2)], { removedSendIds: ['m1'] })] }] }
		const floored = keepStoredChats(next, stored) as typeof stored
		expect(msgs(floored.profiles[0].chats[0]).map((m) => m.sendId)).toEqual(['m2'])
		// and a later stale write without the tombstone cannot bring it back either: the stored row has the tombstone now
		const storedAfter = floored
		const stale = { profiles: [{ keyID: 'k', chats: [row(A, [me('m1', 'failed', 1), me('m2', 'sent', 2)])] }] }
		expect(msgs((keepStoredChats(stale, storedAfter) as typeof stored).profiles[0].chats[0]).map((m) => m.sendId)).toEqual(['m2'])
	})
	it('the set only grows (a union of both copies) and is bounded to the newest MAX_TOMBSTONES', () => {
		expect(tombstonesOf({ removedSendIds: ['a', 'b'] }, { removedSendIds: ['b', 'c'] }, null, { removedSendIds: ['', 7] })).toEqual(['a', 'b', 'c'])
		const many = Array.from({ length: MAX_TOMBSTONES + 20 }, (_, i) => `id${i}`)
		const out = tombstonesOf({ removedSendIds: many })
		expect(out).toHaveLength(MAX_TOMBSTONES)
		expect(out[out.length - 1]).toBe(`id${MAX_TOMBSTONES + 19}`)
	})
	it('only messages named by sendId are dropped: a message without a sendId, another contact\'s row and the inbound messages are untouched', () => {
		const current = [row(A, [me('m1', 'failed', 1), them('i1', 2)], { removedSendIds: ['m1'] }), row(B, [me('m1', 'sent', 1)])]
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: current, batchChats: [{ ...current[0], unreadCount: 2 }, current[1]], delivered: [] })
		expect(ids(out[0])).toEqual(['i1'])
		expect(ids(out[1])).toEqual(['m1']) // the other contact's chat has its own message with that sendId
	})
})

describe('pickCurrentProfiles: the record a writer merges into', () => {
	const snap = [{ keyID: '0xAbC', chats: ['old'] }]
	it('the current global record when it is the same account (the newest copy), otherwise the snapshot', () => {
		const cur = { profiles: [{ keyID: '0xabc', chats: ['new'] }] }
		expect(pickCurrentProfiles(cur, snap)).toEqual({ profiles: cur.profiles, isCurrent: true })
		expect(pickCurrentProfiles({ profiles: [{ keyID: '0xother', chats: [] }] }, snap)).toEqual({ profiles: snap, isCurrent: false }) // another account: never mixed
		expect(pickCurrentProfiles(null, snap)).toEqual({ profiles: snap, isCurrent: false })
		expect(pickCurrentProfiles({ profiles: [] }, snap)).toEqual({ profiles: snap, isCurrent: false })
		expect(pickCurrentProfiles({ profiles: [{ keyID: '', chats: [] }] }, [{ keyID: '' }])).toEqual({ profiles: [{ keyID: '' }], isCurrent: false }) // an empty keyID is not an account
	})
})


describe('two copies with DIFFERENT tombstones merge to their union, in every merge', () => {
	const ids = (r: unknown) => msgs(r).map((m) => m.sendId)
	const dead = (r: unknown) => [...((r as { removedSendIds?: string[] }).removedSendIds ?? [])].sort()
	it('the writer\'s own row merged into the current row: tombstones {a} (current) and {b} (own) -> {a, b}; both messages stay removed', () => {
		const current = row(A, [me('m3', 'sent', 3)], { removedSendIds: ['a'] })
		const own = row(A, [me('a', 'failed', 1), me('b', 'failed', 2), me('m3', 'sent', 3)], { removedSendIds: ['b'] })
		const out = mergeOwnRowIntoCurrent(current, own)
		expect(dead(out)).toEqual(['a', 'b'])
		expect(ids(out)).toEqual(['m3'])
	})
	it('the inbound batch: tombstones of the current record {a} and of the batch row {b} -> {a, b}', () => {
		const snapshot = [row(A, [me('a', 'failed', 1), me('b', 'failed', 2), me('m3', 'sent', 3)])]
		const batchRow = { ...snapshot[0], removedSendIds: ['b'], messages: [me('a', 'failed', 1), me('m3', 'sent', 3), them('i1', 5)] }
		const current = [row(A, [me('b', 'failed', 2), me('m3', 'sent', 3)], { removedSendIds: ['a'] })]
		const out = mergeBatchIntoCurrent({ currentChats: current, startChats: snapshot, batchChats: [batchRow], delivered: [] })
		expect(dead(out[0])).toEqual(['a', 'b'])
		expect(ids(out[0]).sort()).toEqual(['i1', 'm3'])
	})
	it('the persisted floor: the stored row has {a}, the new copy has {b} -> the stored row keeps {a, b}', () => {
		const stored = { profiles: [{ keyID: 'k', chats: [row(A, [me('m3', 'sent', 3)], { removedSendIds: ['a'] })] }] }
		const next = { profiles: [{ keyID: 'k', chats: [row(A, [me('a', 'failed', 1), me('m3', 'sent', 3)], { removedSendIds: ['b'] })] }] }
		const floored = keepStoredChats(next, stored) as typeof stored
		expect(dead(floored.profiles[0].chats[0])).toEqual(['a', 'b'])
		expect(ids(floored.profiles[0].chats[0])).toEqual(['m3'])
	})
	it('a later stale writer that knows neither tombstone cannot revive either message', () => {
		let cur = row(A, [me('m3', 'sent', 3)], { removedSendIds: ['a'] })
		cur = mergeOwnRowIntoCurrent(cur, row(A, [me('m3', 'sent', 3)], { removedSendIds: ['b'] })) as typeof cur
		const stale = row(A, [me('a', 'failed', 1), me('b', 'failed', 2), me('m3', 'sent', 3)])
		expect(ids(mergeOwnRowIntoCurrent(cur, stale))).toEqual(['m3'])
	})
})
