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
// the start-up pre-read answer (spec item 42(2)): unknown until a case sets it
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
	// spec item 42(2): the start-up pre-read; a plain function (CRA resets jest.fn implementations between tests)
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
	// rule 2026-11-16 (PWA first): the page is read before the native side. The page is confirmed empty by default, so the
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

describe('the gate is decided, the chat is not initialised', () => {
	// Rewritten for rule (a), 2026-11-16 (spec item 42(5), identity missing and an explicit native no_key with the page
	// confirmed empty is the onboarding. An unknown native answer is the start-up state, never the onboarding (the earlier assertion
	// that unknown goes to the onboarding is superseded by this rule). The child route is never rendered without evidence.
	it('a page that needs no identity does not render its child route without evidence: the start-up state, never the onboarding (rule (a))', async () => {
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

	it('the chat route is blocked without evidence: the start-up state (no explicit no_key), and the chat page does not show (rule (a))', async () => {
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
	// Rewritten for rule (a), 2026-11-16 (spec item 42(5)): a device hint is not evidence, and an unknown native answer is the
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

	// Rewritten for rule 2026-11-16 (spec item 42(5)): the old "5 rounds then onboarding" assertion is replaced by its negative. The
	// bridge hello cadence never routes the wallet: after the probe cap the page stays in the startup wait, not onboarding.
	it('bridge hello: after five unanswered probes the probes stop and the page does not go to onboarding (no route change)', async () => {
		probe.mockImplementation(async () => UNANSWERED)
		await act(async () => {
			renderAt('/settings')
		})
		await flush()
		const start = probe.mock.calls.length
		// 10 s, 30 s, 60 s, 60 s, 60 s: five automatic probes
		await advance(10_000)
		await advance(30_000)
		await advance(60_000)
		await advance(60_000)
		await advance(60_000)
		await flush()
		expect(probe.mock.calls.length).toBe(start + 5)
		// the bridge cap never routes: no onboarding and no home from the hello count
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		// no sixth automatic probe, however long the clock runs
		await advance(600_000)
		expect(probe.mock.calls.length).toBe(start + 5)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})

	it('probes at 10 s, 30 s, 60 s, then every 60 s while unanswered; a manual retry restarts the cadence; the answer stops it', async () => {
		probe.mockImplementation(async () => UNANSWERED)
		await act(async () => {
			renderAt('/settings')
		})
		await flush()
		const start = probe.mock.calls.length // the start's own hello

		await advance(9_999)
		expect(probe.mock.calls.length).toBe(start)
		await advance(1) // 10 s
		expect(probe.mock.calls.length).toBe(start + 1)

		await advance(29_999)
		expect(probe.mock.calls.length).toBe(start + 1)
		await advance(1) // 30 s after the first
		expect(probe.mock.calls.length).toBe(start + 2)

		await advance(59_999)
		expect(probe.mock.calls.length).toBe(start + 2)
		await advance(1) // 60 s after the second
		expect(probe.mock.calls.length).toBe(start + 3)

		await advance(60_000) // every 60 s from then on
		expect(probe.mock.calls.length).toBe(start + 4)
		await advance(60_000)
		expect(probe.mock.calls.length).toBe(start + 5)

		// a manual retry probes at once and starts the cadence again: the next automatic probe is 10 s later
		await act(async () => {
			requestNativeIdentityRetry()
		})
		await flush()
		expect(probe.mock.calls.length).toBe(start + 6)
		await advance(9_999)
		expect(probe.mock.calls.length).toBe(start + 6)
		await advance(1)
		expect(probe.mock.calls.length).toBe(start + 7)

		// the hello answers with the capability: probing stops for good. The declared answer starts one init (its own hello),
		// so the count is taken once that init has settled; from then on no automatic probe runs.
		probe.mockImplementation(async () => DECLARED)
		await advance(10_000)
		// the declared answer runs one init, and that init's zero-delay retry timer fires on the next clock move; the first
		// 60 s step absorbs it. The backoff is what must stop, so the count is compared from there on.
		await advance(60_000)
		const answered = probe.mock.calls.length
		for (let i = 0; i < 10; i++) await advance(60_000)
		expect(probe.mock.calls.length).toBe(answered)
	})
})

