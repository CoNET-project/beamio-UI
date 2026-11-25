/**
 * 全应用入口门闸：本地未完成 Beamio 初始化（与 pages/Home/index 原逻辑一致）时，
 * 先 Splash + BeamioOnboardingModal，任意深层路由（/wallet、/Chat 等）均不可跳过。
 */
import { useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useDaemonContext } from '@/providers/DaemonProvider'
import { purgeKeyOnlyPageRecord, checkStorageWithStatus, checkStorageWithStatusWithTimeout, checkStorageWithTransientRetry, persistPageIdbMnemonic, registrationStateVia, persistPageIdbPasscodeRecord, readStoredRecordForVerify, sendPendingProfileSync, storeSystemDataAndWait } from '@/services/beamio'
import { allowRestoreWrite, endRestoreWriteWindow, setPageWritePermit, type PageWritePermit } from '@/services/beamio'
import { checkRecoveredRecord, checkShellReadBack, recoveredPageRecord } from '@/services/recoveredMnemonicRecord'
import { releaseShellSessionSignerHold, holdShellSessionFromPhrase, loadShellSessionSigner, recordCarriesAccountKey, refreshShellSessionInMemory, shellSessionEoa } from '@/services/shellSessionSigner'
import { pageCopyAction, readWalletCredential, type PageCopyAction } from '@/services/walletCredential'
import { decidePageRecord, type PageRecordRead } from '@/services/pageRecordDecision'
import { onAppUpdateRequired } from '@/services/appUpdatePrompt'
import { OLD_SHELL_UPGRADE_REASON, shellRecordFallbackLabel, terminalEvidenceOf } from '@/services/shellRecordFallback'
import { decideShellTerminal, isShellTerminal, requestShellSingleProbe } from '@/services/shellTerminalState'
import { createColdStartBackoff, type ColdStartKey } from '@/services/coldStartBackoff'
import { registerPendingSender } from '@/services/pendingServerSync'
import { allowFirstNativeWrite, resumeDeferredWrite, retryDeferredWriteNow } from '@/services/shellRecordStore'
import { installNativeNoKeyWatcher, NO_KEY_ERROR } from '@/services/nativeKeyState'
import { markPendingSync, takePendingSync } from '@/services/pendingSync'
import { runSyncPreCheck } from '@/services/syncPreCheck'
import { clearFailureRecord, manualRetryVisible, readFailureRecord, recordForFailure, recordMatchesAccount, writeFailureRecord } from '@/services/pwaSyncFailureRecord'
import { getShellSyncState, setShellSyncManualCheck } from '@/services/shellSyncStatus'
import { needsReread, rereadDecision } from '@/services/manualRetryReread'
import { queryNativeWalletStatusForPreCheck } from '@/services/syncPreCheckReads'
import { forgetPersistedShellEoa } from '@/services/shellIdentitySource'
import { clearPendingCreateTag } from '@/services/pendingCreateTag'
import { classifyPageKeyState } from '@/services/pageRecordKeyState'
import { installPasscodeStateWatcher } from '@/services/passcodeStateWatch'
import { decideNoKeyEntry, readNoKeyFacts } from '@/services/noKeyEntry'
import { cleanupAfterVerifiedRecovery, readCleanupPending, startCleanupAfterRecovery } from '@/services/accountCleanupPending'
import { AppEntryNoKeyController } from './appEntryNoKeyController'
import { NATIVE_WALLET_ESTABLISHED_EVENT } from '@/services/nativeWalletEstablished'
import { NATIVE_FLOW_PENDING_EVENT } from '@/services/nativeFlowPending'
import { startPgpMigrationOnce } from '@/services/pgpMigrationRunner'
import { ensureShellChatState } from '@/services/shellChatCapability'
import { beamioTagCreateNeeded, idbSignalFromRecord, judgeBrowser, judgeLocalOnly, judgeShellFromNative, type NativeWalletState, type NativeWalletStatus } from '../services/accountJudgement'
import { queryNativeMnemonicPreread, queryNativePasscodeStatus, type MnemonicPreread } from '../services/nativeRecovery'
import { capNativeRead } from '../services/nativeReadDeadline'
import { bridgeTrustReasonCode, bridgeTrustState, nativeNoKeyRoute, nativeStartRoute, prereadPageRoute } from '../services/accountJudgement'
import { isStartReasonCode, startReasonLine, type StartReasonCode } from '../services/startReasonCodes'
import { queryNativeWalletStateForPreCheck } from '@/services/syncPreCheckReads'
import { identityCapabilityFrom, identityEntryDisplay, shellEntryFor, type IdentityCapabilityState } from '@/services/shellEntryDecision'
import { identityProbeDelayMs, onNativeIdentityRetryRequested, requestNativeIdentityRetry, setNativeIdentityCapability } from '@/services/nativeIdentityProbeRetry'
import { onHelloValid, probeNativeCapabilities, requestNativeAck } from '@/services/nativeChatRouteRegister'
import { validNativeApp } from '@/services/callCapability'
import { reportUiLocked } from '@/services/passcode/uiLockState'
import { IDENTITY_CAPABILITY_MISSING } from '@/services/bridgeGuard'
import { shellNotReadyWaitReason } from '@/services/shellNotReadyWait'
import { NATIVE_WALLET_READY_EVENT, notifyNativeWalletReady, publicWalletSeed, reachNativeWallet, releaseInitLockedHold, rememberNativeEoa, takeInitRefusal } from '@/services/nativeWallet'
import { readWalletEoaAddress, type WalletEoaAddressAnswer } from '@/services/walletEoaAddress'
import { shellMnemonicSync } from '@/services/shellMnemonicSync'
import { markBootScreen } from '@/services/bootTrace'
import { setCoNET_Data } from '@/utils/globals'
import PasscodeLockScreen from '@/components/PasscodeLockScreen'
import { PrereadPasscodeUnlock } from '@/components/PrereadPasscodeUnlock'
import { nativePrereadRoundInFlight } from '@/services/prereadRound'

import { VAULT_LOCKED_EVENT } from '@/services/walletVaultEvents'
import { lockChatAccess } from '@/services/passcode/chatAccessGuard'
import SplashScreen from '@/components/SplashScreen'
import { EmbeddedPwaUpdateBanner } from '@/components/EmbeddedPwaUpdateBanner'
import IdentityEntryPrompt from '@/components/IdentityEntryPrompt'
import ResumeNoticeCard from '@/components/ResumeNoticeCard'
import { CONET_RPC_SECONDARY, CONET_RPC_URL } from '@/config/chainAddresses'
import { flushQueuedResume, hasPendingCreateRecord, hasResumeFired, clearResumeFired, hasQueuedResume, markResumeFired, registerResumeBusyProbe, requestResumeRoute, resumeCreateCheck, type ResumeDeps, type ResumeVerdict } from '@/services/resumeCreate'
import { pushResumeNotice } from '@/services/resumeNotice'
import BeamioOnboardingModal from '@/pages/Home/LoadingPage'
import { isCashTreesNativeWebView } from '@/utils/cashTreesNativeNfc'
import { setSyncPendingHandler } from '@/services/passcode/syncPendingHandoff'
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
import { splashDeadlineAction } from '@/services/shellStoreWait'
import { type NativeWalletStatusAnswer } from '@/services/accountPresence'
import { nativeRecoveryCopyKey, nativeRecoveryOpen, onNativeRecoveryResult, queryNativeWalletStatus, recoveryOpenErrorKey } from '@/services/nativeRecovery'
import { announceNativeWalletEstablished } from '@/services/nativeWalletEstablished'
import { tu } from '@/locale/beamioLocale'
import { isIosNativeShell } from '@/services/nativeIosShell'
import { ensureEphemeralWalletForCouponClaim } from '@/utils/ephemeralCouponClaimWallet'
import { BEAMIO_WALLET_READY_EVENT, dispatchBeamioWalletReady } from '@/utils/beamioWalletReadyEvent'
import { requestChatRestartAfterUnlock } from '@/services/unlockChatRestart'
import { startupRetryDelayMs, STARTUP_RETRY_OFFER_EVENT } from '@/services/startupRetryPolicy'
import { passcodeNotProvidedEffect } from '@/services/shellStoreWait'
import { pageSyncPayload } from '@/services/shellMnemonicSync'
import { isMnemonicCipherEnvelope, pageMnemonicField } from '@/services/pageMnemonicField'
import { isTrustedTopFrame } from '@/utils/androidChatChannel'
import { copyPageEvidence, copyPreHoldAction, decidePrepareEntry, decidePrereadEntry, isNativeCopyValidated } from '@/services/copyValidatedEntry'
import { setShellSyncRetry } from '@/services/shellSyncStatus'

/** Unit (b): the first re-request of an unknown pre-read (the Android first call only starts the read). Later unknowns back off (startupRetryPolicy). */
const PREREAD_QUICK_RETRY_MS = 750

/** HC-LOCK: the wait between checks while the native side is locked (the unlock re-runs the gate sooner, R-21). */
const NATIVE_LOCKED_RETRY_MS = 30_000

const isExplicitNativeNoKey = (status: NativeWalletStatus): boolean => status === 'no_key'

const SPLASH_FORCE_DISMISS_MS = 12_000
const EPHEMERAL_WALLET_TIMEOUT_MS = 8_000
/** The shell entry's page-storage read limit (the same 2 s as the shell pre-check). A read past it is unknown: never the local home. */
const SHELL_PAGE_READ_TIMEOUT_MS = 2_000
/**
 * Y.159 A(6): the identity hello (the bridge connection) is probed again on the cadence (10 s, 30 s, then every 60 s). The cadence is
 * bridge-only: it never decides the wallet route. After this many probes it stops; the retry screen stays.
 */
const BRIDGE_HELLO_MAX_PROBES = 5

/**
 * The page's mnemonic evidence. `valid`: the page holds a valid mnemonic, and its EOA is the one current
 * account. `confirmed_empty`: the page store was read and holds no valid mnemonic. `unknown`: a timeout, a failure or an unreadable store
 * (a passcode-locked store is unknown with `locked`). Unknown is never empty: nothing is deleted, overwritten or shown as an error.
 */
type PageMnemonicEvidence = { kind: 'valid'; eoa: string; phrase: string; nativeValidated?: boolean } | { kind: 'confirmed_empty'; keyIdMismatch?: boolean } | { kind: 'unknown'; locked?: boolean; reason?: string } | { kind: 'terminal' } | { kind: 'recovery' } | { kind: 'valid_cipher'; eoa: string; cipher: Record<string, unknown> }
const UNKNOWN_PAGE_MNEMONIC: PageMnemonicEvidence = { kind: 'unknown' }
/** Diagnostic code of a storage reason on a shell background wait (the codes of START_REASON_CODES; an unlisted reason is read_failed). */
const SHELL_WAIT_CODE: Record<string, StartReasonCode> = {
	storage_locked: 'storage_locked',
	ambiguous_accounts: 'ambiguous_accounts',
	not_ready_persistent: 'not_ready_persistent',
	unreadable: 'unreadable_nonretryable',
	read_error: 'record_unreadable',
	invalid_document: 'record_unreadable',
}
const shellWaitCodeOf = (reason?: string): StartReasonCode => (reason !== undefined && SHELL_WAIT_CODE[reason]) || 'read_failed'
/** The shell pre-read's per-round limit marker (never a read result). */
const PREREAD_TIMED_OUT = Symbol('preread-timed-out')

/** Unit (b) diagnostics: one reqId per start (status codes only: never a phrase, a key or a full bridge answer). */
let startReqCounter = 0
const newStartReqId = (): string => {
	startReqCounter += 1
	return `s${startReqCounter.toString(36)}`
}
const logStartRoute = (reqId: string, route: 'home' | 'onboarding' | 'none_yet'): void => {
	publishNativePwaLog('info', `[startup] reqId=${reqId} final_route=${route}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			window.setTimeout(() => resolve(fallback), ms)
		}),
	])
}



/** The page's IDB-derived account address (profiles[0].keyID), read once through the read-only probe; null when not readable (v191 §211). */
async function readPageDerivedAddress(): Promise<unknown> {
	const r = await checkStorageWithStatus({ probe: true })
	if (r.status !== 'loaded') return null
	const profiles = (r.data as { profiles?: Array<{ keyID?: unknown }> } | null)?.profiles
	return profiles?.[0]?.keyID ?? null
}

/**
 * Shell reasons that keep their own screen. Everything else in the shell is a background wait (0.53.44 two-landing rule).
 * PENDING_DECISION (project owner): storage_locked, ambiguous_accounts and not_ready_persistent have no final landing yet. They are not listed
 * here, so they stay background waits with their diagnostic code.
 */
const SHELL_SCREEN_REASONS: ReadonlySet<string> = new Set([OLD_SHELL_UPGRADE_REASON, 'app_update_required', IDENTITY_CAPABILITY_MISSING])

export default function AppEntryGate() {
	const { setIsInitialLoading } = useDaemonContext()
	// Passcode lock (D19): the wallet is encrypted with a passcode and not unlocked yet. No app content mounts.
	// (items 2 and 3): the native no-key decision lives in one controller; the component forwards events.
	const [noKeyCtl] = useState(() => new AppEntryNoKeyController())
	const boundedNotReadyRef = useRef(0)
	/** the cold-start backoff of a not_ready read (1, 2, 4, 8, 16 s, then every 16 s, a 60 s window; PROTOCOL-cold-start-retry-backoff) */
	const coldBackoffRef = useRef(createColdStartBackoff())
	/** after the 180 s window is used up: a read-only ask every 30 s while the page is visible and in the foreground */
	const visiblePollRef = useRef<number | undefined>(undefined)
	const stopVisiblePoll = () => {
		if (visiblePollRef.current !== undefined) window.clearInterval(visiblePollRef.current)
		visiblePollRef.current = undefined
	}
	const startVisiblePoll = () => {
		if (visiblePollRef.current !== undefined) return
		visiblePollRef.current = window.setInterval(() => {
			if (document.visibilityState !== 'visible') return
			void initRef.current?.()
		}, 30_000)
	}
	/** Unit g (rev): a native passcode_not_provided answer marks a pending sync. It never changes the landing, the splash or the counters. */
	const passcodePendingSyncRef = useRef(false)
	/** Unit (b) item 3: the first unknown pre-read of a start sequence was re-requested at once (not a verdict). Once per sequence: cleared only by a decision. */
	const quickPrereadRetryRef = useRef(false)
	const markDecided = () => {
		boundedNotReadyRef.current = 0
		coldBackoffRef.current.reset()
		stopVisiblePoll()
		quickPrereadRetryRef.current = false
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
	// rev2 §3.2: every UI lock (including the hot-restore lock) reports uiLockState {locked:true}. The native session is not touched.
	useEffect(() => {
		if (!vaultLocked) return
		void probeNativeCapabilities()
			.then((p) => reportUiLocked(p.answered ? p.capabilities : [], (cmd) => requestNativeAck(cmd, 5000)))
			.catch(() => undefined)
	}, [vaultLocked])
	// R-16: which lock is showing. A native-side lock hides "Forgot passcode?"; the page-storage lock keeps it.
	const [vaultLockKind, setVaultLockKind] = useState<'page' | 'native'>('page')
	const [showBeamioOnboardingModal, setShowBeamioOnboardingModal] = useState(false)
	const [requireWalletRecover, setRequireWalletRecover] = useState(false)
	/** a key without a BeamioTag opens the Create Beamio ID page directly. */
	const [requireBeamioTagCreate, setRequireBeamioTagCreate] = useState(false)
	/** 0.53.51: an interrupted onboarding create to resume: the wallet and the tag the create page locks (R2271-DEF-CREATE-RESUME-1). */
	const [resumeCreate, setResumeCreate] = useState<{ eoa: string; tag: string } | null>(null)
	const [splashVisible, setSplashVisible] = useState(true)
	// 门闸是否已判定「可进入主 App」。判定完成前绝不渲染 <Outlet/>（不依赖 Splash 遮挡）。
	const [gateDecided, setGateDecided] = useState(false)
	// 门闸已读到的本地存储快照（含超时降级结果），下传给 onboarding 弹窗避免二次读 IndexedDB 再次挂起。
	const [bootCoNETData, setBootCoNETData] = useState<encrypt_keys_object | null>(null)
	const [bootResolved, setBootResolved] = useState(false)
	const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null)
	/** an error line for the native recovery exit on the unavailable screen (existing copy keys only). */
	const [nativeRecoveryNotice, setNativeRecoveryNotice] = useState('')
	// QA boot marker (request) : the splash is the first screen of every launch. Only a QA build prints it.
	useEffect(() => {
		markBootScreen('splash')
	}, [])
	// decision: the silent cleanup of the old account is part of this version. A pending cleanup from an
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
				// silent cleanup: only a verified recovery (native ok and the page's derived address agrees) starts it; any other
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
	/** ②: an adoption (the write-back and its read-back) that has started is not interrupted by the splash deadline. */
	const adoptionInFlightRef = useRef(false)
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
	// unit (c), 2026-11-22: false once this gate unmounts. An unmounted gate starts no read, no retry and no wake-up (a late answer of its
	// earlier read is then not sent into the next page session). Declared before the effects that may start a start round.
	const gateMountedRef = useRef(false)
	useEffect(() => {
		gateMountedRef.current = true
		return () => {
			gateMountedRef.current = false
		}
	}, [])
	const nativeShellRef = useRef(false)
	/** 0.53.39: when the bridge trust wait began (the first start without a declared identity). */
	const bridgeTrustStartRef = useRef<number | undefined>(undefined)
	/** attempts of the native store's not-ready retry (a backoff that is never given up; reset when the store reads). */
	/** true while the native store is not ready (a migration): the splash deadline keeps the wait, never the unavailable screen. */
	const startupRoundsRef = useRef(0)
	/** r92 step 5: the visible retry button of an unknown start (shown from the first unknown round on, until a decision). */
	const [startupRetryOffered, setStartupRetryOffered] = useState(false)
	/** spec item 4: the pre-read returned the current v3 ciphertext (no plaintext). The passcode page decrypts it; nothing is written before that. */
	const [prereadCipher, setPrereadCipher] = useState<{ cipher: unknown; reqId: string } | null>(null)
	/** 2026-11-21: the hold page's restore button opened the existing restore screen (RestoreWalletUnifiedScreen) directly. */
	const [restoreFromHold, setRestoreFromHold] = useState(false)
	// the terminal screen's one Retry: while its probe runs the control is disabled (no second probe, no second control)
	const [terminalProbing, setTerminalProbing] = useState(false)
	const terminalProbeRef = useRef(false)
	/** 0.53.39 (rule 2026-11-20): the native lock with no PWA mnemonic is a retry state; the unlock entry is offered on it. */
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
			if (noKeyCtl.capabilityResolved(state === 'native_chat')) void openOnboardingConfirmed('chat capability resolved')
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
		markBootScreen('onboarding')
		markDecided()
		setBootResolved(true)
		setRequireWalletRecover(needRecover)
		setRequireBeamioTagCreate(beamioTagCreate)
		setIsInitialLoading(true)
		setShowBeamioOnboardingModal(true)
		setSplashVisible(false)
	}

	/** 2026-11-21: the hold page's restore button enters the existing restore screen only. It never opens the onboarding entry
	 *  (no create, no Get started). Nothing is written here; the restore screen writes only on a completed restore (open point b). */
	// 0.53.44: Restore Wallet is not a startup button any more.

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

	/**
	 * Unit g (rev): the native passcode is not provided. This is a native pending-sync answer, not a landing decision. It records
	 * the diagnostic code and marks the pending sync. The landing stays with the page store (a valid page mnemonic is already on /home before any
	 * native read) and with the pre-read. No splash hold, no screen, no button, no re-read timer, not counted, nothing deleted.
	 */
	const markPasscodePendingSync = (source: string, diagnostic: 'passcode_not_provided' | 'native_passcode_not_provided') => {
		passcodePendingSyncRef.current = true
		const effect = passcodeNotProvidedEffect()
		publishNativePwaLog('info', `[AppEntryGate] ${source}: diagnostic=${diagnostic} pendingSync=${effect.pendingSync} landingChanged=${effect.landingChanged} screen=${effect.screen} rereads=${effect.rereads}`)
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
		// HC-LOCK (v10 §〇): the native side is locked. Never onboarding, never the storage-unavailable screen, never a manual retry page:
		// the page keeps waiting and retries on a timer; the unlock (passcodeState, R-21) re-runs the gate.
		if (reason === 'native_locked') {
			publishNativePwaLog('info', '[AppEntryGate] native locked: waiting, no onboarding')
			nativeWaitRef.current = true
			setSplashVisible(true)
			window.setTimeout(() => void init(), NATIVE_LOCKED_RETRY_MS)
			return
		}
		// Unit g (2026-11-22): passcode_not_provided is an explicit not_ready class: background wait, never a screen, never counted, never onboarding.
		if (reason === 'native_passcode_not_provided') {
			markPasscodePendingSync('shell read answer', 'passcode_not_provided')
			return
		}
		// v4 (v159 §179, v161 §181, v162 §182): a not_ready with a bounded class re-reads at most 5 times (0.5, 1, 2, 4, 8 s), then the explicit
		// error. A final class (zero, persistent) is the explicit error at once. Neither creates, recovers, imports or onboards.
		// 0.53.44:
		// in the shell the start has two landings only (/home, onboarding). Every other reason is a background wait: no error screen, no button,
		// data kept; the re-read schedule is startupWait's (2, 4, 8, 16 s, then every 30 s; each native read at most 30 s). The reasons in
		// SHELL_SCREEN_REASONS keep their own screen (terminal decisions of the existing rules, or the eoa stop).
		if (nativeShell && !SHELL_SCREEN_REASONS.has(reason)) {
			publishNativePwaLog('info', `[AppEntryGate] shell start: ${reason} is not a decision yet: background re-read (no screen, no button, nothing deleted)`)
			startupWait(`shell background: ${reason}`, shellWaitCodeOf(reason))
			return
		}
		if (reason === 'native_not_ready_bounded') {
			// walletStatus not_ready: the cold-start schedule (1, 2, 4, 8, 16 s, then every 16 s) inside a 60 s window; no attempt-count stop.
			const step = coldBackoffRef.current.next('walletStatus')
			if (step.kind === 'wait') {
				publishNativePwaLog('info', `[AppEntryGate] not_ready (backoff): walletStatus re-read attempt ${step.attempt} in ${step.delayMs} ms, ${step.elapsedMs} ms since the first; no creation, recovery or import`)
				nativeWaitRef.current = true
				setSplashVisible(true)
				window.setTimeout(() => void init(), step.delayMs)
				return
			}
			publishNativePwaLog('warn', `[AppEntryGate] not_ready (backoff): the 180 s window is used up after ${step.attempt} attempts (${step.elapsedMs} ms): the try-later state, a read-only ask every 30 s while visible, the user may retry`)
			startVisiblePoll()
			showStorageUnavailable('native_not_ready_final')
			return
		}
		if (reason === 'native_not_ready_final') {
			publishNativePwaLog('warn', '[AppEntryGate] not_ready (final): explicit error, no automatic re-read; the user retries')
			showStorageUnavailable(reason)
			return
		}
		// decision (2026-11-21): both capabilities absent on the shell and the page store empty: the terminal update prompt; no retry.
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
		// An unreadable vault is never "no wallet": onboarding could overwrite the encrypted copy.: every browser reason
		// other than a confirmed empty store stays on the unavailable screen with retry (see storageRoute.ts). Shell: the same screen.
		showStorageUnavailable(reason)
	}

	// Shell: the native wallet decides. A native wallet enters the app on its public address; the page storage is not read.
	const applyNativeWalletCore = (eoa: string) => {
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
	 * The local home waits for the native wallet to reach G2 (walletStatus, then init). One attempt at a time: a try that is still running
	 * makes the next trigger (the entry or the 30 s beat) a no-op, so calls never pile up. Shell only; the browser has no local home.
	 */
	const upgradeInFlightRef = useRef(false)
	/**
	 * The wallets (lower case) that this process already saw unlocked through reachNativeWallet. The entry-time attempt is made only for a wallet
	 * not in this set: an unlocked answer sends notifyNativeWalletReady, which re-runs the start, which enters the local home again (a valid page
	 * record always does); without this memory that re-entry would ask again at once and the two would feed each other without end.
	 */
	const reachedUnlockedRef = useRef(new Set<string>())
	/** the wallet (lower case) of the local home that is on now */
	const localHomeEoaRef = useRef('')
	const upgradeLocalHome = async (): Promise<void> => {
		if (!localModeRef.current || upgradeInFlightRef.current) return
		upgradeInFlightRef.current = true
		try {
			// read again only once the capability is declared: a missing, refused or unanswered hello keeps the local home.
			const cap = await shellIdentityState()
			if (cap !== 'declared') return
			const native = await reachNativeWallet()
			if (native.status === 'unlocked') {
				const eoaKey = typeof (native as { eoa?: unknown }).eoa === 'string' ? (native as { eoa: string }).eoa.toLowerCase() : ''
				if (eoaKey) reachedUnlockedRef.current.add(eoaKey)
				notifyNativeWalletReady('')
				return
			}
			// Not unlocked (locked, no key, not ready): forget this wallet, so that the next entry (after an unlock, say) asks again at once
			// instead of waiting for the 30 s beat. A locked answer sends no ready event, so this cannot start the loop.
			if (localHomeEoaRef.current) reachedUnlockedRef.current.delete(localHomeEoaRef.current)
			const answeredEoa = typeof (native as { eoa?: unknown }).eoa === 'string' ? (native as { eoa: string }).eoa.toLowerCase() : ''
			if (answeredEoa) reachedUnlockedRef.current.delete(answeredEoa)
			// an address mismatch ends the local home for the recovery entry.
			if (takeInitRefusal() === 'address_mismatch') {
				// 0.53.44: no recovery screen at startup; the start waits in the background
				localModeRef.current = false
				startupWait('address mismatch (background, data kept; no recovery screen at startup)', 'read_failed')
			}
		} catch {
			/* the 30 s beat tries again */
		} finally {
			upgradeInFlightRef.current = false
		}
	}

	/**
	 * the local home on a G1 wallet (the native record exists and is readable; the EOA is for display only). Chat and the
	 * network features stay unavailable (waiting for init) until the wallet reaches G2.
	 */
	const applyLocalWalletCore = (eoa: string) => {
		localModeRef.current = true
		localHomeEoaRef.current = eoa.trim().toLowerCase()
		const seed = publicWalletSeed(eoa)
		setCoNET_Data(seed)
		setBootCoNETData(seed)
		setRequireWalletRecover(false)
		setShowBeamioOnboardingModal(false)
		publishNativePwaLog('info', '[AppEntryGate] native wallet not initialised (g1_uninitialized): local home; network features wait for init')
		markWalletEstablished()
		enterApp()
		notifyShellEntry('native-wallet-local')
		// 0.53.51 (R2271-DEF-IOS-HOME-1): the first walletStatus/init attempt is made now, not after the first 30 s beat (shell only)
		if (isShellContext() && !reachedUnlockedRef.current.has(eoa.trim().toLowerCase())) void upgradeLocalHome()
	}

	/**
	 * Native G2 and no page wallet record: the page asks walletCredential once and keeps the sealed blob with the restored mnemonic in its
	 * own record (1c). The mnemonic is written in the record's existing format: wrapForDisk wraps it on the way to the
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
			// Unit g: the native passcode is not provided: nothing used or stored; a background retry (never record_unavailable, never onboarding).
			if (decision === 'passcode_not_provided') {
				publishNativePwaLog('warn', `[AppEntryGate] page record: ${startReasonLine('passcode_not_provided')} (background wait, nothing used or stored)`)
				return 'retry'
			}
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
			// r94 (R-PWA-R94-01): a native-validated copy for this account is the native path; no credential is asked or held here.
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
		// r94 (§24.5): a native-validated copy enters on the native path; the sealed credential is not held for it.
		return decidePrepareEntry(pre, eoa, loadShellSessionSigner)
	}

	const blockShellEntry = (outcome: 'eoa_mismatch' | 'update_required' | 'unseal_failed' | 'retry' | 'record_unavailable') => {
		setWritePermit(null, `entry blocked: ${outcome}`)
		// 0.53.44: eoa_mismatch, unseal_failed and record_unavailable are read failures for the
		// start: data kept, background wait with a diagnostic code, no screen and no button. Only the version gate (update_required) keeps its screen.
		if (outcome === 'eoa_mismatch') startupWait('shell entry: eoa_mismatch (background, data kept)', 'read_failed')
		else if (outcome === 'record_unavailable') startupWait('shell entry: record unavailable (background)', 'read_failed')
		else if (outcome === 'update_required') showStorageUnavailable('app_update_required')
		else if (outcome === 'unseal_failed') startupWait('shell entry: unseal_failed (background, data kept)', 'read_failed')
		// Per 1501: a native store that is not ready is unknown: the startup wait, no retry screen and no retry rounds.
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
		await openOnboardingConfirmed('walletEoaAddress no_key')
		return true
	}

	// Boundary (0.53.11): the local-home early return for identity MISSING is not the iOS not_ready path below.
	/**
	 * The page's mnemonic evidence from IndexedDB. Only a store that was read and holds no valid mnemonic is confirmed_empty; a timeout,
	 * a failure, an unavailable or a locked store is unknown (R68). A hint or a private key is never evidence.
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
			// 0.53.44: a definite native answer that the key must be recovered is
			// recovery evidence (the recovery entry), not an unknown. Nothing is written, cleared or onboarded.
			// Current code (11-17 reading, the recorded rule): a definite native needs_native_recovery answer is the
			// recovery entry, for the PNK-07 shape and the schema-2 key-stripped copy (spec §25.52Y.156 item 3). The owner's reaffirmed rule
			// maps it to onboarding only when the mnemonic is confirmed missing; that
			// change is pending (the answer carries no mnemonic-presence signal here), not made in this line. Unknown stays for timeouts and unreadable records.
			if (read?.status === 'unavailable' && read.reason === 'native_recovery_needed') return { kind: 'recovery' }
			if (read?.status === 'unavailable') return { kind: 'unknown', reason: read.reason }
			if (read?.status !== 'loaded') return UNKNOWN_PAGE_MNEMONIC
			// r94 (§24.5): a copy validated natively takes the native EOA; the page derives no address from it.
			if (isNativeCopyValidated(read, '')) {
				// no_key is the expected native answer for a validated copy (beamio.ts ~1697): the copy's EOA is taken; any other refusal is unknown.
				const native = await readWalletEoaAddress().catch(() => ({ kind: 'refused' as const, code: 'error' }))
				const evidence = copyPageEvidence(read, native)
				return evidence?.kind === 'valid' ? evidence : UNKNOWN_PAGE_MNEMONIC
			}
			// f3 (walletVault): a passcode-protected page record keeps the v3 envelope in `mnemonicPhrase`. It is account evidence (never an empty
			// record), its EOA is the record's keyID, and it is synced as stored: nothing is decrypted here.
			const field = pageMnemonicField(read.data)
			if (field.kind === 'envelope') {
				const keyID = typeof read.data?.profiles?.[0]?.keyID === 'string' ? String(read.data.profiles[0].keyID).trim().toLowerCase() : ''
				if (!keyID || keyID !== field.envelope.eoa) return UNKNOWN_PAGE_MNEMONIC
				sessionSawValidRef.current = true
				return { kind: 'valid_cipher', eoa: field.envelope.eoa, cipher: field.envelope }
			}
			// any other shape of the field is never "no mnemonic": unknown (hold, retry), never confirmed_empty and never onboarding
			if (field.kind === 'other') return UNKNOWN_PAGE_MNEMONIC
			const eoa = validMnemonicEoa(read.data)
			// 0.53.43 (the decision): a stored phrase that cannot be decoded or derived is unknown (hold, retry), never confirmed_empty.
			const storedPhrase = typeof read.data?.mnemonicPhrase === 'string' ? read.data.mnemonicPhrase.trim() : ''
			if (storedPhrase && !eoa) return UNKNOWN_PAGE_MNEMONIC
			// E7-1 (2026-11-17): the account credential is a valid mnemonic whose derived EOA equals the record's keyID. A mnemonic for another
			// address is not this account's credential: no valid mnemonic here (the pre-read path decides), nothing is used.
			const keyID = typeof read.data?.profiles?.[0]?.keyID === 'string' ? String(read.data.profiles[0].keyID).trim().toLowerCase() : ''
			// 0.53.43 (the decision): a parseable mnemonic whose EOA differs from the keyID is evidence
			// of a page account: it never leads to onboarding or a write; the start holds with the diagnostic page_mnemonic_keyid_mismatch.
			if (eoa && keyID && keyID !== eoa) return { kind: 'confirmed_empty', keyIdMismatch: true }
			if (eoa) sessionSawValidRef.current = true
			return eoa ? { kind: 'valid', eoa, phrase: String(read.data?.mnemonicPhrase ?? '').trim() } : { kind: 'confirmed_empty' }
		} catch {
			return UNKNOWN_PAGE_MNEMONIC
		}
	}

	/** v10 §六.2: whether the last reply of the sync was an envelope-level locked (the button is hidden after one). */
	const lastReplyLocked = useRef(false)
	/**
	 * the recorded rule: the shell pre-read keeps one page read in flight across start rounds. The 2 s
	 * limit only decides this round's wait (splash and retry); it never discards the read. A later round (automatic or manual retry)
	 * awaits the same read instead of starting another, so two page reads never overlap. The read is released when a round takes its answer.
	 */
	const preReadRef = useRef<Promise<PageMnemonicEvidence> | null>(null)
	/** The start rounds currently awaiting the pre-read (a late wake-up never runs beside one of them). */
	const preReadWaitersRef = useRef(0)
	// Bound of the in-flight read (checked against the code, 2026-11-22; no hard cap is added): readPageMnemonic awaits only two bounded
	// steps. (a) checkStorageWithTransientRetry: up to 2 attempts of checkStorageWithStatusWithTimeout, each raced with a 5 s timer
	// (beamio.ts 1998–2010, 1975–1990), so at most 10 s. (b) readWalletEoaAddress in the validated-copy branch: sendShellRecordCommand with
	// SHELL_RECORD_REPLY_TIMEOUT_MS = 10 s (walletEoaAddress.ts, shellRecordTransport.ts 34). The worst case is therefore about 20 s, after
	// which the read settles (as unknown) and a manual retry or the next round starts a new read. A hung read cannot outlive that bound.
	const takePageMnemonicRead = async (): Promise<PageMnemonicEvidence> => {
		if (!preReadRef.current) preReadRef.current = readPageMnemonic()
		const pending = preReadRef.current
		let timer: number | undefined
		preReadWaitersRef.current += 1
		let got: PageMnemonicEvidence | typeof PREREAD_TIMED_OUT
		try {
			got = await Promise.race([
				pending,
				new Promise<typeof PREREAD_TIMED_OUT>((resolve) => {
					timer = window.setTimeout(() => resolve(PREREAD_TIMED_OUT), SHELL_PAGE_READ_TIMEOUT_MS)
				}),
			])
		} finally {
			preReadWaitersRef.current -= 1
			window.clearTimeout(timer)
		}
		if (got === PREREAD_TIMED_OUT) {
			// this round's limit passed: unknown for this round only, the read stays in flight. The moment it ends, the start is woken and
			// decides on the same read at once (the next-round timer is cancelled); no new read is started and the wait does not run out.
			void pending.then(() => {
				if (!gateMountedRef.current || preReadRef.current !== pending || preReadWaitersRef.current > 0) return
				if (startupRetryRef.current !== undefined) {
					window.clearTimeout(startupRetryRef.current)
					startupRetryRef.current = undefined
				}
				publishNativePwaLog('info', '[AppEntryGate] pre-read ended after its round limit: the start decides now (no new read)')
				void initRef.current?.()
			})
			return UNKNOWN_PAGE_MNEMONIC
		}
		// the in-flight mark is released when a round takes the answer
		if (preReadRef.current === pending) preReadRef.current = null
		return got
	}

	/** The page's local store for the held-write record (v10 §六.1); null without a window (fail-closed). */
	const failureStore = () => (typeof window === 'undefined' ? null : window.localStorage)
	/** The EOA|phrase pairs this page session has confirmed (ok) or has in flight: a pair is sent once; a failed one may be sent again (item A). */
	const phraseSyncs = useRef<{ confirmed: Set<string>; inFlight: Set<string> }>({ confirmed: new Set(), inFlight: new Set() })
	/** Background retries of an unconfirmed pwaWalletSync (2026-11-22 item 3): the schedule, never a block. */
	const syncRetryAttemptRef = useRef(0)
	// Dependency (review b, 2026-11-17): a remount clears this ref, so the same pair may be sent again in a new page session. That is accepted:
	// the native side answers an identical request (same seq and content) with idempotent, which is confirmed here (ok), and writes nothing twice.
	/**
	 * The cipher sync (spec 30.1; 2.3): completed only on the shell's read-back confirmation (stored and readback match). Any other
	 * answer is not a completion: it is retried in the background on the re-read schedule (); the page record is not written here.
	 */
	const cipherSyncs = useRef<{ confirmed: Set<string>; inFlight: Set<string> }>({ confirmed: new Set(), inFlight: new Set() })
	const cipherRetryAttemptRef = useRef(0)
	const sendCipherOnce = async (payload: { cipher: Record<string, unknown>; eoa: string }): Promise<void> => {
		const key = `${payload.eoa}|${String(payload.cipher.ct)}`
		const sets = cipherSyncs.current
		if (sets.confirmed.has(key) || sets.inFlight.has(key)) return
		sets.inFlight.add(key)
		try {
			const out = await shellMnemonicSync.syncCipher(payload.cipher, payload.eoa)
			if (out.kind === 'synced') {
				sets.confirmed.add(key)
				cipherRetryAttemptRef.current = 0
				allowFirstNativeWrite(payload.eoa)
				void retryDeferredWriteNow()
				publishNativePwaLog('info', '[sync] cipher confirmed by the shell read-back (stored, readback match)')
			} else if (out.kind === 'failed' && !out.retryable) {
				// M6 (v3.3): a store-only sync (no passcode) of a different envelope for the same account is refused by the native side (bad_request, or
				// another closed refusal code): a terminal answer. It is not retried; the next unlock sends the current envelope with the passcode, and the
				// native side verifies and accepts it. The log carries the code only.
				cipherRetryAttemptRef.current = 0
				publishNativePwaLog('warn', `[sync] cipher sync refused (code=${out.code}): not retried; the next unlock syncs again with the passcode`)
			} else {
				const attempt = cipherRetryAttemptRef.current + 1
				cipherRetryAttemptRef.current = attempt
				const delay = startupRetryDelayMs(attempt)
				publishNativePwaLog('info', `[sync] ${startReasonLine('sync_retry')} attempt=${attempt} next=${delay}ms`)
				window.setTimeout(() => {
					if (gateMountedRef.current) void sendCipherOnce(payload)
				}, delay)
			}
		} finally {
			sets.inFlight.delete(key)
		}
	}

	// 2026-11-22 (item 1): a set whose first sync was not confirmed (sync_pending) is handed to this mechanism, which sends it
	// through sendCipherOnce ( schedule; completion only on the shell's read-back). Registered only in the native shell.
	useEffect(() => {
		if (!isCashTreesNativeWebView()) return
		setSyncPendingHandler((cipher, eoa) => {
			void sendCipherOnce({ cipher, eoa })
		})
		return () => setSyncPendingHandler(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const sendPhraseOnce = async (payload: { phrase: string; eoa: string }): Promise<void> => {
		const key = `${payload.eoa}|${payload.phrase}`
		const sets = phraseSyncs.current
		if (sets.confirmed.has(key) || sets.inFlight.has(key)) return
		sets.inFlight.add(key)
		try {
			const out = await shellMnemonicSync.sync(payload.phrase, payload.eoa)
			const outcome = out as { kind?: string; code?: string; reason?: string } | undefined
			lastReplyLocked.current = outcome?.kind === 'failed' && outcome.code === 'locked'
			if (outcome?.kind !== 'synced') {
				// not confirmed (failed, locked or no answer): retry in the background on the re-read schedule; the page and its IndexedDB are untouched
				const attempt = syncRetryAttemptRef.current + 1
				syncRetryAttemptRef.current = attempt
				const delay = startupRetryDelayMs(attempt)
				publishNativePwaLog('info', `[sync] ${startReasonLine('sync_retry')} attempt=${attempt} next=${delay}ms`)
				window.setTimeout(() => {
					if (gateMountedRef.current) void sendPhraseOnce(payload)
				}, delay)
			} else syncRetryAttemptRef.current = 0
			if (outcome?.kind === 'synced') {
				sets.confirmed.add(key)
				// the native sync of this account is confirmed; the first native record of the account may now be written
				allowFirstNativeWrite(payload.eoa)
				void retryDeferredWriteNow()
				// v10 §六.1: a confirmed sync for this account clears its held record.
				if (recordMatchesAccount(readFailureRecord(failureStore()), payload.eoa)) clearFailureRecord(failureStore())
			}
			// v10 §六.1: only write_failed with rollback_pending is recorded (no key material; one entry).
			if (outcome?.kind === 'failed') {
				const rec = recordForFailure({ code: outcome.code ?? '', reason: outcome.reason }, payload.eoa, new Date())
				if (rec) writeFailureRecord(failureStore(), rec)
				// Unit (b) (review item 7): a sync that did not finish is pending only. Home is unchanged and the account in use is not changed.
				markPendingSync(`native_sync_${outcome.code ?? 'failed'}`)
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
	 * Per spec r2.4 item 44: after the home is entered, a trusted shell receives the page's valid mnemonic for durable
	 * sync. Browser builds never sync. Not awaited: the route does not wait, and a failed sync never changes it.
	 */
	const syncPageMnemonicToShell = () => {
		if (!isCashTreesNativeWebView()) return
		void readPageMnemonic().then(async (ev) => {
			const payload = pageSyncPayload(ev)
			if (!payload) return
			// v10 §六.1: a held record of another account is cleared (the account changed).
			const held = readFailureRecord(failureStore())
			if (held && !recordMatchesAccount(held, payload.eoa)) clearFailureRecord(failureStore())
			// C1 (v10 §五): the pre-sync read of walletState and walletStatus. Locked, corrupt, unknown or timed out: held (pendingSync), not sent.
			if ((await runSyncPreCheck(queryNativeWalletStateForPreCheck, queryNativeWalletStatusForPreCheck)) === 'pending') {
				markPendingSync('pre_sync_locked_or_unknown')
				publishNativePwaLog('info', '[AppEntryGate] pre-sync: native locked, unknown or timed out: held until the unlock (not sent)')
				return
			}
			void sendPhraseOnce(payload)
		})
	}
	/**
	 * v10 §六.3 (manual retry of a held write): the record for this account is present. Live walletStatus is read at the click; locked
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
	// v10 §六.2: the live inputs of the button's visibility (the rule is pure: manualRetryVisible). Read before rendering the button.
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
	 * PWA-RETRY-03 (v10.2 R-22): a manual retry of internal_state or storage_write rereads walletEoaAddress first. Unknown does not send;
	 * valid or absent sends. A pair in flight is refused (inFlight, v10 §138).
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
	// r94: the home's "retry sync" re-reads the page's valid mnemonic and syncs again; the home shows the result (shellSyncStatus).
	// v10 §六: a held record for this account takes the manual path (live check, inFlight refusal); otherwise the re-read path.
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
	 * Startup wait (1501): unknown is neither the onboarding nor the home. The splash stays up and the start is read
	 * again after a fixed interval, until a definite answer arrives. Nothing is deleted, overwritten, shown as an error or routed.
	 * Only a confirmed empty page with a confirmed "no such account" from the native side reaches the onboarding.
	 */
	/** 0.53.39 (rule 2026-11-20): a native lock with no PWA mnemonic: retry with the unlock entry. Never onboarding, never the passcode page. */
	const waitNativeLocked = (reason: string) => {
		publishNativePwaLog('warn', `[AppEntryGate] native locked: retry with the unlock entry (never onboarding): ${reason}`)
		setNativeLockedOffered(true)
		startupWait(`native locked: ${reason}`, 'native_locked')
	}

	const startupWait = (reason: string, code?: StartReasonCode, backoffKey?: ColdStartKey) => {
		setWritePermit(null, `hold: ${reason}`)
		publishNativePwaLog('warn', `[AppEntryGate] ${reason}: startup wait (unknown: nothing deleted, overwritten or routed)${code ? ` ${startReasonLine(code)}` : ''}`)
		nativeWaitRef.current = true
		// Per startup capability: an unknown answer never waits silently for long. See the rounds below.
		startupRoundsRef.current += 1
		// r92 step 5: the splash stays; the visible retry button is offered from the first unknown round. No generic fallback screen. The
		// automatic re-read backs off (2, 4, 8, 16 s, then every 30 s) and never gives up. Nothing is deleted, overwritten or routed.
		const attempt = startupRoundsRef.current
		setSplashVisible(true)
		setStartupRetryOffered(true)
		// a not_ready read (preread, walletStatus, identityPublic) follows the cold-start schedule inside its 60 s window; any other unknown
		// keeps the existing schedule. The window used up stops the automatic re-reads: the retry offer stays, and a return to the foreground
		// starts the clock again.
		let delay = startupRetryDelayMs(attempt)
		if (backoffKey) {
			const step = coldBackoffRef.current.next(backoffKey)
			if (step.kind === 'exhausted') {
				publishNativePwaLog('warn', `[AppEntryGate] not_ready (backoff): ${backoffKey} 180 s window used up after ${step.attempt} attempts (${step.elapsedMs} ms): the visible 30 s poll goes on`)
				startVisiblePoll()
				return
			}
			delay = step.delayMs
			publishNativePwaLog('info', `[AppEntryGate] not_ready (backoff): ${backoffKey} attempt ${step.attempt}, next in ${delay} ms, ${step.elapsedMs} ms since the first`)
		} else {
			publishNativePwaLog('info', `[AppEntryGate] startup retry: attempt ${attempt}, next in ${delay} ms`)
		}
		if (startupRetryRef.current === undefined) {
			startupRetryRef.current = window.setTimeout(() => {
				startupRetryRef.current = undefined
				// (option A): a re-run that would start a new pre-read waits for the open round to conclude (one round at a time)
				const inFlight = nativePrereadRoundInFlight()
				if (inFlight) {
					void inFlight.then(() => void initRef.current?.())
					return
				}
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

	// 0.53.44: Try Again is not a startup button any more; the start re-reads in the background (startupWait) only.

	// r92 step 5: the App's init skip raises this when a start stays unknown; the same visible retry button is then offered.
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
	 * Onboarding confirmation: before an account is opened because no account was found (page absent, native no_key), one real native read decides it. A valid mnemonic is
	 * the home (the page record is written from it, the sync follows in the background); a ciphertext is the unlock page; a lock waits; an unavailable or
	 * failed read is unknown (wait and retry, no onboarding, nothing written). Only a read that confirms no valid mnemonic returns 'proceed'. An address, a
	 * pointer or an old private key alone do not block it. An earlier pre-read answer is never reused: it may predate the record or be folded from an
	 * unavailable read. 'handled' means the start went elsewhere (home, unlock, wait) and the caller must stop.
	 *
	 * Platform (declared by the shell in its hello answer, nativeApp.platform): an iOS pre-read covers the current record and the sealed copy, so the
	 * pre-read alone confirms. Android (and a shell that declares no valid platform: fail closed) must also read walletStatus, which reads the sealed
	 * copies: no_key confirms; a wallet there (unlocked, phrase_only) is the home on its address; locked waits for the unlock; any other answer waits.
	 */
	const confirmNoMnemonicOnNative = async (reqId: string): Promise<'proceed' | 'handled'> => {
		// A page with no native bridge (an ordinary browser) has no native record to confirm against: the page store read is the only
		// source, and it already said empty. No native command is sent there.
		if (!isShellContext()) return 'proceed'
		const real = await queryNativeMnemonicPreread()
		publishNativePwaLog('info', `[startup] reqId=${reqId} onboarding confirmation read=${real.kind}${real.kind === 'unknown' && real.reason ? ` reason=${real.reason}` : ''}`)
		if (real.kind === 'cipher') {
			showPrereadCipher(real.cipher, reqId)
			return 'handled'
		}
		if (real.kind === 'valid') {
			await adoptValidPreread(real, reqId)
			return 'handled'
		}
		if (real.kind === 'locked') {
			waitNativeLocked('onboarding confirmation read locked')
			return 'handled'
		}
		// A shell that has no pre-read command at all (reason 'unsupported', an older build) cannot answer it, now or later: waiting would never end.
		// It is confirmed by the walletStatus read below instead, and only an explicit no_key proceeds (any other answer waits).
		const prereadUnsupported = real.kind === 'unknown' && real.reason === 'unsupported'
		if (real.kind !== 'absent' && !prereadUnsupported) {
			logStartRoute(reqId, 'none_yet')
			startupWait(
				`onboarding confirmation read unknown (${real.reason ?? 'unknown'}): retry, no onboarding`,
				real.reason === 'read_timeout' ? 'native_read_timeout' : real.reason === 'not_ready' ? 'pre_read_not_ready' : 'record_unreadable',
			)
			return 'handled'
		}
		const hello = await probeNativeCapabilities().catch(() => null)
		const platform = validNativeApp(hello && typeof hello === 'object' ? (hello as { nativeApp?: unknown }).nativeApp : undefined)?.platform ?? null
		if (platform === 'ios' && !prereadUnsupported) {
			// 0.53.52 (owner approval 2026-11-25): the SDK deletes a key-only native record itself; until walletStatus says no_key the page only waits.
			const ios = await queryNativeWalletStatus()
			if (ios.status === 'not_ready' && ios.notReadyReason === 'key_only') {
				logStartRoute(reqId, 'none_yet')
				startupWait('native key-only record: waiting for the SDK deletion (no_key), no onboarding', 'status_not_no_key')
				return 'handled'
			}
		}
		if (platform !== 'ios' || prereadUnsupported) {
			const ws = await queryNativeWalletStatus()
			publishNativePwaLog('info', `[startup] reqId=${reqId} onboarding confirmation platform=${platform ?? 'undeclared'} walletStatus=${ws.status}`)
			if (ws.status === 'unlocked' || ws.status === 'phrase_only') {
				publishNativePwaLog('info', '[AppEntryGate] pre-read absent but walletStatus holds a wallet: the home on its address, not onboarding')
				applyNativeWallet(ws.eoa)
				logStartRoute(reqId, 'home')
				resolveShellChatCapability()
				return 'handled'
			}
			if (ws.status === 'locked') {
				waitNativeLocked('onboarding confirmation walletStatus locked')
				return 'handled'
			}
			if (ws.status !== 'no_key') {
				logStartRoute(reqId, 'none_yet')
				startupWait(`onboarding confirmation walletStatus ${ws.status}: retry, no onboarding`, 'status_not_no_key')
				return 'handled'
			}
		}
		return 'proceed'
	}

	/**
	 * 0.53.52 (owner approval 2026-11-25): THE one place where a key-only page record is silently deleted, called by openOnboardingConfirmed, which every way into
	 * the onboarding passes after the absence of a mnemonic was confirmed. Compare and delete (purgeKeyOnlyPageRecord): only a plain record with a private key
	 * and no mnemonic at all goes; a read failure, a lock, a passcode record, a mnemonic of any kind or an unknown shape leaves everything and holds the start (no
	 * onboarding). A process that has read a valid mnemonic never deletes (sessionSawValidRef). Returns true when the onboarding may open.
	 */
	const holdUnlessKeyOnlyPurged = async (reqId: string): Promise<boolean> => {
		if (sessionSawValidRef.current) return true
		const purged = await purgeKeyOnlyPageRecord()
		if (purged.kind === 'unknown' || purged.kind === 'failed') {
			publishNativePwaLog('warn', `[startup] reqId=${reqId} key-only page record check ${purged.kind}: nothing deleted, no onboarding; the start waits`)
			logStartRoute(reqId, 'none_yet')
			startupWait(`key-only page record ${purged.kind}: hold, not onboarding`, 'read_failed')
			return false
		}
		if (purged.kind === 'deleted') {
			// one line, no secret, no address
			publishNativePwaLog('info', '[AppEntryGate] a key-only page record was deleted; the onboarding follows')
			// the leftovers of that wallet: the kept address hint and a pending create record (they would revive the deleted account)
			if (purged.eoa) {
				forgetPersistedShellEoa(purged.eoa)
				clearPendingCreateTag(purged.eoa)
			}
		}
		return true
	}

	/** The entries that open the onboarding because no account was found (not the create-tag or the recovery entries): confirmed by the one real read first. */
	const openOnboardingConfirmed = async (where: string, opts?: { reqId?: string; alreadyConfirmed?: boolean; onProceed?: () => void }): Promise<void> => {
		const reqId = opts?.reqId ?? newStartReqId()
		publishNativePwaLog('info', `[startup] reqId=${reqId} onboarding requested by ${where}: confirming with one real native read`)
		if (!opts?.alreadyConfirmed && (await confirmNoMnemonicOnNative(reqId)) === 'handled') return
		if (!(await holdUnlessKeyOnlyPurged(reqId))) return
		opts?.onProceed?.()
		goOnboarding(false)
	}

	/** A valid native pre-read answer (the start's, or the one real read before an onboarding): written to the page record, then the home; background sync follows. */
	const adoptValidPreread = async (pre: { eoa: string; phrase: string }, reqId: string): Promise<void> => {
		publishNativePwaLog('info', '[AppEntryGate] native mnemonic pre-read valid: writing it to the page IndexedDB, then the home')
		// ②: the adoption (its checks, write-back and read-back) starts here and is not interrupted by the splash deadline.
		adoptionInFlightRef.current = true
		// Per B, item 3: the derived address must also agree with any local account record. A different one is verify_failed:
		// nothing is written, nothing is onboarded, the data is kept.
		const localEoa = await readPageDerivedAddress().catch(() => null)
		if (typeof localEoa === 'string' && localEoa.trim() !== '' && localEoa.trim().toLowerCase() !== pre.eoa.trim().toLowerCase()) {
			adoptionInFlightRef.current = false
			startupWait('pre-read address differs from the local account record: verify_failed (nothing written)', 'verify_failed')
			return
		}
		// a held signer for another account is cleared before any entry
		if (shellSessionEoa() && shellSessionEoa() !== pre.eoa.trim().toLowerCase()) releaseShellSessionSignerHold()
		try {
			await adoptPrereadMnemonic(pre.phrase, pre.eoa, reqId)
		} finally {
			adoptionInFlightRef.current = false
		}
		resolveShellChatCapability()
	}

	/**
	 * Spec r2.4 item 42(2) valid, the 1c write-back (): the mnemonic from the native pre-read is written into the page's own record in
	 * the existing format, then read back. Only a read-back that derives this account opens the home (on its EOA); the post-home sync follows
	 * (item 44). A failed hold, write or read-back is a startup wait: nothing is deleted, shown or routed.
	 */
	const adoptPrereadMnemonic = async (phrase: string, eoa: string, reqId: string, cipherSync?: { cipher: Record<string, unknown>; passcode: string }): Promise<void> => {
		const held = holdShellSessionFromPhrase(phrase, eoa)
		if (held.kind !== 'ok') {
			publishNativePwaLog('warn', `[AppEntryGate] pre-read: the held key is not this account (${held.code}): startup wait`)
			startupWait('pre-read mnemonic not held', 'pre_read_no_hold')
			return
		}
		// Unit (b), the decision rule 4 fix 2: written to the page's own IndexedDB (existing format) and verified only by an
		// independent read of the mnemonic there, deriving this account. The shell record, the address and the generic record read-back do not count.
		// M6: a ciphertext pre-read (a passcode account) is written to the page IndexedDB as the passcode record (the envelope), never as plaintext;
		// the single cipher+passcode sync is sent by that write. A plaintext pre-read keeps the plaintext page record and the phrase sync.
		const verdict = cipherSync
			? await persistPageIdbPasscodeRecord(recoveredPageRecord(publicWalletSeed(eoa), phrase), phrase, eoa, cipherSync.passcode)
			: await persistPageIdbMnemonic(recoveredPageRecord(publicWalletSeed(eoa), phrase), phrase, eoa)
		publishNativePwaLog('info', `[startup] reqId=${reqId} writeback=${verdict}`)
		if (verdict !== 'verified') {
			// the spec (write_failed): a real write or read-back failure keeps the data and waits; it is never reported as a missing record.
			publishNativePwaLog('warn', `[AppEntryGate] pre-read write-back not confirmed (${verdict}): startup wait, the next read asks again`)
			startupWait('pre-read write-back not confirmed', 'write_failed')
			return
		}
		setCoNET_Data(recoveredPageRecord(publicWalletSeed(eoa), phrase) as never)
		refreshShellSessionInMemory()
		setWritePermit('native_restore', 'pre-read write-back read back consistent (page IndexedDB)')
		applyLocalWallet(eoa)
		logStartRoute(reqId, 'home')
		// the plaintext phrase is never sent for a passcode account: its one sync (cipher + passcode) was sent by the page write above
		if (!cipherSync) syncHeldPhraseToShell(phrase, eoa)
	}

	/**
	 * spec item 4: the pre-read returned ciphertext. The splash and any scheduled re-read stop, and the passcode page takes the
	 * screen. The page decrypts on its own; the phrase then goes through adoptPrereadMnemonic (write, read back, home).
	 */
	/**
	 * 2026-11-22 (the decision, item 2): the pre-read of a start round is capped (30 s). A timed-out read is a background wait.
	 * Its late answer is adopted only when it is the one this start still waits for (same reqId, no decision made yet); a late answer for
	 * another reqId, or after a decision, is dropped with a log line. A new read supersedes the older expectation.
	 */
	const lateReadRef = useRef<{ expectReqId: string | null; lateAnswer: { reqId: string; answer: MnemonicPreread } | null }>({ expectReqId: null, lateAnswer: null })
	const readPrereadCapped = async (reqId: string): Promise<MnemonicPreread> => {
		const late = lateReadRef.current
		late.expectReqId = null
		// wrapped so that a sync reader (a test double) and an async one both work, and a throw is an unknown answer
		const task = Promise.resolve().then(() => queryNativeMnemonicPreread()).catch((): MnemonicPreread => ({ kind: 'unknown' }))
		const r = await capNativeRead(task)
		if (r.kind === 'answer') return r.value
		publishNativePwaLog('warn', startReasonLine('native_read_timeout', reqId))
		late.expectReqId = reqId
		void task.then((answer) => {
			if (late.expectReqId !== reqId) {
				publishNativePwaLog('warn', `${startReasonLine('late_result_discarded', reqId)} cause=reqid_mismatch`)
				return
			}
			late.expectReqId = null
			if (decisionMadeRef.current) {
				publishNativePwaLog('warn', `${startReasonLine('late_result_discarded', reqId)} cause=decided`)
				return
			}
			late.lateAnswer = { reqId, answer }
			publishNativePwaLog('info', startReasonLine('late_result_adopted', reqId))
			if (startupRetryRef.current !== undefined) {
				window.clearTimeout(startupRetryRef.current)
				startupRetryRef.current = undefined
			}
			void initRef.current?.()
		})
		return { kind: 'unknown', reason: 'read_timeout' }
	}
	/** A status read (passcodeStatus, walletStatus) is capped too; a late answer is dropped (a status is never a decision on its own). */
	const capStatusRead = async <T,>(reqId: string, task: () => Promise<T>, fallback: T): Promise<T> => {
		const p = Promise.resolve().then(() => task()).catch(() => fallback)
		const r = await capNativeRead(p)
		if (r.kind === 'answer') return r.value
		publishNativePwaLog('warn', `${startReasonLine('native_read_timeout', reqId)} read=status`)
		void p.then(() => publishNativePwaLog('warn', `${startReasonLine('late_result_discarded', reqId)} cause=status_read`))
		return fallback
	}

	const showPrereadCipher = (cipher: unknown, reqId: string) => {
		publishNativePwaLog('info', `[startup] reqId=${reqId} preread=cipher: passcode page (no plaintext, nothing written)`)
		if (startupRetryRef.current !== undefined) {
			window.clearTimeout(startupRetryRef.current)
			startupRetryRef.current = undefined
		}
		nativeWaitRef.current = false
		setStartupRetryOffered(false)
		markDecided()
		setSplashVisible(false)
		setGateDecided(false)
		setPrereadCipher({ cipher, reqId })
	}

	const init = async () => {
		// unit (c): an unmounted gate starts no round (see gateMountedRef)
		if (!gateMountedRef.current) return
		const reqId = newStartReqId()
		// R96: the pre-read answer of this start (unsupported: the native rule does not decide the account; see the judgement below)
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
		// in a shell the page is read before the native side is asked. A valid mnemonic on the page is the
		// one current account: the home opens on its EOA, and the native side is not asked or compared. An unknown read is retryable
		// (never a delete, an overwrite or a popup). Only a confirmed-empty page goes on to the native side below.
		let pageEvidence: PageMnemonicEvidence | null = null
		if (nativeShellRef.current) {
			const first = await takePageMnemonicRead()
			pageEvidence = first
			if (first.kind === 'valid') {
				publishNativePwaLog('info', `[AppEntryGate] page mnemonic is valid: the home on the page EOA; the native side is not asked (reqId=${reqId} idb=valid preread=not_called)`)
				setWritePermit('page_valid_mnemonic', 'page mnemonic valid, EOA is the current account')
				applyLocalWallet(first.eoa)
				logStartRoute(reqId, 'home')
				// The home is already entered; native chat capability is resolved only after the PWA account is known.
				resolveShellChatCapability()
				// rule 1502: after the home is entered, the trusted shell receives the valid mnemonic for durable sync (never awaited here)
				if (isCashTreesNativeWebView() && first.phrase) void sendPhraseOnce({ phrase: first.phrase, eoa: first.eoa })
				return
			}
			if (first.kind === 'valid_cipher') {
				// the home on the record's EOA with no native read (preread and walletStatus are not asked); the cipher goes to the shell as stored
				publishNativePwaLog('info', `[AppEntryGate] page record is the v3 ciphertext: the home on its EOA; no native read (reqId=${reqId} idb=valid_cipher preread=not_called)`)
				setWritePermit('page_valid_mnemonic', 'page v3 record valid, EOA is the current account')
				applyLocalWallet(first.eoa)
				logStartRoute(reqId, 'home')
				resolveShellChatCapability()
				// M6: the passcode account syncs once per page session, after the page unlock, as pwaWalletSync{eoa, cipher, passcode, seq} (PasscodeLockScreen,
				// afterUiUnlock). No sync without the passcode is sent from here: the native record is not touched before the unlock.
				return
			}
			if (first.kind === 'terminal') {
				// the terminal is set before its diagnostic (decideShellTerminal); handleStorageUnavailable shows the screen
				decideShellTerminal(() => publishNativePwaLog('warn', `[AppEntryGate] terminal: fallback shell (shellRecordRead ${shellRecordFallbackLabel()}), page store confirmed empty: update prompt, no retry`))
				handleStorageUnavailable(OLD_SHELL_UPGRADE_REASON)
				return
			}
			if (first.kind === 'recovery') {
				// 0.53.44: the native side answered that the key must be recovered: the recovery entry (nothing written, cleared or onboarded)
				publishNativePwaLog('warn', '[AppEntryGate] pre-read: native recovery needed (a definite answer): the recovery entry; nothing written or cleared')
				handleStorageUnavailable('native_recovery_needed')
				return
			}
			if (first.kind === 'unknown') {
				publishNativePwaLog('warn', `[startup] reqId=${reqId} idb=unknown preread=not_called`)
				logStartRoute(reqId, 'none_yet')
				startupWait('page mnemonic unknown (timeout, read failure or unreadable store)', shellWaitCodeOf(first.reason))
				return
			}
			publishNativePwaLog('info', `[startup] reqId=${reqId} idb=absent`)
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
				// 0.53.39 (3): bridge trust is unknown after the deadline (no identity declared): a retry state with a reason
				// code. Never onboarding, never a new wallet. A slow hello (S25, 9.9 s) before the deadline is a wait, not a failure.
				if (bridgeTrustStartRef.current === undefined) bridgeTrustStartRef.current = Date.now()
				const trust = bridgeTrustState({ identity, elapsedMs: Date.now() - bridgeTrustStartRef.current })
				publishNativePwaLog('warn', `[AppEntryGate] native mnemonic pre-read capability ${identity}: startup wait (bridge trust ${trust.state}${trust.reason ? ` reason=${trust.reason}` : ''})`)
				startupWait(`native mnemonic pre-read capability ${identity}`, bridgeTrustReasonCode(trust.state))
				return
			}
			// Unit (b): the pre-read is asked only here, when the page IndexedDB is definitively absent (the gate above). It does not depend on Chat init.
			const lateAnswer = lateReadRef.current.lateAnswer
			lateReadRef.current.lateAnswer = null
			const pre = lateAnswer ? lateAnswer.answer : await readPrereadCapped(reqId)
			publishNativePwaLog('info', `[startup] reqId=${reqId} preread=${pre.kind}${pre.kind === 'unknown' && pre.reason ? ` reason=${pre.reason}` : ''}${pre.kind === 'unknown' && pre.code ? ` code=${pre.code}` : ''}`)
			if (pre.kind === 'cipher') {
				// the spec: a passcode-protected record is unlocked by the PWA page; it is never onboarding and never a native unlock.
				showPrereadCipher(pre.cipher, reqId)
				return
			}
			if (pre.kind === 'valid') {
				await adoptValidPreread(pre, reqId)
				return
			}
			// Unit (b): unknown (not_ready, envelope errors, a read that did not finish) is never a verdict and never an
			// onboarding. The first unknown of a start re-asks at once (Android answers its first call unknown); later ones back off (startupWait).
			if (pre.kind === 'unknown' && pre.reason !== 'unsupported') {
				// a not_ready pre-read follows the cold-start schedule from the first answer (no separate quick re-request)
				if (!quickPrereadRetryRef.current && pre.reason !== 'not_ready') {
					quickPrereadRetryRef.current = true
					publishNativePwaLog('info', `[startup] reqId=${reqId} preread first unknown: quick re-request in ${PREREAD_QUICK_RETRY_MS} ms (no verdict)`)
					nativeWaitRef.current = true
					setSplashVisible(true)
					logStartRoute(reqId, 'none_yet')
					if (startupRetryRef.current === undefined) {
						startupRetryRef.current = window.setTimeout(() => {
							startupRetryRef.current = undefined
							// the quick re-request runs after its round concluded (its own round is the one in flight)
							void initRef.current?.()
						}, PREREAD_QUICK_RETRY_MS)
					}
					return
				}
				logStartRoute(reqId, 'none_yet')
				// the spec (record_unreadable): a read failure keeps the data and is never a confirmed absence.
				startupWait(
					`native pre-read unknown (${pre.reason ?? 'unknown'}): retry, no verdict`,
					pre.reason === 'read_error' ? 'record_unreadable' : pre.reason === 'read_timeout' ? 'native_read_timeout' : pre.reason === 'verify_failed' ? 'verify_failed' : pre.reason === 'not_ready' ? 'pre_read_not_ready' : 'pre_unknown',
					pre.reason === 'not_ready' ? 'nativeMnemonicPreread' : undefined,
				)
				return
			}
			// 0.53.39: the native start reads walletState and hasKey (passcodeStatus) and walletStatus after the pre-read.
			// It never returns early on an unknown pre-read. The route is decided by nativeStartRoute (pure, tested).
			const passcode = await capStatusRead(reqId, queryNativePasscodeStatus, { walletState: 'unknown', hasKey: 'unknown' })
			const walletStatusAnswer = await capStatusRead(reqId, queryNativeWalletStatus, { status: 'unknown' })
			const status = walletStatusAnswer.status as NativeWalletStatus
			// Unit g (rev 2): passcode_not_provided is a pending sync: it does not hold the landing; the pre-read and the key guards decide.
			const passcodePending = walletStatusAnswer.status === 'not_ready' && walletStatusAnswer.notReadyReason === 'passcode_not_provided'
			if (passcodePending) markPasscodePendingSync('pre-read start walletStatus', 'native_passcode_not_provided')
			const outcome = nativeStartRoute({ pre, walletState: passcode.walletState, hasKey: passcode.hasKey, walletStatus: status, passcodePending })
			// Unit g: a passcode account is reported and the pre-read answers absent: inconsistent. Nothing is onboarded; the wait is in the background.
			if (passcodePending && pre.kind === 'absent') {
				publishNativePwaLog('warn', `[AppEntryGate] ${startReasonLine('passcode_preread_inconsistent')}: no onboarding, data kept`)
			}
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
				// One real native read confirms the absence before the onboarding opens (shared with every other onboarding entry)
				if ((await confirmNoMnemonicOnNative(reqId)) === 'handled') return
				// explicit gate: route === 'onboard' (nativeStartRoute) and the confirmation reads above (native no_key on Android); the key-only purge is inside the helper
				await openOnboardingConfirmed('start route onboard', {
					reqId,
					alreadyConfirmed: true,
					onProceed: () => {
						publishNativePwaLog('info', '[AppEntryGate] native mnemonic pre-read absent, page confirmed empty: onboarding')
						logStartRoute(reqId, 'onboarding')
						resolveShellChatCapability()
						setStorageUnavailable(null)
					},
				})
				return
			}
			if (outcome.route === 'retry') {
				if (pre.kind === 'unknown') publishNativePwaLog('warn', 'native mnemonic pre-read unknown: startup wait')
				// the spec: absent here, but another record has data: diagnostic, data kept, no button.
				if (pre.kind === 'absent' && (outcome.reason === 'key_marker' || outcome.reason === 'record_without_mnemonic')) {
					startupWait(`pre-read absent but another record has data (${outcome.reason}): contradiction, data kept`, 'preread_contradiction')
					return
				}
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
				lockChatAccess() // unit e: the UI lock also refuses chat access (no bridge request)
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
				const passcode = await capStatusRead(reqId, queryNativePasscodeStatus, { walletState: 'unknown', hasKey: 'unknown' })
				shellWalletState = passcode.walletState
				shellHasKey = passcode.hasKey
				const walletStatusAnswer = await capStatusRead(reqId, queryNativeWalletStatus, { status: 'unknown' })
				shellWalletStatus = walletStatusAnswer.status as NativeWalletStatus
				// Unit g (rev 2): walletStatus not_ready with passcode_not_provided is an explicit pending sync (diagnostic native_passcode_not_provided).
				// Unit g (B): an old shell's old SDK never sends passcode_not_provided, so this legacy route does not reach it. The hold below is unchanged.
				if (walletStatusAnswer.status === 'not_ready' && walletStatusAnswer.notReadyReason === 'passcode_not_provided') markPasscodePendingSync('walletStatus not_ready (legacy)', 'native_passcode_not_provided')
			}
			//the shell judges by walletState (the only basis when it is reported); the transitional route uses walletStatus only.
			const judged = isShellContext()
				? judgeShellFromNative({
						idb,
						walletState: shellWalletState ?? 'not_reported',
						walletStatus: shellWalletStatus,
						hasKey: shellHasKey,
						// R96: only with the declared identity, and only when the pre-read command answered (or was never needed here as unsupported)
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
				lockChatAccess() // unit e: the UI lock also refuses chat access (no bridge request)
				setVaultLocked(true)
				return
			}
			if (judged.account === 'undetermined') {
				// R96 (b): in a shell an undetermined answer is the start state (a wait with the retry), never the generic storage-unavailable screen.
				if (isShellContext()) startupWait('account judgement undetermined (shell): the start state, retry', 'read_failed')
				else handleStorageUnavailable('undetermined')
				return
			}
			const presence = judged.account
			// a shell not_ready is wait-and-retry: no creation, recovery or import entry (shellNotReadyWait.ts).
			const notReadyWait = shellNotReadyWaitReason({ isShell: isShellContext(), walletStatus: shellWalletStatus, presence })
			if (notReadyWait) {
				startupWait(notReadyWait, 'status_not_no_key')
				return
			}
			// Y.85 (c) and Y.89: a shell enters onboarding only when the IndexedDB side and the native side both confirmed none.
			// Any unknown (or a contradicting "has") is retry: no onboarding, nothing deleted. The gate deletes nothing here.
			// No native side is asked on this path: a native webview has already decided the start above (the pre-read), so here the shell
			// has no identity hello to declare identity.native-keys.v1. Option A: the unified capability notice, never onboarding, never a creation entry.
			// R96: both sides confirmed no account (native no_key, page store empty): onboarding. Read-only; nothing is written or deleted here.
			if (judged.via === 'native_no_key') {
				// 0.53.39 (B): before onboarding the sealed copy is checked (the same native pre-read as the start).
				// valid: restore; locked: the passcode page; unknown or unreadable: retry; absent (confirmed): onboarding.
				const sealed = await queryNativeMnemonicPreread()
				if (sealed.kind === 'cipher') {
					showPrereadCipher(sealed.cipher, reqId)
					return
				}
				const route = nativeNoKeyRoute(sealed)
				publishNativePwaLog('info', `[AppEntryGate] shell no_key: sealed-copy check route=${route}`)
				if (route === 'onboard') {
					setStorageUnavailable(null)
					noKeyCtl.storageRead(true)
					goOnboarding(false)
					return
				}
				if (route === 'restore' && sealed.kind === 'valid') {
					// 0.53.39 (2nd item): the sealed-copy restore is the same as the pre-read valid path. An unreadable page
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
					await decidePrereadEntry(sealedCopy, sealed.eoa, () => applyNativeWallet(sealed.eoa), () => adoptPrereadMnemonic(sealed.phrase, sealed.eoa, reqId))
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
			// 0.53.52 (owner approval 2026-11-25): a browser page record holding only a private key is not a valid account: deleted (compare-and-delete), then the onboarding
			if (!isShellContext() && classifyPageKeyState(CoNETData as never) === 'key_only') {
				await openOnboardingConfirmed('browser key-only page record', { alreadyConfirmed: true })
				return
			}
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
			// Per R88 review of: in a shell the onboarding needs an explicit walletStatus no_key. A not_ready or unknown
			// native answer with an empty page is unknown, never a new account: the startup wait (nothing deleted, shown or routed).
			if (isShellContext() && !isExplicitNativeNoKey(shellWalletStatus)) {
				startupWait(`shell onboarding needs an explicit walletStatus no_key (got ${shellWalletStatus})`, 'status_not_no_key')
				return
			}
			// Trusted empty (or empty status): Create Beamio ID / onboarding. The native no-key route only after a confirmed-empty store.
			noKeyCtl.storageRead(storageResult.status === 'empty')
			await openOnboardingConfirmed('storage read empty with native no_key')
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

	// ---- 0.53.51 R2271-DEF-CREATE-RESUME-1: an interrupted onboarding create is resumed with its tag locked --------------------------------
	// The two entry functions of the shell home (applyNativeWallet, applyLocalWallet) are wrapped: when this device holds a pending create
	// record for the wallet, the registry decides (resumeCreateCheck: two hosts, chain id, minimum wait) between the create page and the home.
	// With no record nothing is awaited and the original function runs unchanged.
	const vaultLockedRef = useRef(false)
	vaultLockedRef.current = vaultLocked
	const nativeFlowOpenRef = useRef(false)
	const onboardingOpenRef = useRef(false)
	const resumeRecheckTimerRef = useRef<number | undefined>(undefined)
	/** the resume page that is routed now (the wallet and the tag) */
	const resumeCreateRef = useRef<{ eoa: string; tag: string } | null>(null)
	/** the wallet whose resume check was uncertain: a check is made again when the page comes back to the foreground */
	const uncertainResumeEoaRef = useRef<string | null>(null)
	onboardingOpenRef.current = showBeamioOnboardingModal
	const resumeDeps: ResumeDeps = {
		now: () => Date.now(),
		mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
		read: (url, tag, eoa) => registrationStateVia(url, tag, eoa),
		primaryUrl: CONET_RPC_URL,
		secondaryUrl: CONET_RPC_SECONDARY,
		// the device wallet from the trusted window channel (walletEoaAddress), asked only when a resume would be routed
		nativeEoa: () => readWalletEoaAddress(),
	}
	const goResumeCreate = (eoa: string, tag: string) => {
		// a resume page that is already open for this wallet is never routed again (the user may be typing in it).
		// Defence in depth: no current entry can reach this (resumeEntry and the fired mark stop a second route first), so a mutant that
		// removes this line cannot be killed by a test; that is expected.
		if (resumeCreateRef.current?.eoa === eoa && onboardingOpenRef.current) return
		markResumeFired(eoa)
		resumeCreateRef.current = { eoa, tag }
		publishNativePwaLog('info', '[AppEntryGate] interrupted create: the create page with the locked tag')
		setResumeCreate({ eoa, tag })
		goOnboarding(false, true)
	}
	/** A check after the home is shown (the entry was uncertain): the same verdicts, routed through the idle-only event. */
	const handleLateResumeVerdict = (eoa: string, v: ResumeVerdict) => {
		if (v.kind !== 'uncertain') uncertainResumeEoaRef.current = null
		if (v.kind === 'resume') {
			requestResumeRoute(eoa, v.tag, goResumeCreate)
		} else if (v.kind === 'registered') {
			pushResumeNotice('code_not_shown', eoa)
		} else if (v.kind === 'uncertain') {
			scheduleResumeRecheck(eoa, v.recheckInMs)
		}
	}
	const scheduleResumeRecheck = (eoa: string, delayMs: number) => {
		uncertainResumeEoaRef.current = eoa
		if (resumeRecheckTimerRef.current !== undefined) window.clearTimeout(resumeRecheckTimerRef.current)
		resumeRecheckTimerRef.current = window.setTimeout(() => {
			resumeRecheckTimerRef.current = undefined
			void resumeCreateCheck(eoa, resumeDeps).then((v) => handleLateResumeVerdict(eoa, v), () => scheduleResumeRecheck(eoa, 60_000))
		}, delayMs)
	}
	/** returns true when the resume check owns this entry (it calls `proceed` itself); false: the caller runs its original code at once */
	const resumeEntry = (eoa: string, proceed: () => void): boolean => {
		if (!isShellContext()) return false
		if (!hasPendingCreateRecord(eoa)) return false
		// the start runs more than once (retries, a native ready event): with the resume page already routed for this wallet nothing is checked
		// again and nothing is routed: the page stays as it is (no remount, no home, no lost input)
		if (hasResumeFired(eoa)) return true
		void resumeCreateCheck(eoa, resumeDeps).then(
			(v) => {
				if (hasResumeFired(eoa)) return // another entry routed it while this check ran
				if (v.kind === 'resume') {
					goResumeCreate(eoa, v.tag)
					return
				}
				if (v.kind === 'registered') pushResumeNotice('code_not_shown', eoa)
				if (v.kind === 'uncertain') scheduleResumeRecheck(eoa, v.recheckInMs)
				proceed()
			},
			() => proceed(),
		)
		return true
	}
	const applyNativeWallet = (eoa: string) => {
		if (resumeEntry(eoa, () => applyNativeWalletCore(eoa))) return
		applyNativeWalletCore(eoa)
	}
	const applyLocalWallet = (eoa: string) => {
		if (resumeEntry(eoa, () => applyLocalWalletCore(eoa))) return
		applyLocalWalletCore(eoa)
	}
	// The busy signals and the idle triggers of the late resume route (D4): never while a call, the settings, the unlock screen, a native flow or the create
	// page itself is on; a request that has to wait is started on the next idle signal (foreground, route change, the 30 s visible poll).
	useEffect(() => {
		// the browser has no resume route: nothing is listened to, scheduled or loaded there
		if (!isShellContext()) return
		let voiceCallModule: typeof import('@/utils/voiceCallSession') | null = null
		void import('@/utils/voiceCallSession').then((m) => { voiceCallModule = m }, () => undefined)
		const offs = [
			registerResumeBusyProbe(() => window.location.pathname.startsWith('/settings')),
			registerResumeBusyProbe(() => vaultLockedRef.current),
			registerResumeBusyProbe(() => nativeFlowOpenRef.current),
			// the call module is loaded on demand (not at import time); until it is loaded the user counts as busy (never start on a doubt)
			registerResumeBusyProbe(() => (voiceCallModule ? voiceCallModule.browserVoiceCallBusyFor({}) : true)),
			registerResumeBusyProbe(() => onboardingOpenRef.current),
		]
		const flush = () => {
			if (hasQueuedResume()) flushQueuedResume(goResumeCreate)
		}
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return
			flush()
			if (uncertainResumeEoaRef.current) scheduleResumeRecheck(uncertainResumeEoaRef.current, 1_000)
		}
		const poll = window.setInterval(() => {
			if (document.visibilityState === 'visible') flush()
		}, 30_000)
		document.addEventListener('visibilitychange', onVisible)
		window.addEventListener('popstate', flush)
		return () => {
			offs.forEach((off) => off())
			window.clearInterval(poll)
			document.removeEventListener('visibilitychange', onVisible)
			window.removeEventListener('popstate', flush)
			if (resumeRecheckTimerRef.current !== undefined) window.clearTimeout(resumeRecheckTimerRef.current)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// the identity hello is unanswered: it is probed again after 10 s, then 30 s, then every 60 s. Stops once it answers.
	useEffect(() => {
		if (!identityUnansweredRef.current || identityProbesDoneRef.current >= BRIDGE_HELLO_MAX_PROBES) return
		const id = window.setTimeout(() => {
			identityProbesDoneRef.current += 1
			void probeIdentityNow().then(() => {
				// r2.4: the bridge cadence never routes the wallet. After the last probe it stops; a manual retry or a later answer continues.
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
			if (adoptionInFlightRef.current) {
				// ②: an adoption in progress is not interrupted at the deadline; no storage-unavailable judgement. It ends on its read-back (home) or its own failure.
				publishNativePwaLog('info', `[AppEntryGate] splash deadline ${SPLASH_FORCE_DISMISS_MS}ms during an adoption: the write-back is not interrupted`)
				return
			}
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
				startupWait('splash deadline: start undecided (shell background, no screen)', 'native_retry_deadline')
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
			nativeFlowOpenRef.current = !!(e as CustomEvent<{ open?: boolean }>).detail?.open
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
			lockChatAccess() // unit e: the UI lock also refuses chat access (no bridge request)
			setVaultLocked(true)
		}
		window.addEventListener(VAULT_LOCKED_EVENT, onVaultLocked)

		// Native key state: a shell with no key for the account answers `no_key`; show the import route.
		// R-21: an unlock releases a held init once (HC-LOCK INIT-3); the native answer, not this event, decides a lock.
		const removePasscodeWatcher = nativeShell ? installPasscodeStateWatcher((state) => {
			if (state.locked) return
			releaseInitLockedHold()
			// C1: an unlock resumes a held sync exactly once (the take clears it).
			if (takePendingSync()) syncPageMnemonicToShell()
		}) : null
		const removeNoKeyWatcher = nativeShell ? installNativeNoKeyWatcher(() => {
			// Race (3.3): the import route only after the gate has decided and found no page account.
			if (!noKeyCtl.onNativeNoKey()) return
			// Per spec r2.4 item 42(2): both sides confirmed no mnemonic. The existing onboarding holds the two recovery entries; no import route.
			void openOnboardingConfirmed('native no_key event')
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
			stopVisiblePoll()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// A refused build on a background shell write shows the update screen, the same screen a refused read shows.
	useEffect(() => onAppUpdateRequired(() => showStorageUnavailable('app_update_required')), [])

	// while the wallet is not initialised, the native state is read again every 30 s, so the init retries once
	// the node list is reachable . Reaching G2 hands the app the native wallet.
	// 2026-11-24 (late is not dead): a valid hello answer that arrives after the page showed "not answered" is taken. The capability status is
	// set from it and the start re-runs at once; an earlier "unanswered" or "preparing" state is withdrawn by it (no click needed).
	useEffect(
		() =>
			onHelloValid((r) => {
				if (!nativeShellRef.current) return
				setNativeIdentityCapability(identityCapabilityFrom(r))
				identityUnansweredRef.current = false
				publishNativePwaLog('info', '[AppEntryGate] a valid hello answer arrived (possibly late): the capability state is updated and the start re-runs')
				void initRef.current?.()
			}),
		[],
	)
	// 2026-11-22: on return to the foreground a waiting shell start re-reads at once; the schedule continues afterwards.
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState !== 'visible' || !nativeShellRef.current) return
			if (startupRetryRef.current === undefined && !nativeWaitRef.current) return
			window.clearTimeout(startupRetryRef.current)
			startupRetryRef.current = undefined
			coldBackoffRef.current.reset()
			publishNativePwaLog('info', `[reread] ${startReasonLine('foreground_reread')}`)
			void initRef.current?.()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => document.removeEventListener('visibilitychange', onVisible)
	}, [])

	useEffect(() => {
		// the retry beat of the local home: the first try is made at entry (applyLocalWalletCore); this keeps trying every 30 s
		const id = window.setInterval(() => void upgradeLocalHome(), 30_000)
		return () => window.clearInterval(id)
	}, [])

	return (
		<div className="flex h-full min-h-[100dvh] w-full flex-col">
			<EmbeddedPwaUpdateBanner />
			{/* One retry control at a time (S25 r88: the G1 page showed Try again and Retry): while any start screen of the gate is shown, the identity prompt is not mounted.
			    The hold page (2026-11-21) shows only the gate's retry, the unlock control when locked, and the restore button below. */}
			{!storageUnavailable && !(splashVisible && startupRetryOffered) && <IdentityEntryPrompt />}
			<ResumeNoticeCard />
			{splashVisible && <SplashScreen />}
			{/* 0.53.44: the loading page has no Try Again and no Restore Wallet. The
			    native unlock button stays (it is the unlock, not a startup retry). The start re-reads in the background. */}
			{splashVisible && nativeLockedOffered && (
				<div className="fixed inset-x-0 bottom-10 z-[10000] flex justify-center gap-3">
					<button
						type="button"
						className="rounded-full border border-white px-5 py-2.5 text-sm font-semibold text-white"
						onClick={() => {
							setNativeLockedOffered(false)
							setVaultLockKind('native')
							lockChatAccess() // unit e: the UI lock also refuses chat access (no bridge request)
							setVaultLocked(true)
						}}
					>
						{tu('unlock_wallet')}
					</button>
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
			) : prereadCipher ? (
				<PrereadPasscodeUnlock
					cipher={prereadCipher.cipher}
					onUnlocked={(phrase, eoa, passcode) => {
						const reqId = prereadCipher.reqId
						const sentCipher = prereadCipher.cipher
						setPrereadCipher(null)
						setSplashVisible(true)
						void adoptPrereadMnemonic(phrase, eoa, reqId, isMnemonicCipherEnvelope(sentCipher) ? { cipher: sentCipher, passcode } : undefined)
					}}
					onVerifyFailed={() => {
						publishNativePwaLog('warn', '[AppEntryGate] preread cipher could not be verified (verify_failed): record kept, nothing written')
					}}
				/>
			) : storageUnavailable ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white">
					<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
						{storageUnavailable === OLD_SHELL_UPGRADE_REASON ? (
							<>
								<h1 className="text-xl font-semibold">{tu('old_shell.terminal.title')}</h1>
								{/* the spec: the shell terminal has no button (the update prompt only); terminalProbing and retryTerminalOnce are kept unused here. */}
								{!(isShellContext() || nativeShellRef.current || isCashTreesNativeWebView()) && (
									<button type="button" disabled={terminalProbing} className="mt-5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-[#071126] disabled:opacity-60" onClick={() => void retryTerminalOnce()}>
										{tu('retry')}
									</button>
								)}
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
								{/* Y.158: a recovery-oriented title (the native wallet restores its key). Manual Retry only. */}
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
						{/* 0.53.44: no recovery button at startup; the recovery code entry is in the onboarding page (v237) */}
						{/* the spec / 三端 PWA: the shell middle pages have no operable button; the browser path keeps its Retry. */}
						{!(isShellContext() || nativeShellRef.current || isCashTreesNativeWebView()) && storageUnavailable !== OLD_SHELL_UPGRADE_REASON && (
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
					resumeCreate={resumeCreate}
					onNewAccountCreated={() => setWritePermit('new_account_created', 'onboarding: new account created')}
					onRestoreWriteStart={onRestoreWriteStart}
					onRestoreWriteEnd={onRestoreWriteEnd}
					bootResolved={bootResolved}
					bootCoNETData={bootCoNETData}
					home={() => {
						setShowBeamioOnboardingModal(false)
						setRequireWalletRecover(false)
						if (resumeCreateRef.current) clearResumeFired(resumeCreateRef.current.eoa)
						resumeCreateRef.current = null
						setResumeCreate(null)
						setRestoreFromHold(false)
						setSplashVisible(false)
						// in a shell the bar waits for the App's init to load the account, as on enterApp (no clear here).
						if (!isShellContext()) setIsInitialLoading(false)
						// onboarding / recover 成功后允许进入主 App。
						markBootScreen('home')
						setGateDecided(true)
						// Per spec 44(1)(c): onboarding success enters the home, then the page mnemonic is synced to the shell
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
