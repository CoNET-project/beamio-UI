/**
 * Page level account reset and capability tiers. SYNTHETIC values only.
 * ST-02, ST-03, ST-05: the page-level cases of accountResetCases. CP-01 to CP-06: onboardingCompatCases, with CP-04 (the
 * legacy shell without identity.native-keys.v1) covered at the tier level in accountReset.test.ts, see the receipt.
 * Real App and entry gate; the native bridge and the storage are stubs.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
const mockDeepStub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : k === '__esModule' ? true : mockDeepStub()), apply: () => mockDeepStub(), construct: () => mockDeepStub() })

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94' // derives from PAGE_PHRASE (the page sync checks the derivation)
type Native =
	| { status: 'no_key' }
	| { status: 'unknown' }
	| { status: 'not_ready'; notReadyReason: 'unreadable' | 'g1_uninitialized' }
	| { status: 'locked' | 'unlocked'; eoa: string }
// Declared before the App is loaded: the module mocks below read it lazily.
const race: {
	shell: boolean
	native: Native
	walletState: 'absent' | 'present' | 'locked' | 'not_ready'
	kPresent: boolean | undefined
	caps: string[]
	eoa: string | null
	idb: 'empty' | 'key' | 'unknown' | 'locked'
	walletStateCalls: number
	reachCalls: number
	probeCalls: number
	answered: boolean
	wipes: number
	writes: string[]
	queryCalls: number
} = { shell: true, native: { status: 'no_key' }, walletState: 'absent', kPresent: false, caps: ['identity.native-keys.v1', 'identity.kpresent.v1'], eoa: EOA, idb: 'empty', walletStateCalls: 0, reachCalls: 0, probeCalls: 0, answered: true, wipes: 0, writes: [], queryCalls: 0 }
// Synthetic: the BIP-39 public test vector (not an account). Its first account is the EOA used by the derivation test below.
const PAGE_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// Counts every render of the onboarding stand-in: a trajectory that enters onboarding at any moment is a failure (spec 57(6), RM-05..07).
// `arrivals` records, in order, what the real start-up reducer received and reached: the page answers, the native pre-read answers, the
// home and the onboarding. The RM-07 check reads these recorded arrivals and nothing else (spec 57(5)).
const mockTrail: { onboardingRenders: number; arrivals: string[] } = { onboardingRenders: 0, arrivals: [] }

const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
const App = require('./App').default
const { DaemonProvider } = require('@/providers/DaemonProvider')

jest.mock('@/services/shellContext', () => ({ isShellContext: () => race.shell }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: () => race.shell,
	getCashTreesNativeNfcBridge: () => null,
	getCashTreesNativeNfcHost: () => null,
	dispatchNativeSystemCallAction: jest.fn(),
	openExternalUrl: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
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
// r92 steps 1 and 2: a shell start reads the old PWA store (PouchDB "init") first. This file keeps that store absent (its page record is
// the race.idb switch above), so the database answers a missing document (404) instead of a missing PouchDB in jsdom.
jest.mock('pouchdb', () => ({
	__esModule: true,
	default: () => ({
		get: async () => {
			const e = Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
			throw e
		},
		put: async () => ({ ok: true }),
		remove: async () => ({ ok: true }),
		close: async () => undefined,
	}),
}))

// r92 step 6: the page sync checks the phrase's derivation; jsdom has no WebCrypto for BIP-39 derivation, so the test derivation is the
// fixture's own (the standard phrase of PAGE_PHRASE derives to EOA above).
jest.mock('@/services/shellLegacyIdbInit', () => ({
	...jest.requireActual('@/services/shellLegacyIdbInit'),
	mnemonicEoa: (phrase: string) => (phrase === 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' ? '0x9858effd232b4033e47d90003d41ec34ecaeda94' : ''),
}))

// The page record: empty, or a record with the key (race.idb). Storage reads follow the same switch.
jest.mock('@/services/beamio', () => ({
	setPageWritePermit: () => undefined, // 0.53.44: the session write gate (AppEntryGate); stub here
	allowRestoreWrite: () => undefined,
  endRestoreWriteWindow: () => undefined,
	...jest.requireActual('@/services/beamio'),
	checkStorageWithStatusWithTimeout: async () => ({ status: 'empty' }), // 0.53.39: jsdom has no IndexedDB; the page copy is confirmed empty unless the test sets it
	checkStorage: async () => null,
	checkStorageWithTransientRetry: async () => {
		const answer: { status: string; data?: unknown; reason?: string } =
			race.idb === 'key' || (race as { writeBack?: boolean }).writeBack === true
				? { status: 'loaded', data: { profiles: [{ keyID: EOA, isPrimary: true }], mnemonicPhrase: PAGE_PHRASE } }
				: race.idb === 'unknown'
					? { status: 'unavailable', reason: 'timeout' }
					: race.idb === 'locked'
						? { status: 'locked' }
						: { status: 'empty' }
		// recorded as the reducer received it: a read error is `page-error`, never `page-empty` (spec 57(5))
		mockTrail.arrivals.push(answer.status === 'unavailable' ? 'page-error' : `page-${answer.status}`)
		return answer
	},
	sendPendingProfileSync: jest.fn(),
	wipeLocalWalletForRestore: async () => {
		race.wipes += 1
		race.writes.push('wipeLocalWalletForRestore')
	},
	getUserInfo: async () => ({ accountName: 'synthtag' }),
	getUserInfoLookup: async () => ({ status: 'ok', info: { accountName: 'synthtag' } }),
	storeSystemData: async () => {
		race.writes.push('storeSystemData')
	},
	// the pre-read write-back (page IndexedDB, read back): jsdom cannot open the device-key vault; counted, and the page then reads its own record
	persistPageIdbMnemonic: async () => {
		race.writes.push('persistPageIdbMnemonic')
		;(race as { writeBack?: boolean }).writeBack = true
		return 'verified'
	},
	storeSystemDataAndWait: async () => {
		race.writes.push('storeSystemDataAndWait')
		// after a write-back the page store reads its own record (the pre-read route syncs after the home)
		;(race as { writeBack?: boolean }).writeBack = true
		return true
	},
	readStoredRecordForVerify: async () => ({ mnemonicPhrase: PAGE_PHRASE }),
	ensureProfilePrivateKeyArmorFromMnemonic: (x: unknown) => x,
	bootstrapProfileLocaleCurrencyIfUnset: async (x: unknown) => x,
	readWalletRecordForOnboardingGate: async () => null,
	checkStorageWithStatus: async () => ({ status: 'empty' }),
	postBeamio: async () => true,
	createOrGetWallet: jest.fn(),
	resolveSigningPrivateKeyArmor: () => '',
}))
jest.mock('@/utils/consumerWalletGate', () => ({
	...jest.requireActual('@/utils/consumerWalletGate'),
	hasLocalSigningMaterial: () => race.idb === 'key',
	hasValidMnemonic: () => race.idb === 'key',
	validMnemonicEoa: () => (race.idb === 'key' || (race as { writeBack?: boolean }).writeBack === true ? EOA : ''),
	hasCompletedBeamioAccount: () => race.idb === 'key',
	pageWalletRecoverNeeded: () => false,
	hasLocalPlaintextMnemonic: () => false,
	isTrustedEmptyWalletBlob: () => false,
}))
// jsdom cannot derive a wallet (its Uint8Array is another realm than ethers'); the derivation is covered in the node tests.
jest.mock('@/services/shellSessionSigner', () => ({ ...jest.requireActual('@/services/shellSessionSigner'), holdShellSessionFromPhrase: () => ({ kind: 'ok' }) }))
jest.mock('@/services/recoveredMnemonicRecord', () => ({ ...jest.requireActual('@/services/recoveredMnemonicRecord'), checkRecoveredRecord: () => 'valid' }))
// jsdom cannot run the BIP-39 checksum (ethers Mnemonic); the word-shape check is the app's, the derivation is stubbed in renderApp
jest.mock('@/services/walletCredential', () => ({ ...jest.requireActual('@/services/walletCredential'), isMnemonicPhrase: (v: unknown) => typeof v === 'string' && /^[a-z]+( [a-z]+)*$/.test(v) && [12, 24].includes(v.split(' ').length) }))
// Spec r2.4 item 42(2): the start-up pre-read answers valid / absent / unknown. The race's native state is mapped to that answer.
const SAMPLE_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
jest.mock('@/services/nativeWallet', () => ({
	NATIVE_WALLET_READY_EVENT: 'beamio:native-wallet-ready',
	notifyNativeWalletReady: jest.fn(),
	publicWalletSeed: () => ({ profiles: [], beamio: undefined, isReady: true }),
	reachNativeWallet: async () => {
		race.reachCalls += 1
		return race.native
	},
	rememberNativeEoa: jest.fn(),
	takeInitRefusal: () => null,
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryOpen: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
	recoveryOpenErrorKey: () => '',
	nativeRecoveryCopyKey: () => null,
	queryNativeWalletState: async () => {
		race.walletStateCalls += 1
		return race.walletState
	},
	queryNativeWalletStatus: async () => {
		race.queryCalls += 1
		return race.native
	},
	queryNativeWalletStateSafe: async () => race.walletState,
	// 0.53.39: the start reads passcodeStatus (walletState and hasKey); the stub reports the same walletState and no key marker
	queryNativePasscodeStatus: async () => ({ walletState: race.walletState, hasKey: 'not_reported' as const }),
	// the real pre-read (its transport and inner timeouts); the native answer comes from the window host (prereadReply below)
	queryNativeMnemonicPreread: (...a: unknown[]) => (jest.requireActual('@/services/nativeRecovery') as { queryNativeMnemonicPreread: (...x: unknown[]) => unknown }).queryNativeMnemonicPreread(...a),
}))
/** The host's reply for the pre-read: the case's own override (race.preread), else the native state of the race (the same mapping as before). */
function prereadReply(): { kind: string; eoa?: string; phrase?: string } {
	const override = (race as { preread?: { kind: string; eoa?: string; phrase?: string } }).preread
	if (override) return override
	const n = race.native
	return n.status === 'locked'
		? { kind: 'locked' }
		: n.status === 'unlocked' || (n.status === 'not_ready' && n.notReadyReason === 'g1_uninitialized')
			? { kind: 'valid', eoa: SAMPLE_EOA, phrase: PAGE_PHRASE }
			: n.status === 'no_key'
				? { kind: 'absent' }
				: { kind: 'unknown' }
}
/** the window host the App's pre-read transport talks to (the App.nativeLateReply shape). The reply body is the native envelope of each kind. */
let hostOnMessage: ((ev: unknown) => void) | null = null
function installNativeHost(): void {
	const host = {
		postMessage: (text: string) => {
			const cmd = JSON.parse(text) as { type: string; reqId: number }
			if (cmd.type !== 'nativeMnemonicPreread') return
			// the pre-read is the start-up's native read: it takes the place of the walletStatus read (counted as reachCalls)
			race.reachCalls += 1
			const answer = prereadReply()
			mockTrail.arrivals.push(`pre-read-${answer.kind}`) // recorded as the reducer received it (RM-05..07 read these arrivals)
			const payload = answer.kind === 'valid'
				? { ok: true, result: { code: 'ok', mnemonic: answer.phrase, eoa: answer.eoa } }
				: answer.kind === 'absent'
					? { ok: true, result: { code: 'confirmed_missing' } }
					: answer.kind === 'locked'
						? { ok: false, error: 'locked' }
						: { ok: false, error: 'envelope_fail' }
			setTimeout(() => hostOnMessage?.({ data: JSON.stringify({ type: 'ack', reqId: cmd.reqId, ...payload }) }), 0)
		},
		get onmessage() { return hostOnMessage },
		set onmessage(fn: ((ev: unknown) => void) | null) { hostOnMessage = fn },
	}
	;(window as unknown as { BeamioShellRecord: unknown }).BeamioShellRecord = host
}
jest.mock('@/services/nativeIdentityPublic', () => ({
	...jest.requireActual('@/services/nativeIdentityPublic'),
	readNativeIdentityPublic: async () => ({ kind: 'no_key', kPresent: race.kPresent }),
}))
jest.mock('@/services/walletEoaAddress', () => ({ readWalletEoaAddress: async () => (race.eoa ? { kind: 'address', eoa: race.eoa } : { kind: 'refused', code: 'unavailable' }) }))
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: async () => null }))
// C1 pre-sync read: a present, unlocked native wallet (the sync is not held by the pre-check in these cases)
jest.mock('@/services/nativeKeyState', () => ({ ...jest.requireActual('@/services/nativeKeyState'), readNativeWalletStatus: async () => 'unlocked' }))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => { race.probeCalls += 1; return { answered: race.answered, capabilities: race.caps } } }))
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
jest.mock('@/components/PasscodeLockScreen', () => {
	const R = require('react')
	return () => R.createElement('div', null, 'PASSCODE_MARK')
})
jest.mock('@/components/EmbeddedPwaUpdateBanner', () => ({ EmbeddedPwaUpdateBanner: () => null }))
// The onboarding page is replaced by a marker, so the test reads whether the gate entered onboarding.
jest.mock('@/pages/Home/LoadingPage', () => {
	const R = require('react')
	const mockTrailRef = mockTrail
	// the stand-in creation entry (positive control for the role query in the recovery case): a real creation button sits here in onboarding.
	return (props: { home?: () => void }) => (mockTrailRef.onboardingRenders += 1, mockTrailRef.arrivals.push('onboarding'), R.createElement(R.Fragment, null,R.createElement('div', null, 'ONBOARDING_MARK'), R.createElement('button', { type: 'button', onClick: () => props.home?.() }, 'Create account')))
})
// the home page stand-in: a positive marker that /home rendered.
jest.mock('@/components/Home/Home', () => {
	const R = require('react')
	return () => (mockTrail.arrivals.push('home'), R.createElement('div', null, 'HOME_MARK'))
})
const { publishNativePwaLog } = require('@/utils/cashTreesNativePwaLog')

function renderApp() {
	installNativeHost()
	jest.spyOn(require('ethers').Wallet, 'fromPhrase').mockReturnValue({ address: SAMPLE_EOA } as never)
	return render(
		<DaemonProvider>
			<MemoryRouter initialEntries={['/home']}>
				<App />
			</MemoryRouter>
		</DaemonProvider>,
	)
}

const RETRY_TITLE = 'native_not_ready_retry_title'
const BOTH_CAPS = ['identity.native-keys.v1', 'identity.kpresent.v1']
// a write-back by an earlier case must not make the page store read as written in a later one
beforeEach(() => {
	;(race as { writeBack?: boolean }).writeBack = false
})

describe('account reset at the gate', () => {
	beforeEach(() => {
		race.reachCalls = 0
		race.answered = true
		race.shell = true
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.kPresent = false
		race.caps = [...BOTH_CAPS]
		race.eoa = EOA
		race.idb = 'empty'
	})

	// ST-01 / CP-06: two-sided confirmed none (both capabilities reported): onboarding; nothing else is shown.
	it('CP-06 and ST-01: no_key with kPresent false, both capabilities reported, IDB empty: onboarding opens', async () => {
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
		// positive control: the role query used by the recovery case finds the creation entry when onboarding is shown
		expect(screen.getByRole('button', { name: /create|get started|新建|创建/i })).toBeTruthy()
	})

	// A missing native-mnemonic read capability is unknown; an address or no_key status cannot prove that current/sealed phrases are absent.
	it('CP-04: identity missing, empty page, no native mnemonic read method: startup wait, never onboarding', async () => {
		race.caps = []
		race.kPresent = undefined
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.idb = 'empty'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('capability missing')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// CP-05 (Y.93 2c): native-keys reported, kpresent not reported: unknown, retry, no creation entry, never onboarding.
	it('CP-05: native-keys reported, kpresent not, the pre-read unknown: startup wait, no onboarding, no creation entry (spec r2.4 item 42(2)(3); the kPresent tier is not an answer of the pre-read)', async () => {
		race.caps = ['identity.native-keys.v1']
		race.kPresent = undefined
		race.native = { status: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('native_key_required_import')).toBeNull()
	})

	// PNK-04 supersedes the earlier case here: a no_key answer with kPresent true holds the native key. It is the recovery entry only:
	// never onboarding, never a creation entry.
	it('no_key with kPresent true and no mnemonic on either side: the pre-read says absent, so onboarding (spec r2.4 item 42(2)); the Y.151 PNK-04 recovery entry is superseded here and pending a rule', async () => {
		race.kPresent = true
		race.native = { status: 'no_key' }
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// A locked native read remains unknown; this gate does not infer account absence or open another unlock path.
	it('CP-01: native mnemonic pre-read locked: startup wait, not onboarding or home', async () => {
		race.native = { status: 'locked', eoa: EOA }
		race.walletState = 'locked'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('pre-read locked')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// CP-02: a storage-derived lock (not_ready, unreadable) is unknown: the startup wait (spec r2.4 item 42(3)).
	// Rewritten from "retry on the unavailable screen": unknown shows no error screen, no onboarding and no creation entry.
	it('CP-02: storage-derived lock (not_ready, unreadable) is unknown: startup wait, no error screen, no onboarding, no creation entry', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('Wallet storage is unavailable')).toBeNull()
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByRole('button', { name: /create/i })).toBeNull()
	})

	// CP-03: a browser with no native side and an empty IndexedDB: onboarding, the creation entry is allowed.
	it('CP-03: browser, fresh install (IDB empty, no native side): onboarding opens', async () => {
		race.shell = false
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
	})

	// ST-02: IDB has a valid mnemonic, native absent (no_key, kPresent false): the page account is the home (PWA first, spec 42(1)).
	// Rewritten from "storage hasAccount=true" (the superseded judgement log): the native side is not asked.
	it('ST-02: IDB has a valid mnemonic, native absent: the home on the page account, native not asked, no onboarding, no retry', async () => {
		race.idb = 'key'
		race.reachCalls = 0
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('page mnemonic is valid')), { timeout: 3000 })
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(race.reachCalls).toBe(0)
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	// ST-03: IDB empty, native has (a G1 wallet): continues on the public address (the local home), no onboarding, no deletion.
	it('ST-03: IDB empty, native has (G1): continues on the public address, no onboarding, no retry', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('local home')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	it('ST-03 (pre-read unknown, no public address to fall back on): startup wait, nothing guessed, never onboarding (spec r2.4 item 42(3))', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.eoa = null
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	// ST-05: both sides hold a wallet (the PGP record is not a basis): the valid page mnemonic is the one account, the home (spec 42(1)).
	it('ST-05: both sides hold the wallet: the home on the valid page mnemonic, native not asked, no onboarding, no retry', async () => {
		race.idb = 'key'
		race.reachCalls = 0
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		renderApp()
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(race.reachCalls).toBe(0)
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})

	it('unreadable native wallet (not_ready, unreadable) with no walletState: retry, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		renderApp()
		await act(async () => { await Promise.resolve() })
		await waitFor(() => expect(screen.queryByText('ONBOARDING_MARK')).toBeNull(), { timeout: 3000 })
	})
})

// Y.163 (r7): iOS not_ready + unreadable goes silently to the PWA onboarding with nothing written; a usable
// wallet leaves it for /home. g1_uninitialized is not intercepted here. The create entry is unchanged (A-3 revoked). No picker.
const NATIVE_RESTORE_TITLE = 'native_restore_title'

async function idbSnapshot(): Promise<string> {
	const list = (await indexedDB.databases()).filter((d) => d.name).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
	const out: unknown[] = []
	for (const info of list) {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const r = indexedDB.open(info.name as string)
			r.onsuccess = () => resolve(r.result)
			r.onerror = () => reject(r.error)
		})
		const stores: Record<string, unknown> = {}
		for (const name of Array.from(db.objectStoreNames).sort()) {
			stores[name] = await new Promise((resolve, reject) => {
				const req = db.transaction(name, 'readonly').objectStore(name).getAll()
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(req.error)
			})
		}
		out.push({ name: info.name, version: db.version, stores })
		db.close()
	}
	return JSON.stringify(out)
}
const POPUP_TITLES = ['Native wallet is not ready', NATIVE_RESTORE_TITLE]
function snapshot(): string {
	// the shell transport's request counter (beamio.shellTxSeq.v1) advances with every native request, the pre-read included; it is not user data
	const local = Object.keys(window.localStorage).filter((k) => !k.startsWith('beamio.shellTxSeq.')).sort().map((k) => [k, window.localStorage.getItem(k)])
	return JSON.stringify({ local, idb: race.idb, eoa: race.eoa, writes: race.writes, wipes: race.wipes })
}
describe('Y.163: silent entry, no picker, no popup, data kept (iOS)', () => {
	beforeEach(() => {
		;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = {}
		window.localStorage.setItem('y163.sentinel', 'keep-me')
		race.wipes = 0
		race.writes = []
		race.queryCalls = 0
	})
	afterEach(() => {
		delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
		window.localStorage.removeItem('y163.sentinel')
	})

	it('1. single wallet: the readable wallet enters /home (positive), no onboarding, no popup', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'unlocked', eoa: EOA }
		race.walletState = 'present'
		race.idb = 'key'
		renderApp()
		await waitFor(() => expect(screen.getByText('HOME_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
		expect(screen.queryByText(/native_pick_account/)).toBeNull()
	}, 15000)

	it('2. several wallets (gate level: the native answer is already readable): /home (positive), no picker, no popup', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'unlocked', eoa: EOA }
		race.walletState = 'present'
		race.idb = 'key'
		renderApp()
		await waitFor(() => expect(screen.getByText('HOME_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
		expect(screen.queryByText(/native_pick_account/)).toBeNull()
	}, 15000)

	// Rewritten for the current rule (spec 42(2)(3)): an unreadable native answer with no valid page mnemonic is unknown. It is the startup
	// wait: no popup, no onboarding, nothing written or cleared. The earlier "silent onboarding" (r7) is superseded by that rule.
	it('3. unreadable (not_ready), page confirmed empty: startup wait, no popup, no onboarding, and the data snapshot is identical before and after', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		const before = snapshot()
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		await new Promise((r) => setTimeout(r, 300))
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
		expect(screen.queryByText(/Native wallet is not ready/)).toBeNull()
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(snapshot()).toBe(before)
		expect(race.wipes).toBe(0)
	}, 15000)

	it('4. g1_uninitialized is not intercepted by the unreadable rule: no onboarding from it', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		race.walletState = 'not_ready'
		race.idb = 'key'
		renderApp()
		await new Promise((r) => setTimeout(r, 400))
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText(/native_pick_account/)).toBeNull()
	}, 15000)

	// Rewritten for the current rule: the startup wait is left for the home when a usable native wallet arrives (the ready event).
	it('5. unreadable startup wait, then a usable wallet (ready event): the home', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		race.native = { status: 'unlocked', eoa: EOA }
		race.walletState = 'present'
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await waitFor(() => expect(screen.getByText('HOME_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	}, 15000)

	it('6. confirmed no account (no_key, no page key): onboarding with create entry, nothing written', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.kPresent = false
		race.idb = 'empty'
		renderApp()
		await waitFor(() => expect(screen.getByText('ONBOARDING_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.getByText('Create account')).toBeTruthy()
		expect(race.wipes).toBe(0)
		expect(window.localStorage.getItem('y163.sentinel')).toBe('keep-me')
	}, 15000)

	// Rewritten for the current rule: a ready event while the native side is still unreadable keeps the startup wait (no popup, no onboarding).
	it('7. ready event while still unreadable: no popup, still the startup wait (no onboarding, no status screen), nothing written', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		const before = snapshot()
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await new Promise((r) => setTimeout(r, 300))
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(snapshot()).toBe(before)
	}, 15000)
	// Rewritten for the current rule: the startup wait re-reads on its interval until a definite answer. The re-read is a read: 60 s of
	// fake time writes nothing, shows no popup and never onboards.
	/** Moves the fake clock in 100 ms steps; each step settles the microtask queue first (the gate awaits before it sends a request). */
	const tick = async (ms: number) => {
		for (let i = 0; i < ms / 100; i += 1) {
			await act(async () => {
				for (let k = 0; k < 20; k += 1) await Promise.resolve()
				jest.advanceTimersByTime(100)
			})
		}
	}
	it('8. the startup wait re-reads on its interval: 60 s of fake time reads only (no write, no onboarding, no popup)', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		// fake timers before the render, so the wait's timer is created on them
		jest.useFakeTimers()
		try {
			renderApp()
			// the host answers on a timer (the real transport), and the first unknown is re-asked after 750 ms: one second covers both answers
			// the host answers on the fake clock: each 100 ms step settles the microtask chain (the gate's awaits before a request) first
			await tick(2_000)
			expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait'))
			const before = snapshot()
			const reachBefore = race.reachCalls
			for (let i = 0; i < 60; i += 1) {
				await tick(1_000)
			}
			await act(async () => {
				await Promise.resolve()
			})
			expect(race.reachCalls).toBeGreaterThan(reachBefore)
			expect(snapshot()).toBe(before)
			expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
			expect(race.wipes).toBe(0)
		} finally {
			jest.useRealTimers()
		}
	}, 15000)

	it('9. g1_uninitialized: the one init (inside reach) answers ready, then /home (positive)', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		race.walletState = 'not_ready'
		race.idb = 'key'
		renderApp()
		await new Promise((r) => setTimeout(r, 300))
		// the native init succeeded: the next answer is unlocked on the public address
		race.native = { status: 'unlocked', eoa: EOA }
		race.walletState = 'present'
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		await waitFor(() => expect(screen.getByText('HOME_MARK')).toBeTruthy(), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
	}, 15000)

	// Rewritten for the current rule (spec 42(1)): a valid page mnemonic is the one current account, the home. The native not_ready answer
	// is not compared with it and shows no status screen.
	it('10. walletState present with a not-ready native answer and a valid page mnemonic: the home, no status screen, no popup', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		race.walletState = 'present'
		race.idb = 'key'
		renderApp()
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(screen.queryByText(/Native wallet is not ready/)).toBeNull()
		POPUP_TITLES.forEach((t) => expect(screen.queryByText(t)).toBeNull())
	}, 15000)
	// Rewritten for the current rule: the startup wait (native unreadable, page confirmed empty) writes nothing to the device database.
	it('11. real IndexedDB snapshot: the startup wait writes nothing to the device database (before and after compared)', async () => {
		// fake-indexeddb (jest only) is installed for this test alone; the other tests keep indexedDB absent, as before.
		const { IDBFactory } = require('fake-indexeddb') as typeof import('fake-indexeddb')
		const previous = (globalThis as unknown as { indexedDB?: unknown }).indexedDB
		// jsdom has no structuredClone; fake-indexeddb needs one for the stored records
		const previousClone = (globalThis as unknown as { structuredClone?: unknown }).structuredClone
		;(globalThis as unknown as { structuredClone: unknown }).structuredClone = (v: unknown) => require('node:v8').deserialize(require('node:v8').serialize(v))
		;(globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory()
		try {
		const DB = 'beamio-snapshot-fixture'
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.open(DB, 1)
			r.onblocked = () => reject(new Error('blocked'))
			r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' })
			r.onsuccess = () => {
				const db = r.result
				let tx: IDBTransaction
				try {
					tx = db.transaction('docs', 'readwrite')
				} catch (e) {
					reject(new Error('tx: ' + String(e) + ' stores=' + Array.from(db.objectStoreNames).join(',')))
					return
				}
				tx.objectStore('docs').put({ id: 'init', data: 'seed-init' })
				tx.objectStore('docs').put({ id: 'meta', data: 'seed-meta' })
				tx.oncomplete = () => {
					db.close()
					resolve()
				}
				tx.onerror = () => reject(tx.error)
			}
			r.onerror = () => reject(r.error)
		})
		const before = await idbSnapshot()
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		await new Promise((r) => setTimeout(r, 200))
		const after = await idbSnapshot()
		expect(after).toBe(before)
		expect(before).toContain('seed-init')
		} finally {
			;(globalThis as unknown as { indexedDB?: unknown }).indexedDB = previous
			;(globalThis as unknown as { structuredClone?: unknown }).structuredClone = previousClone
		}
	}, 15000)


	// Rewritten for the current rule: a device hint is never evidence. With no valid page mnemonic and an unreadable native side the answer is
	// unknown: the startup wait, never the home and never onboarding.
	it('12. a device hint alone (no valid mnemonic, native unreadable): the startup wait, never the home, never onboarding', async () => {
		window.localStorage.setItem('beamio.shellPublicEoa.v1', EOA)
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		race.walletState = 'not_ready'
		race.idb = 'empty'
		try {
			renderApp()
			await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
			expect(screen.queryByText('HOME_MARK')).toBeNull()
			expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		} finally {
			window.localStorage.removeItem('beamio.shellPublicEoa.v1')
		}
	}, 15000)

	it('13. a valid mnemonic on the page (native unlocked): the home, with the mnemonic EOA as the evidence', async () => {
		race.answered = true
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'unlocked', eoa: EOA }
		race.walletState = 'present'
		race.idb = 'key'
		renderApp()
		await waitFor(() => expect(screen.getByText('HOME_MARK')).toBeTruthy(), { timeout: 3000 })
	}, 15000)

})

// Per spec r2.4 item 42(3): PWA unknown is the startup wait. The native side is not asked at all.
describe('ST-07: PWA unknown does not ask the native side', () => {
	beforeEach(() => {
		race.reachCalls = 0
		race.queryCalls = 0
		race.walletStateCalls = 0
		race.probeCalls = 0
		race.answered = true
		race.shell = true
		race.caps = [...BOTH_CAPS]
		race.kPresent = false
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.eoa = EOA
		race.idb = 'empty'
	})

	it('ST-07: the page read is unknown (timeout): startup wait, no native ask, no onboarding, no home, no screen', async () => {
		race.idb = 'unknown'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		await new Promise((r) => setTimeout(r, 200))
		expect(race.reachCalls).toBe(0)
		expect(race.queryCalls).toBe(0)
		expect(race.walletStateCalls).toBe(0)
		expect(race.probeCalls).toBe(0)
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(screen.queryByText('Wallet storage is unavailable')).toBeNull()
		expect(screen.queryByText(RETRY_TITLE)).toBeNull()
	})
})

// QA boot markers and the sync call points (spec 44). The markers come through publishNativePwaLog.
describe('boot markers and the shell sync (QA only)', () => {
	const { setShellMnemonicSyncBridge } = require('@/services/shellMnemonicSync') as typeof import('@/services/shellMnemonicSync')
	const labels = (): string[] =>
		(publishNativePwaLog as jest.Mock).mock.calls
			.map((c: unknown[]) => String(c[1]))
			.filter((m) => m.startsWith('[BeamioBoot]'))
			.map((m) => {
				const hit = /\] (screen|sync)=(\w+)/.exec(m)
				return hit ? `${hit[1]}=${hit[2]}` : m
			})
	beforeEach(() => {
		process.env.REACT_APP_BEAMIO_BOOT_TRACE = 'true'
		race.reachCalls = 0
		race.queryCalls = 0
		race.walletStateCalls = 0
		race.answered = true
		race.shell = true
		race.caps = [...BOTH_CAPS]
		race.kPresent = false
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.eoa = EOA
		race.idb = 'empty'
		;(race as { writeBack?: boolean }).writeBack = false
		setShellMnemonicSyncBridge(async () => 'ok' as const)
	})
	afterEach(() => {
		delete process.env.REACT_APP_BEAMIO_BOOT_TRACE
		setShellMnemonicSyncBridge(null)
	})

	it('PWA has a valid mnemonic: splash -> home -> sync=send -> sync=reply (the home does not wait for the sync)', async () => {
		race.idb = 'key'
		renderApp()
		await waitFor(() => expect(labels()).toContain('sync=reply'), { timeout: 3000 })
		expect(labels()).toEqual(['screen=splash', 'screen=home', 'sync=send', 'sync=reply'])
		// the markers never carry the phrase or the EOA
		const all = (publishNativePwaLog as jest.Mock).mock.calls.map((c: unknown[]) => String(c[1])).join('\n')
		expect(all).not.toContain('abandon')
		expect(all.toLowerCase()).not.toContain(EOA.toLowerCase())
	})

	it('onboarding success: splash -> onboarding -> home -> sync=send -> sync=reply, the sync starts after the home', async () => {
		renderApp()
		expect(await screen.findByText('ONBOARDING_MARK', {}, { timeout: 3000 })).toBeTruthy()
		race.idb = 'key'
		await act(async () => {
			screen.getByRole('button', { name: 'Create account' }).click()
		})
		await waitFor(() => expect(labels()).toContain('sync=reply'), { timeout: 3000 })
		expect(labels()).toEqual(['screen=splash', 'screen=onboarding', 'screen=home', 'sync=send', 'sync=reply'])
	})

	it('native pre-read valid (shell restore): splash -> home -> sync=send -> sync=reply, the sync is sent once and only after the home', async () => {
		const send = jest.fn(async () => 'ok' as const)
		setShellMnemonicSyncBridge(send)
		race.idb = 'empty'
		race.native = { status: 'unlocked', eoa: EOA }
		renderApp()
		await waitFor(() => expect(labels()).toContain('sync=reply'), { timeout: 3000 })
		expect(labels()).toEqual(['screen=splash', 'screen=home', 'sync=send', 'sync=reply'])
		expect(send).toHaveBeenCalledTimes(1)
	})
})

// rule (a), 2026-11-16 (spec r2.4 item 42(5), §25.29.5): without identity.native-keys.v1 the walletStatus route stays. Only an explicit
// native `no_key` enters the onboarding. unknown (read failure or timeout), not_ready and a contradicting walletState stay in the start-up
// state. rule (c): a native locked answer never routes to the onboarding. rule (f): the ready event does not route while the hello is
// unanswered (no hello backoff is read by the ready path).
describe('walletStatus route without identity.native-keys.v1 ((c), (f))', () => {
	beforeEach(() => {
		race.reachCalls = 0
		race.answered = true
		race.shell = true
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.kPresent = undefined
		race.caps = []
		race.eoa = EOA
		race.idb = 'empty'
		;(race as { preread?: unknown }).preread = undefined
	})

	it('a1: native unknown (a read failure or a timeout), capability missing: start-up wait, never onboarding', async () => {
		race.native = { status: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('capability missing')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(screen.queryByRole('button', { name: /create/i })).toBeNull()
	})

	it('a2: native not_ready (g1_uninitialized) with walletState absent, capability missing: start-up wait, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'g1_uninitialized' }
		race.walletState = 'absent'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('capability missing')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
	})

	it('a3: native not_ready (unreadable), capability missing: start-up wait, never onboarding', async () => {
		race.native = { status: 'not_ready', notReadyReason: 'unreadable' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByRole('button', { name: /create/i })).toBeNull()
	})

	it('a4: native no_key but walletState reports present (the two answers contradict), capability missing: start-up wait, never onboarding', async () => {
		race.native = { status: 'no_key' }
		race.walletState = 'present'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('capability missing')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	it('a5: native no_key without the mnemonic read capability remains unknown, never onboarding', async () => {
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('capability missing')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	// M4 (R70 item 2; spec 42(2) and 57(6)). The page store is locked, so its answer is unknown and it is not a confirmed empty page. The native
	// side is not asked and the start waits; the onboarding must not open. A locked store is `unknown` with `locked: true`, which reaches
	// the pageEvidence branch only past the earlier `unknown && !locked` return. Mutation M4 (that branch enters the onboarding) fails here.
	it('M4: page store locked (pageEvidence unknown), native no_key and walletState absent: start-up wait, never onboarding, native side not asked', async () => {
		// the onboarding counter is shared by the cases above in this file: start this case from zero
		mockTrail.onboardingRenders = 0
		mockTrail.arrivals.length = 0
		race.idb = 'locked'
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.caps = [...BOTH_CAPS]
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('page mnemonic unknown')), { timeout: 3000 })
		expect(mockTrail.onboardingRenders).toBe(0)
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(race.reachCalls).toBe(0)
		expect(race.walletStateCalls).toBe(0)
	})

	it('c1 (r11 LK-P1): native locked, capability missing: no local home on a locked wallet (unknown), never onboarding', async () => {
		race.native = { status: 'locked', eoa: EOA }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('HOME_MARK')).toBeNull()
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	it('c2: native locked, capability declared, the pre-read unknown: start-up wait, never onboarding', async () => {
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'locked', eoa: EOA }
		;(race as { preread?: unknown }).preread = { kind: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('PASSCODE_MARK')).toBeNull()
	})

	it('f1: ready event while the hello is unanswered, after a start-up wait: no onboarding, the start-up state stays', async () => {
		race.caps = [...BOTH_CAPS]
		race.native = { status: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		race.answered = false
		race.native = { status: 'no_key' }
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
			await new Promise((resolve) => setTimeout(resolve, 50))
		})
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
	})
})

// rule r2.5.11 (spec 57(6), C-3, C-5; vectors RM-05, RM-06, RM-07): the whole start-up trajectory never enters the onboarding, at any
// moment, whichever order the shell's record error and the native pre-read arrive in. An error is never read as confirmed "no account".
describe('start-up trajectory, record error and pre-read in either order (RM-05, RM-06, RM-07)', () => {
	const { requestNativeIdentityRetry } = require('@/services/nativeIdentityProbeRetry') as typeof import('@/services/nativeIdentityProbeRetry')
	const preread = (value: unknown) => {
		;(race as { preread?: unknown }).preread = value
	}
	const PREREAD_VALID = { kind: 'valid', eoa: SAMPLE_EOA, phrase: PAGE_PHRASE }
	beforeEach(() => {
		race.reachCalls = 0
		race.answered = true
		race.shell = true
		race.native = { status: 'no_key' }
		race.walletState = 'absent'
		race.kPresent = undefined
		race.caps = [...BOTH_CAPS]
		race.eoa = EOA
		race.idb = 'empty'
		;(race as { writeBack?: boolean }).writeBack = false
		mockTrail.onboardingRenders = 0
		preread(undefined)
	})

	// RM-05: the record error arrives first (the page read is unknown, a start-up wait), then the native pre-read is valid.
	it('RM-05: record error before the pre-read valid: never the onboarding, the home on the pre-read account, and the error is not confirmed none', async () => {
		race.idb = 'unknown'
		preread(PREREAD_VALID)
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(mockTrail.onboardingRenders).toBe(0)
		// the record reads again as empty; the native pre-read is valid: the same account enters the home
		race.idb = 'empty'
		await act(async () => {
			requestNativeIdentityRetry()
		})
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(mockTrail.onboardingRenders).toBe(0)
		expect(publishNativePwaLog).not.toHaveBeenCalledWith('info', expect.stringContaining('native pre-read absent'))
	})

	// RM-06: the pre-read is valid first and the home opens; the record error arrives afterwards and is handled as an event, not a route.
	it('RM-06: record error after the pre-read valid: never the onboarding at any moment, the home stays, and the error is not confirmed none', async () => {
		preread(PREREAD_VALID)
		renderApp()
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(mockTrail.onboardingRenders).toBe(0)
		;(race as { writeBack?: boolean }).writeBack = false
		race.idb = 'unknown'
		await act(async () => {
			requestNativeIdentityRetry()
		})
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(mockTrail.onboardingRenders).toBe(0)
		expect(publishNativePwaLog).not.toHaveBeenCalledWith('info', expect.stringContaining('native pre-read absent'))
	})

	// RM-07 (negative control, spec 57(5) and 57(6)). REWRITTEN (R70 item 1): the check reads the arrivals that the real start-up reducer
	// recorded (mockTrail.arrivals), not hand-written arrays. An onboarding arrival is legal only after the page is confirmed empty AND the
	// native pre-read is confirmed absent. A variant that reads an error as "no account" (mutation M5 in the R70 list) puts an onboarding
	// arrival without that confirmation into the recorded trail; the check flags it and RM-07 fails. Self-test: with M5 applied to the
	// source, both orders fail (receipt, mutation log).
	const onboardingWithoutConfirmedNone = (trail: string[]): boolean => {
		let pageEmpty = false
		let prereadAbsent = false
		for (const arrival of trail) {
			if (arrival === 'page-empty') pageEmpty = true
			else if (arrival === 'pre-read-absent') prereadAbsent = true
			else if (arrival === 'onboarding' && !(pageEmpty && prereadAbsent)) return true
		}
		return false
	}

	// RM-07a: the record error arrives first (the page read errors, a start-up wait), then the native pre-read is valid.
	it('RM-07a (error first): the recorded trail reaches the home, the error comes first, and no onboarding arrival without a confirmed none', async () => {
		mockTrail.arrivals.length = 0
		race.idb = 'unknown'
		preread(PREREAD_VALID)
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		race.idb = 'empty'
		await act(async () => {
			requestNativeIdentityRetry()
		})
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		const trail = [...mockTrail.arrivals]
		expect(trail.indexOf('page-error')).toBeGreaterThanOrEqual(0)
		expect(trail.indexOf('page-error')).toBeLessThan(trail.indexOf('pre-read-valid'))
		expect(trail.indexOf('pre-read-valid')).toBeLessThan(trail.indexOf('home'))
		expect(onboardingWithoutConfirmedNone(trail)).toBe(false)
	})

	// RM-07b: the pre-read is valid first and the home opens; the record error arrives afterwards.
	it('RM-07b (error after): the recorded trail reaches the home first, the error follows it, and no onboarding arrival without a confirmed none', async () => {
		mockTrail.arrivals.length = 0
		preread(PREREAD_VALID)
		renderApp()
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		;(race as { writeBack?: boolean }).writeBack = false
		race.idb = 'unknown'
		await act(async () => {
			requestNativeIdentityRetry()
		})
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		const trail = [...mockTrail.arrivals]
		expect(trail.indexOf('pre-read-valid')).toBeLessThan(trail.indexOf('home'))
		expect(trail.indexOf('home')).toBeLessThan(trail.lastIndexOf('page-error'))
		expect(onboardingWithoutConfirmedNone(trail)).toBe(false)
	})
})
