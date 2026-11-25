import { secretFieldProps } from '@/utils/secretInputGuard'
import { BEAMIO_TAG_MESSAGE_KEY, BEAMIO_TAG_PATTERN, normalizeBeamioTagInput } from '@/utils/beamioTagInput'
import { IpfsImg } from '@/components/IpfsImg';
import { InvitedByIntroducerChip } from '@/components/InvitedByIntroducerChip'
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react"
import { AppButton } from "@/components/button/AppButton"
import { checkBeamioAccountAPI, createRecover, CreateRemoteError, LocalCreateError } from "@/services/beamio"
import { createRecoverCopyKey, createRemoteErrorCopyKey } from '@/services/createRecoverCopy'
import { nativeAccountCreateOpen, onNativeAccountCreateResult } from "@/services/nativeRecovery"
import { announceNativeWalletEstablished } from "@/services/nativeWalletEstablished"
import { cancelCreateWait, canStartCreate, onCreateResult, scheduleCreateFallback, startCreateWait, tickCreateWait, type CreateWaitState } from "@/services/nativeCreateWait"
import { readWalletEoaAddress } from "@/services/walletEoaAddress"
import { rereadDecision } from "@/services/manualRetryReread"
import { createRollbackRetryVisible } from "@/services/createRollbackRetry"
import { queryNativeWalletStatusForPreCheck } from "@/services/syncPreCheckReads"
import { announceNativeFlowPending } from "@/services/nativeFlowPending"
import { requestNativeIdentityRetry } from "@/services/nativeIdentityProbeRetry"
import { ensureShellChatState } from "@/services/shellChatCapability"
import { isShellContext } from "@/services/shellContext"
import { publishNativePwaLog } from "@/utils/cashTreesNativePwaLog"
import { notifyNativeWalletReady, reachNativeWallet, rememberNativeEoa } from "@/services/nativeWallet"
import { warmArgon2Worker } from "@/services/argon2WorkerBridge"
import { realRegisterDeps, registerNewAccount } from '@/services/accountCreateRegister'
import { hasPageCreate, setSecureScreen } from '@/services/shellPageCreate'
import { clearPendingCreateTag, markPendingForwardAccepted, markPendingForwardSent, readPendingCreateTag, writePendingCreateTag } from '@/services/pendingCreateTag'
import { pushResumeNotice } from '@/services/resumeNotice'
import { CONET_RPC_URL } from '@/config/chainAddresses'
import RecoverCodeNotice from '@/components/RecoverCodeNotice'
import {
	Eye,
	EyeOff,
	AlertTriangle,
	Check,
	LockKeyhole,
	RefreshCw,
	Shield,
	ArrowRight,
} from "lucide-react"
import { getActivatingSteps } from "./RecoveryQRScreen"
import { VerraFloatingNavChrome } from "./VerraFloatingNavChrome"
import { APP_FLOATING_CHROME_MAIN_TOP_PT, APP_TITLE_BLOCK_TO_FIRST_CONTROL_MB } from "@/ui/appContentSpacing"
import { useTu } from '@/locale/beamioLocale'
import { getCurrentBeamioUiLocale } from '@/locale/i18n'
import { openInAppBrowser } from '@/utils/cashTreesNativeNfc'

/** How long the recover code may stay on screen (r3sk), in wall-clock milliseconds. */
export const RECOVER_CODE_TTL_MS = 5 * 60 * 1000

const BEAMIO_TERMS_URL = "https://beamio.ca/terms"
const BEAMIO_PRIVACY_URL = "https://beamio.ca/privacy"
const APP_LOGO_SRC = `${process.env.PUBLIC_URL ?? ''}/logo192.png`

function CreateIdentityDecorativeBg() {
	return (
		<>
			<div
				className="pointer-events-none fixed top-0 right-0 -z-10 h-1/3 w-1/3 min-h-[200px] min-w-[200px] translate-x-1/2 -translate-y-1/2 rounded-full bg-[#004bc3]/5 blur-[120px]"
				aria-hidden
			/>
			<div
				className="pointer-events-none fixed bottom-0 left-0 -z-10 h-1/2 w-1/2 min-h-[240px] min-w-[240px] -translate-x-1/4 translate-y-1/4 rounded-full bg-[#465c99]/5 blur-[160px]"
				aria-hidden
			/>
		</>
	)
}

const CREATING_STEP_DEFS = [
	{ id: 0, titleKey: 'configuring_global_network', icon: Shield },
	{ id: 1, titleKey: 'preparing_your_smart_wallet', icon: RefreshCw },
] as const
const STEP_DURATION_MS = 2000
const ACTIVATING_STEP_DURATION_MS = 5000

export type CreateUsernamePinScreenRef = { goBack: () => boolean }

/** Brief pause so React can commit the loading tree before crypto starts. */
const CREATE_RECOVER_START_DELAY_MS = 100

/** Double rAF + micro-delay so CSS animations paint before async crypto work. */
function waitForLoadingPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				window.setTimeout(resolve, CREATE_RECOVER_START_DELAY_MS)
			})
		})
	})
}


/** Same persist rules as bizSite `BusinessIdentityForm` — wallet password must pass before createRecover. */
function passwordRuleChecks(password: string) {
	const len8 = password.length >= 8
	const hasLower = /[a-z]/.test(password)
	const hasUpper = /[A-Z]/.test(password)
	const mixed = hasLower && hasUpper
	const numbers = /[0-9]/.test(password)
	return { len8, mixed, numbers, hasLower, hasUpper }
}

const CreateUsernamePinScreen = forwardRef<
	CreateUsernamePinScreenRef,
	{
		close: (val: { qrDataUrl: string; pin: string; passcode: string; temp: any; beamioTag: string }) => void,
		isRedeemFlow?: boolean,
		onRequestClose?: () => void,
		/** 创建钱包 loading 时通知父级（用于隐藏顶栏、整页垂直居中，避免光晕被裁切） */
		onCreatingWalletChange?: (creating: boolean) => void,
		/** the account has a key without a BeamioTag. This page reuses that key, has no back step and never creates a wallet. */
		reuseExistingKey?: boolean,
		/** an already-bound account: the parent opens the PWA restore page with this tag. */
		onRequestRestore?: (tag: string) => void,
		/** 0.53.51: resume of an interrupted create: the wallet and the tag the gate found (the tag is locked, the wallet is checked at step 1) */
		resumeEoa?: string,
		resumeTag?: string,
	}
>(function CreateUsernamePinScreen(
	{ close, isRedeemFlow = false, onRequestClose, onCreatingWalletChange, reuseExistingKey = false, onRequestRestore, resumeEoa, resumeTag },
	ref
) {
	const { tu } = useTu()
	/** 0.53.50 (r3sk R-1 a): the tag that passed step 1 is locked for step 2 and, after an interruption, prefilled and locked for the completion. */
	const [lockedTag, setLockedTag] = useState(() => (resumeTag ?? '').trim().replace(/^@+/, ''))
	const [beamioName, setBeamioName] = useState(() => (resumeTag ?? '').trim().replace(/^@+/, ''))
	/** The wallet of this create (step 1): the record of the locked tag is kept and cleared under it. A resume starts with the wallet the gate found. */
	const createEoaRef = useRef((resumeEoa ?? '').trim().toLowerCase())
	/** a resume of an interrupted create (the gate sent the user here with a locked tag) */
	const resumeEoaLower = (resumeEoa ?? '').trim().toLowerCase()
	// After an interruption the device already has the wallet: the tag recorded for it is prefilled and locked. No record (another browser,
	// cleared storage, a wallet that is not readable): nothing is locked and the user types the tag.
	useEffect(() => {
		if (!isShellContext() || resumeEoaLower) return
		let alive = true
		void readWalletEoaAddress()
			.catch(() => null)
			.then((r) => {
				if (!alive || !r || r.kind !== 'address') return
				const tag = readPendingCreateTag(r.eoa)
				if (!tag) return
				createEoaRef.current = r.eoa
				setLockedTag(tag)
				setBeamioName(tag)
			})
		return () => {
			alive = false
		}
	}, [])
	const [password, setPassword] = useState("")
	const [passwordTouched, setPasswordTouched] = useState(false)
	const [showPassword, setShowPassword] = useState(false)
	const lastCheckedRef = useRef("")
	const passwordInputRef = useRef<HTMLInputElement>(null)
	const [tagStatus, setTagStatus] = useState<"idle" | "checking" | "valid" | "invalid">("idle")
	const [tagError, setTagError] = useState("")
	const [createError, setCreateError] = useState("")

	// Pending native create: set when the native page opens; cleared only on ok, on cancel (the page is
	// closed), or when this screen unmounts. A failed result keeps the native page open and keeps pending: no second open.
	const nativeCreatePendingRef = useRef(false)
	// v10.2 r4 §2.2: the native create wait (event first, 10-minute fallback) and its cancel timer.
	const createWaitRef = useRef<CreateWaitState>({ kind: 'idle' })
	/** 0.53.50: the onboarding create waits here for step 1 (nativeAccountCreateOpen) to report; the result listener resolves it. */
	type ShellCreateStep = { kind: 'created'; eoa: string } | { kind: 'exists' } | { kind: 'failed' }
	const shellCreateWaitRef = useRef<((step: ShellCreateStep) => void) | null>(null)
	const createWaitCancelRef = useRef<(() => void) | null>(null)
	const createWaitSeqRef = useRef(0)
	// v10 §九: after a write_failed (any reason, or none) the next create action rereads walletEoaAddress first.
	const createRereadRequiredRef = useRef(false)
	const [writeHold, setWriteHold] = useState(false)
	/** Starts the native wait (event first, 10-minute fallback). Used by the opened page and by page none (the nested result). */
	const startNativeWait = () => {
		createWaitSeqRef.current += 1
		createWaitRef.current = startCreateWait(Date.now(), createWaitSeqRef.current)
		createWaitCancelRef.current?.()
		createWaitCancelRef.current = scheduleCreateFallback(() => {
			createWaitRef.current = tickCreateWait(createWaitRef.current, Date.now())
			if (createWaitRef.current.kind !== 'fallback') return
			nativeCreatePendingRef.current = false
			announceNativeFlowPending(false)
			setNativeOpening(false)
			setLoading(false)
			{
				const w = shellCreateWaitRef.current
				shellCreateWaitRef.current = null
				w?.({ kind: 'failed' })
			}
			publishNativePwaLog('info', '[createAccount] shell: no result in 10 minutes; the wait ends, a new create needs the reread')
			setCreateError(tu('create_account_try_later'))
		})
	}
	// v10 §九 OB-3 (line 285): a held write (rollback_pending) shows a retry only when the §六.2 conditions hold (checked live).
	const [rollbackPending, setRollbackPending] = useState(false)
	const [rollbackRetryVisible, setRollbackRetryVisible] = useState(false)
	// the BeamioTag of the native create in progress; cached with its EOA when the native result arrives
	const createTagRef = useRef("")
	/**consecutive G0 not_available acks (three show the terminal copy), the 15 s wait before a manual retry, and the "正在打开" state. */
	const g0NotAvailableCountRef = useRef(0)
	const createCooldownUntilRef = useRef(0)
	const [nativeOpening, setNativeOpening] = useState(false)
	// 0.53.49: an already-bound account opens the PWA restore page (prefilled with the tag typed here); that page hands the credential to the
	// native engine and enters the app on the original EOA itself. This page opens no native recovery page.
	const openNativeRecoveryFromCreate = () => {
		onRequestRestore?.(createTagRef.current)
	}

	// Shell: the native create page reports its result. ok enters the app on the native wallet, with no reload.
	useEffect(() => {
		if (!isShellContext()) return
		const off = onNativeAccountCreateResult((accepted) => {
			// v10.2 r4 §2.2: a result ends the wait (event first) and is delivered once; a result with no wait is dropped.
			const waited = onCreateResult(createWaitRef.current)
			createWaitRef.current = waited.state
			createWaitCancelRef.current?.()
			createWaitCancelRef.current = null
			if (!waited.deliver) return
			setNativeOpening(false)
			// 0.53.50: a create that the page itself is running (steps 1 to 3) takes the result here. A new key (ok) or an account the device
			// already has (already_exists) goes on to step 2; any other code ends the run after the copy below.
			const waiter = shellCreateWaitRef.current
			shellCreateWaitRef.current = null
			if (waiter) {
				if (accepted.code === 'ok' || accepted.code === 'already_exists') {
					nativeCreatePendingRef.current = false
					waiter(accepted.code === 'ok' ? { kind: 'created', eoa: accepted.eoa ?? '' } : { kind: 'exists' })
					return
				}
				waiter({ kind: 'failed' })
			}
			if (accepted.code === 'shape_violation') {
				// r11 §11: an ok/code mismatch ends the wait at once, shows a retry, and logs the category only (never a key name or value).
				publishNativePwaLog('warn', '[createAccount] native create result: shape violation (ok_code_mismatch); wait ended, retry offered')
				nativeCreatePendingRef.current = false
				announceNativeFlowPending(false)
				setLoading(false)
				setCreateError(tu('create_account_try_later'))
				return
			}
			const { code, eoa } = accepted
			if (code === 'already_bound') {
				//3: already bound. The native recovery opens and returns the original EOA; no new EOA is made.
				nativeCreatePendingRef.current = false
				setLoading(false)
				openNativeRecoveryFromCreate()
				return
			}
			if (code === 'lookup_unavailable') {
				//3: the binding lookup failed. Nothing is created; try again later.
				nativeCreatePendingRef.current = false
				setCreateError(tu('create_account_try_later'))
				return
			}
			if (code === 'ok') {
				// CT-16 (r5 §五): a late ok after a failure hint clears the hint and establishes the wallet (no duplicate create)
				setCreateError('')
				// the wallet is established now, synchronously, before any async read (the gate refuses a late no_key).
				announceNativeWalletEstablished()
				nativeCreatePendingRef.current = false
				rememberNativeEoa(eoa)
				void reachNativeWallet().then((st) => {
					if (st.status === 'unlocked') notifyNativeWalletReady(createTagRef.current, eoa)
					else setCreateError(tu('create_account_try_later'))
				})
				return
			}
			if (code === 'already_exists') {
				// r3 / r11 §2: already_exists is never a success on its own. The create is handed back to the entry judgement, which reads
				// the native account (page first, then the native record) and waits when it cannot decide. eoa is not used here.
				nativeCreatePendingRef.current = false
				announceNativeFlowPending(false)
				setLoading(false)
				requestNativeIdentityRetry()
				return
			}
			if (code === 'not_ready') {
				// category C: the native create is not finished (F-CREATE-1). The wait ends; retry opens a new create request.
				nativeCreatePendingRef.current = false
				announceNativeFlowPending(false)
				setLoading(false)
				setCreateError(tu('create_account_try_later'))
				return
			}
			if (code === 'cancelled') {
				nativeCreatePendingRef.current = false
				announceNativeFlowPending(false)
				// CT-15b (v10.2 r5 §四): the native page was closed: the wait ends, nothing is judged, the user may create again.
				setCreateError(tu('create_account_cancelled_retry'))
				return
			}
			// v10 §九 OB-2…OB-4: a write_failed never completes. The reason decides the copy; a missing or unknown reason is the
			// conservative case: no completion, the explanation only, and a reread of walletEoaAddress before any further action.
			if (code === 'write_failed' || code === 'readback_failed') {
				createRereadRequiredRef.current = true
				setRollbackPending(accepted.code === 'write_failed' && accepted.reason === 'rollback_pending')
				// a write_failed without a reason, or with the old-copy reason (no button), holds the submit button:
				// explanation only. Leaving and re-entering the create page re-runs the entry rules (state resets on remount).
				// v10 §九 OB-4 (line 286): old_copy_unverified is "无按钮", so the normal submit is disabled; the most conservative case (reason missing or
				// outside the vocabulary, undefined here) has no retry button either. It holds for the rest of this page session. internal_state and
				// storage_write show a retry (OB-1, OB-2: the normal submit stays enabled); rollback_pending has its own button (OB-3) and is not held.
				// rollback_pending also holds the normal submit (v10 line 285: "按钮条件同第六节"; the retry goes only through the
				// conditioned OB-3 button). The OB-3 button bypasses writeHold and stays bound by its whitelist and live reread.
				setWriteHold(accepted.code === 'write_failed' && (accepted.reason === undefined || accepted.reason === 'rollback_pending' || accepted.reason === 'old_copy_unverified'))
				if (accepted.code === 'write_failed' && accepted.reason === 'old_copy_unverified') {
					setCreateError(tu('shell_sync_old_copy_unverified_body'))
					return
				}
				setCreateError(tu('create_account_try_later'))
				return
			}
			// readback_failed and others: the native page stays open: the pending state is kept (the native page stays open for another confirmation) and no new create request is offered (r9 / TM-1). The failure is shown.
			setCreateError(tu('create_account_try_later'))
		})
		return () => {
			off()
			createWaitCancelRef.current?.()
			createWaitCancelRef.current = null
			nativeCreatePendingRef.current = false
			announceNativeFlowPending(false)
		}
	}, [])
	const [termsAccepted, setTermsAccepted] = useState(false)
	const [loading, setLoading] = useState(false)
	const [creatingStep, setCreatingStep] = useState(0)
	const [viewportHeight, setViewportHeight] = useState(() =>
		typeof window === "undefined"
			? 0
			: Math.round(window.visualViewport?.height ?? window.innerHeight)
	)

	// Prefetch Argon2 Worker while the user fills the form (avoids cold-start on Next)
	useEffect(() => {
		warmArgon2Worker()
	}, [])

	const steps = isRedeemFlow
		? getActivatingSteps()
		: CREATING_STEP_DEFS.map((s) => ({
				...s,
				title: tu(s.titleKey),
				desc: '',
			}))
	const stepDuration = isRedeemFlow ? ACTIVATING_STEP_DURATION_MS : STEP_DURATION_MS
	const isCompactHeight = viewportHeight > 0 && viewportHeight <= 760
	const isVeryCompactHeight = viewportHeight > 0 && viewportHeight <= 620
	const isUltraCompactHeight = viewportHeight > 0 && viewportHeight <= 560
	const shouldHideInfoCards = isCompactHeight
	const topInsetPadding = isUltraCompactHeight
		? "calc(env(safe-area-inset-top) + 3.75rem)"
		: isVeryCompactHeight
			? "calc(env(safe-area-inset-top) + 4.25rem)"
			: "calc(env(safe-area-inset-top) + 4.75rem)"

	const localValidateTag = (raw: string) => {
		const trimmed = normalizeBeamioTagInput(raw)
		if (!trimmed) return { ok: false, v: "", msg: tu('please_enter_a_beamiotag') }
		if (!BEAMIO_TAG_PATTERN.test(trimmed)) {
			return { ok: false, v: trimmed, msg: tu(BEAMIO_TAG_MESSAGE_KEY) }
		}
		return { ok: true, v: trimmed, msg: "" }
	}

	const validateAndCheckTag = async () => {
		// a locked tag was checked before step 1 (or is registered to this wallet after an interruption): it is not asked again
		if (lockedTag) return true
		if (tagStatus === "checking") return false

		const { ok, v, msg } = localValidateTag(beamioName)
		setTagError("")

		if (!ok) {
			if (v.length > 0) {
				setTagStatus("invalid")
				setTagError(msg)
			} else {
				setTagStatus("idle")
			}
			return false
		}

		if (v === lastCheckedRef.current && tagStatus === "valid") return true
		lastCheckedRef.current = v

		setTagStatus("checking")
		try {
			const available = await checkBeamioAccountAPI(v)
			if (!available) {
				setTagStatus("invalid")
				setTagError(tu('tag_is_already_taken', { tag: v }))
				return false
			}
			setTagStatus("valid")
			setTagError("")
			return true
		} catch {
			setTagStatus("invalid")
			setTagError(tu('network_error_try_again'))
			return false
		}
	}

	const tagChecking = !lockedTag && tagStatus === "checking"
	const tagValid = !!lockedTag || tagStatus === "valid"

	useEffect(() => {
		if (lockedTag) return
		const trimmed = normalizeBeamioTagInput(beamioName)
		if (trimmed.length <= 2) return
		if (trimmed === lastCheckedRef.current && tagStatus === "valid") return

		const t = setTimeout(() => {
			void validateAndCheckTag()
		}, 3000)
		return () => clearTimeout(t)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 beamioName / tagStatus 重置 debounce
	}, [beamioName, tagStatus])

	useEffect(() => {
		if (typeof window === "undefined") return

		const syncViewportHeight = () => {
			const nextHeight = Math.round(window.visualViewport?.height ?? window.innerHeight)
			setViewportHeight(nextHeight)
			// Do not write --beamio-native-viewport-height here: LoadingPage onboarding
			// overlay uses that variable for height; shrinking it exposes App shell (#000414).
		}

		syncViewportHeight()
		window.addEventListener("resize", syncViewportHeight)
		window.visualViewport?.addEventListener("resize", syncViewportHeight)
		window.visualViewport?.addEventListener("scroll", syncViewportHeight)

		return () => {
			window.removeEventListener("resize", syncViewportHeight)
			window.visualViewport?.removeEventListener("resize", syncViewportHeight)
			window.visualViewport?.removeEventListener("scroll", syncViewportHeight)
		}
	}, [])

	const { len8, mixed, numbers, hasLower, hasUpper } = passwordRuleChecks(password)
	const pwdRulesOk = len8 && mixed && numbers
	// 0.53.50: the shell create page collects the password like the browser; it goes to the native layer in accountCreateRegister.
	const canSubmit = tagValid && pwdRulesOk && termsAccepted && !loading && !tagChecking
	// Four meter segments map 1:1 to length / lowercase / uppercase / digit.
	// Persist is still the original 3 rules (mixed = both cases); all persist → 4/4 = 100%.
	const passwordStrengthCount = [len8, hasLower, hasUpper, numbers].filter(Boolean).length
	const passwordStrengthPercent = passwordStrengthCount * 25
	const passwordStrengthLabel =
		passwordStrengthCount >= 4
			? tu('strong_security')
			: passwordStrengthCount >= 2
				? tu('building_security')
				: passwordStrengthCount >= 1
					? tu('basic_security')
					: tu('set_a_secure_password')
	const passwordIssues = [
		!len8 ? tu('at_least_8_characters') : "",
		!mixed ? tu('upper_and_lowercase_letters') : "",
		!numbers ? tu('at_least_one_number') : "",
	].filter(Boolean)
	const showPasswordIssues = passwordTouched && password.length > 0 && passwordIssues.length > 0

	useEffect(() => {
		onCreatingWalletChange?.(loading)
	}, [loading, onCreatingWalletChange])

	useEffect(() => {
		if (!loading) {
			setCreatingStep(0)
			return
		}
		const advance = () => setCreatingStep((prev) => Math.min(prev + 1, steps.length - 1))
		const timers: ReturnType<typeof setTimeout>[] = []
		const lead = CREATE_RECOVER_START_DELAY_MS + 50
		for (let i = 1; i < steps.length; i++) {
			timers.push(setTimeout(advance, lead + i * stepDuration))
		}
		return () => timers.forEach((t) => clearTimeout(t))
	}, [loading, isRedeemFlow, steps.length, stepDuration])

	useImperativeHandle(
		ref,
		() => ({
			goBack: () => {
				onRequestClose?.()
				return true
			},
		}),
		[onRequestClose]
	)

	/** The wallet of a finished registration, kept until the user has confirmed the recover code. */
	const registeredWalletRef = useRef('')
	const [shellRecoverCode, setShellRecoverCode] = useState<string | null>(null)
	/** The wall-clock moment the recover code was rendered (r3sk: the 5-minute limit is judged on absolute time, not on a timer that background throttling can stall). */
	const codeShownAtRef = useRef(0)
	// The screen protection was turned on before the code was rendered (handleShellRegister); it goes off when the code is gone or the page leaves.
	useEffect(() => {
		if (!shellRecoverCode) return
		return () => {
			void setSecureScreen(false)
		}
	}, [shellRecoverCode])
	// The code is hidden after RECOVER_CODE_TTL_MS of wall-clock time. Checked by a timer and, because a background page's timers are throttled,
	// at once when the page comes back (visibilitychange, pageshow, focus, resume).
	useEffect(() => {
		if (!shellRecoverCode) return
		const expire = () => {
			registeredWalletRef.current = ''
			codeShownAtRef.current = 0
			setShellRecoverCode(null)
			announceNativeFlowPending(false)
			setCreateError(tu('create_account_recover_code_expired'))
		}
		const check = () => {
			if (codeShownAtRef.current > 0 && Date.now() - codeShownAtRef.current >= RECOVER_CODE_TTL_MS) expire()
		}
		const onVisible = () => {
			if (document.visibilityState === 'visible') check()
		}
		const timer = setInterval(check, 1000)
		document.addEventListener('visibilitychange', onVisible)
		document.addEventListener('resume', check)
		window.addEventListener('pageshow', check)
		window.addEventListener('focus', check)
		return () => {
			clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisible)
			document.removeEventListener('resume', check)
			window.removeEventListener('pageshow', check)
			window.removeEventListener('focus', check)
		}
	}, [shellRecoverCode])
	const finishShellRegister = (wallet: string) => {
		// step 4 is done (the code was confirmed, or the registration was complete already): the record of the locked tag goes
		clearPendingCreateTag(wallet)
		clearPendingCreateTag(createEoaRef.current)
		setCreateError('')
		announceNativeFlowPending(false)
		announceNativeWalletEstablished()
		rememberNativeEoa(wallet)
		void reachNativeWallet().then((st) => {
			if (st.status === 'unlocked') notifyNativeWalletReady(createTagRef.current, wallet)
			else setCreateError(tu('create_account_try_later'))
		})
	}
	const handleShellRegister = async (tag: string, pwd: string) => {
		let out
		try {
			const deps = await realRegisterDeps()
			const recordEoa = createEoaRef.current
			// the pending record learns when step 3 is first sent (`s`) and when the server answers 2xx (`a`): non-secret times
			out = await registerNewAccount(
				{ tag, password: pwd },
				{
					...deps,
					beforeFirstForward: () => markPendingForwardSent(recordEoa, Date.now()),
					afterForwardOk: (atMs) => markPendingForwardAccepted(recordEoa, atMs),
				},
			)
		} finally {
			// the password leaves the page state as soon as the call returns
			setPassword('')
			setLoading(false)
		}
		if (out.ok) {
			if (out.recoverCodeBase58) {
				// r3sk: the screen protection is on before the code is rendered; a shell that cannot give it gets "unavailable" and no code
				const secured = await setSecureScreen(true)
				if (!secured) {
					announceNativeFlowPending(false)
					setCreateError(tu('create_account_native_unavailable'))
					return
				}
				registeredWalletRef.current = out.wallet
				codeShownAtRef.current = Date.now()
				setShellRecoverCode(out.recoverCodeBase58)
				return
			}
			// r4 N1: the completion page of an interrupted create ended on "already registered": the password just typed did not take effect
			if (out.alreadyRegistered && resumeEoaLower) pushResumeNotice('already_registered_keep_password', out.wallet)
			finishShellRegister(out.wallet)
			return
		}
		announceNativeFlowPending(false)
		switch (out.code) {
			case 'tag_taken':
				// the registry holds this tag for another account: the lock is released so the user can choose another tag (the wallet stays)
				clearPendingCreateTag(createEoaRef.current)
				setLockedTag('')
				// the last native check after the page's own pre-check (a race): the same copy as the pre-check, back to renaming
				lastCheckedRef.current = ''
				setTagStatus('invalid')
				setTagError(tu('tag_is_already_taken', { tag }))
				return
			case 'bad_tag':
				setCreateError(tu('create_account_invalid_name'))
				return
			case 'bad_password':
				setCreateError(tu('create_account_invalid_password'))
				return
			case 'post_failed':
				setCreateError(tu('network_error_try_again'))
				return
			case 'not_available':
			case 'unavailable':
			case 'bad_request':
			case 'bad_response':
				setCreateError(tu('create_account_native_unavailable'))
				return
			default:
				setCreateError(tu('create_account_try_later'))
		}
	}

	/** The step 1 refusals: each open failure reason has its own copy; loading ends. */
	const showShellOpenFailure = (opened: Extract<Awaited<ReturnType<typeof nativeAccountCreateOpen>>, { ok: false }>) => {
		setLoading(false)
		publishNativePwaLog('warn', `[createAccount] shell: native create unavailable reason=${opened.reason}`)
		// OB-5 (v10 §九): a locked native side is not a completion and not a second create; the unlock branch (gate) resumes the start.
		if (opened.reason === 'locked') {
			setCreateError(tu('create_account_try_later'))
			return
		}
		// Compatibility branch only (an old shell): the new SDKs send already_bound as the nested result event.
		if (opened.reason === 'already_bound') {
			openNativeRecoveryFromCreate()
			return
		}
		if (opened.reason === 'lookup_unavailable') {
			setCreateError(tu('create_account_try_later'))
			return
		}
		if (opened.reason === 'bad_request') {
			// the name is not a valid BeamioTag for the native create; nothing was sent
			setCreateError(tu('create_account_invalid_name'))
			return
		}
		if (opened.reason === 'not_available') {
			if (opened.walletStatus === 'G1' || opened.walletStatus === 'G2') {
				// G1 and G2 show "unavailable" and do not retry.
				setCreateError(tu('create_account_unavailable'))
				return
			}
			// G0, or no walletStatus (treated as G0): try later; the 15 s wait applies; three in a row show the terminal copy (manual retry stays open).
			g0NotAvailableCountRef.current += 1
			createCooldownUntilRef.current = Date.now() + 15_000
			setCreateError(g0NotAvailableCountRef.current >= 3
				? tu('create_account_unavailable_terminal')
				: `${tu('create_account_try_later')} ${tu('create_account_close_native_first')}`)
			return
		}
		// F-CREATE-1 §4, r10 OPEN-4: not_ready at the open is a retryable wait (try later), never the unsupported-version message.
		if (opened.reason === 'not_ready') {
			setCreateError(tu('create_account_try_later'))
			return
		}
		// not_supported and no_key: the shell does not offer creation yet.
		setCreateError(tu('create_account_native_unavailable'))
	}

	/**
	 * The device already has an account (already_exists): the registration is completed only for the same account when the registry holds no
	 * BeamioTag for it (an earlier run ended before addUser). Any other case goes back to the entry judgement.
	 */
	const canCompleteRegistration = async (tag: string): Promise<boolean> => {
		try {
			const r = await readWalletEoaAddress().catch(() => null)
			if (!r || r.kind !== 'address') return false
			// 0.53.51: the same registration-state function as the gate (tag owner or wallet account), not the account read alone
			const { registrationStateVia } = await import('@/services/beamio')
			return (await registrationStateVia(CONET_RPC_URL, tag, r.eoa)) === 'unregistered'
		} catch {
			return false
		}
	}

	/** Shell onboarding create (0.53.50): step 1 nativeAccountCreateOpen (headless), step 2 accountCreateRegister, step 3 addUser, then the recover code. */
	const handleShellCreate = async (trimmedTag: string, pwd: string) => {
		const stop = (copy: string) => {
			setLoading(false)
			announceNativeFlowPending(false)
			setCreateError(copy)
		}
		// without identity.native-keys.v1 or account.page-create.v1 nothing is sent; the unified unavailable notice shows (no page fallback).
		if ((await ensureShellChatState()) !== 'native_chat' || !(await hasPageCreate())) {
			publishNativePwaLog('warn', '[createAccount] shell: identity.native-keys.v1 or account.page-create.v1 not declared; nothing sent')
			return stop(tu('create_account_native_unavailable'))
		}
		createTagRef.current = trimmedTag
		if (nativeCreatePendingRef.current) {
			setLoading(false)
			return
		}
		// after a G0 not_available the user waits at least 15 s before a new open (no same-reqId resend, no automatic retry).
		if (Date.now() < createCooldownUntilRef.current) {
			return stop(`${tu('create_account_try_later')} ${tu('create_account_close_native_first')}`)
		}
		// v10.2 r4 §2.2: a pending wait admits no new create; after the 10-minute fallback a new create needs the reread (PWA-RETRY-03).
		if (createWaitRef.current.kind === 'cancelled') {
			return stop(tu('create_account_close_native_retry'))
		}
		if (createWaitRef.current.kind === 'pending') {
			return stop(tu('create_account_try_later'))
		}
		if (createWaitRef.current.kind === 'fallback') {
			if (!canStartCreate(createWaitRef.current, { kind: 'timeout' })) {
				return stop(tu('create_account_native_still_open'))
			}
			const r = await readWalletEoaAddress().catch(() => null)
			const reread = r === null ? { kind: 'timeout' as const } : r.kind === 'address' ? { kind: 'address' as const } : { kind: 'refused' as const, code: r.code }
			if (!canStartCreate(createWaitRef.current, reread)) return stop(tu('create_account_try_later'))
			createWaitRef.current = { kind: 'idle' }
		}
		if (createRereadRequiredRef.current) {
			const r = await readWalletEoaAddress().catch(() => null)
			const reread = r === null ? { kind: 'timeout' as const } : r.kind === 'address' ? { kind: 'address' as const } : { kind: 'refused' as const, code: r.code }
			if (rereadDecision(reread) !== 'send') {
				return stop(tu('create_account_try_later'))
			}
			createRereadRequiredRef.current = false
		}
		// step 1: the waiter is set before the open, so a result that arrives right behind the ack is not lost
		const stepDone = new Promise<ShellCreateStep>((resolve) => {
			shellCreateWaitRef.current = resolve
		})
		announceNativeFlowPending(true)
		publishNativePwaLog('info', '[createAccount] shell: native create requested (headless)')
		const opened = await nativeAccountCreateOpen(trimmedTag)
		if (!opened.ok) {
			shellCreateWaitRef.current = null
			announceNativeFlowPending(false)
			showShellOpenFailure(opened)
			return
		}
		g0NotAvailableCountRef.current = 0
		nativeCreatePendingRef.current = true
		// the wait starts: the nested result event (already_bound, lookup_unavailable) and the ok result are delivered through it
		startNativeWait()
		const step = await stepDone
		nativeCreatePendingRef.current = false
		if (step.kind !== 'failed') {
			// step 1 passed for this tag: it is recorded under the wallet; step 2 uses this tag, and so does the completion after an interruption
			let eoa = step.kind === 'created' ? step.eoa : ''
			if (!eoa) {
				const r = await readWalletEoaAddress().catch(() => null)
				eoa = r && r.kind === 'address' ? r.eoa : ''
			}
			// r3 D2: a resume is for the wallet the gate found. The wallet step 1 answered for must be that wallet; otherwise this tag is not used:
			// no record is written, the lock is dropped and the normal create flow applies (the other wallet's own record stays untouched).
			if (resumeEoaLower && eoa.toLowerCase() !== resumeEoaLower) {
				publishNativePwaLog('warn', '[createAccount] resume: the device wallet is not the one the resume was found for; the locked tag is dropped')
				createEoaRef.current = ''
				setLockedTag('')
				setLoading(false)
				announceNativeFlowPending(false)
				setCreateError(tu('create_account_try_later'))
				return
			}
			if (eoa) {
				createEoaRef.current = eoa
				writePendingCreateTag(eoa, trimmedTag)
			}
			setLockedTag(trimmedTag)
		}
		if (step.kind === 'failed') {
			// the result listener showed the copy for the code
			setLoading(false)
			announceNativeFlowPending(false)
			return
		}
		if (step.kind === 'exists' && !(await canCompleteRegistration(trimmedTag))) {
			// an account the device already has, or the registry holds a tag for it: back to the entry judgement
			setLoading(false)
			announceNativeFlowPending(false)
			requestNativeIdentityRetry()
			return
		}
		// steps 2 and 3
		await handleShellRegister(trimmedTag, pwd)
	}

	const handleCreateWallet = async (pwd: string) => {
		// a locked tag (step 1 passed) is the only tag step 2 may use
		const trimmedTag = lockedTag || normalizeBeamioTagInput(beamioName || "")
		const { len8: l, mixed: m, numbers: n } = passwordRuleChecks(pwd)
		if (!trimmedTag || !l || !m || !n) return

		setLoading(true)
		setCreateError("")
		// Argon2 runs in a Worker; still wait one paint so ripple/orbit start before network/crypto
		await waitForLoadingPaint()

		//in a shell the page never generates an account key (createRecover would, through createOrGetWallet). The shell
		// creates the account natively; until it answers ok, the unavailable notice is shown. Logs carry no secret.
		if (isShellContext()) {
			await handleShellCreate(trimmedTag, pwd)
			return
		}
		let kks: Awaited<ReturnType<typeof createRecover>> = null
		// the failure of THIS call, kept in a local: never read from the state of an earlier render (a stale createError hid the second failure)
		let failureCopy = ''
		try {
			kks = await createRecover(trimmedTag, pwd, { mustReuseKey: reuseExistingKey })
		} catch (ex) {
			failureCopy = tu(
				ex instanceof LocalCreateError
					? createRecoverCopyKey(ex.step)
					: ex instanceof CreateRemoteError
						? createRemoteErrorCopyKey(ex.kind)
						: 'network_error_try_again',
			)
			setCreateError(failureCopy)
		} finally {
			setLoading(false)
		}

		if (!kks) {
			// a null result without a thrown reason is still a failure of this call: show the generic network message (never nothing)
			setCreateError(failureCopy || tu('network_error_try_again'))
			return
		}

		close({
			qrDataUrl: kks.qrCode,
			pin: pwd,
			passcode: kks.recoverCode,
			temp: kks.temp,
			beamioTag: trimmedTag,
		})
		// 0.53.48.1: the account is registered but this device could not save the wallet yet. The recovery code page is open; the
		// onboarding save runs again after it. Say so, so the user keeps the code and does not make a second account.
		if ('persistFailed' in kks && kks.persistFailed) window.alert(tu('create_account_registered_save_code'))
	}

	// OB-3 (v10 §九 line 285; §6.2), create-page rule: the retry shows only when the reread is valid or absent and walletStatus is not locked.
	// Deviation (for review): no persistent held-write record on this page, so hasRecord and accountMatches are not judged (see createRollbackRetry.ts).
	useEffect(() => {
		if (!rollbackPending) {
			setRollbackRetryVisible(false)
			return
		}
		let alive = true
		void (async () => {
			const r = await readWalletEoaAddress().catch(() => null)
			const reread = r === null ? { kind: 'timeout' as const } : r.kind === 'address' ? { kind: 'address' as const } : { kind: 'refused' as const, code: r.code }
			const st = await queryNativeWalletStatusForPreCheck().catch(() => 'timeout' as const)
			// OB-3 create-page rule (createRollbackRetry.ts): the live reread and walletStatus only; no persistent record exists on this page.
			const visible = createRollbackRetryVisible({ reason: 'rollback_pending', reread, nativeStatus: st })
			if (alive) setRollbackRetryVisible(visible)
		})()
		return () => {
			alive = false
		}
	}, [rollbackPending])
	const onSubmitPress = async (bypassWriteHold = false) => {
		if (!canSubmit || (writeHold && !bypassWriteHold)) return
		setRollbackPending(false)
		const ok = await validateAndCheckTag()
		if (!ok) return
		const p = password.trim()
		const { len8: l, mixed: m, numbers: n } = passwordRuleChecks(p)
		if (!l || !m || !n) return
		await handleCreateWallet(p)
	}

	if (loading) {
		return (
			<div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#f9f9ff] font-[Inter,system-ui,sans-serif] text-[#151c27]">
				<style>{`
					@keyframes beamio-passport-ripple {
						0% { transform: translateZ(0) scale(0.5); opacity: 0; }
						50% { opacity: 1; }
						100% { transform: translateZ(0) scale(1.2); opacity: 0; }
					}
					@keyframes beamio-passport-orbit {
						from { transform: translateZ(0) rotate(0deg); }
						to { transform: translateZ(0) rotate(360deg); }
					}
				`}</style>

				<main className="flex min-h-0 w-full max-w-lg flex-1 flex-col items-center justify-center self-center overflow-hidden px-6 pt-[max(1rem,env(safe-area-inset-top))] py-12 text-center [@media(max-height:700px)]:py-8 [@media(max-height:640px)]:py-6">
					{/* Ripple + orbit + logo */}
					<div
						className="relative mb-12 flex w-full max-w-[320px] aspect-square shrink-0 items-center justify-center
							[@media(max-height:700px)]:mb-8 [@media(max-height:700px)]:max-w-[260px]
							[@media(max-height:640px)]:mb-6 [@media(max-height:640px)]:max-w-[220px]"
					>
						<div className="absolute inset-0 -z-10 rounded-full bg-[#004bc3]/5 blur-3xl" aria-hidden />
						<div className="relative flex h-[240px] w-[240px] items-center justify-center [@media(max-height:700px)]:h-[200px] [@media(max-height:700px)]:w-[200px] [@media(max-height:640px)]:h-[168px] [@media(max-height:640px)]:w-[168px]">
							{[0, 1, 2].map((i) => (
								<div
									key={i}
									className="absolute rounded-full border border-[rgba(21,98,240,0.1)]"
									style={{
										width: `${100 - i * 20}%`,
										height: `${100 - i * 20}%`,
										animation: `beamio-passport-ripple 3s linear infinite`,
										animationDelay: `${i}s`,
										opacity: 0,
										willChange: 'transform, opacity',
										transform: 'translateZ(0)',
									}}
									aria-hidden
								/>
							))}
							<div
								className="absolute inset-0"
								style={{
									animation: 'beamio-passport-orbit 4s linear infinite',
									willChange: 'transform',
									transform: 'translateZ(0)',
								}}
								aria-hidden
							>
								<div className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1562f0]" />
							</div>
							<div
								className="relative z-10 flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-white shadow-lg [@media(max-height:640px)]:h-20 [@media(max-height:640px)]:w-20"
								style={{ transform: 'translateZ(0)' }}
							>
								<IpfsImg
									src={APP_LOGO_SRC}
									alt="Beamio"
									className="h-16 w-16 rounded-xl object-contain shadow-[0_4px_20px_rgba(0,75,195,0.15)] [@media(max-height:640px)]:h-12 [@media(max-height:640px)]:w-12 [@media(max-height:640px)]:rounded-lg"
									draggable={false}
								/>
							</div>
						</div>
					</div>

					<h1 className="mb-8 max-w-md text-center text-[32px] font-bold leading-10 tracking-[-0.02em] text-[#151c27] [@media(max-height:700px)]:mb-6 [@media(max-height:700px)]:text-[28px] [@media(max-height:700px)]:leading-9 [@media(max-height:640px)]:mb-4 [@media(max-height:640px)]:text-[22px] [@media(max-height:640px)]:leading-7">
						{isRedeemFlow ? tu('securing_your_identity') : tu('issuing_your_digital_passport')}
					</h1>

					<div className="w-full max-w-md space-y-4 px-4 text-left [@media(max-height:700px)]:space-y-3 [@media(max-height:640px)]:space-y-2.5 [@media(max-height:640px)]:px-2">
						{steps.map((s, idx) => {
							const isCompleted = idx < creatingStep
							const isActive = idx === creatingStep
							const isPending = !isCompleted && !isActive
							return (
								<div
									key={s.id}
									className={[
										'flex items-start space-x-4 transition-opacity',
										isActive ? 'opacity-70' : '',
										isPending ? 'opacity-40' : '',
									]
										.filter(Boolean)
										.join(' ')}
								>
									<div
										className={[
											'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-[0_4px_10px_rgba(0,0,0,0.03)]',
											isCompleted
												? 'border-[#dce2f3] bg-[#e2e8f8]'
												: isActive
													? 'border-[#1562f0] bg-white text-[#1562f0] shadow-[0_4px_20px_rgba(21,98,240,0.1)]'
													: 'border-[#dce2f3] bg-white',
										].join(' ')}
									>
										{isCompleted ? (
											<Check className="h-5 w-5 text-[#22c55e]" strokeWidth={3} aria-hidden />
										) : isActive ? (
											<RefreshCw className="h-5 w-5 animate-spin text-[#1562f0]" strokeWidth={2.25} aria-hidden />
										) : (
											<span className="h-2 w-2 rounded-full bg-[#c3c6d8]" aria-hidden />
										)}
									</div>
									<div className="flex min-w-0 flex-col pt-1">
										<span className="text-lg font-semibold leading-7 text-[#151c27] [@media(max-height:640px)]:text-base [@media(max-height:640px)]:leading-6">
											{s.title}
										</span>
										{s.desc ? (
											<span className="mt-0.5 text-xs text-[#424655] [@media(max-height:640px)]:text-[11px]">
												{s.desc}
											</span>
										) : null}
									</div>
								</div>
							)
						})}
					</div>
				</main>

				<footer className="flex shrink-0 flex-col items-center px-6 pb-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))] pt-3 [@media(max-height:700px)]:pt-2 [@media(max-height:640px)]:pt-1.5">
					<p className="mb-2 text-center text-xs font-semibold uppercase leading-4 tracking-[0.05em] text-[#737687]">
						{tu('do_not_close_the_app_during_this_process')}
					</p>
					<div className="flex space-x-1.5" aria-hidden>
						<div className="h-1.5 w-1.5 rounded-full bg-[#1562f0]/40" />
						<div className="h-1.5 w-1.5 rounded-full bg-[#1562f0]" />
						<div className="h-1.5 w-1.5 rounded-full bg-[#1562f0]/40" />
					</div>
				</footer>
			</div>
		)
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#f9f9ff] font-[Inter,system-ui,sans-serif] text-[#151c27]">
			<CreateIdentityDecorativeBg />
			{shellRecoverCode ? (
				<RecoverCodeNotice
					code={shellRecoverCode}
					onDone={() => {
						const wallet = registeredWalletRef.current
						registeredWalletRef.current = ''
						setShellRecoverCode(null)
						finishShellRegister(wallet)
					}}
				/>
			) : null}
			<VerraFloatingNavChrome onBack={() => onRequestClose?.()} tone="create" hideBack={reuseExistingKey} />
			<main
				lang={getCurrentBeamioUiLocale() === 'zh-CN' ? 'zh-CN' : 'en'}
				className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 pb-[max(1rem,env(safe-area-inset-bottom))] [@media(max-height:700px)]:pb-[max(0.875rem,env(safe-area-inset-bottom))] [@media(max-height:640px)]:pb-[max(0.75rem,env(safe-area-inset-bottom))] [@media(max-height:560px)]:px-5 [@media(max-height:560px)]:pb-[max(0.625rem,env(safe-area-inset-bottom))] ${APP_FLOATING_CHROME_MAIN_TOP_PT}`}
				style={{ paddingTop: topInsetPadding }}
			>
				<div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
					<div
						className={`shrink-0 text-center ${APP_TITLE_BLOCK_TO_FIRST_CONTROL_MB} [@media(max-height:780px)]:mb-8 [@media(max-height:700px)]:mb-6 [@media(max-height:640px)]:mb-4 [@media(max-height:560px)]:mb-3`}
					>
						<h1 className="mb-2 text-[32px] font-bold leading-10 tracking-[-0.02em] text-[#151c27] [@media(max-height:780px)]:text-[28px] [@media(max-height:780px)]:leading-9 [@media(max-height:700px)]:text-[24px] [@media(max-height:700px)]:leading-8 [@media(max-height:640px)]:mb-1.5 [@media(max-height:640px)]:text-[22px] [@media(max-height:640px)]:leading-7 [@media(max-height:560px)]:mb-1 [@media(max-height:560px)]:text-[20px]">
							{tu('create_your_beamio_id')}
						</h1>
						<p className="px-4 text-base font-normal leading-6 text-[#424655] [@media(max-height:700px)]:text-[15px] [@media(max-height:640px)]:px-2 [@media(max-height:640px)]:text-sm [@media(max-height:640px)]:leading-snug [@media(max-height:560px)]:text-[12px] [@media(max-height:560px)]:leading-[1.25]">
							{tu('your_unique_identity_in_the_beamio_network_use_it_to_connect_with_friend')}
						</p>
						<div className="mt-4 text-left">
							<InvitedByIntroducerChip />
						</div>
					</div>

					<div className="flex min-h-0 flex-1 flex-col justify-between gap-5 [@media(max-height:780px)]:gap-4 [@media(max-height:700px)]:gap-3 [@media(max-height:640px)]:gap-2.5 [@media(max-height:560px)]:gap-2">
						<div className="space-y-5 [@media(max-height:780px)]:space-y-4 [@media(max-height:700px)]:space-y-3 [@media(max-height:640px)]:space-y-2.5 [@media(max-height:560px)]:space-y-2">
						<div className="space-y-2 [@media(max-height:640px)]:space-y-1.5 [@media(max-height:560px)]:space-y-1">
							<label htmlFor="create-beamio-tag-input" className="block text-xs font-semibold uppercase tracking-[0.05em] text-[#424655] [@media(max-height:560px)]:text-[11px]">
								{tu('beamiotag')}
							</label>
							<div className="relative">
								<div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
									<span className="mr-1 text-lg font-normal text-[#004bc3] [@media(max-height:560px)]:text-base">@</span>
								</div>
								<input
									id="create-beamio-tag-input"
									lang="en-US"
									dir="ltr"
									translate="no"
									name="beamioTag"
									readOnly={loading || tagChecking || !!lockedTag}
									type="text"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									enterKeyHint="next"
									autoComplete="username"
									inputMode="text"
									className={[
										"w-full rounded-lg border-none bg-[#dce2f3] py-3 pl-10 pr-12 text-lg font-normal text-[#151c27] outline-none transition-all placeholder:text-[#737687] focus:bg-white focus:ring-1 focus:ring-[#004bc3] [@media(max-height:780px)]:py-3 [@media(max-height:700px)]:py-2.5 [@media(max-height:640px)]:py-2.5 [@media(max-height:640px)]:text-base [@media(max-height:560px)]:rounded-lg [@media(max-height:560px)]:py-2 [@media(max-height:560px)]:pl-9 [@media(max-height:560px)]:pr-10 [@media(max-height:560px)]:text-[15px]",
										"disabled:opacity-70",
										tagStatus === "invalid" ? "ring-2 ring-orange-400/80 focus:ring-orange-400/30" : "",
									].join(" ")}
									value={beamioName}
									placeholder={tu('username')}
									onChange={(e) => {
										if (tagChecking || lockedTag) return
										const next = normalizeBeamioTagInput(e.currentTarget.value)
										setBeamioName(next)
										setTagStatus("idle")
										setTagError("")
									}}
									onBlur={async () => {
										const trimmed = normalizeBeamioTagInput(beamioName)
										if (trimmed.length < 3) return
										const ok = await validateAndCheckTag()
										if (ok) passwordInputRef.current?.focus()
									}}
									onKeyDown={async (e) => {
										if (e.key === "Enter") {
											e.preventDefault()
											e.stopPropagation()
											const ok = await validateAndCheckTag()
											if (ok) passwordInputRef.current?.focus()
										}
									}}
								/>
								<div className="pointer-events-none absolute inset-y-0 right-5 flex items-center [@media(max-height:560px)]:right-4">
									{tagChecking && (
										<div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/80 [@media(max-height:560px)]:h-7 [@media(max-height:560px)]:w-7">
											<div className="h-4 w-4 animate-spin rounded-full border-2 border-[#737687] border-t-[#004bc3] [@media(max-height:560px)]:h-3.5 [@media(max-height:560px)]:w-3.5" />
										</div>
									)}
									{tagValid && !tagChecking && (
										<div className="flex items-center justify-center rounded-full bg-emerald-500 p-0.5">
											<Check className="h-4 w-4 text-white" strokeWidth={3} aria-hidden />
										</div>
									)}
								</div>
							</div>
							{tagStatus === "invalid" ? (
								<div className="flex items-center gap-2 px-4 pt-1 text-orange-600 [@media(max-height:560px)]:px-3 [@media(max-height:560px)]:pt-0.5">
									<AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden />
									<span className="text-[13px] font-semibold leading-snug [@media(max-height:560px)]:text-[11px]">{tagError}</span>
								</div>
							) : tagValid ? (
								<p className="px-4 text-[13px] font-medium text-emerald-600 [@media(max-height:560px)]:px-3 [@media(max-height:560px)]:text-[11px]">{tu('this_tag_is_available')}</p>
							) : (
								<p className="text-sm font-medium leading-5 text-[#737687] [@media(max-height:560px)]:text-[12px]">{tu('permanent_cannot_be_changed_later')}</p>
							)}
						</div>

						<div className="mt-4 space-y-3.5 [@media(max-height:700px)]:mt-3 [@media(max-height:700px)]:space-y-3 [@media(max-height:640px)]:space-y-2.5 [@media(max-height:560px)]:mt-2 [@media(max-height:560px)]:space-y-2">
							<>
							<div className="space-y-2 [@media(max-height:640px)]:space-y-1.5 [@media(max-height:560px)]:space-y-1">
								<label htmlFor="create-wallet-password" className="block text-xs font-semibold uppercase tracking-[0.05em] text-[#424655] [@media(max-height:560px)]:text-[11px]">
									{tu('secure_password')}
								</label>
								<div className="relative">
									<input
										{...secretFieldProps('pin')}
										ref={passwordInputRef}
										id="create-wallet-password"
										readOnly={loading}
										type={showPassword ? "text" : "password"}
										autoComplete="new-password"
										enterKeyHint="next"
										className="w-full rounded-lg border-none bg-[#dce2f3] py-3 pl-4 pr-12 text-lg font-normal tracking-widest text-[#151c27] outline-none transition-all placeholder:text-[#737687] focus:bg-white focus:ring-1 focus:ring-[#004bc3] disabled:opacity-70 [@media(max-height:700px)]:py-2.5 [@media(max-height:640px)]:text-base [@media(max-height:560px)]:py-2 [@media(max-height:560px)]:pr-11 [@media(max-height:560px)]:text-[15px]"
										value={password}
										placeholder="••••••••••••"
										onChange={(e) => setPassword(e.currentTarget.value)}
										onBlur={() => setPasswordTouched(true)}
										onKeyDown={(e) => {
											if (e.key !== "Enter") return
											e.preventDefault()
											e.stopPropagation()
											if (loading) return
											if (canSubmit) void onSubmitPress()
										}}
									/>
									<button
										type="button"
										tabIndex={-1}
										className="absolute inset-y-0 right-3 flex items-center rounded-lg p-1 text-[#737687] transition-colors hover:text-[#424655] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#004bc3]/30"
										onClick={() => setShowPassword(!showPassword)}
										aria-label={showPassword ? tu('hide_password') : tu('show_password')}
									>
										{showPassword ? <EyeOff className="h-5 w-5" strokeWidth={2} /> : <Eye className="h-5 w-5" strokeWidth={2} />}
									</button>
								</div>
							</div>

							<div className="mt-2 space-y-1 [@media(max-height:560px)]:space-y-1">
								<div className="flex h-1 gap-1" aria-hidden>
									{[0, 1, 2, 3].map((idx) => (
										<div
											key={idx}
											className={[
												"flex-1 rounded-full transition-colors",
												idx < passwordStrengthCount ? "bg-[#004bc3]" : "bg-[#dce2f3]",
											].join(" ")}
										/>
									))}
								</div>
								<div className="mt-1 flex items-center justify-between">
									<span className="text-sm font-medium leading-5 text-[#424655] [@media(max-height:560px)]:text-[12px]">
										{passwordStrengthLabel}
									</span>
									<span className="text-sm font-medium leading-5 text-[#737687] [@media(max-height:560px)]:text-[12px]">
										{passwordStrengthPercent}%
									</span>
								</div>
								{showPasswordIssues ? (
									<div className="space-y-1 rounded-xl bg-orange-50 px-3 py-2 text-orange-700">
										<p className="text-[12px] font-bold leading-snug">{tu('please_fix')}</p>
										<ul className="space-y-0.5">
											{passwordIssues.map((issue) => (
												<li key={issue} className="flex items-center gap-1.5 text-[12px] font-semibold leading-snug">
													<AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
													<span>{issue}</span>
												</li>
											))}
										</ul>
									</div>
								) : null}
							</div>
							</>
						</div>

						{!shouldHideInfoCards ? (
							<div className="mx-auto mt-2 flex w-full max-w-md items-center justify-center gap-4 rounded-2xl bg-[#f1f6fd] px-4 py-3.5 text-center [@media(max-height:640px)]:gap-3 [@media(max-height:640px)]:px-3.5 [@media(max-height:640px)]:py-3">
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#1562f0] text-white shadow-[0_4px_10px_rgba(21,98,240,0.18)]">
									<LockKeyhole className="h-6 w-6" strokeWidth={2.5} aria-hidden />
								</div>
								<p className="max-w-[260px] text-center text-sm font-medium leading-[1.35] text-[#3f51a5] [@media(max-height:640px)]:text-[13px]">
									{tu('password_encryption_notice')}
								</p>
							</div>
						) : null}

						</div>

					<div className="mt-auto flex w-full shrink-0 flex-col items-center px-0 pt-2 [@media(max-height:700px)]:pt-1.5 [@media(max-height:640px)]:pt-1 [@media(max-height:560px)]:pt-0.5">
						{nativeOpening && !createError ? (
						<p className="text-[12px] text-slate-500">{tu('create_account_opening')}</p>
					) : null}
					{/* CT-15 (r5 §四): the cancel control during the wait ends it; nothing is judged; a retry is then possible. */}
					{nativeOpening ? (
						<button type="button" className="mb-2 text-[12px] text-slate-600 underline" onClick={() => {
							createWaitCancelRef.current?.()
							createWaitCancelRef.current = null
							createWaitRef.current = cancelCreateWait(createWaitRef.current)
							nativeCreatePendingRef.current = false
							announceNativeFlowPending(false)
							setNativeOpening(false)
							setCreateError(tu('create_account_cancelled_retry'))
						}}>{tu('create_account_cancel')}</button>
					) : null}
					{rollbackRetryVisible ? (
						<button type="button" className="mb-2 text-[12px] text-slate-700 underline" onClick={() => void onSubmitPress(true)}>{tu('create_account_retry_action')}</button>
					) : null}
					{createError ? (
							<div className="mb-3 flex w-full items-start gap-1.5 px-1 text-red-600">
								<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
								<span className="text-[11px] font-semibold leading-snug">{createError}</span>
							</div>
						) : null}
						<div className="mb-4 flex max-w-md items-start gap-3 px-2 text-left text-xs font-semibold uppercase tracking-[0.05em] leading-4 text-[#737687] [@media(max-height:700px)]:mb-3 [@media(max-height:640px)]:mb-2 [@media(max-height:560px)]:mb-1.5 [@media(max-height:560px)]:text-[11px]">
							<button
								type="button"
								role="checkbox"
								aria-checked={termsAccepted}
								aria-label="Agree to Terms of Service and Privacy Policy"
								tabIndex={0}
								disabled={loading}
								onClick={() => setTermsAccepted((prev) => !prev)}
								className={[
									"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border transition",
									termsAccepted
										? "border-[#004bc3] bg-[#004bc3] text-white"
										: "border-[#b8bcd0] bg-white text-transparent",
									loading ? "cursor-not-allowed opacity-60" : "active:scale-95",
								].join(" ")}
							>
								<Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
							</button>
							<p className="min-w-0 flex-1">
								{tu('by_continuing_you_agree_to_our')}
								{' '}
								<button
									type="button"
									onClick={() => openInAppBrowser(BEAMIO_TERMS_URL)}
									className="text-[#004bc3] hover:underline"
								>
									{tu('terms_of_service')}
								</button>
								{' '}
								{tu('and')}
								{' '}
								<button
									type="button"
									onClick={() => openInAppBrowser(BEAMIO_PRIVACY_URL)}
									className="text-[#004bc3] hover:underline"
								>
									{tu('privacy_policy')}
								</button>
								.
							</p>
						</div>
						<AppButton
							fullWidth
							loading={loading}
							disabled={!canSubmit || writeHold}
							rightIcon={!loading ? <ArrowRight className="h-4 w-4" strokeWidth={2.5} aria-hidden /> : undefined}
							className={[
								"!rounded-full !py-4 !text-sm !font-medium !transition-transform active:scale-95 [@media(max-height:700px)]:!py-3.5 [@media(max-height:640px)]:!py-3 [@media(max-height:560px)]:!py-2.5",
								canSubmit
									? "!inline-flex !items-center !justify-center !gap-2 !bg-[#004bc3] !text-white !shadow-[0_8px_30px_rgba(0,75,195,0.1)] hover:!bg-[#004bc3]/90 focus-visible:!ring-2 focus-visible:!ring-[#004bc3]/50 focus-visible:!ring-offset-2 focus-visible:!ring-offset-[#f9f9ff]"
									: "!cursor-not-allowed !bg-[#c3c6d8] !text-[#737687] !shadow-none",
							].join(" ")}
							onClick={() => void onSubmitPress()}
						>{tu('next')}</AppButton>
					</div>
					</div>
				</div>
			</main>
		</div>
	)
})

export default CreateUsernamePinScreen
