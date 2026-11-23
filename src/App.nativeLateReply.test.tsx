/**
 * The native shell's record read (0.53.44, the recorded rule, revised 30 s): a read request is open for up to
 * 30 s; a reply inside that window is taken by the read in flight, a reply after it is ignored. The page store is an empty IndexedDB
 * (a missing document, the real read path); the native side is only a window transport whose reply timing the test sets. Real timers and the
 * real timeouts: readPageMnemonic, the race timers and the transient retry are not mocked. SYNTHETIC values only.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const mockLogs: string[] = []
// jest only: the app's module-level JSON-RPC providers (utils/constants, utils/membershipKyc) retry network detection every 1 s without end in
// this offline harness, and that retry logs after the file has finished ("Cannot log after tests are done"). Each provider that starts is recorded
// here and destroyed in afterAll, which ends its retry loop. Product code is not changed.
const liveRpcProviders: Array<{ destroy: () => void }> = []
{
	const ethersActual = jest.requireActual('ethers') as typeof import('ethers')
	const proto = ethersActual.JsonRpcProvider.prototype as unknown as { _start: () => void }
	const startOriginal = proto._start
	proto._start = function (this: unknown) {
		liveRpcProviders.push(this as { destroy: () => void })
		return startOriginal.call(this)
	}
}
afterAll(() => {
	for (const provider of liveRpcProviders.splice(0)) provider.destroy()
})
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
/** a validated copy (the native side holds the key): the shape the native ok carries (copyValidated, eoa, record with a mnemonic) */
const okRecord = { schemaVersion: 2, profiles: [{ keyID: EOA, isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], chats: [] }], mnemonicPhrase: PHRASE, beamio: { accountName: 'synthtag' }, isReady: true, rev: 1 }

/** One scenario: what the native side answers to each shellRecordRead request (null: never answers). */
/** reqId: a reply id other than the request's (the mismatch case); late: a second reply for the same request, after the first */
type ReadAnswer = { delayMs: number; payload: Record<string, unknown>; reqId?: number; late?: { delayMs: number; payload: Record<string, unknown> } } | null
const scenario: { read: (reqId: number) => ReadAnswer; walletEoa: 'no_key' | 'address'; preread: ReadAnswer | null } = {
	read: () => null,
	walletEoa: 'no_key',
	// the native answer to nativeMnemonicPreread (the start's pre-read, asked when the page store is confirmed empty): absent after 1 s by default
	preread: { delayMs: 1_000, payload: { ok: true, result: { code: 'confirmed_missing' } } } as ReadAnswer | null,
}
/** the pre-read reply window (the decision section 2: each native read waits up to 30 s; a late reply matched by reqId is taken while undecided) */
const PREREAD_INNER_TIMEOUT_MS = 30_000
/** the native sends: each read request with its send time, the time its reply is due, and the time the page stops waiting for it */
const sends: { reqId: number; sentAt: number; closeAt: number; replyAt: number | null }[] = []
const T0: { t: number } = { t: 0 }
const concurrency: { overlaps: number } = { overlaps: 0 }
/** the pre-read requests (nativeMnemonicPreread) sent in this case: the start's native pre-read when the page store is confirmed empty */
const prereads: { n: number } = { n: 0 }
const HARD_CAP_MS = 30_000

const mockWrites: { n: number } = { n: 0 }

/** the window transport: walletEoaAddress answers at once; shellRecordRead answers as the scenario says */
function installNativeHost(): void {
	const host: { postMessage: (s: string) => void; onmessage: ((ev: unknown) => void) | null; allowedOrigins?: unknown } = {
		postMessage: (text: string) => {
			const cmd = JSON.parse(text) as { type: string; reqId: number }
			const deliver = (payload: Record<string, unknown>, delayMs: number) => {
				setTimeout(() => host.onmessage?.({ data: JSON.stringify(payload) }), delayMs)
			}
			if (cmd.type === 'walletEoaAddress') {
				deliver(scenario.walletEoa === 'address' ? { type: 'ack', reqId: cmd.reqId, ok: true, result: { eoa: EOA } } : { type: 'ack', reqId: cmd.reqId, ok: false, error: 'no_key' }, 0)
				return
			}
			if (cmd.type === 'nativeMnemonicPreread') {
				prereads.n += 1
				// the pre-read is one request too: none is sent while an earlier one is open (its reply, or the page's 10 s inner timeout)
				const preSentAt = Date.now() - T0.t
				if (sends.some((x) => x.closeAt > preSentAt)) concurrency.overlaps += 1
				const preAnswer = scenario.preread
				const preReplyAt = preAnswer ? preSentAt + preAnswer.delayMs : null
				sends.push({ reqId: cmd.reqId, sentAt: preSentAt, closeAt: Math.min(preReplyAt ?? Infinity, preSentAt + PREREAD_INNER_TIMEOUT_MS), replyAt: preReplyAt })
				// the real pre-read transport (nativeRecovery prereadSend) with its real inner timeout; a null answer never replies
				if (preAnswer) deliver({ type: 'ack', reqId: preAnswer.reqId ?? cmd.reqId, ...preAnswer.payload }, preAnswer.delayMs)
				if (preAnswer?.late) deliver({ type: 'ack', reqId: cmd.reqId, ...preAnswer.late.payload }, preAnswer.late.delayMs)
				return
			}
			if (cmd.type !== 'shellRecordRead') return
			const sentAt = Date.now() - T0.t
			// the in-flight count: an earlier request still open at this send (not answered, not past its 30 s cap) is an overlap
			if (sends.some((x) => x.closeAt > sentAt)) concurrency.overlaps += 1
			const answer = scenario.read(cmd.reqId)
			const replyAt = answer ? sentAt + answer.delayMs : null
			sends.push({ reqId: cmd.reqId, sentAt, closeAt: Math.min(replyAt ?? Infinity, sentAt + HARD_CAP_MS), replyAt })
			if (answer) deliver({ type: 'ack', reqId: cmd.reqId, ...answer.payload }, answer.delayMs)
		},
		onmessage: null,
	}
	;(window as unknown as { BeamioShellRecord: unknown }).BeamioShellRecord = host
}

jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => true,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
	hasNativeWalletListApi: () => false,
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (_level: string, message: string) => { mockLogs.push(`${Date.now() - ((globalThis as { __t0?: number }).__t0 ?? 0)} ${String(message)}`) } }))
jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/providers/DaemonProvider', () => {
	const React = require('react')
	const Ctx = React.createContext(null)
	function DaemonProvider({ children }: { children: unknown }) {
		const [isInitialLoading, setIsInitialLoading] = React.useState(false)
		const [showFooter, setShowFooter] = React.useState(true)
		const [profiles, setProfiles] = React.useState([])
		const value = new Proxy({ isInitialLoading, setIsInitialLoading, showFooter, setShowFooter, profiles, setProfiles, hasNewVersion: false, darkModle: false, messageCount: 0, chatSearchOpen: false, scanData: '', scanIntent: '', exchangeRates: { CAD: 1.35, USDC: 1 }, usdcRates: { CAD: 1.35, USDC: 1 }, currencyRates: { CAD: 1.35, USDC: 1 }, currencyData: { CAD: 1.35, USDC: 1 } }, {
			get: (t: any, k: string) => (k in t ? t[k] : /^(set|on|handle|open|close|show|hide|toggle|reset|clear|navigate|dispatch|track|notify|register|stash|remove|add|update|refresh|load|sync|bind|push|mark)/.test(k) ? jest.fn() : /(Input|Text|Value|Link|Url|Tag|Address|Name|Code|Key|Id|Eoa|Memo|Note|Query|Search)$/.test(k) ? '' : /(s|List|Items|Records)$/.test(k) ? [] : /(rate|Rate|oracle|Oracle|price|Price|fx)/.test(k) ? {} : /(Data|Details|Snapshot|Balances|Map|Record|Cache|Status)$/.test(k) ? {} : undefined),
		})
		return React.createElement(Ctx.Provider, { value }, children)
	}
	return { DaemonProvider, useDaemonContext: () => React.useContext(Ctx) }
})
// the page's IndexedDB layer: an empty database (a missing init document). Everything above it is the real code.
jest.mock('pouchdb', () => {
	const missing = () => { const e: any = new Error('missing'); e.status = 404; e.name = 'not_found'; return e }
	// an in-memory database per name: a write is read back (the pre-read write-back is verified by an independent read); reset per case
	const stores = new Map<string, Map<string, Record<string, unknown>>>()
	const storeOf = (name: string) => { let m = stores.get(name); if (!m) { m = new Map(); stores.set(name, m) } return m }
	const factory: any = (name?: string) => {
		const db = storeOf(String(name ?? 'default'))
		return {
			get: async (id: string) => { const d = db.get(id); if (!d) throw missing(); return JSON.parse(JSON.stringify(d)) },
			put: async (doc: Record<string, unknown>) => { db.set(String(doc._id), JSON.parse(JSON.stringify(doc))); return { ok: true, id: doc._id, rev: '1-x' } },
			remove: async (doc: { _id: string }) => { db.delete(doc._id); return { ok: true } },
			allDocs: async () => ({ rows: [...db.keys()].map((id) => ({ id, doc: db.get(id) })) }),
		}
	}
	factory.__stores = stores
	return { __esModule: true, default: factory }
})
jest.mock('@/services/idbBlobCompat', () => ({ ...jest.requireActual('@/services/idbBlobCompat'), idbBlobCompatReady: async () => 'ready' }))
jest.mock('@/services/walletCredential', () => ({
	...jest.requireActual('@/services/walletCredential'),
	isMnemonicPhrase: (v: unknown) => typeof v === 'string' && /^[a-z]+( [a-z]+)*$/.test(v) && [12, 24].includes(v.split(' ').length),
}))
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasValidMnemonic: (d: { mnemonicPhrase?: unknown } | null | undefined) => Boolean(d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim()),
	validMnemonicEoa: (d: { mnemonicPhrase?: unknown } | null | undefined) => (d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim() ? EOA : ''),
}))
// only the writes and the network are stubbed (the writes are counted); the read path is the real one
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	// a save counts as a page write only when the real session write gate permits it (consultPageWriteGate)
	storeSystemData: async () => { if (jest.requireActual('@/services/beamio').consultPageWriteGate('app_save')) mockWrites.n += 1 },
	storeSystemDataAndWait: async () => {
		if (!jest.requireActual('@/services/beamio').consultPageWriteGate('app_save_wait')) return false
		mockWrites.n += 1
		return true
	},
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	reachNativeWallet: () => Promise.resolve({ status: 'no_key' }),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'absent',
	queryNativeWalletStatus: async () => ({ status: 'no_key' }),
	queryNativePasscodeStatus: async () => ({ walletState: 'absent', hasKey: 'not_reported' as const }),
	queryNativeWalletStateSafe: async () => 'absent',
	// the real pre-read (its own transport and timeouts); the native answer comes from the window host (scenario.preread)
	queryNativeMnemonicPreread: (...args: unknown[]) => (jest.requireActual('@/services/nativeRecovery') as { queryNativeMnemonicPreread: (...a: unknown[]) => unknown }).queryNativeMnemonicPreread(...args),
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }) }))
jest.mock('@/workers/beamioTag/client', () => mockDeepStub())
jest.mock('@/workers/appDaemon/client', () => mockDeepStub())
jest.mock('@/services/chatWorkerBridge', () => mockDeepStub())
// the page crypto in Jest: the v3 mnemonic KDF is injected through setMnemonicKdfForTest (argon2id by @noble/hashes; the bridge's worker cannot run here)
jest.mock('@/services/argon2WorkerBridge', () => ({
	warmArgon2Worker: () => undefined,
}))
require('@/services/passcode/mnemonicCipherV3').setMnemonicKdfForTest(async (pw: Uint8Array, salt: Uint8Array, o: { m: number; t: number; p: number; dkLen: number }) =>
	Uint8Array.from(require('@noble/hashes/argon2').argon2id(pw, salt, { m: o.m, t: o.t, p: o.p, dkLen: o.dkLen })),
)
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

let current: { unmount: () => void } | null = null
/** After a test: unmount the gate, then wait until no native request is open and none was sent for 3 s (no late answer leaks into the next test). */
async function drainNative(): Promise<void> {
	current?.unmount()
	current = null
	for (let i = 0; i < 240; i++) {
		const now = Date.now() - T0.t
		const open = sends.some((x) => x.closeAt > now)
		const lastSend = sends.reduce((m, x) => Math.max(m, x.sentAt), 0)
		if (!open && now - lastSend > 3_000) return
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
}

function renderApp() {
	current = null
	const out = render(
		<DaemonProvider>
			<MemoryRouter initialEntries={['/home']}>
				<App />
			</MemoryRouter>
		</DaemonProvider>,
	)
	current = out
	return out
}

const logged = (text: string) => mockLogs.some((m) => m.includes(text))
const retryButtons = () => screen.queryAllByRole('button', { name: 'native_not_ready_retry_action' }).length
/** every button on the start screen (0.53.44: the loading page has no startup button; the native unlock button is shown only while locked) */
const startupButtons = () => screen.queryAllByRole('button').filter((b) => /retry|restore|try again|recovery|reading|migration|reload/i.test(b.textContent ?? '')).length
const onboarded = () => logged('page confirmed empty: onboarding')
const okAnswer = (delayMs: number): ReadAnswer => ({ delayMs, payload: { ok: true, result: { code: 'ok', record: okRecord, rev: 1, copyValidated: true, eoa: EOA } } })

function resetScenario(read: (reqId: number) => ReadAnswer, walletEoa: 'no_key' | 'address' = 'no_key', preread: ReadAnswer | null = { delayMs: 1_000, payload: { ok: true, result: { code: 'confirmed_missing' } } }) {
	;(require('pouchdb').default as { __stores: Map<string, unknown> }).__stores.clear()
	scenario.read = read
	scenario.walletEoa = walletEoa
	scenario.preread = preread
	sends.length = 0
	concurrency.overlaps = 0
	prereads.n = 0
	T0.t = Date.now()
	;(globalThis as { __t0?: number }).__t0 = T0.t
	mockLogs.length = 0
	mockWrites.n = 0
	installNativeHost()
}

/** jsdom realm: ethers' BytesLike check rejects the PBKDF2 output here; the derivation is stubbed to the phrase's known EOA (the route after it is real). */
function stubDerivation(): { mockRestore: () => void } {
	return jest.spyOn(require('ethers').Wallet, 'fromPhrase').mockReturnValue({ address: EOA } as never)
}

/** jest only: a real IndexedDB API (fake-indexeddb) for the page's device store, as App.accountReset does; restored after the case. */
function installFakeIndexedDb(): () => void {
	const { IDBFactory } = require('fake-indexeddb') as typeof import('fake-indexeddb')
	const g = globalThis as unknown as { indexedDB?: unknown; structuredClone?: unknown; crypto?: unknown }
	const prevIdb = g.indexedDB
	const prevClone = g.structuredClone
	const prevCrypto = g.crypto
	// a reference copy: the device key is a CryptoKey, which a serialising clone would turn into a plain object
	g.structuredClone = (v: unknown) => v
	g.indexedDB = new IDBFactory()
	// jsdom has no WebCrypto (the vault's no_webcrypto): the Node implementation for this case only
	if (!(g.crypto as { subtle?: unknown } | undefined)?.subtle) g.crypto = require('node:crypto').webcrypto
	return () => {
		g.indexedDB = prevIdb
		g.structuredClone = prevClone
		g.crypto = prevCrypto
	}
}

describe('native record read: the 30 s request window (0.53.44)', () => {
	afterEach(async () => {
		await drainNative()
	}, 120_000)
		// (c) rewrite, IDB-first premise: the page IndexedDB is empty, so the start asks the native pre-read. Original intent kept: a late valid answer is taken.
		// a (was: native record ok at 11 s, validated copy): the pre-read valid at 8 s (after the 2 s round limit, inside the 10 s inner timeout) enters the home on its EOA; one request.
		it('a: pre-read valid at 8 s (inside the inner timeout): the start enters the home on the pre-read EOA; one pre-read request, none overlapping', async () => {
			resetScenario(() => null, 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
			const restoreIdb = installFakeIndexedDb()
			const derive = stubDerivation()
			renderApp()
			try {
				await waitFor(() => expect(logged('native mnemonic pre-read valid: writing it to the page IndexedDB, then the home')).toBe(true), { timeout: 25_000 })
			} finally {
				derive.mockRestore()
				restoreIdb()
			}
			expect(onboarded()).toBe(false)
			expect(prereads.n).toBe(1)
			expect(concurrency.overlaps).toBe(0)
		}, 60_000)

		// b (was: native ok at 31 s, after the 30 s window → ignored): the pre-read valid at 11 s is past the page's 10 s inner timeout, so it is not taken;
		// the start is a background wait (no button, nothing written), and the pre-read requests never overlap.
		// b (was: a reply at 11 s is ignored). the decision s.2: the reply is matched by reqId and undecided, so it is taken.
		// Depends on f2 (the 30 s reply window in the product); against the current product this fails until f2 is merged.
		it('b: pre-read valid at 11 s (inside the 30 s window, reqId matched, undecided) is taken: write-back verified, home; one request', async () => {
			resetScenario(() => ({ delayMs: 50, payload: { ok: true, result: { code: 'ok', rev: 1, record: { profiles: [{ keyID: EOA }] } } } }), 'no_key', { delayMs: 11_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
			const restoreIdb = installFakeIndexedDb()
			const derive = stubDerivation()
			renderApp()
			try {
				await waitFor(() => expect(logged('final_route=home')).toBe(true), { timeout: 45_000 })
			} finally {
				derive.mockRestore()
				restoreIdb()
			}
			expect(logged('native mnemonic pre-read valid: writing it to the page IndexedDB, then the home')).toBe(true)
			expect(logged('writeback=verified')).toBe(true)
			expect(onboarded()).toBe(false)
			expect(prereads.n).toBe(1)
			expect(concurrency.overlaps).toBe(0)
		}, 90_000)

		// c (was: native never answers): the pre-read never answers; each request ends at the 10 s inner timeout; background wait, no button, one request at a time.
		// c (was: never answers, 10 s). the decision s.2: one request waits the 30 s window; at its timeout a diagnostic with the code and reqId is logged.
		// Depends on f2 (the 30 s window and the timeout diagnostic in the product); fails until f2 is merged.
		it('c: pre-read never answers: one request waits the 30 s window; the timeout is logged with its code and reqId; background wait, no button', async () => {
			resetScenario(() => null, 'no_key', null)
			renderApp()
			await waitFor(() => expect(mockLogs.some((m) => /timeout/i.test(m) && /reqId/.test(m))).toBe(true), { timeout: 60_000 })
			expect(prereads.n).toBeGreaterThanOrEqual(1)
			expect(startupButtons()).toBe(0)
			expect(logged('page mnemonic is valid')).toBe(false)
			expect(onboarded()).toBe(false)
			expect(concurrency.overlaps).toBe(0)
		}, 120_000)
		// g: a reply whose reqId is not the request's is dropped, with a log; the start does not decide on it. Depends on f2 (the drop log).
		it('g: a pre-read reply with an unmatched reqId is dropped and logged; the start does not decide on it', async () => {
			resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: true, result: { code: 'confirmed_missing' } }, reqId: 999_999 })
			renderApp()
			await waitFor(() => expect(mockLogs.some((m) => /reqId/.test(m) && /(mismatch|drop|unmatched)/i.test(m))).toBe(true), { timeout: 45_000 })
			expect(onboarded()).toBe(false)
			expect(mockWrites.n).toBe(0)
		}, 90_000)
		// h: a second reply for the same request after the decision is dropped and logged; the decided route stands. Depends on f2 (the drop log).
		it('h: a second pre-read reply for the same request after the decision is dropped and logged; the decided route stands', async () => {
			resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: true, result: { code: 'confirmed_missing' } }, late: { delayMs: 3_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } } })
			renderApp()
			await waitFor(() => expect(onboarded()).toBe(true), { timeout: 30_000 })
			await waitFor(() => expect(mockLogs.some((m) => /reqId/.test(m) && /(after|late|decided|drop)/i.test(m))).toBe(true), { timeout: 20_000 })
			expect(logged('native mnemonic pre-read valid')).toBe(false)
			expect(logged('final_route=home')).toBe(false)
			expect(prereads.n).toBe(1)
		}, 90_000)

	it('e (control): a native answer at 4 s (absent) decides the start: the native pre-read decides, no unknown wait', async () => {
		resetScenario(() => ({ delayMs: 4_000, payload: { ok: true, result: { code: 'absent' } } }))
		renderApp()
		await waitFor(() => expect(onboarded()).toBe(true), { timeout: 20_000 })
		expect(logged('no answer source=init')).toBe(false)
		expect(concurrency.overlaps).toBe(0)
	}, 60_000)

	// 0.53.44 (): the start has two landings only; the recovery entry is inside the onboarding page, never at the start.
	// IDB is read first and is empty here, so the native pre-read decides. Original intent kept: a definite native answer is decided, nothing written by a hold.
	// p1 (was: needs_native_recovery at the start): a pre-read read_error is not a decision: a background wait, data kept, nothing written.
	it('p1 (read_error, was PNK-07): IDB missing, pre-read read_error → background wait (no landing, no button, nothing written)', async () => {
		resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: false, error: 'read_error' } })
		renderApp()
		await waitFor(() => expect(logged('startup wait (unknown: nothing deleted')).toBe(true), { timeout: 30_000 })
		expect(onboarded()).toBe(false)
		expect(logged('page mnemonic is valid')).toBe(false)
		expect(startupButtons()).toBe(0)
		expect(mockWrites.n).toBe(0)
		expect(prereads.n).toBeGreaterThanOrEqual(1)
	}, 60_000)

	// p2 (was: schema-2 key stripped → recovery entry): the pre-read ok with a plaintext mnemonic is written to the page and the home opens on its EOA.
	it('p2 (ok plaintext, was key-stripped recovery): IDB missing, pre-read valid → written, home entered; no onboarding', async () => {
		resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
		// jsdom realm: ethers' BytesLike check rejects the PBKDF2 output here (the derivation works in the app). The derivation is stubbed to the
		// phrase's known EOA; the route after the derivation is the real code.
		const derive = jest.spyOn(require('ethers').Wallet, 'fromPhrase').mockReturnValue({ address: EOA } as never)
		renderApp()
		try {
			await waitFor(() => expect(logged('native mnemonic pre-read valid: writing it to the page IndexedDB, then the home')).toBe(true), { timeout: 30_000 })
		} finally {
			derive.mockRestore()
		}
		expect(onboarded()).toBe(false)
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
		expect(prereads.n).toBe(1)
	}, 60_000)
		// u (was: native unreadable answer): a pre-read answer that the record is unreadable is a background wait, never the recovery entry.
		it('u (record_unreadable): an unreadable pre-read answer is a background wait (no screen, no button), never the recovery entry', async () => {
			resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: true, result: { code: 'error', sub: 'record_unreadable' } } })
			renderApp()
			await waitFor(() => expect(logged('startup wait (unknown: nothing deleted')).toBe(true), { timeout: 30_000 })
			expect(startupButtons()).toBe(0)
			expect(logged('native recovery needed (a definite answer)')).toBe(false)
			expect(onboarded()).toBe(false)
		}, 60_000)
	// the recorded rule: not part of 0.53.44. The normal ok for a non-schema-2 record with only non-wallet fields
	// (PNK-10) is not defined; the page-side expectation waits for the interface definition (next version). Behaviour is the same as
	// 0.53.43 (wallet_fields_missing, unknown with Retry): not a regression. The test is kept, not deleted; no field set is invented here.
	it.skip('n (not schema 2, only non-wallet fields): a normal ok, not the recovery entry and not unknown (PNK-10) [skipped: gap, next version]', async () => {
		// no schemaVersion, no profile key, only a non-wallet field: the spec requires a normal ok (the required outcome is asserted)
		const nonWallet = { rev: 1, beamio: { accountName: 'synthtag' }, isReady: true }
		resetScenario(() => ({ delayMs: 1_000, payload: { ok: true, result: { code: 'ok', record: nonWallet, rev: 1 } } }))
		renderApp()
		await waitFor(() => expect(logged('[shellRecordRead] returned source=init status=ok')).toBe(true), { timeout: 20_000 })
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
		expect(logged('shell_record_')).toBe(false)
		expect(mockWrites.n).toBe(0)
	}, 60_000)
	// the recorded rule: a shell without the key (and not a trusted blank) takes the recovery entry.
	// sa (was: no key → recovery entry at the start): IDB missing, pre-read ok with an encrypted (locked) copy → the unlock entry, never onboarding.
	it('sa (ok encrypted, was no-key recovery): IDB missing, pre-read locked → the native unlock wait (no onboarding, nothing written)', async () => {
		resetScenario(() => null, 'no_key', { delayMs: 1_000, payload: { ok: false, error: 'locked' } })
		renderApp()
		await waitFor(() => expect(logged('native locked: pre-read locked')).toBe(true), { timeout: 30_000 })
		expect(onboarded()).toBe(false)
		expect(mockWrites.n).toBe(0)
	}, 60_000)
	// the trusted blank: no record, the native side confirms absent and no_key → the onboarding (not the recovery entry)
	it('sb (scope): a trusted blank (no record; native absent; no_key) → the onboarding', async () => {
		resetScenario(() => ({ delayMs: 1_000, payload: { ok: true, result: { code: 'absent' } } }), 'no_key')
		renderApp()
		await waitFor(() => expect(onboarded()).toBe(true), { timeout: 30_000 })
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
		expect(mockWrites.n).toBe(0)
	}, 60_000)

	// unit (c), 2026-11-22: a late definite answer (12 s, after the 2 s round limit and the two 5 s attempts) is adopted by the start gate that
	// is waiting on the same request: no read_failed after the adoption, and no second shellRecordRead for that start.
		// f1 (was: native ok valid at 12 s, adopted): the pre-read valid at 8 s is adopted by the start that waits on it; no start wait after the adoption; one request.
		// f1 (was: a late valid at 8 s adopted, no wait after adoption). Now the write-back runs in Jest (argon2id injected, as setMnemonicKdfForTest), so the write-back verdict is asserted.
		it('f1b (45ada442 ②): the valid reply at 8 s, the read-back answers at 14 s: no onboarding at 12 s, the adoption is not interrupted; the home at 14 s; written once', async () => {
			resetScenario(() => ({ delayMs: 6_000, payload: { ok: true, result: { code: 'ok', rev: 1, record: { profiles: [{ keyID: EOA }] } } } }), 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
			const restoreIdb = installFakeIndexedDb()
			const derive = stubDerivation()
			renderApp()
			try {
				await new Promise((r) => setTimeout(r, 12_500))
				expect(logged('during an adoption: the write-back is not interrupted')).toBe(true)
				expect(mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))).toBe(false)
				expect(mockLogs.some((m) => m.includes('storage unavailable'))).toBe(false)
				await waitFor(() => expect(logged('final_route=home')).toBe(true), { timeout: 20_000 })
			} finally {
				derive.mockRestore()
				restoreIdb()
			}
			expect(logged('writeback=verified')).toBe(true)
			expect(prereads.n).toBe(1)
			// The adoption writes the page record once: one verified write-back. The mocked app-level save is counted only when the session write gate is open;
			// an app save requested before the read-back is discarded by design (not queued), and whether one is requested after the gate opens depends on
			// timing (alone: counted once; after another adoption test in the same file: requested early and discarded). So the count is 0 or 1, never more,
			// and the verified write-back is exactly one.
			expect(mockLogs.filter((m) => m.includes('writeback=verified')).length).toBe(1)
			expect(mockWrites.n).toBeLessThanOrEqual(1)
		}, 60_000)

		it('f1 control (no page reset): a late pre-read valid at 8 s is adopted; write-back verified; home; no start wait after adoption; one request', async () => {
			resetScenario(() => ({ delayMs: 50, payload: { ok: true, result: { code: 'ok', rev: 1, record: { profiles: [{ keyID: EOA }] } } } }), 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
			const restoreIdb = installFakeIndexedDb()
			const derive = stubDerivation()
			renderApp()
			try {
				await waitFor(() => expect(logged('final_route=home')).toBe(true), { timeout: 45_000 })
			} finally {
				derive.mockRestore()
				restoreIdb()
			}
			const adoptedAt = mockLogs.findIndex((m) => m.includes('native mnemonic pre-read valid'))
			expect(adoptedAt).toBeGreaterThanOrEqual(0)
			expect(logged('writeback=verified')).toBe(true)
			expect(mockLogs.slice(adoptedAt + 1).some((m) => m.includes('startup wait') || m.includes('no answer source='))).toBe(false)
			expect(prereads.n).toBe(1)
			expect(concurrency.overlaps).toBe(0)
		}, 60_000)

	// unit (c) reverse control for the drop path: a page reset (a real exported path that clears the module's in-flight read) runs while the
	// open native request is still waiting. The late ok (12 s) must still be taken by the start that is waiting on it.
		// f3 (was: a page reset during the wait does not lose a late ok): the reset at 6 s runs while the pre-read (valid at 8 s) is open; the late valid is still taken.
		it('f3 (late adoption, in-flight cleared): a page reset during the wait does not lose a late pre-read valid at 8 s; one request', async () => {
			resetScenario(() => null, 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: EOA } } })
			const derive = stubDerivation()
			const beamioActual = jest.requireActual('@/services/beamio')
			const reset = setTimeout(() => { void beamioActual.wipeLocalWalletForRestore() }, 6_000)
			renderApp()
			try {
				await waitFor(() => expect(logged('native mnemonic pre-read valid: writing it to the page IndexedDB, then the home')).toBe(true), { timeout: 30_000 })
			} finally {
				clearTimeout(reset)
				derive.mockRestore()
			}
			expect(prereads.n).toBe(1)
			expect(concurrency.overlaps).toBe(0)
		}, 60_000)

	// (2) with the same page reset: a late definite-absent answer at 12 s is adopted (onboarding), not read_failed; one request.
	it('f4 (late adoption, in-flight cleared): a native definite-absent answer at 12 s is adopted during a page reset: onboarding; one request', async () => {
		resetScenario(() => null, 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'confirmed_missing' } } })
		const beamioActual = jest.requireActual('@/services/beamio')
		const reset = setTimeout(() => { void beamioActual.wipeLocalWalletForRestore() }, 6_000)
		renderApp()
		try {
			await waitFor(() => expect(onboarded()).toBe(true), { timeout: 30_000 })
		} finally {
			clearTimeout(reset)
		}
		expect(prereads.n).toBe(1)
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
	}, 60_000)

	it('f2 control (no page reset): a native definite-absent answer at 12 s is adopted: the trusted-blank onboarding, not read_failed', async () => {
		resetScenario(() => null, 'no_key', { delayMs: 8_000, payload: { ok: true, result: { code: 'confirmed_missing' } } })
		renderApp()
		await waitFor(() => expect(onboarded()).toBe(true), { timeout: 30_000 })
		const adoptedAt = mockLogs.findIndex((m) => m.includes('page confirmed empty: onboarding'))
		expect(mockLogs.slice(adoptedAt + 1).some((m) => m.includes('startup wait'))).toBe(false)
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
		expect(prereads.n).toBe(1)
		expect(mockWrites.n).toBe(0)
	}, 60_000)

	// BeamioTag, no plaintext mnemonic, native no_key → onboarding (the recorded rule, reaffirmed,
	// the recorded rule). The parser returns the keyless record (keylessRecord) so this rule applies.
	it('sc (11-17 rule, the recorded rule): a BeamioTag record with no mnemonic and no key (native no_key) → the onboarding (silent, data kept)', async () => {
		const keyOnly = { rev: 1, profiles: [{ keyID: EOA, isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], chats: [] }], beamio: { accountName: 'synthtag' }, isReady: true }
		resetScenario(() => ({ delayMs: 1_000, payload: { ok: true, result: { code: 'ok', record: keyOnly, rev: 1 } } }))
		renderApp()
		await waitFor(() => expect(onboarded()).toBe(true), { timeout: 30_000 })
		expect(logged('native recovery needed (a definite answer)')).toBe(false)
		expect(mockWrites.n).toBe(0)
	}, 60_000)
	// 0.53.44: a failure that is not a decision keeps the data and waits in the background:
	// no landing, no button, no write. not_ready (both wire shapes), persistent, storage_locked and ambiguous_accounts are all background.
	// PENDING_DECISION (project owner): the final landing of storage_locked, ambiguous_accounts and not_ready_persistent is not decided.
	const failureCases: Array<[string, Record<string, unknown>]> = [
		['not_ready (iOS shape: result.code not_ready)', { ok: true, result: { code: 'not_ready', retryable: true, notReadyReason: 'migrating' } }],
		['not_ready (envelope shape: ok:false error not_ready)', { ok: false, error: 'not_ready' }],
		['not_ready_persistent (PENDING_DECISION: background)', { ok: true, result: { code: 'error', sub: 'not_ready_persistent' } }],
		['storage_locked (PENDING_DECISION: background)', { ok: true, result: { code: 'error', sub: 'storage_locked' } }],
		['ambiguous_accounts (PENDING_DECISION: background)', { ok: true, result: { code: 'error', sub: 'ambiguous_accounts' } }],
	]
	for (const [name, payload] of failureCases) {
		it(`f-keep: ${name}: no landing, no startup button, no write; the start waits in the background`, async () => {
			resetScenario(() => null, 'no_key', { delayMs: 1_000, payload })
			renderApp()
			await waitFor(() => expect(logged('startup wait (unknown: nothing deleted')).toBe(true), { timeout: 20_000 })
			expect(onboarded()).toBe(false)
			expect(logged('page mnemonic is valid')).toBe(false)
			expect(startupButtons()).toBe(0)
			expect(mockWrites.n).toBe(0)
			expect(concurrency.overlaps).toBe(0)
		}, 60_000)
	}
})
