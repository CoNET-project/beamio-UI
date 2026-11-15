/**
 * @jest-environment node
 *
 * gossip-sign vectors, fourth version (sha 98834619; the third, 47c10521, is superseded), requests to, run through the real
 * signing path:
 * `nativeSignWithGeneration` (envelope and group) and `nativeSignGossip` (the delivery ack), with a fake shell that answers the hello
 * and the gossipSign command. The request objects are the ones the code builds; nothing here constructs a request by hand.
 *
 * (an envelope from an old page, without the field; the fourth version keeps `pageDeferAck` in the test context, not in the
 * request) is not tested: this page is a new page. Its init always declares `deferAck: true`, so the old-page rule of never applies
 * to it. (nothing announced) is refused here as native_unavailable, because the page never builds a request without a generation
 * the bad_request of the vector is the native layer's own check. The older-shell rules (a shell that does not declare the
 * capability): the rule that the request gets no field is tested in nativeSigning.test.ts; the old 30 s wait of the signing
 * path is tested at the end of this file. is not in this file.
 *
 * and (sendId): the signing request has an optional top-level `sendId`. This page never sends one, so the real request has no
 * sendId key at all; an empty sendId is therefore never built here (its refusal is the native layer's rule).
 * SYNTHETIC values only.
 */
import { nativeSignGossip, nativeSignWithGeneration, type GenerationSignDeps } from './nativeSigning'
import { INBOUND_GENERATION_CAPABILITY, recordInboundGenerationEvent, resetInboundGenerationForTests } from './inboundGeneration'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'

type Sent = Record<string, unknown> & { type?: string; reqId?: number }
type Win = EventTarget & { CashTreesIOS?: unknown }
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

const SIG = '0x' + 'ab'.repeat(65)
const ACK = JSON.stringify({ command: 'gossip_delivery_ack', walletAddress: '0x' + '33'.repeat(20), armorHash: '0x' + '44'.repeat(32), timestamp: 1700000000 })
const DECLARED = [NATIVE_KEYS_CAPABILITY, INBOUND_GENERATION_CAPABILITY]

let sent: Sent[] = []

/** A fake shell: hello declares `caps`; gossipSign is answered with a signature. Every command is recorded. */
function installShell(caps: string[]): void {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: caps } })
			if (cmd.type === 'gossipSign') send({ type: 'ack', ok: true, result: { signature: SIG }, reqId: cmd.reqId })
		},
	}
}

const gossipSigns = (): Sent[] => sent.filter((c) => c.type === 'gossipSign')

beforeEach(() => {
	resetInboundGenerationForTests()
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe('an envelope or group request carries inboundGeneration at the top level (real path)', () => {
	it('envelope: the request is exactly type, kind, message, reqId and inboundGeneration, with the announced value', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		await expect(nativeSignWithGeneration('envelope', () => 'hello')).resolves.toEqual({ ok: true, signature: SIG })
		const cmd = gossipSigns()[0]
		expect(Object.keys(cmd).sort()).toEqual(['inboundGeneration', 'kind', 'message', 'reqId', 'type'])
		expect(cmd).toMatchObject({ type: 'gossipSign', kind: 'envelope', message: 'hello', inboundGeneration: 5 })
	})

	it('group: the same shape for a group request', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 7 })
		await expect(nativeSignWithGeneration('group', () => 'hello')).resolves.toEqual({ ok: true, signature: SIG })
		expect(gossipSigns()[0]).toMatchObject({ kind: 'group', inboundGeneration: 7 })
	})
})

describe('no generation announced yet (real path)', () => {
	it('the envelope is refused as native_unavailable and no gossipSign is sent', async () => {
		installShell(DECLARED)
		await expect(nativeSignWithGeneration('envelope', () => 'hello')).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(gossipSigns()).toEqual([])
	})
})

describe('to: a wrong-typed generation is refused before anything is sent (real function, injected generation)', () => {
	it.each([
		['string', '2'],
		['negative', -1],
		['fraction', 2.5],
	])('%s: group with kind and message, bad_request, no send', async (_name, value) => {
		const send = jest.fn()
		const deps: GenerationSignDeps = { generation: () => value, send }
		await expect(nativeSignWithGeneration('group', () => 'hello', deps)).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(send).not.toHaveBeenCalled()
	})

	it('a wrong-typed event never becomes the held value, so the real path never sends it', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 3 })
		expect(recordInboundGenerationEvent({ type: 'inboundGeneration', generation: '9' as unknown as number })).toBe(false)
		expect(recordInboundGenerationEvent({ type: 'inboundGeneration', generation: -4 })).toBe(false)
		await nativeSignWithGeneration('envelope', () => 'hello')
		expect(gossipSigns()[0].inboundGeneration).toBe(3)
	})
})

describe('the delivery ack (gossip) carries no inboundGeneration (real path)', () => {
	it('nativeSignGossip sends only type, message and reqId, even with a generation announced', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		await expect(nativeSignGossip(ACK)).resolves.toEqual({ ok: true, signature: SIG })
		expect(Object.keys(gossipSigns()[0]).sort()).toEqual(['message', 'reqId', 'type'])
	})
})

describe('and: sendId (real path)', () => {
	it('the signing request has no sendId: this page never sends one, so none is built', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		await nativeSignWithGeneration('envelope', () => 'hello')
		expect(Object.keys(gossipSigns()[0])).not.toContain('sendId')
	})

	it('the same real request never carries an empty sendId; the refusal of an empty one is the native layer’s rule ', async () => {
		installShell(DECLARED)
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		await nativeSignWithGeneration('group', () => 'hello')
		const cmd = gossipSigns()[0]
		expect(cmd).not.toHaveProperty('sendId')
	})
})

describe('an older shell keeps its old wait: the signing path waits 30 s, one attempt', () => {
	it('no capability: no field, one attempt, and the wait is the old 30 s, not 35 s', async () => {
		jest.useFakeTimers()
		try {
			sent = []
			w.CashTreesIOS = {
				chatModuleCommand: (p: { command: Sent }) => {
					const cmd = p.command
					sent.push(cmd)
					if (cmd.type === 'hello') {
						setTimeout(
							() =>
								window.dispatchEvent(
									new CustomEvent('cashtreesios', {
										detail: { action: 'chatModuleEvent', event: { type: 'ready', reqId: cmd.reqId, result: { capabilities: [NATIVE_KEYS_CAPABILITY] } } },
									}),
								),
							0,
						)
					}
					// gossipSign is never answered: the older shell is silent.
				},
			}
			const outcome = nativeSignWithGeneration('envelope', () => 'hello')
			jest.advanceTimersByTime(1)
			for (let i = 0; i < 30; i += 1) await Promise.resolve()
			expect(gossipSigns()).toHaveLength(1)
			expect(Object.keys(gossipSigns()[0])).not.toContain('inboundGeneration')
			jest.advanceTimersByTime(29_999)
			for (let i = 0; i < 30; i += 1) await Promise.resolve()
			expect(gossipSigns()).toHaveLength(1)
			jest.advanceTimersByTime(1)
			await expect(outcome).resolves.toEqual({ ok: false, reason: 'timeout' })
			expect(gossipSigns()).toHaveLength(1)
		} finally {
			jest.useRealTimers()
		}
	})
})
