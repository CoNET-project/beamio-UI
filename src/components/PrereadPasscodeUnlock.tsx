/**
 * the spec（有口令）与 316.4：the cold start got the current v3 ciphertext and no plaintext. The PWA shows this page, decrypts the
 * record itself and hands the phrase to the gate, which then writes it to the page IndexedDB and reads it back.
 *
 * Counting (2026-11-22, the decision item 1; f3 passcodeBackoff and passcodeWrapStore):
 * - every attempt goes through attemptUnlock with the persisted passcodeAttemptStore of the account: the count is written before the
 *   judgement, so a refresh or a crash cannot skip it; a lock survives a refresh;
 * - only unlock_failed (a wrong passcode, or a tampered record: GCM authentication failed) counts;
 * - verify_failed (decrypted, but the address does not match) is not counted: the count written for it is reverted and read back, and
 *   nothing is written to the record; the account is not treated as missing and nothing is entered;
 * - a failed read or write refuses the attempt (nothing is decrypted or counted).
 * The shell middle page has no operable button: six digits submit on their own. Nothing is logged except reason codes.
 */
import { useEffect, useRef, useState } from 'react'
import { ZERO_ATTEMPTS, attemptUnlock, gateAt, type AttemptState, type AttemptStore } from '@/services/passcode/passcodeBackoff'
import { idbKeyValueDb, passcodeAttemptStore, type KeyValueDb } from '@/services/passcode/passcodeWrapStore'
import { isSixDigitPasscode, openMnemonicV3, type OpenMnemonicResult } from '@/services/passcode/mnemonicCipherV3'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { startReasonLine } from '@/services/startReasonCodes'

export interface PrereadPasscodeUnlockProps {
	/** The current v3 envelope as the native side returned it (not decrypted yet). Never modified here. */
	cipher: unknown
	/** The phrase and its EOA after a successful decrypt. The gate writes and reads back before the home. */
	/** `passcode` is the six digits just typed: it goes only to the one pwaWalletSync of this unlock (never stored or logged). */
	onUnlocked: (phrase: string, eoa: string, passcode: string) => void
	/** The record cannot be verified (address mismatch, version, parameters). Nothing is changed; the gate holds. */
	onVerifyFailed: () => void
	/** The key-value store of the passcode documents (production: IndexedDB; tests inject one). */
	db?: KeyValueDb
}

type Message = '' | 'unlock_failed' | 'cooldown' | 'verify_failed' | 'refused'

const EOA_RE = /^0x[0-9a-f]{40}$/

/** The account the envelope belongs to (lower case), or '' when the envelope carries no valid address. Only the key of the counter. */
function accountEoaOf(cipher: unknown): string {
	const e = (cipher as { eoa?: unknown } | null)?.eoa
	return typeof e === 'string' && EOA_RE.test(e.toLowerCase()) ? e.toLowerCase() : ''
}

/** Writes `prev` back (no count when there was none) and reads it back. Returns false when the read-back does not match. */
async function revertAttempts(store: AttemptStore, prev: AttemptState | null): Promise<boolean> {
	const target = prev ?? { ...ZERO_ATTEMPTS }
	await store.write(target)
	const back = await store.read()
	const same = (back?.failures ?? 0) === target.failures && (back?.lockedUntilMs ?? 0) === target.lockedUntilMs
	if (!same) publishNativePwaLog('warn', startReasonLine('revert_unconfirmed'))
	return same
}

export function PrereadPasscodeUnlock({ cipher, onUnlocked, onVerifyFailed, db }: PrereadPasscodeUnlockProps) {
	const [digits, setDigits] = useState('')
	const [message, setMessage] = useState<Message>('')
	const [lockUntil, setLockUntil] = useState(0)
	const [now, setNow] = useState(() => Date.now())
	const busyRef = useRef(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const locked = lockUntil > now
	const retrySec = Math.max(1, Math.ceil((lockUntil - now) / 1000))

	// the lock is read from the persisted counter: a refresh does not clear it
	useEffect(() => {
		let alive = true
		const eoa = accountEoaOf(cipher)
		if (!eoa) return
		void (async () => {
			try {
				const store = passcodeAttemptStore(db ?? idbKeyValueDb(), eoa)
				const state = await store.read()
				const gate = gateAt(state ?? { ...ZERO_ATTEMPTS }, Date.now())
				if (alive && gate.kind === 'locked') setLockUntil(Date.now() + gate.retryAfterMs)
			} catch {
				publishNativePwaLog('warn', startReasonLine('record_unreadable'))
			}
		})()
		return () => {
			alive = false
		}
	}, [cipher, db])

	useEffect(() => {
		if (!locked) return
		const id = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(id)
	}, [locked])

	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	const submit = async (passcode: string) => {
		if (busyRef.current || !isSixDigitPasscode(passcode)) return
		busyRef.current = true
		try {
			const eoa = accountEoaOf(cipher)
			if (!eoa) {
				// no valid address on the envelope: nothing is counted, nothing is decrypted
				setMessage('verify_failed')
				onVerifyFailed()
				return
			}
			const store = passcodeAttemptStore(db ?? idbKeyValueDb(), eoa)
			const prev = await store.read()
			const box: { verdict: OpenMnemonicResult | null } = { verdict: null }
			const outcome = await attemptUnlock(store, Date.now(), async () => {
				box.verdict = await openMnemonicV3(cipher, passcode)
				return box.verdict.code === 'ok'
			})
			const verdict = box.verdict
			setDigits('')
			if (outcome.kind === 'refused') {
				publishNativePwaLog('warn', startReasonLine(outcome.reason === 'read_failed' ? 'record_unreadable' : 'write_failed'))
				setMessage('refused')
				return
			}
			if (outcome.kind === 'locked') {
				setLockUntil(Date.now() + outcome.retryAfterMs)
				publishNativePwaLog('info', startReasonLine('cooldown_active'))
				setMessage('cooldown')
				return
			}
			if (outcome.kind === 'correct' && verdict?.code === 'ok') {
				setMessage('')
				onUnlocked(verdict.phrase, verdict.eoa, passcode)
				return
			}
			// a wrong judgement: the count was written before it. Only unlock_failed keeps it.
			if (verdict?.code === 'verify_failed') {
				await revertAttempts(store, prev)
				publishNativePwaLog('warn', startReasonLine('verify_failed'))
				setLockUntil(prev && prev.lockedUntilMs > Date.now() ? prev.lockedUntilMs : 0)
				setMessage('verify_failed')
				onVerifyFailed()
				return
			}
			publishNativePwaLog('info', startReasonLine('unlock_failed'))
			if (outcome.kind === 'wrong' && outcome.locked) {
				setLockUntil(Date.now() + outcome.retryAfterMs)
				setMessage('cooldown')
				return
			}
			setMessage('unlock_failed')
		} catch {
			// a failed read/write or an unexpected error: the count written before the judgement is reverted; nothing is entered
			publishNativePwaLog('warn', startReasonLine('record_unreadable'))
			setDigits('')
			setMessage('refused')
		} finally {
			busyRef.current = false
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[#071126] px-6 text-center text-white" data-testid="preread-passcode-unlock">
			<div className="w-full max-w-md rounded-3xl border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-xl">
				<h1 className="text-xl font-semibold">Enter your six-digit passcode</h1>
				<p className="mt-3 text-sm leading-6 text-white/75">
					This wallet is protected by a passcode. It is unlocked on this device; nothing is deleted.
				</p>
				<input
					ref={inputRef}
					data-testid="preread-passcode-input"
					type="password"
					inputMode="numeric"
					autoComplete="off"
					aria-label="Six-digit passcode"
					disabled={locked}
					value={digits}
					onChange={(e) => {
						const next = e.target.value.replace(/\D/g, '').slice(0, 6)
						setDigits(next)
						if (next.length === 6) void submit(next)
					}}
					className="mt-5 w-full rounded-2xl bg-white/10 px-4 py-3 text-center text-2xl tracking-[0.5em] text-white outline-none disabled:opacity-50"
				/>
				{message === 'unlock_failed' && <p data-testid="preread-passcode-message" className="mt-3 text-sm text-red-200">Incorrect passcode. Nothing was changed.</p>}
				{(message === 'cooldown' || locked) && (
					<p data-testid="preread-passcode-message" className="mt-3 text-sm text-amber-200">
						Too many attempts. Try again in {retrySec} s.
					</p>
				)}
				{message === 'verify_failed' && (
					<p data-testid="preread-passcode-message" className="mt-3 text-sm text-red-200">The record does not match this account. Nothing was used or changed.</p>
				)}
				{message === 'refused' && (
					<p data-testid="preread-passcode-message" className="mt-3 text-sm text-red-200">The passcode could not be checked. Nothing was changed.</p>
				)}
			</div>
		</div>
	)
}

export default PrereadPasscodeUnlock
