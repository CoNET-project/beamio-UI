/**
 * 全应用入口门闸：本地未完成 Beamio 初始化（与 pages/Home/index 原逻辑一致）时，
 * 先 Splash + BeamioOnboardingModal，任意深层路由（/wallet、/Chat 等）均不可跳过。
 */
import { useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useDaemonContext } from '@/providers/DaemonProvider'
import { checkStorageWithTransientRetry, sendPendingProfileSync } from '@/services/beamio'
import { storageUnavailableRoute } from '@/services/storageRoute'
import { registerPendingSender } from '@/services/pendingServerSync'
import { resumeDeferredWrite } from '@/services/shellRecordStore'
import { installNativeNoKeyWatcher, openNativeKeyImport } from '@/services/nativeKeyState'
import { AppEntryNoKeyController } from './appEntryNoKeyController'
import { NATIVE_WALLET_ESTABLISHED_EVENT } from '@/services/nativeWalletEstablished'
import { NATIVE_FLOW_PENDING_EVENT } from '@/services/nativeFlowPending'
import { startPgpMigrationOnce } from '@/services/pgpMigrationRunner'
import NativeKeyImportRequired from '@/components/NativeKeyImportRequired'
import { ensureShellChatState } from '@/services/shellChatCapability'
import { beamioTagCreateNeeded, idbSignalOf, judgeBrowser, judgeShellFromNative, type NativeWalletState, type NativeWalletStatus } from '../services/accountJudgement'
import { queryNativeWalletState } from '../services/nativeRecovery'
import { identityCapabilityFrom, shellEntryFor } from '@/services/shellEntryDecision'
import { probeNativeCapabilities } from '@/services/nativeChatRouteRegister'
import { IDENTITY_CAPABILITY_MISSING } from '@/services/bridgeGuard'
import { NATIVE_WALLET_READY_EVENT, notifyNativeWalletReady, publicWalletSeed, reachNativeWallet, rememberNativeEoa } from '@/services/nativeWallet'
import { setCoNET_Data } from '@/utils/globals'
import PasscodeLockScreen from '@/components/PasscodeLockScreen'
import { VAULT_LOCKED_EVENT } from '@/services/walletVaultEvents'
import SplashScreen from '@/components/SplashScreen'
import { EmbeddedPwaUpdateBanner } from '@/components/EmbeddedPwaUpdateBanner'
import BeamioOnboardingModal from '@/pages/Home/LoadingPage'
import { isCashTreesNativeWebView } from '@/utils/cashTreesNativeNfc'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import {
	hasCompletedBeamioAccount,
	hasLocalPlaintextMnemonic,
	hasLocalSigningMaterial,
	isTrustedEmptyWalletBlob,
	pageWalletRecoverNeeded,
} from '@/utils/consumerWalletGate'
import { isShellContext } from '@/services/shellContext'
import { nativeStoreWaitDelayMs, splashDeadlineAction } from '@/services/shellStoreWait'
import { nativeRecoveryCopyKey, nativeRecoveryOpen, onNativeRecoveryResult, recoveryOpenErrorKey } from '@/services/nativeRecovery'
import { announceNativeWalletEstablished } from '@/services/nativeWalletEstablished'
import { tu } from '@/locale/beamioLocale'
import { ensureEphemeralWalletForCouponClaim } from '@/utils/ephemeralCouponClaimWallet'
import { BEAMIO_WALLET_READY_EVENT, dispatchBeamioWalletReady } from '@/utils/beamioWalletReadyEvent'

const SPLASH_FORCE_DISMISS_MS = 12_000
const EPHEMERAL_WALLET_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			window.setTimeout(() => resolve(fallback), ms)
		}),
	])
}

export default function AppEntryGate() {
	const { setIsInitialLoading } = useDaemonContext()
	// Passcode lock (D19): the wallet is encrypted with a passcode and not unlocked yet. No app content mounts.
	// Native shell without a key for this account: show the import route; no app content mounts.
	const [nativeNoKey, setNativeNoKey] = useState(false)
	// (items 2 and 3): the native no-key decision lives in one controller; the component forwards events.
	const [noKeyCtl] = useState(() => new AppEntryNoKeyController())
	const markDecided = () => {
		decisionMadeRef.current = true
		noKeyCtl.decide()
	}
	const markWalletEstablished = () => {
		noKeyCtl.established()
		setNativeNoKey(false)
		// (default proposal): the shell runs the PGP migration once in the background after the wallet is ready.
		if (nativeShellRef.current) void startPgpMigrationOnce()
	}
	const [vaultLocked, setVaultLocked] = useState(false)
	const [showBeamioOnboardingModal, setShowBeamioOnboardingModal] = useState(false)
	const [requireWalletRecover, setRequireWalletRecover] = useState(false)
	/** a key without a BeamioTag opens the Create Beamio ID page directly. */
	const [requireBeamioTagCreate, setRequireBeamioTagCreate] = useState(false)
	const [splashVisible, setSplashVisible] = useState(true)
	// 门闸是否已判定「可进入主 App」。判定完成前绝不渲染 <Outlet/>（不依赖 Splash 遮挡）。
	const [gateDecided, setGateDecided] = useState(false)
	// 门闸已读到的本地存储快照（含超时降级结果），下传给 onboarding 弹窗避免二次读 IndexedDB 再次挂起。
	const [bootCoNETData, setBootCoNETData] = useState<encrypt_keys_object | null>(null)
	const [bootResolved, setBootResolved] = useState(false)
	const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null)
	/** an error line for the native recovery exit on the unavailable screen (existing copy keys only). */
	const [nativeRecoveryNotice, setNativeRecoveryNotice] = useState('')
	// while the unavailable screen offers the native recovery exit, its result enters the app (the native side keeps the key).
	useEffect(() => {
		if (storageUnavailable !== 'native_recovery_needed') return
		return onNativeRecoveryResult(({ code, eoa }) => {
			if (code === 'ok') {
				setNativeRecoveryNotice('')
				announceNativeWalletEstablished()
				rememberNativeEoa(eoa)
				setStorageUnavailable(null)
				void reachNativeWallet().then(() => notifyNativeWalletReady(''))
				return
			}
			const copyKey = nativeRecoveryCopyKey(code)
			if (copyKey) setNativeRecoveryNotice(tu(copyKey))
		})
	}, [storageUnavailable])
	// the unavailable screen's main guide is the native import page (nativeImportOpen). When the page
	// is visible again after it opened, the app reloads once. The new code reads no walletStatus; the reloaded boot
	// reads it by the existing path. Only visibilitychange is used: a focus event can arrive while the import page is still open.
	const [awaitingImportReturn, setAwaitingImportReturn] = useState(false)
	useEffect(() => {
		if (!awaitingImportReturn) return
		const recheck = () => {
			if (document.visibilityState !== 'visible') return
			window.location.reload()
		}
		document.addEventListener('visibilitychange', recheck)
		return () => {
			document.removeEventListener('visibilitychange', recheck)
		}
	}, [awaitingImportReturn])
	const importWalletNative = async () => {
		setNativeRecoveryNotice('')
		const out = await openNativeKeyImport()
		if (out === 'opened') setAwaitingImportReturn(true)
		else setNativeRecoveryNotice(tu('native_key_import_failed'))
	}
	// 任一终态（进入 App / onboarding / recover）已确定；用于 Splash 兜底时安全降级。
	const decisionMadeRef = useRef(false)
	const nativeShellRef = useRef(false)
	/** attempts of the native store's not-ready retry (a backoff that is never given up; reset when the store reads). */
	const nativeRetryAttemptRef = useRef(0)
	/** true while the native store is not ready (a migration): the splash deadline keeps the wait, never the unavailable screen. */
	const nativeWaitRef = useRef(false)

	/** whether the shell declared identity.native-keys.v1, read from its hello answer. */
	const shellIdentityState = async () => identityCapabilityFrom(await probeNativeCapabilities())

	/** (B): the gate owns the global bar. Entering the app clears the loading flag, except in a shell: there the App's init clears it
	 *  once the account is in its state, so the bar does not show before the account is loaded. A screen the gate shows keeps it set. */
	const enterApp = () => {
		markDecided()
		setGateDecided(true)
		setSplashVisible(false)
		if (!isShellContext()) setIsInitialLoading(false)
	}

	/** (A): a shell that enters on the page's own record (not the native seed) asks the app to run its init again: the init
	 *  judged the account before the record was read, so it cannot have loaded it. A browser build does not need the signal. */
	const notifyShellEntry = (reason: string) => {
		// always wake the App's init on a shell entry. A page-record entry can return before the init's storage
		// read; the wake-up must not depend on the init's pending flag. A repeat for the same account is a skip in the init.
		if (isShellContext()) dispatchBeamioWalletReady(reason)
	}

	const goOnboarding = (needRecover: boolean, beamioTagCreate = false) => {
		markDecided()
		setBootResolved(true)
		setRequireWalletRecover(needRecover)
		setRequireBeamioTagCreate(beamioTagCreate)
		setIsInitialLoading(true)
		setShowBeamioOnboardingModal(true)
		setSplashVisible(false)
	}

	const showStorageUnavailable = (reason: string) => {
		nativeWaitRef.current = false
		markDecided()
		setSplashVisible(false)
		// The unavailable screen is not an entry: the bar stays hidden. The identity-capability notice keeps the content visible (below).
		setIsInitialLoading(reason !== IDENTITY_CAPABILITY_MISSING)
		// a missing identity capability does not replace the app. Pages that need no identity keep working,
		// and the chat and identity entries show the unavailable notice themselves (ShellChatGate; the shell state). Only the gate's
		// own states (storage, not_ready) replace the screen.
		if (reason === IDENTITY_CAPABILITY_MISSING) {
			setGateDecided(true)
			return
		}
		setStorageUnavailable(reason)
	}

	/**
	 * Browser / PWA preview: no proven local signing material → onboarding.
	 * Native shell: keep unavailable (protect existing wallets on IDB hang).
	 */
	const handleStorageUnavailable = (reason: string) => {
		const nativeShell = nativeShellRef.current || isCashTreesNativeWebView()
		// the native store is not ready (migrating, import not done, legacy store unreadable): keep the splash, retry later.
		if (storageUnavailableRoute({ nativeShell, reason }) === 'native_retry') {
			const attempt = nativeRetryAttemptRef.current
			nativeRetryAttemptRef.current = attempt + 1
			nativeWaitRef.current = true
			publishNativePwaLog('info', '[AppEntryGate] native store not ready; retrying (no onboarding)')
			setSplashVisible(true)
			window.setTimeout(() => void init(), nativeStoreWaitDelayMs(attempt))
			return
		}
		// An unreadable vault is never "no wallet": onboarding could overwrite the encrypted copy.: every browser reason
		// other than a confirmed empty store stays on the unavailable screen with retry (see storageRoute.ts). Shell: the same screen.
		showStorageUnavailable(reason)
	}

	// Shell: the native wallet decides. A native wallet enters the app on its public address; the page storage is not read.
	const applyNativeWallet = (eoa: string) => {
		const seed = publicWalletSeed(eoa)
		setCoNET_Data(seed)
		setBootCoNETData(seed)
		setRequireWalletRecover(false)
		setShowBeamioOnboardingModal(false)
		publishNativePwaLog('info', '[AppEntryGate] native wallet present: entering the app on public identity')
		markWalletEstablished()
		enterApp()
		notifyShellEntry('native-wallet')
	}

	const init = async () => {
		// /.2: the shell judges the account from `walletState`(the only basis). A native build that does not report it yet
		// answers `not_reported`, and the existing route applies (unchanged 0.52.930 behaviour).
		let shellWalletState: NativeWalletState | 'not_reported' | null = null
		let shellWalletStatus: NativeWalletStatus = 'unknown'
		if (nativeShellRef.current) {
			shellWalletState = await queryNativeWalletState()
			//a locked native wallet shows the existing passcode page; the account is judged again after the unlock (init runs again).
			if (shellWalletState === 'locked') {
				publishNativePwaLog('info', '[AppEntryGate] native walletState locked: passcode page, judged again after the unlock')
				markDecided()
				setSplashVisible(false)
				setGateDecided(false)
				setVaultLocked(true)
				return
			}
			const native = await reachNativeWallet()
			shellWalletStatus = native.status
			if ((native.status === 'locked' || native.status === 'unlocked') && 'eoa' in native) {
				// Enters on the native account only when walletState does not contradict it (a present store, or a build without walletState).
				if (shellWalletState === 'not_reported' || shellWalletState === 'present') {
					applyNativeWallet(native.eoa)
					return
				}
				publishNativePwaLog('warn', `[AppEntryGate] native walletState ${shellWalletState}: not confirmed, retry`)
				showStorageUnavailable('native_wallet_undetermined')
				return
			}
			// a shell without identity.native-keys.v1 shows the unified unavailable state, not the native-wallet
			// status screen, and never reaches the page-wallet path (not even for no_key).
			if (shellEntryFor(await shellIdentityState(), native) === 'chat_unavailable') {
				publishNativePwaLog('info', '[AppEntryGate] identity.native-keys.v1 not declared: chat unavailable (no page key)')
				showStorageUnavailable(IDENTITY_CAPABILITY_MISSING)
				return
			}
			//unknown and not_ready never fall back to the page storage. The account is not entered
			// from a stored record while the native wallet is not known to be ready.
			if (shellWalletState === 'not_reported') {
				if (native.status !== 'no_key') {
					publishNativePwaLog('warn', `[AppEntryGate] native wallet ${native.status}: page storage is not read`)
					showStorageUnavailable(`native_wallet_${native.status}`)
					return
				}
				// Boundary: native has no key for this account; the page wallet (its own EOA) decides below.
				publishNativePwaLog('info', '[AppEntryGate] native wallet: no key → page wallet decides (boundary)')
			} else {
				// walletState reported: the page storage and walletState decide below (judgeShell). A present store without an entered native
				// account is not ready yet: retry (never onboarding).
				if (shellWalletState === 'present') {
					publishNativePwaLog('warn', '[AppEntryGate] native walletState present but no native account yet: retry')
					showStorageUnavailable('native_wallet_not_ready')
					return
				}
			}
		}
		try {
			const storageResult = await checkStorageWithTransientRetry()
			if (storageResult.status === 'locked') {
				// Never onboarding while locked: the encrypted wallet must not be replaced.
				publishNativePwaLog('info', '[AppEntryGate] wallet passcode required')
				markDecided()
				setSplashVisible(false)
				setGateDecided(false)
				setVaultLocked(true)
				return
			}
			if (storageResult.status === 'unavailable') {
				publishNativePwaLog(
					'error',
					`[AppEntryGate] local wallet storage unavailable: ${storageResult.reason}`,
				)
				handleStorageUnavailable(storageResult.reason)
				return
			}
			//3: the account is judged from the IndexedDB read (browser), and in the shell also from walletState. Undetermined is
			// never onboarding and never creates or overwrites: the retry screen. Only an EOA key decides an account (PGP missing is not no wallet).
			const idb = idbSignalOf({
				status: storageResult.status,
				keyPresent: storageResult.status === 'loaded' && hasLocalSigningMaterial(storageResult.data),
				accountPresent: storageResult.status === 'loaded' && hasCompletedBeamioAccount(storageResult.data),
			})
			//the shell judges by walletState (the only basis when it is reported); the transitional route uses walletStatus only.
			const judged = isShellContext()
				? judgeShellFromNative({ idb, walletState: shellWalletState ?? 'not_reported', walletStatus: shellWalletStatus })
				: judgeBrowser(idb)
			publishNativePwaLog('info', `[AppEntryGate] account judgement=${judged.account} action=${judged.action}`)
			if (judged.action === 'unlock') {
				markDecided()
				setSplashVisible(false)
				setGateDecided(false)
				setVaultLocked(true)
				return
			}
			if (judged.account === 'undetermined') {
				handleStorageUnavailable('undetermined')
				return
			}
			const presence = judged.account
			nativeRetryAttemptRef.current = 0
			// the store reads now: any earlier unavailable state is cleared, so the app enters on its own (no stuck screen).
			nativeWaitRef.current = false
			setStorageUnavailable(null)
			let CoNETData = storageResult.status === 'loaded' ? storageResult.data : null
			// Loaded blob with no secrets / no completed account → first-time onboarding (browser). In a shell the storage read has
			// decided: only an absent store is onboarding, so the page does not re-normalise a loaded record into an empty one.
			if (!isShellContext() && CoNETData && isTrustedEmptyWalletBlob(CoNETData)) {
				CoNETData = null
			}
			// a coupon claim provisions only where no account is confirmed (it reuses a complete local wallet, never creates one).
			const provisioned = presence === 'no_account'
				? await withTimeout(
					ensureEphemeralWalletForCouponClaim().catch(() => null),
					EPHEMERAL_WALLET_TIMEOUT_MS,
					null,
				)
				: null
			if (provisioned) CoNETData = provisioned
			setBootCoNETData(CoNETData)

			// in a shell a loaded record already holds the account's EOA key (the store guard); it is entered even without a
			// @beamioTag or account name (the app's own flow handles them). Browser: the account rule as before.
			// an existing account is any valid record (an EOA key, or an account that needs recovery); the provisioned complete wallet of a
			// coupon claim counts as well. The rule for the browser build and the shell build is the same (accountJudgement.ts).
			const hasAccount = presence === 'has_account' || (presence === 'no_account' && hasCompletedBeamioAccount(CoNETData))
			// An existing account with no record on this device (a shell whose native account is not entered yet): retry, never the create page.
			if (presence === 'has_account' && CoNETData == null) {
				handleStorageUnavailable('undetermined')
				return
			}
			if (hasAccount) markWalletEstablished()
			// Scheme A: a shell routes to its own recovery never; the native side decides there.
			const needsRecover = pageWalletRecoverNeeded(CoNETData, isShellContext())
			const hasMnemonic = hasLocalPlaintextMnemonic(CoNETData)
			publishNativePwaLog(
				'info',
				`[AppEntryGate] storage hasAccount=${hasAccount} needsRecover=${needsRecover} hasMnemonic=${hasMnemonic}`,
			)
			// A browser key with the recovery phrase and no completed BeamioTag goes straight to the Create Beamio ID page (it reuses the key). A key-only record keeps the existing route (enterApp).
				if (beamioTagCreateNeeded({ shell: isShellContext(), presence, completedAccount: hasCompletedBeamioAccount(CoNETData), hasMnemonic: hasLocalPlaintextMnemonic(CoNETData) })) {
					publishNativePwaLog('info', '[AppEntryGate] account key without BeamioTag → Create Beamio ID page (reuses the key)')
					goOnboarding(false, true)
					return
				}
				if (hasAccount) {
				if (needsRecover) {
					// 设备上有账号但本地无明文助记词：必须 BeamioTag + 密码 recover，不可进主 App。
					goOnboarding(true)
					return
				}
				enterApp()
				notifyShellEntry('page-wallet')
				return
			}
			// Trusted empty (or empty status): Create Beamio ID / onboarding. The native no-key route only after a confirmed-empty store.
			noKeyCtl.storageRead(storageResult.status === 'empty')
			goOnboarding(false)
		} catch (err) {
			publishNativePwaLog(
				'error',
				`[AppEntryGate] init failed: ${err instanceof Error ? err.message : String(err)}`,
			)
			handleStorageUnavailable('read_error')
		}
	}

	useEffect(() => {
		const nativeShell = isCashTreesNativeWebView()
		// the shell re-sends queued profile updates once the native identity is ready, also after a restart.
		if (nativeShell) registerPendingSender(sendPendingProfileSync)
		// a deferred write from before a restart resumes even when the native wallet is ready at start (no storage read).
		if (nativeShell) resumeDeferredWrite()
		nativeShellRef.current = nativeShell
		const msg = `[PWA] AppEntryGate mounted nativeShell=${nativeShell}`
		console.log(msg, { nativeShell })
		publishNativePwaLog('info', msg)

		const splashTimer = window.setTimeout(() => {
			const action = splashDeadlineAction({ decided: decisionMadeRef.current, nativeWaiting: nativeWaitRef.current })
			if (action === 'keep_waiting') {
				// a store still migrating keeps the wait (the splash stays); the retries enter the app once it reads ok.
				publishNativePwaLog('info', `[AppEntryGate] splash deadline ${SPLASH_FORCE_DISMISS_MS}ms while the native store is not ready: still waiting`)
				return
			}
			setSplashVisible(false)
			if (action === 'release') {
				publishNativePwaLog('warn', `[AppEntryGate] splash force-dismiss after ${SPLASH_FORCE_DISMISS_MS}ms`)
				return
			}
			publishNativePwaLog(
				'warn',
				`[AppEntryGate] splash force-dismiss after ${SPLASH_FORCE_DISMISS_MS}ms → storage unavailable (retry; never onboarding)`,
			)
			handleStorageUnavailable('timeout')
		}, SPLASH_FORCE_DISMISS_MS)

		// A wallet-ready event follows a creation or a restore: from now on a late no_key never takes over .
		const onWalletReady = () => {
			markWalletEstablished()
			setSplashVisible(false)
		}
		window.addEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)
		// a native ok answer (creation or restore) establishes the wallet at once, synchronously.
		const onNativeWalletEstablished = () => markWalletEstablished()
		window.addEventListener(NATIVE_WALLET_ESTABLISHED_EVENT, onNativeWalletEstablished)
		// 7edc841f residual: while a native create or recovery page is open, a late no_key does not cover it with the import route.
		const onNativeFlowPending = (e: Event) => {
			if ((e as CustomEvent<{ open?: boolean }>).detail?.open) noKeyCtl.beginNativeFlow()
			else noKeyCtl.endNativeFlow()
		}
		window.addEventListener(NATIVE_FLOW_PENDING_EVENT, onNativeFlowPending)

		// A native recovery just succeeded (no reload): re-read the native wallet and enter the app.
		const onNativeWalletReady = () => {
			void reachNativeWallet().then(async (native) => {
				if ((native.status === 'locked' || native.status === 'unlocked') && 'eoa' in native) applyNativeWallet(native.eoa)
				else if (shellEntryFor(await shellIdentityState(), native) === 'chat_unavailable') showStorageUnavailable(IDENTITY_CAPABILITY_MISSING)
				else if (native.status === 'not_ready' || native.status === 'unknown') showStorageUnavailable(`native_wallet_${native.status}`)
			})
		}
		window.addEventListener(NATIVE_WALLET_READY_EVENT, onNativeWalletReady)

		// Sign-out with a passcode set: drop the app content and ask for the passcode again.
		const onVaultLocked = () => {
			markDecided()
			setSplashVisible(false)
			setGateDecided(false)
			setVaultLocked(true)
		}
		window.addEventListener(VAULT_LOCKED_EVENT, onVaultLocked)

		// Native key state: a shell with no key for the account answers `no_key`; show the import route.
		const removeNoKeyWatcher = nativeShell ? installNativeNoKeyWatcher(() => {
			// Race (3.3): the import route only after the gate has decided and found no page account.
			if (!noKeyCtl.onNativeNoKey()) return
			setSplashVisible(false)
			setIsInitialLoading(true)
			setNativeNoKey(true)
		}) : null
		// G0 (walletStatus no_key) is decided by init below: the onboarding shows "Get started" and the native recovery entry.
		// The import route is not shown for G0 (round 27; the import page has no recovery entry).

		setIsInitialLoading(true)
		void init()

		return () => {
			removeNoKeyWatcher?.()
			window.clearTimeout(splashTimer)
			window.removeEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)
			window.removeEventListener(NATIVE_WALLET_ESTABLISHED_EVENT, onNativeWalletEstablished)
			window.removeEventListener(NATIVE_FLOW_PENDING_EVENT, onNativeFlowPending)
			window.removeEventListener(NATIVE_WALLET_READY_EVENT, onNativeWalletReady)
			window.removeEventListener(VAULT_LOCKED_EVENT, onVaultLocked)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Shell capability state (spec, option A): asked once from the shell's hello answer. A no_key held back before
	// the answer is decided again now (G1): the import route shows only for a shell that declared native keys.
	useEffect(() => {
		void ensureShellChatState().then((state) => {
			if (noKeyCtl.capabilityResolved(state === 'native_chat')) {
				setSplashVisible(false)
				setIsInitialLoading(true)
				setNativeNoKey(true)
			}
		})
	}, [])

	return (
		<div className="flex h-full min-h-[100dvh] w-full flex-col">
			<EmbeddedPwaUpdateBanner />
			{splashVisible && <SplashScreen />}
			{nativeNoKey ? (
				<NativeKeyImportRequired />
			) : vaultLocked ? (
				<PasscodeLockScreen
					onUnlocked={() => {
						setVaultLocked(false)
						setSplashVisible(true)
						void init()
					}}
				/>
			) : storageUnavailable ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
					<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
						{storageUnavailable.startsWith('native_wallet_') ? (
							<>
								<h1 className="text-xl font-semibold">Native wallet is not ready</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">
									The native wallet has not confirmed this account yet.
									Your data was not deleted. Retry, or restart the app later.
								</p>
							</>
						) : (
							<>
								<h1 className="text-xl font-semibold">Wallet storage is unavailable</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">
									Beamio could not read the existing local wallet data. Your data was not deleted.
									Keep this app origin unchanged and retry.
								</p>
							</>
						)}
						{storageUnavailable === 'native_recovery_needed' ? (
								<div className="mt-5 flex flex-col items-center gap-3">
									{/* the main guide is the native import page; the recovery-code entry is secondary. */}
									<button
										type="button"
										className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
										onClick={() => void importWalletNative()}
									>
										{tu('native_key_required_import')}
									</button>
									<button
										type="button"
										className="px-3 py-3 text-sm text-white/75 underline"
										onClick={() => {
											setNativeRecoveryNotice('')
											void nativeRecoveryOpen().then((out) => {
												if (!out.ok) setNativeRecoveryNotice(tu(recoveryOpenErrorKey(out.reason)))
											})
										}}
									>
										{tu('use_recovery_code')}
									</button>
									{nativeRecoveryNotice ? <p className="text-sm leading-6 text-white/75">{nativeRecoveryNotice}</p> : null}
								</div>
							) : null}
						<div className="mt-5 flex justify-center">
							<button
								type="button"
								className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
								onClick={() => {
									if (storageUnavailable.startsWith('native_wallet_')) {
										// The native wallet is asked again in place; the page does not reload.
										setStorageUnavailable(null)
										setSplashVisible(true)
										void init()
										return
									}
									window.location.reload()
								}}
							>
								Retry
							</button>
						</div>
					</div>
				</div>
			) : showBeamioOnboardingModal ? (
				<BeamioOnboardingModal
					requireWalletRecover={requireWalletRecover}
					requireBeamioTagCreate={requireBeamioTagCreate}
					bootResolved={bootResolved}
					bootCoNETData={bootCoNETData}
					home={() => {
						setShowBeamioOnboardingModal(false)
						setRequireWalletRecover(false)
						setSplashVisible(false)
						// in a shell the bar waits for the App's init to load the account, as on enterApp (no clear here).
						if (!isShellContext()) setIsInitialLoading(false)
						// onboarding / recover 成功后允许进入主 App。
						setGateDecided(true)
					}}
					onInitComplete={() => setSplashVisible(false)}
				/>
			) : gateDecided ? (
				<div className="flex min-h-0 w-full flex-1 flex-col">
					<Outlet />
				</div>
			) : null}
		</div>
	)
}
