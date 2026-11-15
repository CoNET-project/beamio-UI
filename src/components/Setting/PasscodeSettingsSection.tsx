/**
 * Numeric passcode settings. Web PWA only: the app shell keeps the
 * system keystore and collects the passcode in its native overlay.
 * Driven by the flow table (passcodeFlow.ts): enable, change and disable runs. Visual values come from the tokens; the
 * section is a token card so the colours and sizes match the lock screen.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { disableWalletVaultPasscode, setWalletVaultPasscode, unlockWalletVaultWithPasscode } from '../../services/beamio'
import { signOutLocalWallet } from '../../services/signOutLocal'
import { tu } from '../../locale/beamioLocale'
import { checkPasscodePolicy, PASSCODE_MAX_DIGITS, PASSCODE_MIN_DIGITS } from '../../services/passcode/passcodeRules'
import { PASSCODE_TOKENS as T } from '../../services/passcode/passcodeTokens'
import { applyFlowEvent, startFlow, type FlowMode, type FlowSnapshot } from '../../services/passcode/passcodeFlow'
import {
	CONFIRM_FORGET_TEXT,
	CONFIRM_OFF_TEXT,
	DONE_TEXT,
	ERROR_TEXT,
	MISMATCH_TEXT,
	POLICY_TEXT,
	WRONG_TEXT,
	backoffText,
	formatCooldown,
} from '../../services/passcode/passcodeMessages'
import { isCashTreesNativeWebView } from '../../utils/cashTreesNativeNfc'
import PasscodeDotInput from '../passcode/PasscodeDotInput'
import { usePasscodeEnabled } from '../passcode/usePasscodeEnabled'

type Notice = { ok: boolean; text: string } | null

const TITLE: Record<FlowMode, string> = {
	enable: 'Turn on passcode',
	change: 'Change passcode',
	disable: 'Turn off passcode',
	unlock: 'Unlock',
}

const button = (primary: boolean): CSSProperties => ({
	minHeight: T.touch.minTarget,
	padding: '0 18px',
	borderRadius: 999,
	fontSize: T.font.body.size,
	fontWeight: 600,
	background: primary ? T.color.accent : 'transparent',
	color: primary ? T.color.onAccent : T.color.fg,
	border: primary ? 'none' : `1px solid ${T.color.border}`,
})

export default function PasscodeSettingsSection() {
	const nativeShell = isCashTreesNativeWebView()
	/** Null until the first read. The "Lock" entry renders only when this is true (never hidden or greyed out). */
	const hasPasscode = usePasscodeEnabled(!nativeShell)
	const [snap, setSnap] = useState<FlowSnapshot | null>(null)
	const [oldCode, setOldCode] = useState('')
	const [newCode, setNewCode] = useState('')
	const [confirmCode, setConfirmCode] = useState('')
	const [ack, setAck] = useState(false)
	const [busy, setBusy] = useState(false)
	const [notice, setNotice] = useState<Notice>(null)
	const [waitUntil, setWaitUntil] = useState(0)
	const [now, setNow] = useState(Date.now())

	useEffect(() => {
		if (waitUntil <= Date.now()) return
		const id = window.setInterval(() => setNow(Date.now()), 500)
		return () => window.clearInterval(id)
	}, [waitUntil])

	if (nativeShell) {
		return (
			<p style={{ fontSize: T.font.caption.size, color: '#64748b' }}>
				In the app, the wallet key is held by the system keystore. The numeric passcode is managed in the app.
			</p>
		)
	}

	// Read the clock at render time; the interval only forces the re-render.
	const waitLeft = Math.max(0, waitUntil - Math.max(now, Date.now()))
	const clearInputs = () => {
		setOldCode('')
		setNewCode('')
		setConfirmCode('')
		setAck(false)
	}
	const begin = (mode: FlowMode) => {
		if (waitLeft > 0) return
		clearInputs()
		setNotice(null)
		setSnap(startFlow(mode))
	}
	const cancel = () => {
		if (snap) applyFlowEvent(snap, 'cancel')
		clearInputs()
		setNotice(null)
		setSnap(null)
	}
	const close = () => {
		clearInputs()
		setSnap(null)
	}

	/** A failed verify: a wrong passcode stays in the run; a cooldown ends it (table rows submit_wrong / cooldown). */
	const failVerify = (current: FlowSnapshot, reason: string, retryAfterMs?: number) => {
		if (reason === 'wrong_passcode' || reason === 'backoff') {
			const wait = retryAfterMs ?? 0
			if (wait > 0) {
				setWaitUntil(Date.now() + wait)
				setNotice({ ok: false, text: backoffText(wait) })
				setSnap(applyFlowEvent(current, 'cooldown'))
			} else {
				setNotice({ ok: false, text: WRONG_TEXT })
				setSnap(applyFlowEvent(current, 'submit_wrong'))
			}
			setOldCode('')
			return
		}
		setNotice({ ok: false, text: ERROR_TEXT })
		setSnap(applyFlowEvent(current, 'internal_error'))
	}

	const finishOk = (current: FlowSnapshot) => {
		setSnap(applyFlowEvent(current, 'submit_match'))
		setNotice({ ok: true, text: DONE_TEXT[current.mode] })
		clearInputs()
	}

	const submit = async () => {
		if (!snap || snap.done || busy || waitLeft > 0) return
		const current = snap
		switch (current.state) {
			case 'verify_old':
			case 'verify': {
				if (!/^[0-9]{8,12}$/.test(oldCode)) {
					setNotice({ ok: false, text: `Enter ${PASSCODE_MIN_DIGITS} to ${PASSCODE_MAX_DIGITS} digits.` })
					return
				}
				setBusy(true)
				try {
					if (current.mode === 'change') {
						const r = await unlockWalletVaultWithPasscode(oldCode)
						if (r.ok) {
							setOldCode('')
							setNotice(null)
							setSnap(applyFlowEvent(current, 'submit_match'))
						} else {
							failVerify(current, r.reason, r.retryAfterMs)
						}
					} else {
						const r = await disableWalletVaultPasscode(oldCode)
						if (r.ok) {
							finishOk(current)
						} else {
							failVerify(current, r.reason, r.retryAfterMs)
						}
					}
				} catch {
					failVerify(current, 'error')
				} finally {
					setBusy(false)
				}
				return
			}
			case 'setup_new': {
				const check = checkPasscodePolicy(newCode)
				if (!check.ok) {
					setNotice({ ok: false, text: POLICY_TEXT[check.reason] })
					setNewCode('')
					setSnap(applyFlowEvent(current, 'submit_invalid'))
					return
				}
				if (current.mode === 'enable' && !ack) {
					setNotice({ ok: false, text: CONFIRM_FORGET_TEXT })
					return
				}
				setNotice(null)
				setSnap(applyFlowEvent(current, 'submit_valid'))
				return
			}
			case 'setup_confirm': {
				if (confirmCode !== newCode) {
					setNotice({ ok: false, text: MISMATCH_TEXT })
					setNewCode('')
					setConfirmCode('')
					setSnap(applyFlowEvent(current, 'submit_mismatch'))
					return
				}
				setBusy(true)
				try {
					const r = await setWalletVaultPasscode(newCode)
					if (r.ok) {
						finishOk(current)
					} else {
						setNotice({ ok: false, text: ERROR_TEXT })
						setSnap(applyFlowEvent(current, 'internal_error'))
					}
				} catch {
					setNotice({ ok: false, text: ERROR_TEXT })
					setSnap(applyFlowEvent(current, 'internal_error'))
				} finally {
					setBusy(false)
				}
				return
			}
			default:
				return
		}
	}

	const submitLabel = snap ? (snap.state === 'setup_confirm' ? 'Confirm' : snap.state === 'setup_new' ? 'Next' : 'Continue') : ''
	const inputFor = (): { label: string; value: string; set: (v: string) => void } | null => {
		if (!snap) return null
		if (snap.state === 'verify_old' || snap.state === 'verify') return { label: 'Current passcode', value: oldCode, set: setOldCode }
		if (snap.state === 'setup_new') return { label: `New passcode (${PASSCODE_MIN_DIGITS} to ${PASSCODE_MAX_DIGITS} digits)`, value: newCode, set: setNewCode }
		if (snap.state === 'setup_confirm') return { label: 'Confirm passcode', value: confirmCode, set: setConfirmCode }
		return null
	}
	const input = inputFor()

	return (
		<div
			style={{
				borderRadius: T.radius.card,
				border: `1px solid ${T.color.border}`,
				background: T.color.bg,
				color: T.color.fg,
				padding: 16,
				display: 'flex',
				flexDirection: 'column',
				gap: 12,
			}}
		>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
				<span style={{ fontSize: T.font.body.size, fontWeight: 600 }}>Numeric passcode</span>
				<span style={{ fontSize: T.font.caption.size, color: T.color.fgMuted, textTransform: 'uppercase', letterSpacing: '0.16em' }}>
					{hasPasscode === null ? '…' : hasPasscode ? 'On' : 'Off'}
				</span>
			</div>

			{!snap && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
					{hasPasscode === false && (
						<button type="button" style={button(true)} disabled={waitLeft > 0} onClick={() => begin('enable')}>
							Turn on passcode
						</button>
					)}
					{hasPasscode === true && (
						<>
							<button type="button" style={button(true)} disabled={waitLeft > 0} onClick={() => begin('change')}>
								Change passcode
							</button>
							<button type="button" style={button(false)} disabled={waitLeft > 0} onClick={() => begin('disable')}>
								Turn off
							</button>
						</>
					)}
				</div>
			)}

			{snap && !snap.done && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
					<span style={{ fontSize: T.font.body.size, color: T.color.fgMuted }}>{TITLE[snap.mode]}</span>
					{input && <PasscodeDotInput value={input.value} onChange={input.set} label={input.label} disabled={busy} autoFocus />}
					{snap.mode === 'enable' && snap.state === 'setup_new' && (
						<label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: T.font.caption.size, color: T.color.fgMuted }}>
							<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
							<span>{CONFIRM_FORGET_TEXT}</span>
						</label>
					)}
					{snap.mode === 'disable' && snap.state === 'verify' && (
						<label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: T.font.caption.size, color: T.color.fgMuted }}>
							<input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
							<span>{CONFIRM_OFF_TEXT}</span>
						</label>
					)}
					<div style={{ display: 'flex', gap: 8 }}>
						<button type="button" style={button(true)} disabled={busy || waitLeft > 0} onClick={() => void submit()}>
							{busy ? 'Saving…' : waitLeft > 0 ? `Try again in ${formatCooldown(waitLeft)}` : submitLabel}
						</button>
						<button type="button" style={button(false)} disabled={busy} onClick={cancel}>
							Cancel
						</button>
					</div>
				</div>
			)}

			{snap && snap.done && (
				<div style={{ display: 'flex', gap: 8 }}>
					<button type="button" style={button(true)} onClick={close}>
						Close
					</button>
				</div>
			)}

			{notice && (
				<p role={notice.ok ? 'status' : 'alert'} style={{ fontSize: T.font.caption.size, color: notice.ok ? T.color.fg : T.color.warn }}>
					{notice.text}
				</p>
			)}

			{hasPasscode === true && (
				<div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: `1px solid ${T.color.border}`, paddingTop: 12 }}>
					<button type="button" style={button(false)} onClick={() => void signOutLocalWallet()}>
						{tu('passcode_lock_action')}
					</button>
				</div>
			)}
		</div>
	)
}
