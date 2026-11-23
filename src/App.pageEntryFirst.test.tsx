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

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
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
	validMnemonicEoa: (d: { mnemonicPhrase?: unknown } | null | undefined) => (d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim() ? '0x9858effd232b4033e47d90003d41ec34ecaeda94' : ''),
}))
jest.mock('@/services/beamio', () => ({
	setPageWritePermit: () => undefined, // 0.53.44: the session write gate (AppEntryGate); stub here
	allowRestoreWrite: () => undefined,
  endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorageWithStatusWithTimeout: async () => ({ status: 'empty' }), // 0.53.39: jsdom has no IndexedDB; the page copy is confirmed empty unless the test sets it
	checkStorage: () => {
		mockRace.storageCalls += 1
		if (mockRace.storageCalls === 1) return new Promise((r) => { mockRace.releaseFirstRead = r })
		return Promise.resolve(mockRecord)
	},
	checkStorageWithTransientRetry: () => Promise.resolve({ status: 'loaded', data: mockRecord }),
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
	queryNativeWalletStatus: async () => ({ status: 'no_key' }), // 0.53.39 stub: the start route reads walletStatus
	queryNativePasscodeStatus: async () => ({ walletState: await (async () => 'not_reported')(), hasKey: 'not_reported' as const }),
	queryNativeWalletStateSafe: async () => 'not_reported',
	queryNativeMnemonicPreread: async () => ({ kind: 'unknown' }),
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }) }))
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
const mockPushBinds: unknown[] = []
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => { mockChatStarts.push(1) }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
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

describe('a page-record entry before the init storage read keeps its wake-up', () => {
	it('the entry is logged, the init read then ends empty; the bar shows and the chat starts once', async () => {
		renderApp()
		// The gate has entered on the page record while the App's first read is still in flight.
		// the gate's entry on the page record is the valid-mnemonic route (the page is read before any native ask)
		await waitFor(() => expect(mockLogs.some((m) => m.includes('[AppEntryGate] page mnemonic is valid'))).toBe(true))
		await act(async () => {
			mockRace.releaseFirstRead?.(null)
		})
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy(), { timeout: 3000 })
		await waitFor(() => expect(mockChatStarts.length).toBe(1))
		expect(mockPushBinds.length).toBe(1)
	})
})
