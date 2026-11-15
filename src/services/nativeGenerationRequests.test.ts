/**
 * @jest-environment node
 *
 * 1: the chat transport's send, group text and mailbox commands carry `inboundGeneration`at the top level,
 * the value last announced by the native layer. Nothing is sent before an announcement. A silent request is resent once after 30 s
 * when the generation has not moved, and is abandoned when it has. `send_timeout` is an answer and is not resent.
 * Node environment, as the other transport tests. SYNTHETIC values; the shell is a fake.
 */
import { createNativeConetChatClient } from './nativeConetChatTransport'
import { recordInboundGenerationEvent, resetInboundGenerationForTests } from './inboundGeneration'

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

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const TO = {} as never
const GEN_TYPES = new Set(['send', 'sendGroup', 'mailboxCommand', 'ownMailboxCommand', 'issueGroupRoster', 'issueGroupTombstone'])

let sent: Sent[] = []
/** How the fake shell answers a generation-tagged command: `ack` at once, `send_timeout` as a refusal, or `silent` (no answer). */
let mode: 'ack' | 'silent' | 'send_timeout' = 'ack'

/** The capabilities a current shell declares in hello. An older shell lacks inbound.generation.v1. */
const DECLARED = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck', 'inbound.generation.v1']

function installShell(caps: string[] = DECLARED): void {
	sent = []
	mode = 'ack'
	w.CashTreesIOS = {
		chatModuleCommand: (p: { action: string; command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const reply = (event: Record<string, unknown>) =>
				setTimeout(() => {
					window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } }))
				}, 0)
			if (cmd.type === 'hello') {
				reply({ type: 'ready', reqId: cmd.reqId, result: { protocolVersion: 1, capabilities: caps } })
			} else if (cmd.type === 'init') {
				reply({ type: 'ready', reqId: cmd.reqId, result: { historyApi: 0 } })
			} else if (GEN_TYPES.has(String(cmd.type))) {
				if (mode === 'ack') reply({ type: 'ack', reqId: cmd.reqId, ok: true, result: cmd.type === 'send' ? { sent: true } : {} })
				if (mode === 'send_timeout') reply({ type: 'ack', reqId: cmd.reqId, ok: false, error: 'send_timeout' })
			}
		},
	}
}

function config() {
	return {
		identity: { eoaAddress: EOA, pgpPublicKeyArmored: '', ownRouteArmoredPublicKey: '' },
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never,
		ipfsBaseUrl: 'https://ipfs.invalid',
		apiBaseUrl: 'https://api.invalid',
		chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	} as unknown as Parameters<typeof createNativeConetChatClient>[0]
}

/** Lets pending promise continuations run (fake timers do not move them). */
async function flush(): Promise<void> {
	for (let i = 0; i < 25; i += 1) await Promise.resolve()
}

async function startClient(caps: string[] = DECLARED) {
	installShell(caps)
	const client = createNativeConetChatClient(config())
	await client.init()
	sent = []
	return client
}

const countOf = (type: string) => sent.filter((c) => c.type === type).length

beforeEach(() => {
	resetInboundGenerationForTests()
})
afterEach(() => {
	jest.useRealTimers()
	delete w.CashTreesIOS
})

describe('send, group text and mailbox commands carry inboundGeneration (1)', () => {
	it('nothing is sent before a generation has been announced; send rejects with native_unavailable', async () => {
		const client = await startClient()
		await expect(client.sendMessage(TO, 'hi', { sendId: 's1' })).rejects.toThrow('native_unavailable')
		expect(countOf('send')).toBe(0)
	})

	it('send carries the held generation at the top level and resolves with its sendId', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		await expect(client.sendMessage(TO, 'hi', { sendId: 's2' })).resolves.toEqual({ sendId: 's2' })
		const cmd = sent.find((c) => c.type === 'send')
		expect(cmd).toMatchObject({ type: 'send', sendId: 's2', inboundGeneration: 2 })
	})

	it('group text (sendGroup) carries the field', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 4 })
		await client.sendGroupMessage({} as never)
		expect(sent.find((c) => c.type === 'sendGroup')).toMatchObject({ type: 'sendGroup', inboundGeneration: 4 })
	})

	it('mailbox commands carry the field: mailboxCommand and ownMailboxCommand', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		await expect(client.postMailboxCommand('armored', { command: 'x' })).resolves.toBe(true)
		await expect(client.postOwnMailboxCommand({ command: 'y' })).resolves.toBe(true)
		expect(sent.find((c) => c.type === 'mailboxCommand')).toMatchObject({ inboundGeneration: 5 })
		expect(sent.find((c) => c.type === 'ownMailboxCommand')).toMatchObject({ inboundGeneration: 5 })
	})

	it('a mailbox command before any announcement returns false and sends nothing', async () => {
		const client = await startClient()
		await expect(client.postOwnMailboxCommand({ command: 'y' })).resolves.toBe(false)
		expect(countOf('ownMailboxCommand')).toBe(0)
	})
})

describe('a native refusal and a dropped request', () => {
	it('send_timeout is an answer: the send fails with it, once, and is not resent', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'send_timeout'
		await expect(client.sendMessage(TO, 'hi', { sendId: 's3' })).rejects.toThrow('send_timeout')
		expect(countOf('send')).toBe(1)
	})

	it('a silent send is resent once after 35 s when the generation has not moved, then fails with timeout', async () => {
		const client = await startClient()
		jest.useFakeTimers()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'silent'
		const outcome = client.sendMessage(TO, 'hi', { sendId: 's4' }).then(
			() => 'resolved',
			(e: Error) => e.message,
		)
		await flush()
		expect(countOf('send')).toBe(1)
		jest.advanceTimersByTime(35_000)
		await flush()
		expect(countOf('send')).toBe(2)
		expect(sent.filter((c) => c.type === 'send').map((c) => c.inboundGeneration)).toEqual([2, 2])
		// The resend keeps the same sendId: the native layer de-duplicates by it.
		expect(sent.filter((c) => c.type === 'send').map((c) => c.sendId)).toEqual(['s4', 's4'])
		jest.advanceTimersByTime(35_000)
		await flush()
		await expect(outcome).resolves.toBe('timeout')
		expect(countOf('send')).toBe(2)
	})

	it('a silent mailbox command whose generation moved is abandoned: no resend, no third attempt', async () => {
		const client = await startClient()
		jest.useFakeTimers()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'silent'
		const outcome = client.postOwnMailboxCommand({ command: 'z' })
		await flush()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 3 })
		jest.advanceTimersByTime(35_000)
		await flush()
		await expect(outcome).resolves.toBe(false)
		expect(countOf('ownMailboxCommand')).toBe(1)
	})
})

describe('an older shell that does not declare inbound.generation.v1', () => {
	it('send works without the field and without any generation announcement', async () => {
		const client = await startClient(['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck'])
		await expect(client.sendMessage(TO, 'hi', { sendId: 'old-1' })).resolves.toEqual({ sendId: 'old-1' })
		const cmd = sent.find((c) => c.type === 'send')
		expect(cmd).toBeDefined()
		expect(Object.keys(cmd as object)).not.toContain('inboundGeneration')
	})

	it('group text, mailbox commands and the group roster and tombstone are not refused either', async () => {
		const client = await startClient(['identity.native-keys.v1', 'identity.provision'])
		await expect(client.sendGroupMessage({} as never)).resolves.toBeDefined()
		await expect(client.postMailboxCommand('armored', { command: 'x' })).resolves.toBe(true)
		await expect(client.postOwnMailboxCommand({ command: 'y' })).resolves.toBe(true)
		await expect(client.issueGroupRoster({} as never)).resolves.toBeDefined()
		await expect(client.issueGroupTombstone({} as never)).resolves.toBeDefined()
		for (const type of ['sendGroup', 'mailboxCommand', 'ownMailboxCommand', 'issueGroupRoster', 'issueGroupTombstone']) {
			const cmd = sent.find((c) => c.type === type)
			expect(cmd).toBeDefined()
			expect(Object.keys(cmd as object)).not.toContain('inboundGeneration')
		}
	})
})

describe('the group roster and tombstone carry the field when declared', () => {
	it('issueGroupRoster and issueGroupTombstone carry inboundGeneration at the top level', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 6 })
		await client.issueGroupRoster({} as never)
		await client.issueGroupTombstone({} as never)
		expect(sent.find((c) => c.type === 'issueGroupRoster')).toMatchObject({ inboundGeneration: 6 })
		expect(sent.find((c) => c.type === 'issueGroupTombstone')).toMatchObject({ inboundGeneration: 6 })
	})

	it('before any announcement, the roster and the tombstone are native_unavailable and nothing is sent', async () => {
		const client = await startClient()
		await expect(client.issueGroupRoster({} as never)).rejects.toThrow('native_unavailable')
		await expect(client.issueGroupTombstone({} as never)).rejects.toThrow('native_unavailable')
		expect(countOf('issueGroupRoster')).toBe(0)
		expect(countOf('issueGroupTombstone')).toBe(0)
	})
})

describe('to): capability, events, the 35 s wait, sendId, the group roster and tombstone', () => {
	it('the shell declares inbound.generation.v1 and no event has arrived: send is not sent and the caller gets native_unavailable', async () => {
		const client = await startClient()
		await expect(client.sendMessage(TO, 'hi', { sendId: 'ig32' })).rejects.toThrow('native_unavailable')
		expect(countOf('send')).toBe(0)
	})

	it('declared and the event has arrived: send is sent with inboundGeneration at the top level', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		await expect(client.sendMessage(TO, 'hi', { sendId: 'ig33' })).resolves.toEqual({ sendId: 'ig33' })
		expect(sent.find((c) => c.type === 'send')).toMatchObject({ inboundGeneration: 2 })
	})

	it('not declared (an older shell): no field, sent with the generation the native layer holds (no event needed here)', async () => {
		const client = await startClient(['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck'])
		await expect(client.sendMessage(TO, 'hi', { sendId: 'ig34' })).resolves.toEqual({ sendId: 'ig34' })
		const cmd = sent.find((c) => c.type === 'send') as Record<string, unknown>
		expect(Object.keys(cmd)).not.toContain('inboundGeneration')
	})

	it('a resend keeps the sendId; the original request is still in flight, so its late answer is not used', async () => {
		const client = await startClient()
		jest.useFakeTimers()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'silent'
		const outcome = client.sendMessage(TO, 'hi', { sendId: 'ig35' })
		await flush()
		const firstReq = sent.find((c) => c.type === 'send')?.reqId as number
		jest.advanceTimersByTime(35_000)
		await flush()
		const sends = sent.filter((c) => c.type === 'send')
		expect(sends).toHaveLength(2)
		expect(sends.map((c) => c.sendId)).toEqual(['ig35', 'ig35'])
		// The original's late answer arrives after the resend started: it matches no pending request and is ignored.
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId: firstReq, ok: true, result: { sent: true } } },
			}),
		)
		await flush()
		const resendReq = sends[1].reqId as number
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId: resendReq, ok: true, result: { sent: true } } },
			}),
		)
		await flush()
		await expect(outcome).resolves.toEqual({ sendId: 'ig35' })
	})

	it('no answer at all, twice: one resend with the same sendId, then the page gives up with timeout (no third attempt)', async () => {
		const client = await startClient()
		jest.useFakeTimers()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'silent'
		const outcome = client.sendMessage(TO, 'hi', { sendId: 'ig36' }).then(
			() => 'resolved',
			(e: Error) => e.message,
		)
		await flush()
		jest.advanceTimersByTime(35_000)
		await flush()
		const sends = sent.filter((c) => c.type === 'send')
		expect(sends.map((c) => c.sendId)).toEqual(['ig36', 'ig36'])
		jest.advanceTimersByTime(35_000)
		await flush()
		await expect(outcome).resolves.toBe('timeout')
	})

	it('the original completed at the native layer but its answer never reached the page: the page resends with the same sendId, and the answer to the resend is the outcome', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		jest.useFakeTimers()
		mode = 'silent'
		// The original is answered natively, but the answer is lost on the way; the page sees silence.
		const outcome = client.sendMessage(TO, 'hi', { sendId: 'ig36' })
		await flush()
		jest.advanceTimersByTime(35_000)
		await flush()
		const sends = sent.filter((c) => c.type === 'send')
		expect(sends).toHaveLength(2)
		expect(sends.map((c) => c.sendId)).toEqual(['ig36', 'ig36'])
		// The native layer answers the resend from its stored result.
		const resendReq = sends[1].reqId as number
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId: resendReq, ok: true, result: { sent: true } } },
			}),
		)
		await flush()
		await expect(outcome).resolves.toEqual({ sendId: 'ig36' })
		// No third attempt once the resend has been answered.
		jest.advanceTimersByTime(70_000)
		await flush()
		expect(countOf('send')).toBe(2)
	})

	it('the answer comes at 34.9 s, inside the 35 s wait: not timed out, no resend', async () => {
		const client = await startClient()
		jest.useFakeTimers()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		mode = 'silent'
		const outcome = client.sendMessage(TO, 'hi', { sendId: 'ig37' })
		await flush()
		const req = sent.find((c) => c.type === 'send')?.reqId as number
		jest.advanceTimersByTime(34_900)
		window.dispatchEvent(
			new CustomEvent('cashtreesios', {
				detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId: req, ok: true, result: { sent: true } } },
			}),
		)
		await flush()
		await expect(outcome).resolves.toEqual({ sendId: 'ig37' })
		expect(countOf('send')).toBe(1)
	})

	it('and: the group roster and the tombstone carry the field when declared (a missing field is refused by the native layer; the page always sends it)', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		await client.issueGroupRoster({} as never)
		await client.issueGroupTombstone({} as never)
		expect(sent.find((c) => c.type === 'issueGroupRoster')).toMatchObject({ inboundGeneration: 2 })
		expect(sent.find((c) => c.type === 'issueGroupTombstone')).toMatchObject({ inboundGeneration: 2 })
	})
})


describe('an older shell keeps its old waits: group text 60 s, mailbox command 30 s, one attempt', () => {
	it('an older shell, group text: no answer for 59.999 s is still pending; at 60 s it fails with timeout; no resend', async () => {
		const client = await startClient(['identity.native-keys.v1', 'identity.provision'])
		jest.useFakeTimers()
		mode = 'silent'
		let settled: 'pending' | 'failed' = 'pending'
		const outcome = client.sendGroupMessage({} as never).then(
			() => 'resolved',
			(e: Error) => {
				settled = 'failed'
				return e.message
			},
		)
		await flush()
		jest.advanceTimersByTime(59_999)
		await flush()
		expect(settled).toBe('pending')
		jest.advanceTimersByTime(1)
		await flush()
		await expect(outcome).resolves.toBe('timeout')
		expect(countOf('sendGroup')).toBe(1)
	})

	it('an older shell, mailbox command: no answer for 29.999 s is still pending; at 30 s it returns false; no resend', async () => {
		const client = await startClient(['identity.native-keys.v1', 'identity.provision'])
		jest.useFakeTimers()
		mode = 'silent'
		let settled: 'pending' | 'done' = 'pending'
		const outcome = client.postOwnMailboxCommand({ command: 'z' }).then((ok) => {
			settled = 'done'
			return ok
		})
		await flush()
		jest.advanceTimersByTime(29_999)
		await flush()
		expect(settled).toBe('pending')
		jest.advanceTimersByTime(1)
		await flush()
		await expect(outcome).resolves.toBe(false)
		expect(countOf('ownMailboxCommand')).toBe(1)
	})
})

describe('a declaring shell waits 35 s', () => {
	it('group text: no answer for 34.999 s is still pending; at 35 s the one resend is sent', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		jest.useFakeTimers()
		mode = 'silent'
		const outcome = client.sendGroupMessage({} as never).then(
			() => 'resolved',
			(e: Error) => e.message,
		)
		await flush()
		expect(countOf('sendGroup')).toBe(1)
		jest.advanceTimersByTime(34_999)
		await flush()
		expect(countOf('sendGroup')).toBe(1)
		jest.advanceTimersByTime(1)
		await flush()
		expect(countOf('sendGroup')).toBe(2)
		jest.advanceTimersByTime(35_000)
		await flush()
		await expect(outcome).resolves.toBe('timeout')
		expect(countOf('sendGroup')).toBe(2)
	})

	it('mailbox command: no answer for 34.999 s is still pending; at 35 s the one resend is sent', async () => {
		const client = await startClient()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		jest.useFakeTimers()
		mode = 'silent'
		const outcome = client.postOwnMailboxCommand({ command: 'z' })
		await flush()
		jest.advanceTimersByTime(34_999)
		await flush()
		expect(countOf('ownMailboxCommand')).toBe(1)
		jest.advanceTimersByTime(1)
		await flush()
		expect(countOf('ownMailboxCommand')).toBe(2)
		jest.advanceTimersByTime(35_000)
		await flush()
		await expect(outcome).resolves.toBe(false)
		expect(countOf('ownMailboxCommand')).toBe(2)
	})
})

