/**
 * 全应用入口门闸：本地未完成 Beamio 初始化（与 pages/Home/index 原逻辑一致）时，
 * 先 Splash + BeamioOnboardingModal，任意深层路由（/wallet、/Chat 等）均不可跳过。
 */
import { useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useDaemonContext } from '@/providers/DaemonProvider'
import { checkStorageWithStatus, checkStorageWithStatusWithTimeout, checkStorageWithTransientRetry, readStoredRecordForVerify, sendPendingProfileSync, storeSystemDataAndWait } from '@/services/beamio'
import { allowRestoreWrite, endRestoreWriteWindow, setPageWritePermit, type PageWritePermit } from '@/services/beamio'
import { checkRecoveredRecord, checkShellReadBack, recoveredPageRecord } from '@/services/recoveredMnemonicRecord'
import { releaseShellSessionSignerHold, holdShellSessionFromPhrase, loadShellSessionSigner, recordCarriesAccountKey, refreshShellSessionInMemory, shellSessionEoa } from '@/services/shellSessionSigner'
import { pageCopyAction, readWalletCredential, type PageCopyAction } from '@/services/walletCredential'
import { decidePageRecord, type PageRecordRead } from '@/services/pageRecordDecision'
import { onAppUpdateRequired } from '@/services/appUpdatePrompt'
import { storageUnavailableRoute } from '@/services/storageRoute'
import { OLD_SHELL_UPGRADE_REASON, shellRecordFallbackLabel, terminalEvidenceOf } from '@/services/shellRecordFallback'
import { decideShellTerminal, isShellTerminal, requestShellSingleProbe } from '@/services/shellTerminalState'
import { NOT_READY_BOUNDED_DELAYS_MS } from '@/services/shellStoreWait'
import { registerPendingSender } from '@/services/pendingServerSync'
import { allowFirstNativeWrite, resumeDeferredWrite, retryDeferredWriteNow } from '@/services/shellRecordStore'
import { installNativeNoKeyWatcher, NO_KEY_ERROR } from '@/services/nativeKeyState'
import { markPendingSync, takePendingSync } from '@/services/pendingSync'
import { runSyncPreCheck } from '@/services/syncPreCheck'
import { clearFailureRecord, manualRetryVisible, readFailureRecord, recordForFailure, recordMatchesAccount, writeFailureRecord } from '@/services/pwaSyncFailureRecord'
import { getShellSyncState, setShellSyncManualCheck } from '@/services/shellSyncStatus'
import { needsReread, rereadDecision } from '@/services/manualRetryReread'
import { queryNativeWalletStatusForPreCheck } from '@/services/syncPreCheckReads'
import { installPasscodeStateWatcher } from '@/services/passcodeStateWatch'
import { decideNoKeyEntry, readNoKeyFacts } from '@/services/noKeyEntry'
import { cleanupAfterVerifiedRecovery, readCleanupPending, startCleanupAfterRecovery } from '@/services/accountCleanupPending'
import { AppEntryNoKeyController } from './appEntryNoKeyController'
import { NATIVE_WALLET_ESTABLISHED_EVENT } from '@/services/nativeWalletEstablished'
import { NATIVE_FLOW_PENDING_EVENT } from '@/services/nativeFlowPending'
import { startPgpMigrationOnce } from '@/services/pgpMigrationRunner'
import { ensureShellChatState } from '@/services/shellChatCapability'
import { beamioTagCreateNeeded, idbSignalFromRecord, judgeBrowser, judgeLocalOnly, judgeShellFromNative, type NativeWalletState, type NativeWalletStatus } from '../services/accountJudgement'
import { queryNativeMnemonicPreread, queryNativePasscodeStatus } from '../services/nativeRecovery'
import { bridgeTrustReasonCode, bridgeTrustState, nativeNoKeyRoute, nativeStartRoute, prereadPageRoute } from '../services/accountJudgement'
import { isStartReasonCode, startReasonLine, type StartReasonCode } from '../services/startReasonCodes'
import { queryNativeWalletStateForPreCheck } from '@/services/syncPreCheckReads'
import { identityCapabilityFrom, identityEntryDisplay, MIGRATION_RETRY_SCREEN, NATIVE_RETRY_SCREEN, shellEntryFor, type IdentityCapabilityState } from '@/services/shellEntryDecision'
import { identityProbeDelayMs, onNativeIdentityRetryRequested, requestNativeIdentityRetry, setNativeIdentityCapability } from '@/services/nativeIdentityProbeRetry'
import { probeNativeCapabilities, requestNativeAck } from '@/services/nativeChatRouteRegister'
import { reportUiLocked } from '@/services/passcode/uiLockState'
import { IDENTITY_CAPABILITY_MISSING } from '@/services/bridgeGuard'
import { shellNotReadyWaitReason } from '@/services/shellNotReadyWait'
import { NATIVE_WALLET_READY_EVENT, notifyNativeWalletReady, publicWalletSeed, reachNativeWallet, releaseInitLockedHold, rememberNativeEoa, takeInitRefusal } from '@/services/nativeWallet'
import { readWalletEoaAddress, type WalletEoaAddressAnswer } from '@/services/walletEoaAddress'
import { shellMnemonicSync } from '@/services/shellMnemonicSync'
import { markBootScreen } from '@/services/bootTrace'
import { setCoNET_Data } from '@/utils/globals'
import PasscodeLockScreen from '@/components/PasscodeLockScreen'

import { VAULT_LOCKED_EVENT } from '@/services/walletVaultEvents'
import SplashScreen from '@/components/SplashScreen'
import { EmbeddedPwaUpdateBanner } from '@/components/EmbeddedPwaUpdateBanner'
import IdentityEntryPrompt from '@/components/IdentityEntryPrompt'
import BeamioOnboardingModal from '@/pages/Home/LoadingPage'
import { isCashTreesNativeWebView } from '@/utils/cashTreesNativeNfc'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import {
	hasCompletedBeamioAccount,
	hasLocalPlaintextMnemonic,
	hasLocalSigningMaterial,
	hasValidMnemonic,
	validMnemonicEoa,
	isTrustedEmptyWalletBlob,
	pageWalletRecoverNeeded,
} from '@/utils/consumerWalletGate'
import { isShellContext } from '@/services/shellContext'
import { nativeRetryStep, splashDeadlineAction } from '@/services/shellStoreWait'
import { type NativeWalletStatusAnswer } from '@/services/accountPresence'
import { nativeRecoveryCopyKey, nativeRecoveryOpen, onNativeRecoveryResult, queryNativeWalletStatus, recoveryOpenErrorKey } from '@/services/nativeRecovery'
import { announceNativeWalletEstablished } from '@/services/nativeWalletEstablished'
import { tu } from '@/locale/beamioLocale'
import { isIosNativeShell } from '@/services/nativeIosShell'
import { ensureEphemeralWalletForCouponClaim } from '@/utils/ephemeralCouponClaimWallet'
import { BEAMIO_WALLET_READY_EVENT, dispatchBeamioWalletReady } from '@/utils/beamioWalletReadyEvent'
import { requestChatRestartAfterUnlock } from '@/services/unlockChatRestart'
import { startupRetryDelayMs, STARTUP_RETRY_OFFER_EVENT } from '@/services/startupRetryPolicy'
import { pageSyncPayload } from '@/services/shellMnemonicSync'
import { isTrustedTopFrame } from '@/utils/androidChatChannel'
import { copyPageEvidence, copyPreHoldAction, decidePrepareEntry, decidePrereadEntry, isNativeCopyValidated } from '@/services/copyValidatedEntry'
import { setShellSyncRetry } from '@/services/shellSyncStatus'

/** HC-LOCK: the wait between checks while the native side is locked. */
const NATIVE_LOCKED_RETRY_MS = 30_000

const isExplicitNativeNoKey = (status: NativeWalletStatus): boolean => status === 'no_key'

const SPLASH_FORCE_DISMISS_MS = 12_000
const EPHEMERAL_WALLET_TIMEOUT_MS = 8_000
/** The shell entry's page-storage read limit (the same 2 s as the shell pre-check). A read past it is unknown: never the local home. */
const SHELL_PAGE_READ_TIMEOUT_MS = 2_000
/**
 * A(6): the identity hello (the bridge connection) is probed again on the cadence (10 s, 30 s, then every 60 s). The cadence is
 * bridge-only: it never decides the wallet route. After this many probes it stops; the retry screen stays.
 */
const BRIDGE_HELLO_MAX_PROBES = 5

/**
 * The page's mnemonic evidence. `valid`: the page holds a valid mnemonic, and its EOA is the one current
 * account. `confirmed_empty`: the page store was read and holds no valid mnemonic. `unknown`: a timeout, a failure or an unreadable store
 * (a passcode-locked store is unknown with `locked`). Unknown is never empty: nothing is deleted, overwritten or shown as an error.
 */
type PageMnemonicEvidence = { kind: 'valid'; eoa: string; phrase: string; nativeValidated?: boolean } | { kind: 'confirmed_empty'; keyIdMismatch?: boolean } | { kind: 'unknown'; locked?: boolean } | { kind: 'terminal' }
const UNKNOWN_PAGE_MNEMONIC: PageMnemonicEvidence = { kind: 'unknown' }

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			window.setTimeout(() => resolve(fallback), ms)
		}),
	])
}



/** The page's IDB-derived account address (profiles[0].keyID), read once through the read-only probe; null when not readable. */
async function readPageDerivedAddress(): Promise<unknown> {
	const r = await checkStorageWithStatus({ probe: true })
	if (r.status !== 'loaded') return null
	const profiles = (r.data as { profiles?: Array<{ keyID?: unknown }> } | null)?.profiles
	return profiles?.[0]?.keyID ?? null
}

export default function AppEntryGate() {
	const { setIsInitialLoading } = useDaemonContext()
	// Passcode lock (D19): the wallet is encrypted with a passcode and not unlocked yet. No app content mounts.
	// (items 2 and 3): the native no-key decision lives in one controller; the component forwards events.
	const [noKeyCtl] = useState(() => new AppEntryNoKeyController())
	const boundedNotReadyRef = useRef(0)
	const markDecided = () => {
		boundedNotReadyRef.current = 0
		if (startupRetryRef.current !== undefined) {
			window.clearTimeout(startupRetryRef.current)
			startupRetryRef.current = undefined
		}
		decisionMadeRef.current = true
		noKeyCtl.decide()
	}
	const markWalletEstablished = () => {
		noKeyCtl.established()
		// (default proposal): the shell runs the PGP migration once in the background after the wallet is ready.
		if (nativeShellRef.current) void startPgpMigrationOnce()
	}
	const [vaultLocked, setVaultLocked] = useState(false)
	// rev2 every UI lock (including the hot-restore lock) reports uiLockState {locked:true}. The native session is not touched.
	useEffect(() => {
		if (!vaultLocked) return
		void probeNativeCapabilities()
			.then((p) => reportUiLocked(p.answered ? p.capabilities : [], (cmd) => requestNativeAck(cmd, 5000)))
			.catch(() => undefined)
	}, [vaultLocked])
	//which lock is showing. A native-side lock hides "Forgot passcode?"; the page-storage lock keeps it.
	const [vaultLockKind, setVaultLockKind] = useState<'page' | 'native'>('page')
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
	// QA boot marker (coordinator request): the splash is the first screen of every launch. Only a QA build prints it.
	useEffect(() => {
		markBootScreen('splash')
	}, [])
	// (2026-11-21, approval 75edef25): the silent cleanup of the old account is part of this version. A pending cleanup from an
	// earlier verified recovery resumes at start with the same idempotencyKey (the marker is written only after a verified recovery).
	useEffect(() => {
		const pending = readCleanupPending(window.localStorage)
		if (pending) void startCleanupAfterRecovery(window.localStorage, pending.accountKey).catch(() => undefined)
	}, [])
	// while the unavailable screen offers the native recovery exit, its result enters the app (the native side keeps the key).
	useEffect(() => {
		if (storageUnavailable !== 'native_recovery_needed') return
		return onNativeRecoveryResult(({ code, eoa }) => {
			if (code === 'ok') {
				setNativeRecoveryNotice('')
				announceNativeWalletEstablished()
				rememberNativeEoa(eoa)
				// silent cleanup (approval 75edef25): only a verified recovery (native ok and the page's derived address agrees) starts it; any other
				// case deletes nothing. No button, no pick, no notice.
				if (eoa) void cleanupAfterVerifiedRecovery(window.localStorage, eoa, readPageDerivedAddress).catch(() => undefined)
				setStorageUnavailable(null)
				void reachNativeWallet().then(() => notifyNativeWalletReady(''))
				return
			}
			const copyKey = nativeRecoveryCopyKey(code)
			if (copyKey) setNativeRecoveryNotice(tu(copyKey))
		})
	}, [storageUnavailable])
	// 任一终态（进入 App / onboarding / recover）已确定；用于 Splash 兜底时安全降级。
	const decisionMadeRef = useRef(false)
	// 0.53.44 (PART 2): the session write permit starts CLOSED. It opens only at the three entry points (a valid page mnemonic with a consistent
	// keyID; a native restore read back consistent; a new account created) and closes on every hold. The module state (setPageWritePermit) is
	// what every page-store save consults (storeSystemData, its timer, flushStoreSystemData): a closed save is discarded there.
	const writePermitRef = useRef<PageWritePermit | null>(null)
	const setWritePermit = (permit: PageWritePermit | null, why: string) => {
		writePermitRef.current = permit
		setPageWritePermit(permit)
		publishNativePwaLog('info', `[AppEntryGate] page write gate ${permit ? `open (${permit})` : 'closed'}: ${why}`)
	}
	useEffect(() => {
		setWritePermit(null, 'start')
		return () => setPageWritePermit(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	/** the local home is shown on a G1 wallet; the native wallet is read again until G2. */
	const localModeRef = useRef(false)
	// the latest init, for the retry screen and its timer (set below, after init)
	const initRef = useRef<(() => Promise<void>) | null>(null)
	const nativeShellRef = useRef(false)
	/** 0.53.39: when the bridge trust wait began (the first start without a declared identity). */
	const bridgeTrustStartRef = useRef<number | undefined>(undefined)
	/** attempts of the native store's not-ready retry (a backoff that is never given up; reset when the store reads). */
	const nativeRetryAttemptRef = useRef(0)
	/** true while the native store is not ready (a migration): the splash deadline keeps the wait, never the unavailable screen. */
	const startupRoundsRef = useRef(0)
	/** step 5: the visible retry button of an unknown start (shown from the first unknown round on, until a decision). */
	const [startupRetryOffered, setStartupRetryOffered] = useState(false)
	/** The hold page's restore button opened the existing restore screen (RestoreWalletUnifiedScreen) directly. */
	const [restoreFromHold, setRestoreFromHold] = useState(false)
	// the terminal screen's one Retry: while its probe runs the control is disabled (no second probe, no second control)
	const [terminalProbing, setTerminalProbing] = useState(false)
	const terminalProbeRef = useRef(false)
	/** 0.53.39: the native lock with no PWA mnemonic is a retry state; the unlock entry is offered on it. */
	const [nativeLockedOffered, setNativeLockedOffered] = useState(false)
	const nativeWaitRef = useRef(false)
	/** the pending startup-wait re-read (one at a time); cleared once a decision is made. */
	const startupRetryRef = useRef<number | undefined>(undefined)
	/** true while the identity hello is unanswered: the probe cadence runs. */
	const identityUnansweredRef = useRef(false)
	/** automatic probes since the last start or manual retry: the next delay is 10 s, then 30 s, then 60 s. */
	const identityProbesDoneRef = useRef(0)
	const [identityRetryTick, setIdentityRetryTick] = useState(0)

	/** whether the shell declared identity.native-keys.v1, read from its hello answer. */
	const shellIdentityState = async () => identityCapabilityFrom(await probeNativeCapabilities())
	const resolveShellChatCapability = () => {
		void ensureShellChatState().then((state) => {
			if (noKeyCtl.capabilityResolved(state === 'native_chat')) goOnboarding(false)
		})
	}

	/** One probe of identity.native-keys.v1. Declared enters the account again (G2); unanswered keeps the cadence going. */
	const probeIdentityNow = async (): Promise<void> => {
		const cap = await shellIdentityState()
		setNativeIdentityCapability(cap)
		identityUnansweredRef.current = cap === 'unanswered'
		if (cap === 'unanswered') {
			setIdentityRetryTick((t) => t + 1)
			return
		}
		identityProbesDoneRef.current = 0
		if (cap === 'declared') {
			// the retry screen gives way once the capability is declared; the account is entered by the same init as a start.
			setStorageUnavailable((prev) => (prev === NATIVE_RETRY_SCREEN ? '' : prev))
			void initRef.current?.()
		}
	}

	/** (B): the gate owns the global bar. Entering the app clears the loading flag, except in a shell: there the App's init clears it
	 * once the account is in its state, so the bar does not show before the account is loaded. A screen the gate shows keeps it set. */
	const enterApp = () => {
		startupRoundsRef.current = 0
		setStartupRetryOffered(false)
		markBootScreen('home')
		markDecided()
		setGateDecided(true)
		setSplashVisible(false)
		// The native-retry screen of an earlier undecided start (the splash deadline) gives way to the decided entry: the App is the screen
		// now. Without this the retry screen covers the Outlet and the home never shows (the decision was made, the screen was not cleared).
		setStorageUnavailable((prev) => (prev === NATIVE_RETRY_SCREEN ? null : prev))
		if (!isShellContext()) setIsInitialLoading(false)
	}

	/** (A): a shell that enters on the page's own record (not the native seed) asks the app to run its init again: the init
	 * judged the account before the record was read, so it cannot have loaded it. A browser build does not need the signal. */
	const notifyShellEntry = (reason: string) => {
		// always wake the App's init on a shell entry. A page-record entry can return before the init's storage
		// read; the wake-up must not depend on the init's pending flag. A repeat for the same account is a skip in the init.
		if (isShellContext()) dispatchBeamioWalletReady(reason)
	}

	const goOnboarding = (needRecover: boolean, beamioTagCreate = false) => {
		startupRoundsRef.current = 0
		setStartupRetryOffered(false)
		setStorageUnavailable((prev) => (prev === NATIVE_RETRY_SCREEN ? null : prev))
		markBootScreen('onboarding')
		markDecided()
		setBootResolved(true)
		setRequireWalletRecover(needRecover)
		setRequireBeamioTagCreate(beamioTagCreate)
		setIsInitialLoading(true)
		setShowBeamioOnboardingModal(true)
		setSplashVisible(false)
	}

	/** The hold page's restore button enters the existing restore screen only. It never opens the onboarding entry
	 * (no create, no Get started). Nothing is written here; the restore screen writes only on a completed restore (open point b). */
	const openRestoreFromHold = (): void => {
		setStartupRetryOffered(false)
		setRequireWalletRecover(true)
		setRestoreFromHold(true)
		setIsInitialLoading(true)
		setShowBeamioOnboardingModal(true)
		setSplashVisible(false)
	}

	/** 0.53.44 open point (b): a restore (recovery or onboarding restore) writes inside the restore window; the gate opens only on the read-back. */
	const onRestoreWriteStart = (): void => allowRestoreWrite()
	const onRestoreWriteEnd = async (ok: boolean, temp: { profiles?: Array<{ keyID?: unknown }> } | null | undefined): Promise<void> => {
		endRestoreWriteWindow()
		if (!ok || !temp) return
		const eoa = String(temp.profiles?.[0]?.keyID ?? '').trim().toLowerCase()
		const check = checkStoredRecord(await readStoredRecordForVerify(), eoa)
		if (check === 'valid') setWritePermit('recovery_completed', 'restore completed: read back consistent')
		else publishNativePwaLog('warn', `[AppEntryGate] restore read-back not confirmed (${check}): the gate stays closed`)
	}

	const showStorageUnavailable = (reason: string) => {
		setWritePermit(null, `storage unavailable: ${reason}`)
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
		// HC-LOCK: the native side is locked. Never onboarding, never the storage-unavailable screen, never a manual retry page:
		// the page keeps waiting and retries on a timer; the unlock re-runs the gate.
		if (reason === 'native_locked') {
			publishNativePwaLog('info', '[AppEntryGate] native locked: waiting, no onboarding')
			nativeWaitRef.current = true
			setSplashVisible(true)
			window.setTimeout(() => void init(), NATIVE_LOCKED_RETRY_MS)
			return
		}
		// v4: a not_ready with a bounded class re-reads at most 5 times (0.5, 1, 2, 4, 8 s), then the explicit
		// error. A final class (zero, persistent) is the explicit error at once. Neither creates, recovers, imports or onboards.
		if (reason === 'native_not_ready_bounded') {
			const attempt = boundedNotReadyRef.current
			if (attempt < NOT_READY_BOUNDED_DELAYS_MS.length) {
				boundedNotReadyRef.current = attempt + 1
				const delay = NOT_READY_BOUNDED_DELAYS_MS[attempt]
				publishNativePwaLog('info', `[AppEntryGate] not_ready (bounded): re-read ${attempt + 1} of ${NOT_READY_BOUNDED_DELAYS_MS.length} in ${delay} ms; no creation, recovery or import`)
				nativeWaitRef.current = true
				setSplashVisible(true)
				window.setTimeout(() => void init(), delay)
				return
			}
			publishNativePwaLog('warn', '[AppEntryGate] not_ready (bounded): the re-reads are used up: explicit error, the user retries')
			showStorageUnavailable('native_not_ready_final')
			return
		}
		if (reason === 'native_not_ready_final') {
			publishNativePwaLog('warn', '[AppEntryGate] not_ready (final): explicit error, no automatic re-read; the user retries')
			showStorageUnavailable(reason)
			return
		}
		// b7c6f8b2 (2026-11-21): both capabilities absent on the shell and the page store empty: the terminal update prompt; no retry.
		if (reason === OLD_SHELL_UPGRADE_REASON) {
			// the terminal is decided first (decideShellTerminal sets the state, then reports): no re-read can be scheduled from the report on
			decideShellTerminal(() => publishNativePwaLog('warn', `[AppEntryGate] terminal: fallback shell (shellRecordRead ${shellRecordFallbackLabel()}), page store confirmed empty: update prompt, no retry`))
			if (startupRetryRef.current !== undefined) {
				window.clearTimeout(startupRetryRef.current)
				startupRetryRef.current = undefined
			}
			nativeWaitRef.current = false
			setStartupRetryOffered(false)
			showStorageUnavailable(OLD_SHELL_UPGRADE_REASON)
			return
		}
		// the native store is not ready (migrating, import not done, legacy store unreadable): keep the splash, retry later.
		if (storageUnavailableRoute({ nativeShell, reason }) === 'native_retry') {
			const attempt = nativeRetryAttemptRef.current
			nativeRetryAttemptRef.current = attempt + 1
			//30 s, 2 min, 10 min automatically, then the manual retry screen. Used-up retries are still unknown: never onboarding, no account-lost prompt.
			const step = nativeRetryStep(attempt)
			if (step.kind === 'manual') {
				showStorageUnavailable(MIGRATION_RETRY_SCREEN)
				return
			}
			nativeWaitRef.current = true
			publishNativePwaLog('info', '[AppEntryGate] native store not ready; retrying (no onboarding)')
			setSplashVisible(true)
			window.setTimeout(() => void init(), step.delayMs)
			return
		}
		// An unreadable vault is never "no wallet": onboarding could overwrite the encrypted copy.: every browser reason
		// other than a confirmed empty store stays on the unavailable screen with retry (see storageRoute.ts). Shell: the same screen.
		showStorageUnavailable(reason)
	}

	// Shell: the native wallet decides. A native wallet enters the app on its public address; the page storage is not read.
	const applyNativeWallet = (eoa: string) => {
		localModeRef.current = false
		const seed = publicWalletSeed(eoa)
		setCoNET_Data(seed)
		setBootCoNETData(seed)
		setRequireWalletRecover(false)
		setShowBeamioOnboardingModal(false)
		publishNativePwaLog('info', '[AppEntryGate] native wallet present: entering the app on public identity')
		// 0.53.44 open point (a): the native wallet is present and its read is consistent (decidePrereadEntry), so the gate opens here.
		setWritePermit('native_wallet_present', 'native wallet present and read back consistent: entering on the public identity')
		markWalletEstablished()
		enterApp()
		notifyShellEntry('native-wallet')
	}

	/**
	 * the local home on a G1 wallet (the native record exists and is readable; the EOA is for display only). Chat and the
	 * network features stay unavailable (waiting for init) until the wallet reaches G2.
	 */
	const applyLocalWallet = (eoa: string) => {
		localModeRef.current = true
		const seed = publicWalletSeed(eoa)
		setCoNET_Data(seed)
		setBootCoNETData(seed)
		setRequireWalletRecover(false)
		setShowBeamioOnboardingModal(false)
		publishNativePwaLog('info', '[AppEntryGate] native wallet not initialised (g1_uninitialized): local home; network features wait for init')
		markWalletEstablished()
		enterApp()
		notifyShellEntry('native-wallet-local')
	}

	/**
	 * Native G2 and no page wallet record: the page asks walletCredential once and keeps the sealed blob with the restored mnemonic in its
	 * own record. The mnemonic is written in the record's existing format: wrapForDisk wraps it on the way to the
	 * store (device key, AES-GCM); in a shell the store is the native record. It is read back and must derive this native account; only
	 * then does the page sync run (item 44). Nothing is stored for another account.
	 */
	const readPageRecordForCopy = () => checkStorageWithTransientRetry()
	const restorePageCopy = async (eoa: string): Promise<PageCopyAction> => {
		try {
			const stored = await readPageRecordForCopy()
			if (stored.status === 'unavailable' && stored.reason === 'eoa_mismatch') return 'eoa_mismatch'
			const read: PageRecordRead = stored.status === 'loaded' ? { status: 'loaded', data: stored.data } : stored.status === 'empty' ? { status: 'empty' } : { status: 'other' }
			// the native account is read here (walletEoaAddress); a refusal, a timeout or an unavailable store is a retry.
			const nativeAccount = await readWalletEoaAddress()
			// no_key: a copy present means the native key is missing (recovery only); no copy is onboarding only when the native facts confirm it.
			if (nativeAccount.kind === 'refused' && nativeAccount.code === NO_KEY_ERROR) {
				const entry = decideNoKeyEntry(await readNoKeyFacts(), read.status === 'loaded' ? 'present' : read.status === 'empty' ? 'empty' : 'unknown')
				publishNativePwaLog('warn', `[AppEntryGate] walletEoaAddress no_key: ${entry}; the page copy is kept, nothing is written`)
				if (entry === 'native_key_missing') return 'native_key_missing'
				return entry === 'onboarding' ? 'none' : 'retry'
			}
			const decision = decidePageRecord(read, nativeAccount, eoa)
			if (decision === 'update_required') return 'update_required'
			if (decision === 'record_unavailable') return 'record_unavailable'
			if (decision === 'eoa_mismatch') {
				publishNativePwaLog('warn', '[AppEntryGate] page record is for another account (eoa_mismatch): not used, nothing stored')
				return 'eoa_mismatch'
			}
			if (decision === 'retry') {
				publishNativePwaLog('warn', '[AppEntryGate] page record not decided (native account or store unavailable): retry, nothing used or stored')
				return 'retry'
			}
			if (decision === 'use') return 'none'
			// E7 (2026-11-17): readable, but only a key or an address: not an account. Nothing is copied or written; the pre-read decides.
			if (decision === 'not_account') return 'none'
			//a native-validated copy for this account is the native path; no credential is asked or held here.
			if (copyPreHoldAction(stored, eoa) === 'native') return 'none'
			const answer = await readWalletCredential()
			const action = pageCopyAction({ pageRecordPresent: false, eoa, answer })
			if (action === 'store_blob' && answer.kind === 'credential' && answer.blob) {
				// the page-session key comes from the phrase unsealed for this copy; a mismatch stores nothing.
				const held = holdShellSessionFromPhrase(answer.mnemonic, eoa)
				if (held.kind !== 'ok') {
					publishNativePwaLog('warn', `[AppEntryGate] page copy: the unsealed key is not the native account (${held.code}); nothing stored`)
					return held.code === 'eoa_mismatch' ? 'eoa_mismatch' : 'retry'
				}
				const seed = publicWalletSeed(eoa)
				setCoNET_Data(recoveredPageRecord(seed, answer.mnemonic, answer.blob) as never)
				refreshShellSessionInMemory()
				// 0.53.44: the restore write is the one write allowed while the gate is closed (it completes the restore); the gate opens on its read-back.
				allowRestoreWrite()
				const stored = await storeSystemDataAndWait()
				endRestoreWriteWindow()
				const check = stored ? checkStoredRecord(await readStoredRecordForVerify(), eoa) : 'missing'
				if (check === 'valid') {
					setWritePermit('native_restore', 'page copy from the native wallet read back consistent')
					syncHeldPhraseToShell(answer.mnemonic, eoa)
				} else {
					// the blob path already holds the account; the next start reads the record again. Nothing is shown or deleted.
					publishNativePwaLog('warn', `[AppEntryGate] page copy read-back not confirmed (${check}): sync not sent, the next start reads it again`)
				}
			}
			publishNativePwaLog('info', `[AppEntryGate] page copy from the native wallet: ${action}`)
			return action
		} catch {
			// a failed read or write keeps the native wallet as it is: nothing is stored, and the next start asks again.
			publishNativePwaLog('warn', '[AppEntryGate] page copy from the native wallet: retry (read or write failed)')
			return 'retry'
		}
	}

	/**
	 * Before the native wallet is entered. The page record is read with a bounded wait. A record for another account is not
	 * entered. A record with a sealed credential gives the page-session key: the credential is unsealed, and the derived address
	 * must equal the native account. A recoverable native state is a retry, not an entry. A slow read enters, and the background
	 * copy decides again.
	 */
	const prepareShellEntry = async (eoa: string): Promise<'enter' | 'eoa_mismatch' | 'update_required' | 'unseal_failed' | 'retry' | 'record_unavailable'> => {
		if (shellSessionEoa() && shellSessionEoa() !== eoa.trim().toLowerCase()) releaseShellSessionSignerHold()
		const pre = await checkStorageWithStatusWithTimeout(2_000)
		//a native-validated copy enters on the native path; the sealed credential is not held for it.
		return decidePrepareEntry(pre, eoa, loadShellSessionSigner)
	}

	const blockShellEntry = (outcome: 'eoa_mismatch' | 'update_required' | 'unseal_failed' | 'retry' | 'record_unavailable') => {
		setWritePermit(null, `entry blocked: ${outcome}`)
		if (outcome === 'eoa_mismatch') showStorageUnavailable('eoa_mismatch')
		else if (outcome === 'record_unavailable') showStorageUnavailable('native_record')
		else if (outcome === 'update_required') showStorageUnavailable('app_update_required')
		else if (outcome === 'unseal_failed') showStorageUnavailable('unseal_failed')
		// rule 2026-11-16 (1501): a native store that is not ready is unknown: the startup wait, no retry screen and no retry rounds.
		else startupWait('native store not ready (shell entry pre-check)', 'record_not_ready')
	}

	/** No device copy and walletEoaAddress answers no_key: onboarding only when the native facts confirm it (kPresent false). */
	const enterOnboardingIfNoKeyConfirmed = async (identityState: IdentityCapabilityState): Promise<boolean> => {
		// 1428: a device hint or a private key is not account evidence; the native walletStatus (walletEoaAddress) decides.
		if (identityState !== 'declared') return false
		const answer: WalletEoaAddressAnswer = await readWalletEoaAddress()
		if (answer.kind !== 'refused' || answer.code !== NO_KEY_ERROR) return false
		const entry = decideNoKeyEntry(await readNoKeyFacts(), 'empty')
		publishNativePwaLog('info', `[AppEntryGate] walletEoaAddress no_key with no device copy: ${entry}`)
		if (entry !== 'onboarding') return false
		goOnboarding(false)
		return true
	}

	// Boundary: the local-home early return for identity MISSING is not the iOS not_ready path below.
	/**
	 * The page's mnemonic evidence from IndexedDB. Only a store that was read and holds no valid mnemonic is confirmed_empty; a timeout,
	 * a failure, an unavailable or a locked store is unknown. A hint or a private key is never evidence.
	 */
	// 0.53.43: a session that has read a valid page mnemonic never enters onboarding later in the same page session. Set only
	// by a valid page read; never cleared by a later read (the gate component lives for one page session).
	const sessionSawValidRef = useRef(false)
	const readPageMnemonic = async (): Promise<PageMnemonicEvidence> => {
		try {
			const read = await checkStorageWithTransientRetry()
			// the fallback shell's terminal (confirmed empty, both capabilities absent): the update prompt, never an unknown wait
			const terminal = terminalEvidenceOf(read as { status: string; reason?: string })
			if (terminal) return terminal
			if (read?.status === 'empty') return { kind: 'confirmed_empty' }
			if (read?.status === 'locked') return { kind: 'unknown', locked: true }
			if (read?.status !== 'loaded') return UNKNOWN_PAGE_MNEMONIC
			//a copy validated natively takes the native EOA; the page derives no address from it.
			if (isNativeCopyValidated(read, '')) {
				// no_key is the expected native answer for a validated copy (beamio.ts ~1697): the copy's EOA is taken; any other refusal is unknown.
				const native = await readWalletEoaAddress().catch(() => ({ kind: 'refused' as const, code: 'error' }))
				const evidence = copyPageEvidence(read, native)
				return evidence?.kind === 'valid' ? evidence : UNKNOWN_PAGE_MNEMONIC
			}
			const eoa = validMnemonicEoa(read.data)
			// 0.53.43: a stored phrase that cannot be decoded or derived is unknown (hold, retry), never confirmed_empty.
			const storedPhrase = typeof read.data?.mnemonicPhrase === 'string' ? read.data.mnemonicPhrase.trim() : ''
			if (storedPhrase && !eoa) return UNKNOWN_PAGE_MNEMONIC
			// E7-1 (2026-11-17): the account credential is a valid mnemonic whose derived EOA equals the record's keyID. A mnemonic for another
			// address is not this account's credential: no valid mnemonic here (the pre-read path decides), nothing is used.
			const keyID = typeof read.data?.profiles?.[0]?.keyID === 'string' ? String(read.data.profiles[0].keyID).trim().toLowerCase() : ''
			// 0.53.43: a parseable mnemonic whose EOA differs from the keyID is evidence
			// of a page account: it never leads to onboarding or a write; the start holds with the diagnostic page_mnemonic_keyid_mismatch.
			if (eoa && keyID && keyID !== eoa) return { kind: 'confirmed_empty', keyIdMismatch: true }
			if (eoa) sessionSawValidRef.current = true
			return eoa ? { kind: 'valid', eoa, phrase: String(read.data?.mnemonicPhrase ?? '').trim() } : { kind: 'confirmed_empty' }
		} catch {
			return UNKNOWN_PAGE_MNEMONIC
		}
	}

	/** whether the last reply of the sync was an envelope-level locked (the button is hidden after one). */
	const lastReplyLocked = useRef(false)
	/** The page's local store for the held-write record; null without a window (fail-closed). */
	const failureStore = () => (typeof window === 'undefined' ? null : window.localStorage)
	/** The EOA|phrase pairs this page session has confirmed (ok) or has in flight: a pair is sent once; a failed one may be sent again (item A). */
	const phraseSyncs = useRef<{ confirmed: Set<string>; inFlight: Set<string> }>({ confirmed: new Set(), inFlight: new Set() })
	// Dependency (review b, 2026-11-17): a remount clears this ref, so the same pair may be sent again in a new page session. That is accepted:
	// the native side answers an identical request (same seq and content) with idempotent, which is confirmed here (ok), and writes nothing twice.
	const sendPhraseOnce = async (payload: { phrase: string; eoa: string }): Promise<void> => {
		const key = `${payload.eoa}|${payload.phrase}`
		const sets = phraseSyncs.current
		if (sets.confirmed.has(key) || sets.inFlight.has(key)) return
		sets.inFlight.add(key)
		try {
			const out = await shellMnemonicSync.sync(payload.phrase, payload.eoa)
			const outcome = out as { kind?: string; code?: string; reason?: string } | undefined
			lastReplyLocked.current = outcome?.kind === 'failed' && outcome.code === 'locked'
			if (outcome?.kind === 'synced') {
				sets.confirmed.add(key)
				// 2026-11-20: the native sync of this account is confirmed; the first native record of the account may now be written
				allowFirstNativeWrite(payload.eoa)
				void retryDeferredWriteNow()
				// a confirmed sync for this account clears its held record.
				if (recordMatchesAccount(readFailureRecord(failureStore()), payload.eoa)) clearFailureRecord(failureStore())
			}
			// only write_failed with rollback_pending is recorded (no key material; one entry).
			if (outcome?.kind === 'failed') {
				const rec = recordForFailure({ code: outcome.code ?? '', reason: outcome.reason }, payload.eoa, new Date())
				if (rec) writeFailureRecord(failureStore(), rec)
			}
		} finally {
			sets.inFlight.delete(key)
		}
	}
	/** The read-back check of a restore: the shell compares the keyID (the phrase is never in the shell read-back); the browser keeps the phrase check. */
	const checkStoredRecord = (readBack: Parameters<typeof checkRecoveredRecord>[0], eoa: string) =>
		isShellContext() ? checkShellReadBack(readBack, eoa) : checkRecoveredRecord(readBack, eoa)
	/** The phrase held by this restore goes to the native side once, through pwaWalletSync (the only shell channel for a phrase). */
	const syncHeldPhraseToShell = (phrase: string, eoa: string) => {
		if (!isCashTreesNativeWebView()) return
		const payload = pageSyncPayload({ kind: 'valid', phrase, eoa })
		if (payload) void sendPhraseOnce(payload)
	}
	/**
	 * rule 2026-11-16: after the home is entered, a trusted shell receives the page's valid mnemonic for durable
	 * sync. Browser builds never sync. Not awaited: the route does not wait, and a failed sync never changes it.
	 */
	const syncPageMnemonicToShell = () => {
		if (!isCashTreesNativeWebView()) return
		void readPageMnemonic().then(async (ev) => {
			const payload = pageSyncPayload(ev)
			if (!payload) return
			// a held record of another account is cleared (the account changed).
			const held = readFailureRecord(failureStore())
			if (held && !recordMatchesAccount(held, payload.eoa)) clearFailureRecord(failureStore())
			// C1: the pre-sync read of walletState and walletStatus. Locked, corrupt, unknown or timed out: held (pendingSync), not sent.
			if ((await runSyncPreCheck(queryNativeWalletStateForPreCheck, queryNativeWalletStatusForPreCheck)) === 'pending') {
				markPendingSync('pre_sync_locked_or_unknown')
				publishNativePwaLog('info', '[AppEntryGate] pre-sync: native locked, unknown or timed out: held until the unlock (not sent)')
				return
			}
			void sendPhraseOnce(payload)
		})
	}
	/**
	 * (manual retry of a held write): the record for this account is present. Live walletStatus is read at the click; locked
	 * refuses; a key in flight refuses; the confirmed key is cleared and the pair is sent once. No reread, not limited by unknown or timeout.
	 */
	const manualRetryShellSync = () => {
		if (!isCashTreesNativeWebView()) return
		void readPageMnemonic().then(async (ev) => {
			const payload = pageSyncPayload(ev)
			if (!payload) return
			if (!recordMatchesAccount(readFailureRecord(failureStore()), payload.eoa)) return syncPageMnemonicToShell()
			const st = await queryNativeWalletStatusForPreCheck().catch(() => 'timeout' as const)
			if (st === 'locked') {
				publishNativePwaLog('info', '[AppEntryGate] manual retry refused: native locked (unlock first)')
				return
			}
			const key = `${payload.eoa}|${payload.phrase}`
			if (phraseSyncs.current.inFlight.has(key)) {
				publishNativePwaLog('info', '[AppEntryGate] manual retry refused: a sync for this account is in flight')
				return
			}
			phraseSyncs.current.confirmed.delete(key)
			void sendPhraseOnce(payload)
		})
	}
	// the live inputs of the button's visibility (the rule is pure: manualRetryVisible). Read before rendering the button.
	useEffect(() => {
		setShellSyncManualCheck(async () => {
			if (!isCashTreesNativeWebView()) return false
			const ev = await readPageMnemonic()
			const payload = pageSyncPayload(ev)
			const rec = readFailureRecord(failureStore())
			const st = await queryNativeWalletStatusForPreCheck().catch(() => 'timeout' as const)
			return manualRetryVisible({
				hasRecord: rec !== null,
				accountMatches: payload ? recordMatchesAccount(rec, payload.eoa) : false,
				lastReplyEnvelopeLocked: lastReplyLocked.current,
				hasValidPageMnemonic: payload !== null,
				nativeStatus: st,
			})
		})
		return () => setShellSyncManualCheck(null)
	}, [])
	/**
	 * PWA-RETRY-03: a manual retry of internal_state or storage_write rereads walletEoaAddress first. Unknown does not send;
	 * valid or absent sends. A pair in flight is refused.
	 */
	const rereadThenSync = () => {
		if (!isCashTreesNativeWebView()) return
		void readWalletEoaAddress().then(async (a) => {
			const decision = rereadDecision(a.kind === 'address' ? { kind: 'address' } : a.kind === 'refused' ? { kind: 'refused', code: a.code } : { kind: 'timeout' })
			if (decision === 'hold') {
				publishNativePwaLog('info', '[AppEntryGate] manual retry: reread unknown, not sent')
				return
			}
			const ev = await readPageMnemonic()
			const payload = pageSyncPayload(ev)
			if (!payload) return
			if (phraseSyncs.current.inFlight.has(`${payload.eoa}|${payload.phrase}`)) {
				publishNativePwaLog('info', '[AppEntryGate] manual retry refused: a sync for this account is in flight')
				return
			}
			syncPageMnemonicToShell()
		})
	}
	//the home's "retry sync" re-reads the page's valid mnemonic and syncs again; the home shows the result (shellSyncStatus).
	// a held record for this account takes the manual path (live check, inFlight refusal); otherwise the re-read path.
	useEffect(() => {
		setShellSyncRetry(() => {
			const rec = readFailureRecord(failureStore())
			if (rec) manualRetryShellSync()
			else if (needsReread(getShellSyncState())) rereadThenSync()
			else syncPageMnemonicToShell()
		})
	})
	useEffect(() => () => setShellSyncRetry(null), [])

	/** The EOA of the page's valid mnemonic, or '' for any other answer. For the routes that need only the EOA. Never a hint. */
	const readPageMnemonicEoa = async (): Promise<string> => {
		const evidence = await readPageMnemonic()
		return evidence.kind === 'valid' ? evidence.eoa : ''
	}

	/**
	 * Startup wait: unknown is neither the onboarding nor the home. The splash stays up and the start is read
	 * again after a fixed interval, until a definite answer arrives. Nothing is deleted, overwritten, shown as an error or routed.
	 * Only a confirmed empty page with a confirmed "no such account" from the native side reaches the onboarding.
	 */
	/** 0.53.39: a native lock with no PWA mnemonic: retry with the unlock entry. Never onboarding, never the passcode page. */
	const waitNativeLocked = (reason: string) => {
		publishNativePwaLog('warn', `[AppEntryGate] native locked: retry with the unlock entry (never onboarding): ${reason}`)
		setNativeLockedOffered(true)
		startupWait(`native locked: ${reason}`, 'native_locked')
	}

	const startupWait = (reason: string, code?: StartReasonCode) => {
		setWritePermit(null, `hold: ${reason}`)
		publishNativePwaLog('warn', `[AppEntryGate] ${reason}: startup wait (unknown: nothing deleted, overwritten or routed)${code ? ` ${startReasonLine(code)}` : ''}`)
		nativeWaitRef.current = true
		// rule 2026-11-16 (startup capability): an unknown answer never waits silently for long. See the rounds below.
		startupRoundsRef.current += 1
		// step 5: the splash stays; the visible retry button is offered from the first unknown round. No generic fallback screen. The
		// automatic re-read backs off (2, 4, 8, 16 s, then every 30 s) and never gives up. Nothing is deleted, overwritten or routed.
		const attempt = startupRoundsRef.current
		setSplashVisible(true)
		setStartupRetryOffered(true)
		const delay = startupRetryDelayMs(attempt)
		publishNativePwaLog('info', `[AppEntryGate] startup retry: attempt ${attempt}, next in ${delay} ms`)
		if (startupRetryRef.current === undefined) {
			startupRetryRef.current = window.setTimeout(() => {
				startupRetryRef.current = undefined
				void initRef.current?.()
			}, delay)
		}
	}

	/**
	 * The terminal screen's Retry: one probe, the terminal screen stays while it runs (no splash, no second control). Still empty →
	 * the gate decides the terminal again; any other answer leaves the terminal. Nothing is created, recovered or imported.
	 */
	const retryTerminalOnce = async () => {
		if (terminalProbeRef.current) return
		terminalProbeRef.current = true
		setTerminalProbing(true)
		publishNativePwaLog('info', '[AppEntryGate] terminal: user Retry, one probe (still empty returns to the terminal)')
		requestShellSingleProbe()
		decisionMadeRef.current = false
		nativeWaitRef.current = false
		try {
			await initRef.current?.()
		} finally {
			terminalProbeRef.current = false
			setTerminalProbing(false)
		}
		// the probe left the terminal: the screen is cleared for the answer it reached (the entry, or the wait). Still terminal: unchanged.
		if (!isShellTerminal()) {
			setStorageUnavailable(null)
			// not decided yet (an unknown answer): the splash waits, as the start does; a decided entry hides it
			if (!decisionMadeRef.current) setSplashVisible(true)
		}
	}

	/** The visible retry button: one immediate re-run of the start (the automatic schedule is kept for the next unknown round). */
	const retryStartupNow = () => {
		if (startupRetryRef.current !== undefined) {
			window.clearTimeout(startupRetryRef.current)
			startupRetryRef.current = undefined
		}
		publishNativePwaLog('info', `[AppEntryGate] startup retry: manual (attempt ${startupRoundsRef.current})`)
		void initRef.current?.()
	}

	// step 5: the App's init skip raises this when a start stays unknown; the same visible retry button is then offered.
	useEffect(() => {
		const offer = () => setStartupRetryOffered(true)
		window.addEventListener(STARTUP_RETRY_OFFER_EVENT, offer)
		return () => {
			window.removeEventListener(STARTUP_RETRY_OFFER_EVENT, offer)
			// the pending automatic re-read belongs to this gate: it is cleared on unmount
			if (startupRetryRef.current !== undefined) {
				window.clearTimeout(startupRetryRef.current)
				startupRetryRef.current = undefined
			}
		}
	}, [])

	/**
	 * Spec item 42(2) valid, the 1c write-back (a7e0add): the mnemonic from the native pre-read is written into the page's own record in
	 * the existing format, then read back. Only a read-back that derives this account opens the home (on its EOA); the post-home sync follows
	 * (item 44). A failed hold, write or read-back is a startup wait: nothing is deleted, shown or routed.
	 */
	const adoptPrereadMnemonic = async (phrase: string, eoa: string): Promise<void> => {
		const held = holdShellSessionFromPhrase(phrase, eoa)
		if (held.kind !== 'ok') {
			publishNativePwaLog('warn', `[AppEntryGate] pre-read: the held key is not this account (${held.code}): startup wait`)
			startupWait('pre-read mnemonic not held', 'pre_read_no_hold')
			return
		}
		setCoNET_Data(recoveredPageRecord(publicWalletSeed(eoa), phrase) as never)
		refreshShellSessionInMemory()
		// 0.53.44: the restore write (see restorePageCopy); the gate opens only on a consistent read-back.
		allowRestoreWrite()
		const stored = await storeSystemDataAndWait()
		endRestoreWriteWindow()
		const check = stored ? checkStoredRecord(await readStoredRecordForVerify(), eoa) : 'missing'
		if (check !== 'valid') {
			publishNativePwaLog('warn', `[AppEntryGate] pre-read write-back not confirmed (${check}): startup wait, the next read asks again`)
			startupWait('pre-read write-back not confirmed', 'pre_read_write_back_unconfirmed')
			return
		}
		setWritePermit('native_restore', 'pre-read write-back read back consistent')
		applyLocalWallet(eoa)
		syncHeldPhraseToShell(phrase, eoa)
	}

	const init = async () => {
		//the pre-read answer of this start (unsupported: the native rule does not decide the account; see the judgement below)
		let prereadUnsupported = false
		// /.2: the shell judges the account from `walletState`(the only basis). A native build that does not report it yet
		// answers `not_reported`, and the existing route applies (unchanged 0.52.930 behaviour).
		let shellWalletState: NativeWalletState | 'not_reported' | null = null
		// the passcodeStatus hasKey marker (0.53.39): read with walletState in the judgement below
		let shellHasKey: boolean | 'not_reported' | 'unknown' = 'not_reported'
		let shellWalletStatus: NativeWalletStatus = 'unknown'
		// the identity capability is probed once per start; a missing capability sends no init and shows neither the lock nor the import page.
		let identity: IdentityCapabilityState = 'unanswered'
		let identityDeclared = false
		// rule 2026-11-16 (PWA first): in a shell the page is read before the native side is asked. A valid mnemonic on the page is the
		// one current account: the home opens on its EOA, and the native side is not asked or compared. An unknown read is retryable
		// (never a delete, an overwrite or a popup). Only a confirmed-empty page goes on to the native side below.
		let pageEvidence: PageMnemonicEvidence | null = null
		if (nativeShellRef.current) {
			const first = await withTimeout(readPageMnemonic(), SHELL_PAGE_READ_TIMEOUT_MS, UNKNOWN_PAGE_MNEMONIC)
			pageEvidence = first
			if (first.kind === 'valid') {
				publishNativePwaLog('info', '[AppEntryGate] page mnemonic is valid: the home on the page EOA; the native side is not asked')
				setWritePermit('page_valid_mnemonic', 'page mnemonic valid, EOA is the current account')
				applyLocalWallet(first.eoa)
				// The home is already entered; native chat capability is resolved only after the PWA account is known.
				resolveShellChatCapability()
				// rule 1502: after the home is entered, the trusted shell receives the valid mnemonic for durable sync (never awaited here)
				if (isCashTreesNativeWebView() && first.phrase) void sendPhraseOnce({ phrase: first.phrase, eoa: first.eoa })
				return
			}
			if (first.kind === 'terminal') {
				// the terminal is set before its diagnostic (decideShellTerminal); handleStorageUnavailable shows the screen
				decideShellTerminal(() => publishNativePwaLog('warn', `[AppEntryGate] terminal: fallback shell (shellRecordRead ${shellRecordFallbackLabel()}), page store confirmed empty: update prompt, no retry`))
				handleStorageUnavailable(OLD_SHELL_UPGRADE_REASON)
				return
			}
			if (first.kind === 'unknown') {
				startupWait('page mnemonic unknown (timeout, read failure or unreadable store)', 'read_failed')
				return
			}
		}
		if (nativeShellRef.current) {
			// A native read is allowed only after the page has explicitly confirmed that no valid mnemonic exists.
			// Unknown (including locked, timeout, or read error) returned above without querying the native bridge.
			if (!isTrustedTopFrame()) {
				publishNativePwaLog('warn', '[AppEntryGate] native pre-read not asked: not the trusted top frame; startup wait')
				startupWait('native pre-read not asked (child frame)', 'child_frame_not_trusted')
				return
			}
			identity = await shellIdentityState()
			identityDeclared = identity === 'declared'
			setNativeIdentityCapability(identity)
			identityUnansweredRef.current = identity === 'unanswered'
			if (identity === 'unanswered') {
				identityProbesDoneRef.current = 0
				setIdentityRetryTick((t) => t + 1)
			}
			if (!identityDeclared) {
				// 0.53.39: bridge trust is unknown after the deadline (no identity declared): a retry state with a reason
				// code. Never onboarding, never a new wallet. A slow hello (S25, 9.9 s) before the deadline is a wait, not a failure.
				if (bridgeTrustStartRef.current === undefined) bridgeTrustStartRef.current = Date.now()
				const trust = bridgeTrustState({ identity, elapsedMs: Date.now() - bridgeTrustStartRef.current })
				publishNativePwaLog('warn', `[AppEntryGate] native mnemonic pre-read capability ${identity}: startup wait (bridge trust ${trust.state}${trust.reason ? ` reason=${trust.reason}` : ''})`)
				startupWait(`native mnemonic pre-read capability ${identity}`, bridgeTrustReasonCode(trust.state))
				return
			}
			const pre = await queryNativeMnemonicPreread()
			if (pre.kind === 'valid') {
				publishNativePwaLog('info', '[AppEntryGate] native mnemonic pre-read valid: restoring this account')
				// 0.53.39: the key hold of prepareShellEntry (a held
				// signer for another account is cleared before any entry); the record check is decidePrereadEntry (isNativeCopyValidated).
				if (shellSessionEoa() && shellSessionEoa() !== pre.eoa.trim().toLowerCase()) releaseShellSessionSignerHold()
				const pageCopy = await checkStorageWithStatusWithTimeout(2_000)
				// 0.53.39: a page copy that exists is checked by prepareShellEntry (record and key hold) before any entry.
				// An empty page is not checked (it would block the native restore); the restore write below lands the wallet on the page.
				const pageRoute = prereadPageRoute(pageCopy.status)
				// 0.53.39: an unreadable page copy is unknown: wait and retry with a reason code; the native restore never
				// overwrites a page that may hold the user's own wallet.
				if (pageRoute === 'wait_retry') {
					publishNativePwaLog('warn', '[AppEntryGate] page copy unreadable (reason page_read_failed): unknown, startup wait, no restore over the page')
					startupWait('page read failed (page_read_failed)', 'page_read_failed')
					return
				}
				if (pageRoute === 'check_record') {
					const outcome = await prepareShellEntry(pre.eoa)
					if (outcome !== 'enter') {
						blockShellEntry(outcome)
						return
					}
				}
				await decidePrereadEntry(pageCopy, pre.eoa, () => applyNativeWallet(pre.eoa), () => adoptPrereadMnemonic(pre.phrase, pre.eoa))
				resolveShellChatCapability()
				return
			}
			// 0.53.39: the native start reads walletState and hasKey (passcodeStatus) and walletStatus after the pre-read.
			// It never returns early on an unknown pre-read. The route is decided by nativeStartRoute (pure, tested).
			const passcode = await queryNativePasscodeStatus()
			const status = (await queryNativeWalletStatus()).status as NativeWalletStatus
			const outcome = nativeStartRoute({ pre, walletState: passcode.walletState, hasKey: passcode.hasKey, walletStatus: status })
			publishNativePwaLog('info', `[AppEntryGate] native start route=${outcome.route} ${isStartReasonCode(outcome.reason) ? startReasonLine(outcome.reason) : '[start] reason=unlisted'}`)
			if (outcome.route === 'native_locked') {
				waitNativeLocked('pre-read locked')
				return
			}
			if (outcome.route === 'onboard' && sessionSawValidRef.current) {
				// 0.53.43: this page session has read a valid mnemonic: never onboarding; hold with a retry notice (no write).
				publishNativePwaLog('warn', '[AppEntryGate] session_read_valid_page_mnemonic: native absent, onboarding refused: hold')
				startupWait('page session read a valid mnemonic earlier: hold, not onboarding', 'read_failed')
				return
			}
			if (outcome.route === 'onboard' && pageEvidence?.kind === 'confirmed_empty' && pageEvidence.keyIdMismatch) {
				// 0.53.43: the page holds a parseable mnemonic for another EOA. Hold with a retry notice: no onboarding, no creation, no rewrite.
				publishNativePwaLog('warn', '[AppEntryGate] page_mnemonic_keyid_mismatch: page mnemonic derives another EOA; native absent: hold, no onboarding')
				startupWait('page mnemonic keyid mismatch: hold, not onboarding', 'read_failed')
				return
			}
			if (outcome.route === 'onboard') {
				publishNativePwaLog('info', '[AppEntryGate] native mnemonic pre-read absent, page confirmed empty: onboarding')
				resolveShellChatCapability()
				setStorageUnavailable(null)
				goOnboarding(false)
				return
			}
			if (outcome.route === 'retry') {
				if (pre.kind === 'unknown') publishNativePwaLog('warn', 'native mnemonic pre-read unknown: startup wait')
				startupWait(`native start: ${outcome.reason}`, isStartReasonCode(outcome.reason) ? outcome.reason : 'read_failed')
				return
			}
			// legacy (an old shell without the pre-read command): the shell's judgement below decides, with its own rules. Nothing waits here.
			publishNativePwaLog('info', '[AppEntryGate] pre-read not supported by this shell: legacy judgement (walletStatus route), nothing waits')
			shellWalletState = passcode.walletState
			shellHasKey = passcode.hasKey
			shellWalletStatus = status
			// the legacy route is an old shell with no pre-read: the storage judgement must not treat an absent store as confirmed (storeEmpty)
			prereadUnsupported = true
		}
		try {
			const storageResult = await checkStorageWithTransientRetry()
			if (storageResult.status === 'locked') {
				// Never onboarding while locked: the encrypted wallet must not be replaced.
				publishNativePwaLog('info', '[AppEntryGate] wallet passcode required')
				markDecided()
				setSplashVisible(false)
				setGateDecided(false)
				setVaultLockKind('page')
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
			// 1423/1428 (decision 2026-11-18): only a valid mnemonic is account evidence (`valid_mnemonic`); a private key or an address is not.
			const idb = idbSignalFromRecord(storageResult, (data) => hasValidMnemonic(data as Parameters<typeof hasValidMnemonic>[0]))
			// 0.53.39 (handoff order: IndexedDB, then the trusted native record): the native walletState and hasKey are read here, once.
			// An unreadable answer is `unknown` (retry), never an absent account.
			if (isShellContext()) {
				const passcode = await queryNativePasscodeStatus()
				shellWalletState = passcode.walletState
				shellHasKey = passcode.hasKey
				shellWalletStatus = (await queryNativeWalletStatus()).status as NativeWalletStatus
			}
			//the shell judges by walletState (the only basis when it is reported); the transitional route uses walletStatus only.
			const judged = isShellContext()
				? judgeShellFromNative({
						idb,
						walletState: shellWalletState ?? 'not_reported',
						walletStatus: shellWalletStatus,
						hasKey: shellHasKey,
						//only with the declared identity, and only when the pre-read command answered (or was never needed here as unsupported)
						// Q3 / C4(b) (2026-11-18): the page holds no valid mnemonic (a private key or an address alone included). The record is
						// read (loaded) or empty; only a valid mnemonic is account evidence, so storeEmpty is 'no valid mnemonic on the page'.
						storeEmpty: idb === 'absent' && identityDeclared && !prereadUnsupported,
					})
				: judgeBrowser(idb)
			publishNativePwaLog('info', `[AppEntryGate] account judgement=${judged.account} action=${judged.action}`)
			if (judged.action === 'unlock' && (shellWalletState === 'locked' || shellWalletStatus === 'locked')) {
				waitNativeLocked('judgement: native locked')
				return
			}
			if (judged.action === 'unlock') {
				markDecided()
				setSplashVisible(false)
				setGateDecided(false)
				setVaultLockKind('native')
				setVaultLocked(true)
				return
			}
			if (judged.account === 'undetermined') {
				// (b): in a shell an undetermined answer is the start state (a wait with the retry), never the generic storage-unavailable screen.
				if (isShellContext()) startupWait('account judgement undetermined (shell): the start state, retry', 'read_failed')
				else handleStorageUnavailable('undetermined')
				return
			}
			const presence = judged.account
			// (2026-11-21): a shell not_ready is wait-and-retry: no creation, recovery or import entry (shellNotReadyWait.ts).
			const notReadyWait = shellNotReadyWaitReason({ isShell: isShellContext(), walletStatus: shellWalletStatus, presence })
			if (notReadyWait) {
				startupWait(notReadyWait, 'status_not_no_key')
				return
			}
			// (c) and: a shell enters onboarding only when the IndexedDB side and the native side both confirmed none.
			// Any unknown (or a contradicting "has") is retry: no onboarding, nothing deleted. The gate deletes nothing here.
			// No native side is asked on this path: a native webview has already decided the start above (the pre-read), so here the shell
			// has no identity hello to declare identity.native-keys.v1. Option A: the unified capability notice, never onboarding, never a creation entry.
			//both sides confirmed no account (native no_key, page store empty): onboarding. Read-only; nothing is written or deleted here.
			if (judged.via === 'native_no_key') {
				// 0.53.39: before onboarding the sealed copy is checked (the same native pre-read as the start).
				// valid: restore; locked: the passcode page; unknown or unreadable: retry; absent (confirmed): onboarding.
				const sealed = await queryNativeMnemonicPreread()
				const route = nativeNoKeyRoute(sealed)
				publishNativePwaLog('info', `[AppEntryGate] shell no_key: sealed-copy check route=${route}`)
				if (route === 'onboard') {
					setStorageUnavailable(null)
					noKeyCtl.storageRead(true)
					goOnboarding(false)
					return
				}
				if (route === 'restore' && sealed.kind === 'valid') {
					// 0.53.39: the sealed-copy restore is the same as the pre-read valid path. An unreadable page
					// waits (never overwritten); an existing page copy is checked by prepareShellEntry; an empty page is restored by the restore write.
					const sealedCopy = await checkStorageWithStatusWithTimeout(2_000)
					const sealedRoute = prereadPageRoute(sealedCopy.status)
					if (sealedRoute === 'wait_retry') {
						publishNativePwaLog('warn', '[AppEntryGate] sealed-copy restore: page copy unreadable (reason page_read_failed): unknown, startup wait, no restore over the page')
						startupWait('sealed-copy restore: page read failed (page_read_failed)', 'page_read_failed')
						return
					}
					if (sealedRoute === 'check_record') {
						const sealedOutcome = await prepareShellEntry(sealed.eoa)
						if (sealedOutcome !== 'enter') {
							blockShellEntry(sealedOutcome)
							return
						}
					}
					await decidePrereadEntry(sealedCopy, sealed.eoa, () => applyNativeWallet(sealed.eoa), () => adoptPrereadMnemonic(sealed.phrase, sealed.eoa))
					return
				}
				if (route === 'native_locked') {
					waitNativeLocked('sealed-copy check locked')
					return
				}
				startupWait('shell no_key: sealed-copy check unknown', 'sealed_copy_unknown')
				return
			}
			// Q3 (2026-11-18): a shell no_account no longer shows the capability notice; the no-record case goes on to the onboarding rules
			// below, which still require an explicit native no_key in the shell.
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
				// 0.53.44: a valid mnemonic whose EOA is the record's keyID opens the gate (point 1); anything else keeps it closed.
				if (hasMnemonic && validMnemonicEoa(CoNETData) === String(CoNETData?.profiles?.[0]?.keyID ?? '').trim().toLowerCase()) {
					setWritePermit('page_valid_mnemonic', 'record: valid mnemonic, keyID consistent')
				}
				// 0.53.44 open point (c): a browser key-only copy of an established account (not in hold, not a recovery) opens the gate.
				if (!isShellContext() && !hasMnemonic) setWritePermit('browser_key_only_established', 'browser key-only copy of an established account')
				enterApp()
				notifyShellEntry('page-wallet')
				return
			}
			// rule 2026-11-16: in a shell the onboarding needs an explicit walletStatus no_key. A not_ready or unknown
			// native answer with an empty page is unknown, never a new account: the startup wait (nothing deleted, shown or routed).
			if (isShellContext() && !isExplicitNativeNoKey(shellWalletStatus)) {
				startupWait(`shell onboarding needs an explicit walletStatus no_key (got ${shellWalletStatus})`, 'status_not_no_key')
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

	// the retry screen's button and its timer call the latest init
	initRef.current = init

	// the identity hello is unanswered: it is probed again after 10 s, then 30 s, then every 60 s. Stops once it answers.
	useEffect(() => {
		if (!identityUnansweredRef.current || identityProbesDoneRef.current >= BRIDGE_HELLO_MAX_PROBES) return
		const id = window.setTimeout(() => {
			identityProbesDoneRef.current += 1
			void probeIdentityNow().then(() => {
				// : the bridge cadence never routes the wallet. After the last probe it stops; a manual retry or a later answer continues.
				if (!identityUnansweredRef.current || identityProbesDoneRef.current < BRIDGE_HELLO_MAX_PROBES) return
				publishNativePwaLog('warn', '[AppEntryGate] identity hello still unanswered after the bridge probe cap: probes stop (bridge only, no route change)')
			})
		}, identityProbeDelayMs(identityProbesDoneRef.current))
		return () => window.clearTimeout(id)
	}, [identityRetryTick])

	// a manual retry (the identity hint or the retry screen) runs the init again: the page is read first, then the hello, and an unanswered
	// hello restarts the bridge cadence from zero.
	useEffect(
		() =>
			onNativeIdentityRetryRequested(() => {
				identityProbesDoneRef.current = 0
				void initRef.current?.()
			}),
		[],
	)

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
				// The decision was made before the deadline: the timer only hides the splash (no screen or storage change).
				publishNativePwaLog('info', `[AppEntryGate] splash deadline ${SPLASH_FORCE_DISMISS_MS}ms after a decision: splash hidden, nothing else changed`)
				return
			}
			publishNativePwaLog(
				'warn',
				`[AppEntryGate] splash force-dismiss after ${SPLASH_FORCE_DISMISS_MS}ms → storage unavailable (retry; never onboarding)`,
			)
			// S25 (2026-11-15): an undecided start at the deadline is a startup in progress, not an unreadable store. It shows the
			// retryable state (never onboarding, no record is judged, nothing is written). The retry re-runs the identity probe and the init.
			if (nativeShellRef.current || isCashTreesNativeWebView()) {
				publishNativePwaLog('warn', `[AppEntryGate] splash deadline ${SPLASH_FORCE_DISMISS_MS}ms, start undecided: retryable state`)
				showStorageUnavailable(NATIVE_RETRY_SCREEN)
				return
			}
			handleStorageUnavailable('timeout')
		}, SPLASH_FORCE_DISMISS_MS)

		// A wallet-ready event follows a creation or a restore: from now on a late no_key never takes over.
		const onWalletReady = () => {
			markWalletEstablished()
			setSplashVisible(false)
		}
		window.addEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)
		// a native ok answer (creation or restore) establishes the wallet at once, synchronously.
		const onNativeWalletEstablished = () => markWalletEstablished()
		window.addEventListener(NATIVE_WALLET_ESTABLISHED_EVENT, onNativeWalletEstablished)
		// Late-arrival case: while a native create or recovery page is open, a late no_key does not cover it with the import route.
		const onNativeFlowPending = (e: Event) => {
			if ((e as CustomEvent<{ open?: boolean }>).detail?.open) noKeyCtl.beginNativeFlow()
			else noKeyCtl.endNativeFlow()
		}
		window.addEventListener(NATIVE_FLOW_PENDING_EVENT, onNativeFlowPending)

		// A native ready event re-runs the same PWA-first gate. An address or status alone never enters the app.
		const onNativeWalletReady = () => { void initRef.current?.() }
		window.addEventListener(NATIVE_WALLET_READY_EVENT, onNativeWalletReady)

		// Sign-out with a passcode set: drop the app content and ask for the passcode again.
		const onVaultLocked = () => {
			releaseShellSessionSignerHold()
			markDecided()
			setSplashVisible(false)
			setGateDecided(false)
			setVaultLockKind('native')
			setVaultLocked(true)
		}
		window.addEventListener(VAULT_LOCKED_EVENT, onVaultLocked)

		// Native key state: a shell with no key for the account answers `no_key`; show the import route.
		//an unlock releases a held init once (HC-LOCK INIT-3); the native answer, not this event, decides a lock.
		const removePasscodeWatcher = nativeShell ? installPasscodeStateWatcher((state) => {
			if (state.locked) return
			releaseInitLockedHold()
			// C1: an unlock resumes a held sync exactly once (the take clears it).
			if (takePendingSync()) syncPageMnemonicToShell()
		}) : null
		const removeNoKeyWatcher = nativeShell ? installNativeNoKeyWatcher(() => {
			// Race (3.3): the import route only after the gate has decided and found no page account.
			if (!noKeyCtl.onNativeNoKey()) return
			// rule (b), spec item 42(2): both sides confirmed no mnemonic. The existing onboarding holds the two recovery entries; no import route.
			goOnboarding(false)
		}) : null
		// G0 (walletStatus no_key) is decided by init below: the onboarding shows "Get started" and the native recovery entry.
		// The import route is not shown for G0 (round 27; the import page has no recovery entry).

		setIsInitialLoading(true)
		void init()

		return () => {
			removeNoKeyWatcher?.()
			removePasscodeWatcher?.()
			window.clearTimeout(splashTimer)
			window.removeEventListener(BEAMIO_WALLET_READY_EVENT, onWalletReady)
			window.removeEventListener(NATIVE_WALLET_ESTABLISHED_EVENT, onNativeWalletEstablished)
			window.removeEventListener(NATIVE_FLOW_PENDING_EVENT, onNativeFlowPending)
			window.removeEventListener(NATIVE_WALLET_READY_EVENT, onNativeWalletReady)
			window.removeEventListener(VAULT_LOCKED_EVENT, onVaultLocked)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// A refused build on a background shell write shows the update screen, the same screen a refused read shows.
	useEffect(() => onAppUpdateRequired(() => showStorageUnavailable('app_update_required')), [])

	// while the wallet is not initialised, the native state is read again every 30 s, so the init retries once
	// the node list is reachable. Reaching G2 hands the app the native wallet.
	useEffect(() => {
		const id = window.setInterval(() => {
			if (!localModeRef.current) return
			// read again only once the capability is declared: a missing, refused or unanswered hello keeps the local home.
			void shellIdentityState().then(async (cap) => {
				if (cap !== 'declared') return
				const native = await reachNativeWallet()
				if (native.status === 'unlocked') {
					notifyNativeWalletReady('')
					return
				}
				// an address mismatch ends the local home for the recovery entry.
				if (takeInitRefusal() === 'address_mismatch') {
					localModeRef.current = false
					setStorageUnavailable('native_recovery_needed')
				}
			})
		}, 30_000)
		return () => window.clearInterval(id)
	}, [])

	return (
		<div className="flex h-full min-h-[100dvh] w-full flex-col">
			<EmbeddedPwaUpdateBanner />
			{/* One retry control at a time (the G1 page showed Try again and Retry): while any start screen of the gate is shown, the identity prompt is not mounted.
			    The hold page shows only the gate's retry, the unlock control when locked, and the restore button below. */}
			{!storageUnavailable && !(splashVisible && startupRetryOffered) && <IdentityEntryPrompt />}
			{splashVisible && <SplashScreen />}
			{splashVisible && startupRetryOffered && (
				<div className="fixed inset-x-0 bottom-10 z-[60] flex justify-center gap-3">
					<button type="button" className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]" onClick={retryStartupNow}>
						{tu('native_not_ready_retry_action')}
					</button>
					<button
						type="button"
						className="rounded-full border border-white px-5 py-2.5 text-sm font-semibold text-white"
						onClick={openRestoreFromHold}
					>
						{tu('restore_wallet')}
					</button>
					{nativeLockedOffered && (
						<button
							type="button"
							className="rounded-full border border-white px-5 py-2.5 text-sm font-semibold text-white"
							onClick={() => {
								setNativeLockedOffered(false)
								setVaultLockKind('native')
								setVaultLocked(true)
							}}
						>
							{tu('unlock_wallet')}
						</button>
					)}
				</div>
			)}
			{vaultLocked ? (
				<PasscodeLockScreen
					lock={vaultLockKind}
					onNativeMismatch={() => blockShellEntry('eoa_mismatch')}
					onUnlocked={() => {
						setVaultLocked(false)
						setSplashVisible(true)
						// claims the chat start for this unlock before init(): the App's start runs once (src/services/unlockChatRestart.ts)
						requestChatRestartAfterUnlock()
						void init()
					}}
				/>
			) : storageUnavailable ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
					<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
						{storageUnavailable === MIGRATION_RETRY_SCREEN ? (
							<>
								<h1 className="text-xl font-semibold">{tu('migration_retry_title')}</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">{tu('migration_retry_body')}</p>
								<button
									type="button"
									className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
									onClick={() => {
										nativeRetryAttemptRef.current = 0
										setStorageUnavailable('')
										void init()
									}}
								>
									{tu('migration_retry_action')}
								</button>
							</>
						) : storageUnavailable === 'native_reading' ? (
							<>
								<h1 className="text-xl font-semibold">{tu('native_reading_title')}</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">{tu('native_reading_body')}</p>
								<button
									type="button"
									className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
									onClick={() => {
										setStorageUnavailable('')
										void init()
									}}
								>
									{tu('native_reading_action')}
								</button>
							</>
						) : storageUnavailable === NATIVE_RETRY_SCREEN ? (
							<>
								<h1 className="text-xl font-semibold">{tu('native_not_ready_retry_title')}</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">{tu('native_not_ready_retry_body')}</p>
								<button
									type="button"
									className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126]"
									onClick={() => requestNativeIdentityRetry()}
								>
									{tu('native_not_ready_retry_action')}
								</button>
							</>
						) : storageUnavailable === OLD_SHELL_UPGRADE_REASON ? (
							<>
								<h1 className="text-xl font-semibold">{tu('old_shell.terminal.title')}</h1>
								<button type="button" disabled={terminalProbing} className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60" onClick={() => void retryTerminalOnce()}>
									{tu('retry')}
								</button>
							</>
						) : storageUnavailable === 'app_update_required' ? (
							<>
								<h1 className="text-xl font-semibold">{tu('app_update_required_title')}</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">{tu('app_update_required_body')}</p>
							</>
						) : storageUnavailable === 'unseal_failed' ? (
							<>
								<h1 className="text-xl font-semibold">The wallet key could not be unlocked on this device</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">
									The native wallet did not confirm the key for this account. Nothing was used or created.
								</p>
							</>
						) : storageUnavailable === 'eoa_mismatch' ? (
							<>
								<h1 className="text-xl font-semibold">The wallet record on this device is for another account</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">
									The wallet record stored on this device does not match the account in the native wallet.
									Nothing was used or deleted, and no new wallet was created.
								</p>
							</>
						) : storageUnavailable.startsWith('native_wallet_') ? (
							<>
								<h1 className="text-xl font-semibold">Native wallet is not ready</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">
									The native wallet has not confirmed this account yet.
									Your data was not deleted. Retry, or restart the app later.
								</p>
							</>
												) : storageUnavailable === 'native_recovery_needed' ? (
							<>
								{/* A recovery-oriented title (the native wallet restores its key). Manual Retry only. */}
								<h1 className="text-xl font-semibold">{tu('native_restore_title')}</h1>
								<p className="mt-3 text-sm leading-6 text-white/75">{tu('native_restore_body')}</p>
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
									{/* the only recovery entry here is the recovery code (the import route is retired). */}
									<button
										type="button"
										className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#071126]"
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
						{storageUnavailable !== OLD_SHELL_UPGRADE_REASON && (
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
						)}
					</div>
				</div>
			) : showBeamioOnboardingModal ? (
				<BeamioOnboardingModal
					requireWalletRecover={requireWalletRecover}
					openRestoreFromHold={restoreFromHold}
					requireBeamioTagCreate={requireBeamioTagCreate}
					onNewAccountCreated={() => setWritePermit('new_account_created', 'onboarding: new account created')}
					onRestoreWriteStart={onRestoreWriteStart}
					onRestoreWriteEnd={onRestoreWriteEnd}
					bootResolved={bootResolved}
					bootCoNETData={bootCoNETData}
					home={() => {
						setShowBeamioOnboardingModal(false)
						setRequireWalletRecover(false)
						setRestoreFromHold(false)
						setSplashVisible(false)
						// in a shell the bar waits for the App's init to load the account, as on enterApp (no clear here).
						if (!isShellContext()) setIsInitialLoading(false)
						// onboarding / recover 成功后允许进入主 App。
						markBootScreen('home')
						setGateDecided(true)
						// rule 2026-11-16 (spec 44(1)(c)): onboarding success enters the home, then the page mnemonic is synced to the shell
						syncPageMnemonicToShell()
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
