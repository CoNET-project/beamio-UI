/**
 * @jest-environment node
 */
// The drafts outside the components, with the real queue, queue store and media send. Invariant: whatever is counted as unsent still has its content here, and can be sent again. Synthetic values.
import { createChatDocStores } from './chatDocStores'
import { createSendQueue, type QueueDocAdapter } from './sendQueue'
import { conversationMediaContext, resetMediaClaimsForTest, sendMediaJobs, type MediaJob } from './chatMediaSend'
import { clearAllPendingSends, pendingCountOf, resetPendingSendsForTest } from './pendingSends'
import { discardVoice, heldFiles, heldVoice, holdRecording, resetDraftHolderForTest, sendHeldVoice, subscribeDrafts, updateHeldFiles, type VoiceSendSteps } from './mediaDraftHolder'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xbbbb000000000000000000000000000000000002'
const OTHER = '0xcccc000000000000000000000000000000000003'
type Row = { id: string; sendId: string }
beforeEach(() => { resetMediaClaimsForTest(); resetPendingSendsForTest(); resetDraftHolderForTest() })

function page() {
	const docs = new Map<string, string>()
	const broken = { queue: false }
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { if (broken.queue) throw new Error('quota'); docs.set(id, t) }, remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	const stores = createChatDocStores({ eoa: EOA, privateKey: `0x${'33'.repeat(32)}`, nativeShell: false, doc })!
	const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'awaiting', persisted: true }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	const delivered: string[] = []
	const shown = { peer: PEER }
	const messagesRef = { current: [] as Row[] }
	const context = () => conversationMediaContext<Row>({ wallet: EOA, peer: PEER, queueRef: { current: queue }, shownPeer: () => shown.peer, messagesRef, applyMessages: (n) => { messagesRef.current = n }, persistOutgoing: async () => undefined, markSendPersistFailed: () => undefined, deliverTextRef: { current: async (_i, wire) => { delivered.push(wire); return { kind: 'awaiting', persisted: true } } }, releaseDraft: () => undefined })
	return { stores, queue, broken, delivered, shown, messagesRef, context }
}
const recordingOf = (n: number) => ({ size: n }) as unknown as Blob
function steps(p: ReturnType<typeof page>, net: { fail?: boolean; gate?: Promise<void>; ids?: number; seals?: number }): VoiceSendSteps<string, Row> {
	return {
		newSendId: () => `voice-${(net.ids = (net.ids ?? 0) + 1)}`,
		now: () => 5,
		seal: async () => `sealed-${(net.seals = (net.seals ?? 0) + 1)}`,
		upload: async (s) => { await net.gate; if (net.fail) throw new Error('offline'); return `hash-${s}` },
		job: ({ sendId, createdAt, fragmentHash }) => ({ jobId: `voice:${sendId}`, sendId, createdAt, wire: JSON.stringify({ sendId, from: 'me', text: '', createdAt, voiceMessage: { fragmentHash } }), message: { id: `row-${sendId}`, sendId } }),
		context: p.context,
	}
}
/** what the page shows after it was unmounted and mounted again: it reads the holder, nothing else */
const afterRemount = () => heldVoice(EOA, PEER)

describe('a recording', () => {
	it('while it is being sent it stays held and counted: it cannot be discarded or replaced before the message is accepted', async () => {
		const p = page(); const rec = recordingOf(1)
		holdRecording(EOA, PEER, { recording: rec, durationMs: 900 })
		let open!: () => void
		const gate = new Promise<void>((r) => { open = r })
		const running = sendHeldVoice(EOA, PEER, steps(p, { gate }))
		expect([afterRemount()?.recording, afterRemount()?.sending, pendingCountOf(EOA)]).toEqual([rec, true, 1])
		expect([discardVoice(EOA, PEER), holdRecording(EOA, PEER, { recording: recordingOf(2), durationMs: 1 })]).toEqual([false, false])
		expect([afterRemount()?.recording, pendingCountOf(EOA)]).toEqual([rec, 1])
		expect((await sendHeldVoice(EOA, PEER, steps(p, {}))).kind).toBe('skipped') // a second click
		open()
		expect((await running).kind).toBe('accepted')
		expect([afterRemount(), pendingCountOf(EOA), p.delivered.length, (await p.stores.queueStore.list()).length]).toEqual([null, 0, 1, 1])
		p.queue.dispose()
	})
	it('a failed upload, then a refused acceptance: after a remount the recording is there, counted once, and the retry is the same message', async () => {
		const p = page(); const rec = recordingOf(1); const net = { fail: true } as { fail: boolean; ids?: number; seals?: number }
		holdRecording(EOA, PEER, { recording: rec, durationMs: 900 })
		let notices = 0
		const off = subscribeDrafts(() => { notices += 1 })
		expect((await sendHeldVoice(EOA, PEER, steps(p, net))).kind).toBe('failed')
		expect([afterRemount()?.recording, afterRemount()?.sending, pendingCountOf(EOA)]).toEqual([rec, false, 1])
		expect(holdRecording(EOA, PEER, { recording: recordingOf(2), durationMs: 1 })).toBe(false) // a counted recording is not replaced
		net.fail = false; p.broken.queue = true
		expect((await sendHeldVoice(EOA, PEER, steps(p, net))).kind).toBe('not_saved')
		expect([afterRemount()?.recording, pendingCountOf(EOA), p.delivered.length]).toEqual([rec, 1, 0])
		p.broken.queue = false
		expect((await sendHeldVoice(EOA, PEER, steps(p, net))).kind).toBe('accepted')
		expect([afterRemount(), pendingCountOf(EOA), net.ids, net.seals]).toEqual([null, 0, 1, 1])
		expect((await p.stores.queueStore.list()).map((i) => i.sendId)).toEqual(['voice-1'])
		expect(notices).toBeGreaterThan(0)
		off(); p.queue.dispose()
	})
	it('only the user discarding it ends the count of a failed recording; the conversation changed during the upload keeps it with its own conversation', async () => {
		const p = page(); const rec = recordingOf(1)
		holdRecording(EOA, PEER, { recording: rec, durationMs: 9 })
		let open!: () => void
		const gate = new Promise<void>((r) => { open = r })
		const running = sendHeldVoice(EOA, PEER, steps(p, { gate }))
		p.shown.peer = OTHER
		open()
		expect((await running).kind).toBe('not_saved')
		expect([heldVoice(EOA, OTHER), heldVoice(EOA, PEER)?.recording, pendingCountOf(EOA)]).toEqual([null, rec, 1])
		expect(discardVoice(EOA, PEER)).toBe(true)
		expect([heldVoice(EOA, PEER), pendingCountOf(EOA)]).toEqual([null, 0])
		p.queue.dispose()
	})
})

const fileJob = (id: string): MediaJob<Row> => ({ jobId: id, sendId: `s-${id}`, createdAt: 7, wire: JSON.stringify({ sendId: `s-${id}`, from: 'me', text: '', createdAt: 7, fileMessage: { name: id } }), message: { id: `row-${id}`, sendId: `s-${id}` } })
describe('a file whose acceptance failed', () => {
	it('stays held and counted once however often it is tried, until it is accepted', async () => {
		const p = page()
		updateHeldFiles<{ id: string }>(EOA, PEER, () => [{ id: 'f1' }])
		p.broken.queue = true
		for (let i = 0; i < 2; i++) expect((await sendMediaJobs([fileJob('f1')], p.context())).notAccepted).toEqual(['f1'])
		expect([heldFiles(EOA, PEER).map((j) => j.id), heldFiles(EOA, OTHER), pendingCountOf(EOA)]).toEqual([['f1'], [], 1])
		updateHeldFiles<{ id: string }>(EOA, PEER, (list) => list.map((j) => ({ ...j }))) // a change of the draft is not its removal
		expect(pendingCountOf(EOA)).toBe(1)
		p.broken.queue = false
		expect((await sendMediaJobs([fileJob('f1')], p.context())).accepted).toEqual(['f1'])
		expect(pendingCountOf(EOA)).toBe(0)
		p.queue.dispose()
	})
	it('removing the draft ends its count, and only its own; a draft removed while it is being accepted does not end the count early', async () => {
		const p = page()
		updateHeldFiles<{ id: string }>(EOA, PEER, () => [{ id: 'f1' }, { id: 'f2' }])
		p.broken.queue = true
		await sendMediaJobs([fileJob('f1'), fileJob('f2')], p.context())
		updateHeldFiles<{ id: string }>(EOA, PEER, (list) => list.filter((j) => j.id !== 'f1'))
		expect(pendingCountOf(EOA)).toBe(1)
		const running = sendMediaJobs([fileJob('f2')], p.context()) // claimed and counted synchronously
		updateHeldFiles<{ id: string }>(EOA, PEER, () => [])
		expect(pendingCountOf(EOA)).toBe(1)
		await running
		p.queue.dispose()
	})
	it('the reload after the confirmed local reset drops the drafts together with their counts', async () => {
		const p = page()
		holdRecording(EOA, PEER, { recording: recordingOf(1), durationMs: 1 })
		updateHeldFiles<{ id: string }>(EOA, PEER, () => [{ id: 'f1' }])
		clearAllPendingSends()
		expect([heldVoice(EOA, PEER), heldFiles(EOA, PEER), pendingCountOf(EOA)]).toEqual([null, [], 0])
		p.queue.dispose()
	})
})

describe('the page keeps no draft of its own (source check only: the whole conversation page is not rendered in any test)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const src: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('recording and file drafts come from the holder, and the send goes through it', () => {
		expect(src).not.toMatch(/\[voiceDraftBlob,|useState<ChatFileJob\[\]>|setVoiceDraftBlob|setVoiceSending|\[voiceSending,/)
		expect(src).toContain('await sendHeldVoice<')
		expect(src).toContain('heldFiles<ChatFileJob>(draftWallet, draftPeer)')
		expect(src.match(/discardVoice\(/g)).toHaveLength(1)
		expect(src).toContain("		persistOutgoing: (id) => persistOutgoing(id),\n		markSendPersistFailed: (id) => markSendPersistFailed(id),\n		deliverTextRef,\n		releaseDraft,\n")
	})
})
