/**
 * Account name rules for the home capsule and the save path (investigation 2026-11-11).
 *
 * The capsule label used to read only the React `beamio` state, which Home sets after a server call. Until that call resolved,
 * the label fell back to the product default "Beamio" even when the wallet held the real name. That was display only: the stored
 * and in-memory names were never changed. These helpers keep the display on the real name and keep an existing name when an
 * update arrives without one (for example after a failed server call). Pure functions; nothing is written here.
 */

/**
 * Display name: the first non-empty candidate (state, then the stored wallet name, then the BeamioTag cached on this device),
 * without a leading "@". Returns "" when none is known. It never returns a fixed product name: a fixed name reads as another
 * account (S25 QA, 2026-11-15).
 */
export function homeAccountName(...candidates: Array<string | null | undefined>): string {
	for (const c of candidates) {
		const n = (c ?? '').trim().replace(/^@+/, '')
		if (n) return n
	}
	return ''
}

/** localStorage key of the device's BeamioTag cache. The value is JSON {eoa, name}; the name is bound to its EOA. */
export const DEVICE_BEAMIO_TAG_KEY = 'beamio.shellAccountName'

const isEoa = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v)

/**
 * Caches the BeamioTag for one EOA on this device. Nothing is written without a valid EOA: a name is only ever bound to the
 * account it was created or restored for. Any earlier entry is replaced.
 */
export function rememberDeviceBeamioTag(name: string | null | undefined, eoa: string | null | undefined): void {
	const n = (name ?? '').trim().replace(/^@+/, '')
	const e = (eoa ?? '').trim()
	if (!n || !isEoa(e)) return
	try {
		window.localStorage.setItem(DEVICE_BEAMIO_TAG_KEY, JSON.stringify({ eoa: e.toLowerCase(), name: n }))
	} catch {
		// storage disabled: nothing is cached
	}
}

/**
 * The cached BeamioTag, only when the cached EOA equals `eoa` (compared in lower case). "" for another account, an entry
 * without an EOA (the earlier format), or no entry. A cached name is never shown for a different account.
 */
export function deviceCachedBeamioTagFor(eoa: string | null | undefined): string {
	const e = (eoa ?? '').trim().toLowerCase()
	if (!isEoa(e)) return ''
	try {
		const raw = window.localStorage.getItem(DEVICE_BEAMIO_TAG_KEY)
		if (!raw) return ''
		const parsed = JSON.parse(raw) as { eoa?: unknown; name?: unknown }
		if (typeof parsed?.eoa !== 'string' || typeof parsed?.name !== 'string') return ''
		if (parsed.eoa.toLowerCase() !== e) return ''
		return parsed.name.trim().replace(/^@+/, '')
	} catch {
		return ''
	}
}

/** A short form of a public wallet address for a neutral placeholder: 0x1234…abcd. "" for anything that is not an address. */
export function shortAddressLabel(address: string | null | undefined): string {
	const a = (address ?? '').trim()
	if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return ''
	return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/**
 * The capsule label: "@name" when a name is known; otherwise the short address; otherwise "" (nothing is shown).
 */
export function homeDisplayLabel(name: string, address: string | null | undefined): string {
	if (name) return `@${name}`
	return shortAddressLabel(address)
}

/** Name to store: the incoming name when it is non-empty, otherwise the existing one. Never turns a real name into nothing. */
export function keepExistingAccountName(existing: string | null | undefined, next: string | null | undefined): string | undefined {
	const n = (next ?? '').trim()
	if (n) return next as string
	const e = (existing ?? '').trim()
	return e || undefined
}
