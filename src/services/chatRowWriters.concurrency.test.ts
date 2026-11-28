/**
 * @jest-environment node
 */
// two writers of the account record that BOTH took an old snapshot before either one wrote (the inbound batch of App.tsx, the conversation's storageData of chat.tsx). The interleaving is
// real (both snapshot first, each waits on its own gate, the commits then run in the order the test chooses), not two calls one after the other. The commits use the same pure functions as the
// production code (mergeBatchIntoCurrent, mergeOwnRowIntoCurrent, markDeliveredFrom); the wiring of those calls into App.tsx / chat.tsx is pinned by draftWiring.static.test.ts.
import { mergeBatchIntoCurrent, mergeOwnRowIntoCurrent } from './chatRowMerge'
import { keepStoredChats } from './chatsFloor'

type Row = { address: string; messages: Array<Record<string, unknown>>; unreadCount: number }
type Acct = { profiles: Array<{ keyID: string; chats: Row[] }> }
const A = '0xaaaa000000000000000000000000000000000001'
const me = (sendId: string, status: string, t: number) => ({ from: 'me', sendId, id: `tmp_${sendId}`, text: sendId, createdAt: t, status })
const inbound = (sendId: string, t: number) => ({ from: 'them', sendId, id: sendId, text: sendId, createdAt: t, status: 'sent' })
const gate = () => { let open: () => void = () => undefined; const p = new Promise<void>((r) => { open = r }); return { p, open } }
const tick = () => new Promise<void>((r) => setImmediate(r))
const summary = (acct: Acct) => acct.profiles[0].chats[0].messages.map((m) => `${m.sendId}:${m.status}`).sort()

function freshAccount(): Acct {
	return { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [me('m1', 'sent', 1)] }] }] }
}

/** App.tsx addNewMessage: snapshot at the start, its awaits (the gate), then the commit into the CURRENT record. */
async function batchWriter(acct: Acct, g: Promise<void>, lines: { inbound?: Array<ReturnType<typeof inbound>>; delivered?: string[] }, onSnapshot: () => void) {
	const startChats = [...acct.profiles[0].chats]
	const chats = startChats.map((r) => ({ ...r, messages: [...r.messages] }))
	onSnapshot()
	await g
	for (const i of lines.inbound ?? []) chats[0].messages.push(i)
	if ((lines.inbound ?? []).length) chats[0].unreadCount += 1
	const merged = mergeBatchIntoCurrent({ currentChats: acct.profiles[0].chats, startChats, batchChats: chats, delivered: (lines.delivered ?? []).map((sendId) => ({ sendId, from: A })) }) as Row[]
	acct.profiles = [{ ...acct.profiles[0], chats: merged }]
}

/** chat.tsx storageData: its own list, an await (sealing the file manifests), then the record is read AGAIN and its row merged into the current row. */
async function conversationWriter(acct: Acct, g: Promise<void>, ownMessages: Array<Record<string, unknown>>, onSnapshot: () => void) {
	const ownRow: Row = { address: A, unreadCount: 0, messages: ownMessages }
	onSnapshot()
	await g
	const live = acct.profiles[0]
	const merged = live.chats.map((c) => (c.address === A ? (mergeOwnRowIntoCurrent(c, ownRow) as Row) : c))
	acct.profiles = [{ ...live, chats: merged }]
}

/** The old way: the writer puts its snapshot (plus its changes) over the record. */
async function oldWayBatch(acct: Acct, g: Promise<void>, lines: { inbound: Array<ReturnType<typeof inbound>> }, onSnapshot: () => void) {
	const snapshotProfiles = acct.profiles
	const chats = snapshotProfiles[0].chats.map((r) => ({ ...r, messages: [...r.messages, ...lines.inbound] }))
	onSnapshot()
	await g
	acct.profiles = [{ ...snapshotProfiles[0], chats }]
}

describe('two writers with old snapshots', () => {
	for (const order of ['conversation first', 'batch first'] as const) {
		it(`${order}: the message the conversation added, the inbound message of the batch and the delivered mark of the batch are all in the record (nothing is lost, nothing goes back)`, async () => {
			const acct = freshAccount()
			const gConv = gate()
			const gBatch = gate()
			let snapshots = 0
			const conv = conversationWriter(acct, gConv.p, [me('m1', 'sent', 1), me('m2', 'sending', 4)], () => { snapshots += 1 })
			const batch = batchWriter(acct, gBatch.p, { inbound: [inbound('i1', 5)], delivered: ['m1'] }, () => { snapshots += 1 })
			await tick()
			expect(snapshots).toBe(2) // BOTH took their snapshot before either wrote
			if (order === 'conversation first') {
				gConv.open(); await conv
				gBatch.open(); await batch
			} else {
				gBatch.open(); await batch
				gConv.open(); await conv
			}
			expect(summary(acct)).toEqual(['i1:sent', 'm1:delivered', 'm2:sending'])
		})
	}

	it('a receipt for a message that is not in the batch\'s snapshot (the conversation adds it meanwhile) is applied to the current record', async () => {
		const acct = freshAccount()
		const gConv = gate()
		const gBatch = gate()
		const batch = batchWriter(acct, gBatch.p, { delivered: ['m2'] }, () => undefined) // the batch's snapshot has m1 only
		const conv = conversationWriter(acct, gConv.p, [me('m1', 'sent', 1), me('m2', 'sent', 4)], () => undefined)
		await tick()
		gConv.open(); await conv // m2 is now in the record
		gBatch.open(); await batch // the receipt for m2 arrives with the batch that never saw m2
		expect(summary(acct)).toEqual(['m1:sent', 'm2:delivered'])
	})

	it('the conversation writes a stale `sent` after the batch marked the message delivered: it stays delivered', async () => {
		const acct = freshAccount()
		const gConv = gate()
		const gBatch = gate()
		const conv = conversationWriter(acct, gConv.p, [me('m1', 'sent', 1)], () => undefined)
		const batch = batchWriter(acct, gBatch.p, { delivered: ['m1'] }, () => undefined)
		await tick()
		gBatch.open(); await batch
		gConv.open(); await conv
		expect(summary(acct)).toEqual(['m1:delivered'])
	})

	it('the persisted floor holds the same line for the writer that goes to disk last', () => {
		const stored = { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [me('m1', 'delivered', 1), me('m2', 'sent', 4)] }] }] }
		const stale = { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [me('m1', 'sent', 1)] }] }] }
		const written = keepStoredChats(stale, stored) as Acct
		expect(summary(written)).toEqual(['m1:delivered', 'm2:sent'])
	})

	it('control: a writer that puts its whole snapshot over the record drops the other writer\'s message in exactly this interleaving, so these tests do have teeth', async () => {
		const acct = freshAccount()
		const gConv = gate()
		const gBatch = gate()
		const batch = oldWayBatch(acct, gBatch.p, { inbound: [inbound('i1', 5)] }, () => undefined)
		const conv = conversationWriter(acct, gConv.p, [me('m1', 'sent', 1), me('m2', 'sending', 4)], () => undefined)
		await tick()
		gConv.open(); await conv
		gBatch.open(); await batch
		expect(summary(acct)).not.toContain('m2:sending') // the conversation's message is gone
	})
})

describe('a removal by the user against a stale batch', () => {
	it('the conversation removes the failed message m1 (tombstone) while the batch, which took its snapshot before, commits: m1 stays removed, whichever commits first', async () => {
		for (const order of ['batch first', 'conversation first'] as const) {
			const acct = freshAccount()
			acct.profiles[0].chats[0].messages.push(me('m1x', 'failed', 3))
			const gConv = gate()
			const gBatch = gate()
			const batch = batchWriter(acct, gBatch.p, { inbound: [inbound('i1', 5)] }, () => undefined) // its snapshot holds m1x
			const ownRow = { address: A, unreadCount: 0, messages: [me('m1', 'sent', 1)], removedSendIds: ['m1x'] } as unknown as Row
			const conv = (async () => {
				await gConv.p
				const live = acct.profiles[0]
				acct.profiles = [{ ...live, chats: live.chats.map((c) => (c.address === A ? (mergeOwnRowIntoCurrent(c, ownRow) as Row) : c)) }]
			})()
			await tick()
			if (order === 'batch first') { gBatch.open(); await batch; gConv.open(); await conv } else { gConv.open(); await conv; gBatch.open(); await batch }
			expect(summary(acct)).toEqual(['i1:sent', 'm1:sent'])
		}
	})
})


describe('two messages 0.7 s apart', () => {
	// The second message's write (chat.tsx storageData) can start with a list that does not hold the first message yet (the first one's own write is still waiting on its gate), or holds it as `sending`.
	for (const secondList of ['without the first', 'with the first as sending'] as const) {
		for (const order of ['first write lands first', 'second write lands first'] as const) {
			it(`the second write starts ${secondList}; ${order}: both messages are in the record, the first keeps its best status`, async () => {
				const acct: Acct = { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [] }] }] }
				const g1 = gate()
				const g2 = gate()
				let snaps = 0
				const w1 = conversationWriter(acct, g1.p, [me('first', 'sent', 1)], () => { snaps += 1 })
				const w2 = conversationWriter(acct, g2.p, secondList === 'without the first' ? [me('second', 'sending', 2)] : [me('first', 'sending', 1), me('second', 'sending', 2)], () => { snaps += 1 })
				await tick()
				expect(snaps).toBe(2)
				const [a, b] = order === 'first write lands first' ? [g1, g2] : [g2, g1]
				a.open()
				await tick()
				b.open()
				await Promise.all([w1, w2])
				expect(summary(acct)).toEqual(['first:sent', 'second:sending'])
			})
		}
	}
	it('a whole-record writer that took its snapshot before the first message existed would drop it (the old way); the merge never does', async () => {
		const acct: Acct = { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [] }] }] }
		const g = gate()
		const snapshot = acct.profiles[0]
		const old = (async () => { await g.p; acct.profiles = [{ ...snapshot, chats: [{ address: A, unreadCount: 0, messages: [me('second', 'sent', 2)] }] }] })()
		acct.profiles = [{ ...acct.profiles[0], chats: [{ address: A, unreadCount: 0, messages: [me('first', 'sent', 1)] }] }]
		g.open()
		await old
		expect(summary(acct)).toEqual(['second:sent']) // what the pre-writers did: the first is gone
		const acct2: Acct = { profiles: [{ keyID: 'k', chats: [{ address: A, unreadCount: 0, messages: [me('first', 'sent', 1)] }] }] }
		const merged = mergeOwnRowIntoCurrent(acct2.profiles[0].chats[0], { address: A, unreadCount: 0, messages: [me('second', 'sent', 2)] }) as Row
		expect(merged.messages.map((m) => m.sendId).sort()).toEqual(['first', 'second'])
	})
})
