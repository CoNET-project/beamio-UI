/**
 * the shell has the wallet decided but the chat is not initialised (no identity.native-keys.v1). The entry gate
 * renders its child routes, so a page that needs no identity keeps working. The chat route stays behind ShellChatGate.
 * Real render. The modules that touch the native bridge or the page stores are replaced by stubs; SYNTHETIC values only.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppEntryGate from './AppEntryGate'
import { ShellChatGate } from './ShellChatUnavailableNotice'
import { setShellChatUiState } from '../services/shellChatUiState'
import { probeNativeCapabilities } from '@/services/nativeChatRouteRegister'
import { requestNativeIdentityRetry, setNativeIdentityCapability } from '../services/nativeIdentityProbeRetry'

// The copy is the key itself, so the test reads which line is shown.
jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }), { virtual: true })
// The PGP notices pull in the PGP stack, which does not load under jest here (same as ShellChatUnavailableNotice.back.test.tsx).
jest.mock('./PgpRestoreFailedNotice', () => () => null)
jest.mock('./PgpFirstIdentityNotice', () => () => null)
jest.mock('../services/pgpRestore', () => ({
	getPgpRestoreFailure: () => null,
	subscribePgpRestoreFailure: () => () => undefined,
}))
jest.mock('../services/shellIdentitySource', () => ({
	getShellFirstIdentity: () => false,
	getShellIdentityPending: () => false,
	subscribeShellFirstIdentity: () => () => undefined,
	subscribeShellIdentityPending: () => () => undefined,
	setShellIdentityPending: () => undefined,
	setShellFirstIdentity: () => undefined,
	persistShellEoa: () => undefined,
	readPersistedShellEoa: jest.fn(() => ''),
}))

// The gate's own dependencies: the '@/' alias does not resolve under jest here, so each one is a virtual stub.
// The gate owns the global bar: it clears the loading flag on entry and sets it on each screen it shows.
jest.mock('@/providers/DaemonProvider', () => ({ useDaemonContext: () => ({ setIsInitialLoading: () => undefined }) }), { virtual: true })
jest.mock('@/services/beamio', () => ({ checkStorageWithTransientRetry: jest.fn(), sendPendingProfileSync: jest.fn(), setPageWritePermit: () => undefined, allowRestoreWrite: () => undefined }), { virtual: true })
jest.mock('@/services/pendingServerSync', () => ({ registerPendingSender: jest.fn() }), { virtual: true })
jest.mock('@/services/shellRecordStore', () => ({ resumeDeferredWrite: jest.fn() }), { virtual: true })
jest.mock('@/services/nativeKeyState', () => ({ installNativeNoKeyWatcher: () => null }), { virtual: true })
jest.mock('@/services/nativeWalletEstablished', () => ({
	NATIVE_WALLET_ESTABLISHED_EVENT: 'beamio:native-wallet-established',
	announceNativeWalletEstablished: jest.fn(),
}), { virtual: true })
jest.mock('@/services/nativeFlowPending', () => ({ NATIVE_FLOW_PENDING_EVENT: 'beamio:native-flow-pending' }), { virtual: true })
jest.mock('@/services/pgpMigrationRunner', () => ({ startPgpMigrationOnce: jest.fn() }), { virtual: true })
jest.mock('@/services/shellChatCapability', () => ({ ensureShellChatState: async () => 'chat_unavailable', shellChatBlockedNow: () => true }), { virtual: true })
jest.mock('@/services/nativeChatRouteRegister', () => ({
	probeNativeCapabilities: jest.fn(async () => ({ answered: true, capabilities: [] })),
}), { virtual: true })
// a holder read by the mock (CRA resets jest.fn implementations between tests; a plain function is not reset)
let mockNativeAnswer: unknown = { status: 'unknown' }
// the start-up pre-read answer (spec r2.4 item 42(2)): unknown until a case sets it
let mockPrereadAnswer: unknown = { kind: 'unknown' }
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: jest.fn(),
	reachNativeWallet: async () => mockNativeAnswer,
	rememberNativeEoa: jest.fn(),
}), { virtual: true })
jest.mock('@/utils/globals', () => ({ setCoNET_Data: jest.fn() }), { virtual: true })
jest.mock('@/components/PasscodeLockScreen', () => () => null, { virtual: true })
jest.mock('@/services/walletVaultEvents', () => ({ VAULT_LOCKED_EVENT: 'beamio:vault-locked' }), { virtual: true })
jest.mock('@/components/SplashScreen', () => () => null, { virtual: true })
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }), { virtual: true })
jest.mock('@/pages/Home/LoadingPage', () => {
	const R = require('react')
	return () => R.createElement('div', null, 'ONBOARDING-PAGE')
}, { virtual: true })
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => true }), { virtual: true })
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }), { virtual: true })
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }), { virtual: true })
jest.mock('@/services/shellStoreWait', () => ({ nativeStoreWaitDelayMs: () => 0, splashDeadlineAction: () => 'release' }), { virtual: true })
jest.mock('@/services/nativeRecovery', () => ({
	queryNativeWalletStatus: async () => mockNativeAnswer,
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
	// 0.53.39: the start route reads passcodeStatus (walletState and hasKey) after the pre-read; the stub reports no state and no key marker
	queryNativePasscodeStatus: async () => ({ walletState: 'not_reported', hasKey: 'not_reported' }),
	// spec r2.4 item 42(2): the start-up pre-read; a plain function (CRA resets jest.fn implementations between tests)
	queryNativeMnemonicPreread: async () => mockPrereadAnswer,
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: jest.fn() }), { virtual: true })
jest.mock('@/utils/beamioWalletReadyEvent', () => ({ BEAMIO_WALLET_READY_EVENT: 'beamio:wallet-ready', dispatchBeamioWalletReady: jest.fn() }), { virtual: true })
jest.mock('@/utils/consumerWalletGate', () => ({
	hasCompletedBeamioAccount: () => false,
	validMnemonicEoa: jest.fn(() => ''),
	hasLocalPlaintextMnemonic: () => false,
	isTrustedEmptyWalletBlob: () => false,
	pageWalletRecoverNeeded: () => false,
}), { virtual: true })
// The decision is the real pure function: the test is about what the gate renders with it.
jest.mock('@/services/shellEntryDecision', () => jest.requireActual('../services/shellEntryDecision'), { virtual: true })
jest.mock('@/services/bridgeGuard', () => ({ IDENTITY_CAPABILITY_MISSING: 'identity_capability_missing' }), { virtual: true })

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route element={<AppEntryGate />}>
					<Route path="/settings" element={<div>SETTINGS-PAGE</div>} />
					<Route path="/Chat" element={<ShellChatGate><div>CHAT-PAGE</div></ShellChatGate>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	)
}

beforeEach(() => {
	// The shell's chat state is unavailable: no identity capability.
	setShellChatUiState('chat_unavailable')
	// CRA resets mock implementations before each test: the default hello answer (answered, no capability) is set here.
	;(probeNativeCapabilities as unknown as jest.Mock).mockImplementation(async () => ({ answered: true, capabilities: [] }))
	// the page is read before the native side. The page is confirmed empty by default, so the
	// routes below are decided by the native answer. Without this a page read returns undefined, which is unknown (startup wait).
	;(jest.requireMock('@/services/beamio') as { checkStorageWithTransientRetry: jest.Mock }).checkStorageWithTransientRetry.mockResolvedValue({ status: 'empty' })
})

afterEach(() => {
	const probe = probeNativeCapabilities as unknown as jest.Mock
	probe.mockReset()
	probe.mockImplementation(async () => ({ answered: true, capabilities: [] }))
	const recovery = jest.requireMock('@/services/nativeRecovery') as { queryNativeWalletState: jest.Mock }
	recovery.queryNativeWalletState.mockReset()
	recovery.queryNativeWalletState.mockImplementation(async () => ({ status: 'unknown' }))
	const identity = jest.requireMock('../services/shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
	identity.readPersistedShellEoa.mockReset()
	identity.readPersistedShellEoa.mockImplementation(() => '')
})

describe('the gate is decided, the chat is not initialised (R66: no evidence, no home)', () => {
	// Rewritten for the current rule (a), 2026-11-16 (spec r2.4 item 42(5), §25.29.5): identity missing and an explicit native no_key with the page
	// confirmed empty is the onboarding. An unknown native answer is the start-up state, never the onboarding (the earlier R66 assertion
	// that unknown goes to the onboarding is superseded by this rule). The child route is never rendered without evidence.
	it('a page that needs no identity does not render its child route without evidence: the start-up state, never the onboarding', async () => {
		renderAt('/settings')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
	})

	it('explicit no_key without the native mnemonic read capability remains unknown, never onboarding', async () => {
		;(jest.requireMock('@/services/nativeRecovery') as { queryNativeWalletState: jest.Mock }).queryNativeWalletState.mockResolvedValue('absent')
		mockNativeAnswer = { status: 'no_key' }
		renderAt('/settings')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
	})

	it('the chat route is blocked without evidence: the start-up state (no explicit no_key), and the chat page does not show', async () => {
		renderAt('/Chat')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('CHAT-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
})

describe('native identity capability is missing: address and status do not establish a wallet', () => {
	const EOA_PAGE = '0x2222222222222222222222222222222222222222'
	const beamioMock = () => jest.requireMock('@/services/beamio') as { checkStorageWithTransientRetry: jest.Mock }
	const walletMock = () => jest.requireMock('@/utils/consumerWalletGate') as { validMnemonicEoa: jest.Mock }
	const recoveryMock = () => jest.requireMock('@/services/nativeRecovery') as { queryNativeWalletState: jest.Mock }
	const nativeWalletMock = () => jest.requireMock('@/services/nativeWallet') as { reachNativeWallet: jest.Mock }
	beforeEach(() => {
		beamioMock().checkStorageWithTransientRetry.mockReset()
		beamioMock().checkStorageWithTransientRetry.mockResolvedValue({ status: 'empty' })
		walletMock().validMnemonicEoa.mockReset()
		walletMock().validMnemonicEoa.mockReturnValue('')
		mockNativeAnswer = { status: 'unknown' }
	})
	afterEach(() => {
		mockNativeAnswer = { status: 'unknown' }
	})
	it('1. an unlocked native address without the mnemonic pre-read capability remains unknown; no home or onboarding', async () => {
		recoveryMock().queryNativeWalletState.mockResolvedValue('unlocked')
		mockNativeAnswer = { status: 'unlocked', eoa: EOA_PAGE }
		renderAt('/settings')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
	it('2. a valid PWA mnemonic still opens the home without requiring native capability', async () => {
		recoveryMock().queryNativeWalletState.mockResolvedValue({ status: 'unknown' })
		beamioMock().checkStorageWithTransientRetry.mockResolvedValue({ status: 'loaded', data: { profiles: [] } })
		walletMock().validMnemonicEoa.mockReturnValue(EOA_PAGE)
		renderAt('/settings')
		expect(await screen.findByText('SETTINGS-PAGE', {}, { timeout: 3000 })).toBeTruthy()
	})
	// Rewritten for the current rule (a), 2026-11-16 (spec r2.4 item 42(5)): a device hint is not evidence, and an unknown native answer is the
	// start-up state. Neither the home nor the onboarding is shown.
	it('3. the native side unusable and only a device hint: not the home, and not the onboarding (start-up state, rule (a))', async () => {
		recoveryMock().queryNativeWalletState.mockResolvedValue({ status: 'unknown' })
		const identity = jest.requireMock('../services/shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
		identity.readPersistedShellEoa.mockImplementation(() => EOA_PAGE)
		renderAt('/settings')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
})

describe('the identity hello backoff, run by the gate timer (fake timers)', () => {
	const probe = probeNativeCapabilities as unknown as jest.Mock
	const UNANSWERED = { answered: false, capabilities: [] as string[] }
	const DECLARED = { answered: true, capabilities: ['identity.native-keys.v1'] }
	const beamio = () => jest.requireMock('@/services/beamio') as { checkStorageWithTransientRetry: jest.Mock }
	/** The page read is controlled by the test (2026-11-22, pre-read in flight). The first read answers empty, so the start asks the
	 *  hello and the cadence begins. Later reads stay in flight until the test releases the held one, so no start round probes on its own:
	 *  the probes are the hello cadence's. */
	let releaseHeldRead: ((v: unknown) => void) | undefined
	let pageReadsOpen = false
	const holdPageReads = () => {
		pageReadsOpen = false
		beamio().checkStorageWithTransientRetry.mockReset()
		beamio().checkStorageWithTransientRetry.mockResolvedValueOnce({ status: 'empty' })
		beamio().checkStorageWithTransientRetry.mockImplementation(() => (pageReadsOpen ? Promise.resolve({ status: 'empty' }) : new Promise((resolve) => { releaseHeldRead = resolve })))
	}
	/** Releases the held read and lets later reads answer at once (the manual retry then runs on any gate version). */
	const openPageReads = () => {
		pageReadsOpen = true
		releaseHeldRead?.({ status: 'empty' })
	}
	/** Each hello with its fake-clock time (ms since the start of the test) and the most hellos in flight at once. */
	const trace: { t0: number; at: number[]; inFlight: number; maxInFlight: number } = { t0: 0, at: [], inFlight: 0, maxInFlight: 0 }
	const recordProbes = (answer: unknown) => {
		trace.t0 = Date.now()
		trace.at = []
		trace.inFlight = 0
		trace.maxInFlight = 0
		probe.mockImplementation(async () => {
			trace.at.push(Date.now() - trace.t0)
			trace.inFlight += 1
			trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight)
			await Promise.resolve()
			trace.inFlight -= 1
			return answer
		})
	}
	/** Moves the clock and lets the gate's async probe and its state effects settle. */
	const advance = async (ms: number) => {
		await act(async () => {
			jest.advanceTimersByTime(ms)
		})
	}
	const flush = async () => {
		await act(async () => {
			await Promise.resolve()
		})
	}

	beforeEach(() => {
		jest.useFakeTimers()
		setNativeIdentityCapability('unknown')
	})
	afterEach(() => {
		jest.useRealTimers()
		setNativeIdentityCapability('unknown')
	})

	// Rewritten 2026-11-22 (pre-read in flight): the hello cadence is pinned by its fake-clock times (10 s, then 30 s, 60 s, 60 s, 60 s)
	// and by the probes never overlapping (max in flight 1). The page read is test-controlled (see holdPageReads).
	it('bridge hello: after five unanswered probes the probes stop and the page does not go to onboarding (no route change)', async () => {
		holdPageReads()
		recordProbes(UNANSWERED)
		await act(async () => {
			renderAt('/settings')
		})
		await flush()
		// the start's own hello at 0, then 10 s, 30 s, 60 s, 60 s, 60 s: five automatic probes
		await advance(10_000)
		await advance(30_000)
		await advance(60_000)
		await advance(60_000)
		await advance(60_000)
		await flush()
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000, 220_000])
		expect(trace.maxInFlight).toBe(1)
		// the bridge cap never routes: no onboarding and no home from the hello count
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		// no sixth automatic probe, however long the clock runs
		await advance(600_000)
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000, 220_000])
		expect(trace.maxInFlight).toBe(1)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})

	it('probes at 10 s, 30 s, 60 s, then every 60 s while unanswered; a manual retry restarts the cadence; the answer stops it', async () => {
		holdPageReads()
		recordProbes(UNANSWERED)
		await act(async () => {
			renderAt('/settings')
		})
		await flush()
		await advance(9_999)
		expect(trace.at).toEqual([0])
		await advance(1) // 10 s
		expect(trace.at).toEqual([0, 10_000])
		await advance(29_999)
		expect(trace.at).toEqual([0, 10_000])
		await advance(1) // 30 s after the first
		expect(trace.at).toEqual([0, 10_000, 40_000])
		await advance(59_999)
		expect(trace.at).toEqual([0, 10_000, 40_000])
		await advance(1) // 60 s after the second
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000])
		await advance(60_000) // every 60 s from then on
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000])
		await advance(60_000)
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000, 220_000])

		// a manual retry probes at once and starts the cadence again. The held page read is released in the same act: the retry
		// awaits it (no second read), and the hello is asked once, at the retry.
		await act(async () => {
			openPageReads()
			requestNativeIdentityRetry()
		})
		await flush()
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000, 220_000, 220_000])
		// the next automatic probe is 10 s later
		await advance(9_999)
		expect(trace.at.length).toBe(7)
		await advance(1)
		expect(trace.at).toEqual([0, 10_000, 40_000, 100_000, 160_000, 220_000, 220_000, 230_000])
		expect(trace.maxInFlight).toBe(1)

		// the hello answers with the capability: probing stops for good. The declared answer runs one init (its own hello), so the
		// count is taken once that init has settled; from then on no automatic probe runs.
		probe.mockImplementation(async () => DECLARED)
		await advance(10_000)
		await advance(60_000)
		const answered = trace.at.length
		for (let i = 0; i < 10; i++) await advance(60_000)
		expect(trace.at.length).toBe(answered)
	})
})
