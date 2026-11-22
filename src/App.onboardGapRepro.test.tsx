/**
 * A page-record entry comes back before the App init's own storage read, and that read ends empty. The entry's wake-up
 * must not be lost: the init runs again and the bar and its search show, and the chat starts once. Real App and entry gate; the native
 * bridge, the storage and the chat start are stubs. SYNTHETIC values only.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const mockLogs: string[] = []
// page-store write calls that pass the session write gate (the real gate decision, consultPageWriteGate): the no-write assertions count them
const mockWrites: { n: number } = { n: 0 }
// the page record bytes: a save that passes the gate rewrites them (the hold assertions compare these bytes before and after)
const mockStored: { bytes: string } = { bytes: '' }
// removal calls (the no-clear assertions): the page store's delete-like exports (wrapped in the mock below) and the browser storage removeItem / clear
const mockDeletes: { n: number } = { n: 0 }
const mockCountDeletes = (actual: Record<string, unknown>) => Object.fromEntries(Object.keys(actual).filter((k) => /delete|remove|clear|wipe|erase/i.test(k) && typeof actual[k] === 'function').map((k) => [k, (...a: unknown[]) => { mockDeletes.n += 1; return (actual[k] as (...x: unknown[]) => unknown)(...a) }]))
const mockStorageSpies: { remove?: jest.SpyInstance; clear?: jest.SpyInstance } = {}
const deleteCalls = (): number => mockDeletes.n + (mockStorageSpies.remove?.mock.calls.length ?? 0) + (mockStorageSpies.clear?.mock.calls.length ?? 0)
// the scenario's state: page copy (IndexedDB read) and native answers. FIXTURE values only.
const mockPage: { copy: any } = { copy: { status: 'empty' } }
// the EOA the page mnemonic derives (real value for the standard phrase is 0x9858...; R2 uses a different one)
const mockDerived: { eoa: string } = { eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94' }
// '' simulates a derivation failure (the real validMnemonicEoa returns '' on any error)
const mockNative: { preread: any; walletState: string; hasKey: any; walletStatus: string } = { preread: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' }
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

/** A synthetic account record with a local mnemonic (a not-key-only account), as the storage read returns it. */
const mockRecord = {
	profiles: [{ keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [], privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }],
	// a valid BIP39 phrase (1423/1428: the account evidence is a valid mnemonic; this is the standard test phrase, not a real wallet)
	mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
	beamio: { accountName: 'synthtag' },
	isReady: true,
}

/** The App's first storage read is held until the test releases it (empty); later reads return the record. */
const mockRace: { storageCalls: number; releaseFirstRead?: (v: unknown) => void } = { storageCalls: 0 }
/** the first page read of a start, when it differs from the page copy (0.53.44 open point (a): the page first read is confirmed empty) */
const mockFirst: { copy: any } = { copy: null }
/** the record the storage read returns when a scenario sets it (browser key-only copy); null = the account record */
const mockStorageRead: { record: any } = { record: null }
/** the record the read-back of a restore write returns (0.53.44) */
const mockReadBack: { record: any } = { record: null }

// the shell switch is read at call time (the factories are hoisted above this file's constants)
jest.mock('@/services/shellContext', () => ({ isShellContext: () => (globalThis as { __gateShell?: boolean }).__gateShell !== false }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => (globalThis as { __gateShell?: boolean }).__gateShell !== false,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
	hasNativeWalletListApi: () => false,
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (_level: string, message: string) => { mockLogs.push(String(message)) } }))

// The daemon context: a small real store with the flags the bar reads. Everything else is a no-op function.
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

// Storage: the App's first read is held (then empty); the gate's read and the later App reads return the record.
// jsdom cannot run ethers' derivation (cross-realm Buffer); the real hasValidMnemonic is tested in the node environment.
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasValidMnemonic: (d: { mnemonicPhrase?: unknown } | null | undefined) => Boolean(d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim()),
	// the page's valid mnemonic derives this EOA (the standard test phrase; the derivation itself is covered in the node tests)
	validMnemonicEoa: (d: { mnemonicPhrase?: unknown } | null | undefined) => (d && typeof d.mnemonicPhrase === 'string' && d.mnemonicPhrase.trim() ? mockDerived.eoa : ''),
}))
// the BIP-39 shape check runs ethers (not in jsdom): the phrase shape is checked here, the checksum is covered in the node tests
jest.mock('@/services/walletCredential', () => ({
	...jest.requireActual('@/services/walletCredential'),
	isMnemonicPhrase: (v: unknown) => typeof v === 'string' && /^[a-z]+( [a-z]+)*$/.test(v) && [12, 24].includes(v.split(' ').length),
}))
jest.mock('@/services/beamio', () => ({
	...jest.requireActual('@/services/beamio'),
	...mockCountDeletes(jest.requireActual('@/services/beamio')),
	checkStorageWithStatusWithTimeout: async () => mockPage.copy, // 0.53.39: jsdom has no IndexedDB; the page copy is confirmed empty unless the test sets it
	checkStorage: () => {
		mockRace.storageCalls += 1
		if (mockRace.storageCalls === 1) return new Promise((r) => { mockRace.releaseFirstRead = r })
		return Promise.resolve(mockStorageRead.record ? { status: 'loaded', data: mockStorageRead.record } : mockRecord)
	},
	checkStorageWithTransientRetry: () => Promise.resolve(mockFirst.copy ?? mockPage.copy),
	// 0.53.44: the read-back of a restore write (AppEntryGate, after the write)
	readStoredRecordForVerify: async () => mockReadBack.record,
	sendPendingProfileSync: jest.fn(),
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	// 0.53.44: the real gate decides (consultPageWriteGate, the same state AppEntryGate opens and closes); a save that passes writes the page bytes.
	storeSystemData: async () => {
		if (jest.requireActual('@/services/beamio').consultPageWriteGate('app_save')) { mockWrites.n += 1; mockStored.bytes = JSON.stringify({ written: mockWrites.n }) }
	},
	storeSystemDataAndWait: async () => {
		if (!jest.requireActual('@/services/beamio').consultPageWriteGate('app_save_wait')) return false
		mockWrites.n += 1
		mockStored.bytes = JSON.stringify({ written: mockWrites.n })
		return true
	},
	pageWriteGateStatus: () => jest.requireActual('@/services/beamio').pageWriteGateStatus(),
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => mockPage.copy,
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [{ keyID: '0x1111111111111111111111111111111111111111', isPrimary: true, referrer: null, isNode: false, type: 'ethereum', webFilter: true, tokens: [] }], beamio: { accountName: 'synthtag' }, isReady: true }),
	// The native wallet has no key for this account: the page record decides (boundary).
	reachNativeWallet: () => Promise.resolve({ status: 'no_key' }),
	rememberNativeEoa: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => 'not_reported',
	queryNativeWalletStatus: async () => ({ status: mockNative.walletStatus }),
	queryNativePasscodeStatus: async () => ({ walletState: mockNative.walletState, hasKey: mockNative.hasKey }),
	queryNativeWalletStateSafe: async () => 'not_reported',
	queryNativeMnemonicPreread: async () => mockNative.preread,
}))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: true, capabilities: ['identity.native-keys.v1'] }) }))
// Modules that build a worker from import.meta (not loadable under jest here): every export is an inert stub.
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
const mockChatStarts: unknown[] = []
const mockPushBinds: unknown[] = []
jest.mock('@/services/chat', () => new Proxy({ initChat: async () => { mockChatStarts.push(1) }, retryShellChatNow: () => undefined }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }), { virtual: true })
jest.mock('@/utils/ensureConetAa', () => ({ ensureConetAaForProfileAndPersist: () => Promise.resolve() }))
jest.mock('@/utils/cashTreesPushBind', () => new Proxy({ ensureNativePushBoundForWallet: (...a: unknown[]) => { mockPushBinds.push(a); return true } }, { get: (t: any, k: string) => (k in t ? t[k] : mockDeepStub()) }))
jest.mock('@/components/SplashScreen', () => () => null)
jest.mock('@/components/PasscodeLockScreen', () => () => null)
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
// 0.53.44: the onboarding modal's props are captured, so the restore and creation callbacks can be driven through the real AppEntryGate
const mockOnboarding: { props: any } = { props: null }
jest.mock('@/pages/Home/LoadingPage', () => (props: unknown) => {
	mockOnboarding.props = props
	return null
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

function resetScenario() {
	;(globalThis as { __gateShell?: boolean }).__gateShell = true
	mockDeletes.n = 0
	// fresh call-through spies per scenario (the jest config resets mocks before each test)
	mockStorageSpies.remove?.mockRestore()
	mockStorageSpies.clear?.mockRestore()
	mockStorageSpies.remove = jest.spyOn(Storage.prototype, 'removeItem')
	mockStorageSpies.clear = jest.spyOn(Storage.prototype, 'clear')
	mockReadBack.record = mockRecord
	mockFirst.copy = null
	mockStorageRead.record = null
	mockWrites.n = 0
	mockStored.bytes = JSON.stringify(mockRecord)
	mockLogs.length = 0
	mockChatStarts.length = 0
	mockRace.storageCalls = 0
	mockRace.releaseFirstRead = undefined
}

describe('REPRO 2026-11-21: page holds a valid mnemonic, native pre-read is absent (frozen 70e9c502)', () => {
	// let the previous case's leftover async work settle (the page-valid start keeps saving after its case returns), then reset the counters
	beforeEach(async () => {
		await new Promise((r) => setTimeout(r, 900))
		resetScenario()
	})

	it('PHR-05a / R1 page valid mnemonic + native absent (pre absent, walletState absent, walletStatus no_key, hasKey false): does the start route onboard?', async () => {
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		// settle: either the page-valid entry or the native start route is logged, or a short wait passes
		await waitFor(() => expect(mockLogs.some((m) => m.includes('page mnemonic is valid') || m.includes('native start route='))).toBe(true), { timeout: 3000 }).catch(() => undefined)
		await new Promise((r) => setTimeout(r, 300))
		const route = mockLogs.find((m) => m.includes('native start route=')) || ''
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		console.log('R1 valid-path log:', mockLogs.some((m) => m.includes('page mnemonic is valid')), ' kinds:', JSON.stringify((globalThis as any).__diagKinds))
		console.log('R1 TRACE:', JSON.stringify((globalThis as any).__trace))
		console.log('R1 start route line:', route.slice(0, 160))
		console.log('R1 diag read:', JSON.stringify((globalThis as any).__diagRead), 'eoa:', (globalThis as any).__diagEoa)
		console.log('R1 kinds:', JSON.stringify((globalThis as any).__diagKinds))
		console.log('R1 page logs:', JSON.stringify(mockLogs.filter((m) => /page|keyID|mnemonic/i.test(m)).slice(0, 8)))
		console.log('R1 onboarding entered:', onboarded)
		// Expected: NOT onboarding. The frozen code is expected to onboard (the gap).
		expect(onboarded).toBe(false)
		// 0.53.44 point 1: the valid page mnemonic with a consistent keyID opens the gate, and the app's own save reaches the page store
		expect(jest.requireActual('@/services/beamio').pageWriteGateStatus().permit).toBe('page_valid_mnemonic')
		expect(mockWrites.n).toBeGreaterThanOrEqual(1)
	})

	it('PHR-05c / R2 page mnemonic derives a different EOA than the record keyID (E7-1 confirmed_empty) + native absent: does the start route onboard?', async () => {
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockDerived.eoa = '0x2222222222222222222222222222222222222222'
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedBefore = mockStored.bytes
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('native start route='))).toBe(true), { timeout: 5000 })
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		const held = mockLogs.some((m) => m.includes('page_mnemonic_keyid_mismatch'))
		console.log('R2 onboarding entered:', onboarded, ' keyid-mismatch diag logged:', held, ' writes:', mockWrites.n)
		expect(mockWrites.n).toBe(0)
		console.log('R2 route line:', (mockLogs.find((m) => m.includes('native start route=')) || '').slice(0, 160))
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
		expect(onboarded).toBe(false)
		// 0.53.44: no save passed the gate during the hold and the page record bytes are unchanged
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(storedBefore)
		// the page record key is kept (bytes unchanged) and no removal or clear call ran during the hold
		expect(mockStored.bytes).not.toBe('')
		expect(deleteCalls()).toBe(0)
	})

	it('PHR-05e / R3 the stored phrase cannot be derived (derivation failure) + native absent: does the start route onboard? (must not)', async () => {
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockDerived.eoa = ''
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedBefore = mockStored.bytes
		renderApp()
		await new Promise((r) => setTimeout(r, 600))
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		console.log('R3 onboarding entered:', onboarded, ' writes:', mockWrites.n)
		expect(mockWrites.n).toBe(0)
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
		expect(onboarded).toBe(false)
		// 0.53.44: no save passed the gate during the hold and the page record bytes are unchanged
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(storedBefore)
		// the page record key is kept (bytes unchanged) and no removal or clear call ran during the hold
		expect(mockStored.bytes).not.toBe('')
		expect(deleteCalls()).toBe(0)
	})

	it('PHR-05b page unreadable (unknown) + native absent: no onboarding; retry notice (not a write)', async () => {
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedBefore = mockStored.bytes
		renderApp()
		await new Promise((r) => setTimeout(r, 600))
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		console.log('PHR-05b onboarding entered:', onboarded)
		expect(onboarded).toBe(false)
		// 0.53.44: no save passed the gate during the hold and the page record bytes are unchanged
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(storedBefore)
		// the page record key is kept (bytes unchanged) and no removal or clear call ran during the hold
		expect(mockStored.bytes).not.toBe('')
		expect(deleteCalls()).toBe(0)
	})

	it('SESSION: a page session that read a valid mnemonic does not onboard later (native ready re-run, page now empty, native absent)', async () => {
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('page mnemonic is valid'))).toBe(true), { timeout: 3000 })
		// the valid entry's own save runs after the entry log line: let it land before the hold's baseline is taken
		await new Promise((r) => setTimeout(r, 400))
		const writesBefore = mockWrites.n
		const storedBeforeHold = mockStored.bytes
		const storedAtHold = mockStored.bytes
		expect(storedAtHold).toBe(storedBeforeHold)
		mockPage.copy = { status: 'empty' }
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await new Promise((r) => setTimeout(r, 400))
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		const held = mockLogs.some((m) => m.includes('session_read_valid_page_mnemonic'))
		console.log('SESSION onboarding entered:', onboarded, ' session hold logged:', held, ' writes:', mockWrites.n)
		expect(onboarded).toBe(false)
		expect(mockWrites.n).toBe(writesBefore)
		expect(mockStored.bytes).toBe(storedAtHold)
		// the page record key is kept (bytes unchanged) and no removal or clear call ran during the hold
		expect(mockStored.bytes).not.toBe('')
		expect(deleteCalls()).toBe(0)
	})

	it('PHR-05d / C1 control: page empty + native absent (confirmed): onboarding is entered (the intended route)', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('native start route='))).toBe(true), { timeout: 5000 })
		const onboarded = mockLogs.some((m) => m.includes('pre-read absent, page confirmed empty: onboarding'))
		console.log('C1 onboarding entered:', onboarded)
		expect(onboarded).toBe(true)
	})

	it('LEAVE-HOLD: after a hold, the next valid start opens the gate and its write is visible (the gate does not stay closed)', async () => {
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedHold = mockStored.bytes
		renderApp()
		await new Promise((r) => setTimeout(r, 600))
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(storedHold)
		expect(jest.requireActual('@/services/beamio').pageWriteGateStatus().open).toBe(false)
		// the page becomes readable and holds a valid mnemonic for this EOA; the native-ready re-run is the next start
		mockPage.copy = { status: 'loaded', data: mockRecord }
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await waitFor(() => expect(mockWrites.n).toBeGreaterThanOrEqual(1), { timeout: 3000 })
		expect(mockStored.bytes).not.toBe(storedHold)
		expect(jest.requireActual('@/services/beamio').pageWriteGateStatus().permit).toBe('page_valid_mnemonic')
	})
})

/** 0.53.44 open points (a), (b) and the hold entry. FIXTURE values only. */
describe('0.53.44 open points and hold page entry (real App and AppEntryGate)', () => {
	beforeEach(async () => {
		await new Promise((r) => setTimeout(r, 900))
		resetScenario()
		mockOnboarding.props = null
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
	})
	const gate = () => jest.requireActual('@/services/beamio')
	const writeNow = async () => {
		await require('@/services/beamio').storeSystemData()
		await new Promise((r) => setTimeout(r, 300))
	}

	it('open point (a): native wallet present and read back consistent enters directly and opens the gate (positive)', async () => {
		// the first page read is confirmed empty; the pre-read page copy is a copy this native account validates (copyValidated, same keyID)
		mockFirst.copy = { status: 'empty' }
		mockPage.copy = { status: 'loaded', data: mockRecord, copyValidated: true }
		mockNative.preread = { kind: 'valid', eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94', phrase: mockRecord.mnemonicPhrase }
		mockNative.walletState = 'present'
		mockNative.hasKey = true
		mockNative.walletStatus = 'unlocked'
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('native wallet present'))).toBe(true), { timeout: 4000 })
		expect(gate().pageWriteGateStatus().permit).toBe('native_wallet_present')
		// the entry's own saves land first; the save below must reach the store through the open gate
		await new Promise((r) => setTimeout(r, 500))
		const before = mockWrites.n
		await writeNow()
		expect(mockWrites.n).toBe(before + 1)
		mockDerived.eoa = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
	})

	it('open point (b): a completed recovery opens the gate after its restore write reads back consistent (positive); the write waits for the window', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 5000 })
		expect(gate().pageWriteGateStatus().open).toBe(false)
		// the restore write outside the window is discarded (gate closed)
		await writeNow()
		expect(mockWrites.n).toBe(0)
		// the restore write: the window is opened by the onboarding modal, the write lands, and the gate opens on the read-back
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
		})
		await writeNow()
		expect(mockWrites.n).toBe(1)
		await act(async () => {
			await mockOnboarding.props.onRestoreWriteEnd(true, mockRecord)
		})
		expect(gate().pageWriteGateStatus().permit).toBe('recovery_completed')
		await writeNow()
		expect(mockWrites.n).toBe(2)
	})

	it('open point (b) negative: a restore whose read-back is not consistent keeps the gate closed', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 5000 })
		mockReadBack.record = null
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
			await mockOnboarding.props.onRestoreWriteEnd(true, mockRecord)
		})
		expect(gate().pageWriteGateStatus().open).toBe(false)
		await writeNow()
		expect(mockWrites.n).toBe(0)
	})

	it('open point (c) creation callbacks: the account creation completion opens the gate (onNewAccountCreated, reached by both create paths)', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 5000 })
		expect(typeof mockOnboarding.props.onNewAccountCreated).toBe('function')
		await act(async () => {
			mockOnboarding.props.onNewAccountCreated()
		})
		expect(gate().pageWriteGateStatus().permit).toBe('new_account_created')
		await writeNow()
		expect(mockWrites.n).toBe(1)
	})

	it('hold page: the gate retry and the restore button only (no identity prompt, no onboarding or create entry); the hold writes nothing', async () => {
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedHold = mockStored.bytes
		renderApp()
		await waitFor(() => expect(mockLogs.some((m) => m.includes('startup wait'))).toBe(true), { timeout: 5000 })
		await waitFor(() => expect(screen.getAllByText('native_not_ready_retry_action').length).toBe(1), { timeout: 3000 })
		// The single restore button of the hold page (the existing restore text)
		expect(screen.getAllByText('restore_wallet').length).toBe(1)
		// the identity prompt is not shown on the hold page
		expect(screen.queryByText('native_not_ready_hint')).toBeNull()
		expect(screen.queryByText('create_new_wallet')).toBeNull()
		expect(screen.queryByText('get_started')).toBeNull()
		expect(mockOnboarding.props).toBeNull()
		// the gate's retry: the hold stays, and nothing is written
		await act(async () => {
			screen.getAllByText('native_not_ready_retry_action')[0].click()
		})
		await new Promise((r) => setTimeout(r, 400))
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(storedHold)
		expect(gate().pageWriteGateStatus().open).toBe(false)
	})

	/** the hold page for the restore cases: the page is unreadable and the native side has no key (the same hold as above) */
	const holdForRestore = async () => {
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(screen.getAllByText('restore_wallet').length).toBe(1), { timeout: 5000 })
	}

	it('hold restore: the button opens the existing restore route (no create, no onboarding entry); writes stay 0 until the restore completes; a consistent read-back opens the gate and the write lands', async () => {
		await holdForRestore()
		// the page record bytes before the restore: the reference for the hold (nothing written)
		const previousRecord = mockStored.bytes
		await act(async () => {
			screen.getByText('restore_wallet').click()
		})
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 3000 })
		// the existing restore route: the modal is asked to require the recovery, and opens its restore screen directly
		expect(mockOnboarding.props.requireWalletRecover).toBe(true)
		expect(mockOnboarding.props.openRestoreFromHold).toBe(true)
		// the hold controls are gone; no create or onboarding callback is reached
		expect(screen.queryByText('native_not_ready_retry_action')).toBeNull()
		expect(mockWrites.n).toBe(0)
		// the restore is not complete: a write before the restore's own write is refused
		await writeNow()
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(previousRecord)
		expect(gate().pageWriteGateStatus().permit).not.toBe('recovery_completed')
		// the restore write (window), then its completion: the read-back of the restored record is consistent
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
		})
		await act(async () => {
			await mockOnboarding.props.onRestoreWriteEnd(true, mockRecord)
		})
		expect(gate().pageWriteGateStatus().permit).toBe('recovery_completed')
		await writeNow()
		expect(mockWrites.n).toBe(1)
		// the restored record is written; the previous record was the reference and is replaced only by a read-back consistent restore
		expect(mockStored.bytes).not.toBe(previousRecord)
	})

	it('hold restore failed: a restore that does not complete opens no gate and writes nothing', async () => {
		await holdForRestore()
		await act(async () => {
			screen.getByText('restore_wallet').click()
		})
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 3000 })
		const previousRecord = mockStored.bytes
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
			await mockOnboarding.props.onRestoreWriteEnd(false, null)
		})
		expect(gate().pageWriteGateStatus().permit).not.toBe('recovery_completed')
		expect(gate().pageWriteGateStatus().open).toBe(false)
		await writeNow()
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(previousRecord)
	})

	it('hold restore cancelled (no restore write ever starts): the gate stays closed and nothing is written', async () => {
		await holdForRestore()
		await act(async () => {
			screen.getByText('restore_wallet').click()
		})
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 3000 })
		const previousRecord = mockStored.bytes
		// the restore screen is left without a restore write: no start, no end
		await writeNow()
		expect(gate().pageWriteGateStatus().open).toBe(false)
		expect(mockWrites.n).toBe(0)
		expect(mockStored.bytes).toBe(previousRecord)
	})

	it('onboarding restore branch (not requireWalletRecover): a successful restore that reads back consistent opens the gate', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 5000 })
		// the onboarding entry: not the recover route and not the hold restore
		expect(mockOnboarding.props.requireWalletRecover).toBe(false)
		expect(mockOnboarding.props.openRestoreFromHold).toBeFalsy()
		expect(gate().pageWriteGateStatus().open).toBe(false)
		mockReadBack.record = mockRecord
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
			await mockOnboarding.props.onRestoreWriteEnd(true, mockRecord)
		})
		expect(gate().pageWriteGateStatus().permit).toBe('recovery_completed')
		await writeNow()
		expect(mockWrites.n).toBe(1)
	})

	it('onboarding restore branch failure: a restore that fails does not open the gate', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(mockOnboarding.props).not.toBeNull(), { timeout: 5000 })
		mockReadBack.record = mockRecord
		await act(async () => {
			mockOnboarding.props.onRestoreWriteStart()
			await mockOnboarding.props.onRestoreWriteEnd(false, mockRecord)
		})
		expect(gate().pageWriteGateStatus().permit).not.toBe('recovery_completed')
		await writeNow()
		expect(mockWrites.n).toBe(0)
	})
})

describe('0.53.44 open point (c): browser key-only copy of an established account', () => {
	beforeEach(async () => {
		await new Promise((r) => setTimeout(r, 900))
		resetScenario()
		mockOnboarding.props = null
	})
	it('open point (c) positive: a browser key-only copy (not in hold, not a recovery) enters and opens the gate; its save reaches the store', async () => {
		;(globalThis as { __gateShell?: boolean }).__gateShell = false
		mockRace.storageCalls = 1
		const keyOnly = { isReady: true, profiles: [{ keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94', isPrimary: true, privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [] }], beamio: { accountName: 'synthtag' } }
		mockStorageRead.record = keyOnly
		mockPage.copy = { status: 'loaded', data: keyOnly }
		renderApp()
		await waitFor(() => expect(jest.requireActual('@/services/beamio').pageWriteGateStatus().permit).toBe('browser_key_only_established'), { timeout: 4000 })
		await new Promise((r) => setTimeout(r, 300))
		const before = mockWrites.n
		await require('@/services/beamio').storeSystemData()
		await new Promise((r) => setTimeout(r, 300))
		expect(mockWrites.n).toBe(before + 1)
		expect(mockOnboarding.props).toBeNull()
	})
})
