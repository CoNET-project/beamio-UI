/**
 * @jest-environment node
 *
 * `walletCredential` through the transport: the request goes only to the injected window object; without it,
 * the chat channel is never used and the answer is not_supported. A credential reply is read, an eoa_key reply is unavailable, a
 * not_trusted reply is refused, and the request carries no key material. SYNTHETIC values only: the phrase is a public zero-entropy vector.
 */
jest.mock('./nativeChatRouteRegister', () => ({ nextReqId: () => 5 }))

type Win = EventTarget & Record<string, unknown>
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w

import { setPageOriginForTest } from './shellRecordTransport'
import { readWalletCredential } from './walletCredential'

const ANDROID_ORIGIN = 'https://appassets.androidplatform.net'
const EOA = '0x' + '8'.repeat(40)
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type Host = { postMessage: jest.Mock; onmessage: ((ev: { data: string }) => void) | null }
/** A window object that answers each request with `reply(request)`. */
function host(reply: (req: Record<string, unknown>) => Record<string, unknown>): Host {
	const h: Host = { postMessage: jest.fn(), onmessage: null }
	h.postMessage.mockImplementation((msg: string) => {
		const req = JSON.parse(msg) as Record<string, unknown>
		h.onmessage?.({ data: JSON.stringify(reply(req)) })
	})
	w.BeamioShellRecord = h
	return h
}

beforeEach(() => {
	delete w.BeamioShellRecord
	delete w.CashTreesAndroid
	setPageOriginForTest(ANDROID_ORIGIN)
})

describe('walletCredential over the window channel', () => {
	it('the request is {type, reqId} only, carries no key material, and the credential reply is read', async () => {
		const h = host((req) => ({ type: 'ack', reqId: req.reqId, ok: true, result: { eoa: EOA, credentialKind: 'mnemonic', mnemonic: PHRASE, blob: 'sealed-blob' } }))
		const r = await readWalletCredential()
		expect(r).toEqual({ kind: 'credential', eoa: EOA, mnemonic: PHRASE, blob: 'sealed-blob' })
		const sent = JSON.parse(h.postMessage.mock.calls[0][0] as string) as Record<string, unknown>
		expect(sent).toEqual({ type: 'walletCredential', reqId: 5 })
		expect(JSON.stringify(sent)).not.toMatch(/mnemonic|PrivateKey|privateKey/)
	})

	it('an eoa_key account is unavailable: no private key is asked for', async () => {
		host((req) => ({ type: 'ack', reqId: req.reqId, ok: true, result: { eoa: EOA, credentialKind: 'eoa_key' } }))
		expect(await readWalletCredential()).toEqual({ kind: 'refused', code: 'unavailable' })
	})

	it('a not_trusted reply is refused with that code (the update prompt follows)', async () => {
		host((req) => ({ type: 'ack', reqId: req.reqId, ok: false, error: 'not_trusted' }))
		expect(await readWalletCredential()).toEqual({ kind: 'refused', code: 'not_trusted' })
	})

	it('without the window object the chat channel is never used: not_supported', async () => {
		const chat = jest.fn()
		w.CashTreesAndroid = { getNfcStatus: () => 'ok', chatModuleCommand: chat }
		expect(await readWalletCredential()).toEqual({ kind: 'refused', code: 'not_supported' })
		expect(chat).not.toHaveBeenCalled()
	})
})
