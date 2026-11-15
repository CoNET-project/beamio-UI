/**
 * Account name rules for the home capsule and the save path (investigation 2026-11-11).
 *
 * The capsule label used to read only the React `beamio` state, which Home sets after a server call. Until that call resolved,
 * the label fell back to the product default "Beamio" even when the wallet held the real name. That was display only: the stored
 * and in-memory names were never changed. These helpers keep the display on the real name and keep an existing name when an
 * update arrives without one (for example after a failed server call). Pure functions; nothing is written here.
 */

/** Display name: the first non-empty candidate (state, then the stored wallet name), without leading "@". Default "Beamio". */
export function homeAccountName(...candidates: Array<string | null | undefined>): string {
	for (const c of candidates) {
		const n = (c ?? '').trim().replace(/^@+/, '')
		if (n) return n
	}
	return 'Beamio'
}

/** Name to store: the incoming name when it is non-empty, otherwise the existing one. Never turns a real name into nothing. */
export function keepExistingAccountName(existing: string | null | undefined, next: string | null | undefined): string | undefined {
	const n = (next ?? '').trim()
	if (n) return next as string
	const e = (existing ?? '').trim()
	return e || undefined
}
