/**
 * 0.53.51: the one-time notices of the resume-create route (design r3 R3 and r4 N1). One notice at a time, shown on the home as a
 * dismissible card (never a dialog):
 *  - `code_not_shown`: the registry already holds the account, the pending record was cleared and no recover code can be shown.
 *    Neutral wording: "If you have not saved your recovery code yet, please remember your BeamioTag and password."
 *  - `already_registered_keep_password`: the completion page ended on "already registered": the password just typed did not take effect.
 * "Once": a non-secret flag per wallet and kind (`beamio.codeNoticeShown.v1`: { [eoa]: { d3?: true, n1?: true } }, booleans only) is written when
 * the notice is shown, and the same notice is not shown again for that wallet.
 */
export type ResumeNoticeKind = 'code_not_shown' | 'already_registered_keep_password'
const KEY = 'beamio.codeNoticeShown.v1'
const FLAG: Record<ResumeNoticeKind, 'd3' | 'n1'> = { code_not_shown: 'd3', already_registered_keep_password: 'n1' }

type Shown = Record<string, { d3?: true; n1?: true }>

function readShown(): Shown {
	try {
		const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY)
		const parsed: unknown = raw ? JSON.parse(raw) : {}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const out: Shown = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (!/^0x[0-9a-f]{40}$/.test(k) || !v || typeof v !== 'object') continue
			const o = v as Record<string, unknown>
			out[k] = { ...(o.d3 === true ? { d3: true as const } : {}), ...(o.n1 === true ? { n1: true as const } : {}) }
		}
		return out
	} catch {
		return {}
	}
}

function writeShown(map: Shown): void {
	try {
		window.localStorage.setItem(KEY, JSON.stringify(map))
	} catch {
		/* storage unavailable: the notice may show again after a restart */
	}
}

let current: { kind: ResumeNoticeKind; eoa: string } | null = null
const listeners = new Set<() => void>()
const emit = () => {
	for (const l of [...listeners]) l()
}

/** Shows the notice unless it was shown for this wallet before. Returns true when it is now showing. Replaces another notice (one at a time). */
export function pushResumeNotice(kind: ResumeNoticeKind, eoaRaw: string): boolean {
	const eoa = eoaRaw.trim().toLowerCase()
	if (!/^0x[0-9a-f]{40}$/.test(eoa)) return false
	const shown = readShown()
	if (shown[eoa]?.[FLAG[kind]]) return false
	shown[eoa] = { ...shown[eoa], [FLAG[kind]]: true }
	writeShown(shown)
	current = { kind, eoa }
	emit()
	return true
}

export const getResumeNotice = (): { kind: ResumeNoticeKind; eoa: string } | null => current
export function dismissResumeNotice(): void {
	current = null
	emit()
}
export function subscribeResumeNotice(l: () => void): () => void {
	listeners.add(l)
	return () => {
		listeners.delete(l)
	}
}
export function resetResumeNoticeForTest(): void {
	current = null
	listeners.clear()
}
