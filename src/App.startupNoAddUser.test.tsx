/**
 * A start never sends the account to /api/addUser, in the browser and in the shell alike. The locale and currency defaults of an
 * account whose chain record has no setup are display values only; writing them is a user save, never a start. The mount init and the
 * wallet-ready event from the loading page both run a start, so a repeated request would show here too.
 * Covers a browser account, the restart after a recovery, and the shell. Real App and entry gate; the chain read, the storage,
 * the chat start and the native bridge are stubs; the /api/addUser fetch is recorded. SYNTHETIC values only.
 */
import { act, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')
const { chainIdentityRead } = require('@/services/beamio')

const EOA = '0x1111111111111111111111111111111111111111'
/** A synthetic account record with a local mnemonic (a not-key-only account), as the storage read returns it. */
const mockRecord = {
	profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }],
	mnemonicPhrase: 'synthetic words for the cold start test',
	beamio: { accountName: 'synthtag' },
	isReady: true,
}

const race: { storage: 'record'; nativeResolve?: (v: unknown) => void } = { storage: 'record' }
// Switches between the browser and the shell for each test (the module mocks below read it lazily).
// the mock state lives on globalThis: the factories below run when App is imported (before this line), so they read it lazily
;(globalThis as unknown as { __mockRace: { shell: boolean } }).__mockRace = { shell: false }
const mockSynthPgpArmor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic\n-----END PGP PUBLIC KEY BLOCK-----'
/** The chain record of a registered account with no locale/currency setup, and a PGP public key on the chain. */
const mockChainInfo = {
	accountName: 'synthtag', image: '', darkTheme: false, isUSDCFaucet: false, isETHFaucet: false, firstName: '', lastName: '',
	language: 'en', currency: 'USD', tax: '0', localeCurrencyConfigured: false, initialLoading: false, exists: true,
	pgpPublicKeyID: '0xsyntheticpgpid', pgpPublicKeyArmor: mockSynthPgpArmor,
}
/** The bodies of the /api/addUser requests the App sent, recorded by the fetch stub. */
const mockAddUserBodies: Record<string, unknown>[] = []
/** While `hold` is set, the storage read of the first init waits until `release` is called (the init is in flight). */
const mockStorageGate: { hold: boolean; release?: () => void } = { hold: false }
const mockStorageReads: number[] = []

jest.mock('@/services/shellContext', () => ({ isShellContext: () => ((globalThis as unknown as { __mockRace?: { shell: boolean } }).__mockRace?.shell === true) }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => ((globalThis as unknown as { __mockRace?: { shell: boolean } }).__mockRace?.shell === true),
	hasNativeWalletListApi: () => false,
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

// Storage: the App's read and the gate's read both return the synthetic record.
jest.mock('@/services/beamio', () => ({
	setPageWritePermit: () => undefined, // 0.53.44: the session write gate (AppEntryGate); stub here
	allowRestoreWrite: () => undefined,
  endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorageWithStatusWithTimeout: async () => ({ status: 'empty' }), // 0.53.39: jsdom has no IndexedDB; the page copy is confirmed empty unless the test sets it
	checkStorage: () => {
		mockStorageReads.push(1)
		if (!mockStorageGate.hold) return Promise.resolve(mockRecord)
		return new Promise((resolve) => { mockStorageGate.release = () => resolve(mockRecord) })
	},
	checkStorageWithTransientRetry: () => Promise.resolve({ status: 'loaded', data: mockRecord }),
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => mockChainInfo,
	getUserInfoLookup: async () => ({ status: 'ok', info: mockChainInfo }),
	storeSystemData: async () => undefined,
	storeSystemDataAndWait: async () => undefined,
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => ({ status: 'empty' }),
	flushStoreSystemData: async () => undefined,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	reachNativeWallet: () => new Promise((r) => { race.nativeResolve = r }),
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
	queryNativeWalletStateSafe: async () => 'present',
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => (((globalThis as unknown as { __mockRace?: { shell: boolean } }).__mockRace?.shell === true) ? 'native_chat' : 'browser_chat'), shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: [] }) }))
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
jest.mock('@/services/chat', () => new Proxy({ initChat: async (_p: unknown, _a: unknown, setGossip?: (v: boolean) => void, gossipNow?: boolean) => { mockChatStarts.push(gossipNow === true); setGossip?.(true) }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: (...a: unknown[]) => { mockAaEnsures.push(a); return Promise.resolve() } }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: (...a: unknown[]) => { mockPushBinds.push(a); return true } }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/services/ownPgpPublic', () => ({
	...jest.requireActual('@/services/ownPgpPublic'),
	shellPgpForServerRequest: async () => (((globalThis as unknown as { __mockRace?: { shell: boolean } }).__mockRace?.shell === true) ? { keyID: '0xsyntheticpgpid', publicArmor: mockSynthPgpArmor } : null),
}))
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

describe('a start never sends the account to /api/addUser, and runs one browser init at a time', () => {
	beforeEach(() => {
		mockChatStarts.length = 0
		mockAddUserBodies.length = 0
		mockStorageReads.length = 0
		mockStorageGate.hold = false
		mockStorageGate.release = undefined
		;(globalThis as unknown as { __mockRace: { shell: boolean } }).__mockRace.shell = false
		// The save path's chain read (the PGP identity) sees the same chain record as the start, so a start that wrote would reach the request.
		chainIdentityRead.read = async () => ({ status: 'ok', info: mockChainInfo } as never)
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown, init?: { body?: unknown }) => {
			if (String(url).includes('/api/addUser')) mockAddUserBodies.push(JSON.parse(String(init?.body ?? '{}')))
			return { ok: true, status: 200, json: async () => ({}) }
		})
	})

	/**
	 * A browser start whose storage read is held in flight; the loading page's wallet-ready arrives meanwhile. The wallet-ready must
	 * not start a second read (no concurrent init), then the held read is released and the start completes.
	 */
	const heldStartWithWalletReady = async () => {
		const before = mockStorageReads.length
		mockStorageGate.hold = true
		const view = renderApp()
		await waitFor(() => expect(mockStorageReads.length).toBe(before + 1))
		const readsDuringFlight = mockStorageReads.length
		await act(async () => {
			window.dispatchEvent(new CustomEvent('beamio:wallet-ready', { detail: { reason: 'loading-page-init' } }))
		})
		await act(async () => {
			await new Promise((r) => setTimeout(r, 80))
		})
		expect(mockStorageReads.length).toBe(readsDuringFlight)
		mockStorageGate.hold = false
		await act(async () => {
			mockStorageGate.release?.()
		})
		await waitFor(() => expect(mockChatStarts.length).toBeGreaterThanOrEqual(1))
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50))
		})
		return view
	}

	it('T-R1 browser, an account whose chain record has no locale or currency setup: the start sends no addUser', async () => {
		await heldStartWithWalletReady()
		expect(mockAddUserBodies).toEqual([])
	})

	it('T-R1 browser, the restart after a recovery (same chain state): no addUser on either start', async () => {
		const first = await heldStartWithWalletReady()
		first.unmount()
		await heldStartWithWalletReady()
		expect(mockAddUserBodies).toEqual([])
	})

	it('T-R4 browser, mount init and wallet-ready together: at most one write request, and one storage read in flight', async () => {
		await heldStartWithWalletReady()
		expect(mockAddUserBodies.length).toBeLessThanOrEqual(1)
	})

	it('T-R4 browser, the queued run after the single-flight carries the active chat (gossip true), so chat.ts skips the restart', async () => {
		await heldStartWithWalletReady()
		// two chat calls: the first with no chat yet (gossip false), the queued run with the chat already active (gossip true). chat.ts
		// then decides by gossipStartDecision (same account: skip), so the queued run restarts nothing.
		expect(mockChatStarts).toEqual([false, true])
	})

	it('shell, the same start: no addUser', async () => {
		;(globalThis as unknown as { __mockRace: { shell: boolean } }).__mockRace.shell = true
		renderApp()
		await waitFor(() => expect(mockChatStarts.length).toBeGreaterThanOrEqual(1))
		await act(async () => {
			window.dispatchEvent(new CustomEvent('beamio:wallet-ready', { detail: { reason: 'loading-page-init' } }))
		})
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50))
		})
		expect(mockAddUserBodies).toEqual([])
	})
})
