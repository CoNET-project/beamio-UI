import { ethers } from 'ethers'

/** Local PouchDB wallet has a plaintext 12-word mnemonic (consumer apps may persist it). */
export function hasLocalPlaintextMnemonic(data: encrypt_keys_object | null | undefined): boolean {
	return Boolean(typeof data?.mnemonicPhrase === 'string' && data.mnemonicPhrase.trim())
}

/** Local profile has a derived EOA private key armor (may exist without mnemonicPhrase briefly). */
export function hasLocalPrivateKeyArmor(data: encrypt_keys_object | null | undefined): boolean {
	const armor = data?.profiles?.[0]?.privateKeyArmor
	return Boolean(typeof armor === 'string' && armor.trim())
}

/** Any local signing material (mnemonic and/or privateKeyArmor). */
export function hasLocalSigningMaterial(data: encrypt_keys_object | null | undefined): boolean {
	return hasLocalPlaintextMnemonic(data) || hasLocalPrivateKeyArmor(data)
}

/** Registered Beamio account in local storage (EOA + @beamioTag), independent of mnemonic presence. */
export function hasCompletedBeamioAccount(data: encrypt_keys_object | null | undefined): boolean {
	if (!data) return false
	const eoa = data.profiles?.[0]?.keyID
	if (!eoa || !ethers.isAddress(eoa)) return false
	const accountName = data.beamio?.accountName
	if (!accountName || typeof accountName !== 'string' || !accountName.trim()) return false
	return true
}

/**
 * Trusted-empty local wallet blob: no signing secrets and no completed Beamio account.
 * Must enter first-time onboarding — never "Wallet storage is unavailable".
 */
export function isTrustedEmptyWalletBlob(data: encrypt_keys_object | null | undefined): boolean {
	if (!data) return true
	return !hasLocalSigningMaterial(data) && !hasCompletedBeamioAccount(data)
}

/**
 * Existing account on device but no plaintext mnemonic — must recover via BeamioTag + password
 * (CoNET chain) before using the app. See `beamio-consumer-wallet-signing-storage.mdc`.
 */
export function consumerAppNeedsWalletRecover(data: encrypt_keys_object | null | undefined): boolean {
	return hasCompletedBeamioAccount(data) && !hasLocalPlaintextMnemonic(data)
}

/**
 * Scheme A: the page sends an account without a plaintext mnemonic to its own recovery only outside a shell. In a
 * shell the native side holds the EOA key and owns recovery (the page recovery entry throws native_recovery_only there).
 */
export function pageWalletRecoverNeeded(data: encrypt_keys_object | null | undefined, shell: boolean): boolean {
	return !shell && consumerAppNeedsWalletRecover(data)
}

/** Scheme A: a plaintext mnemonic is required by the page only outside a shell (the shell holds the EOA key). */
export function pagePlaintextMnemonicMissing(data: encrypt_keys_object | null | undefined, shell: boolean): boolean {
	return !shell && !hasLocalPlaintextMnemonic(data)
}

/** Normalized @beamioTag (no leading @) from local wallet blob, if present. */
export function knownBeamioAccountNameFromStorage(
	data: encrypt_keys_object | null | undefined,
): string {
	const raw = data?.beamio?.accountName
	if (typeof raw !== 'string') return ''
	const trimmed = raw.trim().replace(/^@+/, '')
	return trimmed
}

/** `?beamioTag=` from current page URL (restore / deep link). */
export function beamioTagFromUrlSearch(): string {
	if (typeof window === 'undefined') return ''
	const raw = new URLSearchParams(window.location.search).get('beamioTag')?.trim()
	if (!raw) return ''
	return raw.replace(/^@+/, '')
}
