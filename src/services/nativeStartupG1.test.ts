/**
 * @jest-environment node
 *
 * Start-up in a shell with a key that has not been initialised (G1, step 4b). The fake shell is a
 * small gate: before a successful `init` the session is G1, and `provisionIdentity` is refused with `not_ready`; after `init` the
 * session is G2 and `provisionIdentity` is accepted. The test records the state at the time each command was sent.
 * SYNTHETIC identity: the public test vector address, and PGP text made up for this file. No key material is sent.
 */
import { createNativeConetChatClient, initNativeIdentityOnly } from './nativeConetChatTransport'

type Sent = Record<string, unknown>

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const PGP_PUBLIC = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC-PGP-PUBLIC-ONLY\n-----END PGP PUBLIC KEY BLOCK-----'
const HELLO_CAPS = ['identity.native-keys.v1', 'identity.provision', 'inbound.deferAck']

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

/** The fake shell's session state. A new shell (a reload) starts in G1: the key is there, `init` has not run in this session. */
let g2 = false
let sent: Sent[] = []
/** For each provisionIdentity: whether the session was G2 when it was sent (the gate's answer). */
let provisionAcceptedInG2: boolean[] = []
/** For each command: the command type and the session state when it was sent. */
let log: Array<{ type: string; g2: boolean }> = []

function installShell(initOutcome: 'ready' | 'address_mismatch'): void {
	w.CashTreesIOS = {
		chatModuleCommand: (p: { command: Sent }) => {
			const cmd = p.command
			sent.push(cmd)
			log.push({ type: String(cmd.type), g2 })
			const reply = (event: Record<string, unknown>) =>
				setTimeout(
					() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })),
					0,
				)
			if (cmd.type === 'hello') {
				reply({ type: 'ready', reqId: cmd.reqId, result: { protocolVersion: 1, capabilities: HELLO_CAPS } })
			} else if (cmd.type === 'init') {
				if (initOutcome === 'ready') {
					g2 = true
					reply({ type: 'ready', reqId: cmd.reqId, result: { historyApi: 0 } })
				} else {
					reply({ type: 'ack', reqId: cmd.reqId, ok: false, error: 'address_mismatch' })
				}
			} else if (cmd.type === 'provisionIdentity') {
				provisionAcceptedInG2.push(g2)
			}
		},
	}
}

function config() {
	return {
		identity: {
			eoaAddress: EOA,
			pgpPublicKeyArmored: PGP_PUBLIC,
			ownRouteArmoredPublicKey: PGP_PUBLIC,
		},
		conetRpcUrl: 'https://rpc.invalid',
		addressPgpContractAddress: '0x0000000000000000000000000000000000000001',
		getNodes: async () => [{ domain: 'synthetic.node', armoredPublicKey: 'synthetic' }] as never,
		ipfsBaseUrl: 'https://ipfs.invalid',
		apiBaseUrl: 'https://api.invalid',
		chatIndexRegistryAddress: '0x1511Caa71081C84d8a591490D1b83879088EED72',
	} as unknown as Parameters<typeof createNativeConetChatClient>[0]
}

let client: ReturnType<typeof createNativeConetChatClient> | null = null

beforeEach(() => {
	g2 = false
	sent = []
	log = []
	provisionAcceptedInG2 = []
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

describe('G1 start-up: init first, provisionIdentity only once the session is ready', () => {
	it('sends init, and provisionIdentity only after init succeeded (accepted in G2, not refused as not_ready in G1)', async () => {
		installShell('ready')
		client = createNativeConetChatClient(config())
		await client.init()
		const types = log.map((e) => e.type)
		expect(types).toContain('init')
		expect(types).toContain('provisionIdentity')
		expect(types.indexOf('provisionIdentity')).toBeGreaterThan(types.indexOf('init'))
		expect(provisionAcceptedInG2).toEqual([true])
	})

	it('when init is refused (address_mismatch) the session never reaches G2, and provisionIdentity is not sent', async () => {
		installShell('address_mismatch')
		client = createNativeConetChatClient(config())
		await expect(client.init()).rejects.toThrow('address_mismatch')
		expect(log.map((e) => e.type)).not.toContain('provisionIdentity')
		expect(provisionAcceptedInG2).toEqual([])
	})

	it('a start after a reload (G1 again, then init) sends init and provisionIdentity again, and the second is accepted in G2', async () => {
		installShell('ready')
		client = createNativeConetChatClient(config())
		await client.init()
		client.destroy()
		client = null

		// Reload: the shell is still holding the key; this session has not init-ed.
		g2 = false
		log = []
		client = createNativeConetChatClient(config())
		await client.init()
		const types = log.map((e) => e.type)
		expect(types).toContain('init')
		expect(types.filter((t) => t === 'provisionIdentity')).toHaveLength(1)
		expect(provisionAcceptedInG2).toEqual([true, true])
	})
})

describe('identity-only init: EOA only, no route key, no provisionIdentity', () => {
	const identityOnlyConfig = () =>
		({
			...config(),
			identity: { eoaAddress: EOA, pgpPrivateKeyArmored: '', pgpPassphrase: '' },
		}) as unknown as Parameters<typeof createNativeConetChatClient>[0]

	it('sends init whose identity has the EOA only, never provisionIdentity, and succeeds in G2', async () => {
		installShell('ready')
		await expect(initNativeIdentityOnly(identityOnlyConfig())).resolves.toEqual({ ok: true })
		const types = log.map((e) => e.type)
		expect(types).toContain('init')
		expect(types).not.toContain('provisionIdentity')
		const initCmd = sent.find((c) => c.type === 'init') as { payload: { identity: Record<string, unknown> } }
		expect(Object.keys(initCmd.payload.identity)).toEqual(['eoa'])
	})

	it('an identity-only init with no node list omits the nodes key: the native layer keeps its stored nodes, never an empty list', async () => {
		installShell('ready')
		const cfg = { ...identityOnlyConfig(), getNodes: async () => [] } as unknown as Parameters<typeof createNativeConetChatClient>[0]
		await expect(initNativeIdentityOnly(cfg)).resolves.toEqual({ ok: true })
		const initCmd = sent.find((c) => c.type === 'init') as { payload: Record<string, unknown> }
		expect('nodes' in initCmd.payload).toBe(false)
	})

	it('an identity-only init with a listed node set sends that list', async () => {
		installShell('ready')
		const nodes = [{ domain: 'a.example', armoredPublicKey: 'SYNTHETIC-NODE' }]
		const cfg = { ...identityOnlyConfig(), getNodes: async () => nodes } as unknown as Parameters<typeof createNativeConetChatClient>[0]
		await expect(initNativeIdentityOnly(cfg)).resolves.toEqual({ ok: true })
		const initCmd = sent.find((c) => c.type === 'init') as { payload: { nodes?: unknown } }
		expect(initCmd.payload.nodes).toEqual(nodes)
	})

	it('a refused init (address_mismatch) returns the reason; nothing else is sent', async () => {
		installShell('address_mismatch')
		const r = await initNativeIdentityOnly(identityOnlyConfig())
		expect(r).toEqual({ ok: false, reason: 'address_mismatch' })
		expect(log.map((e) => e.type)).not.toContain('provisionIdentity')
	})
})

describe('identity-only client never sends destroy (Android S25 observation, 2026-11-13)', () => {
	const identityOnlyConfig = () =>
		({
			...config(),
			identity: { eoaAddress: EOA, pgpPrivateKeyArmored: '', pgpPassphrase: '' },
		}) as unknown as Parameters<typeof createNativeConetChatClient>[0]

	it('init succeeds: no destroy command is sent', async () => {
		installShell('ready')
		await initNativeIdentityOnly(identityOnlyConfig())
		expect(log.map((e) => e.type)).not.toContain('destroy')
		expect(sent.some((c) => c.type === 'destroy')).toBe(false)
	})

	it('init refused: no destroy command is sent either', async () => {
		installShell('address_mismatch')
		await initNativeIdentityOnly(identityOnlyConfig())
		expect(sent.some((c) => c.type === 'destroy')).toBe(false)
	})

	it('the capability is not declared: nothing is sent at all, and no destroy', async () => {
		w.CashTreesIOS = {
			chatModuleCommand: (p: { command: Sent }) => {
				sent.push(p.command)
				if (p.command.type === 'hello') {
					window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'ready', reqId: p.command.reqId, result: { capabilities: [] } } } }))
				}
			},
		}
		const r = await initNativeIdentityOnly(identityOnlyConfig())
		expect(r.ok).toBe(false)
		expect(sent.some((c) => c.type === 'destroy')).toBe(false)
	})
})
