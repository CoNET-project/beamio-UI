/**
 * C 的 AppEntryGate 级 sync_pending 交接测试（2026-11-22, item 1）。
 *
 * 渲染真实 AppEntryGate（原生壳）。其注册的 setSyncPendingHandler、真实的 handOffSyncPending、sendCipherOnce、
 * shellMnemonicSync.syncCipher、sendPwaWalletSyncCipher 与 mapCipherSyncReply 全部参与；只在 I/O 边界替换：
 * 原生桥 sendShellWalletSyncCommand、IndexedDB 读取及其余原生服务。时间由 fake timers 确定性推进。
 * 合成数据：无真实口令、助记词或地址。
 *
 * 退避节奏：单次 syncCipher 内层重试 2 s / 10 s / 30 s；gate 外层未确认后按 startupRetryDelayMs 2 s、4 s…重试。
 * 只有原生桥回 ok 且 stored=true、readback=match、decrypted 与无口令分支一致（false）时才完成；完成后不再发送。
 * 环境与 harness 参照 AppEntryGate.unitGPasscode.test.tsx。
 */
import { act, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppEntryGate from './AppEntryGate'
import { handOffSyncPending, setSyncPendingHandler } from '@/services/passcode/syncPendingHandoff'
import { allowFirstNativeWrite, retryDeferredWriteNow } from '@/services/shellRecordStore'
import { getShellSyncState, resetShellSyncStatus } from '@/services/shellSyncStatus'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const CIPHER = { v: 3, mode: 'passcode', alg: 'AES-256-GCM', kdf: 'pbkdf2', salt: 'synthetic-salt', iv: 'synthetic-iv', ct: 'synthetic-ct-A', eoa: EOA }

type Reply = { ok: boolean; result?: Record<string, unknown>; error?: string; reason?: string } | 'throw'
type BridgeState = { script: Reply[]; fallback: Reply; sends: Array<{ at: number; seq: number; hasPasscode: boolean; ct: string }>; t0: number }

const OK_CONFIRMED: Reply = { ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: false } }

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }), { virtual: true })
jest.mock('./PgpRestoreFailedNotice', () => () => null)
jest.mock('./PgpFirstIdentityNotice', () => () => null)
jest.mock('../services/pgpRestore', () => ({ getPgpRestoreFailure: () => null, subscribePgpRestoreFailure: () => () => undefined }))
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
jest.mock('@/providers/DaemonProvider', () => ({ useDaemonContext: () => ({ setIsInitialLoading: () => undefined }) }), { virtual: true })
jest.mock('@/services/beamio', () => ({
	checkStorageWithStatus: jest.fn(async () => ({ status: 'empty' })),
	checkStorageWithStatusWithTimeout: jest.fn(async () => ({ status: 'empty' })),
	checkStorageWithTransientRetry: async () => (globalThis as { __idbPage?: unknown }).__idbPage,
	persistPageIdbMnemonic: async () => 'verified',
	readStoredRecordForVerify: jest.fn(async () => null),
	storeSystemDataAndWait: jest.fn(async () => true),
	sendPendingProfileSync: jest.fn(),
	setPageWritePermit: () => undefined,
	allowRestoreWrite: () => undefined,
	endRestoreWriteWindow: () => undefined,
}), { virtual: true })
jest.mock('@/services/pendingSync', () => ({
	markPendingSync: (reason: string) => {
		;(globalThis as { __pendingMarks?: string[] }).__pendingMarks!.push(reason)
	},
	takePendingSync: () => null,
}), { virtual: true })
jest.mock('@/services/pendingServerSync', () => ({ registerPendingSender: jest.fn() }), { virtual: true })
jest.mock('@/services/shellRecordStore', () => ({ resumeDeferredWrite: jest.fn(), allowFirstNativeWrite: jest.fn(), retryDeferredWriteNow: jest.fn(), retryDeferredWriteNow2: jest.fn() }), { virtual: true })
jest.mock('@/services/nativeKeyState', () => ({ installNativeNoKeyWatcher: () => null, NO_KEY_ERROR: 'no_key' }), { virtual: true })
jest.mock('@/services/nativeWalletEstablished', () => ({ NATIVE_WALLET_ESTABLISHED_EVENT: 'beamio:native-wallet-established', announceNativeWalletEstablished: jest.fn() }), { virtual: true })
jest.mock('@/services/nativeFlowPending', () => ({ NATIVE_FLOW_PENDING_EVENT: 'beamio:native-flow-pending' }), { virtual: true })
jest.mock('@/services/pgpMigrationRunner', () => ({ startPgpMigrationOnce: jest.fn() }), { virtual: true })
jest.mock('@/services/shellChatCapability', () => ({
	ensureShellChatState: () => {
		;(globalThis as { __order?: string[] }).__order!.push('chat')
		return Promise.resolve('chat_unavailable')
	},
	shellChatBlockedNow: () => true,
}), { virtual: true })
jest.mock('@/services/nativeChatRouteRegister', () => ({
	helloWithinWindow: () => true,
	onHelloValid: () => () => undefined,
	getCachedHello: () => undefined,
	getCachedHelloRaw: () => undefined,
	probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }),
	requestNativeAck: jest.fn(async () => ({ kind: 'none' })),
}), { virtual: true })
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: (eoa: string) => ({ profiles: [{ keyID: eoa, isPrimary: true }] }),
	reachNativeWallet: async () => ({ status: 'unknown' }),
	rememberNativeEoa: jest.fn(),
	releaseInitLockedHold: jest.fn(),
	takeInitRefusal: () => null,
}), { virtual: true })
jest.mock('@/services/shellSessionSigner', () => ({
	holdShellSessionFromPhrase: () => ({ kind: 'ok' }),
	releaseShellSessionSignerHold: jest.fn(),
	loadShellSessionSigner: jest.fn(),
	recordCarriesAccountKey: () => false,
	refreshShellSessionInMemory: jest.fn(),
	shellSessionEoa: () => '',
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
// the native shell flag is switched per test (globalThis.__native); the default is the native shell
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => (globalThis as { __native?: boolean }).__native !== false,
	getCashTreesNativeNfcHost: () => null,
}), { virtual: true })
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (_level: string, message: string) => {
		;(globalThis as { __logs?: string[] }).__logs!.push(String(message))
	},
}), { virtual: true })
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }), { virtual: true })
jest.mock('@/services/shellStoreWait', () => {
	const actual = jest.requireActual('../services/shellStoreWait')
	return { ...actual, nativeStoreWaitDelayMs: () => 0, splashDeadlineAction: () => 'release' }
}, { virtual: true })
// I/O boundary only: the native bridge. The page code above it (pwaWalletSyncTransport mapping, shellMnemonicSync retries) is real.
jest.mock('@/services/shellRecordTransport', () => {
	const actual = jest.requireActual('../services/shellRecordTransport')
	return {
		...actual,
		shellRecordTransportKind: () => 'window',
		sendShellWalletSyncCommand: async (cmd: { type?: string; seq?: number; cipher?: { ct?: unknown }; passcode?: unknown }) => {
			const b = (globalThis as { __bridge?: BridgeState }).__bridge!
			if (cmd.type !== 'pwaWalletSync') return { kind: 'none' }
			b.sends.push({ at: Date.now() - b.t0, seq: Number(cmd.seq), hasPasscode: 'passcode' in cmd, ct: String(cmd.cipher?.ct) })
			const next = b.script.length > 0 ? b.script.shift()! : b.fallback
			if (next === 'throw') throw new Error('synthetic bridge: no answer')
			return { kind: 'payload', payload: next }
		},
	}
}, { virtual: true })
jest.mock('@/services/nativeRecovery', () => ({
	queryNativeWalletStatus: async () => (globalThis as { __walletStatusAnswer?: unknown }).__walletStatusAnswer ?? { status: 'no_key' },
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(() => () => undefined),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
	queryNativePasscodeStatus: async () => ({ walletState: 'not_reported', hasKey: 'not_reported' }),
	queryNativeMnemonicPreread: async () => ({ kind: 'unknown' }),
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: jest.fn() }), { virtual: true })
jest.mock('@/utils/beamioWalletReadyEvent', () => ({ BEAMIO_WALLET_READY_EVENT: 'beamio:wallet-ready', dispatchBeamioWalletReady: jest.fn() }), { virtual: true })
jest.mock('@/utils/consumerWalletGate', () => ({
	hasCompletedBeamioAccount: () => false,
	validMnemonicEoa: () => '',
	hasValidMnemonic: () => false,
	hasLocalPlaintextMnemonic: () => false,
	hasLocalSigningMaterial: () => false,
	isTrustedEmptyWalletBlob: (d: unknown) => !d || Object.keys(d as object).length === 0,
	pageWalletRecoverNeeded: () => false,
}), { virtual: true })
jest.mock('@/services/bridgeGuard', () => ({ IDENTITY_CAPABILITY_MISSING: 'identity_capability_missing' }), { virtual: true })

/** Lets the async sync chain run between fake-timer steps (Jest 27: no advanceTimersByTimeAsync). */
const flush = async () => {
	for (let i = 0; i < 100; i++) await Promise.resolve()
}

/** Advances the fake clock in 1 s steps; each step lets the chain set its next timer at the right time. */
async function runFor(ms: number) {
	for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
		await act(async () => {
			// run pending continuations first, so each timer is set at the current fake time
			await flush()
			jest.advanceTimersByTime(1000)
			await flush()
		})
	}
}

const bridge = () => (globalThis as { __bridge?: BridgeState }).__bridge!
const sentAt = () => bridge().sends.map((s) => s.at)
const logs = () => (globalThis as { __logs?: string[] }).__logs!
const confirmedLogged = () => logs().some((l) => l.includes('cipher confirmed by the shell read-back'))

function renderGate() {
	return render(
		<MemoryRouter initialEntries={['/settings']}>
			<Routes>
				<Route element={<AppEntryGate />}>
					<Route path="/settings" element={<div>SETTINGS-PAGE</div>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	)
}

beforeEach(() => {
	jest.useFakeTimers()
	const g = globalThis as Record<string, unknown>
	g.__native = true
	// IndexedDB unknown: the gate holds and sends nothing by itself, so every bridge call below comes from the hand-off
	g.__idbPage = { status: 'unavailable', reason: 'native_retry' }
	g.__walletStatusAnswer = { status: 'no_key' }
	const bridgeState: BridgeState = { script: [], fallback: 'throw', sends: [], t0: Date.now() }
	g.__bridge = bridgeState
	g.__logs = []
	g.__pendingMarks = []
	g.__order = []
	g.__chatNever = false
	g.__persistCalls = { n: 0 }
	g.__calls = { preread: 0, walletStatus: 0, passcode: 0 }
	jest.clearAllMocks()
	resetShellSyncStatus()
	setSyncPendingHandler(null)
})

afterEach(() => {
	setSyncPendingHandler(null)
	jest.useRealTimers()
})

describe('AppEntryGate sync_pending 交接（原生壳，真实 handOff 与 sendCipherOnce）', () => {
	it('未注册时 handOffSyncPending 返回 false，不发送，也不在此重试', async () => {
		expect(handOffSyncPending(CIPHER, EOA)).toBe(false)
		await runFor(5000)
		expect(bridge().sends).toHaveLength(0)
	})

	it('原生壳渲染 AppEntryGate 后已注册：交接给 sendCipherOnce，发出一次不带口令的 pwaWalletSync', async () => {
		bridge().script = [OK_CONFIRMED]
		renderGate()
		await runFor(1000)
		expect(bridge().sends).toHaveLength(0) // the gate sends nothing by itself while IndexedDB is unknown
		expect(handOffSyncPending(CIPHER, EOA)).toBe(true)
		await runFor(1000)
		expect(bridge().sends).toHaveLength(1)
		expect(bridge().sends[0].hasPasscode).toBe(false)
		expect(bridge().sends[0].ct).toBe(CIPHER.ct)
	})

	it('卸载 AppEntryGate 后注销：之后 handOffSyncPending 返回 false，不发送', async () => {
		const { unmount } = renderGate()
		await runFor(1000)
		unmount()
		expect(handOffSyncPending(CIPHER, EOA)).toBe(false)
		await runFor(5000)
		expect(bridge().sends).toHaveLength(0)
	})

	it('非原生壳（浏览器）不注册：handOffSyncPending 返回 false', async () => {
		;(globalThis as { __native?: boolean }).__native = false
		renderGate()
		await runFor(1000)
		expect(handOffSyncPending(CIPHER, EOA)).toBe(false)
		await runFor(5000)
		expect(bridge().sends).toHaveLength(0)
	})

	it('读回前不计完成：stored=false、readback 不符、decrypted 与无口令分支不一致、write_failed 均不写完成标记，也不停止重试', async () => {
		bridge().script = [
			{ ok: true, result: { code: 'ok', stored: false, readback: 'match', decrypted: false } },
			{ ok: true, result: { code: 'ok', stored: true, readback: 'mismatch', decrypted: false } },
			{ ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: true } },
			{ ok: false, error: 'write_failed', reason: 'storage_write' },
		]
		renderGate()
		handOffSyncPending(CIPHER, EOA)
		// sends at 0 s, 2 s, 12 s (inner schedule 2 s / 10 s), 42 s (write_failed: no inner retry), gate retry after 2 s: none before 44 s
		await runFor(43000)
		expect(sentAt()).toEqual([0, 2000, 12000, 42000])
		expect(allowFirstNativeWrite).not.toHaveBeenCalled()
		expect(retryDeferredWriteNow).not.toHaveBeenCalled()
		expect(confirmedLogged()).toBe(false)
		expect(getShellSyncState().kind).not.toBe('synced')
	})

	it('退避节奏：内层 2 s / 10 s / 30 s，外层 startupRetryDelayMs 2 s 起；读回确认（stored、readback match、decrypted=false）后才完成，且不再重试', async () => {
		bridge().script = ['throw', 'throw', 'throw', 'throw', OK_CONFIRMED]
		renderGate()
		handOffSyncPending(CIPHER, EOA)
		await runFor(43000)
		expect(sentAt()).toEqual([0, 2000, 12000, 42000])
		expect(allowFirstNativeWrite).not.toHaveBeenCalled()
		expect(confirmedLogged()).toBe(false)

		await runFor(1000) // 44 s: the outer retry (2 s after the first round) sends the same cipher and is confirmed
		expect(sentAt()).toEqual([0, 2000, 12000, 42000, 44000])
		expect(allowFirstNativeWrite).toHaveBeenCalledWith(EOA)
		expect(retryDeferredWriteNow).toHaveBeenCalled()
		expect(confirmedLogged()).toBe(true)
		expect(getShellSyncState().kind).toBe('synced')

		// completed: the same hand-off again and a long wait send nothing more
		expect(handOffSyncPending(CIPHER, EOA)).toBe(true)
		await runFor(120000)
		expect(sentAt()).toHaveLength(5)
	})

	it('M6 v3.3: a store-only sync refused with bad_request (or another closed refusal code) is terminal: sent once, not retried, a code-only log', async () => {
		for (const error of ['bad_request', 'verify_failed', 'unlock_failed', 'key_over_bridge_refused']) {
			resetShellSyncStatus()
			setSyncPendingHandler(null)
			bridge().sends.length = 0
			;(globalThis as { __logs?: string[] }).__logs = []
			bridge().script = [{ ok: false, error }]
			bridge().fallback = { ok: false, error }
			const { unmount } = renderGate()
			handOffSyncPending({ ...CIPHER, ct: `ct-${error}` }, EOA)
			await runFor(120000)
			expect(bridge().sends).toHaveLength(1)
			expect(logs().some((l) => l.includes(`cipher sync refused (code=${error})`))).toBe(true)
			expect(logs().join('\n')).not.toContain(CIPHER.ct)
			expect(getShellSyncState().kind).toBe('failed')
			unmount()
		}
	})

	it('同一密文进行中再次交接不重复发送（in-flight 去重）', async () => {
		renderGate()
		handOffSyncPending(CIPHER, EOA)
		handOffSyncPending(CIPHER, EOA)
		await runFor(1000)
		expect(bridge().sends).toHaveLength(1)
	})
})
