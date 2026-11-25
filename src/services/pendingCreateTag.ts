/**
 * 0.53.50 (spec r3sk, R-1 mitigation a): the BeamioTag of an onboarding create that passed step 1 (nativeAccountCreateOpen). From then on the
 * create page locks that tag: step 2 (accountCreateRegister) uses it, and after an interruption the page offers the completion with this
 * tag prefilled and locked. The tag is a public identifier (never a secret); nothing else is stored here: no password, no recover code.
 */
const KEY = 'beamio.pendingCreateTag.v1'

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/^@+/, '') : '')

export function readPendingCreateTag(): string {
	try {
		return clean(typeof window === 'undefined' ? '' : window.localStorage.getItem(KEY))
	} catch {
		return ''
	}
}

export function writePendingCreateTag(tag: string): void {
	const t = clean(tag)
	if (!t) return
	try {
		window.localStorage.setItem(KEY, t)
	} catch {
		/* storage unavailable: the lock then holds for this page session only */
	}
}

export function clearPendingCreateTag(): void {
	try {
		window.localStorage.removeItem(KEY)
	} catch {
		/* nothing to clear */
	}
}
