/**
 * @jest-environment node
 *
 * the native init carries `deferAck: true`, which declares this page calls
 * `ackInbound` after it has stored or shown each message. The native module reads `true` as a new page. `ackInbound` cleans the inbox
 * armor and sends the sender receipt; it never sends a mailbox ACK. Node environment, as the other transport tests. SYNTHETIC values.
 */
import { createNativeConetChatClient } from './nativeConetChatTransport'

type Sent = { type?: string; payload?: Record<string, unknown>; armorHashes?: string[] }

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
let sent: Sent[] = []

/** A fake shell: `hello` declares the capabilities; `init` and `provisionIdentity` get an ack; everything is recorded. */
function installShell(): void {
	sent = []
	w.CashTreesIOS = {
		chatModuleCommand: (p: { action: string; command: Sent & { reqId?: number } }) => {
			const cmd = p.command
			sent.push(cmd)
			const reply = (result: unknown) =>
				setTimeout(() => {
					window.dispatchEvent(
						new CustomEvent('cashtreesios', {
							detail: { action: 'chatModuleEvent', event: { type: 'ready', reqId: cmd.reqId, result } },
						}),
					)
				}, 0)
			if (cmd.type === 'hello') reply({ protocolVersion: 1, capabilities: ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck'] })
			if (cmd.type === 'init') reply({ historyApi: 0 })
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

describe('the native init declares deferAck: true', () => {
	it('the init command carries deferAck: true in its payload', async () => {
		installShell()
		const client = createNativeConetChatClient(config())
		await client.init()
		const init = sent.find((c) => c.type === 'init')
		expect(init).toBeDefined()
		expect(init?.payload?.deferAck).toBe(true)
	})

	it('ackInbound cleans the armor and sends the sender receipt; it never sends a mailbox ACK (gossip_delivery_ack)', async () => {
		installShell()
		const client = createNativeConetChatClient(config())
		await client.init()
		sent = []
		client.ackInbound(['0x' + 'a'.repeat(64)])
		const types = sent.map((c) => c.type)
		expect(types).toEqual(['ackInbound'])
		expect(JSON.stringify(sent)).not.toContain('gossip_delivery_ack')
	})
})
