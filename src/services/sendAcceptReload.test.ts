/**
 * @jest-environment node
 */
// A reload at every storage step of a text send. The REAL draft store, queue store, send queue, accept step and restore; the page dies at the k-th storage operation (before it is applied, or right after). Invariant:
// once the input has been cleared, or a request has left, the message is still there after the reload; before that the input was never cleared and nothing was sent. Code level: no browser, synthetic values.
import { createChatDocStores } from './chatDocStores'
import { createDraftAutosaver } from './chatDraftStore'
import { createSendQueue, type QueueDocAdapter } from './sendQueue'
import { acceptOutgoingText, inputAfterAccept, loadQueueChecked, queueItemFromDraft, restoreOnMount, messagesForUnlisted, readConversationQueue } from './sendFlow'
import { conversationMediaContext, prepareVoiceAttempt, resetMediaClaimsForTest, sendMediaJobs, type MediaJob, type VoiceAttempt } from './chatMediaSend'
import { pendingCountOf, resetPendingSendsForTest } from './pendingSends'
import { bubbleRetryPlan, retryTapFor } from './failedRetry'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xbbbb000000000000000000000000000000000002'
const KEY = `0x${'33'.repeat(32)}`
const TEXT = 'synthetic message typed right before a reload'
const tick = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)) }
const never = () => new Promise<never>(() => undefined)

/** storage that stops at the k-th writing operation: `applied` says whether that operation itself reached the disk. After that the page is dead: nothing more is written. */
function disk(dieAt: number, applied: boolean) {
	const docs = new Map<string, string>()
	const state = { ops: 0, dead: false, log: [] as string[] }
	const write = async (label: string, fn: () => void) => {
		if (state.dead) return never()
		const at = state.ops++
		state.log.push(label)
		if (at === dieAt) { if (applied) fn(); state.dead = true; return never() }
		fn()
	}
	const doc: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: (id, text) => write(`put ${id.split(':')[0]}`, () => void docs.set(id, text)),
		remove: (id) => write(`remove ${id.split(':')[0]}`, () => void docs.delete(id)),
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort(),
	}
	const aliveAgain: QueueDocAdapter = { read: doc.read, list: doc.list, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id) }
	return { docs, state, doc, aliveAgain }
}

async function sendAndDie(dieAt: number, applied: boolean) {
	const d = disk(dieAt, applied)
	const page = { cleared: false, requests: 0, notSaved: 0, sendId: '' }
	const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.doc })!
	const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'awaiting', persisted: true }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	const autosaver = createDraftAutosaver({ store: stores.draftStore, peer: PEER, enqueue: (rec) => queue.enqueue(queueItemFromDraft(rec, PEER, 1), { inline: true }), setTimer: () => 0, clearTimer: () => undefined })
	void (async () => {
		const begun = await acceptOutgoingText({ autosaver, queueReady: true, currentText: TEXT, clearInput: () => { page.cleared = true }, onNotSaved: () => { page.notSaved += 1 } })
		if (!begun.ok || d.state.dead) return
		page.sendId = begun.sendId
		await queue.run(begun.sendId, async () => { if (!d.state.dead) page.requests += 1; return { kind: 'awaiting', persisted: true } }, { inline: true })
	})()
	await tick()
	queue.dispose()
	// the new page
	const again = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.aliveAgain })!
	const items = await again.queueStore.list()
	const restored = await restoreOnMount({ store: again.draftStore, peer: PEER, queueItems: items, stored: [] })
	const listed = messagesForUnlisted(items, [])
	return { page, items, restored, listed, steps: d.state.log, died: d.state.dead }
}

describe('a reload at every storage step of a text send', () => {
	it('never loses a message the page had accepted, never shows it twice, never sends before it is stored', async () => {
		const whole = await sendAndDie(Number.MAX_SAFE_INTEGER, false)
		expect(whole.page).toMatchObject({ cleared: true, requests: 1, notSaved: 0 })
		const total = whole.steps.length
		expect(total).toBeGreaterThanOrEqual(2)
		let acceptedKills = 0
		for (let k = 0; k < total; k++) {
			for (const applied of [false, true]) {
				const r = await sendAndDie(k, applied)
				const where = `die at step ${k} (${r.steps[k]}), ${applied ? 'after' : 'before'} it reached the disk`
				const queued = r.items.filter((i) => i.text === TEXT)
				const inInput = r.restored.inputText === TEXT
				expect([where, r.died]).toEqual([where, true])
				if (r.page.cleared || r.page.requests > 0) {
					acceptedKills += 1
					expect([where, queued.length, r.listed.length]).toEqual([where, 1, 1])
				}
				if (r.page.requests > 0) expect([where, queued[0]!.sendId]).toEqual([where, r.page.sendId])
				// never both back in the input and queued
				expect([where, inInput && queued.length > 0]).toEqual([where, false])
			}
		}
		expect(acceptedKills).toBeGreaterThan(0)
	})

	it('with no send queue (account or key not ready) nothing is accepted: the input is not cleared', async () => {
		for (const [autosaverMissing, queueReady] of [[true, true], [false, false], [true, false]] as const) {
			const d = disk(Number.MAX_SAFE_INTEGER, false)
			const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.doc })!
			const autosaver = createDraftAutosaver({ store: stores.draftStore, peer: PEER, enqueue: async () => ({ ok: true }), setTimer: () => 0, clearTimer: () => undefined })
			let cleared = false; let told = 0
			const r = await acceptOutgoingText({ autosaver: autosaverMissing ? null : autosaver, queueReady, currentText: TEXT, clearInput: () => { cleared = true }, onNotSaved: () => { told += 1 } })
			expect([r.ok, cleared, told]).toEqual([false, false, 1])
		}
	})

	it('the page accepts text only through that step, and clears the input nowhere else on the text path (source check)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		const from = src.indexOf('async function send() {')
		const body = src.slice(from, src.indexOf('const pendingMsg: ChatMessage = {', from))
		expect(body).toContain('const begun = await acceptOutgoingText({')
		expect(body.match(/clearChatInput\(\)/g)).toHaveLength(1)
		expect(body).toContain("if (rest === '') clearChatInput()")
		expect(body).toContain('if (!begun.ok) return')
		expect(body).not.toContain('setMessages(')
	})
})

/** one kill-able step that is not a document write (the account record, the request) */
type Row = { id: string; sendId: string }
type Page = { shown: boolean; draftHeld: boolean; recorded: boolean; requests: number }

/** the page's pieces as chat.tsx hands them to the controller it really calls (conversationMediaContext + sendMediaJobs); storage and transport are doubles on the same dying disk */
function mediaPage(d: ReturnType<typeof disk>, opts: { shown?: () => string; wallet?: string; deliverResult?: () => Promise<{ kind: 'awaiting'; persisted: boolean }> } = {}) {
	const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.doc })!
	const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'awaiting', persisted: true }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	const page: Page & { released: string[]; sentWires: string[]; list: Row[] } = { shown: false, draftHeld: true, recorded: false, requests: 0, released: [], sentWires: [], list: [] }
	const messagesRef = { current: [] as Row[] }
	const queueRef = { current: queue as typeof queue | null }
	const context = () => conversationMediaContext<Row>({
		wallet: opts.wallet ?? EOA, peer: PEER, queueRef, shownPeer: opts.shown ?? (() => PEER), messagesRef,
		applyMessages: (next) => { if (!d.state.dead) { messagesRef.current = next; page.list = next; page.shown = true } },
		persistOutgoing: () => d.doc.put('account-record:x', 'row').then(() => { page.recorded = true }),
		markSendPersistFailed: () => undefined,
		deliverTextRef: { current: async (_id, wire) => { await d.doc.put('network:x', 'request'); page.requests += 1; page.sentWires.push(wire); await d.doc.put('network:answer', 'answer'); return opts.deliverResult ? opts.deliverResult() : { kind: 'awaiting', persisted: true } } },
		releaseDraft: (jobId) => { if (!d.state.dead) { page.released.push(jobId); page.draftHeld = false } },
	})
	return { stores, queue, queueRef, page, context }
}
const jobOf = (id: string, kind: 'fileMessage' | 'voiceMessage'): MediaJob<Row> => ({ jobId: id, sendId: `s-${id}`, createdAt: 7, wire: JSON.stringify({ sendId: `s-${id}`, from: 'me', text: '', createdAt: 7, [kind]: { name: `synthetic-${id}` } }), message: { id: `row-${id}`, sendId: `s-${id}` } })
beforeEach(() => { resetMediaClaimsForTest(); resetPendingSendsForTest() })

async function sendFileAndDie(dieAt: number, applied: boolean, kind: 'fileMessage' | 'voiceMessage') {
	resetMediaClaimsForTest()
	const d = disk(dieAt, applied)
	const m = mediaPage(d)
	const job = jobOf('f-1', kind)
	void sendMediaJobs([job], m.context())
	await tick()
	m.queue.dispose()
	const again = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.aliveAgain })!
	const items = await again.queueStore.list()
	return { page: m.page, items, listed: messagesForUnlisted(items, []) as Array<Record<string, unknown>>, steps: d.state.log, died: d.state.dead, requestLeft: d.docs.has('network:x'), wire: job.wire }
}

describe('a reload at every step of a file or voice send (the controller the page calls)', () => {
	for (const kind of ['fileMessage', 'voiceMessage'] as const) {
		it(`${kind}: shown or sent only with the payload on disk, and the reload shows exactly that message with the same sendId and payload`, async () => {
			const whole = await sendFileAndDie(Number.MAX_SAFE_INTEGER, false, kind)
			expect([whole.page.shown, whole.page.draftHeld, whole.page.recorded, whole.page.requests]).toEqual([true, false, true, 1])
			expect(whole.steps.map((s) => s.split(' ')[1])).toEqual(['chat-queue-v1', 'account-record', 'network', 'network'])
			for (let k = 0; k < whole.steps.length; k++) {
				for (const applied of [false, true]) {
					const r = await sendFileAndDie(k, applied, kind)
					const where = `${kind}: die at step ${k} (${r.steps[k]}), ${applied ? 'applied' : 'not applied'}`
					if (r.page.shown || r.requestLeft) {
						expect([where, r.items.length, r.listed.length]).toEqual([where, 1, 1])
						expect([where, r.items[0]!.sendId, r.items[0]!.wire]).toEqual([where, 's-f-1', r.wire])
						expect([where, r.listed[0]!.sendId, r.listed[0]![kind]]).toEqual([where, 's-f-1', { name: 'synthetic-f-1' }])
					} else expect([where, r.page.draftHeld]).toEqual([where, true])
					// the request never leaves before the payload and the account record are on disk
					if (r.requestLeft) expect([where, r.page.recorded]).toEqual([where, true])
				}
			}
		})
	}
	it('a queue that is not ready or cannot write: not accepted, the draft is kept, nothing shown or sent, and the job can be tried again', async () => {
		for (const broken of ['null', 'quota'] as const) {
			resetMediaClaimsForTest()
			const d = disk(Number.MAX_SAFE_INTEGER, false)
			const m = mediaPage({ ...d, doc: broken === 'quota' ? { ...d.doc, put: async () => { throw new Error('quota') } } : d.doc })
			if (broken === 'null') m.queueRef.current = null
			const r = await sendMediaJobs([jobOf('f-2', 'fileMessage')], m.context())
			expect([r.accepted, r.notAccepted, m.page.shown, m.page.released, m.page.requests]).toEqual([[], ['f-2'], false, [], 0])
			const again = await sendMediaJobs([jobOf('f-2', 'fileMessage')], m.context())
			expect(again.skipped).toEqual([])
			m.queue.dispose()
		}
	})
	it('an account record that cannot be written: accepted and kept in the queue, but nothing leaves', async () => {
		const d = disk(Number.MAX_SAFE_INTEGER, false)
		const m = mediaPage({ ...d, doc: { ...d.doc, put: async (id, text) => { if (id.startsWith('account-record')) throw new Error('disk'); return d.doc.put(id, text) } } })
		const r = await sendMediaJobs([jobOf('f-3', 'voiceMessage')], m.context())
		expect([r.accepted, m.page.shown, m.page.requests]).toEqual([['f-3'], true, 0])
		expect((await m.stores.queueStore.list()).map((i) => i.sendId)).toEqual(['s-f-3'])
		m.queue.dispose()
	})
})

describe('several files and repeated taps (duplicate delivery)', () => {
	it('every job is claimed and counted at the click and all are on disk before the first delivery ends; a second tap sends nothing', async () => {
		const d = disk(Number.MAX_SAFE_INTEGER, false)
		let release!: () => void
		const first = new Promise<void>((r) => { release = r })
		let deliveries = 0
		const m = mediaPage(d, { deliverResult: async () => { if (deliveries++ === 0) await first; return { kind: 'awaiting', persisted: true } } })
		const jobs = ['a', 'b', 'c'].map((id) => jobOf(id, 'fileMessage'))
		const one = sendMediaJobs(jobs, m.context())
		expect(pendingCountOf(EOA)).toBe(3) // synchronously
		// taps before anything has landed: the same drafts, with the NEW sendIds a fresh click would make
		const secondTap = () => sendMediaJobs(jobs.map((j) => ({ ...j, sendId: `${j.sendId}-again`, wire: j.wire.replace(j.sendId, `${j.sendId}-again`) })), m.context())
		expect((await secondTap()).skipped).toEqual(['a', 'b', 'c'])
		await tick()
		expect((await m.stores.queueStore.list()).map((i) => i.sendId).sort()).toEqual(['s-a', 's-b', 's-c'])
		expect(m.page.released).toEqual(['a', 'b', 'c'])
		expect(m.page.requests).toBe(1) // the first delivery is still running
		expect((await secondTap()).skipped).toEqual(['a', 'b', 'c'])
		release()
		await one
		expect(m.page.sentWires.map((w) => (JSON.parse(w) as { sendId: string }).sendId)).toEqual(['s-a', 's-b', 's-c'])
		expect(pendingCountOf(EOA)).toBe(0)
		m.queue.dispose()
	})
	it('the conversation changes before a job is accepted: it is not accepted and nothing appears in the other conversation; a queue refuses another conversation\'s item', async () => {
		const d = disk(Number.MAX_SAFE_INTEGER, false)
		let shown = PEER
		const m = mediaPage(d, { shown: () => shown })
		const context = m.context()
		shown = '0xcccc000000000000000000000000000000000003'
		const r = await sendMediaJobs([jobOf('x', 'fileMessage')], context)
		expect([r.accepted, r.notAccepted, m.page.shown, m.page.requests]).toEqual([[], ['x'], false, 0])
		expect(await m.stores.queueStore.list()).toEqual([])
		const refused = await m.queue.enqueue({ v: 1, sendId: 'z', peer: shown, text: 'synthetic', createdAt: 1, queuedAt: 1 }, { inline: true })
		expect(refused.ok).toBe(false)
		expect(await m.stores.queueStore.list()).toEqual([])
		m.queue.dispose()
	})
	it('changed after acceptance: kept in its own queue, not shown or delivered from the other conversation', async () => {
		const d = disk(Number.MAX_SAFE_INTEGER, false)
		let calls = 0
		const m = mediaPage(d, { shown: () => (calls++ < 1 ? PEER : '0xcccc000000000000000000000000000000000003') })
		const r = await sendMediaJobs([jobOf('y', 'fileMessage')], m.context())
		expect([r.accepted, m.page.shown, m.page.requests]).toEqual([['y'], false, 0])
		expect((await m.stores.queueStore.list()).map((i) => i.sendId)).toEqual(['s-y'])
		m.queue.dispose()
	})
})

describe('a recording that failed is retried as the SAME message', () => {
	it('after an upload failure and after a refused acceptance: same sendId, same sealed bytes, sealed once; a new recording or another conversation is a new message', async () => {
		const holder: { current: VoiceAttempt<string> | null } = { current: null }
		const recording = {}
		let sealed = 0; let ids = 0; let failUpload = true
		const run = (what: object, peer = PEER) => prepareVoiceAttempt<string>(holder, { recording: what, peer, newSendId: () => `voice-${++ids}`, now: () => 100 + ids, seal: async () => `sealed-${++sealed}`, upload: async (s) => { if (failUpload) throw new Error('offline'); return `hash-of-${s}` } })
		await expect(run(recording)).rejects.toThrow('offline')
		failUpload = false
		const a = await run(recording)
		const b = await run(recording)
		expect([a.sendId, a.sealed, a.fragmentHash, b.sendId, b.createdAt, sealed]).toEqual(['voice-1', 'sealed-1', 'hash-of-sealed-1', 'voice-1', a.createdAt, 1])
		expect((await run({})).sendId).toBe('voice-2')
		expect((await run(recording, '0xcccc000000000000000000000000000000000003')).sendId).toBe('voice-3')
	})
})

describe('a tap on a failed file or voice bubble', () => {
	it('sends the stored payload again; without it the bubble is kept as it is (never removed or made text); the handler acts on failed bubbles only', () => {
		for (const media of [{ fileMessage: {} }, { voiceMessage: {} }]) {
			const m = { from: 'me' as const, text: '', sendId: 's', createdAt: 1, status: 'failed', ...media }
			expect(bubbleRetryPlan(m, 'stored-payload')).toEqual({ kind: 'resend', wire: 'stored-payload' })
			expect(bubbleRetryPlan(m, undefined)).toEqual({ kind: 'keep' })
		}
		const tapped: string[] = []
		retryTapFor({ status: 'failed', id: '1' }, (m) => tapped.push(m.id))()
		retryTapFor({ status: 'sent', id: '2' }, (m) => tapped.push(m.id))()
		expect(tapped).toEqual(['1'])
	})
})

describe('an illustration only, NOT evidence: a hand-written model of an order that stores last', () => {
	/** an order that shows and requests before anything is stored */
	async function oldOrder(dieAt: number) {
		const d = disk(dieAt, false)
		const page = { accepted: false }
		void (async () => { page.accepted = true; await d.doc.put('network:x', 'request'); await d.doc.put('account-record:x', TEXT) })()
		await tick()
		return { page, kept: d.docs.has('account-record:x') }
	}
	it('with that order, a reload before the first or the second write leaves nothing stored', async () => {
		for (const k of [0, 1]) { const r = await oldOrder(k); expect([k, r.page.accepted, r.kept]).toEqual([k, true, false]) }
	})
})

describe('what was typed while the message was being written stays', () => {
	it('inputAfterAccept', () => {
		expect(inputAfterAccept('hello', 'hello')).toBe('')
		expect(inputAfterAccept('  hello  ', 'hello')).toBe('')
		expect(inputAfterAccept('hello and more', 'hello')).toBe('and more')
		expect(inputAfterAccept('hello\nnext', 'hello')).toBe('next')
		expect(inputAfterAccept('something else entirely', 'hello')).toBeNull()
		expect(inputAfterAccept('say hello', 'hello')).toBeNull()
		expect(inputAfterAccept('', 'hello')).toBeNull()
	})
})

describe('a queue that cannot be read after a reload is not an empty queue', () => {
	const build = async (doc: QueueDocAdapter) => {
		const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc })!
		const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
		const r = await loadQueueChecked(queue, stores.queueStore)
		queue.dispose()
		return r
	}
	it('a read failure and a record that does not open are both reported; a damaged record stays on disk; a healthy queue reports nothing', async () => {
		const d = disk(Number.MAX_SAFE_INTEGER, false)
		const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc: d.doc })!
		await stores.queueStore.put({ v: 1, sendId: 'ok-1', peer: PEER, text: 'synthetic', createdAt: 1, queuedAt: 1 })
		expect((await build(d.doc)).problem).toBeNull()
		const bad = `chat-queue-v1:${EOA}:broken`
		d.docs.set(bad, 'not a sealed record')
		const damaged = await build(d.doc)
		expect([damaged.problem, damaged.unreadable, damaged.items.map((i) => i.sendId)]).toEqual(['unreadable', 1, ['ok-1']])
		expect(d.docs.get(bad)).toBe('not a sealed record')
		expect((await build({ ...d.doc, list: async () => { throw new Error('idb') } })).problem).toBe('load_failed')
		expect((await build({ ...d.doc, read: async () => { throw new Error('idb') } })).problem).toBe('load_failed')
	})
})

describe('what the restore does with the queue problem', () => {
	it('hands a real problem to the notice, reads again before believing it, and stays quiet when healthy', async () => {
		const shown: Array<string | null> = []
		const run = (results: Array<{ raw: string[]; list: string[] }>) => { let i = 0; return readConversationQueue({ load: async () => [] }, { rawSendIds: async () => results[Math.min(i, results.length - 1)]!.raw, list: async () => { const r = results[Math.min(i++, results.length - 1)]!; return r.list.map((sendId) => ({ sendId }) as never) } }, (p) => shown.push(p), () => true) }
		await run([{ raw: ['a', 'bad'], list: ['a'] }])
		await run([{ raw: ['a', 'new'], list: ['a'] }, { raw: ['a', 'new'], list: ['a', 'new'] }]) // added between the two steps
		await run([{ raw: ['a'], list: ['a'] }])
		expect(shown).toEqual(['unreadable', null, null])
		await readConversationQueue({ load: async () => { throw new Error('idb') } }, { rawSendIds: async () => [], list: async () => [] }, (p) => shown.push(p), () => true)
		expect(shown[3]).toBe('load_failed')
	})
})

describe('the page uses these steps (source check)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const src: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	const bodyOf = (start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)))
	it('files and voice go through the controller and never send or show on their own; every own media bubble has the retry handler', () => {
		for (const [body, controller] of [[bodyOf('const sendFileDrafts = useCallback', '}, [allNodes, chatData, fileJobs, privateKey])'), 'await sendMediaJobs('], [bodyOf('const sendVoiceDraft = useCallback', "'Voice message could not be sent.'"), 'await sendHeldVoice<']] as const) {
			expect(body).toContain(controller)
			expect(body).not.toContain('sendChatToRecipient(')
			expect(body).not.toContain('setMessages(')
		}
		expect(src).toContain('conversationMediaContext<ChatMessage>({')
		expect(src).toContain('persistOutgoing: (id) => persistOutgoing(id),')
		expect(src.match(/onRetry=\{retryTapFor\(m, retryFailedSend\)\}/g)).toHaveLength(2)
		expect(src).not.toContain('Please record and send the voice message again.')
	})
	it('retry and resume use the stored payload; the queue is read with the check and the problem is shown with a retry', () => {
		expect(src).toContain('const plan = bubbleRetryPlan(m, m.sendId ? sendQueueRef.current?.wireOf(m.sendId) : undefined)')
		expect(src).toContain('const wire = item.wire ?? heldWireFromMessage(m)')
		expect(src).toContain('await readConversationQueue(queue, queueStore, setQueueProblem, () => !cancelled)')
		expect(src).toContain('data-testid="send-queue-problem"')
		expect(src).toContain('const rest = inputAfterAccept(inputRef.current?.value ?? t, t)')
	})
})
