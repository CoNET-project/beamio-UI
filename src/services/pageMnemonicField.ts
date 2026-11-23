/**
 * Every read of a page record's `mnemonicPhrase` goes through this classification (2026-11-22, item 2).
 * - absent: the field is missing, null or an empty string (only this is "no mnemonic");
 * - phrase: a string, trimmed; the only shape that is a plaintext phrase;
 * - envelope: the v3 mnemonic envelope object f3 stores in this field (walletVault); it is never a phrase and is never sent as one;
 * - other: any other shape. It is never absent: a caller treats it as unknown or verify_failed, and never onboards on it.
 */
export type PageMnemonicField =
	| { kind: 'absent' }
	| { kind: 'phrase'; phrase: string }
	| { kind: 'envelope'; envelope: Record<string, unknown> & { eoa: string } }
	| { kind: 'other' }

const EOA_RE = /^0x[0-9a-fA-F]{40}$/

/** Structural check of the v3 envelope (f1 mnemonic-cipher-format v3). Nothing is decrypted. */
export function isMnemonicCipherEnvelope(x: unknown): x is Record<string, unknown> & { eoa: string } {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return false
	const e = x as Record<string, unknown>
	if (e.v !== 3 || e.mode !== 'passcode' || e.alg !== 'AES-256-GCM') return false
	if (typeof e.kdf !== 'string' || typeof e.salt !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string') return false
	return typeof e.eoa === 'string' && EOA_RE.test(e.eoa)
}

export function pageMnemonicField(data: unknown): PageMnemonicField {
	const v = (data as { mnemonicPhrase?: unknown } | null | undefined)?.mnemonicPhrase
	if (v === undefined || v === null || v === '') return { kind: 'absent' }
	if (typeof v === 'string') {
		const t = v.trim()
		return t ? { kind: 'phrase', phrase: t } : { kind: 'absent' }
	}
	if (isMnemonicCipherEnvelope(v)) return { kind: 'envelope', envelope: v }
	return { kind: 'other' }
}
