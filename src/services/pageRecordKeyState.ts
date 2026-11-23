/**
 * The key-only test of the page record (the decision; 2026-11-22: key_only needs BOTH no mnemonic here AND a private key in the
 * record). Pure: no read, no write. Anything that is not clearly a plain record with a private key is `unknown` (shown as a neutral line,
 * no entry): an address-only record, a wrapped or passcode record, a record that cannot be parsed, and an absent record.
 * The private-key field is the one recordCarriesAccountKey reads (profiles[0].privateKeyArmor, non-empty).
 */
import { hasPlainSecrets } from './passcode/walletVault'
import { isLegacyWrapRecord, isWrapRecord } from './passcode/walletWrap'

type Loose = Record<string, unknown>

export type PageKeyState = 'key_only' | 'unknown'

export function classifyPageKeyState(parsed: Loose | null | undefined): PageKeyState {
	if (!parsed || typeof parsed !== 'object') return 'unknown'
	// a wrapped (passcode) record is not read here: unknown until it is unlocked
	if (!hasPlainSecrets(parsed)) return 'unknown'
	// a removed format (v=1, PBKDF2, device mode) at the top, or any wrapped or removed-format record in a slot: unknown, never key_only ()
	if (isLegacyWrapRecord(parsed)) return 'unknown'
	// any wrapped or removed-format record anywhere in the record (top level, or inside profiles and their fields): unknown
	if (holdsWrapOrLegacy(parsed, 0)) return 'unknown'
	// a mnemonic field that is set but is not a plain string (a future format, or an object) is not read here: unknown, never key_only
	const rawPhrase = parsed.mnemonicPhrase
	if (rawPhrase !== undefined && rawPhrase !== null && rawPhrase !== '' && typeof rawPhrase !== 'string') return 'unknown'
	const phrase = typeof rawPhrase === 'string' ? rawPhrase.trim() : ''
	if (phrase !== '') return 'unknown'
	const profiles = parsed.profiles
	if (!Array.isArray(profiles) || profiles.length === 0) return 'unknown'
	const key = (profiles[0] as { privateKeyArmor?: unknown } | null | undefined)?.privateKeyArmor
	return typeof key === 'string' && key.trim() !== '' ? 'key_only' : 'unknown'
}

/** Walks the record (bounded depth) and reports a wrap or a removed-format record at any level (: profiles[0].wrap). */
function holdsWrapOrLegacy(value: unknown, depth: number): boolean {
	if (depth > 6 || value === null || typeof value !== 'object') return false
	if (isWrapRecord(value) || isLegacyWrapRecord(value)) return true
	const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
	return children.some((c) => holdsWrapOrLegacy(c, depth + 1))
}
