/**
 * The recovery code is the value generateCODE makes (uuid62.v4): 22 base62 characters. A scanned Recovery QR is accepted only in this
 * format (C-2): a QR that carries a mnemonic, a private key or a URL never fills the recovery code field.
 */
export const RECOVERY_CODE_FORMAT = /^[0-9A-Za-z]{22}$/

export function isRecoveryCodeFormat(value: string): boolean {
	return RECOVERY_CODE_FORMAT.test(String(value ?? '').trim())
}
