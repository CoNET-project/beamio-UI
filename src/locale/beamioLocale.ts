import { useCallback, useEffect, useState } from 'react'
import i18n, { t, type BeamioUiLocale, getCurrentBeamioUiLocale } from './i18n'

export { t, type BeamioUiLocale, getCurrentBeamioUiLocale }

/**
 * The key a copy lookup uses (review H1). The `ui.`form is tried first (`i18n.exists('ui.'+ key)`); if it does not exist,
 * the key is used as written. That covers the top-level sections of the locale files (recovery.* import.* errors.* time.*). A key that
 * is not found in either place keeps the `ui.` form, as before.
 */
export function copyKey(key: string): string {
	if (key.startsWith('ui.')) return key
	if (i18n.exists(`ui.${key}`)) return `ui.${key}`
	if (i18n.exists(key)) return key
	return `ui.${key}`
}

/** Shorthand for UI copy: `ui.redeem_code` or full key `ui:redeem_code` */
export function tu(key: string, options?: Record<string, unknown>): string {
	return t(copyKey(key), options)
}

/**
 * Live UI strings — re-render when i18n language changes.
 * Static `tu()` alone only updates after navigation / parent re-render.
 */
export function useTu() {
	const [localeVersion, setLocaleVersion] = useState(0)

	useEffect(() => {
		const bump = () => setLocaleVersion((v) => v + 1)
		const inst = i18n as unknown as {
			on?: (event: string, cb: () => void) => void
			off?: (event: string, cb: () => void) => void
		}
		inst.on?.('languageChanged', bump)
		return () => {
			inst.off?.('languageChanged', bump)
		}
	}, [])

	const translate = useCallback(
		(key: string, options?: Record<string, unknown>) => {
			const fullKey = copyKey(key)
			return t(fullKey, options)
		},
		[localeVersion],
	)
	return { tu: translate, i18n }
}
