/**
 * Page level account reset and capability tiers (Y.85, Y.89, Y.93). SYNTHETIC values only.
 * ST-02, ST-03, ST-05: the page-level cases of accountResetCases. CP-01 to CP-06: onboardingCompatCases (Y.93), with CP-04 (the
 * legacy shell without identity.native-keys.v1) covered at the tier level in accountReset.test.ts, see the receipt.
 * Real App and entry gate; the native bridge and the storage are stubs.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })

const EOA = '0x1111111111111111111111111111111111111111'
type Native =
	| { status: 'no_key' }
	| { status: 'unknown' }
	| { status: 'not_ready'; notReadyReason: 'unreadable' | 'g1_uninitialized' }
	| { status: 'locked' | 'unlocked'; eoa: string }
// Declared before the App is loaded: the module mocks below read it lazily.
const race: {
	shell: boolean
	native: Native
	walletState: 'absent' | 'present' | 'locked' | 'not_ready'
	kPresent: boolean | undefined
	caps: string[]
	eoa: string | null
	idb: 'empty' | 'key'
	reachCalls: number
} = { shell: true, native: { status: 'no_key' }, walletState: 'absent', kPresent: false, caps: ['identity.native-keys.v1', 'identity.kpresent.v1'], eoa: EOA, idb: 'empty', reachCalls: 0 }

const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

jest.mock('@/services/shellContext', () => ({ isShellContext: () => race.shell }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => race.shell,
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
// The page record: empty, or a record with the key (race.idb). Storage reads follow the same switch.
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	checkStorage: async () => null,
	checkStorageWithTransientRetry: async () => (race.idb === 'key' ? { status: 'loaded', data: { profiles: [{ keyID: EOA, isPrimary: true }] } } : { status: 'empty' }),
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
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasLocalSigningMaterial: () => race.idb === 'key',
	hasCompletedBeamioAccount: () => race.idb === 'key',
	pageWalletRecoverNeeded: () => false,
	hasLocalPlaintextMnemonic: () => false,
	isTrustedEmptyWalletBlob: () => false,
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [], beamio: undefined, isReady: true }),
	reachNativeWallet: async () => {
		race.reachCalls += 1
		return race.native
	},
	rememberNativeEoa: jest.fn(),
	takeInitRefusal: () => null,
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => race.walletState,
	queryNativeWalletStatus: async () => race.native,
	queryNativeWalletStateSafe: async () => race.walletState,
}))
jest.mock('@/services/nativeIdentityPublic', () => ({
	...jest.requireActual('@/services/nativeIdentityPublic'),
	readNativeIdentityPublic: async () => ({ kind: 'no_key', kPresent: race.kPresent }),
}))
jest.mock('@/services/walletEoaAddress', () => ({ readWalletEoaAddress: async () => (race.eoa ? { kind: 'address', eoa: race.eoa } : { kind: 'refused', code: 'unavailable' }) }))
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
jest.mock('@/components/PasscodeLockScreen', () => {
	const R = require('react')
	return () => R.createElement('div', null, 'PASSCODE_MARK')
})
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
// The onboarding page is replaced by a marker, so the test reads whether the gate entered onboarding.
jest.mock('@/pages/Home/LoadingPage', () => {
	const R = require('react')
	return () => R.createElement('div', null, 'ONBOARDING_MARK')
})
const { publishNativePwaLog } = require('@/utils/cashTreesNativePwaLog')

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
const BOTH_CAPS = ['identity.native-keys.v1', 'identity.kpresent.v1']

describe('account reset at the gate (Y.85, Y.89, Y.93)', () => {
	beforeEach(() => {
		race.reachCalls = 0
		race.shell = true
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.kPresent = false
		race.caps = [...BOTH_CAPS]
		race.eoa = EOA
		race.idb = 'empty'
	})

	// ST-01 / CP-06: two-sided confirmed none (both capabilities reported): onboarding; nothing else is shown.
	it('CP-06 and ST-01: no_key with kPresent false, both capabilities reported, IDB empty: onboarding opens', async () => {
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// CP-04 (Y.93 2b, option A, §25.29.5): a shell that does not report identity.native-keys.v1 shows the unified capability notice.
	// It never reaches onboarding, and the IndexedDB state does not decide an account for it.
	it('CP-04: a shell without identity.native-keys.v1 shows the capability-missing notice, never onboarding', async () => {
		race.caps = []
		race.kPresent = undefined
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('chat unavailable')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// CP-05 (Y.93 2c): native-keys reported, kpresent not reported: unknown, retry, no creation entry, never onboarding.
	it('CP-05: native-keys reported, kpresent not: retry only, no onboarding, no creation entry', async () => {
		race.caps = ['identity.native-keys.v1']
		race.kPresent = undefined
		renderApp()
		// Y.104: the unknown answer is retried on the cadence (30 s first); the page never onboards and the decision is logged.
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('shell upgrade needed')), { timeout: 3000 })
		expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('onboarding not entered, nothing deleted'))
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	// Y.151 (PNK-04) supersedes Y.107/Y.108 here: a no_key answer with kPresent true holds the native key. It is the recovery entry only:
	// never onboarding, never a creation entry.
	it('no_key with kPresent true and no mnemonic on either side: recovery entry, not onboarding, no retry (Y.151 PNK-04)', async () => {
		race.kPresent = true
		renderApp()
		// the recovery screen shows its import entry (native_key_required_import)
		await waitFor(() => expect(screen.getByText('native_key_required_import')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		// no native retry screen, and no creation entry
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
		expect(screen.queryByText('native_account_create')).toBeNull()
		const afterRecovery = race.reachCalls
		await new Promise((r) => setTimeout(r, 300))
		// no automatic retry: the native wallet is not asked again
		expect(race.reachCalls).toBe(afterRecovery)
	})

	// CP-01: a passcode lock (walletStatus locked, the wallet is held) is has: continue_account, the passcode page; never onboarding.
	it('CP-01: passcode lock (walletStatus locked) is has: the passcode page, not onboarding', async () => {
		race.native = { status: 'locked', eoa: EOA }
		race.walletState = 'locked'
		renderApp()
		await waitFor(() => expect(screen.getByText('PASSCODE_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// CP-02: a storage-derived lock (not_ready, unreadable) is unknown: retry, never onboarding, never a creation entry.
	it('CP-02: storage-derived lock (not_ready, unreadable) is unknown: retry, no onboarding, no creation entry', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		renderApp()
		await waitFor(() => expect(screen.getByText('Wallet storage is unavailable')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	// CP-03: a browser with no native side and an empty IndexedDB: onboarding, the creation entry is allowed.
	it('CP-03: browser, fresh install (IDB empty, no native side): onboarding opens', async () => {
		race.shell = false
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
	})

	// ST-02: IDB has a key, native absent (no_key, kPresent false): the page account continues.
	it('ST-02: IDB has a key, native absent: continues on the page account, no onboarding, no retry', async () => {
		race.idb = 'key'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('storage hasAccount=true')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// ST-03: IDB empty, native has (a G1 wallet): continues on the public address (the local home), no onboarding, no deletion.
	it('ST-03: IDB empty, native has (G1): continues on the public address, no onboarding, no retry', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('local home')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	it('ST-03 (no public address on this device): retry, nothing guessed, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		race.eoa = null
		renderApp()
		await waitFor(() => expect(screen.getByText(RETRY_TITLE)).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	// ST-05: both sides hold the wallet (the PGP record is not a basis; the presence logic does not read it): continues.
	it('ST-05: both sides hold the wallet: continues on the account, no onboarding, no retry', async () => {
		race.idb = 'key'
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('storage hasAccount=true')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	it('unreadable native wallet (not_ready, unreadable) with no walletState: retry, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		renderApp()
		await act(async () => { await Promise.resolve() })
		await waitFor(() => expect(screen.queryByText('ONBOARDING_MARK')).toBeNull(), { timeout: 3000 })
	})
})
