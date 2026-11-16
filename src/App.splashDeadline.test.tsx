/**
 * Splash deadline races (0.53.5): a native decision before the 12 s timer, the timer first (the retry screen), a native
 * store that is not ready twice, and a Retry after a timeout. The real App and entry gate run; the native bridge, the
 * storage and the chat start are stubs. SYNTHETIC values only.
 *
 * Each case loads App from a fresh module registry (jest.resetModules in beforeEach). Without it, module-level state of
 * the app (the identity capability in services/nativeIdentityProbeRetry, the shell record transport, and the native wallet
 * hints) survives from an earlier case and the later cases see a stale App state. Reproduced by merging the cases into one
 * file without the reset: the timer-first and the Retry cases fail.
 */
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })

const EOA = '0x1111111111111111111111111111111111111111'

// Controlled by each case: how the App's storage read ends, and when the native wallet arrives.
const race: { caps: string[]; storage: 'null' | 'late-null'; storageResolve?: (v: unknown) => void; nativeResolve?: (v: unknown) => void; releaseStorage?: () => void; nativeImmediate?: unknown; reads: number; notReady: boolean } = { caps: [], storage: 'null', reads: 0, notReady: false }

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

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

// Storage: the App's read and the gate's read both end the same way for a case.
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	checkStorage: () => (race.storage === 'null' ? Promise.resolve(null) : new Promise((r) => { race.releaseStorage = () => r(null) })),
	checkStorageWithTransientRetry: () => (race.storage === 'null' ? Promise.resolve({ status: 'unavailable', reason: 'invalid_document' }) : new Promise((r) => { race.releaseStorage = () => r({ status: 'unavailable', reason: 'invalid_document' }) })),
	checkStorageWithStatusWithTimeout: async () => { race.reads += 1; return race.notReady && race.reads <= 2 ? { status: 'unavailable', reason: 'native_retry' } : { status: 'empty' } },
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	storeSystemData: async () => undefined,
	storeSystemDataAndWait: async () => undefined,
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => ({ status: 'empty' }),
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	reachNativeWallet: () => (race.nativeImmediate ? Promise.resolve(race.nativeImmediate) : new Promise((r) => { race.nativeResolve = r })),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'present',
	queryNativeWalletStateSafe: async () => 'present',
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: race.caps }) }))
// Modules that build a worker from import.meta (not loadable under jest here): every export is an inert stub.
jest.mock('@/workers/beamioTag/client', () => mockDeepStub())
jest.mock('@/workers/appDaemon/client', () => mockDeepStub())
jest.mock('@/services/chatWorkerBridge', () => mockDeepStub())
jest.mock('@/services/argon2WorkerBridge', () => mockDeepStub())
jest.mock('@/services/chatMediaWorkerBridge', () => mockDeepStub())
jest.mock('@dicebear/core', () => ({ createAvatar: () => ({ toDataUri: () => '', toString: () => '' }) }))
jest.mock('@dicebear/collection', () => ({ funEmoji: {}, adventurer: {}, bottts: {} }))
jest.mock('openpgp', () => mockDeepStub())
jest.mock('pdfjs-dist', () => mockDeepStub())
jest.mock('pdfjs-dist/legacy/build/pdf', () => mockDeepStub())
const mockChatStarts: unknown[] = []
const mockAaEnsures: unknown[] = []
const mockPushBinds: unknown[] = []
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => { mockChatStarts.push(1) }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: (...a: unknown[]) => { mockAaEnsures.push(a); return Promise.resolve() } }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: (...a: unknown[]) => { mockPushBinds.push(a); return true } }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/components/SplashScreen', () => () => null)
jest.mock('@/components/PasscodeLockScreen', () => () => null)
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
jest.mock('@/pages/Home/LoadingPage', () => () => null)


// Fresh registry per case: React and Testing Library are loaded from the same registry as App, so hooks share one React.
// Auto-cleanup is off; each case unmounts its own tree in the afterEach below, before the next registry is loaded.
process.env.RTL_SKIP_AUTO_CLEANUP = 'true'
let rtl: any
let act: any
let screen: any
let waitFor: any
let render: any
let MemoryRouter: any
let App: any
let DaemonProvider: any
function loadFresh() {
	jest.resetModules()
	rtl = require('@testing-library/react')
	act = rtl.act
	screen = rtl.screen
	waitFor = rtl.waitFor
	render = rtl.render
	MemoryRouter = require('react-router-dom').MemoryRouter
	App = require('./App').default
	DaemonProvider = require('@/providers/DaemonProvider').DaemonProvider
}
afterEach(() => {
	rtl?.cleanup()
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

const SPLASH_MS = 12_000
const RETRY_TITLE = 'native_not_ready_retry_title'
const RETRY_ACTION = 'native_not_ready_retry_action'
const MIGRATION_TITLE = 'migration_retry_title'

describe('splash deadline race: decision first (a native decision before the 12 s timer)', () => {
	beforeEach(() => {
		loadFresh()
		jest.useFakeTimers()
		race.caps = []
		race.storage = 'null'
		race.nativeResolve = undefined
		race.nativeImmediate = undefined
		race.reads = 0
		race.notReady = false
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('decision first, then the 12 s timer: the home stays, no retry screen, state unchanged', async () => {
		renderApp()
		await act(async () => { jest.advanceTimersByTime(1) })
		await waitFor(() => expect(race.nativeResolve).toBeDefined())
		await act(async () => { race.nativeResolve?.({ status: 'unlocked', eoa: EOA }) })
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		await act(async () => { jest.advanceTimersByTime(SPLASH_MS + 1000) })
		expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

describe('splash deadline race: timer first (no decision by 12 s; the retry screen shows; a later decision enters the home)', () => {
	beforeEach(() => {
		loadFresh()
		jest.useFakeTimers()
		race.caps = []
		race.storage = 'null'
		race.nativeResolve = undefined
		race.nativeImmediate = undefined
		race.reads = 0
		race.notReady = false
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('timer first (no decision by 12 s): the retry state shows; a later decision enters the home and the retry state goes', async () => {
		renderApp()
		await act(async () => { jest.advanceTimersByTime(1) })
		await waitFor(() => expect(race.nativeResolve).toBeDefined())
		await act(async () => { jest.advanceTimersByTime(SPLASH_MS + 1000) })
		expect(screen.getByText(RETRY_TITLE)).toBeTruthy()
		await act(async () => { race.nativeResolve?.({ status: 'unlocked', eoa: EOA }) })
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

describe('splash deadline race: the native store not ready twice, then ok (end to end, the home is entered; no migration screen)', () => {
	beforeEach(() => {
		loadFresh()
		jest.useFakeTimers()
		race.caps = []
		race.storage = 'null'
		race.nativeResolve = undefined
		race.nativeImmediate = undefined
		race.reads = 0
		race.notReady = false
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('the native store is not ready twice, then ok: the home is entered end to end, no migration screen', async () => {
		race.notReady = true
		race.caps = ['identity.native-keys.v1']
		race.nativeImmediate = { status: 'unlocked', eoa: EOA }
		renderApp()
		for (let i = 0; i < 6 && race.reads < 3; i += 1) {
			await act(async () => { jest.advanceTimersByTime(60_000) })
		}
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy(), { timeout: 5000 })
		expect(race.reads).toBe(3)
		expect(screen.queryByText(MIGRATION_TITLE)).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

describe('splash deadline race: timeout, then Retry once the identity is declared (the home is entered, once)', () => {
	beforeEach(() => {
		loadFresh()
		jest.useFakeTimers()
		race.caps = []
		race.storage = 'null'
		race.nativeResolve = undefined
		race.nativeImmediate = undefined
		race.reads = 0
		race.notReady = false
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('timeout, then the user taps Retry once the identity is declared: the home is entered, once', async () => {
		renderApp()
		await act(async () => { jest.advanceTimersByTime(1) })
		await waitFor(() => expect(race.nativeResolve).toBeDefined())
		await act(async () => { jest.advanceTimersByTime(SPLASH_MS + 1000) })
		expect(screen.getByText(RETRY_TITLE)).toBeTruthy()
		race.caps = ['identity.native-keys.v1']
		race.nativeResolve = undefined
		await act(async () => { screen.getByText(RETRY_ACTION).click() })
		await waitFor(() => expect(race.nativeResolve).toBeDefined())
		await act(async () => { race.nativeResolve?.({ status: 'unlocked', eoa: EOA }) })
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})
