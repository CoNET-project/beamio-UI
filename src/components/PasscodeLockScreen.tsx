/**
 * Start-up lock for a wallet protected by a passcode.
 * Driven by the flow table (passcodeFlow.ts, mode `unlock`). Visual values come from the tokens (passcode-tokens.v1.json).
 * Shown by AppEntryGate before any app content mounts. Failed tries are counted and waited on; nothing is erased here.
 * Forgetting the passcode leads to an explicit local reset and re-import with the recovery phrase.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { unlockWalletVaultWithPasscode, wipeLocalWalletForRestore } from '../services/beamio'
import { PASSCODE_MAX_DIGITS, PASSCODE_MIN_DIGITS } from '../services/passcode/passcodeRules'
import { PASSCODE_TOKENS as T } from '../services/passcode/passcodeTokens'
import { applyFlowEvent, startFlow, type FlowSnapshot } from '../services/passcode/passcodeFlow'
import { ERROR_TEXT, WRONG_TEXT, backoffText, formatCooldown } from '../services/passcode/passcodeMessages'
import PasscodeDotInput from './passcode/PasscodeDotInput'

export default function PasscodeLockScreen({ onUnlocked }: { onUnlocked: () => void }) {
	const [snap, setSnap] = useState<FlowSnapshot>(() => startFlow('unlock'))
	const [digits, setDigits] = useState('')
	const [notice, setNotice] = useState('')
	const [busy, setBusy] = useState(false)
	const [waitUntil, setWaitUntil] = useState(0)
	const [now, setNow] = useState(Date.now())
	const [forgot, setForgot] = useState(false)
	const [confirmReset, setConfirmReset] = useState(false)

	useEffect(() => {
		if (waitUntil <= Date.now()) return
		const id = window.setInterval(() => setNow(Date.now()), 500)
		return () => window.clearInterval(id)
	}, [waitUntil])

	// Read the clock at render time; the interval only forces the re-render, so the first render after a wait is exact.
	const waitLeft = Math.max(0, waitUntil - Math.max(now, Date.now()))

	// The cooldown ends the run (table: unlock → cooldown → done/backoff). When the wait is over, a new unlock run starts.
	useEffect(() => {
		if (snap.done && snap.result === 'backoff' && waitUntil > 0 && waitLeft === 0) {
			setWaitUntil(0)
			setNotice('')
			setSnap(startFlow('unlock'))
		}
	}, [snap, waitLeft, waitUntil])

	const inputLocked = busy || waitLeft > 0 || snap.done
	const canTry = !inputLocked && digits.length >= PASSCODE_MIN_DIGITS

	const submit = async () => {
		if (!canTry) return
		if (!/^[0-9]{8,12}$/.test(digits)) {
			setNotice(`Enter ${PASSCODE_MIN_DIGITS} to ${PASSCODE_MAX_DIGITS} digits.`)
			return
		}
		setBusy(true)
		setNotice('')
		try {
			const res = await unlockWalletVaultWithPasscode(digits)
			if (res.ok) {
				setDigits('')
				setSnap(applyFlowEvent(snap, 'submit_match'))
				onUnlocked()
				return
			}
			if (res.reason === 'wrong_passcode' || res.reason === 'backoff') {
				const wait = res.retryAfterMs ?? 0
				if (wait > 0) {
					setWaitUntil(Date.now() + wait)
					setNotice(backoffText(wait))
					setSnap(applyFlowEvent(snap, 'cooldown'))
				} else {
					setNotice(WRONG_TEXT)
					setSnap(applyFlowEvent(snap, 'submit_wrong'))
				}
			} else {
				setNotice(ERROR_TEXT)
				setSnap(applyFlowEvent(snap, 'internal_error'))
				setSnap(startFlow('unlock'))
			}
			setDigits('')
		} catch {
			setNotice(ERROR_TEXT)
			setDigits('')
			setSnap(startFlow('unlock'))
		} finally {
			setBusy(false)
		}
	}

	const reset = async () => {
		if (!confirmReset || busy) return
		setBusy(true)
		try {
			await wipeLocalWalletForRestore()
			window.location.reload()
		} catch {
			setNotice('Reset failed. Your data may still be on this device. Reload and try again.')
			setBusy(false)
		}
	}

	const card: CSSProperties = {
		width: '100%',
		maxWidth: 400,
		borderRadius: T.radius.card,
		border: `1px solid ${T.color.border}`,
		background: T.color.surface,
		padding: 24,
	}
	const outline: CSSProperties = {
		minHeight: T.touch.minTarget,
		padding: '0 20px',
		borderRadius: 999,
		border: `1px solid ${T.color.border}`,
		color: T.color.fg,
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" style={{ background: T.color.bg, color: T.color.fg }}>
			<div style={card}>
				<h1 style={{ fontSize: T.font.title.size, fontWeight: T.font.title.weight }}>Enter passcode</h1>
				<p style={{ marginTop: 8, fontSize: T.font.body.size, color: T.color.fgMuted }}>This wallet is locked with your passcode.</p>

				{!forgot ? (
					<form
						style={{ marginTop: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}
						onSubmit={(e) => {
							e.preventDefault()
							void submit()
						}}
					>
						<PasscodeDotInput value={digits} onChange={setDigits} label="Passcode" autoFocus disabled={inputLocked} />
						<button
							type="submit"
							disabled={!canTry}
							style={{
								minHeight: T.touch.minTarget,
								padding: '0 24px',
								borderRadius: 999,
								background: T.color.accent,
								color: T.color.onAccent,
								fontSize: T.font.body.size,
								fontWeight: 600,
								opacity: canTry ? 1 : 0.4,
							}}
						>
							{busy ? 'Checking…' : waitLeft > 0 ? `Try again in ${formatCooldown(waitLeft)}` : 'Unlock'}
						</button>
					</form>
				) : (
					<div style={{ marginTop: 20, textAlign: 'left', fontSize: T.font.body.size, color: T.color.fgMuted, display: 'flex', flexDirection: 'column', gap: 16 }}>
						<p>
							A forgotten passcode cannot be recovered on this device. The only way back is to delete the local
							copy and re-import this wallet with your recovery phrase.
						</p>
						<label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
							<input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} style={{ marginTop: 4 }} />
							<span>I understand the local wallet data on this device will be deleted.</span>
						</label>
						<div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
							<button type="button" onClick={() => setForgot(false)} style={outline}>
								Back
							</button>
							<button
								type="button"
								disabled={!confirmReset || busy}
								onClick={() => void reset()}
								style={{ minHeight: T.touch.minTarget, padding: '0 20px', borderRadius: 999, background: T.color.danger, color: T.color.fg, fontWeight: 600, opacity: !confirmReset || busy ? 0.4 : 1 }}
							>
								Delete and re-import
							</button>
						</div>
					</div>
				)}

				{notice && !forgot && (
					<p role="alert" style={{ marginTop: 16, fontSize: T.font.body.size, color: T.color.warn }}>
						{notice}
					</p>
				)}

				{!forgot && (
					<button type="button" onClick={() => setForgot(true)} style={{ marginTop: 24, minHeight: T.touch.minTarget, fontSize: T.font.caption.size, color: T.color.fgMuted, textDecoration: 'underline' }}>
						Forgot passcode?
					</button>
				)}
			</div>
		</div>
	)
}
