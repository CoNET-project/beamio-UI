/**
 * r94: BROWSER entry-level cases (no shell). A key without a valid mnemonic is not
 * an entry in the browser either; a browser read that is unknown is kept and retried. Derived from App.entryPoints (same mocks).
 * Original header: entry-level cases. The real App and AppEntryGate run; every case enters through the gate.
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
	prereadCalls: number
	prereadCmd: Record<string, unknown> | null
	prereadThrow: boolean
	rereadState: 'valid' | 'absent' | 'unknown'
	writes: number
} = { page: null, nativeEoa: null, preread: null, reach: null, walletWrite: 'ok', prereadCalls: 0, prereadCmd: null, prereadThrow: false, rereadState: 'valid', writes: 0 }

const PWA_LOG: string[] = []
const CAPS = ['identity.native-keys.v1', 'identity.kpresent.v1']

jest.mock('@/services/shellContext', () => ({ isShellContext: () => false }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => false,
	hasNativeWalletListApi: () => false,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (level: string, line: string) => {
		PWA_LOG.push(`${level} ${line}`)
	},
}))
jest.mock('@/services/recoveredMnemonicRecord', () => ({ ...jest.requireActual('@/services/recoveredMnemonicRecord'), checkRecoveredRecord: () => 'valid' }))
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
	readStoredRecordForVerify: async () => ({ profiles: [{ keyID: EOA_X }], mnemonicPhrase: PHRASE_X, beamio: {} }),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	storeSystemData: async () => undefined,
	storeSystemDataAndWait: async () => {
		storeCalls.storeSystemDataAndWait += 1
		return true
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
	probeNativeCapabilities: async () => ({ answered: true, capabilities: CAPS }),
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
	queryNativeWalletState: async () => 'present',
	queryNativeWalletStatus: async () => ({ status: 'no_key' }), // 0.53.39 stub: the start route reads walletStatus
	queryNativePasscodeStatus: async () => ({ walletState: await (async () => 'present')(), hasKey: 'not_reported' as const }),
	queryNativeWalletStateSafe: async () => 'present',
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
}))
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
	const host: { postMessage: (raw: string) => void; onmessage: ((ev: { data: string }) => void) | null; allowedOrigins: string[] } = {
		allowedOrigins: [window.location.origin],
		onmessage: null,
		postMessage: (raw: string) => {
			const req = JSON.parse(raw) as Record<string, unknown>
			shellSent.push(req)
			let envelope: Record<string, unknown>
			if (req.type === 'nativeMnemonicPreread') {
				// the re-read after a failed write (spec §十一): the native state
				envelope = { ok: true, result: { state: race.rereadState } }
			} else if (req.type === 'walletEoaAddress') {
				envelope = race.nativeEoa?.kind === 'address' ? { ok: true, result: { eoa: race.nativeEoa.eoa } } : { ok: false, error: race.nativeEoa?.code ?? 'no_key' }
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
async function start(opts: { page: any; nativeEoa?: any; preread?: any; reach?: any; walletWrite?: typeof race.walletWrite }) {
	loadFresh()
	installDerivationTable()
	race.page = opts.page
	race.nativeEoa = opts.nativeEoa ?? null
	race.preread = opts.preread ?? null
	race.reach = opts.reach ?? { status: 'unlocked', eoa: EOA_X }
	race.walletWrite = opts.walletWrite ?? 'ok'
	race.prereadCalls = 0
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


/** Browser (no shell): the page store is the only source; the gate decides from it. */
describe('browser entry', () => {
	let consoles: jest.SpyInstance[]
	beforeEach(() => {
		consoles = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined), jest.spyOn(console, 'error').mockImplementation(() => undefined)]
	})
	afterEach(() => {
		consoles.forEach((c) => c.mockRestore())
	})
	const WALLET_ONLY_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], beamio: {} } }
	const LOADED_X = { status: 'loaded', data: { profiles: [{ keyID: EOA_X, privateKeyArmor: PK_X }], mnemonicPhrase: PHRASE_X, beamio: { accountName: 'synthtag' } } }
	const holdLogged = () => PWA_LOG.some((l) => l.includes('no key and no mnemonic — held'))
	const onboardLogged = () => PWA_LOG.some((l) => l.includes('account judgement=no_account action=onboard'))

	it('K1 a browser key without a valid mnemonic is not an entry: the gate judges no account and onboards; the store is kept', async () => {
		await start({ page: WALLET_ONLY_X, nativeEoa: null, preread: null })
		expect(homeShown()).toBe(false)
		expect(onboardLogged()).toBe(true)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('K2 a browser read that is unknown: not an entry, not onboarding, kept and retryable (no write)', async () => {
		await start({ page: UNKNOWN, nativeEoa: null, preread: null })
		expect(homeShown()).toBe(false)
		expect(holdLogged()).toBe(false)
		expect(storeCalls.storeSystemDataAndWait).toBe(0)
	})

	it('K3 control: a browser record with a valid mnemonic is judged an account and enters (the gate, not onboarding)', async () => {
		await start({ page: LOADED_X, nativeEoa: null, preread: null })
		// the gate judges the account from the valid mnemonic and enters; the browser App's own home is not rendered by this harness
		expect(PWA_LOG.some((l) => l.includes('account judgement=has_account action=enter'))).toBe(true)
		expect(onboardLogged()).toBe(false)
	})
})
