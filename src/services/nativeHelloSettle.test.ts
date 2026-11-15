/**
 * @jest-environment node
 *
 * init decides on identity.native-keys.v1 only after the hello answer has arrived, up to HELLO_TIMEOUT_MS (5 s).
 * A fixed 150 ms window read a declared capability as missing on a real S25 (hello round trip 424 to 478 ms). The fake shell
 * answers hello after a set delay. SYNTHETIC identity: the public test vector address and made-up PGP text.
 */
import { createNativeConetChatClient } from './nativeConetChatTransport'
import { IDENTITY_CAPABILITY_MISSING } from './bridgeGuard'

type Sent = Record<string, unknown>

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const PGP_PUBLIC = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC-PGP-PUBLIC-ONLY\n-----END PGP PUBLIC KEY BLOCK-----'
const DECLARED = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck']
const UNDECLARED = ['identity.provision', 'inbound.deferAck']

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

/** The fake module: `hello` answers with `capabilities` after `helloDelayMs` (null: never); `init` is answered at once. */
function installShell(capabilities: string[], helloDelayMs: number | null): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			const reply = (delay: number) =>
				setTimeout(() => {
					window.dispatchEvent(
						new CustomEvent('cashtreesios', {
							detail: { action: 'chatModuleEvent', event: { type: 'ready', reqId: cmd.reqId, result: cmd.type === 'hello' ? { protocolVersion: 1, capabilities } : { historyApi: 0 } } },
						}),
					)
				}, delay)
			if (cmd.type === 'hello') {
				if (helloDelayMs !== null) reply(helloDelayMs)
			} else if (cmd.type === 'init') {
				reply(0)
			}
		},
	}
}

function config() {
	return {
		identity: { eoaAddress: EOA, pgpPublicKeyArmored: PGP_PUBLIC, ownRouteArmoredPublicKey: PGP_PUBLIC },
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never,
		ipfsBaseUrl: 'https://ipfs.invalid',
		apiBaseUrl: 'https://api.invalid',
		chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	} as unknown as Parameters<typeof createNativeConetChatClient>[0]
}

let client: { destroy?: () => void } | null = null

beforeEach(() => {
	sent = []
	client = null
})

afterEach(() => {
	try {
		client?.destroy?.()
	} catch {
		/* ignore */
	}
	delete w.CashTreesIOS
})

const types = () => sent.map((c) => c.type)

describe('init waits for the hello answer (up to 5 s), not for a fixed 150 ms', () => {
	it('a declared capability answered after 500 ms: init runs', async () => {
		installShell(DECLARED, 500)
		client = createNativeConetChatClient(config())
		await (client as { init(): Promise<void> }).init()
		expect(types()).toContain('init')
	}, 15_000)

	it('a declared capability answered after 4 s: init still runs (inside the 5 s limit)', async () => {
		installShell(DECLARED, 4_000)
		client = createNativeConetChatClient(config())
		await (client as { init(): Promise<void> }).init()
		expect(types()).toContain('init')
	}, 15_000)

	it('an undeclared capability answered after 500 ms: refused with IDENTITY_CAPABILITY_MISSING, no init sent', async () => {
		installShell(UNDECLARED, 500)
		client = createNativeConetChatClient(config())
		await expect((client as { init(): Promise<void> }).init()).rejects.toThrow(IDENTITY_CAPABILITY_MISSING)
		expect(types()).not.toContain('init')
	}, 15_000)

	it('no hello answer at all: refused with IDENTITY_CAPABILITY_MISSING once the 5 s limit has ended, no init sent', async () => {
		installShell(DECLARED, null)
		client = createNativeConetChatClient(config())
		const started = Date.now()
		await expect((client as { init(): Promise<void> }).init()).rejects.toThrow(IDENTITY_CAPABILITY_MISSING)
		expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
		expect(types()).not.toContain('init')
	}, 15_000)
})
