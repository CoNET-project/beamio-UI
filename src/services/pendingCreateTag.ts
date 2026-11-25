/**
 * 0.53.51 (spec r3sk/r3sl and the resume-create design r4): the pending record of an onboarding create that passed step 1
 * (nativeAccountCreateOpen), kept per wallet (EOA) in page storage.
 *
 *  - `t`: the BeamioTag. From step 1 on the create page locks it: step 2 (accountCreateRegister) uses it, and after an interruption the
 *    completion offers it prefilled and locked.
 *  - `s` (optional): the wall-clock time (ms) of the moment before the first send of step 3 (addUser). Without it step 3 was never sent.
 *  - `a` (optional): the wall-clock time (ms) at which the server answered 2xx to step 3.
 *
 * The record holds only these non-secret values: no password, no recover code, no payload, no hash. A value that is a plain string is the
 * older format (tag only): it reads as a tag with `s` unknown (`legacy: true`).
 * It is cleared when step 4 succeeded and the user confirmed the code is saved (or the registration was already complete). No record
 * (another browser, cleared storage): the user types the tag again.
 */
const KEY = 'beamio.pendingCreateTag.v2'
const MAX_ENTRIES = 8

export type PendingCreateRecord = { tag: string; s?: number; a?: number; legacy: boolean }

const cleanTag = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/^@+/, '') : '')
const cleanEoa = (v: unknown): string => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? v.trim().toLowerCase() : '')
const cleanTime = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : undefined)

type Stored = { t: string; s?: number; a?: number }

function readMap(): Record<string, PendingCreateRecord> {
	try {
		const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY)
		const parsed: unknown = raw ? JSON.parse(raw) : {}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const out: Record<string, PendingCreateRecord> = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = cleanEoa(k)
			if (!e) continue
			if (typeof v === 'string') {
				const tag = cleanTag(v)
				if (tag) out[e] = { tag, legacy: true }
			} else if (v && typeof v === 'object' && !Array.isArray(v)) {
				const o = v as Record<string, unknown>
				const tag = cleanTag(o.t)
				if (!tag) continue
				const rec: PendingCreateRecord = { tag, legacy: false }
				const s = cleanTime(o.s)
				const a = cleanTime(o.a)
				if (s !== undefined) rec.s = s
				if (a !== undefined) rec.a = a
				out[e] = rec
			}
		}
		return out
	} catch {
		return {}
	}
}

function writeMap(map: Record<string, PendingCreateRecord>): void {
	try {
		const keys = Object.keys(map)
		if (keys.length === 0) {
			window.localStorage.removeItem(KEY)
			return
		}
		const stored: Record<string, Stored> = {}
		for (const k of keys) {
			const r = map[k]
			const o: Stored = { t: r.tag }
			if (r.s !== undefined) o.s = r.s
			if (r.a !== undefined) o.a = r.a
			stored[k] = o
		}
		window.localStorage.setItem(KEY, JSON.stringify(stored))
	} catch {
		/* storage unavailable: the lock then holds for this page session only */
	}
}

/** The whole record for this wallet, or null when there is none (a synchronous local read). */
export function readPendingCreateRecord(eoa: string): PendingCreateRecord | null {
	const e = cleanEoa(eoa)
	return e ? readMap()[e] ?? null : null
}

/** The tag recorded for this wallet, or '' when there is none. */
export function readPendingCreateTag(eoa: string): string {
	return readPendingCreateRecord(eoa)?.tag ?? ''
}

/** Records the tag for this wallet. The same tag keeps its `s` and `a` (a retry of step 1 must not lose them); another tag starts clean. */
export function writePendingCreateTag(eoa: string, tag: string): void {
	const e = cleanEoa(eoa)
	const t = cleanTag(tag)
	if (!e || !t) return
	const map = readMap()
	const old = map[e]
	delete map[e]
	map[e] = old && old.tag === t ? { ...old, legacy: false } : { tag: t, legacy: false }
	const keys = Object.keys(map)
	for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[k]
	writeMap(map)
}

/** Step 3 is about to be sent (the first send of this cycle): `s` is set to `atMs` and an older `a` is dropped (a new send cycle). */
export function markPendingForwardSent(eoa: string, atMs: number): void {
	const e = cleanEoa(eoa)
	const s = cleanTime(atMs)
	if (!e || s === undefined) return
	const map = readMap()
	const old = map[e]
	if (!old) return
	map[e] = { tag: old.tag, s, legacy: false }
	writeMap(map)
}

/** The server answered 2xx to step 3 at `atMs`. */
export function markPendingForwardAccepted(eoa: string, atMs: number): void {
	const e = cleanEoa(eoa)
	const a = cleanTime(atMs)
	if (!e || a === undefined) return
	const map = readMap()
	const old = map[e]
	if (!old) return
	map[e] = { ...old, a, legacy: false }
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
