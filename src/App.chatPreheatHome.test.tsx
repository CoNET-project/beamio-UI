/**
 * A page-record entry comes back before the App init's own storage read, and that read ends empty. The entry's wake-up
 * must not be lost: the init runs again and the bar and its search show, and the chat starts once. Real App and entry gate; the native
 * bridge, the storage and the chat start are stubs. SYNTHETIC values only.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const mockLogs: string[] = []
// page-store write calls that pass the session write gate (the real gate decision, consultPageWriteGate): the no-write assertions count them
const mockWrites: { n: number } = { n: 0 }
// the page record bytes: a save that passes the gate rewrites them (the hold assertions compare these bytes before and after)
const mockStored: { bytes: string } = { bytes: '' }
// removal calls (the no-clear assertions): the page store's delete-like exports (wrapped in the mock below) and the browser storage removeItem / clear
const mockDeletes: { n: number } = { n: 0 }
const mockCountDeletes = (actual: Record<string, unknown>) => Object.fromEntries(Object.keys(actual).filter((k) => /delete|remove|clear|wipe|erase/i.test(k) && typeof actual[k] === 'function').map((k) => [k, (...a: unknown[]) => { mockDeletes.n += 1; return (actual[k] as (...x: unknown[]) => unknown)(...a) }]))
const mockStorageSpies: { remove?: jest.SpyInstance; clear?: jest.SpyInstance } = {}
const deleteCalls = (): number => mockDeletes.n + (mockStorageSpies.remove?.mock.calls.length ?? 0) + (mockStorageSpies.clear?.mock.calls.length ?? 0)
// the scenario's state: page copy (IndexedDB read) and native answers. FIXTURE values only.
const mockPage: { copy: any } = { copy: { status: 'empty' } }
// the EOA the page mnemonic derives (real value for the standard phrase is 0x9858...; R2 uses a different one)
const mockDerived: { eoa: string } = { eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94' }
// '' simulates a derivation failure (the real validMnemonicEoa returns '' on any error)
const mockNative: { preread: any; walletState: string; hasKey: any; walletStatus: string } = { preread: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' }
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

/** A synthetic account record with a local mnemonic (a not-key-only account), as the storage read returns it. */
const mockRecord = {
	profiles: [{ keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }],
	// a valid BIP39 phrase (1423/1428: the account evidence is a valid mnemonic; this is the standard test phrase, not a real wallet)
	mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
	beamio: { accountName: 'synthtag' },
	isReady: true,
}

/** The App's first storage read is held until the test releases it (empty); later reads return the record. */
const mockRace: { storageCalls: number; releaseFirstRead?: (v: unknown) => void } = { storageCalls: 0 }
/** the first page read of a start, when it differs from the page copy (0.53.44 open point (a): the page first read is confirmed empty) */
const mockFirst: { copy: any } = { copy: null }
/** the record the storage read returns when a scenario sets it (browser key-only copy); null = the account record */
const mockStorageRead: { record: any } = { record: null }
/** the record the read-back of a restore write returns (0.53.44) */
const mockReadBack: { record: any } = { record: null }

// the shell switch is read at call time (the factories are hoisted above this file's constants)
jest.mock('@/services/shellContext', () => ({ isShellContext: () => (globalThis as { __gateShell?: boolean }).__gateShell !== false }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => (globalThis as { __gateShell?: boolean }).__gateShell !== false,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
	hasNativeWalletListApi: () => false,
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (_level: string, message: string) => { mockLogs.push(String(message)) } }))

// The daemon context: a small real store with the flags the bar reads. Everything else is a no-op function.
jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/providers/DaemonProvider', () => {
	const React = require('react')
	const Ctx = React.createContext(null)
	function DaemonProvider({ children }: { children: unknown }) {
		const [isInitialLoading, setIsInitialLoading] = React.useState(false)
		const [showFooter, setShowFooter] = React.useState(true)
		const [profiles, setProfiles] = React.useState([])
		const value = new Proxy({ isInitialLoading, setIsInitialLoading, showFooter, setShowFooter, profiles, setProfiles, hasNewVersion: false, darkModle: false, messageCount: 0, chatSearchOpen: false, scanData: '', scanIntent: '', exchangeRates: { CAD: 1.35, USDC: 1 }, usdcRates: { CAD: 1.35, USDC: 1 }, currencyRates: { CAD: 1.35, USDC: 1 }, currencyData: { CAD: 1.35, USDC: 1 } }, {
			get: (t: any, k: string) => (k in t ? t[k] : /^(set|on|handle|open|close|show|hide|toggle|reset|clear|navigate|dispatch|track|notify|register|stash|remove|add|update|refresh|load|sync|bind|push|mark)/.test(k) ? jest.fn() : /(Input|Text|Value|Link|Url|Tag|Address|Name|Code|Key|Id|Eoa|Memo|Note|Query|Search)$/.test(k) ? '' : /(s|List|Items|Records)$/.test(k) ? [] : /(rate|Rate|oracle|Oracle|price|Price|fx)/.test(k) ? {} : /(Data|Details|Snapshot|Balances|Map|Record|Cache|Status)$/.test(k) ? {} : undefined),
		})
		return React.createElement(Ctx.Provider, { value }, children)
	}
	return { DaemonProvider, useDaemonContext: () => React.useContext(Ctx) }
})

// Storage: the App's first read is held (then empty); the gate's read and the later App reads return the record.
// jsdom cannot run ethers' derivation (cross-realm Buffer); the real hasValidMnemonic is tested in the node environment.
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasValidMnemonic: (d: { mnemonicPhrase?: unknown } | null | undefined) => Boolean(d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim()),
	// the page's valid mnemonic derives this EOA (the standard test phrase; the derivation itself is covered in the node tests)
	validMnemonicEoa: (d: { mnemonicPhrase?: unknown } | null | undefined) => (d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim() ? mockDerived.eoa : ''),
}))
// the BIP-39 shape check runs ethers (not in jsdom): the phrase shape is checked here, the checksum is covered in the node tests
jest.mock('@/services/walletCredential', () => ({
	...jest.requireActual('@/services/walletCredential'),
	isMnemonicPhrase: (v: unknown) => typeof v === 'string' && /^[a-z]+( [a-z]+)*$/.test(v) && [12, 24].includes(v.split(' ').length),
}))
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	...mockCountDeletes(jest.requireActual('@/services/beamio')),
	checkStorageWithStatusWithTimeout: async () => mockPage.copy, // 0.53.39: jsdom has no IndexedDB; the page copy is confirmed empty unless the test sets it
	checkStorage: () => {
		mockRace.storageCalls += 1
		if (mockRace.storageCalls === 1) return new Promise((r) => { mockRace.releaseFirstRead = r })
		return Promise.resolve(mockStorageRead.record ? { status: 'loaded', data: mockStorageRead.record } : mockRecord)
	},
	checkStorageWithTransientRetry: () => Promise.resolve(mockFirst.copy ?? mockPage.copy),
	// 0.53.44: the read-back of a restore write (AppEntryGate, after the write)
	readStoredRecordForVerify: async () => mockReadBack.record,
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	// 0.53.44: the real gate decides (consultPageWriteGate, the same state AppEntryGate opens and closes); a save that passes writes the page bytes.
	storeSystemData: async () => {
		if (jest.requireActual('@/services/beamio').consultPageWriteGate('app_save')) { mockWrites.n += 1; mockStored.bytes = JSON.stringify({ written: mockWrites.n }) }
	},
	storeSystemDataAndWait: async () => {
		if (!jest.requireActual('@/services/beamio').consultPageWriteGate('app_save_wait')) return false
		mockWrites.n += 1
		mockStored.bytes = JSON.stringify({ written: mockWrites.n })
		return true
	},
	pageWriteGateStatus: () => jest.requireActual('@/services/beamio').pageWriteGateStatus(),
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => mockPage.copy,
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	// The native wallet has no key for this account: the page record decides (boundary).
	reachNativeWallet: () => Promise.resolve({ status: 'no_key' }),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'not_reported',
	queryNativeWalletStatus: async () => ({ status: mockNative.walletStatus }),
	queryNativePasscodeStatus: async () => ({ walletState: mockNative.walletState, hasKey: mockNative.hasKey }),
	queryNativeWalletStateSafe: async () => 'not_reported',
	queryNativeMnemonicPreread: async () => mockNative.preread,
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }) }))
// Modules that build a worker from import.meta (not loadable under jest here): every export is an inert stub.
jest.mock('@/workers/beamioTag/client', () => mockDeepStub())
jest.mock('@/workers/appDaemon/client', () => mockDeepStub())
// The worker bridge: the history tail completion is controlled by the scenario (the worker and IPFS are not loaded under jest).
const mockTail: { pending: boolean; ok: boolean; calls: number } = { pending: true, ok: true, calls: 0 }
const mockTailWaiters: Array<(ok: boolean) => void> = []
jest.mock('@/services/chatWorkerBridge', () => new Proxy({
	awaitWorkerHistoryTail: () => {
		mockTail.calls += 1
		if (!mockTail.pending) return Promise.resolve(mockTail.ok)
		return new Promise<boolean>((r) => { mockTailWaiters.push(r) })
	},
	readDecryptedChatHistory: async () => null,
}, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/services/argon2WorkerBridge', () => mockDeepStub())
jest.mock('@/services/chatMediaWorkerBridge', () => mockDeepStub())
jest.mock('@dicebear/core', () => ({ createAvatar: () => ({ toDataUri: () => '', toString: () => '' }) }))
jest.mock('@dicebear/collection', () => ({ funEmoji: {}, adventurer: {}, bottts: {} }))
jest.mock('openpgp', () => mockDeepStub())
jest.mock('pdfjs-dist', () => mockDeepStub())
jest.mock('pdfjs-dist/legacy/build/pdf', () => mockDeepStub())
const mockChatStarts: unknown[] = []
const mockPushBinds: unknown[] = []
const mockWorkerStart: { fail: boolean } = { fail: false }
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => { mockChatStarts.push(1); if (mockWorkerStart.fail) throw new Error('start failed'); return undefined }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: (...a: unknown[]) => { mockPushBinds.push(a); return true } }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/components/SplashScreen', () => () => null)
jest.mock('@/components/PasscodeLockScreen', () => () => null)
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
// 0.53.44: the onboarding modal's props are captured, so the restore and creation callbacks can be driven through the real AppEntryGate
const mockOnboarding: { props: any } = { props: null }
jest.mock('@/pages/Home/LoadingPage', () => (props: unknown) => {
	mockOnboarding.props = props
	return null
})

function renderApp() {
	return render(
		<DaemonProvider>
			<MemoryRouter initialEntries={['/home']}>
				<App />
			</MemoryRouter>
		</DaemonProvider>,
	)
}

function resetScenario() {
	;(globalThis as { __gateShell?: boolean }).__gateShell = true
	mockDeletes.n = 0
	// fresh call-through spies per scenario (the jest config resets mocks before each test)
	mockStorageSpies.remove?.mockRestore()
	mockStorageSpies.clear?.mockRestore()
	mockStorageSpies.remove = jest.spyOn(Storage.prototype, 'removeItem')
	mockStorageSpies.clear = jest.spyOn(Storage.prototype, 'clear')
	mockReadBack.record = mockRecord
	mockFirst.copy = null
	mockStorageRead.record = null
	mockWrites.n = 0
	mockStored.bytes = JSON.stringify(mockRecord)
	mockLogs.length = 0
	mockChatStarts.length = 0
	mockRace.storageCalls = 0
	mockRace.releaseFirstRead = undefined
}


// App-level (browser runtime, not a shell): the chat preheat starts at account-ready and never blocks the offline home (sdk-roles-chat-preheat.v1 SDR-08, SDR-10).
describe('chat preheat does not block the offline home (browser runtime)', () => {
	const sdkLogs: string[] = []
	let infoSpy: jest.SpyInstance
	beforeEach(async () => {
		await new Promise((r) => setTimeout(r, 900))
		resetScenario()
		;(globalThis as { __gateShell?: boolean }).__gateShell = false
		// browser: the page copy (IndexedDB) holds the valid account record; the first storage read is not held
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockFirst.copy = { status: 'loaded', data: mockRecord }
		mockRace.storageCalls = 1
		mockTail.pending = true
		mockTail.ok = true
		mockTail.calls = 0
		mockTailWaiters.length = 0
		mockWorkerStart.fail = false
		mockChatStarts.length = 0
		sdkLogs.length = 0
		const { resetChatPreheatForTest } = require('@/services/chatPreheat')
		resetChatPreheatForTest()
		infoSpy = jest.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { if (String(a[0]).startsWith('[sdk] preheat')) sdkLogs.push(String(a[0])) })
	})
	afterEach(() => {
		infoSpy.mockRestore()
	})

	it('(+) the tail is pending: the app renders and the wallet path proceeds; the preheat is requested, not failed', async () => {
		renderApp()
		await new Promise((r) => setTimeout(r, 1500))
		await waitFor(() => expect(mockLogs.some((m) => m.includes('[AppShell] init proceeding'))).toBe(true))
		expect(sdkLogs).toContain('[sdk] preheat state=requested ms=' + sdkLogs[0]?.split('ms=')[1])
		expect(mockTail.calls).toBe(1)
		expect(sdkLogs.some((l) => l.includes('state=failed'))).toBe(false)
		// the preheat's worker start and the App's own later start both call initChat here; the real initChat skips a second start while gossip is active
		expect(mockChatStarts.length).toBeGreaterThanOrEqual(1)
		expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0)
	})

	it('(+) the tail fails: the app still renders the home path; the preheat is failed and logs a code only', async () => {
		mockTail.pending = false
		mockTail.ok = false
		renderApp()
		await waitFor(() => expect(sdkLogs.some((l) => l.includes('state=failed'))).toBe(true))
		expect(mockLogs.some((m) => m.includes('[AppShell] init proceeding'))).toBe(true)
		expect(sdkLogs.every((l) => /^\[sdk\] preheat state=(requested|ready|failed) ms=\d+$/.test(l))).toBe(true)
	})

	it('(+) the worker start throws: the preheat is failed, the wallet path still proceeds', async () => {
		mockWorkerStart.fail = true
		renderApp()
		await waitFor(() => expect(sdkLogs.some((l) => l.includes('state=failed'))).toBe(true))
		expect(mockLogs.some((m) => m.includes('[AppShell] init proceeding'))).toBe(true)
	})
})
