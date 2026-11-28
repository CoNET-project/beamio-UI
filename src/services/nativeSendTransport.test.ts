/**
 * @jest-environment node
 */
// the transport class (the iOS and the Android shell share it) sends `sendPrepare` and the armored `send` as IFACE-native-send-v1 fixes them, through the generation-tagged request,
// and a fake shell answers like the interface. SYNTHETIC values; the shell is a fake.
import { createNativeConetChatClient } from './nativeConetChatTransport'
import { recordInboundGenerationEvent, resetInboundGenerationForTests } from './inboundGeneration'
import { armorDigest } from './sendAnswer'
import { assertArmorSendCommand, nativeSendReuseOf, sendViaNative } from './nativeSendProtocol'

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
const SEND_ID = '1767225600000-aaaa1111'
const PAYLOAD = JSON.stringify({ sendId: SEND_ID, from: 'me', text: 'hello', createdAt: 1 })
const ARMOR = '-----BEGIN PGP MESSAGE-----\nSYNTHETIC-ARMOR\n-----END PGP MESSAGE-----'
const DECLARED = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck', 'inbound.generation.v1', 'send.mailboxWrap', 'send.armorReuse.v1']

let sent: Sent[] = []
let sendAnswer: () => { ok: boolean; result?: unknown; error?: string } = () => ({ ok: true, result: { sendId: SEND_ID, armorDigest: armorDigest(ARMOR), sent: true, entryAnswer: { kind: 'bound', stored: true, h: armorDigest(ARMOR), hMatches: true }, tried: 1 } })

function installShell(): void {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (p: { action: string; command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const reply = (event: Record<string, unknown>) => setTimeout(() => { window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })) }, 0)
			if (cmd.type === 'hello') reply({ type: 'ready', reqId: cmd.reqId, result: { protocolVersion: 1, capabilities: DECLARED } })
			else if (cmd.type === 'init') reply({ type: 'ready', reqId: cmd.reqId, result: { historyApi: 0 } })
			else if (cmd.type === 'sendPrepare') reply({ type: 'ack', reqId: cmd.reqId, ok: true, result: { sendId: cmd.sendId, armor: ARMOR, armorDigest: armorDigest(ARMOR) } })
			else if (cmd.type === 'send') {
				const a = sendAnswer()
				reply(a.ok ? { type: 'ack', reqId: cmd.reqId, ok: true, result: a.result } : { type: 'ack', reqId: cmd.reqId, ok: false, error: a.error })
			}
		},
	}
}
const config = () => ({
	identity: { eoaAddress: EOA, pgpPublicKeyArmored: '', ownRouteArmoredPublicKey: '' },
	conetRpcUrl: 'https://rpc.invalid', addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
	getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never, ipfsBaseUrl: 'https://ipfs.invalid', apiBaseUrl: 'https://api.invalid',
	chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
}) as unknown as Parameters<typeof createNativeConetChatClient>[0]
async function startClient() {
	installShell()
	const client = createNativeConetChatClient(config())
	await client.init()
	sent = []
	recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 3 })
	return client
}
beforeEach(() => { resetInboundGenerationForTests() })
afterEach(() => { delete w.CashTreesIOS })

describe('the commands of IFACE-native-send-v1 through the real transport class', () => {
	it('sendPrepare carries schema 1, the application sendId, the payload and the generation; no armor', async () => {
		const client = await startClient()
		const r = await (client as unknown as { sendPrepare: (t: never, p: string, s: string) => Promise<{ sendId: string; armor: string; armorDigest: string }> }).sendPrepare(TO, PAYLOAD, SEND_ID)
		expect(r).toEqual({ sendId: SEND_ID, armor: ARMOR, armorDigest: armorDigest(ARMOR) })
		const cmd = sent.find((c) => c.type === 'sendPrepare') as Sent
		expect(cmd).toMatchObject({ type: 'sendPrepare', schema: 1, sendId: SEND_ID, payload: PAYLOAD, inboundGeneration: 3 })
		expect(cmd.armor).toBeUndefined()
	})
	it('the armored send carries schema 1, sendId, armor and armorDigest (the same ones every time) and the generation; the ack is parsed into the classified answer; armor text passes the key guard', async () => {
		const client = await startClient()
		const c = client as unknown as { sendArmored: (t: never, p: string, i: { sendId: string; armor: string; armorDigest: string }) => Promise<unknown> }
		const input = { sendId: SEND_ID, armor: ARMOR, armorDigest: armorDigest(ARMOR) }
		const a = await c.sendArmored(TO, PAYLOAD, input)
		const b = await c.sendArmored(TO, PAYLOAD, input)
		expect(a).toMatchObject({ sendId: SEND_ID, sent: true, entryAnswer: { kind: 'bound', stored: true } })
		expect(b).toEqual(a)
		const cmds = sent.filter((x) => x.type === 'send')
		expect(cmds.length).toBe(2)
		for (const cmd of cmds) expect(cmd).toMatchObject({ type: 'send', schema: 1, sendId: SEND_ID, armor: ARMOR, armorDigest: armorDigest(ARMOR), inboundGeneration: 3 })
		expect(cmds[1].reqId).not.toBe(cmds[0].reqId)
	})
	it('a native refusal (ok:false) rejects with its code; a bad ack is not an answer (null)', async () => {
		const client = await startClient()
		const c = client as unknown as { sendArmored: (t: never, p: string, i: { sendId: string; armor: string; armorDigest: string }) => Promise<unknown> }
		sendAnswer = () => ({ ok: false, error: 'armor_digest_mismatch' })
		await expect(c.sendArmored(TO, PAYLOAD, { sendId: SEND_ID, armor: ARMOR, armorDigest: '0x00' })).rejects.toThrow('armor_digest_mismatch')
		sendAnswer = () => ({ ok: true, result: { sent: true } })
		await expect(c.sendArmored(TO, PAYLOAD, { sendId: SEND_ID, armor: ARMOR, armorDigest: armorDigest(ARMOR) })).resolves.toBeNull()
	})
})

describe('IFACE v1.2: the armored send is never built without a non-empty armor string (JSON.stringify drops an undefined key, which would be the old path)', () => {
	it('an undefined, null, empty, blank or non-string armor rejects with armor_required and NO send command leaves', async () => {
		const client = await startClient()
		const c = client as unknown as { sendArmored: (t: never, p: string, i: { sendId: string; armor: unknown; armorDigest: string }) => Promise<unknown> }
		for (const armor of [undefined, null, '', '   \n', 7, {}]) {
			await expect(c.sendArmored(TO, PAYLOAD, { sendId: SEND_ID, armor, armorDigest: armorDigest(ARMOR) })).rejects.toThrow('armor_required')
		}
		await expect(c.sendArmored(TO, PAYLOAD, { sendId: SEND_ID, armor: ARMOR, armorDigest: '' })).rejects.toThrow('armor_required')
		await expect(c.sendArmored(TO, PAYLOAD, { sendId: '', armor: ARMOR, armorDigest: armorDigest(ARMOR) })).rejects.toThrow('armor_required')
		expect(sent.filter((x) => x.type === 'send').length).toBe(0)
	})
	it('the assertion looks at the command AS SERIALISED: the armor key must survive JSON.stringify', () => {
		expect(() => assertArmorSendCommand({ sendId: SEND_ID, armor: undefined, armorDigest: '0x1' })).toThrow('armor_required')
		expect(() => assertArmorSendCommand({ sendId: SEND_ID, armor: ARMOR, armorDigest: '0x1' })).not.toThrow()
	})
	it('a blank stored armor is not reused: the page prepares a new one and sends THAT (never a blank armor)', async () => {
		const client = await startClient()
		sendAnswer = () => ({ ok: true, result: { sendId: SEND_ID, armorDigest: armorDigest(ARMOR), sent: true, entryAnswer: { kind: 'bound', stored: true, h: armorDigest(ARMOR), hMatches: true }, tried: 1 } })
		let stored: string | undefined = '   '
		const ctx = { get armor() { return stored }, record: async (a: string) => { stored = a } }
		const r = await sendViaNative({ client: client as never, reuse: true, to: TO, payload: PAYLOAD, armor: ctx })
		expect(r.ok).toBe(true)
		expect(sent.filter((c) => c.type === 'sendPrepare').length).toBe(1)
		const cmds = sent.filter((c) => c.type === 'send')
		expect(cmds.length).toBe(1)
		expect(cmds[0].armor).toBe(ARMOR)
		expect(stored).toBe(ARMOR)
	})
})

describe('the whole page flow over the real transport and the fake shell', () => {
	it('prepare, the armor is stored, send: bound; the retry sends the same armor with no second prepare', async () => {
		const client = await startClient()
		sendAnswer = () => ({ ok: true, result: { sendId: SEND_ID, armorDigest: armorDigest(ARMOR), sent: true, entryAnswer: { kind: 'network_error' }, tried: 1 } })
		let stored: string | undefined
		const ctx = { get armor() { return stored }, record: async (a: string) => { stored = a } }
		const receipts: unknown[] = []
		const first = await sendViaNative({ client: client as never, reuse: nativeSendReuseOf({ capabilities: DECLARED }, true), to: TO, payload: PAYLOAD, armor: ctx, onReceipt: (r) => receipts.push(r) })
		expect(first.ok).toBe(false) // the answer was a network error: a failed attempt, the armor is stored
		expect(stored).toBe(ARMOR)
		sendAnswer = () => ({ ok: true, result: { sendId: SEND_ID, armorDigest: armorDigest(ARMOR), sent: true, entryAnswer: { kind: 'bound', duplicate: true, h: armorDigest(ARMOR), hMatches: true }, tried: 1 } })
		const second = await sendViaNative({ client: client as never, reuse: true, to: TO, payload: PAYLOAD, armor: ctx, onReceipt: (r) => receipts.push(r) })
		expect(second.ok).toBe(true)
		expect(sent.filter((c) => c.type === 'sendPrepare').length).toBe(1)
		expect(sent.filter((c) => c.type === 'send').length).toBe(2)
		expect(receipts).toEqual([{ kind: 'bound', digest: armorDigest(ARMOR) }])
	})
})
