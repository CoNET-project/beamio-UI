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

/**
 * 1423/1428: the only account credential is a valid BIP39 mnemonic. It must be present, validate, and derive an EOA. A private key
 * armor or a device hint is never account evidence (no legacy private-key compatibility).
 */
export function hasValidMnemonic(data: encrypt_keys_object | null | undefined): boolean {
	const phrase = typeof data?.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
	if (!phrase) return false
	try {
		return /^0x[0-9a-fA-F]{40}$/.test(ethers.Wallet.fromPhrase(phrase).address)
	} catch {
		return false
	}
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
	// rule E (2026-11-17): in the browser a record with only a private key (no valid mnemonic) goes to onboarding, and its data is kept.
	// The browser recovery route is not used for it (no plaintext mnemonic means no account credential here, E7).
	if (!shell && hasLocalPrivateKeyArmor(data) && !hasLocalPlaintextMnemonic(data)) return false
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

/**
 * 1423 / 1428: the EOA derived from the page's valid mnemonic (Wallet.fromPhrase: BIP-39 English, empty passphrase, m/44'/60'/0'/0/0,
 * index 0), or '' when there is no valid mnemonic. This is the only page-side account evidence for routing.
 */
export function validMnemonicEoa(data: encrypt_keys_object | null | undefined): string {
	const phrase = typeof data?.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
	if (!phrase) return ''
	try {
		const address = ethers.Wallet.fromPhrase(phrase).address
		return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : ''
	} catch {
		return ''
	}
}

/**
 * A shell record that carries only the EOA private-key copy and no mnemonic. Such a copy is not an account: when both sides confirm
 * that there is no mnemonic (the page record here, and the native walletEoaAddress answering no_key), the start goes on to onboarding.
 * A record with a mnemonic, or a completed Beamio account, is never judged here (the native recovery route keeps it). Read-only.
 */
export function isKeyOnlyCopyWithoutMnemonic(data: encrypt_keys_object | null | undefined): boolean {
	if (!data) return false
	if (typeof data.mnemonicPhrase === 'string' && data.mnemonicPhrase.trim()) return false
	if (hasCompletedBeamioAccount(data)) return false
	return hasLocalPrivateKeyArmor(data)
}
