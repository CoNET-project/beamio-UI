/**
 * 0.53.50 (spec r3sk/r3sl, R-1 mitigation a): the BeamioTag of an onboarding create that passed step 1 (nativeAccountCreateOpen), recorded per
 * wallet (EOA) in page storage. From then on the create page locks that tag: step 2 (accountCreateRegister) uses it, and after an interruption
 * (a killed app) the completion offers the recorded tag prefilled and locked. The record is cleared when step 4 succeeded and the user confirmed
 * the recover code is saved (or the registration was already complete). No record (another browser, cleared storage): the user types the tag
 * again. The tag and the EOA are public identifiers; nothing else is stored here: no password, no recover code.
 */
const KEY = 'beamio.pendingCreateTag.v2'
const MAX_ENTRIES = 8

const cleanTag = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/^@+/, '') : '')
const cleanEoa = (v: unknown): string => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? v.trim().toLowerCase() : '')

function readMap(): Record<string, string> {
	try {
		const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY)
		const parsed: unknown = raw ? JSON.parse(raw) : {}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const out: Record<string, string> = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = cleanEoa(k)
			const t = cleanTag(v)
			if (e && t) out[e] = t
		}
		return out
	} catch {
		return {}
	}
}

function writeMap(map: Record<string, string>): void {
	try {
		const keys = Object.keys(map)
		if (keys.length === 0) window.localStorage.removeItem(KEY)
		else window.localStorage.setItem(KEY, JSON.stringify(map))
	} catch {
		/* storage unavailable: the lock then holds for this page session only */
	}
}

/** The tag recorded for this wallet, or '' when there is none. */
export function readPendingCreateTag(eoa: string): string {
	const e = cleanEoa(eoa)
	return e ? readMap()[e] ?? '' : ''
}

export function writePendingCreateTag(eoa: string, tag: string): void {
	const e = cleanEoa(eoa)
	const t = cleanTag(tag)
	if (!e || !t) return
	const map = readMap()
	delete map[e]
	map[e] = t
	const keys = Object.keys(map)
	for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[k]
	writeMap(map)
}

export function clearPendingCreateTag(eoa: string): void {
	const e = cleanEoa(eoa)
	if (!e) return
	const map = readMap()
	if (!(e in map)) return
	delete map[e]
	writeMap(map)
}
