/**
 * 0.53.51: the one-time notices of the resume-create route (design r3 R3 and r4 N1). One notice at a time, shown on the home as a
 * dismissible card (never a dialog):
 *  - `code_not_shown`: the registry already holds the account, the pending record was cleared and no recover code can be shown.
 *    Neutral wording: "If you have not saved your recovery code yet, please remember your BeamioTag and password."
 *  - `already_registered_keep_password`: the completion page ended on "already registered": the password just typed did not take effect.
 * "Once": a non-secret flag per wallet and kind, each kind in its own key (D3 `beamio.codeNoticeShown.v1`, N1 `beamio.passwordNoticeShown.v1`, both { [eoa]: true } only) is written when
 * the notice is shown, and the same notice is not shown again for that wallet.
 */
export type ResumeNoticeKind = 'code_not_shown' | 'already_registered_keep_password'
const KEY = 'beamio.codeNoticeShown.v1'

/** Two independent one-time stores, each only wallet -> true (no tag, no secret): D3 in `beamio.codeNoticeShown.v1`, N1 in its own key. */
const KEYS: Record<ResumeNoticeKind, string> = { code_not_shown: KEY, already_registered_keep_password: 'beamio.passwordNoticeShown.v1' }

function readShown(kind: ResumeNoticeKind): Record<string, true> {
	try {
		const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEYS[kind])
		const parsed: unknown = raw ? JSON.parse(raw) : {}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const out: Record<string, true> = {}
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (/^0x[0-9a-f]{40}$/.test(k) && v === true) out[k] = true
		}
		return out
	} catch {
		return {}
	}
}

function writeShown(kind: ResumeNoticeKind, map: Record<string, true>): void {
	try {
		window.localStorage.setItem(KEYS[kind], JSON.stringify(map))
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
	const shown = readShown(kind)
	if (shown[eoa]) return false
	shown[eoa] = true
	writeShown(kind, shown)
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
