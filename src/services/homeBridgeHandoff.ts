/**
 * Cold-start /home mnemonic handoff (eng-home-bridge-deferred-sdk).
 *
 * After PWA Create / Restore finishes You’re all set and the user continues to /home,
 * the shell receives one pwaWalletSync. Without a six-digit app passcode the shell stores
 * the phrase in protected plaintext storage; with a six-digit passcode it stores v3 ciphertext.
 * Browser: no bridge. Native Chat SDK init happens only after the shell accepts this handoff.
 */
import { isCashTreesNativeWebView } from '@/utils/cashTreesNativeNfc'
import { nextShellTxSeq } from './shellTxSeq'
import {
	sendPwaWalletSync,
	sendPwaWalletSyncCipher,
	pwaWalletSyncTransportAvailable,
} from './pwaWalletSyncTransport'
import { SHELL_MNEMONIC_SYNC_COMMAND } from './shellMnemonicSync'
import { sealMnemonicV3, type MnemonicCipherEnvelopeV3 } from './passcode/mnemonicCipherV3'
import { notifyNativeWalletReady } from './nativeWallet'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export type PendingHomeMnemonicHandoff = {
	eoa: string
	phrase: string
	tag: string
	/**
	 * Optional six-digit app passcode (not the BeamioTag access password).
	 * When set, shell stores sealed ciphertext; otherwise protected plaintext.
	 */
	passcode?: string
	/** Retry must reuse the same seq (Grok idempotency). */
	seq?: number
}

let pending: PendingHomeMnemonicHandoff | null = null
/** Per JS process: first actual /home handoff completed (or skipped as revisit / browser). */
let homeHandoffDone = false
/** a second call while the first is still awaiting the shell reply joins it (exactly one send per attempt). */
let inFlight: Promise<HomeHandoffResult> | null = null
/** per JS process call counter, only for log correlation (no secret, no account data). */
let handoffCallNo = 0

const EOA_RE = /^0x[0-9a-fA-F]{40}$/
const SIX_DIGIT = /^\d{6}$/

export function resetHomeBridgeHandoffForTests(): void {
	pending = null
	homeHandoffDone = false
	inFlight = null
	handoffCallNo = 0
}

export function setPendingHomeMnemonicHandoff(next: PendingHomeMnemonicHandoff): void {
	const eoa = String(next.eoa || '').trim()
	const phrase = String(next.phrase || '').trim()
	const tag = String(next.tag || '').trim().replace(/^@+/, '')
	if (!EOA_RE.test(eoa) || phrase.split(/\s+/).length < 12) return
	const rawPc = typeof next.passcode === 'string' ? next.passcode.trim() : ''
	const passcode = SIX_DIGIT.test(rawPc) ? rawPc : undefined
	pending = { eoa, phrase, tag, passcode, seq: next.seq }
}

export function peekPendingHomeMnemonicHandoff(): PendingHomeMnemonicHandoff | null {
	return pending
}

export function clearPendingHomeMnemonicHandoff(): void {
	pending = null
}

export function isHomeHandoffDone(): boolean {
	return homeHandoffDone
}

export type HomeHandoffResult = 'browser' | 'skipped' | 'ok' | 'retry' | 'unavailable'

function isEnvelope(v: unknown): v is MnemonicCipherEnvelopeV3 {
	return !!v && typeof v === 'object' && (v as { v?: unknown }).v === 3
}

type HandoffOutcome = { result: HomeHandoffResult; stage: string; code: string; seq: number; mode: string }

/** one log line per entry and per result. Only call number, stage, result and reply code are written (never the phrase, keys or addresses). */
const logHandoff = (message: string): void => publishNativePwaLog('info', `[homeHandoff] ${message}`)

async function attemptHomeHandoff(): Promise<HandoffOutcome> {
	if (homeHandoffDone) return { result: 'skipped', stage: 'already_done', code: 'none', seq: 0, mode: 'none' }
	if (!isCashTreesNativeWebView()) {
		homeHandoffDone = true
		clearPendingHomeMnemonicHandoff()
		return { result: 'browser', stage: 'browser', code: 'none', seq: 0, mode: 'none' }
	}
	const p = pending
	if (!p) {
		// No pending handoff in this JS process: this path (A) has nothing to send and says so (stage no_pending), and it is final for this start (homeHandoffDone).
		// It is NOT a rule that the PWA never tells the shell the phrase. The duty "every cold start, the first time /home is entered, the PWA tells the shell the phrase (or the passcode cipher)" is carried by
		// the other two paths, not by this one: B = a valid page mnemonic at the start judgement (AppEntryGate, `[syncSender] src=coldStartPageValid`, sendPhraseOnce) and C = the passcode account after its page unlock
		// (PasscodeLockScreen afterUiUnlock). Path A sends only when this very process has just finished Create / Restore and stored a pending (LoadingPage "You're all set" -> setPendingHomeMnemonicHandoff).
		// Per start cycle exactly one of them delivers; here `homeHandoffDone` and `inFlight` make a repeated or concurrent /home entry within the same start send nothing more.
		homeHandoffDone = true
		return { result: 'skipped', stage: 'no_pending', code: 'none', seq: 0, mode: 'none' }
	}
	const mode = p.passcode ? 'sealed' : 'plain'
	if (!pwaWalletSyncTransportAvailable()) return { result: 'unavailable', stage: 'transport', code: 'unavailable', seq: 0, mode }
	const seq = p.seq && p.seq > 0 ? p.seq : nextShellTxSeq()
	pending = { ...p, seq }
	try {
		let reply
		if (p.passcode) {
			const sealed = await sealMnemonicV3(p.phrase, p.eoa, p.passcode)
			if (!isEnvelope(sealed)) return { result: 'unavailable', stage: 'seal', code: 'seal_failed', seq, mode }
			reply = await sendPwaWalletSyncCipher(SHELL_MNEMONIC_SYNC_COMMAND, seq, sealed, p.passcode)
		} else {
			reply = await sendPwaWalletSync(SHELL_MNEMONIC_SYNC_COMMAND, seq, p.phrase, p.eoa)
		}
		const code = String(reply?.code ?? 'none')
		// mapSyncReply already folds updated|idempotent|unchanged → code 'ok'
		if (code === 'ok') {
			homeHandoffDone = true
			clearPendingHomeMnemonicHandoff()
			// the shell now holds the account; the same session starts the native chat (no cold start needed).
			try {
				notifyNativeWalletReady(p.tag, p.eoa)
			} catch {
				// the handoff itself already succeeded
			}
			return { result: 'ok', stage: 'reply', code, seq, mode }
		}
		if (code === 'bad_request' || code === 'untrusted_source') return { result: 'unavailable', stage: 'reply', code, seq, mode }
		return { result: 'retry', stage: 'reply', code, seq, mode }
	} catch {
		return { result: 'retry', stage: 'throw', code: 'exception', seq, mode }
	}
}

/**
 * Call once when the product route has settled on /home after You’re all set (or revisit).
 * Does not init Chat SDK — shell does that after accepting the sync; after an ok the existing NATIVE_WALLET_READY_EVENT is dispatched.
 */
export function runColdStartHomeHandoffOnce(): Promise<HomeHandoffResult> {
	if (inFlight) return inFlight
	const n = ++handoffCallNo
	logHandoff(`enter n=${n}`)
	const run = attemptHomeHandoff().then(
		(o) => {
			logHandoff(`result n=${n} result=${o.result} stage=${o.stage} code=${o.code} mode=${o.mode} seq=${o.seq}`)
			return o.result
		},
		() => {
			logHandoff(`result n=${n} result=retry stage=internal code=exception mode=none seq=0`)
			return 'retry' as HomeHandoffResult
		},
	)
	inFlight = run
	void run.finally(() => {
		if (inFlight === run) inFlight = null
	})
	return run
}
