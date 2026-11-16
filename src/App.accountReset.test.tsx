/**
 * Y.85 / Y.89 at page level (ST-01, ST-04, ST-06 family): a shell with no page record and walletStatus no_key enters onboarding only when
 * identityPublic reports kPresent false. kPresent absent or true, or an unknown walletStatus, is retry: the native retry screen, never
 * onboarding, and nothing is deleted. Real App and entry gate; the native bridge and storage are stubs. SYNTHETIC values only.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

type Native = { status: 'no_key' } | { status: 'unknown' } | { status: 'not_ready'; notReadyReason: 'unreadable' }
const race: { native: Native; kPresent: boolean | undefined; caps: string[] } = { native: { status: 'no_key' }, kPresent: false, caps: ['identity.native-keys.v1'] }

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
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
// The page record is empty on this device (no IndexedDB key, no account record).
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	checkStorage: async () => null,
	checkStorageWithTransientRetry: async () => ({ status: 'empty' }),
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
	publicWalletSeed: () => ({ profiles: [], beamio: undefined, isReady: true }),
	reachNativeWallet: async () => race.native,
	rememberNativeEoa: jest.fn(),
	takeInitRefusal: () => null,
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'absent',
	queryNativeWalletStatus: async () => race.native,
	queryNativeWalletStateSafe: async () => 'absent',
}))
jest.mock('@/services/nativeIdentityPublic', () => ({
	...jest.requireActual('@/services/nativeIdentityPublic'),
	readNativeIdentityPublic: async () => ({ kind: 'no_key', kPresent: race.kPresent }),
}))
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: async () => null }))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: race.caps }) }))
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
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => undefined, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: () => true }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/components/SplashScreen', () => () => null)
jest.mock('@/components/PasscodeLockScreen', () => () => null)
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
// The onboarding page is replaced by a marker, so the test reads whether the gate entered onboarding.
jest.mock('@/pages/Home/LoadingPage', () => {
	const R = require('react')
	return () => R.createElement('div', null, 'ONBOARDING_MARK')
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

const RETRY_TITLE = 'native_not_ready_retry_title'

describe('account reset at the gate (Y.85 with Y.89 kPresent)', () => {
	beforeEach(() => {
		race.native = { status: 'no_key' }
		race.kPresent = false
		race.caps = ['identity.native-keys.v1']
	})

	it('no_key with kPresent false on both sides (ST-01): onboarding opens; nothing else is shown', async () => {
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	it('no_key with kPresent absent (identity.kpresent.v1 not declared, Y.90 4): retry, never onboarding', async () => {
		race.kPresent = undefined
		renderApp()
		await waitFor(() => expect(screen.getByText(RETRY_TITLE)).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	it('no_key with kPresent true (a key exists without a native wallet): retry, never onboarding', async () => {
		race.kPresent = true
		renderApp()
		await waitFor(() => expect(screen.getByText(RETRY_TITLE)).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	it('unreadable native wallet (not_ready, unreadable) (ST-04 family): retry, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		renderApp()
		await waitFor(() => expect(screen.getByText(RETRY_TITLE)).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})
})
