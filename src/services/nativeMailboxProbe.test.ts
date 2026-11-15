/**
 * @jest-environment node
 *
 * (interface envelope): the probe signature is the native command `mailboxProbeSign`. The page
 * sends {type, reqId, command, targetWallet, timestamp} only, and uses the returned message. Without the declared capability
 * mailbox.probe.sign.v1 nothing is sent and the probe is not_supported (no page fallback). SYNTHETIC values only.
 */
import { MAILBOX_PROBE_SIGN_CAPABILITY, nativeMailboxProbeSign } from './nativeMailboxProbe'

type Sent = Record<string, unknown>

const TARGET = '0x1234567890AbcdEF1234567890aBcdef12345678'
const MESSAGE = '{"command":"wallet_online_query","walletAddress":"0xabCDeF0123456789AbcdEf0123456789aBCDEF01","targetWallet":"0x1234567890AbcdEF1234567890aBcdef12345678","timestamp":1762000000}'
const SIG = '0x' + 'ab'.repeat(65)
const HELLO_CAPS = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck', MAILBOX_PROBE_SIGN_CAPABILITY]

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

let sent: Sent[] = []
/** What the module answers to `mailboxProbeSign`: a payload (an ack), or nothing. */
let probeAnswer: Record<string, unknown> | null = null
/** The capabilities the hello answer lists; null means no hello answer at all. */
let helloCaps: string[] | null = HELLO_CAPS

function installShell(): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const reply = (event: Record<string, unknown>) =>
				setTimeout(
					() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })),
					0,
				)
			if (cmd.type === 'hello') {
				if (helloCaps !== null) reply({ type: 'ready', reqId: cmd.reqId, result: { protocolVersion: 1, capabilities: helloCaps } })
			} else if (cmd.type === 'mailboxProbeSign' && probeAnswer) {
				reply({ ...probeAnswer, reqId: cmd.reqId })
			}
		},
	}
}

const probes = () => sent.filter((c) => c.type === 'mailboxProbeSign')

beforeEach(() => {
	sent = []
	helloCaps = HELLO_CAPS
	probeAnswer = { type: 'ack', ok: true, result: { message: MESSAGE, signature: SIG } }
	installShell()
})

afterEach(() => {
	delete w.CashTreesIOS
})

describe('the shell builds and signs the probe when it declares mailbox.probe.sign.v1', () => {
	it('declared: the flat request (type, command, targetWallet, timestamp) and the returned message and signature are the answer', async () => {
		const out = await nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1762000000 })
		expect(out).toEqual({ ok: true, message: MESSAGE, signature: SIG })
		expect(probes()).toHaveLength(1)
		const req = probes()[0]
		// Flat envelope: dispatched by type; no action, no args.
		expect(Object.keys(req).sort()).toEqual(['command', 'reqId', 'targetWallet', 'timestamp', 'type'])
		expect(req).toMatchObject({ type: 'mailboxProbeSign', command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1762000000 })
		expect(req).not.toHaveProperty('action')
		expect(req).not.toHaveProperty('args')
		// The page never sends its own message, a signing account, or a signature.
		expect(JSON.stringify(req)).not.toMatch(/walletAddress|"message"|"signature"|privateKey/)
	})

	it('the wake kind is sent with its own command name', async () => {
		probeAnswer = { type: 'ack', ok: true, result: { message: MESSAGE.replace('wallet_online_query', 'wallet_native_wake_query'), signature: SIG } }
		const out = await nativeMailboxProbeSign({ command: 'wallet_native_wake_query', targetWallet: TARGET, timestamp: 1762000000 })
		expect(out.ok).toBe(true)
		expect(probes()[0].command).toBe('wallet_native_wake_query')
	})

	it('a native refusal passes its reason through (the gate answers before any payload is read)', async () => {
		for (const error of ['no_key', 'not_ready', 'locked']) {
			probeAnswer = { type: 'ack', ok: false, error }
			await expect(nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1 })).resolves.toEqual({ ok: false, reason: error })
		}
	})

	it('an ack without a well-formed signature or message is bad_ack, and nothing is taken from it', async () => {
		probeAnswer = { type: 'ack', ok: true, result: { message: MESSAGE, signature: '0x12' } }
		await expect(nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1 })).resolves.toEqual({ ok: false, reason: 'bad_ack' })
		probeAnswer = { type: 'ack', ok: true, result: { signature: SIG } }
		await expect(nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1 })).resolves.toEqual({ ok: false, reason: 'bad_ack' })
	})
})

describe('without the capability there is no probe and no page fallback', () => {
	it('an undeclared shell answers not_supported, and no mailboxProbeSign is sent', async () => {
		helloCaps = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck']
		const out = await nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1 })
		expect(out).toEqual({ ok: false, reason: 'not_supported' })
		expect(probes()).toHaveLength(0)
	})

	it('no hello answer: native_unavailable, and no mailboxProbeSign is sent', async () => {
		helloCaps = null
		const out = await nativeMailboxProbeSign({ command: 'wallet_online_query', targetWallet: TARGET, timestamp: 1 })
		expect(out).toEqual({ ok: false, reason: 'native_unavailable' })
		expect(probes()).toHaveLength(0)
	}, 15_000)
})
