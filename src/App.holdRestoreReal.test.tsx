/**
 * REAL RENDER (2026-11-22 r2): the hold restore and the onboarding restore run through the real AppEntryGate, the real
 * BeamioOnboardingModal (LoadingPage) and the real RestoreWalletUnifiedScreen. Only the storage, the native bridge and the chat are stubs.
 * A page-record entry comes back before the App init's own storage read, and that read ends empty. The entry's wake-up
 * must not be lost: the init runs again and the bar and its search show, and the chat starts once. Real App and entry gate; the native
 * bridge, the storage and the chat start are stubs. SYNTHETIC values only.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
// A callable, constructible, property-returning stub for the worker modules (their methods are called at start-up).
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })
// The App is loaded after the text encoders exist (the jsdom global does not have them, and the App reads them when it loads).
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
// jsdom polyfills the real components read (the same as the restore screen's render test)
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList)
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }
const mockLogs: string[] = []
// page-store write calls that pass the session write gate (the real gate decision, consultPageWriteGate): the no-write assertions count them
const mockWrites: { n: number } = { n: 0 }
// the page record bytes: a save that passes the gate rewrites them (the hold assertions compare these bytes before and after)
const mockStored: { bytes: string } = { bytes: '' }
// removal calls (the no-clear assertions): the page store's delete-like exports (wrapped below) and the browser storage removeItem / clear
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
/** the answer of the password restore (restoreWithUserPin): false = a failed restore */
const mockRestore: { result: any } = { result: false }

// the shell switch is read at call time (the factories are hoisted above this file's constants)
// Test fixture: the gate keeps its shell state (the hold exists only in a shell), but the restore screen is rendered in browser
// mode, so its password form is the one under test (in a shell the same screen only opens the native recovery page).
// The screen is recognised by its render-time call stack (the component name RestoreWalletUnifiedScreen).
jest.mock('@/services/shellContext', () => ({
	isShellContext: () => {
		if (new Error().stack?.includes('RestoreWalletUnifiedScreen')) return false
		return (globalThis as { __gateShell?: boolean }).__gateShell !== false
	},
}))
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
	// real restore screen (LoadingPage, not mocked here): the password restore result and the restore write through the page gate
	restoreWithUserPin: async () => mockRestore.result,
	persistAndVerifyLocalWallet: async () => {
		if (jest.requireActual('@/services/beamio').consultPageWriteGate('app_save_wait')) {
			mockWrites.n += 1
			mockStored.bytes = JSON.stringify({ written: mockWrites.n })
		}
		return mockRecord
	},
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
	nativeRecoverySubmit: jest.fn(),
	nativeRecoveryCancel: jest.fn(),
	hasPageInputRecovery: async () => true,
	isTopFrameForRecovery: () => true,
	isTrustedRecoveryOrigin: () => true,
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
	mockReadBack.record = mockRecord
	mockFirst.copy = null
	mockStorageRead.record = null
	mockWrites.n = 0
	mockStored.bytes = JSON.stringify(mockRecord)
	mockLogs.length = 0
	mockChatStarts.length = 0
	mockRace.storageCalls = 0
	mockRace.releaseFirstRead = undefined
	mockDeletes.n = 0
	// fresh call-through spies per scenario (the jest config resets mocks before each test)
	mockStorageSpies.remove?.mockRestore()
	mockStorageSpies.clear?.mockRestore()
	mockStorageSpies.remove = jest.spyOn(Storage.prototype, 'removeItem')
	mockStorageSpies.clear = jest.spyOn(Storage.prototype, 'clear')
}


const gateOf = () => jest.requireActual('@/services/beamio')
const writeNowReal = async () => {
	await require('@/services/beamio').storeSystemData()
	await new Promise((r) => setTimeout(r, 300))
}
const restoreInput = () => document.getElementById('welcome-back-beamio-id') as HTMLInputElement | null
/** the real login form of the restore screen: the BeamioTag and the password (a valid length), then the unlock submit */
const submitRestoreForm = () => {
	fireEvent.change(restoreInput() as HTMLInputElement, { target: { value: 'synthtag' } })
	fireEvent.change(document.getElementById('welcome-back-password') as HTMLInputElement, { target: { value: '123456789' } })
	fireEvent.submit((restoreInput() as HTMLInputElement).closest('form') as HTMLFormElement)
}

describe('REAL RENDER: hold restore and onboarding restore through the real restore screen (2026-11-22 r2)', () => {
	beforeEach(async () => {
		await new Promise((r) => setTimeout(r, 900))
		resetScenario()
		mockRestore.result = false
		;(globalThis as { __gateShell?: boolean }).__gateShell = false
	})

	it('onboarding restore (real): the entry opens the real restore screen; a failed restore opens no gate and writes nothing; back returns to the onboarding start only on an explicit click', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		const storedBefore = mockStored.bytes
		renderApp()
		await waitFor(() => expect(screen.getByText(/already_have_a_beamio_id/)).toBeTruthy(), { timeout: 5000 })
		fireEvent.click(screen.getByText(/already_have_a_beamio_id/))
		await waitFor(() => expect(restoreInput()).not.toBeNull(), { timeout: 3000 })
		// the restore screen is shown and the onboarding start is not
		expect(screen.queryByText('get_started')).toBeNull()
		expect(gateOf().pageWriteGateStatus().open).toBe(false)
		await writeNowReal()
		expect(mockWrites.n).toBe(0)
		// a failed restore (the password restore answers false): no gate, no write, the screen stays
		submitRestoreForm()
		await waitFor(() => expect(screen.getByText('something_went_wrong_while_restoring_your_wallet')).toBeTruthy(), { timeout: 3000 })
		expect(restoreInput()).not.toBeNull()
		expect(gateOf().pageWriteGateStatus().permit).not.toBe('recovery_completed')
		await writeNowReal()
		expect(mockWrites.n).toBe(0)
		// no automatic jump: the onboarding start appears only after the explicit back control
		await new Promise((r) => setTimeout(r, 300))
		expect(restoreInput()).not.toBeNull()
		expect(screen.queryByText('get_started')).toBeNull()
		fireEvent.click(screen.getByLabelText('back'))
		await waitFor(() => expect(screen.getByText('get_started')).toBeTruthy(), { timeout: 3000 })
		await waitFor(() => expect(restoreInput()).toBeNull(), { timeout: 3000 })
		expect(mockWrites.n).toBe(0)
		// the original page record is kept: its key still holds the bytes read before the restore, and no removal or clear call ran
		expect(mockStored.bytes).not.toBe('')
		expect(mockStored.bytes).toBe(storedBefore)
		expect(deleteCalls()).toBe(0)
	})

	it('onboarding restore (real) success: a restore that reads back consistent opens the gate and its write lands; the write waits for the restore', async () => {
		mockPage.copy = { status: 'empty' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await waitFor(() => expect(screen.getByText(/already_have_a_beamio_id/)).toBeTruthy(), { timeout: 5000 })
		fireEvent.click(screen.getByText(/already_have_a_beamio_id/))
		await waitFor(() => expect(restoreInput()).not.toBeNull(), { timeout: 3000 })
		await writeNowReal()
		expect(mockWrites.n).toBe(0)
		const previousRecord = mockStored.bytes
		mockRestore.result = mockRecord
		mockReadBack.record = mockRecord
		submitRestoreForm()
		await waitFor(() => expect(gateOf().pageWriteGateStatus().permit).toBe('recovery_completed'), { timeout: 5000 })
		await writeNowReal()
		expect(mockWrites.n).toBeGreaterThanOrEqual(1)
		expect(mockStored.bytes).not.toBe(previousRecord)
	})

	it('0.53.44 (no startup restore entry, retired): hold restore (real): the hold restore button opens the real restore screen → no startup button, no write', async () => {
		;(globalThis as { __gateShell?: boolean }).__gateShell = true
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await new Promise((r) => setTimeout(r, 3000))
		// 0.53.44: the hold page has no startup button (no Restore Wallet, no Try Again)
		expect(screen.queryAllByText('restore_wallet').length).toBe(0)
		expect(screen.queryAllByText('native_not_ready_retry_action').length).toBe(0)
		expect(mockWrites.n).toBe(0)
	}, 30000)
	it('0.53.44 (no startup restore entry, retired): hold restore (real) success: the write waits for the restore → no startup button, no write', async () => {
		;(globalThis as { __gateShell?: boolean }).__gateShell = true
		mockPage.copy = { status: 'unavailable' }
		mockNative.preread = { kind: 'absent' }
		mockNative.walletState = 'absent'
		mockNative.hasKey = false
		mockNative.walletStatus = 'no_key'
		renderApp()
		await new Promise((r) => setTimeout(r, 3000))
		// 0.53.44: the hold page has no startup button (no Restore Wallet, no Try Again)
		expect(screen.queryAllByText('restore_wallet').length).toBe(0)
		expect(screen.queryAllByText('native_not_ready_retry_action').length).toBe(0)
		expect(mockWrites.n).toBe(0)
	}, 30000)
})
