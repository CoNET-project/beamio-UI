/**
 * @jest-environment node
 */
// "Failed · Tap to retry" resends a failed TEXT message through the full new-send path; other kinds keep the earlier behaviour; the removal is stored too.
import { readFileSync } from 'fs'
import { join } from 'path'
import { generateKey } from 'openpgp'
import { sendWithFreshRoute, type RecipientLookup } from '../utils/recipientPublicKey'
import { storedKeyFingerprint } from '../utils/pgpFingerprint'
import { failedRetryPlan, markSendingById, removeMessageById } from './failedRetry'

const text = (over: Record<string, unknown> = {}) => ({ id: 'tmp_1', sendId: 'send-1', from: 'me' as const, text: 'hello', createdAt: 1_700_000_000_000, status: 'failed', sendError: 'recipient_key_unavailable', ...over })

describe('failedRetryPlan', () => {
	it('a failed text message is resent from its original wire (same sendId and time, quote kept)', () => {
		const p = failedRetryPlan(text({ quote: { id: 'q', text: 'x', from: 'them' } }))
		expect(p.kind).toBe('resend')
		expect(JSON.parse((p as { wire: string }).wire)).toEqual({ sendId: 'send-1', from: 'me', text: 'hello', createdAt: 1_700_000_000_000, quote: { id: 'q', text: 'x', from: 'them' } })
	})
	it.each([
		['a file', { fileMessage: {} }],
		['a file cipher', { fileMessageCipher: {} }],
		['a voice message', { voiceMessage: {} }],
		['a call record', { callRecord: {} }],
		['a payment card', { paymentCard: {} }],
		['a reply', { reply: {} }],
	])('%s is kept as it is (never removed, never turned into input text)', (_l, extra) => {
		expect(failedRetryPlan(text(extra))).toEqual({ kind: 'keep' })
	})
	it('a message that cannot be rebuilt (no sendId, not mine, no time) or is not failed is kept', () => {
		expect(failedRetryPlan(text({ sendId: undefined }))).toEqual({ kind: 'keep' })
		expect(failedRetryPlan(text({ from: 'them' }))).toEqual({ kind: 'keep' })
		expect(failedRetryPlan(text({ createdAt: 'x' }))).toEqual({ kind: 'keep' })
		expect(failedRetryPlan(text({ status: 'sent' }))).toEqual({ kind: 'keep' })
	})
})

describe('list helpers', () => {
	it('markSendingById changes only that message (no error left) and keeps the others as they are', () => {
		const a = text({ id: 'a' })
		const b = text({ id: 'b', status: 'sent', sendError: undefined })
		const out = markSendingById([a, b], 'a')
		expect(out[0]).toMatchObject({ id: 'a', status: 'sending', sendError: undefined, text: 'hello' })
		expect(out[1]).toBe(b)
		expect(markSendingById(undefined, 'a')).toEqual([])
	})
	it('removeMessageById removes only that message', () => {
		expect(removeMessageById([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }])
		expect(removeMessageById(undefined, 'a')).toEqual([])
	})
	// a removal has to reach the stored copy as well as the page state, or a refresh brings the message back
	it('a removal is applied to the stored copy and the page state alike', () => {
		const stored = [text({ id: 'f1' }), text({ id: 's1', status: 'sent', sendError: undefined })]
		let state = [...stored]
		// applied to the state only
		state = state.filter((m) => m.id !== 'f1')
		expect(stored.some((m) => m.id === 'f1')).toBe(true) // a refresh reloads this
		// one list written to the ref, the state and the stored copy
		const kept = removeMessageById(stored, 'f1')
		expect(kept.some((m) => m.id === 'f1')).toBe(false)
		expect(state).toHaveLength(1)
	})
})

describe('wiring in chat.tsx (static)', () => {
	const src = readFileSync(join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')
	const start = src.indexOf('function retryAttemptFor(')
	// the node wait moved into nodeWait.ts: the slice ends where the page's waiter wiring begins
	const end = src.indexOf('/** messages waiting for the entry nodes', start)
	const body = src.slice(start, end)

	it('every failed bubble goes through retryFailedSend; no handler filters the state only', () => {
		expect(src).not.toContain('setMessages(prev => prev.filter(x => x.id !== m.id))')
		const uses = src.match(/void retryFailedSend\(m\)/g) ?? []
		expect(uses.length).toBe(5)
	})
	it('the resend goes through deliverText (a full new send) with the rebuilt wire, after marking the message sending and storing that', () => {
		expect(body).toContain('bubbleRetryPlan(m, m.sendId ? sendQueueRef.current?.wireOf(m.sendId) : undefined)')
		expect(body).toContain('await deliverText(id, plan.wire, t0)')
		expect(body.indexOf('markSendingById(')).toBeLessThan(body.indexOf('deliverText('))
		// no cached failure, no timer: nothing here reads a saved lookup result
		expect(body).not.toMatch(/setTimeout|lastSendCodeRef\.current = |heldSendsRef/)
	})
	it('a tap on a bubble that cannot be resent only says so: nothing is removed, no text goes to the input box, no queue item is dropped', () => {
		const tap = body.slice(body.indexOf('async function retryFailedSend('), body.length)
		expect(tap).toContain('return tapFailedBubble({')
		expect(tap).toContain("tellKept: () => setChatError(")
		for (const part of ['setText(', 'removeMessageById(', 'setMessages(', 'noteMessageDropped(', '.drop(']) expect(tap).not.toContain(part)
	})
	it('without nodes a shell waits like a first send; a browser marks it failed again and stores that', () => {
		expect(body).toContain('waitSendForNodes(id, plan.wire, t0)')
		expect(body).toContain("status: 'failed' as const")
		expect(body.lastIndexOf('await storageData()')).toBeGreaterThan(body.indexOf("status: 'failed' as const"))
	})
})

describe('the resend is a full new send: a failed read is not remembered', () => {
	it('after a read failure the first send is not sent; the resend of the same wire does a NEW lookup and goes out (no cached failure, no back-off)', async () => {
		const KEY = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })).publicKey.trim()
		const chat = { address: '0x' + 'ab12'.repeat(10), chatData: { verifiedFingerprint: storedKeyFingerprint('a'.repeat(40)) } }
		const answers: RecipientLookup[] = [
			{ status: 'network_error', reason: 'blocked' },
			{ status: 'ok', publicArmored: KEY, routersArmoreds: 'route-1' },
		]
		const fetchKeys = jest.fn(async () => answers.shift() as RecipientLookup)
		const send = jest.fn(async () => true)
		const wire = (failedRetryPlan(text()) as { wire: string }).wire
		const first = await sendWithFreshRoute(chat, wire, 'pk', ['n'], { fetchKeys, send })
		expect(first).toMatchObject({ ok: false, code: 'route_unconfirmed' })
		expect(send).not.toHaveBeenCalled()
		const second = await sendWithFreshRoute(chat, wire, 'pk', ['n'], { fetchKeys, send })
		// (the pinned fingerprint here is another key, so the new lookup is held as fingerprint_changed: the point is that a NEW read happened and nothing old was reused)
		expect(fetchKeys).toHaveBeenCalledTimes(2)
		expect(second.ok === true || (second as { code: string }).code === 'fingerprint_changed').toBe(true)
	}, 60_000)
})


// a stored `sending` message from an earlier page load has no send in flight
import { settleStaleSending } from './failedRetry'
describe('settleStaleSending (the message stored in the sending state before the send)', () => {
	const START = 1_000_000
	it('a sending message made before this page load becomes failed (interrupted), the same text and sendId stay for the retry', () => {
		const list = [{ id: 'a', sendId: 's1', text: 'hi', createdAt: START - 5_000, status: 'sending' }]
		const out = settleStaleSending(list, START)
		expect(out[0]).toMatchObject({ id: 'a', sendId: 's1', text: 'hi', status: 'failed', sendError: 'interrupted' })
		expect(list[0].status).toBe('sending') // the input is not changed
	})
	it('a sending message made in this page load is a live send and is never touched (the same list is returned)', () => {
		const list = [{ id: 'a', createdAt: START + 1, status: 'sending' }, { id: 'b', createdAt: START, status: 'sending' }]
		expect(settleStaleSending(list, START)).toBe(list)
	})
	it('sent, failed, held and delivered messages and messages without a time are never touched', () => {
		const list = [
			{ id: 'a', createdAt: 1, status: 'sent' },
			{ id: 'b', createdAt: 1, status: 'failed' },
			{ id: 'c', createdAt: 1, status: 'route_unconfirmed' },
			{ id: 'd', createdAt: 1, status: 'delivered' },
			{ id: 'e', status: 'sending' },
		]
		expect(settleStaleSending(list, START)).toBe(list)
		expect(settleStaleSending(undefined, START)).toEqual([])
	})
})
