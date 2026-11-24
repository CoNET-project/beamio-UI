/**
 * Unit g (rev 2, runtime): a native passcode_not_provided answer never changes the landing. Rendered gate, synthetic accounts only.
 * Copied harness of AppEntryGate.idbFirst.test.tsx (same mocks, same real gate code).
 *
 * Unit (b), the decision (gate level, synthetic accounts only). The page's IndexedDB is read first and on its own:
 * - a valid mnemonic there enters /home with no native recovery or pre-read query, and the native sync targets the same mnemonic only;
 * - the native pre-read is asked only when the page IndexedDB is definitively absent;
 * - an unknown IndexedDB read is held (no pre-read, no onboarding);
 * - a pre-read valid answer is written to IndexedDB and must read back (independent mnemonic read, derived address) before /home;
 * - Android first-unknown: one quick re-request (not a verdict), then the second answer decides (valid -> home; absent -> onboarding);
 * - not_ready (either answer shape) and envelope errors are unknown: never onboarding;
 * - a sync that did not finish records pending sync only; home is unchanged.
 * The storage, native bridge and PouchDB are replaced at their I/O boundary. The decisions are the real gate code. Derivation of the phrase
 * is a fixture (jsdom cannot run ethers' derivation here); the derivation itself is covered by the node-environment test.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppEntryGate from './AppEntryGate'

const EOA_LOCAL = '0x1111111111111111111111111111111111111111'
const EOA_NATIVE = '0x2222222222222222222222222222222222222222'
const EOA_OLD = '0x3333333333333333333333333333333333333333'
const PHRASE_LOCAL = 'local synthetic phrase one'
const PHRASE_NATIVE = 'native synthetic phrase two'
const PHRASE_OLD = 'old synthetic phrase three'

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
	persistPageIdbMnemonic: async () => {
		;(globalThis as { __persistCalls?: { n: number } }).__persistCalls!.n += 1
		return (globalThis as { __writeVerdict?: string }).__writeVerdict ?? 'verified'
	},
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
		return (globalThis as { __chatNever?: boolean }).__chatNever ? new Promise(() => undefined) : Promise.resolve('chat_unavailable')
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
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => true, getCashTreesNativeNfcHost: () => null }), { virtual: true })
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
jest.mock('@/services/shellMnemonicSync', () => {
	const actual = jest.requireActual('../services/shellMnemonicSync')
	return {
		...actual,
		pageSyncPayload: (ev: { kind: string; phrase?: string; eoa?: string }) => (ev.kind === 'valid' && ev.phrase && ev.eoa ? { phrase: ev.phrase, eoa: ev.eoa } : null),
		shellMnemonicSync: {
			...actual.shellMnemonicSync,
			sync: async (phrase: string, eoa: string) => {
				;(globalThis as { __syncCalls?: Array<{ phrase: string; eoa: string }> }).__syncCalls!.push({ phrase, eoa })
				return (globalThis as { __syncAnswer?: unknown }).__syncAnswer
			},
		},
	}
}, { virtual: true })
jest.mock('@/services/nativeRecovery', () => ({
	queryNativeWalletStatus: async () => {
		;(globalThis as { __calls?: { walletStatus: number } }).__calls!.walletStatus += 1
		return (globalThis as { __walletStatusAnswer?: unknown }).__walletStatusAnswer ?? { status: 'no_key' }
	},
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(() => () => undefined),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
	queryNativePasscodeStatus: async () => {
		;(globalThis as { __calls?: { passcode: number } }).__calls!.passcode += 1
		return { walletState: 'not_reported', hasKey: 'not_reported' }
	},
	queryNativeMnemonicPreread: async () => {
		const g = globalThis as { __calls?: { preread: number }; __prereadAnswers?: unknown[] }
		g.__calls!.preread += 1
		;(g as { __order?: string[] }).__order!.push('preread')
		const list = g.__prereadAnswers ?? []
		return list.length > 1 ? list.shift() : (list[0] ?? { kind: 'unknown' })
	},
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: jest.fn() }), { virtual: true })
jest.mock('@/utils/beamioWalletReadyEvent', () => ({ BEAMIO_WALLET_READY_EVENT: 'beamio:wallet-ready', dispatchBeamioWalletReady: jest.fn() }), { virtual: true })
jest.mock('@/utils/consumerWalletGate', () => {
	// fixture derivation: the synthetic phrases map to their synthetic addresses (jsdom cannot run the real derivation here)
	const fixtures: Record<string, string> = {
		'local synthetic phrase one': '0x1111111111111111111111111111111111111111',
		'native synthetic phrase two': '0x2222222222222222222222222222222222222222',
		'old synthetic phrase three': '0x3333333333333333333333333333333333333333',
	}
	const eoaOf = (d: any): string => (typeof d?.mnemonicPhrase === 'string' ? fixtures[d.mnemonicPhrase] ?? '' : '')
	return {
		hasCompletedBeamioAccount: () => false,
		validMnemonicEoa: (d: any) => eoaOf(d),
		hasValidMnemonic: (d: any) => eoaOf(d) !== '',
		hasLocalPlaintextMnemonic: () => false,
		hasLocalSigningMaterial: () => false,
		isTrustedEmptyWalletBlob: (d: any) => !d || Object.keys(d).length === 0,
		pageWalletRecoverNeeded: () => false,
	}
}, { virtual: true })
jest.mock('@/services/bridgeGuard', () => ({ IDENTITY_CAPABILITY_MISSING: 'identity_capability_missing' }), { virtual: true })

// Synthetic fixture page records (the IndexedDB read result shape: status loaded with the record).
const pageLocal = () => ({ status: 'loaded', data: { mnemonicPhrase: PHRASE_LOCAL, profiles: [{ keyID: EOA_LOCAL }], beamio: {} } })
const PASSCODE_NOT_READY = { status: 'not_ready', notReadyReason: 'passcode_not_provided' }

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route element={<AppEntryGate />}>
					<Route path="/settings" element={<div>SETTINGS-PAGE</div>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	)
}

beforeEach(() => {
	const g = globalThis as Record<string, any>
	g.__idbPage = { status: 'empty' }
	g.__prereadAnswers = []
	g.__writeVerdict = 'verified'
	g.__walletStatusAnswer = PASSCODE_NOT_READY
	g.__syncAnswer = { kind: 'synced', tx: 1 }
	g.__calls = { preread: 0, walletStatus: 0, passcode: 0 }
	g.__persistCalls = { n: 0 }
	g.__syncCalls = []
	g.__pendingMarks = []
	g.__logs = []
	g.__order = []
	g.__chatNever = false
})

describe('unit g runtime: a native passcode_not_provided answer does not change the landing', () => {
	it('local IDB valid and native walletStatus not_ready passcode_not_provided: the rendered gate enters /home', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
	})

	it('local IDB valid and native pre-read valid answer carrying the passcode state: /home on the page EOA', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'passcode_not_provided' }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(g.__calls.preread).toBe(0)
	})

	it('reverse: IDB absent, pre-read answers absent, walletStatus answers passcode_not_provided: no onboarding, data kept, background wait, inconsistency logged', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/settings')
		await settle(1200)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(g.__calls.preread).toBeGreaterThanOrEqual(1)
		expect((g.__logs as string[]).some((l) => l.includes('reason=passcode_preread_inconsistent'))).toBe(true)
		expect((g.__logs as string[]).some((l) => l.includes('no onboarding, data kept'))).toBe(true)
	})

	it('legacy B: an old shell whose answers carry no passcode state: IDB absent, pre-read absent, walletStatus no_key -> onboarding, as before', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		g.__walletStatusAnswer = { status: 'no_key' }
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect((g.__logs as string[]).some((l) => l.includes('passcode_preread_inconsistent'))).toBe(false)
	})

	it('IDB absent, pre-read valid: /home on the pre-read account even though the native passcode state is reported', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})

	it('IDB unknown is still held (not passcode): no pre-read, no onboarding, no home', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'unavailable', reason: 'native_retry' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/settings')
		await settle(300)
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
	})
})

const settle = (ms: number) => act(async () => {
	await new Promise((resolve) => setTimeout(resolve, ms))
})


describe('unit g runtime: the preread current record as is (the decision; PRR-02, PRR-03, PRR-04, PRR-05, PRR-07, PRR-06)', () => {
	it('PRR-02/05/07 ciphertext current, no passcode, SDK not initialised, walletStatus passcode pending: the unlock page at once, no onboarding, no home', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'cipher', cipher: {
			v: 3,
			mode: 'passcode',
			eoa: '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f',
			kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32',
			salt: 'AAECAwQFBgcICQoLDA0ODw==',
			iv: 'AAECAwQFBgcICQoL',
			alg: 'AES-256-GCM',
			ct: 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0=',
		} }]
		renderAt('/settings')
		// current shape: a ciphertext record is the pre-read unlock page (class ii), never onboarding
		await waitFor(() => expect(screen.getByTestId('preread-passcode-unlock')).toBeTruthy(), { timeout: 4000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(1)
	})

	it('PRR-04 read_error twice: a bridge fault, data kept, never confirmed missing: no onboarding, no home', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'read_error' }, { kind: 'unknown', reason: 'read_error' }]
		renderAt('/settings')
		await settle(900)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
	})

	it('PRR-03 confirmed_missing with no other source holding a ciphertext and the native key state no_key: onboarding (the only confirmed absence)', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		g.__walletStatusAnswer = { status: 'no_key' }
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 4000 })
	})

	it('PRR-06 contradiction: pre-read absent while the native walletStatus reports a passcode account: no onboarding, diagnostic logged, no button', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/settings')
		await settle(1200)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('unlock_wallet')).toBeNull()
		expect((g.__logs as string[]).some((l) => l.includes('reason=passcode_preread_inconsistent'))).toBe(true)
	})
})
