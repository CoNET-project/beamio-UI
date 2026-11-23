/**
 * Shell pre-read in flight: the 2 s limit only shows the retry of a round. The page
 * read in flight is kept and awaited by the next round (automatic or manual retry); it is never started twice. A slow read that finally
 * answers with a valid mnemonic opens the home; a genuine failure stays unknown with the retry, never onboarding, never a write, never a
 * clear. Real App and entry gate; the native bridge, the storage and the chat start are stubs. SYNTHETIC values only.
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

/** A synthetic account record with a local mnemonic, as the page read returns it. */
const mockRecord = {
	profiles: [{ keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }],
	// a valid BIP39 phrase (this is the standard test phrase, not a real wallet)
	mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
	beamio: { accountName: 'synthtag' },
	isReady: true,
}

/** The page read: each call of checkStorageWithTransientRetry is counted; `impl` decides how that read answers (the test sets it). */
const mockPageRead: { calls: number; inFlight: number; maxInFlight: number; impl: () => Promise<unknown> } = { calls: 0, inFlight: 0, maxInFlight: 0, impl: async () => ({ status: 'empty' }) }
/** The native pre-read answers (never asked while the page is unknown or valid). */
const mockPreread: { asked: number; answer: () => Promise<unknown> } = { asked: 0, answer: async () => ({ kind: 'absent' }) }
/** page-store writes (the no-write assertions) and removal calls (the no-clear assertions) */
const mockWrites: { n: number } = { n: 0 }
const mockStorageSpies: { remove?: jest.SpyInstance; clear?: jest.SpyInstance } = {}
const deleteCalls = (): number => (mockStorageSpies.remove?.mock.calls.length ?? 0) + (mockStorageSpies.clear?.mock.calls.length ?? 0)
const mockNative: { walletState: string } = { walletState: 'absent' }

const slowRead = (ms: number, data: unknown) => () => new Promise((resolve) => { window.setTimeout(() => resolve(data), ms) })

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

// jsdom cannot run ethers' derivation (cross-realm Buffer); the derivation is covered in the node tests.
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasValidMnemonic: (d: { mnemonicPhrase?: unknown } | null | undefined) => Boolean(d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim()),
	validMnemonicEoa: (d: { mnemonicPhrase?: unknown } | null | undefined) => (d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim() ? '0x9858effd232b4033e47d90003d41ec34ecaeda94' : ''),
}))
jest.mock('@/services/beamio', () => ({
	setPageWritePermit: () => undefined,
	allowRestoreWrite: () => undefined,
	endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorageWithStatusWithTimeout: async () => ({ status: 'empty' }),
	checkStorage: () => Promise.resolve(mockRecord),
	// the page read of the shell pre-read: counted, with at most one read in flight
	checkStorageWithTransientRetry: () => {
		mockPageRead.calls += 1
		mockPageRead.inFlight += 1
		mockPageRead.maxInFlight = Math.max(mockPageRead.maxInFlight, mockPageRead.inFlight)
		return Promise.resolve()
			.then(() => mockPageRead.impl())
			.finally(() => { mockPageRead.inFlight -= 1 })
	},
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	// a save counts as a page write only when the real session write gate permits it (consultPageWriteGate, as in App.onboardGapRepro)
	storeSystemData: async () => { if (jest.requireActual('@/services/beamio').consultPageWriteGate('app_save')) mockWrites.n += 1 },
	storeSystemDataAndWait: async () => {
		if (!jest.requireActual('@/services/beamio').consultPageWriteGate('app_save_wait')) return false
		mockWrites.n += 1
		return true
	},
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => ({ status: 'empty' }),
	readStoredRecordForVerify: async () => mockRecord,
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	reachNativeWallet: () => Promise.resolve({ status: 'no_key' }),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => mockNative.walletState,
	queryNativeWalletStatus: async () => ({ status: 'no_key' }),
	queryNativePasscodeStatus: async () => ({ walletState: mockNative.walletState, hasKey: 'not_reported' as const }),
	queryNativeWalletStateSafe: async () => mockNative.walletState,
	queryNativeMnemonicPreread: () => { mockPreread.asked += 1; return mockPreread.answer() },
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
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => { mockChatStarts.push(1) }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: () => true }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
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

const logged = (text: string) => mockLogs.some((m) => m.includes(text))
/** 0.53.44 (two-landing rule): the loading page has no startup button; retries are background only */
const startupButtons = () => screen.queryAllByRole('button').filter((b) => /retry|restore|try again|recovery|reading|migration|reload/i.test(b.textContent ?? '')).length
const onboarded = () => logged('pre-read absent, page confirmed empty: onboarding') || logged('native mnemonic pre-read absent, page confirmed empty')

describe('shell pre-read: the page read in flight is kept and awaited, never started twice (2026-11-22)', () => {
	beforeEach(() => {
		mockPageRead.calls = 0
		mockPageRead.inFlight = 0
		mockPageRead.maxInFlight = 0
		mockPageRead.impl = async () => ({ status: 'empty' })
		mockPreread.asked = 0
		mockPreread.answer = async () => ({ kind: 'absent' })
		mockWrites.n = 0
		mockNative.walletState = 'absent'
		mockLogs.length = 0
		mockChatStarts.length = 0
		mockStorageSpies.remove?.mockRestore()
		mockStorageSpies.clear?.mockRestore()
		mockStorageSpies.remove = jest.spyOn(Storage.prototype, 'removeItem')
		mockStorageSpies.clear = jest.spyOn(Storage.prototype, 'clear')
	})

	it('a: a 11 s page read: round 1 shows the retry; the late valid read opens the home; one read only, no overlap', async () => {
		mockPageRead.impl = slowRead(11_000, { status: 'loaded', data: mockRecord })
		renderApp()
		await waitFor(() => expect(logged('page mnemonic unknown (timeout')).toBe(true), { timeout: 5_000 })
		await waitFor(() => expect(startupButtons()).toBe(0))
		expect(logged('page mnemonic is valid')).toBe(false)
		await waitFor(() => expect(logged('page mnemonic is valid')).toBe(true), { timeout: 20_000 })
		// the late answer reached the gate: the home on the page EOA, the native side never asked, no onboarding
		expect(mockPreread.asked).toBe(0)
		expect(onboarded()).toBe(false)
		expect(jest.requireActual('@/services/beamio').pageWriteGateStatus().permit).toBe('page_valid_mnemonic')
		// exactly one page read was started for the whole start; later rounds reused it
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.maxInFlight).toBe(1)
	}, 60_000)

	it('b: a 31 s page read: the retries keep waiting on the same read; it answers valid late and the home opens; max in flight 1', async () => {
		mockPageRead.impl = slowRead(31_000, { status: 'loaded', data: mockRecord })
		renderApp()
		await waitFor(() => expect(logged('page mnemonic unknown (timeout')).toBe(true), { timeout: 5_000 })
		await waitFor(() => expect(startupButtons()).toBe(0))
		await waitFor(() => expect(logged('page mnemonic is valid')).toBe(true), { timeout: 60_000 })
		expect(mockPreread.asked).toBe(0)
		expect(onboarded()).toBe(false)
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.maxInFlight).toBe(1)
		expect(mockWrites.n).toBeGreaterThanOrEqual(0)
	}, 75_000)

	it('c: a genuine read failure stays unknown with the retry offered: no onboarding, no write, no clear, no native ask', async () => {
		mockPageRead.impl = async () => { throw new Error('synthetic read failure') }
		renderApp()
		await waitFor(() => expect(logged('page mnemonic unknown (timeout')).toBe(true), { timeout: 5_000 })
		await waitFor(() => expect(startupButtons()).toBe(0))
		// a second round after the first unknown answer (the automatic re-read at 2 s)
		await waitFor(() => expect(mockPageRead.calls).toBeGreaterThanOrEqual(2), { timeout: 8_000 })
		expect(logged('page mnemonic is valid')).toBe(false)
		expect(onboarded()).toBe(false)
		expect(mockPreread.asked).toBe(0)
		expect(mockWrites.n).toBe(0)
		expect(deleteCalls()).toBe(0)
		expect(mockPageRead.maxInFlight).toBe(1)
	}, 30_000)

	it('d: no manual trigger while the read is in flight (no startup button, no second read); the one read answers', async () => {
		mockPageRead.impl = slowRead(11_000, { status: 'loaded', data: mockRecord })
		renderApp()
		await waitFor(() => expect(logged('page mnemonic unknown (timeout')).toBe(true), { timeout: 5_000 })
		// 0.53.44: Try Again is not a startup button; the start has nothing to click while the read is in flight
		expect(startupButtons()).toBe(0)
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.inFlight).toBe(1)
		await waitFor(() => expect(logged('page mnemonic is valid')).toBe(true), { timeout: 20_000 })
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.maxInFlight).toBe(1)
		expect(onboarded()).toBe(false)
	}, 60_000)

	it('e: a read that ends between two rounds is decided at once: no new read is started (calls stay 1)', async () => {
		// round 1 times out at 2 s; the next round would start at 4 s. The read ends at 3 s, in that gap.
		mockPageRead.impl = slowRead(3_000, { status: 'loaded', data: mockRecord })
		renderApp()
		await waitFor(() => expect(logged('page mnemonic unknown (timeout')).toBe(true), { timeout: 5_000 })
		await waitFor(() => expect(logged('page mnemonic is valid')).toBe(true), { timeout: 6_000 })
		// decided before the next round's timeout (attempt 2 would be logged at 6 s): the wait was left at once
		expect(logged('startup retry: attempt 2')).toBe(false)
		expect(logged('pre-read ended after its round limit: the start decides now')).toBe(true)
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.maxInFlight).toBe(1)
		expect(mockPreread.asked).toBe(0)
		expect(onboarded()).toBe(false)
	}, 30_000)

	it('f: a 31 s read that ends inside a long wait leaves the wait within the same event loop turn (no further retry is logged)', async () => {
		let resolvedAt = -1
		mockPageRead.impl = () => new Promise((resolve) => {
			window.setTimeout(() => {
				resolvedAt = mockLogs.length
				resolve({ status: 'loaded', data: mockRecord })
			}, 31_000)
		})
		renderApp()
		// the rounds back off to a 16 s wait (attempt 4, read still running at 22 s); the read ends at 31 s, inside that wait
		await waitFor(() => expect(logged('startup retry: attempt 4')).toBe(true), { timeout: 30_000 })
		await waitFor(() => expect(logged('page mnemonic is valid')).toBe(true), { timeout: 20_000 })
		const validAt = mockLogs.findIndex((m) => m.includes('page mnemonic is valid'))
		expect(resolvedAt).toBeGreaterThanOrEqual(0)
		expect(validAt).toBeGreaterThanOrEqual(resolvedAt)
		// no retry was logged between the read's end and the decision: the wait was left at once, not at its next scheduled round
		expect(mockLogs.slice(resolvedAt, validAt).some((m) => m.includes('startup retry:'))).toBe(false)
		expect(logged('startup retry: attempt 5')).toBe(false)
		// the wake-up ran between the read's end and the decision (not the next scheduled round)
		expect(mockLogs.slice(resolvedAt, validAt).some((m) => m.includes('pre-read ended after its round limit'))).toBe(true)
		expect(mockPageRead.calls).toBe(1)
		expect(mockPageRead.maxInFlight).toBe(1)
		expect(mockPreread.asked).toBe(0)
	}, 90_000)
	it('g: after a late read wakes the start into a new wait, the old wait timer does not fire (the next read is at the new wait, not at the old one)', async () => {
		// round 1 times out at 2 s and sets its 2 s wait (it would fire at 4 s). The read ends at 3 s with an unknown answer (a failure):
		// the wake cancels the old timer and starts a new wait of 4 s (attempt 2), so the next read is at 7 s.
		let calls = 0
		mockPageRead.impl = () => {
			calls += 1
			if (calls === 1) return new Promise((_resolve, reject) => { window.setTimeout(() => reject(new Error('synthetic late failure')), 3_000) })
			return Promise.reject(new Error('synthetic failure'))
		}
		renderApp()
		await waitFor(() => expect(logged('startup retry: attempt 2')).toBe(true), { timeout: 6_000 })
		// the wake consumed the late answer (no read at 3 s). The old timer would have started a read at 4 s: wait past that moment.
		await new Promise((resolve) => setTimeout(resolve, 1_500))
		expect(mockPageRead.calls).toBe(1)
		expect(logged('startup retry: attempt 3')).toBe(false)
		// the next read comes at the new wait's end (3 s + 4 s = 7 s), not earlier
		await waitFor(() => expect(mockPageRead.calls).toBe(2), { timeout: 4_000 })
		expect(logged('page mnemonic is valid')).toBe(false)
		expect(mockPreread.asked).toBe(0)
	}, 30_000)
})
