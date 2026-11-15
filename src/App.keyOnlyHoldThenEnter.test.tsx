/**
 * a browser session whose first init has no storage (the loading flag is set) and then
 * enters as key-only. The bar must show. Real App; the storage and the entry gate are stubs. SYNTHETIC values only. A shell whose account is not in the storage read at App's init (no record, a failed
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
const race: { appReads: number; releaseGate?: () => void; nativeResolve?: (v: unknown) => void } = { appReads: 0 }

jest.mock('@/services/shellContext', () => ({ isShellContext: () => false }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => false,
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
	// The App's own read: nothing at the first init (the hold), a key-only record at the next one.
	checkStorage: () => { (globalThis as any).__appReads = ((globalThis as any).__appReads || 0) + 1; return Promise.resolve((globalThis as any).__appReads === 1 ? null : { ChannelPartners: [], isReady: true, nonce: 0, referrals: [], ver: 1, beamio: { createdAt: 1, currency: 'USD', tax: '0', language: 'en' }, profiles: [{ keyID: '0x1111111111111111111111111111111111111111', privateKeyArmor: '0x' + '11'.repeat(32), isPrimary: true, index: 0, isNode: false, type: 'ethereum', referrer: null, tokens: [], webFilter: true, aaAccount: '' }] }) },
	// The entry gate's read stays pending in this case: the key-only entry must show the bar by itself.
	checkStorageWithTransientRetry: () => new Promise(() => undefined),
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

/** The App's native-log lines, as recorded by the stub. */
const publishNativePwaLog = (): jest.Mock => require('@/utils/cashTreesNativePwaLog').publishNativePwaLog

describe('a hold, then a key-only entry in the same session', () => {
	it('the bar shows after the key-only entry, although the first init held the flag', async () => {
		;(globalThis as any).__appReads = 0
		renderApp()
		// The first init reads nothing and holds the bar (the loading flag stays set).
		await waitFor(() => expect((globalThis as any).__appReads).toBe(1))
		await waitFor(() => expect(publishNativePwaLog().mock.calls.some((c: unknown[]) => String(c[1]).includes('no local wallet storage'))).toBe(true))
		expect(screen.queryByRole('button', { name: 'search' })).toBeNull()
		// The next init (the wallet-ready event) reads the key-only record and enters.
		await act(async () => {
			window.dispatchEvent(new Event('beamio:wallet-ready'))
		})
		await waitFor(() => expect(screen.getByRole('button', { name: 'search' })).toBeTruthy(), { timeout: 3000 })
		expect(publishNativePwaLog().mock.calls.some((c: unknown[]) => String(c[1]).includes('key-only account (no local mnemonic) — app entered'))).toBe(true)
	})
})
