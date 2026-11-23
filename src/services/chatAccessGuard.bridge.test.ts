/**
 * unit e runtime check: the real chatWorkerBridge and the real chat-sdk negotiation. Only the chat-sdk client factory is replaced
 * by a counting stub (the bridge transport). Every call on the client, and every host signature request, is one bridge request.
 * SYNTHETIC account values only. No network: nodes, RPC and IPFS are not reached.
 */
/**
 * Jest (CJS) cannot parse `import.meta.url` in chatWorkerBridge.ts (the worker URL in makeGossipWorker, never run here).
 * The factory loads the real bridge source: only that expression is replaced, then the file is transpiled to CJS.
 * Its imports resolve from this directory, so the real bridge code and its real dependencies run.
 */
jest.mock('./chatWorkerBridge', () => {
	const fs = jest.requireActual<typeof import('fs')>('fs')
	const path = jest.requireActual<typeof import('path')>('path')
	const ts = jest.requireActual<typeof import('typescript')>('typescript')
	const file = path.join(__dirname, 'chatWorkerBridge.ts')
	const src = fs.readFileSync(file, 'utf8').replace(/import\.meta\.url/g, JSON.stringify('file:///chat-sdk-gossip-test-only'))
	const js = ts.transpileModule(src, {
		fileName: file,
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
	}).outputText
	const mod = { exports: {} as Record<string, unknown> }
	new Function('require', 'module', 'exports', js)(require, mod, mod.exports)
	return mod.exports
})

/** openpgp is not used on the refused path; its CJS build fails to load under Jest here, so the names chat.ts imports are stubbed. */
jest.mock('openpgp', () => ({
	generateKey: async () => undefined,
	readKey: async () => undefined,
	createMessage: async () => undefined,
	encrypt: async () => undefined,
	enums: {},
}))

/** 模块加载桩：argon2 worker bridge 含 `import.meta.url`（Jest CJS 无法加载）。不在被测聊天路径上，不提供 argon2idAsync。 */
jest.mock('@/services/argon2WorkerBridge', () => ({}))

/** The beamioTag worker client uses `import.meta.url` (Jest CJS cannot load it). Not on the chat path under test: names are no-ops. */
jest.mock('@/workers/beamioTag/client', () => {
	const noop = function () {
		return undefined
	}
	return new Proxy({ __esModule: true } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : noop) })
})

/** Delivery-receipt bookkeeping is not under test; the module loads the vendored SDK (import.meta), so it is stubbed. */
jest.mock('../utils/chatDeliveryReceipt', () => ({
	isMailboxAckSent: () => false,
	noteMailboxAckSent: () => undefined,
}))

// jsdom has no TextEncoder/TextDecoder; the beamio module reads them at load.
Object.assign(globalThis, { TextEncoder: require('util').TextEncoder, TextDecoder: require('util').TextDecoder })

const mockBridgeRequests: string[] = []
const mockRec = <A extends unknown[], R>(name: string, impl: (...a: A) => R) => (...a: A): R => {
	mockBridgeRequests.push(name)
	return impl(...a)
}

const mockOverrides: Record<string, unknown> = {
	'history.read': mockRec('history.read', async () => [{ id: 'h1' }]),
	'history.openConversation': mockRec('history.openConversation', async () => ({ source: 'local', items: [{ id: 'm1' }], olderState: 'none' })),
	'history.loadOlder': mockRec('history.loadOlder', async () => null),
	'history.load': mockRec('history.load', async () => undefined),
	'history.append': mockRec('history.append', async () => undefined),
	sendGroupMessage: mockRec('sendGroupMessage', async () => ({ ok: true })),
	sendMessage: mockRec('sendMessage', async () => undefined),
}

/** Any property of the stub is callable; each call is recorded. Overrides above give the answers the bridge reads. */
const mockMakeCountingClient = (path: string[] = []): unknown =>
	new Proxy(function () {}, {
		get: (_t, k) => {
			if (typeof k === 'symbol' || k === 'then') return undefined
			const p = [...path, String(k)].join('.')
			if (p in mockOverrides) return mockOverrides[p]
			return mockMakeCountingClient([...path, String(k)])
		},
		apply: (_t, _self, _args) => {
			mockBridgeRequests.push(path.join('.') || 'client')
			return Promise.resolve(undefined)
		},
	})

/**
 * The vendored chat-sdk uses `import.meta.url` too (Jest CJS cannot load it). Only the names the bridge calls at run time are
 * provided; the client factory is the counting stub. Unknown names are no-ops.
 */
jest.mock('@conet.project/chat-sdk', () => {
	const impl: Record<string, unknown> = {
		negotiateChatDaemon: () => ({ status: 'legacy', capabilities: [] }),
		hasCapability: () => false,
		createBeamioChatClient: () => mockMakeCountingClient(),
	}
	const noop = () => undefined
	return new Proxy(impl, {
		get: (t, k) => (k === '__esModule' ? true : k in t ? t[k as string] : noop),
	})
})

const ACCT_A = '0x1111111111111111111111111111111111111111'
const ACCT_B = '0x2222222222222222222222222222222222222222'

const flush = async (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** Starts the real browser listen path with the counting client; resolves when the bridge holds the client. */
async function startBridge(bridge: typeof import('./chatWorkerBridge'), signAccount: jest.Mock) {
	const ctl = new AbortController()
	void bridge.startWorkerGossipListen({
		ownRouteArmoredPublicKey: 'SYNTHETIC-ROUTE',
		eoaAddress: ACCT_A,
		signAccount,
		pgpPublicKeyArmored: 'SYNTHETIC-PGP-PUB',
		pgpPrivateKeyArmored: 'SYNTHETIC-PGP-PRIV',
		nodes: [],
		rootSignal: ctl.signal,
		onLine: () => undefined,
	} as never).catch(() => false)
	for (let i = 0; i < 50 && !bridge.isWorkerGossipActive(); i++) await flush(10)
	// the start sequence ends with the daemon handshake (client.hello after init). It is startup, not a chat request: wait for it.
	for (let i = 0; i < 50 && !mockBridgeRequests.includes('hello'); i++) await flush(10)
	await flush(20)
	mockBridgeRequests.length = 0
}

beforeEach(() => {
	mockBridgeRequests.length = 0
	jest.spyOn(console, 'warn').mockImplementation(() => undefined)
	jest.spyOn(console, 'info').mockImplementation(() => undefined)
	jest.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
	jest.restoreAllMocks()
})

describe('chat bridge access guard (real chatWorkerBridge, counting client)', () => {
	test('unlocked: history read and local read reach the bridge', async () => {
		jest.resetModules()
		const guard = require('./passcode/chatAccessGuard')
		const bridge = require('./chatWorkerBridge')
		guard.unlockChatAccess(ACCT_A)
		await startBridge(bridge, jest.fn(async () => '0xsig'))
		expect(bridge.isWorkerGossipActive()).toBe(true)
		mockBridgeRequests.length = 0

		const entries = await bridge.readDecryptedChatHistory({})
		expect(entries).toEqual([{ id: 'h1' }])
		const local = await bridge.readLocalChatHistory('0xpeer', { rootFontSizePx: 16, innerWidth: 400, innerHeight: 800 })
		expect(local.kind).toBe('page')
		expect(mockBridgeRequests).toEqual(['history.read', 'history.openConversation'])
	})

	test('locked: no read, no load, no send and zero bridge requests', async () => {
		jest.resetModules()
		const guard = require('./passcode/chatAccessGuard')
		const bridge = require('./chatWorkerBridge')
		guard.unlockChatAccess(ACCT_A)
		const signAccount = jest.fn(async () => '0xsig')
		await startBridge(bridge, signAccount)
		expect(bridge.isWorkerGossipActive()).toBe(true)

		guard.lockChatAccess()
		mockBridgeRequests.length = 0
		signAccount.mockClear()

		expect(await bridge.readDecryptedChatHistory({})).toBeNull()
		expect(await bridge.searchDecryptedChatHistory('needle')).toBeNull()
		expect(await bridge.openLocalChatPage('0xpeer', { rootFontSizePx: 16, innerWidth: 400, innerHeight: 800 })).toBeNull()
		expect(await bridge.readLocalChatHistory('0xpeer', { rootFontSizePx: 16, innerWidth: 400, innerHeight: 800 })).toEqual({ kind: 'not_ready' })
		expect(await bridge.loadOlderLocalChatPage('0xpeer', 'c', { rootFontSizePx: 16, innerWidth: 400, innerHeight: 800 })).toBeNull()
		await expect(bridge.loadWorkerHistory({})).resolves.toBeUndefined()
		await expect(bridge.sendWorkerGroupMessage({} as never)).rejects.toThrow('Chat is locked')
		expect(await bridge.sendChatViaNativeDaemon({ address: '', userPublicKeyArmored: 'x', routerArmoredPublicKey: 'y' } as never, 'hi')).toBe(false)
		await flush(30)

		expect(mockBridgeRequests).toEqual([])
		expect(signAccount).not.toHaveBeenCalled()
	})

	test('locked: chat sendMessage is refused before signing, zero bridge requests', async () => {
		jest.resetModules()
		const guard = require('./passcode/chatAccessGuard')
		const bridge = require('./chatWorkerBridge')
		const chat = require('./chat')
		guard.unlockChatAccess(ACCT_A)
		const signAccount = jest.fn(async () => '0xsig')
		await startBridge(bridge, signAccount)
		guard.lockChatAccess()
		mockBridgeRequests.length = 0
		const sent = await chat.sendMessage(
			'SYNTHETIC-PGP-PUB',
			'SYNTHETIC-TEXT',
			'SYNTHETIC-PRIV',
			[{ domain: 'synthetic.invalid' }] as never,
			{ recipientRouteArmored: 'SYNTHETIC-ROUTE' },
		)
		expect(sent).toBe(false)
		expect(mockBridgeRequests).toEqual([])
		expect(signAccount).not.toHaveBeenCalled()
	})

	test('after unlock: access resumes', async () => {
		jest.resetModules()
		const guard = require('./passcode/chatAccessGuard')
		const bridge = require('./chatWorkerBridge')
		guard.unlockChatAccess(ACCT_A)
		await startBridge(bridge, jest.fn(async () => '0xsig'))
		guard.lockChatAccess()
		expect(await bridge.readDecryptedChatHistory({})).toBeNull()
		mockBridgeRequests.length = 0

		guard.unlockChatAccess(ACCT_A)
		const entries = await bridge.readDecryptedChatHistory({})
		expect(entries).toEqual([{ id: 'h1' }])
		expect(mockBridgeRequests).toEqual(['history.read'])
	})

	test('account switch: A unlock does not open reads for B; reload starts locked-free with no record', async () => {
		jest.resetModules()
		const guard = require('./passcode/chatAccessGuard')
		const bridge = require('./chatWorkerBridge')
		guard.unlockChatAccess(ACCT_A)
		await startBridge(bridge, jest.fn(async () => '0xsig'))
		guard.clearChatAccessState(true)
		mockBridgeRequests.length = 0
		expect(await bridge.readDecryptedChatHistory({})).toBeNull()
		expect(mockBridgeRequests).toEqual([])

		guard.unlockChatAccess(ACCT_B)
		expect(guard.getChatAccessState().unlockedAccount).toBe(ACCT_B)
		expect(await bridge.readDecryptedChatHistory({})).toEqual([{ id: 'h1' }])
	})
})
