/**
 * Startup capability: the pre-read answer decides only when it is definite. A shell without the pre-read command
 * (unknown_command) does not stall the start; a bridge unknown keeps a retryable wait and never reaches the onboarding. Real App and entry
 * gate; the native bridge, the storage and the chat start are stubs. SYNTHETIC values only.
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
/** The native pre-read reply (the window host's answer body) for each case; the tests set it before the render. The pre-read itself is real. */
const mockPreread: { payload: Record<string, unknown>; asked: number } = { payload: { ok: false, error: 'envelope_fail' }, asked: 0 }
/** the window host the App's pre-read transport talks to (the App.nativeLateReply shape): every nativeMnemonicPreread is answered by the host */
let hostOnMessage: ((ev: unknown) => void) | null = null
function installNativeHost(): void {
	const host = {
		postMessage: (text: string) => {
			const cmd = JSON.parse(text) as { type: string; reqId: number }
			if (cmd.type !== 'nativeMnemonicPreread') return
			mockPreread.asked += 1
			setTimeout(() => hostOnMessage?.({ data: JSON.stringify({ type: 'ack', reqId: cmd.reqId, ...mockPreread.payload }) }), 0)
		},
		get onmessage() { return hostOnMessage },
		set onmessage(fn: ((ev: unknown) => void) | null) { hostOnMessage = fn },
	}
	;(window as unknown as { BeamioShellRecord: unknown }).BeamioShellRecord = host
}
const mockPage: { empty: boolean } = { empty: true }
/** The native walletStatus and walletState answers (the shell side); the default is an explicit no_key with walletState absent. */
const mockNative: { answer: (...a: unknown[]) => Promise<unknown>; walletState: string; walletStatus: unknown } = { answer: async () => ({ status: 'no_key' }), walletState: 'absent', walletStatus: { status: 'no_key' } }
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
	// the page read: a valid record by default; the cases below set it to empty (the page confirmed empty, so the native side is asked)
	checkStorageWithTransientRetry: () => Promise.resolve(mockPage.empty ? { status: 'empty' } : { status: 'loaded', data: mockRecord }),
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
	purgeKeyOnlyPageRecord: async () => ({ kind: 'absent' }), // 0.53.52: no key-only record in these fixtures (the purge reads the page store); last in the factory
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	// The native wallet has no key for this account: the page record decides (boundary).
	reachNativeWallet: (...a: unknown[]) => mockNative.answer(...a),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => mockNative.walletState,
	queryNativeWalletStatus: async () => mockNative.walletStatus, // the start route reads walletStatus (set per test)
	queryNativePasscodeStatus: async () => ({ walletState: await (async () => mockNative.walletState)(), hasKey: 'not_reported' as const }),
	queryNativeWalletStateSafe: async () => mockNative.walletState,
	// the real pre-read (its transport, its inner timeouts); the native answer comes from the window host (mockPreread.payload)
	queryNativeMnemonicPreread: (...a: unknown[]) => (jest.requireActual('@/services/nativeRecovery') as { queryNativeMnemonicPreread: (...x: unknown[]) => unknown }).queryNativeMnemonicPreread(...a),
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'], nativeApp: { platform: 'ios', version: '1.0', build: '1' } }) }))
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
	installNativeHost()
	return render(
		<DaemonProvider>
			<MemoryRouter initialEntries={['/home']}>
				<App />
			</MemoryRouter>
		</DaemonProvider>,
	)
}

describe('the start with the native pre-read (startup capability, 2026-11-16)', () => {
	it('the page has a valid mnemonic: the home opens on it and the native side is not asked', async () => {
		mockPage.empty = false
		mockPreread.payload = { ok: true, result: { code: 'confirmed_missing' } }
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('page mnemonic is valid'))).toBe(true))
		expect(mockPreread.asked).toBe(0)
		expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
	})

	beforeEach(() => {
		mockPage.empty = true
		mockNative.answer = async () => ({ status: 'no_key' })
		mockNative.walletState = 'absent'
		mockNative.walletStatus = { status: 'no_key' }
		mockLogs.length = 0
		mockRace.storageCalls = 0
		mockPreread.asked = 0
	})

	it('a bridge unknown (timeout or error) is a retryable wait: no onboarding, no home from the native side', async () => {
		mockPreread.payload = { ok: false, error: 'envelope_fail' } // an envelope refusal: unknown (a retryable wait)
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('preread=unknown'))).toBe(true))
		expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
		expect(mockLogs.some((m) => m.includes('not supported by this shell'))).toBe(false)
	})

	it('a shell without the pre-read command (unknown_command) does not stall: the walletStatus route decides', async () => {
		mockPreread.payload = { ok: false, error: 'unknown_command' } // the shell has no pre-read command
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('not supported by this shell'))).toBe(true))
		// the unsupported answer is not a retryable wait: no 'retry, no verdict' round
		expect(mockLogs.some((m) => m.includes('retry, no verdict'))).toBe(false)
		expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
	})

	it('0.53.44: an unknown start shows no startup button (no fallback screen), re-reads at 2 s, 4 s', async () => {
		jest.useFakeTimers()
		try {
			mockPreread.payload = { ok: false, error: 'envelope_fail' }
			renderApp()
			const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); jest.advanceTimersByTime(0) } }
			await act(async () => { await flush() })
			const retryShown = () => screen.queryByText('native_not_ready_retry_title') !== null
			const retryButtons = () => screen.queryAllByRole('button', { name: 'native_not_ready_retry_action' }).length
			const roundsLogged = () => mockLogs.filter((m) => m.includes('preread=unknown')).length
			expect(roundsLogged()).toBe(1)
			// 0.53.44 (two-landing rule): the generic retry screen and the visible retry button are not shown at startup
			expect(retryShown()).toBe(false)
			expect(retryButtons()).toBe(0) // 0.53.44: no startup button; the re-reads are background only
			for (const [round, ms] of [[2, 2_000], [3, 4_000]] as const) {
				await act(async () => { jest.advanceTimersByTime(ms); await flush() })
				expect(roundsLogged()).toBe(round)
				expect(retryShown()).toBe(false)
				expect(retryButtons()).toBe(0) // 0.53.44: no startup button; the re-reads are background only
			}
			// the identity prompt (the same retry, with its own copy) must not stack on the retry button: one retry button only
			await act(async () => {
				window.dispatchEvent(new Event('beamio:identityEntryPrompt'))
				jest.advanceTimersByTime(1)
				await flush()
			})
			expect(retryButtons()).toBe(0) // 0.53.44: no startup button; the re-reads are background only
			expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
		} finally {
			jest.useRealTimers()
		}
	})

	it('both sides confirmed empty (the native pre-read absent with the page confirmed empty) goes to the onboarding', async () => {
		mockPreread.payload = { ok: true, result: { code: 'confirmed_missing' } }  // the legacy state shape is not a confirmed absence
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(true))
		expect(mockPreread.asked).toBeGreaterThanOrEqual(1)
	})
})

describe('R96: the start with a native no_key, the page empty and the pre-read', () => {
	beforeEach(() => {
		mockPage.empty = true
		mockLogs.length = 0
		mockNative.answer = async () => ({ status: 'no_key' })
		mockNative.walletState = 'not_reported'
	})

	it('G1 (g1_uninitialized) with the pre-read confirmed_missing and the page empty: onboarding (8ca9299e: walletStatus not_ready does not block)', async () => {
		mockPreread.payload = { ok: true, result: { code: 'confirmed_missing' } }
		mockNative.walletStatus = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		await waitFor(() => expect(mockPreread.asked).toBeGreaterThanOrEqual(1))
		await waitFor(() => expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(true), { timeout: 10_000 })
		expect(mockLogs.some((m) => m.includes('shell no-key judgement'))).toBe(false)
	}, 20_000)

	it('G1 (g1_uninitialized) with the pre-read unknown (no definite answer): the start re-reads in the background, never onboarding (3417d3d6 item 2)', async () => {
		mockPreread.payload = { ok: false, error: 'not_ready' }
		mockNative.walletStatus = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		await waitFor(() => expect(mockPreread.asked).toBeGreaterThanOrEqual(1))
		await new Promise((r) => setTimeout(r, 3000))
		expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
		expect(mockLogs.some((m) => m.includes('startup retry: attempt') || m.includes('startup wait'))).toBe(true)
	}, 20_000)

	it('the pre-read is unsupported by the shell: the native rule does not onboard; the start waits (unknown), no generic storage screen', async () => {
		mockPreread.payload = { ok: false, error: 'unknown_command' }
		renderApp()
		// 0.53.39: the legacy route (old shell, no pre-read) takes the shell judgement; with the sealed copy not checkable the no_key onboarding is not taken,
		// and the start waits (undetermined). Log wording revised (stale: 'sealed-copy check unknown' is the no_key branch, not this route).
		await waitFor(() => expect(mockLogs.some((m) => m.includes('account judgement undetermined'))).toBe(true))
		expect(mockLogs.some((m) => m.includes('shell no-key judgement'))).toBe(false)
		expect(screen.queryByText('Wallet storage is unavailable')).toBeNull()
	})

	it('a bridge unknown on the pre-read never onboards (startup wait), even with walletStatus no_key', async () => {
		mockPreread.payload = { ok: false, error: 'envelope_fail' }
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('preread=unknown'))).toBe(true))
		expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
		expect(mockLogs.some((m) => m.includes('shell no-key judgement'))).toBe(false)
	})
})
