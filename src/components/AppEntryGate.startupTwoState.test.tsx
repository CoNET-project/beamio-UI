/**
 * the spec 与 the decision（unit f2，两状态启动流程，合成账号）。Runtime cases on the real gate code:
 * ① plaintext current: validated, written to the page IndexedDB, read back, home;
 * ② ciphertext current, no passcode on the pre-read: the passcode page; the six digits decrypt in the PWA, then write, read back, home;
 * ③ empty (confirmed_missing) → onboarding; read failure (read_error) → held, data kept, never onboarding, no button in the shell;
 * ④ IndexedDB valid → home with zero pre-read queries.
 * Also PRR-06 (pre-read absent but another record shows ciphertext: diagnostic, no onboarding, no button) and PRR-07 (another command's
 * passcode state does not answer the pre-read). The storage, native bridge and PouchDB are replaced at their I/O boundary; the decisions
 * and the v3 decrypt are the real code. Argon2id runs as noble (the Worker bridge is replaced: jsdom has no Worker).
 * SYNTHETIC values only. The synthetic v3 envelope is the MCF3-01 vector (passcode 482913).
 */
import { webcrypto } from 'crypto'
import { TextDecoder, TextEncoder } from 'util'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AppEntryGate from './AppEntryGate'
import { setNativeReadCapMsForTest } from '@/services/nativeReadDeadline'
import { argon2id } from '@noble/hashes/argon2.js'
import { setMnemonicKdfForTest } from '@/services/passcode/mnemonicCipherV3'
import { setPasscodeKdfForTest } from '@/services/passcode/walletWrap'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
Object.assign(globalThis, { TextEncoder: globalThis.TextEncoder ?? TextEncoder, TextDecoder: globalThis.TextDecoder ?? TextDecoder })

const EOA_LOCAL = '0x1111111111111111111111111111111111111111'
const EOA_NATIVE = '0x2222222222222222222222222222222222222222'
const PHRASE_LOCAL = 'local synthetic phrase one'
const PHRASE_NATIVE = 'native synthetic phrase two'
// MCF3-01 synthetic vector: the phrase derives 0xd492… (ethers, real derivation inside the PWA decrypt)
const PHRASE_CIPHER = 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect'
const EOA_CIPHER = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const CIPHER_ENVELOPE = {
	v: 3,
	mode: 'passcode',
	eoa: EOA_CIPHER,
	kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32',
	salt: 'AAECAwQFBgcICQoLDA0ODw==',
	iv: 'AAECAwQFBgcICQoL',
	alg: 'AES-256-GCM',
	ct: 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0=',
}
const PASSCODE_OK = '482913'
const PASSCODE_WRONG = '111111'

jest.setTimeout(90_000)

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }), { virtual: true })
// 模块加载桩：argon2 worker bridge 含 import.meta（Jest 无法解析）。Argon2id 经 setMnemonicKdfForTest / setPasscodeKdfForTest 注入，见下方。
jest.mock('@/services/argon2WorkerBridge', () => ({}))
const argon2Test = async (password: Uint8Array, salt: Uint8Array, opts: { m: number; t: number; p: number; dkLen: number }) =>
	Uint8Array.from(argon2id(password, salt, { m: opts.m, t: opts.t, p: opts.p, dkLen: opts.dkLen }))
beforeAll(() => {
	setMnemonicKdfForTest(argon2Test)
	setPasscodeKdfForTest(argon2Test)
})
afterAll(() => {
	setMnemonicKdfForTest(null)
	setPasscodeKdfForTest(null)
})
// The decrypt is the real code (f1 openMnemonicV3: envelope check, Argon2id, AES-256-GCM with the EOA-bound AAD). Only the phrase-to-EOA
// derivation of the one synthetic phrase is a fixture: ethers cannot derive under jsdom (Buffer/Uint8Array realm). The real derivation
// is covered by the node test (passcode/mnemonicCipherV3 vectors); any other phrase keeps the real derivation.
jest.mock('ethers', () => {
	const actual = jest.requireActual('ethers')
	class FixtureWallet extends actual.Wallet {
		static fromPhrase(phrase: string, provider?: unknown) {
			if (phrase.trim() === 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect') {
				return { address: '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f' }
			}
			return actual.Wallet.fromPhrase(phrase, provider)
		}
	}
	return { ...actual, Wallet: FixtureWallet }
})
// The passcode documents: the production store is IndexedDB (not in jsdom). The page's counter uses the real passcodeAttemptStore over a Map.
jest.mock('@/services/passcode/passcodeWrapStore', () => {
	const actual = jest.requireActual('../services/passcode/passcodeWrapStore')
	const mapDb = () => {
		const m = () => (globalThis as { __attemptDb?: Map<string, unknown> }).__attemptDb!
		return {
			get: async (k: string) => m().get(k),
			put: async (k: string, v: unknown) => {
				m().set(k, v)
			},
			delete: async (k: string) => {
				m().delete(k)
			},
		}
	}
	return { ...actual, idbKeyValueDb: () => mapDb() }
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
	checkStorageWithStatus: jest.fn(async () => ({ status: 'empty' })),
	checkStorageWithStatusWithTimeout: jest.fn(async () => ({ status: 'empty' })),
	checkStorageWithTransientRetry: async () => {
		const g = globalThis as { __idbPage?: unknown; __pageSeq?: unknown[]; __hang?: boolean; __hangResolve?: (v: unknown) => void }
		// a stalled read (in flight until the test resolves it), then a sequence of page reads, then the steady __idbPage
		if (g.__hang) return new Promise((resolve) => { g.__hangResolve = resolve })
		if (g.__pageSeq && g.__pageSeq.length) return g.__pageSeq.shift()
		return g.__idbPage
	},
	persistPageIdbMnemonic: async (_record: unknown, phrase: string) => {
		const g = globalThis as { __persistCalls?: { n: number; phrases: string[] } }
		g.__persistCalls!.n += 1
		g.__persistCalls!.phrases.push(phrase)
		return (globalThis as { __writeVerdict?: string }).__writeVerdict ?? 'verified'
	},
	// M6: a ciphertext pre-read is written to the page IndexedDB as the passcode record (the envelope), never as plaintext; the record's own
	// sync sends the one cipher+passcode request. Only the account and the passcode's length are recorded (never the passcode or the phrase).
	persistPageIdbPasscodeRecord: async (_record: unknown, _phrase: string, eoa: string, passcode: string) => {
		const g = globalThis as { __passcodeRecordCalls?: { n: number; eoas: string[]; passcodeDigits: number[] } }
		g.__passcodeRecordCalls!.n += 1
		g.__passcodeRecordCalls!.eoas.push(eoa)
		g.__passcodeRecordCalls!.passcodeDigits.push(passcode.length)
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
	ensureShellChatState: () => Promise.resolve('chat_unavailable'),
	shellChatBlockedNow: () => true,
}), { virtual: true })
jest.mock('@/services/nativeChatRouteRegister', () => ({
	// nativeApp: the shell's own declaration of its platform (hello ack); a test sets globalThis.__nativeApp
	probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'], nativeApp: (globalThis as { __nativeApp?: unknown }).__nativeApp }),
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
	return { ...actual, nativeStoreWaitDelayMs: () => 0, splashDeadlineAction: actual.splashDeadlineAction }
}, { virtual: true })
jest.mock('@/services/shellMnemonicSync', () => {
	const actual = jest.requireActual('../services/shellMnemonicSync')
	return {
		...actual,
		pageSyncPayload: (ev: { kind: string; phrase?: string; eoa?: string }) => (ev.kind === 'valid' && ev.phrase && ev.eoa ? { phrase: ev.phrase, eoa: ev.eoa } : null),
		shellMnemonicSync: {
			...actual.shellMnemonicSync,
			syncCipher: async (cipher: Record<string, unknown>, eoa: string) => {
				const g = globalThis as { __cipherCalls?: Array<{ cipher: Record<string, unknown>; eoa: string }>; __cipherAnswers?: unknown[] }
				g.__cipherCalls!.push({ cipher, eoa })
				const list = g.__cipherAnswers ?? []
				return list.length > 1 ? list.shift() : (list[0] ?? { kind: 'synced', tx: 1 })
			},
			sync: async (phrase: string, eoa: string) => {
				const g = globalThis as { __syncCalls?: Array<{ phrase: string; eoa: string }>; __syncAnswers?: unknown[] }
				g.__syncCalls!.push({ phrase, eoa })
				const list = g.__syncAnswers ?? []
				return list.length > 1 ? list.shift() : (list[0] ?? { kind: 'synced', tx: 1 })
			},
		},
	}
}, { virtual: true })
jest.mock('@/services/nativeRecovery', () => ({
	queryNativeWalletStatus: async () => {
		;(globalThis as { __calls?: { walletStatus: number } }).__calls!.walletStatus += 1
		const eoa = (globalThis as { __walletEoa?: string }).__walletEoa
		return { status: (globalThis as { __walletStatus?: string }).__walletStatus ?? 'no_key', ...(eoa ? { eoa } : {}) }
	},
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(() => () => undefined),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: jest.fn(async () => ({ status: 'unknown' })),
	queryNativePasscodeStatus: async () => {
		const g = globalThis as { __calls?: { passcode: number }; __passcode?: unknown; __passcodeAfterMs?: number }
		g.__calls!.passcode += 1
		if (g.__passcodeAfterMs) await new Promise((resolve) => setTimeout(resolve, g.__passcodeAfterMs))
		return g.__passcode ?? { walletState: 'not_reported', hasKey: 'not_reported' }
	},
	queryNativeMnemonicPreread: async () => {
		const g = globalThis as { __calls?: { preread: number }; __prereadAnswers?: unknown[] }
		g.__calls!.preread += 1
		const list = g.__prereadAnswers ?? []
		const item = (list.length > 1 ? list.shift() : (list[0] ?? { kind: 'unknown' })) as { answerAfterMs?: number; answer?: unknown; hangForever?: boolean }
		// test items: { answerAfterMs, answer } answers late (a timeout past the cap); { hangForever } never answers
		if (item && typeof item === 'object' && item.hangForever) return new Promise(() => undefined)
		// deferred: the answer is released by the test (no timer race): (globalThis as any).__deferredResolvers.shift()(answer)
		if (item && typeof item === 'object' && 'deferred' in (item as object)) {
			return new Promise((resolve) => {
				;(globalThis as { __deferredResolvers?: Array<(v: unknown) => void> }).__deferredResolvers!.push(resolve)
			})
		}
		if (item && typeof item === 'object' && 'answerAfterMs' in item) {
			await new Promise((resolve) => setTimeout(resolve, item.answerAfterMs))
			return item.answer
		}
		return item
	},
}), { virtual: true })
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: jest.fn() }), { virtual: true })
jest.mock('@/utils/beamioWalletReadyEvent', () => ({ BEAMIO_WALLET_READY_EVENT: 'beamio:wallet-ready', dispatchBeamioWalletReady: jest.fn() }), { virtual: true })
jest.mock('@/utils/consumerWalletGate', () => {
	const fixtures: Record<string, string> = {
		'local synthetic phrase one': '0x1111111111111111111111111111111111111111',
		'native synthetic phrase two': '0x2222222222222222222222222222222222222222',
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

const pageLocal = () => ({ status: 'loaded', data: { mnemonicPhrase: PHRASE_LOCAL, profiles: [{ keyID: EOA_LOCAL }], beamio: {} } })

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route element={<AppEntryGate />}>
					<Route path="/home" element={<div>HOME-PAGE</div>} />
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
	g.__passcode = undefined
	g.__calls = { preread: 0, walletStatus: 0, passcode: 0 }
	g.__persistCalls = { n: 0, phrases: [] }
	g.__passcodeRecordCalls = { n: 0, eoas: [], passcodeDigits: [] }
	g.__syncCalls = []
	g.__pendingMarks = []
	g.__logs = []
	g.__pageSeq = []
	g.__hang = false
	g.__attemptDb = new Map()
	g.__cipherCalls = []
	g.__cipherAnswers = []
	g.__deferredResolvers = []
	g.__passcodeAfterMs = 0
	g.__syncAnswers = []
	g.__syncCalls = []
})

const settle = (ms: number) => act(async () => {
	await new Promise((resolve) => setTimeout(resolve, ms))
})
const g = globalThis as Record<string, any>

describe('① plaintext current: written to the page IndexedDB, read back, home (silent)', () => {
	it('valid plaintext from the pre-read: persisted once, /home, no onboarding', async () => {
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(g.__persistCalls.n).toBe(1)
		expect(g.__persistCalls.phrases).toEqual([PHRASE_NATIVE])
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByTestId('preread-passcode-unlock')).toBeNull()
	})
})

describe('② ciphertext current without a passcode: the passcode page; decrypted in the PWA, then written and read back', () => {
	it('shows the passcode page with no button, makes no native passcode or walletStatus query, and does not onboard', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		g.__walletStatus = 'passcode_not_provided'
		renderAt('/home')
		await waitFor(() => expect(screen.getByTestId('preread-passcode-unlock')).toBeTruthy(), { timeout: 4000 })
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(1)
		// PRR-07: the walletStatus passcode state never answers or blocks the pre-read ciphertext
		expect(g.__calls.walletStatus).toBe(0)
		expect(g.__calls.passcode).toBe(0)
		expect(screen.queryAllByRole('button')).toHaveLength(0)
		expect(g.__persistCalls.n).toBe(0)
	})

	it('a wrong six-digit passcode: unlock_failed, nothing written, still on the passcode page', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_WRONG } })
		await waitFor(() => expect(screen.getByTestId('preread-passcode-message').textContent).toMatch(/Incorrect passcode/), { timeout: 40_000 })
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__passcodeRecordCalls.n).toBe(0) // a wrong passcode writes nothing (neither plaintext nor the passcode record)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(screen.getByTestId('preread-passcode-unlock')).toBeTruthy()
	})

	it('the correct six digits decrypt, write, read back, and enter the home', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 40_000 })
		// M6: the page record is the envelope (the passcode record), never the plaintext phrase
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__persistCalls.phrases).toEqual([])
		expect(g.__passcodeRecordCalls.n).toBe(1)
		expect(g.__passcodeRecordCalls.eoas.map((e: string) => e.toLowerCase())).toEqual([EOA_CIPHER.toLowerCase()])
		expect(g.__passcodeRecordCalls.passcodeDigits).toEqual([6])
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})

	it('M6 the passcode record write is refused or fails: no plaintext page write, no onboarding, no home; the data is kept (startup wait)', async () => {
		g.__writeVerdict = 'write_failed'
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(g.__passcodeRecordCalls.n).toBe(1), { timeout: 40_000 })
		await settle(500)
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 90_000)
})

describe('R2271: the onboarding is confirmed by one real native read (SR-10 .. SR-16, SR-21 .. SR-23)', () => {
	const declare = (platform: 'ios' | 'android' | null) => {
		;(globalThis as { __nativeApp?: unknown }).__nativeApp = platform ? { platform, version: '1.0', build: '1' } : undefined
	}
	afterEach(() => {
		declare(null)
		;(globalThis as { __walletEoa?: string }).__walletEoa = undefined
	})

	it('SR-10/11: the page is absent, the start says absent, the confirming read finds a valid mnemonic: the home, the page record written from it, no onboarding', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 8000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(2)
		expect(g.__persistCalls.n).toBe(1)
		expect(g.__persistCalls.phrases).toEqual([PHRASE_NATIVE])
	})

	it('the confirming read finds a ciphertext: the unlock page, no onboarding', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		expect(await screen.findByTestId('preread-passcode-input')).toBeTruthy()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
	})

	it('SR-14: the confirming read is unavailable (not_ready): wait and retry, no onboarding, nothing written', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'unknown', reason: 'not_ready' }]
		renderAt('/home')
		await waitFor(() => expect(g.__calls.preread).toBeGreaterThanOrEqual(2), { timeout: 8000 })
		await settle(1500)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__logs.some((l: string) => /onboarding confirmation read=unknown/.test(l))).toBe(true)
	})

	it('SR-15: the confirming read fails (read_error): wait and retry, no onboarding, nothing written', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'unknown', reason: 'read_error' }]
		renderAt('/home')
		await waitFor(() => expect(g.__calls.preread).toBeGreaterThanOrEqual(2), { timeout: 8000 })
		await settle(1500)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
	})

	it('SR-12/13: both reads say there is no mnemonic (an address or an old key may still exist): the onboarding, as before', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'no_key'
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 8000 })
		expect(g.__calls.preread).toBe(2)
		expect(g.__persistCalls.n).toBe(0)
	})

	it('a shell that declares iOS does not need walletStatus no_key for the confirmation (its pre-read covers the sealed copy): not_ready with absent still onboards', async () => {
		declare('ios')
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'not_ready'
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 8000 })
	})

	it('a shell that declares no valid platform is treated like Android (fail closed): walletStatus must also say no_key; not_ready waits', async () => {
		declare(null)
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'not_ready'
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /onboarding confirmation platform=undeclared walletStatus=not_ready/.test(l))).toBe(true), { timeout: 8000 })
		await settle(800)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})

	it('a shell that declares Android is not helped by an iOS-looking user agent: the declaration decides (walletStatus not_ready waits)', async () => {
		const originalUa = window.navigator.userAgent
		Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', configurable: true })
		declare('android')
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'not_ready'
		renderAt('/home')
		try {
			await waitFor(() => expect(g.__logs.some((l: string) => /onboarding confirmation platform=android walletStatus=not_ready/.test(l))).toBe(true), { timeout: 8000 })
			await settle(800)
			expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		} finally {
			Object.defineProperty(window.navigator, 'userAgent', { value: originalUa, configurable: true })
		}
	})

	it('SR-23 (Android): the pre-read says absent and walletStatus says no_key: the onboarding', async () => {
		declare('android')
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'no_key'
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 8000 })
	})

	it('SR-22 (Android): the pre-read says absent but walletStatus is not no_key (not_ready, unknown): wait and retry, no onboarding', async () => {
		declare('android')
		for (const status of ['not_ready', 'unknown']) {
			g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
			g.__walletStatus = status
			const view = renderAt('/home')
			if (status === 'not_ready') {
				// the start route reaches the confirmation, which reads walletStatus and refuses it
				await waitFor(() => expect(g.__logs.some((l: string) => /onboarding confirmation platform=android walletStatus=not_ready/.test(l))).toBe(true), { timeout: 8000 })
			} else {
				// an unknown walletStatus never reaches the confirmation: the start route itself is a retry
				await waitFor(() => expect(g.__calls.walletStatus).toBeGreaterThanOrEqual(1), { timeout: 8000 })
			}
			await settle(800)
			expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
			view.unmount()
			g.__logs = []
		}
	})

	it('SR-21 (Android): the pre-read says absent but walletStatus holds a wallet (the sealed copy): the home on its address, no onboarding', async () => {
		declare('android')
		g.__prereadAnswers = [{ kind: 'absent' }, { kind: 'absent' }]
		g.__walletStatus = 'unlocked'
		g.__walletEoa = EOA_NATIVE
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 8000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	})
})

describe('③ empty and read failure: empty is onboarding; a read failure is held with the data kept', () => {
	it('③a confirmed_missing on every side → onboarding (silent)', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }]
		g.__walletStatus = 'no_key'
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 4000 })
		// the start's pre-read and the one real read that confirms the absence before the onboarding (R2271)
		expect(g.__calls.preread).toBe(2)
		expect(g.__persistCalls.n).toBe(0)
	})

	it('③b read_error: never onboarding, nothing written, record_unreadable, no button in the shell', async () => {
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'read_error' }]
		renderAt('/home')
		await settle(1500)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__logs.some((l: string) => /reason=record_unreadable/.test(l))).toBe(true)
		expect(g.__logs.some((l: string) => /confirmed_absent|reason=pre_read_unsupported/.test(l))).toBe(false)
		expect(screen.queryAllByRole('button')).toHaveLength(0)
	})
})

describe('④ IndexedDB valid: the home with zero pre-read and zero native passcode queries', () => {
	it('valid local record → /home, preread 0, passcode 0, walletStatus 0', async () => {
		g.__idbPage = pageLocal()
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.passcode).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
		expect(screen.queryByTestId('preread-passcode-unlock')).toBeNull()
	})
})

describe('PRR-06: the pre-read says absent but another record shows data: a redacted diagnostic, data kept, no onboarding, no button', () => {
	it('walletState present with absent pre-read is a contradiction: held, no onboarding', async () => {
		g.__prereadAnswers = [{ kind: 'absent' }]
		g.__passcode = { walletState: 'present', hasKey: 'not_reported' }
		renderAt('/home')
		await settle(1500)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__logs.some((l: string) => /reason=preread_contradiction/.test(l))).toBe(true)
		expect(screen.queryAllByRole('button')).toHaveLength(0)
	})
})

// Gateway (2026-11-22, item 6): the old-shell upgrade gate is the one screen that stays. No automatic re-read, no button, no start.
describe('old-shell upgrade gate (version gate): the update prompt stays, with no button and no re-read', () => {
	it('page store reports the old-shell reason: the terminal update prompt, nothing else', async () => {
		g.__idbPage = { status: 'unavailable', reason: 'old_shell_upgrade_required' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('old_shell.terminal.title')).toBeTruthy(), { timeout: 4000 })
		await settle(2500)
		expect(screen.queryAllByRole('button')).toHaveLength(0)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__calls.preread).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
	}, 20_000)
})

// G (2026-11-22, ): the PWA unlock page. Real decrypt, real passcodeBackoff counting; the write, read back and home are the gate's.
const CT_OTHER_AAD = 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816SNVFJ919dazVSo6aqSKTno='
const CT_TAMPERED = 'dyJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0='
const OTHER_EOA = '0x2222222222222222222222222222222222222222'
const envWith = (ct: string, eoa: string) => ({ ...CIPHER_ENVELOPE, ct, eoa })

describe('G: unlock page (PWA): correct, wrong with cooldown counting, address mismatch and tamper never write', () => {
	it('G1 correct six digits: decrypt, write, read back, home', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 60_000 })
		expect(g.__persistCalls.n).toBe(0) // no plaintext page record (M6)
		expect(g.__passcodeRecordCalls.n).toBe(1)
	}, 90_000)

	it('G2 three wrong passcodes: each counted (input cleared); the third starts the 5-minute cooldown, input disabled, no write', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		for (let i = 0; i < 3; i++) {
			fireEvent.change(input, { target: { value: PASSCODE_WRONG } })
			await waitFor(() => expect(input.value).toBe(''), { timeout: 60_000 })
		}
		await waitFor(() => expect(screen.getAllByTestId('preread-passcode-message').map((n) => n.textContent).join(' ')).toMatch(/Too many attempts/), { timeout: 5000 })
		expect((screen.getByTestId('preread-passcode-input') as HTMLInputElement).disabled).toBe(true)
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 240_000)

	it('G3 address mismatch (envelope EOA differs from the decrypted phrase): verify_failed, nothing written', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: envWith(CT_OTHER_AAD, OTHER_EOA) }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(screen.getByTestId('preread-passcode-message').textContent).toMatch(/does not match this account/), { timeout: 60_000 })
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 90_000)

	it('G4 tampered ciphertext: unlock_failed, nothing written', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: envWith(CT_TAMPERED, EOA_CIPHER) }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(screen.getByTestId('preread-passcode-message').textContent).toMatch(/Incorrect passcode/), { timeout: 60_000 })
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 90_000)
})

// (2026-11-22): a valid local record is zero reads (preread, walletStatus) and one background pwaWalletSync.
describe('local valid: zero read queries, one background pwaWalletSync, the shell confirms the read-back', () => {
	it('IDB valid: preread 0, walletStatus 0, passcode 0, pwaWalletSync exactly once with the local phrase, no page write', async () => {
		g.__idbPage = pageLocal()
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		await waitFor(() => expect(g.__syncCalls.length).toBe(1), { timeout: 4000 })
		await settle(2500)
		expect(g.__syncCalls).toEqual([{ phrase: PHRASE_LOCAL, eoa: EOA_LOCAL }])
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
		expect(g.__calls.passcode).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
	})

	it('the sync is not confirmed (no_answer): retried in the background on the schedule (2 s), the page IndexedDB untouched, then confirmed', async () => {
		g.__idbPage = pageLocal()
		g.__syncAnswers = [{ kind: 'failed', tx: 2, code: 'no_answer', retryable: true }, { kind: 'synced', tx: 3 }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		await waitFor(() => expect(g.__syncCalls.length).toBe(2), { timeout: 8000 })
		await settle(500)
		expect(g.__syncCalls.length).toBe(2)
		expect(g.__calls.preread).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.getByText('HOME-PAGE')).toBeTruthy()
		expect(g.__logs.some((l: string) => /reason=sync_retry attempt=1/.test(l))).toBe(true)
	}, 20_000)
})

// A (2026-11-22, ): no shell screen stays stuck. Each waiting class re-reads on the schedule (2, 4, 8, 16 s, then 30 s) and lands
// on the home or onboarding when a definite answer comes. The diagnostic code of the class is logged on every wait.
describe('no stuck shell screens: each class re-enters on its own and reaches a definite landing', () => {
	it.each([
		['storage_locked', 'storage_locked'],
		['ambiguous_accounts', 'ambiguous_accounts'],
		['not_ready_persistent', 'not_ready_persistent'],
		['unreadable', 'unreadable_nonretryable'],
	])('%s: re-reads until the store answers, then onboarding (silent), with reason=%s logged', async (reason, code) => {
		g.__pageSeq = [{ status: 'unavailable', reason }, { status: 'unavailable', reason }]
		g.__idbPage = { status: 'empty' }
		g.__walletStatus = 'no_key'
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 15_000 })
		expect(g.__logs.some((l: string) => new RegExp(`reason=${code}`).test(l))).toBe(true)
		expect(g.__persistCalls.n).toBe(0)
	}, 25_000)

	it('shell storage unavailable: repeated background re-reads keep failing and never reach onboarding; once the store answers with a valid mnemonic, the home', async () => {
		// 2026-11-22 (review requirement): the storage-unavailable cause, not only the locked/ambiguous classes. Four failing reads (2, 4, 8, 16 s
		// schedule), then the store answers with the valid local record: the start lands on HOME. Nothing is onboarded before that answer.
		g.__pageSeq = [1, 2, 3, 4].map(() => ({ status: 'unavailable', reason: 'storage_locked' }))
		g.__idbPage = pageLocal()
		g.__walletStatus = 'no_key'
		g.__prereadAnswers = []
		renderAt('/home')
		await settle(14_000)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__logs.some((l: string) => /startup retry: attempt \d+, next in \d+ ms/.test(l))).toBe(true)
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 60_000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	}, 90_000)

	it('shell storage unavailable (read_error, a real storage-unavailable reason): repeated re-reads fail and never reach onboarding; the valid local record reaches HOME', async () => {
		// also use the real storage-unavailable reason code read_error（BROWSER_UNAVAILABLE_REASONS，storageRoute.ts），storage_locked 用例保留。
		g.__pageSeq = [1, 2, 3, 4].map(() => ({ status: 'unavailable', reason: 'read_error' }))
		g.__idbPage = pageLocal()
		g.__walletStatus = 'no_key'
		g.__prereadAnswers = []
		renderAt('/home')
		await settle(14_000)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__logs.some((l: string) => /startup retry: attempt \d+, next in \d+ ms/.test(l))).toBe(true)
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 60_000 })
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	}, 90_000)

	it('a stalled page read past the splash deadline: the start keeps waiting (no screen, no button), then the home when the read ends', async () => {
		const g2 = globalThis as { __hang?: boolean; __hangResolve?: (v: unknown) => void }
		g2.__hang = true
		g.__idbPage = pageLocal()
		renderAt('/home')
		await settle(14_000)
		// the round limit starts a background wait, so the deadline keeps waiting (never a screen): the shell has no undecided-screen path
		expect(g.__logs.some((l: string) => /splash deadline 12000ms while the native store is not ready: still waiting/.test(l))).toBe(true)
		expect(g.__logs.some((l: string) => /splash force-dismiss|retryable state/.test(l))).toBe(false)
		expect(screen.queryByText('native_not_ready_retry_title')).toBeNull()
		expect(screen.queryAllByRole('button')).toHaveLength(0)
		g2.__hang = false
		g2.__hangResolve?.(pageLocal())
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 20_000 })
	}, 60_000)

	it('returning to the foreground re-reads at once (before the next scheduled read)', async () => {
		g.__pageSeq = Array.from({ length: 30 }, () => ({ status: 'unavailable', reason: 'storage_locked' }))
		g.__idbPage = { status: 'empty' }
		g.__walletStatus = 'no_key'
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await settle(300)
		g.__pageSeq = []
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
		document.dispatchEvent(new Event('visibilitychange'))
		await settle(400)
		// the first scheduled read is 2 s away: the foreground read lands before it
		await waitFor(() => expect(screen.getByText('ONBOARDING-PAGE')).toBeTruthy(), { timeout: 1500 })
		expect(g.__logs.some((l: string) => /reason=foreground_reread/.test(l))).toBe(true)
	}, 20_000)
})

// item 1: the count is persisted before the judgement; only unlock_failed counts; verify_failed leaves no count and writes nothing.
const attemptKey = (eoa: string) => `passcodeAttempt:${eoa}`
const countOf = (eoa: string): number => ((globalThis as { __attemptDb?: Map<string, { failures?: number }> }).__attemptDb!.get(attemptKey(eoa))?.failures ?? 0)

describe('counting: a wrong passcode and a tampered record count; an address mismatch does not and writes nothing', () => {
	it('C1 a wrong six-digit passcode is counted in the persisted attempt document', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_WRONG } })
		await waitFor(() => expect(input.value).toBe(''), { timeout: 60_000 })
		expect(countOf(EOA_CIPHER)).toBe(1)
		expect(g.__persistCalls.n).toBe(0)
	}, 90_000)

	it('C2 a tampered ciphertext is counted (unlock_failed)', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: envWith(CT_TAMPERED, EOA_CIPHER) }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(input.value).toBe(''), { timeout: 60_000 })
		expect(countOf(EOA_CIPHER)).toBe(1)
		expect(g.__persistCalls.n).toBe(0)
	}, 90_000)

	it('C3 an address mismatch is not counted, the record object is unchanged, and nothing is written', async () => {
		const cipher = envWith(CT_OTHER_AAD, OTHER_EOA)
		const before = JSON.stringify(cipher)
		g.__prereadAnswers = [{ kind: 'cipher', cipher }]
		renderAt('/home')
		const input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_OK } })
		await waitFor(() => expect(screen.getByTestId('preread-passcode-message').textContent).toMatch(/does not match this account/), { timeout: 60_000 })
		expect(countOf(OTHER_EOA)).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
		expect(JSON.stringify(cipher)).toBe(before)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 90_000)

	it('C4 a refresh does not clear the count: two wrong inputs, a remount, then the third input locks', async () => {
		g.__prereadAnswers = [{ kind: 'cipher', cipher: CIPHER_ENVELOPE }]
		const first = renderAt('/home')
		let input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		for (let i = 0; i < 2; i++) {
			fireEvent.change(input, { target: { value: PASSCODE_WRONG } })
			await waitFor(() => expect(input.value).toBe(''), { timeout: 60_000 })
		}
		expect(countOf(EOA_CIPHER)).toBe(2)
		first.unmount()
		renderAt('/home')
		input = (await screen.findByTestId('preread-passcode-input')) as HTMLInputElement
		fireEvent.change(input, { target: { value: PASSCODE_WRONG } })
		await waitFor(() => expect(screen.getAllByTestId('preread-passcode-message').map((n) => n.textContent).join(' ')).toMatch(/Too many attempts/), { timeout: 60_000 })
		expect(countOf(EOA_CIPHER)).toBe(3)
		expect((screen.getByTestId('preread-passcode-input') as HTMLInputElement).disabled).toBe(true)
	}, 240_000)
})

// item 2: a native read is capped; a late answer is adopted only for the reqId the start still waits for, and dropped otherwise.
describe('native reads: 30 s cap (200 ms in this test), a timeout is logged, a late answer is matched by reqId', () => {
	beforeAll(() => setNativeReadCapMsForTest(200))
	afterAll(() => setNativeReadCapMsForTest(null))

	it('N1 a late answer for the reqId the start still waits for is adopted (verified, written, read back, home)', async () => {
		g.__prereadAnswers = [{ deferred: true }]
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /native_read_timeout reqId=s[a-z0-9]+/.test(l))).toBe(true), { timeout: 4000 })
		const resolve = (globalThis as { __deferredResolvers?: Array<(v: unknown) => void> }).__deferredResolvers!.shift()!
		resolve({ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE })
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 6000 })
		expect(g.__logs.some((l: string) => /late_result_adopted reqId=s[a-z0-9]+/.test(l))).toBe(true)
		expect(g.__persistCalls.phrases).toEqual([PHRASE_NATIVE])
	}, 20_000)

	it('N2 a late answer whose reqId was superseded by a newer read is dropped with a log; nothing is written', async () => {
		// read 1 is deferred; the quick re-read issues read 2 (it never answers); read 1 is released only after read 2 is issued
		g.__prereadAnswers = [{ deferred: true }, { hangForever: true }]
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /native_read_timeout reqId=s[a-z0-9]+/.test(l))).toBe(true), { timeout: 4000 })
		await waitFor(() => expect(g.__calls.preread).toBe(2), { timeout: 4000 })
		const resolve = (globalThis as { __deferredResolvers?: Array<(v: unknown) => void> }).__deferredResolvers!.shift()!
		resolve({ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE })
		await waitFor(() => expect(g.__logs.some((l: string) => /late_result_discarded reqId=s[a-z0-9]+ cause=reqid_mismatch/.test(l))).toBe(true), { timeout: 4000 })
		expect(g.__logs.some((l: string) => /late_result_adopted/.test(l))).toBe(false)
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
	}, 20_000)
})

// M6 (passcode-preserving unlock sync): a valid v3 record in the page IndexedDB (f3 keeps the envelope in mnemonicPhrase): the home on its EOA with
// zero native reads, and no sync before the unlock. The passcode account syncs once per page session, after the page unlock, as
// pwaWalletSync{eoa, cipher, passcode, seq} (PasscodeLockScreen / afterUiUnlock, see passcodeUnlockSync.test.ts); a refusal or no answer is a
// pending sync recorded by the sync itself, never a plaintext phrase.
describe('valid v3 record in the page IndexedDB: zero native reads; the sync waits for the unlock (M6)', () => {
	it('V1 the home with zero preread, walletStatus and passcode reads; no sync, no phrase and no page write before the unlock', async () => {
		const stored = JSON.parse(JSON.stringify(CIPHER_ENVELOPE))
		g.__idbPage = { status: 'loaded', data: { mnemonicPhrase: stored, profiles: [{ keyID: EOA_CIPHER }], beamio: {} } }
		renderAt('/home')
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		await settle(1500)
		expect(g.__cipherCalls.length).toBe(0)
		expect(g.__calls.preread).toBe(0)
		expect(g.__calls.walletStatus).toBe(0)
		expect(g.__calls.passcode).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
	}, 20_000)
})

// item 1: the two drop paths that were not tested.
describe('drop paths: a late answer after a decision, and a late status read, are discarded with a log', () => {
	beforeAll(() => setNativeReadCapMsForTest(200))
	afterAll(() => setNativeReadCapMsForTest(null))

	it('D1 a late preread answer that arrives after the start has concluded (home from the page) is discarded (cause=decided); nothing is written', async () => {
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ deferred: true }]
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /native_read_timeout reqId=s[a-z0-9]+/.test(l))).toBe(true), { timeout: 4000 })
		// the page becomes a valid local record; the foreground return re-reads at once (no timer): the start concludes from the page
		g.__idbPage = pageLocal()
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
		document.dispatchEvent(new Event('visibilitychange'))
		await waitFor(() => expect(screen.getByText('HOME-PAGE')).toBeTruthy(), { timeout: 4000 })
		// only now the late answer is released: the decision is already made, so it is dropped
		const resolve = (globalThis as { __deferredResolvers?: Array<(v: unknown) => void> }).__deferredResolvers!.shift()!
		resolve({ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE })
		await waitFor(() => expect(g.__logs.some((l: string) => /late_result_discarded reqId=s[a-z0-9]+ cause=decided/.test(l))).toBe(true), { timeout: 4000 })
		expect(g.__logs.some((l: string) => /late_result_adopted/.test(l))).toBe(false)
		expect(g.__persistCalls.phrases).not.toContain(PHRASE_NATIVE)
	}, 20_000)

	it('D2 a late passcodeStatus answer (after its 200 ms cap) is discarded with a log; the start waits and writes nothing', async () => {
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'absent' }]
		g.__walletStatus = 'no_key'
		g.__passcodeAfterMs = 400
		renderAt('/home')
		await settle(1000)
		expect(g.__logs.some((l: string) => /native_read_timeout reqId=s[a-z0-9]+ read=status/.test(l))).toBe(true)
		expect(g.__logs.some((l: string) => /late_result_discarded reqId=s[a-z0-9]+ cause=status_read/.test(l))).toBe(true)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__persistCalls.n).toBe(0)
	}, 20_000)
})

// item 2: a field of another shape, or an envelope whose EOA is not the record's keyID, is held (unknown), never onboarding, never synced.
describe('page mnemonicPhrase of another shape, or an envelope for another account: held, never onboarding, never synced', () => {
	it('an other-shape field with a key armor and native absent: no onboarding, no sync, no write', async () => {
		g.__idbPage = { status: 'loaded', data: { mnemonicPhrase: { foo: 'x' }, profiles: [{ keyID: EOA_CIPHER, privateKeyArmor: '-----BEGIN PGP PRIVATE KEY BLOCK-----' }], beamio: {} } }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await settle(1500)
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(g.__cipherCalls.length).toBe(0)
		expect(g.__syncCalls.length).toBe(0)
		expect(g.__persistCalls.n).toBe(0)
	}, 20_000)

	it('an envelope whose EOA is not the record keyID: held, not the home, nothing synced', async () => {
		g.__idbPage = { status: 'loaded', data: { mnemonicPhrase: CIPHER_ENVELOPE, profiles: [{ keyID: EOA_NATIVE }], beamio: {} } }
		g.__prereadAnswers = [{ kind: 'absent' }]
		renderAt('/home')
		await settle(1500)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		expect(g.__cipherCalls.length).toBe(0)
	}, 20_000)
})

// rule and the vectors NP-18 to NP-20 (gate level). Parser-level mapping: prereadVectorsNP14to20.test.ts.
import * as beamioModule from '@/services/beamio'

describe('NP-18 to NP-20 at the gate: verify_failed and capability-missing never write, never onboard the account', () => {
	it('NP-19 the pre-read answers verify_failed (D differs from the reply eoa): held with the verify_failed code, nothing written', async () => {
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'verify_failed' }]
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /reason=verify_failed/.test(l))).toBe(true), { timeout: 4000 })
		expect(g.__persistCalls.n).toBe(0)
		expect(screen.queryByText('HOME-PAGE')).toBeNull()
		expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
	}, 20_000)

	it('NP-18 the reply has no eoa (old shell, capability missing): the legacy judgement, no valid adoption, nothing written', async () => {
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'unknown', reason: 'unsupported' }]
		renderAt('/home')
		await waitFor(() => expect(g.__logs.some((l: string) => /pre-read not supported by this shell/.test(l))).toBe(true), { timeout: 4000 })
		expect(g.__persistCalls.n).toBe(0)
		expect(g.__logs.some((l: string) => /native mnemonic pre-read valid/.test(l))).toBe(false)
	}, 20_000)

	it('NP-20 D equals the reply eoa but a local account record has another address: verify_failed, nothing written, not onboarded', async () => {
		g.__idbPage = { status: 'empty' }
		g.__prereadAnswers = [{ kind: 'valid', eoa: EOA_NATIVE, phrase: PHRASE_NATIVE }]
		const probe = jest.spyOn(beamioModule, 'checkStorageWithStatus').mockImplementation(async () => ({ status: 'loaded', data: { profiles: [{ keyID: EOA_LOCAL }] } }) as never)
		try {
			renderAt('/home')
			await waitFor(() => expect(g.__logs.some((l: string) => /differs from the local account record/.test(l))).toBe(true), { timeout: 4000 })
			expect(g.__persistCalls.n).toBe(0)
			expect(screen.queryByText('HOME-PAGE')).toBeNull()
			expect(screen.queryByText('ONBOARDING-PAGE')).toBeNull()
		} finally {
			probe.mockRestore()
		}
	}, 20_000)
})
