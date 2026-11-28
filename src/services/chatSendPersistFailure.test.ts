/**
 * @jest-environment node
 */
// inject a durable-write failure into the send. Three assertions each time:
//  (a) nothing leaves the device (no /post, no storageFragment);
//  (b) the message is in a recoverable failed state with Retry; after a successful write, Retry sends it, and the other side gets ONE copy;
//  (c) during the write and after the failure no controlled refresh overwrites what is not saved, and the lock is not held for good.
// Mutation: restore `.catch(() => undefined)` around the wait (chat.tsx / outgoingSend.ts) and these tests fail. SYNTHETIC.
import { createOutgoingPersister, sendWithRecord, retryWithRecord, awaitRecord } from './outgoingSend'
import { durableCommitError, type DurableCommit } from './durableCommit'
import { isChatWriting, deferWhileWriting, chatWriteVersion, readIsStale, requestControlledReload, hasUnsavedMessages, resetChatWriteLockForTest } from './chatWriteLock'
import { failedRetryPlan, markSendingById, settleStaleSending } from './failedRetry'

beforeEach(() => resetChatWriteLockForTest())

/** The page's message list and the network, as the send path sees them. */
function world(commitResults: DurableCommit[], order: string[] = []) {
	const network: string[] = [] // every request that left the device (/post, storageFragment)
	const disk: Array<{ id: string; status: string }>[] = []
	let list: Array<{ id: string; sendId: string; text: string; createdAt: number; status: string; sendError?: string; from: 'me' }> = []
	let shown = list
	const results = [...commitResults]
	const persist = createOutgoingPersister(async () => {
		const failure = durableCommitError(results.shift() ?? 'committed')
		if (failure) throw failure
		disk.push(list.map((m) => ({ id: m.id, status: m.status })))
		order.push('disk') // the record has landed (inside the write, before the lock and the held reload are touched)
	})
	const msg = { id: 'tmp_1', sendId: 'send-uuid-1', text: 'hello', createdAt: 1_000, status: 'sending', from: 'me' as const }
	const insert = () => {
		list = [...list, msg]
		shown = list
	}
	const markFailed = () => {
		list = list.map((m) => (m.id === msg.id ? { ...m, status: 'failed', sendError: 'persist_failed' } : m))
		shown = list
	}
	const deliver = async () => {
		network.push('POST /post', 'POST storageFragment')
	}
	return { network, disk, persist, insert, markFailed, deliver, list: () => list, shown: () => shown }
}

describe.each<DurableCommit>(['gate_closed', 'no_record', 'write_failed'])('the durable write fails (%s)', (failure) => {
	it('(a) nothing is sent: no /post and no storageFragment', async () => {
		const w = world([failure])
		w.insert()
		const outcome = await sendWithRecord({ record: w.persist('tmp_1'), deliver: w.deliver, onPersistFailed: w.markFailed })
		expect(outcome).toBe('persist_failed')
		expect(w.network).toEqual([])
	})

	it('(b) the message is recoverable and failed with Retry; after a good write Retry sends it, and the other side gets ONE copy', async () => {
		const w = world([failure, 'committed'])
		w.insert()
		await sendWithRecord({ record: w.persist('tmp_1'), deliver: w.deliver, onPersistFailed: w.markFailed })
		const failed = w.list()[0]
		expect(failed).toMatchObject({ status: 'failed', sendError: 'persist_failed', sendId: 'send-uuid-1', text: 'hello' })
		const plan = failedRetryPlan(failed)
		expect(plan.kind).toBe('resend')
		// Retry: the same sendId goes out again, after its record is written
		const wire = (plan as { kind: 'resend'; wire: string }).wire
		expect(JSON.parse(wire).sendId).toBe('send-uuid-1')
		const retried = markSendingById(w.list(), 'tmp_1', 2_000)
		expect(retried[0].status).toBe('sending')
		const outcome = await sendWithRecord({ record: w.persist('tmp_1'), deliver: async () => { w.network.push(wire) }, onPersistFailed: w.markFailed })
		expect(outcome).toBe('sent')
		// the receiver keeps one copy per sendId
		const receiver = new Map<string, string>()
		for (const sent of w.network) receiver.set(JSON.parse(sent).sendId, JSON.parse(sent).text)
		expect(receiver.size).toBe(1)
		expect(w.network).toHaveLength(1)
	})

	it('(c) the interactive state unlocks (not locked for good), an in-app refresh asked during the write runs once afterwards without replacing the unsaved message, and an older read is dropped', async () => {
		const w = world([failure])
		w.insert()
		const readVersion = chatWriteVersion()
		const refresh = jest.fn()
		const record = w.persist('tmp_1')
		expect(isChatWriting()).toBe(true) // the lock is held from the change of the list until the commit
		deferWhileWriting('chat-reflash', refresh)
		deferWhileWriting('chat-reflash', refresh)
		expect(refresh).not.toHaveBeenCalled()
		expect(readIsStale(readVersion)).toBe(true) // a read that began before this write must not replace it
		await sendWithRecord({ record, deliver: w.deliver, onPersistFailed: w.markFailed })
		expect(isChatWriting()).toBe(false) // unlocked: the user can tap Retry
		expect(refresh).toHaveBeenCalledTimes(1) // the harmless re-read only reads and merges, and the temp message is kept
		// the unsaved message is still in the page list (failed, recoverable): a stored copy that lacks it must not be shown over it
		expect(w.shown().map((m) => m.id)).toEqual(['tmp_1'])
	})

	it('after a reload the stored `sending` record is failed + Retry with the same sendId (no blind resend)', () => {
		const stored = [{ id: 'tmp_1', sendId: 'send-uuid-1', text: 'hello', createdAt: 1_000, status: 'sending', from: 'me' as const }]
		const settled = settleStaleSending(stored, 5_000)
		expect(settled[0]).toMatchObject({ status: 'failed', sendError: 'interrupted', sendId: 'send-uuid-1' })
		expect(failedRetryPlan(settled[0]).kind).toBe('resend')
	})
})

describe('a good write: the message goes out once, after its record', () => {
	it('the record is written first, then the request; the lock is released', async () => {
		const w = world(['committed'])
		w.insert()
		const order: string[] = []
		const outcome = await sendWithRecord({ record: w.persist().then(() => { order.push('record') }), deliver: async () => { order.push('request'); await w.deliver() }, onPersistFailed: w.markFailed })
		expect(outcome).toBe('sent')
		expect(order).toEqual(['record', 'request'])
		expect(w.disk).toHaveLength(1)
		expect(isChatWriting()).toBe(false)
	})
})

describe('awaitRecord never turns a rejected write into success (mutation guard)', () => {
	it('a rejected record is persist_failed', async () => {
		expect(await awaitRecord(Promise.reject(new Error('x')))).toBe('persist_failed')
		expect(await awaitRecord(Promise.resolve())).toBe('recorded')
	})
	it('chat.tsx and outgoingSend.ts do not swallow the write (static): restoring `.catch(() => undefined)` around the wait fails this test', () => {
		const fs = require('fs')
		const path = require('path')
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		const mod = fs.readFileSync(path.join(__dirname, 'outgoingSend.ts'), 'utf8')
		expect(chat).not.toMatch(/storedSendingRef\.current[^\n]*\.catch\(\(\) => undefined\)/)
		expect(chat).toMatch(/await sendWithRecord\(\{\s*record: storedSendingRef\.current,/)
		expect(chat).toMatch(/await retryWithRecord\(\{[\s\S]*?persist: \(\) => persistOutgoing\(id\),/)
		const awaitFn = mod.slice(mod.indexOf('export async function awaitRecord'), mod.indexOf('/** `write` performs'))
		expect(awaitFn).toMatch(/catch \{\s*return 'persist_failed'/)
	})
})

describe('the whole chain through the real entries (send and retry): failure, a destructive reload queued first, Retry, exactly one reload after the record', () => {
	it('inject one failure; queue a controlled reload during the write; nothing is sent, the reload is held, the UI is unlocked, the message is failed with Retry; Retry writes and sends; both sides have one copy; the reload runs once, after the disk write', async () => {
		const order: string[] = []
		const w = world(['write_failed', 'committed'], order)
		const reload = jest.fn(() => { order.push('reload') })
		w.insert()
		// 1) first send: the record write fails; 2) a destructive reload is asked while it is being written
		const first = sendWithRecord({ record: w.persist('tmp_1'), deliver: w.deliver, onPersistFailed: w.markFailed })
		requestControlledReload(reload)
		expect(reload).not.toHaveBeenCalled()
		await first
		// 3) nothing was sent, the reload did not run, the UI is unlocked, the message is failed and can be retried
		expect(w.network).toEqual([])
		expect(reload).not.toHaveBeenCalled()
		expect(hasUnsavedMessages()).toBe(true)
		expect(isChatWriting()).toBe(false)
		const failed = w.list()[0]
		expect(failed).toMatchObject({ status: 'failed', sendError: 'persist_failed' })
		const plan = failedRetryPlan(failed)
		expect(plan.kind).toBe('resend')
		const wire = (plan as { kind: 'resend'; wire: string }).wire
		// 4) Retry (the real retry entry): the write succeeds this time
		const outcome = await retryWithRecord({
			markSending: () => undefined,
			persist: () => w.persist('tmp_1'),
			deliver: async () => { order.push('send'); w.network.push(wire) },
			onPersistFailed: w.markFailed,
		})
		// 5) sent after the record; both sides have one copy; the held reload ran exactly once, after the disk write
		expect(outcome).toBe('sent')
		expect(w.network).toHaveLength(1)
		const receiver = new Map<string, string>()
		for (const sent of w.network) receiver.set(JSON.parse(sent).sendId, JSON.parse(sent).text)
		expect(receiver.size).toBe(1)
		expect(w.list().filter((m) => m.sendId === 'send-uuid-1')).toHaveLength(1)
		expect(reload).toHaveBeenCalledTimes(1)
		expect(order.indexOf('disk')).toBeLessThan(order.indexOf('reload'))
		expect(hasUnsavedMessages()).toBe(false)
		expect(isChatWriting()).toBe(false)
	})
})

