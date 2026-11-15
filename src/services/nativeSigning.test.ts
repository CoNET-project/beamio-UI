/**
 * @jest-environment node
 *
 * Account message signatures in a shell (matrix v2  / ): the page sends text and gets a signature back; nothing
 * is sent without the chat capability; the ack shape is only ever signed under the gossip kind.
 * The key used in the browser path is synthetic test material.
 */
import { ethers } from 'ethers'
import {
	isGossipAckShape,
	NATIVE_GOSSIP_SIGN_COMMAND,
	NATIVE_SIGN_MESSAGE_COMMAND,
	nativeSignGossip,
	nativeSignMessage,
	signAccountMessageFor,
} from './nativeSigning'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'
import { INBOUND_GENERATION_CAPABILITY, recordInboundGenerationEvent, resetInboundGenerationForTests } from './inboundGeneration'

type Sent = Record<string, unknown>
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

const SYNTHETIC_KEY = '0x' + '22'.repeat(32)
const SIG = '0x' + 'ab'.repeat(65)
const ACK = JSON.stringify({ command: 'gossip_delivery_ack', walletAddress: '0x' + '33'.repeat(20), armorHash: '0x' + '44'.repeat(32), timestamp: 1700000000 })

let sent: Sent[] = []

/** `reply`: the answer to a sign command. `caps`: null = no hello answer. */
function installShell(caps: string[] | null, reply: Record<string, unknown>): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') {
				if (caps !== null) send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: caps } })
				return
			}
			if (cmd.type === NATIVE_GOSSIP_SIGN_COMMAND || cmd.type === NATIVE_SIGN_MESSAGE_COMMAND) {
				send({ ...reply, reqId: cmd.reqId })
			}
		},
	}
}

const signCommands = (): Sent[] => sent.filter((c) => c.type === NATIVE_GOSSIP_SIGN_COMMAND || c.type === NATIVE_SIGN_MESSAGE_COMMAND)

beforeEach(() => {
	sent = []
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe('shape of the delivery ack ', () => {
	it('recognises the ack object and nothing else', () => {
		expect(isGossipAckShape(ACK)).toBe(true)
		expect(isGossipAckShape('{"command":"other"}')).toBe(false)
		expect(isGossipAckShape('[1]')).toBe(false)
		expect(isGossipAckShape('not json')).toBe(false)
	})
})

describe('nativeSignGossip', () => {
	it('without the chat capability: native_unavailable, and no signing command is sent', async () => {
		installShell([], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignGossip(ACK)).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(signCommands()).toEqual([])
	})

	it('sends the exact text with only type, message and reqId, and returns the signature', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignGossip(ACK)).resolves.toEqual({ ok: true, signature: SIG })
		const cmd = signCommands()[0]
		expect(cmd.type).toBe(NATIVE_GOSSIP_SIGN_COMMAND)
		expect(cmd.message).toBe(ACK)
		expect(Object.keys(cmd).sort()).toEqual(['message', 'reqId', 'type'])
	})

	it('refuses a text that is not the ack shape, and a text over 2048 bytes, without sending', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignGossip('{"command":"send"}')).resolves.toEqual({ ok: false, reason: 'not_gossip_shape' })
		await expect(nativeSignGossip(JSON.stringify({ command: 'gossip_delivery_ack', pad: 'x'.repeat(2100) }))).resolves.toEqual({
			ok: false,
			reason: 'bad_request',
		})
		expect(signCommands()).toEqual([])
	})

	it('a malformed signature in the ack is refused, and a native error code is passed through', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: '0x1234' } })
		await expect(nativeSignGossip(ACK)).resolves.toEqual({ ok: false, reason: 'bad_ack' })
	})

	it('a refusal from the native layer returns its short code', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: false, error: 'command_rejected' })
		await expect(nativeSignGossip(ACK)).resolves.toEqual({ ok: false, reason: 'command_rejected' })
	})
})

describe('nativeSignMessage', () => {
	it('selfAuth is not a bridge command: refused as not_supported, and no signMessage command is sent', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignMessage('selfAuth', 'wallet_online_query text')).resolves.toEqual({ ok: false, reason: 'not_supported' })
		expect(signCommands()).toEqual([])
		expect(sent.filter((c) => c.type === NATIVE_SIGN_MESSAGE_COMMAND)).toEqual([])
	})

	it('refuses the ack shape under any kind, without sending', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		for (const kind of ['envelope', 'group', 'selfAuth'] as const) {
			await expect(nativeSignMessage(kind, ACK)).resolves.toEqual({ ok: false, reason: 'ack_requires_gossip_kind' })
		}
		expect(signCommands()).toEqual([])
	})

	it('refuses a kind outside envelope, group and selfAuth (voice and ephemeral are not here)', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignMessage('voice' as never, 'x')).resolves.toEqual({ ok: false, reason: 'kind_not_allowed' })
		await expect(nativeSignMessage('gossip' as never, 'x')).resolves.toEqual({ ok: false, reason: 'kind_not_allowed' })
		expect(signCommands()).toEqual([])
	})

	it('refuses a message over 64 KiB without sending', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(nativeSignMessage('envelope', 'x'.repeat(64 * 1024 + 1))).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(signCommands()).toEqual([])
	})
})

describe('signAccountMessageFor', () => {
	it('browser: signs with the page account key, the same as ethers', async () => {
		const msg = 'envelope text'
		await expect(signAccountMessageFor({ kind: 'envelope', message: msg, privateKeyArmor: SYNTHETIC_KEY })).resolves.toBe(
			await new ethers.Wallet(SYNTHETIC_KEY).signMessage(msg),
		)
	})

	it('browser: no key means no signature', async () => {
		await expect(signAccountMessageFor({ kind: 'selfAuth', message: 'x', privateKeyArmor: '' })).rejects.toThrow('no_account_key')
	})

	it('shell: selfAuth is refused as not_supported without any command, and never signs with a page key', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: false, error: 'locked' })
		await expect(signAccountMessageFor({ kind: 'selfAuth', message: 'x', privateKeyArmor: SYNTHETIC_KEY })).rejects.toThrow('not_supported')
		expect(sent.filter((c) => c.type === NATIVE_SIGN_MESSAGE_COMMAND)).toEqual([])
		expect(JSON.stringify(sent)).not.toContain(SYNTHETIC_KEY.slice(2))
	})

	it('no source file sends the signMessage command (it is not a bridge command)', () => {
		const fs = require('fs') as typeof import('fs')
		const path = require('path') as typeof import('path')
		const srcRoot = path.resolve(__dirname, '..')
		const walk = (dir: string): string[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
				const full = path.join(dir, e.name)
				if (e.isDirectory()) return e.name === '__fixtures__' ? [] : walk(full)
				return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : []
			})
		for (const file of walk(srcRoot)) {
			expect(fs.readFileSync(file, 'utf8')).not.toMatch(/type:\s*NATIVE_SIGN_MESSAGE_COMMAND/)
		}
	})

	it('shell: an envelope before any generation announcement is native_unavailable, and nothing is sent ', async () => {
		resetInboundGenerationForTests()
		installShell([NATIVE_KEYS_CAPABILITY, INBOUND_GENERATION_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(signAccountMessageFor({ kind: 'envelope', message: 'x' })).rejects.toThrow('native_unavailable')
		expect(signCommands()).toEqual([])
	})

	it('shell: an older shell that does not declare inbound.generation.v1 gets no field and is signed as before', async () => {
		resetInboundGenerationForTests()
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(signAccountMessageFor({ kind: 'envelope', message: 'x' })).resolves.toBe(SIG)
		const cmd = signCommands()[0]
		expect(cmd.type).toBe(NATIVE_GOSSIP_SIGN_COMMAND)
		expect(Object.keys(cmd)).not.toContain('inboundGeneration')
	})

	it('shell: an envelope is signed as gossipSign carrying the announced inbound generation ', async () => {
		resetInboundGenerationForTests()
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 5 })
		installShell([NATIVE_KEYS_CAPABILITY, INBOUND_GENERATION_CAPABILITY], { type: 'ack', ok: true, result: { signature: SIG } })
		await expect(signAccountMessageFor({ kind: 'envelope', message: 'x' })).resolves.toBe(SIG)
		const cmd = signCommands()[0]
		expect(cmd.type).toBe(NATIVE_GOSSIP_SIGN_COMMAND)
		expect(cmd).toMatchObject({ kind: 'envelope', message: 'x', inboundGeneration: 5 })
	})
})
