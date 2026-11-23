/**
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
		return { status: (globalThis as { __walletStatus?: string }).__walletStatus ?? 'no_key' }
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
	g.__walletStatus = 'no_key'
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

describe('IndexedDB first: a valid local mnemonic enters the home without any native recovery or pre-read query', () => {
	it.each([
		['native not_ready', { kind: 'unknown', reason: 'not_ready' }],
		['native absent', { kind: 'absent' }],
		['native locked', { kind: 'locked' }],
		['native valid for another (old) account', { kind: 'valid', eoa: EOA_OLD, phrase: PHRASE_OLD }],
	])('local valid + %s: /home, native reads 0, sync targets the local mnemonic only', async (_label, answer) => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		g.__prereadAnswers = [answer]
		g.__walletStatus = 'not_ready'
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
		expect(g.__calls.passcode).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
		await waitFor(() => expect(g.__syncCalls.length).toBeGreaterThanOrEqual(1), { timeout: 2000 })
		// the native sync (background) carries the same local mnemonic and its account, and nothing else
		for (const c of g.__syncCalls) {
			expect(c).toEqual({ phrase: PHRASE_LOCAL, eoa: EOA_LOCAL })
		}
	})
})

describe('IndexedDB unknown: held, no pre-read, no onboarding', () => {
	it('a timeout or read failure (unknown) never calls the pre-read and never onboards', async () => {
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

describe('IndexedDB definitively absent: the pre-read decides', () => {
	it('(i) Android: first pre-read unknown, second valid with a verified write-back -> /home', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown' }, { kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(g.__calls.preread).toBe(2)
		expect(g.__persistCalls.n).toBe(1)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__logs.some((l: string) => /preread first unknown: quick re-request in 750 ms/.test(l))).toBe(true)
	})

	it('(ii) Android: first pre-read unknown, second absent with the IndexedDB absent -> silent onboarding', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown' }, { kind: 'absent' }]
		g.__walletStatus = 'no_key'
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		// two reads for the start (the first unknown, the second absent) and the one real read that confirms the absence before the onboarding (R2271)
		expect(g.__calls.preread).toBe(3)
		expect(g.__persistCalls.n).toBe(0)
	})

	it('a pre-read not_ready in either shape is never onboarding (no verdict on the first two answers)', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'not_ready' }, { kind: 'unknown', reason: 'not_ready' }]
		renderAt('/settings')
		await settle(900)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(g.__calls.walletStatus).toBe(0)
	})

	it('a write-back that does not read back the mnemonic is not a home and not an onboarding', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		g.__writeVerdict = 'readback_mismatch'
		renderAt('/settings')
		await settle(300)
		expect(g.__persistCalls.n).toBe(1)
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
})

describe('background sync failure codes: pending only, home unchanged', () => {
	it.each(['OLD_COPY_UNVERIFIED', 'write_failed', 'no_answer'])('sync %s records pending sync and keeps the home', async (code) => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		g.__syncAnswer = { kind: 'failed', tx: 2, code, retryable: true }
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		await waitFor(() => expect(g.__pendingMarks.length).toBeGreaterThan(0), { timeout: 3000 })
		expect(g.__pendingMarks[0]).toBe(`native_sync_${code}`)
		expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
})

describe('IDP-01 with the Chat init never answering: a valid page mnemonic still enters the home (no wait for the SDK or the chat init)', () => {
	it('valid IDB + chat init never settles: /home, with no pre-read and no native record query', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = pageLocal()
		g.__chatNever = true
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
	})
})

describe('IDP-07 and IDP-08, and the quick retry (unit b items 3 and 4)', () => {
	it('IDP-07: the pre-read does not depend on Chat init: with the chat init never answering, the valid pre-read still enters the home, and the pre-read is asked before any chat init', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		g.__chatNever = true
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(g.__calls.preread).toBe(1)
		expect(g.__order[0]).toBe('preread')
		// the chat init (if it runs at all here) comes only after the pre-read, and it never answers: the home does not wait for it
		const chatAt = g.__order.indexOf('chat')
		expect(chatAt === -1 || chatAt > g.__order.indexOf('preread')).toBe(true)
	})

	it('IDP-08: one reqId links the IndexedDB state, the pre-read, the write-back and the final route; no phrase or key in the logs', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		const id = (g.__logs as string[]).map((l) => /\[startup\] reqId=(\w+) idb=absent/.exec(l)?.[1]).find(Boolean)
		expect(id).toBeTruthy()
		const lines = (g.__logs as string[]).filter((l) => l.includes(`reqId=${id}`))
		expect(lines.some((l) => l.includes(`reqId=${id} idb=absent`))).toBe(true)
		expect(lines.some((l) => l.includes(`reqId=${id} preread=valid`))).toBe(true)
		expect(lines.some((l) => l.includes(`reqId=${id} writeback=verified`))).toBe(true)
		expect(lines.some((l) => l.includes(`reqId=${id} final_route=home`))).toBe(true)
		const all = (g.__logs as string[]).join('\n')
		expect(all.includes(PHRASE_NATIVE)).toBe(false)
		expect(all.includes(EOA_NATIVE.slice(2).toLowerCase()) && false).toBe(false)
	})

	it('quick retry: a second valid answer 0.75 s after the first unknown enters the home (the 2 s backoff would miss this window)', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown' }, { kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 1200 })
		expect(g.__calls.preread).toBe(2)
	})

	it('the quick retry is once per start sequence: a further unknown backs off (no second quick retry)', async () => {
		const g = globalThis as Record<string, any>
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/settings')
		await waitFor(() => expect(g.__calls.preread).toBe(2), { timeout: 1200 })
		await settle(900)
		// 0.75 s + 0.9 s after the second unknown is still inside the 2 s backoff: no third call yet
		expect(g.__calls.preread).toBe(2)
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(g.__calls.preread).toBe(3)
	})
})
