/**
 * a shell init whose storage read ends empty tries again a few times (bounded), so the bar does not wait for a wake-up that never
 * comes. Real App; the storage read is empty twice, then returns the account. SYNTHETIC values only.
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
/** A synthetic account record with a local mnemonic (a not-key-only account), as the storage read returns it. */
const mockRecord = {
	profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }],
	mnemonicPhrase: 'synthetic words for the cold start test',
	beamio: { accountName: 'synthtag' },
	isReady: true,
}

const race: { storage: 'record'; nativeResolve?: (v: unknown) => void } = { storage: 'record' }

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

// Storage: the App's read and the gate's read both return the synthetic record.
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	checkStorage: () => { mockStorageReads += 1; return Promise.resolve(mockStorageReads <= 2 ? null : mockRecord) },
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
	reachNativeWallet: () => new Promise((r) => { race.nativeResolve = r }),
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
let mockStorageReads = 0
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

describe('an empty shell read is read again, bounded', () => {
	it('the first two reads are empty; the third returns the account and the chat starts, with no wake-up', async () => {
		renderApp()
		await waitFor(() => expect(mockChatStarts.length).toBe(1), { timeout: 8000 })
		expect(mockStorageReads).toBeGreaterThanOrEqual(3)
		expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
	})
})
