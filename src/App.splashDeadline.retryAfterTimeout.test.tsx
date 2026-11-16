/**
 * Splash deadline races (0.53.5): a decision before or after the 12 s timer, and a Retry after a timeout. Same harness as
 * App.shellEntryRace.timeout.test (real App and entry gate; the bridge and storage are stubs). The 12 s timer runs on fake timers.
 * (Unused header text follows.) (A + B): the shell startup race (case: no record, or a failed read). A shell whose account is not in the storage read at App's init (no record, a failed
 * read, a timeout, or a record that cannot be read) must still show the global bar once the native wallet is applied. Before the fix the
 * init set the loading flag and returned, and nothing cleared it, so the bar and its search stayed hidden. Real App and entry gate; the
 * native bridge, the storage and the chat start are replaced by stubs. SYNTHETIC values only.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

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

describe('splash deadline race: timeout, then Retry once the identity is declared (the home is entered, once)', () => {
	beforeEach(() => {
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
