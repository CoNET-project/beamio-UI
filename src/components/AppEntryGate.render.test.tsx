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
jest.mock('@/services/beamio', () => ({ checkStorageWithTransientRetry: jest.fn(), sendPendingProfileSync: jest.fn() }), { virtual: true })
jest.mock('@/services/pendingServerSync', () => ({ registerPendingSender: jest.fn() }), { virtual: true })
jest.mock('@/services/shellRecordStore', () => ({ resumeDeferredWrite: jest.fn() }), { virtual: true })
jest.mock('@/services/nativeKeyState', () => ({ installNativeNoKeyWatcher: () => null, openNativeKeyImport: jest.fn() }), { virtual: true })
jest.mock('@/services/nativeWalletEstablished', () => ({
	NATIVE_WALLET_ESTABLISHED_EVENT: 'beamio:native-wallet-established',
	announceNativeWalletEstablished: jest.fn(),
}), { virtual: true })
jest.mock('@/services/nativeFlowPending', () => ({ NATIVE_FLOW_PENDING_EVENT: 'beamio:native-flow-pending' }), { virtual: true })
jest.mock('@/services/pgpMigrationRunner', () => ({ startPgpMigrationOnce: jest.fn() }), { virtual: true })
jest.mock('@/components/NativeKeyImportRequired', () => () => null, { virtual: true })
jest.mock('@/services/shellChatCapability', () => ({ ensureShellChatState: async () => 'chat_unavailable', shellChatBlockedNow: () => true }), { virtual: true })
jest.mock('@/services/nativeChatRouteRegister', () => ({
	probeNativeCapabilities: jest.fn(async () => ({ answered: true, capabilities: [] })),
}), { virtual: true })
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: jest.fn(),
	reachNativeWallet: async () => ({ status: 'unknown' }),
	rememberNativeEoa: jest.fn(),
}), { virtual: true })
jest.mock('@/utils/globals', () => ({ setCoNET_Data: jest.fn() }), { virtual: true })
jest.mock('@/components/PasscodeLockScreen', () => () => null, { virtual: true })
jest.mock('@/services/walletVaultEvents', () => ({ VAULT_LOCKED_EVENT: 'beamio:vault-locked' }), { virtual: true })
jest.mock('@/components/SplashScreen', () => () => null, { virtual: true })
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }), { virtual: true })
jest.mock('@/pages/Home/LoadingPage', () => () => null, { virtual: true })
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => true }), { virtual: true })
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }), { virtual: true })
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }), { virtual: true })
jest.mock('@/services/shellStoreWait', () => ({ nativeStoreWaitDelayMs: () => 0, splashDeadlineAction: () => 'release' }), { virtual: true })
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: jest.fn() }), { virtual: true })
jest.mock('@/utils/beamioWalletReadyEvent', () => ({ BEAMIO_WALLET_READY_EVENT: 'beamio:wallet-ready', dispatchBeamioWalletReady: jest.fn() }), { virtual: true })
jest.mock('@/utils/consumerWalletGate', () => ({
	hasCompletedBeamioAccount: () => false,
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
	it('a page that needs no identity renders its child route', async () => {
		renderAt('/settings')
		expect(await screen.findByText('SETTINGS-PAGE')).toBeTruthy()
		expect(screen.queryByText('shell_chat_unavailable_title')).toBeNull()
	})

	it('the gate does not replace the app with a full-screen state for the missing capability', async () => {
		renderAt('/settings')
		await screen.findByText('SETTINGS-PAGE')
		expect(screen.queryByText('Native wallet is not ready')).toBeNull()
		expect(screen.queryByText('Wallet storage is unavailable')).toBeNull()
	})

	it('the chat route stays blocked by ShellChatGate: the notice shows, and the chat page does not', async () => {
		renderAt('/Chat')
		await waitFor(() => expect(screen.getByText('shell_chat_unavailable_title')).toBeTruthy())
		expect(screen.queryByText('CHAT-PAGE')).toBeNull()
	})
})

describe('hello answered without identity.native-keys.v1: the decision does not wait for the native status', () => {
	it('with a public address on this device, the local home opens at once and the native status is not awaited', async () => {
		const recovery = jest.requireMock('@/services/nativeRecovery') as { queryNativeWalletState: jest.Mock }
		// a native status query that never answers: a wait on it would hold the splash
		recovery.queryNativeWalletState.mockImplementation(() => new Promise(() => undefined))
		const identity = jest.requireMock('../services/shellIdentitySource') as { readPersistedShellEoa: jest.Mock }
		identity.readPersistedShellEoa.mockImplementation(() => '0x1111111111111111111111111111111111111111')
		renderAt('/settings')
		expect(await screen.findByText('SETTINGS-PAGE')).toBeTruthy()
		expect(recovery.queryNativeWalletState).not.toHaveBeenCalled()
	})

	it('with no public address on this device, the native status is still asked: a locked or unlocked account may enter on its address', async () => {
		const recovery = jest.requireMock('@/services/nativeRecovery') as { queryNativeWalletState: jest.Mock }
		recovery.queryNativeWalletState.mockImplementation(async () => ({ status: 'unknown' }))
		renderAt('/settings')
		expect(await screen.findByText('SETTINGS-PAGE')).toBeTruthy()
		expect(recovery.queryNativeWalletState).toHaveBeenCalled()
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

