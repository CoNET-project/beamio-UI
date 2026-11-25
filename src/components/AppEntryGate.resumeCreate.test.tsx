/**
 * 0.53.51 R2271-DEF-CREATE-RESUME-1, gate level (synthetic accounts only). A local valid wallet with a pending create record is routed by
 * the registry (two hosts) between the create page (tag locked, props shown) and the home; with no record nothing is read.
 * The registry reads are the I/O boundary (mocked per host); the decisions and the record store are the real code.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppEntryGate from './AppEntryGate'
import { CONET_RPC_URL, CONET_RPC_SECONDARY } from '@/config/chainAddresses'
import { clearPendingCreateTag, markPendingForwardSent, readPendingCreateRecord, writePendingCreateTag } from '@/services/pendingCreateTag'
import { getResumeNotice, dismissResumeNotice } from '@/services/resumeNotice'
import { resetResumeCreateForTest, resumeBusyProbeCount } from '@/services/resumeCreate'

const EOA_LOCAL = '0x1111111111111111111111111111111111111111'
const EOA_NATIVE = '0x2222222222222222222222222222222222222222'
const EOA_OLD = '0x3333333333333333333333333333333333333333'
const PHRASE_LOCAL = 'local synthetic phrase one'
const PHRASE_NATIVE = 'native synthetic phrase two'
const PHRASE_OLD = 'old synthetic phrase three'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }), { virtual: true })
jest.mock('@/services/resumeCreate', () => {
	const actual = jest.requireActual('@/services/resumeCreate')
	return {
		...actual,
		resumeCreateCheck: (...a: unknown[]) => {
			;(globalThis as any).__checkCalls += 1
			const o = (globalThis as any).__checkOverride as Array<unknown> | undefined
			if (o && o.length) {
				const item = o.length > 1 ? o.shift() : o[0]
				return typeof item === 'function' ? (item as () => Promise<unknown>)() : Promise.resolve(item)
			}
			return actual.resumeCreateCheck(...a)
		},
	}
})
jest.mock('@/utils/voiceCallSession', () => {
	;(globalThis as any).__voiceLoads = ((globalThis as any).__voiceLoads ?? 0) + 1
	return { browserVoiceCallBusyFor: () => !!(globalThis as any).__voiceBusy }
}, { virtual: true })
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
	registrationStateVia: async (url: string) => {
		;(globalThis as any).__regCalls += 1
		return (globalThis as any).__reg?.[url] ?? 'unknown'
	},
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
jest.mock('@/components/PasscodeLockScreen', () => {
	const R = require('react')
	return (p: any) => R.createElement('button', { 'data-testid': 'unlock', onClick: () => p.onUnlocked() }, 'UNLOCK')
}, { virtual: true })
jest.mock('@/services/walletVaultEvents', () => ({ VAULT_LOCKED_EVENT: 'beamio:vault-locked' }), { virtual: true })
jest.mock('@/components/SplashScreen', () => () => null, { virtual: true })
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }), { virtual: true })
jest.mock('@/pages/Home/LoadingPage', () => {
	const R = require('react')
	return (p: any) => R.createElement('div', null, 'ONBOARDING-PAGE', p.resumeCreate ? ' RESUME ' + p.resumeCreate.tag + ' ' + p.resumeCreate.eoa : '')
}, { virtual: true })
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => true, getCashTreesNativeNfcHost: () => null }), { virtual: true })
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (_level: string, message: string) => {
		;(globalThis as { __logs?: string[] }).__logs!.push(String(message))
	},
}), { virtual: true })
jest.mock('@/services/shellContext', () => ({ isShellContext: () => (globalThis as any).__shell !== false }), { virtual: true })
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
const TAG = 'synthtag'
const setReg = (p: string, q: string) => {
	;(globalThis as any).__reg = { [CONET_RPC_URL]: p, [CONET_RPC_SECONDARY]: q }
}
beforeEach(() => {
	dismissResumeNotice()
	localStorage.clear()
	resetResumeCreateForTest()
	const g = globalThis as Record<string, any>
	// a shell interrupted create: the page record is absent and the native pre-read answers with the wallet (the applyNativeWallet entry)
	g.__idbPage = { status: 'empty' }
	g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
	g.__reg = {}
	g.__regCalls = 0
	g.__checkCalls = 0
	g.__checkOverride = undefined
	g.__voiceBusy = false
	g.__shell = true
})
const regCalls = () => (globalThis as any).__regCalls as number

// FIRST in the file on purpose: the voice module mock counts its loads once per file, and the browser must not load it
describe('M3 browser: the resume machinery is not there at all', () => {
	it('no busy probe, no popstate listener, no dynamic import of the call module, no resume check', async () => {
		const g = globalThis as Record<string, any>
		g.__shell = false
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = []
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg('unregistered', 'unregistered')
		const add = jest.spyOn(window, 'addEventListener')
		const before = (g.__voiceLoads ?? 0) as number
		renderAt('/settings')
		await settle(400)
		expect(resumeBusyProbeCount()).toBe(0)
		expect(add.mock.calls.some((c) => c[0] === 'popstate')).toBe(false)
		expect(((g.__voiceLoads ?? 0) as number) - before).toBe(0)
		expect(g.__checkCalls).toBe(0)
		expect(regCalls()).toBe(0)
		add.mockRestore()
	})
})

describe('no record: the original entry, no registry read at all', () => {
	it('home, zero reads', async () => {
		setReg('unregistered', 'unregistered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(regCalls()).toBe(0)
		// the non-hit path is the original synchronous entry: the async check is not even started
		expect((globalThis as any).__checkCalls).toBe(0)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
	it("another wallet's record: still zero reads and home", async () => {
		writePendingCreateTag('0x' + '9'.repeat(40), TAG)
		setReg('unregistered', 'unregistered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(regCalls()).toBe(0)
		expect((globalThis as any).__checkCalls).toBe(0)
	})
})

describe('record for this wallet', () => {
	it('never sent (no s), both hosts unregistered: the create page with the locked tag and wallet', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg('unregistered', 'unregistered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText(new RegExp(`RESUME ${TAG} ${EOA_NATIVE}`, 'i'))).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(regCalls()).toBe(2)
		expect(readPendingCreateRecord(EOA_NATIVE)).not.toBeNull()
	})
	it('registered: record cleared, home, neutral notice once', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg('registered', 'registered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		await waitFor(() => expect(readPendingCreateRecord(EOA_NATIVE)).toBeNull())
		expect(getResumeNotice()?.kind).toBe('code_not_shown')
		// the card renders it, and only then is it counted as shown (S2)
		expect(await screen.findByTestId('resume-notice-card')).toBeTruthy()
		await waitFor(() => expect(localStorage.getItem('beamio.codeNoticeShown.v1') ?? '').toContain(EOA_NATIVE))
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
	it('registered on one host only: still registered (never a create page)', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg('unregistered', 'registered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		await waitFor(() => expect(readPendingCreateRecord(EOA_NATIVE)).toBeNull())
	})
	it.each([['unknown', 'unregistered'], ['unregistered', 'unknown'], ['unknown', 'unknown']])('hosts %s / %s: home, record kept, no create page', async (p, q) => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg(p, q)
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(readPendingCreateRecord(EOA_NATIVE)).not.toBeNull()
		expect(getResumeNotice()).toBeNull()
	})
	it('forward sent just now (recent s): home, record kept, no create page even with both hosts unregistered', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		markPendingForwardSent(EOA_NATIVE, Date.now())
		setReg('unregistered', 'unregistered')
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(readPendingCreateRecord(EOA_NATIVE)).not.toBeNull()
	})
})

describe('no "Later" way out: the resume page is the only way and there is no home card', () => {
	it('the gate source has no later/skip/complete-account card for the resume', () => {
		const s = require('fs').readFileSync(require('path').join(__dirname, 'AppEntryGate.tsx'), 'utf8')
		const part = s.slice(s.indexOf('0.53.51 R2271-DEF-CREATE-RESUME-1'), s.indexOf('const applyNativeWallet = '))
		expect(part).not.toMatch(/\blater\b|skip|complete.?account/i)
	})
})

const UNCERTAIN = { kind: 'uncertain', why: 'min_wait', recheckInMs: 80 }
const RESUME = { kind: 'resume', tag: TAG }
const onboardingShown = () => !!screen.queryByText(new RegExp(`RESUME ${TAG} ${EOA_NATIVE}`, 'i'))

describe('M1 re-entry: a second start while the resume page is open leaves it alone', () => {
	it('after the resume page is routed, a native ready event (init runs again) does not check again, remount, or enter the home', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		setReg('unregistered', 'unregistered')
		const g = globalThis as Record<string, any>
		const { container } = renderAt('/settings')
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 3000 })
		const node = screen.getByText(/ONBOARDING-PAGE/)
		const checksBefore = g.__checkCalls
		const readsBefore = regCalls()
		// the start runs again (a native wallet-ready event re-runs the same gate)
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await settle(300)
		expect(onboardingShown()).toBe(true)
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
		expect(screen.getByText(/ONBOARDING-PAGE/)).toBe(node) // the same element: not remounted
		expect(g.__checkCalls).toBe(checksBefore)
		expect(regCalls()).toBe(readsBefore)
		expect(container).toBeTruthy()
	})
})

describe('M1 stale check: a slower earlier check cannot take the screen back from the resume page', () => {
	it('two checks in flight; the first routes the resume page, the second answers registered/uncertain: the page stays', async () => {
		const g = globalThis as Record<string, any>
		writePendingCreateTag(EOA_NATIVE, TAG)
		let r1: (v: unknown) => void = () => undefined
		let r2: (v: unknown) => void = () => undefined
		g.__checkOverride = [() => new Promise((res) => { r1 = res }), () => new Promise((res) => { r2 = res })]
		renderAt('/settings')
		await waitFor(() => expect(g.__checkCalls).toBe(1), { timeout: 3000 })
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await waitFor(() => expect(g.__checkCalls).toBe(2), { timeout: 3000 })
		await act(async () => r1(RESUME))
		await waitFor(() => expect(onboardingShown()).toBe(true))
		await act(async () => r2({ kind: 'uncertain', why: 'read_failed', recheckInMs: 60000 }))
		await settle(200)
		expect(onboardingShown()).toBe(true)
		expect(screen.queryByText('SETTINGS-PAGE')).toBeNull()
	})
})

describe('S1 late route: uncertain at entry, then idle-only', () => {
	it('uncertain: the home shows at once, a recheck is scheduled, and the later resume verdict routes when idle', async () => {
		writePendingCreateTag(EOA_NATIVE, TAG)
		;(globalThis as any).__checkOverride = [UNCERTAIN, RESUME]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		expect(onboardingShown()).toBe(false)
		expect((globalThis as any).__checkCalls).toBe(1)
		await waitFor(() => expect((globalThis as any).__checkCalls).toBe(2), { timeout: 2000 })
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 2000 })
	})

	it('during a call the route waits (stays home); when the call ends and the page sees an idle signal it routes', async () => {
		const g = globalThis as Record<string, any>
		writePendingCreateTag(EOA_NATIVE, TAG)
		g.__checkOverride = [UNCERTAIN, RESUME]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		g.__voiceBusy = true
		await waitFor(() => expect(g.__checkCalls).toBe(2), { timeout: 2000 })
		await settle(200)
		expect(onboardingShown()).toBe(false)
		expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy()
		g.__voiceBusy = false
		await act(async () => {
			window.dispatchEvent(new PopStateEvent('popstate'))
		})
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 2000 })
	})

	it('visibilitychange to visible flushes the queued route', async () => {
		const g = globalThis as Record<string, any>
		writePendingCreateTag(EOA_NATIVE, TAG)
		g.__checkOverride = [UNCERTAIN, RESUME]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		g.__voiceBusy = true
		await waitFor(() => expect(g.__checkCalls).toBe(2), { timeout: 2000 })
		await settle(150)
		g.__voiceBusy = false
		await act(async () => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 2000 })
	})

	it('the 30 s visible poll flushes the queued route', async () => {
		const g = globalThis as Record<string, any>
		const polls: Array<() => void> = []
		const realSet = window.setInterval.bind(window)
		const spy = jest.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
			if (ms === 30_000) {
				polls.push(fn)
				return 0 as never
			}
			return realSet(fn, ms)
		}) as never)
		writePendingCreateTag(EOA_NATIVE, TAG)
		g.__checkOverride = [UNCERTAIN, RESUME]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		g.__voiceBusy = true
		await waitFor(() => expect(g.__checkCalls).toBe(2), { timeout: 2000 })
		await settle(150)
		g.__voiceBusy = false
		expect(polls.length).toBeGreaterThan(0)
		await act(async () => {
			polls.forEach((f) => f())
		})
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 2000 })
		spy.mockRestore()
	})

	it('vault locked: a resume verdict does not route; after the unlock the entry checks again and routes', async () => {
		const g = globalThis as Record<string, any>
		writePendingCreateTag(EOA_NATIVE, TAG)
		g.__checkOverride = [UNCERTAIN, RESUME]
		renderAt('/settings')
		await waitFor(() => expect(screen.getByText('SETTINGS-PAGE')).toBeTruthy(), { timeout: 3000 })
		// the lock comes up before the recheck answers
		await act(async () => {
			window.dispatchEvent(new Event('beamio:vault-locked'))
		})
		await waitFor(() => expect(screen.getByTestId('unlock')).toBeTruthy())
		await waitFor(() => expect(g.__checkCalls).toBe(2), { timeout: 2000 })
		await settle(200)
		expect(onboardingShown()).toBe(false)
		// the unlock runs the start again: the entry checks again (a fresh verdict) and routes
		g.__checkOverride = [RESUME]
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		await act(async () => {
			screen.getByTestId('unlock').click()
		})
		await waitFor(() => expect(g.__checkCalls).toBeGreaterThanOrEqual(3), { timeout: 3000 })
		await waitFor(() => expect(onboardingShown()).toBe(true), { timeout: 3000 })
	})
})
