/**
 * Self-drawn numeric keypad for the passcode (no `<input>`: the digits never reach a text field, a paste or the autofill path).
 * The caller owns the value and the labels. 「设定」 is enabled only when the value passes the passcode policy.
 */
import { checkPasscodePolicy, PASSCODE_MAX_DIGITS } from '../../services/passcode/passcodeRules'
import { applyPasscodeKey, type PasscodeKey } from './passcodeKeypadReducer'
import { PASSCODE_TOKENS as T } from '../../services/passcode/passcodeTokens'

const ROWS: PasscodeKey[][] = [
	['1', '2', '3'],
	['4', '5', '6'],
	['7', '8', '9'],
]

export default function PasscodeKeypad({
	value,
	onChange,
	onConfirm,
	onSkip,
	confirmLabel,
	skipLabel,
	deleteLabel,
	disabled,
}: {
	value: string
	onChange: (next: string) => void
	onConfirm?: (passcode: string) => void
	onSkip?: () => void
	confirmLabel: string
	skipLabel?: string
	deleteLabel: string
	disabled?: boolean
}) {
	const press = (key: PasscodeKey) => {
		if (disabled) return
		onChange(applyPasscodeKey(value, key))
	}
	const canConfirm = !disabled && checkPasscodePolicy(value).ok === true
	const keyStyle = {
		minHeight: T.touch.minTarget,
		fontSize: 22,
		borderRadius: 14,
		border: `1px solid ${T.color.fg}`,
		background: 'transparent',
		color: T.color.fg,
	}
	const cell = (key: PasscodeKey, label: string) => (
		<button key={key} type="button" aria-label={key === 'delete' ? deleteLabel : label} disabled={disabled} onClick={() => press(key)} style={keyStyle}>
			{key === 'delete' ? '⌫' : label}
		</button>
	)
	return (
		<div data-testid="passcode-keypad" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320, margin: '0 auto' }}>
			<div aria-live="polite" aria-label={`${value.length}/${PASSCODE_MAX_DIGITS}`} style={{ textAlign: 'center', color: T.color.fg, letterSpacing: 4, minHeight: 24 }}>
				{'•'.repeat(value.length)}
			</div>
			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
				{ROWS.flat().map((k) => cell(k, k))}
				{cell('delete', '⌫')}
				{cell('0', '0')}
				<span aria-hidden="true" />
			</div>
			<div style={{ display: 'flex', gap: 10 }}>
				{onSkip && skipLabel ? (
					<button type="button" disabled={disabled} onClick={onSkip} style={{ ...keyStyle, flex: 1, fontSize: 16 }}>
						{skipLabel}
					</button>
				) : null}
				{onConfirm ? (
					<button type="button" disabled={!canConfirm} onClick={() => onConfirm(value)} style={{ ...keyStyle, flex: 1, fontSize: 16, opacity: canConfirm ? 1 : 0.5 }}>
						{confirmLabel}
					</button>
				) : null}
			</div>
		</div>
	)
}
