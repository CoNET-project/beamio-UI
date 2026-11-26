/**
 * Onboarding confirmation, three start contexts (gate level, synthetic accounts only, real rendering):
 * - an ordinary browser (no native bridge, nothing declared): an empty page store goes to the create page with no native command sent;
 * - a shell whose pre-read answers unknown (not_ready, read_timeout, read_error): the start keeps waiting, no onboarding (unchanged);
 * - a shell that has no pre-read command (unsupported, an older build): confirmed by walletStatus; only an explicit no_key opens the create page.
 * isShellContext is the real module: only the native-WebView probe underneath it (cashTreesNativeNfc) is switched per test.
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
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => (globalThis as { __bridge?: boolean }).__bridge === true, getCashTreesNativeNfcHost: () => null }), { virtual: true })
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (_level: string, message: string) => {
		;(globalThis as { __logs?: string[] }).__logs!.push(String(message))
	},
}), { virtual: true })
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
		const list = (globalThis as { __walletStatusList?: string[] }).__walletStatusList ?? ['no_key']
		return { status: list.length > 1 ? list.shift() : list[0] }
	},
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(() => () => undefined),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
	queryNativePasscodeStatus: async () => {
		;(globalThis as { __calls?: { passcode: number } }).__calls!.passcode += 1
		return (globalThis as { __passcode?: unknown }).__passcode ?? { walletState: 'not_reported', hasKey: 'not_reported' }
	},
	queryNativeMnemonicPreread: async () => {
		const g = globalThis as { __calls?: { preread: number }; __prereadAnswers?: unknown[] }
		g.__calls!.preread += 1
		;(g as { __order?: string[] }).__order!.push('preread')
		const list = g.__prereadAnswers ?? []
		return list.length > 1 ? list.shift() : (list[0] ?? { kind: 'unknown' })
	},
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: async () => null }), { virtual: true })
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
	g.__bridge = true
	g.__passcode = undefined
	g.__idbPage = { status: 'empty' }
	g.__prereadAnswers = []
	g.__writeVerdict = 'verified'
	g.__walletStatusList = ['no_key']
	g.__syncAnswer = { kind: 'synced', tx: 1 }
	g.__calls = { preread: 0, walletStatus: 0, passcode: 0 }
	g.__persistCalls = { n: 0 }
	g.__syncCalls = []
	g.__pendingMarks = []
	g.__logs = []
	g.__order = []
	g.__chatNever = false
})

const settle = (ms: number) => act(async () => {
	await new Promise((resolve) => setTimeout(resolve, ms))
})

describe('an ordinary browser (no native bridge): an empty store opens the create page, no native command', () => {
	it('empty page store, no bridge: ONBOARDING, nativeMnemonicPreread 0, walletStatus 0, no wait loop', async () => {
		const g = globalThis as Record<string, any>
		g.__bridge = false
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'read_error' }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
		expect(g.__logs.some((l: string) => /startup retry|onboarding confirmation read unknown/.test(l))).toBe(false)
	})
})

describe('an existing account is kept: it enters directly, with or without a bridge', () => {
	const pageLocal = () => ({ status: 'loaded', data: { mnemonicPhrase: 'local synthetic phrase one', profiles: [{ keyID: '0x1111111111111111111111111111111111111111' }], beamio: {} } })
	it('browser with an existing valid account: the app opens, no create page, no native command', async () => {
		const g = globalThis as Record<string, any>
		g.__bridge = false
		g.__idbPage = pageLocal()
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
	})
	it('shell with an existing valid account: the app opens, no create page, the pre-read is not asked', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'not_ready' }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
	})
})

describe('a shell with a pre-read that answers unknown: the start keeps waiting (no onboarding, nothing written)', () => {
	it.each([
		['not_ready', { kind: 'unknown', reason: 'not_ready' }],
		['read_timeout', { kind: 'unknown', reason: 'read_timeout' }],
		['read_error', { kind: 'unknown', reason: 'read_error' }],
	])('the confirmation read answers unknown/%s: no onboarding, no home, no write', async (reason, answer) => {
		const g = globalThis as Record<string, any>
		// the start reads absent; the one real read that confirms the absence then answers unknown
		g.__prereadAnswers = [{ kind: 'absent' }, answer]
		renderAt('/settings')
		await waitFor(() => expect(g.__logs.some((l: string) => l.includes(`onboarding confirmation read=unknown reason=${reason}`))).toBe(true), { timeout: 4000 })
		await settle(300)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
	})
})

describe('a shell with no pre-read command (unsupported, an older build): walletStatus confirms, only an explicit no_key opens the create page', () => {
	// an older build that reports walletState absent (the judgement reaches the onboarding entry); the pre-read is unknown_command
	const legacyReportingAbsent = () => {
		const g = globalThis as Record<string, any>
		g.__passcode = { walletState: 'absent', hasKey: 'not_reported' }
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'unsupported' }]
	}

	it('unsupported + walletStatus no_key: ONBOARDING (no endless wait), confirmed by the walletStatus read', async () => {
		const g = globalThis as Record<string, any>
		legacyReportingAbsent()
		g.__walletStatusList = ['no_key']
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(g.__logs.some((l: string) => /onboarding confirmation platform=\w+ walletStatus=no_key/.test(l))).toBe(true)
	})

	it.each(['not_ready', 'unknown', 'unlocked'])('unsupported + the confirming walletStatus read answers %s (the start read said no_key): no onboarding', async (status) => {
		const g = globalThis as Record<string, any>
		legacyReportingAbsent()
		// the start's own reads answer no_key; the confirming read answers the other status
		g.__walletStatusList = ['no_key', 'no_key', status]
		renderAt('/settings')
		await waitFor(() => expect(g.__logs.some((l: string) => l.includes('onboarding confirmation platform='))).toBe(true), { timeout: 4000 })
		await settle(300)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__logs.some((l: string) => l.includes(`onboarding confirmation platform=`) && l.includes(`walletStatus=${status}`))).toBe(true)
	})

	it('an older build that does not report walletState at all (not_reported) is unchanged: undetermined, never onboarding', async () => {
		const g = globalThis as Record<string, any>
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'unsupported' }]
		g.__walletStatusList = ['no_key']
		renderAt('/settings')
		await settle(600)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__logs.some((l: string) => l.includes('account judgement=undetermined'))).toBe(true)
	})
})
