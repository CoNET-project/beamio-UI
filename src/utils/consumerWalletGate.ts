import { pageMnemonicField } from '@/services/pageMnemonicField'
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

/**
 * R2271 (page-side unrecognised secret): a record with no mnemonic that still carries a non-empty secret-class field the reader did not recognise is not an
 * empty record. Checked on the record after the start read has opened every recognised wrap, so what remains is: a secret-named field whose value is an
 * object or another non-string shape (privateKeyArmor, mnemonicPhrase, ...), or a non-empty `*Wrap` sibling (privateKeyArmorWrap, pgpKey.privateKeyArmorWrap,
 * a top-level privateKeyArmorWrap). A string key or phrase is handled by the existing rules; an address alone is not a secret. Scans the top level,
 * profiles[*] and profiles[*].pgpKey only (never the chat containers).
 */
export function hasUnrecognizedSecret(data: encrypt_keys_object | null | undefined): boolean {
	const nonEmpty = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && Object.keys(v as object).length === 0)
	const SECRET_KEY = /(privatekey|mnemonic|secret|seed)/i
	const flagged = (o: unknown): boolean => {
		if (!o || typeof o !== 'object' || Array.isArray(o)) return false
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
			const wrap = /Wrap$/.test(k)
			if ((wrap || SECRET_KEY.test(k)) && nonEmpty(v) && (wrap || typeof v !== 'string')) return true
		}
		return false
	}
	const d = data as unknown as Record<string, unknown> | null | undefined
	if (!d || typeof d !== 'object') return false
	if (flagged(d)) return true
	const profiles = Array.isArray(d.profiles) ? (d.profiles as unknown[]).flat() : []
	for (const p of profiles) {
		if (flagged(p)) return true
		if (p && typeof p === 'object' && flagged((p as Record<string, unknown>).pgpKey)) return true
	}
	return false
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
	// in the browser a record with only a private key (no valid mnemonic) goes to onboarding, and its data is kept.
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
 * A shell record that carries only the EOA private-key copy and no mnemonic (R94). Such a copy is not an account: when both sides confirm
 * that there is no mnemonic (the page record here, and the native walletEoaAddress answering no_key), the start goes on to onboarding.
 * A record with a mnemonic, or a completed Beamio account, is never judged here (the native recovery route keeps it). Read-only.
 */
export function isKeyOnlyCopyWithoutMnemonic(data: encrypt_keys_object | null | undefined): boolean {
	if (!data) return false
	// any mnemonicPhrase value other than absent (a phrase, a v3 envelope, or an unknown shape) is never a key-only copy
	if (pageMnemonicField(data).kind !== 'absent') return false
	if (hasCompletedBeamioAccount(data)) return false
	return hasLocalPrivateKeyArmor(data)
}
