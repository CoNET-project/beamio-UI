/**
 * r94 (review; project directive): entry-level cases. The real App and AppEntryGate run; every case enters through the gate.
 * The native side is answered through the shell transports (window.BeamioShellRecord for walletEoaAddress and pwaWalletSync) and
 * through requestNativeAck for hello, walletStatus and nativeMnemonicPreread (stubs). The page's storage is controlled per case.
 * Derivation: ethers cannot derive a wallet under the jsdom realm, so Wallet.fromPhrase is a table of the public BIP-39 test vectors
 * (the addresses were derived with the same ethers in node). The comparison logic is the real one. SYNTHETIC values only.
 */
// The first case loads the whole App (cold module graph); under a loaded machine that exceeds jest's 5 s default.
jest.setTimeout(30_000)
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })

const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() as any })

// ---- synthetic accounts (public BIP-39 test vectors; addresses derived in node with the repo's ethers) ----
const PHRASE_X = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA_X = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PHRASE_Y = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const EOA_Y = '0x58a57ed9d8d624cbd12e2c467d34787555bb1b25'
const EOA_OTHER = '0x' + 'ab'.repeat(20)
const PK_X = '0x' + '11'.repeat(32)
const PK_Y = '0x' + '22'.repeat(32)
const TABLE: Record<string, { address: string; privateKey: string }> = {
	[PHRASE_X]: { address: EOA_X, privateKey: PK_X },
	[PHRASE_Y]: { address: EOA_Y, privateKey: PK_Y },
}

// ---- controlled per case ----
const race: {
	page: any // the page's storage read (checkStorage* results)
	nativeEoa: any // the walletEoaAddress answer: an address, or a refusal code
	preread: any // the nativeMnemonicPreread answer as the transport gives it
	reach: any // walletStatus (reachNativeWallet)
	walletWrite: any // pwaWalletSync answers: 'ok' | 'write_failed' | 'stale_seq' | 'no_reply'
	prereadCalls: number // the JS-interface (requestNativeAck) pre-reads
	windowPrereads: number // the window-channel pre-reads (trusted, Android and other injected shells)
	prereadCmd: Record<string, unknown> | null
	prereadThrow: boolean
	prereadWindow: any // the window reply to nativeMnemonicPreread (envelope), or 'silent'
	platform: 'android' | 'ios' | null
	noWindow: boolean
	rereadState: 'valid' | 'absent' | 'unknown'
	writes: number
} = { page: null, nativeEoa: null, preread: null, reach: null, walletWrite: 'ok', prereadCalls: 0, windowPrereads: 0, prereadCmd: null, prereadThrow: false, prereadWindow: null, platform: null, noWindow: false, rereadState: 'valid', writes: 0 }

/** The walletCredential answer of the case (ack envelope); undefined = unavailable. */
const credentialAnswer: { value?: unknown } = {}

const PWA_LOG: string[] = []
const CAPS = ['identity.native-keys.v1', 'identity.kpresent.v1']
const bridgeHelloCalls = { value: 0 }

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => race.platform,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (level: string, line: string) => {
		PWA_LOG.push(`${level} ${line}`)
	},
}))
jest.mock('@/services/recoveredMnemonicRecord', () => {
	const actual = jest.requireActual('@/services/recoveredMnemonicRecord')
	// default: the read-back check is 'valid' (the other cases); a case that sets readBackOverride runs the real check on its read-back
	return {
		...actual,
		checkRecoveredRecord: (readBack: unknown, eoa: string) => ((globalThis as any).__readBackOverrideSet ? actual.checkRecoveredRecord(readBack, eoa) : 'valid'),
	}
})
jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/providers/DaemonProvider', () => {
	const React = require('react')
	const Ctx = React.createContext(null)
	function DaemonProvider({ children }: { children: unknown }) {
		const [isInitialLoading, setIsInitialLoading] = React.useState(false)
		const [showFooter, setShowFooter] = React.useState(true)
		const [profiles, setProfiles] = React.useState([])
		const value = new Proxy({ isInitialLoading, setIsInitialLoading, showFooter, setShowFooter, profiles, setProfiles, hasNewVersion: false, darkModle: false, messageCount: 0, chatSearchOpen: false, scanData: '', scanIntent: '', myBrandCards: [], myBrandCardDetails: {}, recentActivityNoAaItems: [], conetWalletBalances: {}, conetAaWalletBalances: {}, gossip: [], charts: [], allNodes: [], power: 0, beamio: { accountName: 'synthtag' }, aaAccountUsdcBalance: 0, usdcbalance: 0, exchangeRates: { CAD: 1.35, USDC: 1 }, usdcRates: { CAD: 1.35, USDC: 1 }, currencyRates: { CAD: 1.35, USDC: 1 }, currencyData: { CAD: 1.35, USDC: 1 } }, {
			get: (t: any, k: string) => (k in t ? t[k] : /^(set|on|handle|open|close|show|hide|toggle|reset|clear|navigate|dispatch|track|notify|register|stash|remove|add|update|refresh|load|sync|bind|push|mark)/.test(k) ? jest.fn() : undefined),
		})
		return React.createElement(Ctx.Provider, { value }, children)
	}
	return { DaemonProvider, useDaemonContext: () => React.useContext(Ctx) }
})

const storeCalls = { storeSystemDataAndWait: 0 }
/** Per-case read-back override (the shell read-back of the record after a write; undefined = the default record that keeps the phrase). */
const readBackOverride: { value?: unknown } = {}
jest.mock('@/services/beamio', () => ({
	setPageWritePermit: () => undefined, // 0.53.44: the session write gate (AppEntryGate); stub here
	allowRestoreWrite: () => undefined,
  endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorage: async () => race.page,
	checkStorageWithTransientRetry: async () => race.page,
	checkStorageWithStatusWithTimeout: async () => race.page,
	checkStorageWithStatus: async () => race.page,
	sendPendingProfileSync: jest.fn(),
	// the record as written back by the adopt (the verify read; the page then reads it as loaded)
	readStoredRecordForVerify: async () => (readBackOverride.value !== undefined ? readBackOverride.value : { profiles: [{ keyID: (globalThis as any).__verifyKeyID ?? EOA_X }], beamio: {} }),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	storeSystemData: async () => undefined,
	storeSystemDataAndWait: async () => {
		storeCalls.storeSystemDataAndWait += 1
		return true
	},
	// the pre-read write-back (page IndexedDB, read back rule 4): jsdom cannot open the device-key vault, so the write is stubbed as
	// verified. It is counted as this file's page write (storeCalls.storeSystemDataAndWait), so every "nothing written" check still holds.
	// The verdict follows the case's read-back (readBackOverride): no record keeps the phrase (verified); a keyID of another account is a
	// mismatch; a record without a profile is absent. The verdict names are the page write-back verdicts of persistPageIdbMnemonic.
	persistPageIdbMnemonic: async (_record: unknown, _phrase: string, eoa: string) => {
		storeCalls.storeSystemDataAndWait += 1
		const back = readBackOverride.value as { profiles?: Array<{ keyID?: string }> } | undefined
		if (back === undefined) return 'verified'
		const keyID = back.profiles?.[0]?.keyID
		if (!keyID) return 'readback_absent'
		return keyID.trim().toLowerCase() === eoa.trim().toLowerCase() ? 'verified' : 'readback_mismatch'
	},
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	...jest.requireActual('@/services/nativeWallet'),
	reachNativeWallet: async () => race.reach,
	publicWalletSeed: (eoa: string) => ({ profiles: [{ keyID: eoa, isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	notifyNativeWalletReady: jest.fn(),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeChatRouteRegister', () => ({
	...jest.requireActual('@/services/nativeChatRouteRegister'),
	probeNativeCapabilities: async () => {
		bridgeHelloCalls.value += 1
		return { answered: true, capabilities: (globalThis as any).__capsOverride ?? CAPS }
	},
	// hello, walletStatus, passcodeStatus and nativeMnemonicPreread go through here (stubs)
	requestNativeAck: async (cmd: { type: string }) => {
		if (cmd.type === 'nativeMnemonicPreread') {
			race.prereadCalls += 1
			race.prereadCmd = { ...cmd }
			if (race.prereadThrow) throw new Error('bridge exception (fixture)')
			return race.preread ?? { kind: 'timeout' }
		}
		return { kind: 'timeout' }
	},
}))
jest.mock('@/services/nativeRecovery', () => ({
	...jest.requireActual('@/services/nativeRecovery'),
	queryNativeWalletState: async () => (globalThis as any).__walletStateOverride ?? 'present',
	queryNativeWalletStatus: async () => (globalThis as any).__walletStatusOverride ?? { status: 'no_key' }, // 0.53.39 stub: the start route reads walletStatus (overridable per case)
	queryNativePasscodeStatus: async () => ({ walletState: await (async () => (globalThis as any).__walletStateOverride ?? 'present')(), hasKey: (globalThis as any).__hasKeyOverride ?? ('not_reported' as const) }),
	queryNativeWalletStateSafe: async () => (globalThis as any).__walletStateOverride ?? 'present',
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
}))
// C1 pre-sync read: a present, unlocked native wallet (the sync is not held by the pre-check in these cases)
jest.mock('@/services/nativeKeyState', () => ({ ...jest.requireActual('@/services/nativeKeyState'), readNativeWalletStatus: async () => 'unlocked' }))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
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
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => undefined, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: () => true }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/components/SplashScreen', () => () => null)
jest.mock('@/components/PasscodeLockScreen', () => () => null)
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
jest.mock('@/pages/Home/LoadingPage', () => () => null)

// ---- the native window channel (walletEoaAddress, pwaWalletSync): a fake shell on window.BeamioShellRecord ----
let shellSent: Array<Record<string, unknown>> = []
function installShell() {
	shellSent = []
	if (race.noWindow) {
		delete (window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord
		return
	}
	const host: { postMessage: (raw: string) => void; onmessage: ((ev: { data: string }) => void) | null; allowedOrigins: string[] } = {
		allowedOrigins: [window.location.origin],
		onmessage: null,
		postMessage: (raw: string) => {
			const req = JSON.parse(raw) as Record<string, unknown>
			shellSent.push(req)
			let envelope: Record<string, unknown>
			if (req.type === 'nativeMnemonicPreread') {
				race.windowPrereads += 1
				race.prereadCmd = { ...req }
				// the pre-read (trusted window channel, Android shape) or the re-read after a failed write (spec §十一)
				if (race.prereadWindow === 'silent') return
				if (race.prereadWindow) envelope = race.prereadWindow
				else if (race.preread) {
					// the case's pre-read answer, as the trusted window channel carries it (ack envelope); a timeout case is an unknown answer
					envelope = race.preread.kind === 'payload' ? race.preread.payload : { ok: false, error: 'no_answer' }
				} else envelope = { ok: true, result: { state: race.rereadState } }
			} else if (req.type === 'walletEoaAddress') {
				envelope = race.nativeEoa?.kind === 'address' ? { ok: true, result: { eoa: race.nativeEoa.eoa } } : { ok: false, error: race.nativeEoa?.code ?? 'no_key' }
			} else if (req.type === 'walletCredential') {
				envelope = (credentialAnswer.value as Record<string, unknown> | undefined) ?? { ok: false, error: 'unavailable' }
			} else if (req.type === 'pwaWalletSync') {
				race.writes += 1
				const w = race.walletWrite
				if (w === 'no_reply') return
				envelope = w === 'ok' ? { ok: true, result: { sync: 'updated' } } : w === 'write_failed' ? { ok: false, error: 'write_failed', reason: 'internal_state' } : { ok: false, error: 'stale_seq' }
			} else {
				return
			}
			host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: req.reqId, ...envelope }) })
		},
	}
	;(window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord = host
}

// ---- derivation: the vector table (see the header) ----
/** Installed in the App's own module registry (after loadFresh): CRA resets mocks per test, and the App derives from its registry. */
function installDerivationTable() {
	const { ethers } = require('ethers')
	jest.spyOn(ethers.Wallet, 'fromPhrase').mockImplementation(((p: string) => {
		const hit = TABLE[p.trim()]
		if (!hit) throw new Error('invalid mnemonic (fixture)')
		return { address: hit.address, privateKey: hit.privateKey } as any
	}) as any)
	// the phrase shape check (ethers.Mnemonic) has the same realm limit: the table decides which phrases are valid
	jest.spyOn(ethers.Mnemonic, 'fromPhrase').mockImplementation(((p: string) => {
		if (!TABLE[p.trim()]) throw new Error('invalid mnemonic (fixture)')
		return {} as any
	}) as any)
}

let rtl: any
let act: any
let screen: any
let waitFor: any
let render: any
let MemoryRouter: any
let App: any
let DaemonProvider: any
function loadFresh() {
	jest.resetModules()
	rtl = require('@testing-library/react')
	act = rtl.act
	screen = rtl.screen
	waitFor = rtl.waitFor
	render = rtl.render
	MemoryRouter = require('react-router-dom').MemoryRouter
	App = require('./App').default
	DaemonProvider = require('@/providers/DaemonProvider').DaemonProvider
}
process.env.RTL_SKIP_AUTO_CLEANUP = 'true'
afterEach(() => {
	rtl?.cleanup()
	// the harness default is walletState present; an onboarding case sets absent explicitly and it is reset here
	;(globalThis as any).__walletStateOverride = undefined
})

function renderApp() {
	return render(
		<DaemonProvider>
			<MemoryRouter initialEntries={['/home']}>
				<App />
			</MemoryRouter>
		</DaemonProvider>,
	)
}

const homeShown = () => screen.queryByRole('button', { name: 'search' }) !== null

/** Starts a fresh App with the given storage, native and pre-read answers; resolves once the gate has decided (home or wait). */
async function start(opts: { page: any; nativeEoa?: any; preread?: any; reach?: any; caps?: string[]; credential?: unknown; walletWrite?: typeof race.walletWrite }) {
	loadFresh()
	bridgeHelloCalls.value = 0
	installDerivationTable()
	// the Android shell's origin check (the fixed app-assets origin) decides first; the test page is served from the app-assets origin on Android
	require('@/services/shellRecordTransport').setPageOriginForTest(race.platform === 'android' ? 'https://appassets.androidplatform.net' : null)
	race.page = opts.page
	race.nativeEoa = opts.nativeEoa ?? null
	race.preread = opts.preread ?? null
	race.reach = opts.reach ?? { status: 'unlocked', eoa: EOA_X }
	credentialAnswer.value = opts.credential
	;(globalThis as any).__capsOverride = opts.caps
	// the default shell read-back is the account this start restores (the real check then passes); a case overrides it with readBackOverride
	;(globalThis as any).__verifyKeyID = (opts.preread as { payload?: { result?: { eoa?: string } } } | null)?.payload?.result?.eoa ?? (race.prereadWindow as { result?: { eoa?: string } } | null)?.result?.eoa ?? (opts.nativeEoa?.kind === 'address' ? opts.nativeEoa.eoa : EOA_X)
	race.walletWrite = opts.walletWrite ?? 'ok'
	race.prereadCalls = 0
	race.windowPrereads = 0
	race.prereadCmd = null
	race.prereadThrow = false
	race.writes = 0
	storeCalls.storeSystemDataAndWait = 0
	PWA_LOG.length = 0
	installShell()
	renderApp()
	await act(async () => {
		await new Promise((r) => setTimeout(r, 50))
	})
}

const LOADED_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], mnemonicPhrase: PHRASE_X, beamio: {} } }
const EMPTY = { status: 'empty' }
const UNKNOWN = { status: 'unavailable', reason: 'timeout' }
const copyValidated = (keyID: string, phrase: string) => ({
	status: 'loaded',
	copyValidated: true,
	data: { profiles: [{ keyID }], mnemonicPhrase: phrase, beamio: {} },
})
const addr = (eoa: string) => ({ kind: 'address', eoa })
const payload = (p: Record<string, unknown>) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result: p } })

beforeEach(() => {
	jest.useRealTimers()
	race.walletWrite = 'ok'
})

describe('entry A: a native-validated copy whose EOA contradicts the native address (through the gate)', () => {
	it('unknown: no home, no sync, no write; the start waits and keeps the data', async () => {
		await start({ page: copyValidated(EOA_X, PHRASE_X), nativeEoa: addr(EOA_Y) })
		expect(homeShown()).toBe(false)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(0)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		// the first unknown of a start is re-asked at once (no verdict); the second unknown is the startup wait
		await waitFor(() => expect(PWA_LOG.some((l) => l.includes('startup wait'))).toBe(true), { timeout: 5000 })
	})
})

describe('entry B: page wallet X valid, native wallet Y valid, X ≠ Y (through the gate)', () => {
	it('B1 enters the PWA on X without asking the native address; pwaWalletSync is sent once with X; the home stays', async () => {
		await start({ page: LOADED_X, nativeEoa: addr(EOA_Y), reach: { status: 'unlocked', eoa: EOA_Y } })
		expect(homeShown()).toBe(true)
		expect(shellSent.filter((r) => r.type === 'walletEoaAddress')).toHaveLength(0)
		const writes = shellSent.filter((r) => r.type === 'pwaWalletSync')
		expect(writes).toHaveLength(1)
		expect(writes[0].eoa).toBe(EOA_X)
	})

	it('B2 SDK write_failed: the home and all data stay; the failure is shown and can be retried; each user retry sends exactly one request (no stacking)', async () => {
		// the native side still holds its wallet (the re-read answers valid), so a user retry is allowed to send
		await start({ page: LOADED_X, nativeEoa: addr(EOA_Y), walletWrite: 'write_failed', preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }) })
		expect(homeShown()).toBe(true)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(1)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(screen.getByText('shell_sync_native_unavailable_title')).toBeTruthy()
		// the registered retry (the notice's button) is the only way to send again
		const { retryShellSync } = require('@/services/shellSyncStatus')
		for (let i = 0; i < 3; i += 1) {
			await act(async () => {
				retryShellSync()
				await new Promise((r) => setTimeout(r, 0))
			})
		}
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(4)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync').every((r) => r.eoa === EOA_X)).toBe(true)
		expect(homeShown()).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})
})

describe('entry case 1: validated copy and native address for the same account', () => {
	it('enters on the native EOA; the sync is sent once with that EOA', async () => {
		await start({ page: copyValidated(EOA_X, PHRASE_X), nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(true)
		const writes = shellSent.filter((r) => r.type === 'pwaWalletSync')
		expect(writes).toHaveLength(1)
		expect(writes[0].eoa).toBe(EOA_X)
	})
})

describe('entry case 3: validated copy and native no_key', () => {
	it('enters on the copy EOA without waiting; the sync is sent once', async () => {
		await start({ page: copyValidated(EOA_X, PHRASE_X), nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(homeShown()).toBe(true)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(1)
	})
})

describe('entry case 4 and the pre-read boundaries (native pre-read through the gate)', () => {
	it('positive: the PWA confirms it is empty; the native pre-read is valid with a matching EOA; the phrase is adopted and the home opens; no phrase in logs, console or network', async () => {
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
		const fetchSpy = jest.fn(async () => new Response('{}'))
		;(globalThis as any).fetch = fetchSpy
		// the page is empty at the start; the adopt writes the page record, so the page reads as loaded afterwards
		race.page = EMPTY
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_X }), nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(storeCalls.storeSystemDataAndWait).toBeGreaterThanOrEqual(1)
		expect(homeShown()).toBe(true)
		const everything = [
			...PWA_LOG,
			...consoleSpy.mock.calls.flat().map(String),
			...warnSpy.mock.calls.flat().map(String),
			...errSpy.mock.calls.flat().map(String),
			...(fetchSpy.mock.calls.length ? [JSON.stringify(fetchSpy.mock.calls)] : []),
		].join('\n')
		expect(everything).not.toContain(PHRASE_X)
		consoleSpy.mockRestore()
		warnSpy.mockRestore()
		errSpy.mockRestore()
	})

	it('a PWA read that is unknown never starts the pre-read (the data is kept, the start waits)', async () => {
		await start({ page: UNKNOWN, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_X }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(bridgeHelloCalls.value).toBe(0)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('native unknown (timeout) is not adopted; nothing is written; the start waits', async () => {
		await start({ page: EMPTY, preread: { kind: 'timeout' }, nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('native unreadable (the pre-read answers absent-like unknown) is not adopted', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'unknown' }), nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('native untrusted_source is not adopted; nothing is written; the start waits', async () => {
		await start({ page: EMPTY, preread: { kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source' } }, nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('EOA mismatch: a valid pre-read whose phrase derives another address is unknown; nothing is adopted or written', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_Y }), nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})
})

describe('PHRASE_ONLY (E5.1) text state through the gate', () => {
	it('the home stays on the PWA wallet; the native-unavailable notice shows; nothing is cleared or re-created', async () => {
		await start({ page: LOADED_X, nativeEoa: addr(EOA_X), walletWrite: 'write_failed' })
		expect(homeShown()).toBe(true)
		expect(screen.getByText('shell_sync_native_unavailable_title')).toBeTruthy()
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})
})

/** Runs with this window as a child frame (window.top is another window). Restored afterwards. */
async function asChildFrame(fn: () => Promise<void>) {
	const realTop = window.top
	Object.defineProperty(window, 'top', { value: {}, configurable: true })
	try {
		await fn()
	} finally {
		Object.defineProperty(window, 'top', { value: realTop, configurable: true })
	}
}

/** The strings that must never reach a log, console, telemetry (fetch) or crash report (NE-07, NE-08). */
function leakedText(fetchSpy: jest.Mock, consoles: jest.SpyInstance[]) {
	return [
		...PWA_LOG,
		...consoles.flatMap((c) => c.mock.calls.flat().map(String)),
		...(fetchSpy.mock.calls.length ? [JSON.stringify(fetchSpy.mock.calls)] : []),
	].join('\n')
}

describe('E6 page side (PE-01, NE-01..NE-08), through AppEntryGate', () => {
	let consoles: jest.SpyInstance[]
	let fetchSpy: jest.Mock
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
		fetchSpy = jest.fn(async () => new Response('{}'))
		;(globalThis as any).fetch = fetchSpy
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})

	it('PE-01 accept: PWA confirmed empty; the request carries no phrase or credential field; the native valid answer is adopted when the derived EOA matches', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_X }), nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		// the request carries only the command, its seq (the transport adds reqId); no phrase or credential field (E1, NE-06)
		expect(Object.keys(race.prereadCmd ?? {}).sort()).toEqual(['reqId', 'seq', 'type'])
		expect(storeCalls.storeSystemDataAndWait).toBeGreaterThanOrEqual(1)
		expect(homeShown()).toBe(true)
		expect(leakedText(fetchSpy, consoles)).not.toContain(PHRASE_X)
	})

	it('NE-01 native unknown: not adopted, nothing written, the start waits; no phrase in the answer is used', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'unknown' }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('NE-02 native unreadable: not adopted, nothing written, the start waits', async () => {
		await start({ page: EMPTY, preread: payload({ state: 'unreadable' }), nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('NE-03 PWA read unknown: the pre-read is not started at all (no request, no return)', async () => {
		await start({ page: UNKNOWN, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_X }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(race.prereadCmd).toBeNull()
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('NE-04 child frame: the pre-read is not asked and the start waits; nothing is written', async () => {
		await asChildFrame(async () => {
			await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_X }), nativeEoa: addr(EOA_X) })
		})
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('NE-05 untrusted origin answer: not adopted, nothing written, the start waits', async () => {
		await start({ page: EMPTY, preread: { kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source' } }, nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('NE-07/NE-08 no phrase in logs, console, telemetry or crash reports on the refusal paths (a valid answer whose phrase derives another EOA)', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X, eoa: EOA_Y }), nativeEoa: addr(EOA_X) })
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(leakedText(fetchSpy, consoles)).not.toContain(PHRASE_X)
		expect(PWA_LOG.length).toBeGreaterThan(0) // the gate did log; only states, never the phrase
	})
})

/** Decision 2026-11-17 (through AppEntryGate): the account credential is a valid mnemonic; unknown is never onboarding. */
describe('decision 2026-11-17: wallet-only records, explicit absent, and the unknown family', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})
	const WALLET_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], beamio: {} } }
	const ADDRESS_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], beamio: {} } }
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))

	it('D1 a wallet record without a valid mnemonic (key only) is "no valid mnemonic": the pre-read is started and a valid native answer is adopted', async () => {
		await start({ page: WALLET_ONLY_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync' && r.eoa === EOA_X)).toHaveLength(0)
	})

	it('D1b an address-only record is also "no valid mnemonic": the pre-read is started', async () => {
		await start({ page: ADDRESS_ONLY_X, preread: { kind: 'timeout' }, nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('D3 native explicit absent: the start goes to onboarding by itself; the old store is not deleted or written', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await start({ page: WALLET_ONLY_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		// the start's pre-read and the one real read that confirms the absence before the onboarding (R2271)
		expect(race.prereadCalls + race.windowPrereads).toBe(2)
		expect(onboardingLogged()).toBe(true)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(0)
	})

	it.each([
		['timeout', { kind: 'timeout' }],
		['unknown', payload({ code: 'unknown' })],
		['unreadable', payload({ state: 'unreadable' })],
		['untrusted_source', { kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source' } }],
	])('D4 native %s: not onboarding, nothing written, the start waits', async (_name, answer) => {
		await start({ page: WALLET_ONLY_X, preread: answer, nativeEoa: addr(EOA_X) })
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('D4 an exception on the pre-read bridge: not onboarding, nothing written, the start waits', async () => {
		loadFresh()
		race.prereadThrow = true
		await start({ page: WALLET_ONLY_X, preread: null, nativeEoa: addr(EOA_X) })
		expect(onboardingLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('D5 two wallets with a valid mnemonic on the PWA side only count for B; a wallet-only PWA record is not B: the native valid answer is adopted and the PWA key is not synced', async () => {
		await start({ page: WALLET_ONLY_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync' && r.eoa === EOA_X)).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
	})
})

/** E7 (project decision 2026-11-17): the page-side cases P-01 … P-07, through AppEntryGate. A valid account = a valid BIP-39 mnemonic whose EOA is keyID. */
describe('E7 page side (P-01, P-02, P-03, P-06, P-07), through AppEntryGate', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))
	const WALLET_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], beamio: {} } }
	const ADDRESS_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], beamio: {} } }
	const MISMATCH_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_OTHER }], mnemonicPhrase: PHRASE_X, beamio: {} } }

	it('P-01 wallet only (key record) and native absent: onboarding by itself; every old record is kept', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await start({ page: WALLET_ONLY_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		expect(onboardingLogged()).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(homeShown()).toBe(false)
	})

	it('P-02 wallet only (account X) and native valid for Y: verify_failed, nothing written, not home, not onboarding (the local record is kept; a native answer for another account is never adopted)', async () => {
		// 2026-11-22 rule (verify the original wallet address; B.2): the local record is X, the native valid answer is Y: refused, the data stays.
		await start({ page: WALLET_ONLY_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('(a) plaintext pre-read without eoa is unsupported: the legacy path, never onboarding (d99d0ce3 B.3; capability missing)', async () => {
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_X }), nativeEoa: addr(EOA_X) })
		expect(PWA_LOG.some((l) => l.includes('pre_read_unsupported') || l.includes('legacy'))).toBe(true)
		expect(onboardingLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('(b) TS-06b: no_key, kPresent true, read ok, pre-read confirmed_missing, IDB empty: onboarding even with a key present (key_only), and nothing is deleted or written (the private key, the page copy and the IDB record stay)', async () => {
		;(globalThis as any).__hasKeyOverride = true
		;(globalThis as any).__walletStatusOverride = { status: 'not_ready', notReadyReason: 'key_only' }
		try {
			await start({ page: EMPTY, preread: payload({ code: 'confirmed_missing' }), nativeEoa: { kind: 'refused', code: 'not_supported' } })
			expect(onboardingLogged()).toBe(true)
			expect(homeShown()).toBe(false)
			expect(storeCalls.storeSystemDataAndWait).toBe(0)
			expect(race.walletWrite).toBe('ok')
		} finally {
			;(globalThis as any).__hasKeyOverride = undefined
			;(globalThis as any).__walletStatusOverride = undefined
		}
	})

	it('P-03 wallet only and native unknown or timeout: kept, retryable, not onboarding', async () => {
		await start({ page: WALLET_ONLY_X, preread: { kind: 'timeout' }, nativeEoa: addr(EOA_X) })
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		// the first unknown of a start is re-asked at once (no verdict); the second unknown is the startup wait
		await waitFor(() => expect(PWA_LOG.some((l) => l.includes('startup wait'))).toBe(true), { timeout: 5000 })
	})

	it('P-06 PWA read unknown: the pre-read is not started and the start is not onboarding', async () => {
		await start({ page: UNKNOWN, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(onboardingLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('P-07 the old store holds only an address (or a key) and native absent: onboarding; the old store is not deleted or written', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await start({ page: ADDRESS_ONLY_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		expect(onboardingLogged()).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(0)
	})

	it('E7-1 a valid mnemonic whose EOA is not the keyID is not the account credential: the pre-read is started, the mnemonic is not used', async () => {
		await start({ page: MISMATCH_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync' && r.eoa === EOA_OTHER)).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
	})
})

/**
 * Half-write rule (2026-11-17: an interrupted half-write is ignored; with no mnemonic the start goes to onboarding): a half-write window or an old
 * marker does not block the start. The page asks the native side only when it has no valid mnemonic; the native answer decides:
 * absent → onboarding (data kept), valid → taken back, unknown/no_answer/not_supported → kept and retryable. Local-only browser: see keyOnly suites.
 */
describe('half-write and old marker: no valid mnemonic on both sides is onboarding; any read fault is kept and retryable', () => {
	const MARKER = 'beamio.accountCleanupOld.pending.v1'
	const markerJson = JSON.stringify({ accountKey: EOA_X, idempotencyKey: 'key-half', keepNewAccount: true })
	const withMarker = async (run: () => Promise<void>) => {
		window.localStorage.setItem(MARKER, markerJson)
		try {
			await run()
		} finally {
			window.localStorage.removeItem(MARKER)
		}
	}
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))
	const WALLET_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], beamio: {} } }
	const PWA_VALID_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], mnemonicPhrase: PHRASE_X, beamio: {} } }
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})

	it('H1 both sides none, a half-write window (key-only record) and native absent: onboarding; the record is kept, nothing written or deleted', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await withMarker(() => start({ page: WALLET_ONLY_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) }))
		expect(onboardingLogged()).toBe(true)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(0)
	})

	it('H2 both sides none, an old marker and an empty store, native absent: onboarding; the marker does not block the start', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await withMarker(() => start({ page: EMPTY, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) }))
		expect(onboardingLogged()).toBe(true)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('H3 an old marker with the native side valid: the existing account is taken back (adopt), not onboarding', async () => {
		await withMarker(() => start({ page: WALLET_ONLY_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) }))
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
		expect(onboardingLogged()).toBe(false)
	})

	it('H4 the PWA holds a valid mnemonic: the start uses it directly, the native pre-read is not asked', async () => {
		await start({ page: PWA_VALID_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(onboardingLogged()).toBe(false)
	})

	it('H6 (E9-12 composite) an address-only record, a stale marker and native absent: onboarding; the marker and the record are still there afterwards (nothing deleted)', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		const ADDRESS_ONLY_STORED = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], beamio: {} } }
		await withMarker(async () => {
			await start({ page: ADDRESS_ONLY_STORED, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
			expect(onboardingLogged()).toBe(true)
			expect(homeShown()).toBe(false)
			expect(storeCalls.storeSystemDataAndWait).toBe(0)
			expect(window.localStorage.getItem(MARKER)).toBe(markerJson)
		})
	})

	it('R1 shell adopt (E6 pre-read valid) with a stripped read-back (review 2026-11-17, fixed): the shell read-back has no mnemonicPhrase; the keyID check passes, the account opens, and the held phrase is sent once through pwaWalletSync', async () => {
		// Before the fix this case failed (the check required mnemonicPhrase: write-back not confirmed, no home, no sync). The shell strips the
		// phrase on write (stripWalletFields), so the read-back carries only the keyID.
		readBackOverride.value = { profiles: [{ keyID: EOA_Y }], beamio: {} }
		;(globalThis as any).__readBackOverrideSet = true
		try {
			await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
			expect(PWA_LOG.some((l) => l.includes('write-back not confirmed'))).toBe(false)
			expect(homeShown()).toBe(true)
			const syncs = shellSent.filter((r) => r.type === 'pwaWalletSync')
			expect(syncs).toHaveLength(1)
			expect(syncs[0].eoa).toBe(EOA_Y)
		} finally {
			readBackOverride.value = undefined
			;(globalThis as any).__readBackOverrideSet = false
		}
	})

describe('CAP route cases (account-select CAP-01/03/04/05/06): a missing identity capability', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
		;(globalThis as any).__capsOverride = undefined
		;(globalThis as any).__walletStateOverride = undefined
	})
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))
	const NO_CAPS: string[] = []
	const PWA_VALID = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], mnemonicPhrase: PHRASE_X, beamio: {} } }

	it('CAP-01: capability missing, native no_key, PWA confirmed empty: unknown native phrase state; wait, never onboarding', async () => {
		;(globalThis as any).__walletStateOverride = 'absent'
		await start({ page: EMPTY, caps: NO_CAPS, reach: { status: 'no_key' }, nativeEoa: { kind: 'refused', code: 'no_key' } })
		;(globalThis as any).__walletStateOverride = undefined
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(PWA_LOG.some((l) => l.includes('capability missing'))).toBe(true)
	})

	it('CAP-03: capability missing, native no_key, PWA unknown: the start holds (startup state), not onboarding; no pre-read', async () => {
		await start({ page: UNKNOWN, caps: NO_CAPS, reach: { status: 'no_key' }, nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(onboardingLogged()).toBe(false)
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		// the first unknown of a start is re-asked at once (no verdict); the second unknown is the startup wait
		await waitFor(() => expect(PWA_LOG.some((l) => l.includes('startup wait'))).toBe(true), { timeout: 5000 })
	})

	it('CAP-04: capability missing, native absent (= no_key), a valid PWA mnemonic: the home opens directly, not onboarding (routing unaffected by the capability)', async () => {
		await start({ page: PWA_VALID, caps: NO_CAPS, reach: { status: 'no_key' }, nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(homeShown()).toBe(true)
		expect(onboardingLogged()).toBe(false)
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
	})

	it('CAP-05: capability missing, native unanswered (unknown), PWA confirmed empty: the start holds, not onboarding', async () => {
		await start({ page: EMPTY, caps: NO_CAPS, reach: { status: 'unknown' }, nativeEoa: { kind: 'refused', code: 'timeout' } })
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('CAP-06: capability missing, native not_ready (unreadable), PWA confirmed empty: the start holds, not onboarding', async () => {
		await start({ page: EMPTY, caps: NO_CAPS, reach: { status: 'not_ready', notReadyReason: 'unreadable' }, nativeEoa: { kind: 'refused', code: 'not_ready' } })
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
	})
})

/**
 * walletCredential restore (AppEntryGate restorePageCopy, the shell's background copy restore) and the negative read-back cases (2026-11-17
 * review, item 1-3). The shell read-back is controlled per case: readBackOverride plus __readBackOverrideSet route the read-back checks to the
 * real functions (default: valid, so the other cases are unchanged).
 */
describe('walletCredential restore and the shell read-back, through AppEntryGate', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
		readBackOverride.value = undefined
		;(globalThis as any).__readBackOverrideSet = false
	})
	const withReadBack = (value: unknown) => {
		readBackOverride.value = value
		;(globalThis as any).__readBackOverrideSet = true
	}
	// A shell without the native mnemonic pre-read cannot establish a wallet from status or address alone.
	const UNSUPPORTED_PREREAD = { kind: 'payload', payload: { type: 'ack', ok: false, error: 'unknown_command' } }
	const credentialY = { ok: true, result: { eoa: EOA_Y, credentialKind: 'mnemonic', mnemonic: PHRASE_Y, blob: 'BLOB-Y' } }
	const syncs = () => shellSent.filter((r) => r.type === 'pwaWalletSync')

	it('W1 walletCredential plus native address cannot replace the missing mnemonic pre-read; no write or home', async () => {
		withReadBack({ profiles: [{ keyID: EOA_Y }], beamio: {} })
		await start({ page: EMPTY, preread: UNSUPPORTED_PREREAD, reach: { status: 'unlocked', eoa: EOA_Y }, nativeEoa: addr(EOA_Y), credential: credentialY })
		expect(homeShown()).toBe(false)
		expect(PWA_LOG.some((l) => l.includes('pre-read not supported by this shell'))).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(syncs()).toHaveLength(0)
	})

	it('W6 (item A): a page copy already for this account (action none) and then the home retry: pwaWalletSync is sent once in total (the confirmed pair is not sent again)', async () => {
		const PAGE_Y = { status: 'loaded', data: { profiles: [{ keyID: EOA_Y }], mnemonicPhrase: PHRASE_Y, beamio: {} } }
		await start({ page: PAGE_Y, preread: UNSUPPORTED_PREREAD, reach: { status: 'unlocked', eoa: EOA_Y }, nativeEoa: addr(EOA_Y), credential: credentialY })
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50))
		})
		expect(syncs()).toHaveLength(1)
		const { retryShellSync } = require('@/services/shellSyncStatus')
		await act(async () => {
			retryShellSync()
			await new Promise((r) => setTimeout(r, 50))
		})
		expect(syncs()).toHaveLength(1)
		expect(syncs()[0].eoa).toBe(EOA_Y)
	})

	it('W2 the unsupported pre-read keeps the native credential path untouched; no write or deletion', async () => {
		withReadBack({ profiles: [{ keyID: EOA_X }], beamio: {} })
		await start({ page: EMPTY, preread: UNSUPPORTED_PREREAD, reach: { status: 'unlocked', eoa: EOA_Y }, nativeEoa: addr(EOA_Y), credential: credentialY })
		expect(syncs()).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('pre-read not supported by this shell'))).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('W3 the unsupported pre-read does not query or write a partial credential', async () => {
		withReadBack({ beamio: {} })
		await start({ page: EMPTY, preread: UNSUPPORTED_PREREAD, reach: { status: 'unlocked', eoa: EOA_Y }, nativeEoa: addr(EOA_Y), credential: credentialY })
		expect(syncs()).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('pre-read not supported by this shell'))).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('W4 negative (pre-read adopt): the shell read-back keyID is another account: not the home, no pwaWalletSync, the start waits and retries', async () => {
		withReadBack({ profiles: [{ keyID: EOA_X }], beamio: {} })
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(homeShown()).toBe(false)
		expect(syncs()).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('write-back not confirmed (readback_mismatch)'))).toBe(true)
	})

	it('W5 negative (pre-read adopt): the shell read-back has no profile: not the home, no pwaWalletSync, retryable', async () => {
		withReadBack({ beamio: {} })
		await start({ page: EMPTY, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(homeShown()).toBe(false)
		expect(syncs()).toHaveLength(0)
		expect(PWA_LOG.some((l) => l.includes('write-back not confirmed (readback_absent)'))).toBe(true)
	})
})

	it('H7 source priority: a valid PWA mnemonic is used directly; the native pre-read is not sent even when the native side would answer a valid mnemonic', async () => {
		await start({ page: PWA_VALID_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		// the native account A is not pulled into the PWA, but the PWA account B is still synced to the native side (B, sent once)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync' && r.eoa === EOA_Y)).toHaveLength(0)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync' && r.eoa === EOA_X)).toHaveLength(1)
		expect(onboardingLogged()).toBe(false)
	})

	it('H5 a native read fault with the old marker (timeout): kept and retryable, not onboarding, nothing written', async () => {
		await withMarker(() => start({ page: WALLET_ONLY_X, preread: { kind: 'timeout' }, nativeEoa: addr(EOA_X) }))
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		// the first unknown of a start is re-asked at once (no verdict); the second unknown is the startup wait
		await waitFor(() => expect(PWA_LOG.some((l) => l.includes('startup wait'))).toBe(true), { timeout: 5000 })
	})
})

/** E7 / E7.1 (2026-11-17 latest): the gate's real entry for the remaining page-side statements. */
describe('E7/E7.1 entry statements: address-only and key-only old stores, locked and unknown reads', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))
	const ADDRESS_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X }], beamio: {} } }
	const KEY_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], beamio: {} } }

	it('PWA address only and native valid: the start asks the shell (E6) and takes the existing wallet back', async () => {
		await start({ page: ADDRESS_ONLY_X, preread: payload({ code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y }), nativeEoa: addr(EOA_Y) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(PWA_LOG.some((l) => l.includes('pre-read address differs from the local account record: verify_failed'))).toBe(true)
		expect(homeShown()).toBe(false)
		expect(onboardingLogged()).toBe(false)
		expect(onboardingLogged()).toBe(false)
	})

	it('PWA key only and both sides confirm no valid mnemonic: onboarding by itself; no data is cleared', async () => {
		// 0.53.39: explicit trusted-source state for an onboarding case: native confirms no account (walletState absent)
		;(globalThis as any).__walletStateOverride = 'absent'
		await start({ page: KEY_ONLY_X, preread: payload({ code: 'confirmed_missing' }), nativeEoa: { kind: 'refused', code: 'no_key' } })
		expect(onboardingLogged()).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(shellSent.filter((r) => r.type === 'pwaWalletSync')).toHaveLength(0)
	})

	it('PWA read locked: unknown; the pre-read is not started; kept, retryable, not onboarding', async () => {
		await start({ page: { status: 'locked' }, preread: payload({ code: 'confirmed_missing' }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(0)
		expect(onboardingLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('native locked answer: unknown (E7.1-2); not onboarding, nothing written', async () => {
		await start({ page: EMPTY, preread: payload({ state: 'locked' }), nativeEoa: addr(EOA_X) })
		expect(race.prereadCalls + race.windowPrereads).toBe(1)
		expect(onboardingLogged()).toBe(false)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})
})

/** Android pre-read (2026-11-17 shape): only the trusted window channel; no JS-interface fallback; not_supported / no_answer / untrusted are unknown. */
describe('Android pre-read: window.BeamioShellRecord only (no JS interface fallback)', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
		race.platform = 'android'
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
		race.platform = null
		race.noWindow = false
		race.prereadWindow = null
	})
	const onboardingLogged = () => PWA_LOG.some((l) => l.includes('onboarding'))
	const PREREAD_VALID = { ok: true, result: { code: 'ok', mnemonic: PHRASE_Y, eoa: EOA_Y } }

	it('A1 trusted window answer valid: the wallet is taken back (adopt); the request went over the window channel, not the JS interface', async () => {
		race.prereadWindow = PREREAD_VALID
		await start({ page: EMPTY, nativeEoa: null })
		expect(shellSent.some((r) => r.type === 'nativeMnemonicPreread')).toBe(true)
		expect(race.prereadCalls).toBe(0)
		expect(race.windowPrereads).toBeGreaterThanOrEqual(1)
		expect(storeCalls.storeSystemDataAndWait).toBeGreaterThanOrEqual(1)
		expect(homeShown()).toBe(true)
	})

	it('A2 trusted window answer untrusted_source: unknown; not adopted, nothing written, not onboarding', async () => {
		race.prereadWindow = { ok: false, error: 'untrusted_source' }
		await start({ page: EMPTY, nativeEoa: null })
		expect(shellSent.some((r) => r.type === 'nativeMnemonicPreread')).toBe(true)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(onboardingLogged()).toBe(false)
		expect(race.prereadCalls).toBe(0)
	})

	it('A3 no answer from the SDK (no reply on the window channel): unknown; kept, retryable, not onboarding', async () => {
		race.prereadWindow = 'silent'
		await start({ page: EMPTY, nativeEoa: null })
		// the request went out on the window channel and no reply came (the transport answers no_answer after its timeout; not waited here)
		expect(shellSent.some((r) => r.type === 'nativeMnemonicPreread')).toBe(true)
		expect(homeShown()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(onboardingLogged()).toBe(false)
		expect(race.prereadCalls).toBe(0)
	}, 30_000)

	it('A4 Android without the window injection: not_supported, unknown; no JS-interface fallback (requestNativeAck is not used); kept, not onboarding', async () => {
		race.noWindow = true
		await start({ page: EMPTY, nativeEoa: null })
		expect(homeShown()).toBe(false)
		expect(race.prereadCalls).toBe(0)
		expect(race.windowPrereads).toBe(0)
		expect(shellSent.some((r) => r.type === 'nativeMnemonicPreread')).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
		expect(onboardingLogged()).toBe(false)
	})
})
