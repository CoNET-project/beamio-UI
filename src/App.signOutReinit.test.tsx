/**
 *  and (suggestion): a sign-out or a vault lock forgets the entered account, so the next wake-up runs the account init again; a read that gives up releases the claim, and a lock stops a waiting read. Fake timers.
 * (the claim is released). Without the reset the second init would be a skip. Real App and entry gate; the native bridge, the storage and
 * the chat start are stubs. SYNTHETIC values only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
/** The account read: the first `failFirst` reads fail (the capped ladder), later reads succeed. */
const mockRead = { calls: 0, failFirst: 4 }
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
	checkStorage: () => Promise.resolve(mockRecord),
	checkStorageWithTransientRetry: () => Promise.resolve({ status: 'loaded', data: mockRecord }),
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => {
		mockRead.calls += 1
		return mockRead.calls <= mockRead.failFirst ? { status: 'network_error', reason: 'synthetic' } : { status: 'ok', info: { accountName: 'synthtag' } }
	},
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

const flush = async () => {
	for (let i = 0; i < 30; i++) {
		await act(async () => {
			await Promise.resolve()
		})
	}
}

describe('a read that gives up releases the claim; the user\'s retry or a lock behaves as specified', () => {
	beforeEach(() => {
		jest.useFakeTimers()
		mockRead.calls = 0
		mockRead.failFirst = 4
		mockChatStarts.length = 0
		mockPushBinds.length = 0
	})
	afterEach(() => {
		// Unmount and drop the fake timers before the real ones return, so no timer of this file runs in a later file of the same worker.
		cleanup()
		jest.clearAllTimers()
		jest.useRealTimers()
	})

	it('the ladder runs 30 s, 2 min, 10 min; then four reads have run, nothing has started, and the notice shows', async () => {
		renderApp()
		await flush()
		expect(mockRead.calls).toBe(1)
		for (const ms of [30_000, 120_000, 600_000]) {
			await act(async () => {
				jest.advanceTimersByTime(ms)
			})
			await flush()
		}
		expect(mockRead.calls).toBe(4)
		expect(mockChatStarts.length).toBe(0)
		expect(screen.getByRole('alert')).toBeTruthy()
	})

	it('the user\'s "Try again" runs the init again: the claim was released, so the account enters', async () => {
		renderApp()
		await flush()
		for (const ms of [30_000, 120_000, 600_000]) {
			await act(async () => {
				jest.advanceTimersByTime(ms)
			})
			await flush()
		}
		await act(async () => {
			fireEvent.click(within(screen.getByRole('alert')).getByRole('button'))
		})
		await flush()
		expect(mockRead.calls).toBe(5)
		expect(mockChatStarts.length).toBe(1)
	})

	it('a vault lock during the wait stops the reads: no further read after the lock', async () => {
		renderApp()
		await flush()
		expect(mockRead.calls).toBe(1)
		await act(async () => {
			window.dispatchEvent(new Event('beamio:vault-locked'))
		})
		await act(async () => {
			jest.advanceTimersByTime(630_000)
		})
		await flush()
		expect(mockRead.calls).toBe(1)
		expect(mockChatStarts.length).toBe(0)
	})
})
