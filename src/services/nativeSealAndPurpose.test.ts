/**
 * @jest-environment node
 *
 * Matrix v2 (NFC card state through a purpose signer) and (Cashcode seal through). A shell fails closed
 * until the native layer ships the purpose or the seal; a browser keeps its page signing, as before. The key used is
 * synthetic test material. Also reads the sources, so a re-introduced key parameter fails.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import { NATIVE_ACCOUNT_SEAL_COMMAND, nativeSealAccountPayload, nativeSealOrEmpty } from './nativeSigning'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'

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

const SYNTHETIC_KEY = '0x' + '6e'.repeat(32)
let sent: Sent[] = []

function installShell(caps: string[], reply: Record<string, unknown>): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const send = (payload: Record<string, unknown>) =>
				setTimeout(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } })), 0)
			if (cmd.type === 'hello') send({ type: 'ready', reqId: cmd.reqId, result: { capabilities: caps } })
			else if (cmd.type === NATIVE_ACCOUNT_SEAL_COMMAND) send({ ...reply, reqId: cmd.reqId })
		},
	}
}

beforeEach(() => {
	sent = []
})
afterEach(() => {
	delete w.CashTreesIOS
})

describe(' accountSealPayload (Cashcode)', () => {
	it('without the chat capability: native_unavailable, and nothing is sent', async () => {
		installShell([], { type: 'ack', ok: true, result: { ciphertext: 'Y2lwaGVy' } })
		await expect(nativeSealAccountPayload('cashcode', '{"a":1}')).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(sent.map((c) => c.type)).not.toContain(NATIVE_ACCOUNT_SEAL_COMMAND)
	})

	it('sends only purposeId and plaintext (plus type and reqId), and returns the ciphertext', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { ciphertext: 'Y2lwaGVy' } })
		await expect(nativeSealAccountPayload('cashcode', '{"a":1}')).resolves.toEqual({ ok: true, ciphertext: 'Y2lwaGVy' })
		const cmd = sent.find((c) => c.type === NATIVE_ACCOUNT_SEAL_COMMAND) as Sent
		expect(Object.keys(cmd).sort()).toEqual(['plaintext', 'purposeId', 'reqId', 'type'])
		expect(cmd.purposeId).toBe('cashcode')
	})

	it('an ack without a ciphertext is bad_ack, and the shell helper returns empty text', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: {} })
		await expect(nativeSealAccountPayload('cashcode', 'x')).resolves.toEqual({ ok: false, reason: 'bad_ack' })
		await expect(nativeSealOrEmpty('cashcode', 'x')).resolves.toBe('')
	})

	it('an empty purpose or an oversized plaintext is refused without sending', async () => {
		installShell([NATIVE_KEYS_CAPABILITY], { type: 'ack', ok: true, result: { ciphertext: 'Y2lwaGVy' } })
		await expect(nativeSealAccountPayload('', 'x')).resolves.toEqual({ ok: false, reason: 'bad_request' })
		await expect(nativeSealAccountPayload('cashcode', 'x'.repeat(64 * 1024 + 1))).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(sent.map((c) => c.type)).not.toContain(NATIVE_ACCOUNT_SEAL_COMMAND)
	})
})

describe('wiring in the sources', () => {
	const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

		// Superseded (2026-11-13, consumer NFC claim removed): the card-state signature has no caller any more.
		it('the consumer card-state signature is gone from BeamioCard and Home', () => {
			expect(read('src/services/BeamioCard.ts')).not.toMatch(/postNfcCardLinkStateSigned/)
			expect(read('src/components/Home/Home.tsx')).not.toMatch(/postNfcCardLinkStateSigned|signPurposeMessageFor/)
		})

	it('Cashcode seals through in a shell; the page key seal is only in the browser branch', () => {
		const cashcode = read('src/pages/Pay/Cashcode/index.tsx')
		expect(cashcode).toMatch(/isShellContext\(\)\s*\?\s*await nativeSealOrEmpty\('cashcode', JSON\.stringify\(data\)\)\s*:\s*await aesGcmEncrypt\(JSON\.stringify\(data\), profile\.privateKeyArmor\)/)
	})
})
