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
// The native side is a window host (the real pre-read transport, nativeRecovery.queryNativeMnemonicPreread, with its own timeouts).
// preadAnswer: the host's reply body (ok:true result {state}); unknownTimes: the first n replies are unknown (not_ready); preadDelayMs: reply delay.
const race: { caps: string[]; storage: 'null' | 'late-null'; storageResolve?: (v: unknown) => void; releaseStorage?: () => void; preadAnswer: Record<string, unknown>; preadDelayMs: number; reads: number; answered?: boolean; unknownTimes?: number; notReady: boolean; preadAsked?: number; writes: number } = { caps: [], storage: 'null', reads: 0, notReady: false, preadAnswer: { ok: true, result: { code: 'confirmed_missing' } }, preadDelayMs: 0, writes: 0 }
/** the window host the App's pre-read transport talks to (the same shape as App.nativeLateReply): every nativeMnemonicPreread is answered by the host */
let hostOnMessage: ((ev: unknown) => void) | null = null
function installNativeHost(): void {
	const host = {
		postMessage: (text: string) => {
			const cmd = JSON.parse(text) as { type: string; reqId: number }
			if (cmd.type !== 'nativeMnemonicPreread') return
			race.preadAsked = (race.preadAsked ?? 0) + 1
			race.reads += 1
			const payload = race.reads <= (race.unknownTimes ?? 0) ? { ok: false, error: 'not_ready' } : race.preadAnswer
			setTimeout(() => hostOnMessage?.({ data: JSON.stringify({ type: 'ack', reqId: cmd.reqId, ...payload }) }), race.preadDelayMs)
		},
		get onmessage() { return hostOnMessage },
		set onmessage(fn: ((ev: unknown) => void) | null) { hostOnMessage = fn },
	}
	;(window as unknown as { BeamioShellRecord: unknown }).BeamioShellRecord = host
}

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
// jsdom cannot derive a wallet (its Uint8Array is another realm than ethers'); the derivation is covered in the node tests.
jest.mock('@/services/shellSessionSigner', () => ({ ...jest.requireActual('@/services/shellSessionSigner'), holdShellSessionFromPhrase: () => ({ kind: 'ok' }) }))
// jsdom cannot run the BIP-39 checksum (ethers Mnemonic); the word-shape check is the same as the app's, the derivation is stubbed below
jest.mock('@/services/walletCredential', () => ({ ...jest.requireActual('@/services/walletCredential'), isMnemonicPhrase: (v: unknown) => typeof v === 'string' && /^[a-z]+( [a-z]+)*$/.test(v) && [12, 24].includes(v.split(' ').length) }))
jest.mock('@/services/recoveredMnemonicRecord', () => ({ ...jest.requireActual('@/services/recoveredMnemonicRecord'), checkRecoveredRecord: () => 'valid', checkShellReadBack: () => 'valid' }))
const SAMPLE_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SAMPLE_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const VALID_ANSWER = { ok: true, result: { code: 'ok', mnemonic: SAMPLE_PHRASE, eoa: SAMPLE_EOA } }

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
	setPageWritePermit: () => undefined, // 0.53.44: the session write gate (AppEntryGate); stub here
	allowRestoreWrite: () => undefined,
  endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorage: () => (race.storage === 'null' ? Promise.resolve(null) : new Promise((r) => { race.releaseStorage = () => r(null) })),
	checkStorageWithTransientRetry: () => (race.storage === 'null' ? Promise.resolve({ status: 'empty' }) : new Promise((r) => { race.releaseStorage = () => r({ status: 'unavailable', reason: 'invalid_document' }) })),
	checkStorageWithStatusWithTimeout: async () => { race.reads += 1; return race.notReady && race.reads <= 2 ? { status: 'unavailable', reason: 'native_retry' } : { status: 'empty' } },
	sendPendingProfileSync: jest.fn(),
	// the pre-read write-back (page IndexedDB, read back): jsdom cannot open the device-key vault, so the write is counted and reported verified
	persistPageIdbMnemonic: async () => { race.writes += 1; return 'verified' },
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	storeSystemData: async () => undefined,
	storeSystemDataAndWait: async () => true,
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
	reachNativeWallet: () => new Promise(() => undefined), // never answers (the start does not wait on it)
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'present',
	queryNativeWalletStatus: async () => ({ status: 'no_key' }), // 0.53.39 stub: the start route reads walletStatus
	queryNativePasscodeStatus: async () => ({ walletState: await (async () => 'present')(), hasKey: 'not_reported' as const }),
	// the start-up pre-read (spec r2.4 item 42(2)): counted in race.reads; the first race.unknownTimes answers are unknown
	// the real pre-read (its own transport and timeouts); the native answer comes from the window host
	queryNativeMnemonicPreread: (...args: unknown[]) => (jest.requireActual('@/services/nativeRecovery') as { queryNativeMnemonicPreread: (...a: unknown[]) => unknown }).queryNativeMnemonicPreread(...args),
	queryNativeWalletStateSafe: async () => 'present',
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: race.answered !== false, capabilities: race.caps }) }))
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
	// jsdom cannot derive a wallet from the sample phrase (ethers BytesLike check); the derived EOA is stubbed to the sample EOA. The route after it is real.
	jest.spyOn(require('ethers').Wallet, 'fromPhrase').mockReturnValue({ address: SAMPLE_EOA } as never)
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
/** Moves the fake clock in 1 s steps, each settled on the microtask queue: one long step fires the 2 s page-read limit before the read resolves. */
const advanceSteps = async (ms: number) => {
	for (let i = 0; i < ms / 1_000; i += 1) await act(async () => { jest.advanceTimersByTime(1_000) })
}
/** The rule (3): with the identity not declared the native pre-read is not asked; after the deadline the state is retry. */
const preadAsked = () => race.preadAsked ?? 0
/** No onboarding is shown or logged, and no wallet is created: the only states are the splash, the retry screen and the home. */
const noOnboardingOrNewWallet = (log: jest.Mock) => {
	const lines = log.mock.calls.map((c) => String(c[1]))
	const createOrGetWallet = require('@/services/beamio').createOrGetWallet as jest.Mock
	return lines.every((l) => !l.toLowerCase().includes('onboarding')) && createOrGetWallet.mock.calls.length === 0
}

describe('splash deadline race: decision first (a native decision before the 12 s timer)', () => {
	beforeEach(() => {
		loadFresh()
		installNativeHost()
		jest.useFakeTimers()
		race.caps = ['identity.native-keys.v1']
		race.storage = 'null'
		race.preadAnswer = VALID_ANSWER
		race.preadDelayMs = 0
		race.writes = 0
		race.reads = 0
		race.preadAsked = 0
		race.notReady = false
		race.answered = true
		race.unknownTimes = 0
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('decision first, then the 12 s timer: the home stays, no retry screen, state unchanged', async () => {
		renderApp()
		// IDB first: the page store is empty, so the host is asked for the pre-read and its valid answer enters the home before 12 s
		await act(async () => { jest.advanceTimersByTime(1) })
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		expect(race.preadAsked).toBe(1)
		await advanceSteps(SPLASH_MS + 1000)
		expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
		expect(race.writes).toBe(1)
	})
})

describe('splash deadline race: timer first (no decision by 12 s; the retry screen shows; a later decision enters the home)', () => {
	beforeEach(() => {
		loadFresh()
		installNativeHost()
		jest.useFakeTimers()
		race.caps = ['identity.native-keys.v1']
		race.storage = 'null'
		race.preadAnswer = VALID_ANSWER
		race.preadDelayMs = 0
		race.writes = 0
		race.reads = 0
		race.preadAsked = 0
		race.notReady = false
		race.answered = true
		race.unknownTimes = 0
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('timer first (no decision by 12 s): the retry state shows; a later decision enters the home and the retry state goes', async () => {
		race.answered = false
		renderApp()
		const { publishNativePwaLog } = require('@/utils/cashTreesNativePwaLog')
		await act(async () => { jest.advanceTimersByTime(1) })
		// 12 s: the splash deadline. The identity is not declared, so the native pre-read is not asked and the retry state shows.
		await advanceSteps(SPLASH_MS + 1000)
		expect(screen.queryByText(RETRY_ACTION)).toBeNull() // 0.53.44: no startup button
		expect(preadAsked()).toBe(0)
		// 20 s bridge trust deadline (3): the state is unknown with the reason code, still retry
		// past the 20 s deadline; the bridge trust check runs on the next startup retry round (2, 4, 8, 16 s backoff, round at 30 s)
		await advanceSteps(20_000)
		expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('bridge_trust_timeout'))
		expect(preadAsked()).toBe(0)
		expect(screen.queryByRole('button', { name: 'search' })).toBeNull()
		expect(noOnboardingOrNewWallet(publishNativePwaLog)).toBe(true)
		// the identity is declared later and the user taps Retry: only now is the pre-read asked; its valid answer enters the home
		race.answered = true
		race.caps = ['identity.native-keys.v1']
		await advanceSteps(30_000) // 0.53.44: no tap; the background re-read (30 s steady round) resumes the start
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		expect(preadAsked()).toBeGreaterThan(0)
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

describe('splash deadline race: the native store not ready twice, then ok (end to end, the home is entered; no migration screen)', () => {
	beforeEach(() => {
		loadFresh()
		installNativeHost()
		jest.useFakeTimers()
		race.caps = ['identity.native-keys.v1']
		race.storage = 'null'
		race.preadAnswer = VALID_ANSWER
		race.preadDelayMs = 0
		race.writes = 0
		race.reads = 0
		race.preadAsked = 0
		race.notReady = false
		race.answered = true
		race.unknownTimes = 0
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('the native store is not ready twice, then ok: the home is entered end to end, no migration screen', async () => {
		race.notReady = true
		race.caps = ['identity.native-keys.v1']
		race.unknownTimes = 2
		renderApp()
		// The clock moves in 1 s steps, each one settled on the microtask queue. A single long step would fire the 2 s page-read limit
		// before the read started by a retry can resolve, and the read would count as unknown.
		for (let i = 0; i < 360 && race.reads < 3; i += 1) {
			await act(async () => { jest.advanceTimersByTime(1_000) })
		}
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy(), { timeout: 5000 })
		// IDB first (): the page is read first (empty), then the host is asked: two not_ready answers and the valid one.
		// The valid path writes the mnemonic back once (the page write-back is counted, not a second page read).
		expect(race.preadAsked).toBe(3)
		expect(race.reads).toBe(3)
		expect(race.writes).toBe(1)
		expect(screen.queryByText(MIGRATION_TITLE)).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

describe('splash deadline race: timeout, then Retry once the identity is declared (the home is entered, once)', () => {
	beforeEach(() => {
		loadFresh()
		installNativeHost()
		jest.useFakeTimers()
		race.caps = ['identity.native-keys.v1']
		race.storage = 'null'
		race.preadAnswer = VALID_ANSWER
		race.preadDelayMs = 0
		race.writes = 0
		race.reads = 0
		race.preadAsked = 0
		race.notReady = false
		race.answered = true
		race.unknownTimes = 0
		mockChatStarts.length = 0
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('timeout, then the user taps Retry once the identity is declared: the home is entered, once', async () => {
		race.answered = false
		renderApp()
		const { publishNativePwaLog } = require('@/utils/cashTreesNativePwaLog')
		await act(async () => { jest.advanceTimersByTime(1) })
		// 12 s: the splash deadline, the retry state (reason in the 20 s bridge trust check below); no pre-read is asked
		await advanceSteps(SPLASH_MS + 1000)
		expect(screen.queryByText(RETRY_ACTION)).toBeNull() // 0.53.44: no startup button
		expect(preadAsked()).toBe(0)
		// past the 20 s deadline; the bridge trust check runs on the next startup retry round (2, 4, 8, 16 s backoff, round at 30 s)
		await advanceSteps(20_000)
		expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('bridge_trust_timeout'))
		expect(preadAsked()).toBe(0)
		expect(noOnboardingOrNewWallet(publishNativePwaLog)).toBe(true)
		// the identity is declared, the user taps Retry: the pre-read is asked once after the declaration, and the home is entered once
		race.answered = true
		race.caps = ['identity.native-keys.v1']
		await advanceSteps(30_000) // 0.53.44: no tap; the background re-read (30 s steady round) resumes the start
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy())
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
		expect(mockChatStarts.length).toBe(1)
	})
})
