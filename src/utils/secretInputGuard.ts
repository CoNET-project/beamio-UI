/**
 * Hardening for secret text fields: PIN, passcode, password and recovery code (2026-11-13; an iOS VoiceOver test on WKWebView
 * showed a pasted secret in the system accessibility log). The page cannot stop the OS from observing a field. The
 * mitigations here remove what the page can remove: autofill, spelling, autocorrect, capitalisation and password-manager
 * capture, copy and cut out of the field, and, for numeric PIN and passcode fields, paste (the digits are typed). A recovery
 * code or a password may still be pasted in a browser; a shell does not show those fields at all.
 */
export type SecretFieldKind = 'pin' | 'secret'

type ClipboardLike = { preventDefault: () => void }

export type SecretFieldProps = {
	autoComplete?: string
	autoCorrect?: string
	autoCapitalize?: string
	spellCheck?: boolean
	'data-form-type'?: string
	'data-lpignore'?: string
	'data-1p-ignore'?: string
	onCopy?: (e: ClipboardLike) => void
	onCut?: (e: ClipboardLike) => void
	onDrop?: (e: ClipboardLike) => void
	onPaste?: (e: ClipboardLike) => void
}

const blockEvent = (e: ClipboardLike): void => {
	e.preventDefault()
}

/** Props for a secret field. Spread them first so an explicit attribute can still be set after them. */
export function secretFieldProps(kind: SecretFieldKind): SecretFieldProps {
	const base: SecretFieldProps = {
		autoComplete: 'off',
		autoCorrect: 'off',
		autoCapitalize: 'none',
		spellCheck: false,
		'data-form-type': 'other',
		'data-lpignore': 'true',
		'data-1p-ignore': 'true',
		onCopy: blockEvent,
		onCut: blockEvent,
		onDrop: blockEvent,
	}
	return kind === 'pin' ? { ...base, onPaste: blockEvent } : base
}
