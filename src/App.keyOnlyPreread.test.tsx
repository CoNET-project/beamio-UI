/**
 * Runtime check of the key_only entry: walletStatus not_ready + key_only with the pre-read absent → onboarding,
 * unknown → startup wait, valid → home. Harness copied from App.accountReset.test.tsx. SYNTHETIC values only.
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
	| { status: 'not_ready'; notReadyReason: 'unreadable' | 'g1_uninitialized' | 'key_only' }
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
	answered: boolean
	wipes: number
	writes: string[]
	queryCalls: number
} = { shell: true, native: { status: 'no_key' }, walletState: 'absent', kPresent: false, caps: ['identity.native-keys.v1', 'identity.kpresent.v1'], eoa: EOA, idb: 'empty', walletStateCalls: 0, reachCalls: 0, answered: true, wipes: 0, writes: [], queryCalls: 0 }
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
// steps 1 and 2: a shell start reads the old PWA store (PouchDB "init") first. This file keeps that store absent (its page record is
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

// step 6: the page sync checks the phrase's derivation; jsdom has no WebCrypto for BIP-39 derivation, so the test derivation is the
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
// Spec item 42(2): the start-up pre-read answers valid / absent / unknown. The race's native state is mapped to that answer.
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
	queryNativeMnemonicPreread: async () => {
		// the pre-read is the start-up's native read: it takes the place of the walletStatus read (counted as reachCalls)
		race.reachCalls += 1
		const override = (race as { preread?: { kind: string } }).preread
		const n = race.native
		const answer: { kind: string; eoa?: string; phrase?: string } = override
			? override
			: n.status === 'locked' || n.status === 'unlocked' || (n.status === 'not_ready' && n.notReadyReason === 'g1_uninitialized')
				? { kind: 'valid', eoa: SAMPLE_EOA, phrase: PAGE_PHRASE }
				: n.status === 'no_key'
					? { kind: 'absent' }
					: { kind: 'unknown' }
		// recorded as the reducer received it (RM-05..07 read these arrivals)
		mockTrail.arrivals.push(`pre-read-${answer.kind}`)
		return answer
	},
}))
jest.mock('@/services/nativeIdentityPublic', () => ({
	...jest.requireActual('@/services/nativeIdentityPublic'),
	readNativeIdentityPublic: async () => ({ kind: 'no_key', kPresent: race.kPresent }),
}))
jest.mock('@/services/walletEoaAddress', () => ({ readWalletEoaAddress: async () => (race.eoa ? { kind: 'address', eoa: race.eoa } : { kind: 'refused', code: 'unavailable' }) }))
jest.mock('@/utils/ephemeralCouponClaimWallet', () => ({ ensureEphemeralWalletForCouponClaim: async () => null }))
jest.mock('@/services/shellChatCapability', () => ({ ...jest.requireActual('@/services/shellChatCapability'), ensureShellChatState: async () => 'native_chat', shellChatBlockedNow: () => false }))
jest.mock('@/services/nativeChatRouteRegister', () => ({ ...jest.requireActual('@/services/nativeChatRouteRegister'), probeNativeCapabilities: async () => ({ answered: race.answered, capabilities: race.caps }) }))
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

describe('key_only entry: the pre-read decides', () => {
	beforeEach(() => {
		race.reachCalls = 0
		race.answered = true
		race.shell = true
		race.native = { status: 'not_ready', notReadyReason: 'key_only' }
		race.walletState = 'absent'
		race.kPresent = false
		race.caps = [...BOTH_CAPS]
		race.eoa = EOA
		race.idb = 'empty'
		;(race as { preread?: unknown }).preread = undefined
	})

	// 0.53.39 tightening: onboarding needs an explicit walletStatus no_key. This case answers not_ready, so the
	// start waits with the reason status_not_no_key (startup wait, retry offered), and it does not onboard.
	it('key_only with the pre-read absent (page confirmed empty): no onboarding; the start waits (walletStatus not no_key)', async () => {
		;(race as { preread?: unknown }).preread = { kind: 'absent' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('reason=status_not_no_key')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
	})

	it('key_only with the pre-read unknown: startup wait, no onboarding, no home', async () => {
		;(race as { preread?: unknown }).preread = { kind: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
	})

	it('key_only with the pre-read valid: the home on the pre-read account, no onboarding', async () => {
		;(race as { preread?: unknown }).preread = { kind: 'valid', eoa: SAMPLE_EOA, phrase: PAGE_PHRASE }
		renderApp()
		expect(await screen.findByText('HOME_MARK', {}, { timeout: 3000 })).toBeTruthy()
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
	})

	it('key_only, the pre-read unknown first, then absent on the ready event: onboarding (the ready path runs the init route)', async () => {
		;(race as { preread?: unknown }).preread = { kind: 'unknown' }
		renderApp()
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('warn', expect.stringContaining('startup wait')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		;(race as { preread?: unknown }).preread = { kind: 'absent' }
		await act(async () => {
			window.dispatchEvent(new Event('beamio:native-wallet-ready'))
		})
		// 0.53.39 tightening: the ready event runs the init route; walletStatus is still not_ready (not no_key), so the start waits
		// with status_not_no_key and does not onboard (see the key_only case above).
		await waitFor(() => expect(publishNativePwaLog).toHaveBeenCalledWith('info', expect.stringContaining('reason=status_not_no_key')), { timeout: 3000 })
		expect(screen.queryByText('ONBOARDING_MARK')).toBeNull()
		expect(screen.queryByText('HOME_MARK')).toBeNull()
	})
})
