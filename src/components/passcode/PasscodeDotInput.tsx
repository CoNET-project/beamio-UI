/**
 * Passcode entry for the web PWA: a hidden numeric input with a row of dots (dot size and gap from the tokens).
 * The digits stay in JS memory only; nothing is logged.
 */
import { secretFieldProps } from '../../utils/secretInputGuard'
import { useRef, type CSSProperties } from 'react'
import { PASSCODE_MAX_DIGITS } from '../../services/passcode/passcodeRules'
import { PASSCODE_TOKENS as T } from '../../services/passcode/passcodeTokens'

export default function PasscodeDotInput({
	value,
	onChange,
	label,
	disabled,
	autoFocus,
}: {
	value: string
	onChange: (next: string) => void
	label: string
	disabled?: boolean
	autoFocus?: boolean
}) {
	const ref = useRef<HTMLInputElement | null>(null)
	const dot = (filled: boolean): CSSProperties => ({
		width: T.dot.size,
		height: T.dot.size,
		borderRadius: T.dot.size / 2,
		border: `1px solid ${T.color.fg}`,
		background: filled ? T.color.fg : 'transparent',
	})
	return (
		<div style={{ position: 'relative' }}>
			<div
				aria-hidden="true"
				onClick={() => {
					if (!disabled) ref.current?.focus()
				}}
				style={{ display: 'flex', gap: T.dot.gap, justifyContent: 'center', alignItems: 'center', minHeight: T.touch.minTarget, cursor: disabled ? 'default' : 'text' }}
			>
				{Array.from({ length: PASSCODE_MAX_DIGITS }, (_, i) => (
					<span key={i} aria-hidden="true" style={dot(i < value.length)} />
				))}
			</div>
			<input
				{...secretFieldProps('pin')}
				ref={ref}
				type="password"
				inputMode="numeric"
				autoComplete="off"
				autoFocus={autoFocus}
				maxLength={PASSCODE_MAX_DIGITS}
				aria-label={label}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, PASSCODE_MAX_DIGITS))}
				style={{ position: 'absolute', opacity: 0, width: 1, height: 1, left: 0, top: 0, pointerEvents: 'none' }}
			/>
		</div>
	)
}
