/**
 * Bridge key guard (interface notice 27,). No command sent to a native shell may
 * carry a wallet private key, a mnemonic or PGP private armor, under any key name, at any depth, or in any string value.
 * The native chat transports check every command before it leaves the page, so a refused field never reaches the bridge.
 * A refusal names the field (or the kind of value) only, never the value.
 *
 * Unlike identityPayload.findForbiddenKey, this guard does not apply the 64-hex value rule: armor hashes (for example
 * `ackInbound.armorHashes`) cross the bridge by design. The identity payloads keep their own stricter check.
 */
import { CRED_NAMES, normalizeForCompare } from './identityPayload'

/** Refusal used when the shell does not declare identity.native-keys.v1: native chat is not started, no key is sent. */
export const IDENTITY_CAPABILITY_MISSING = 'identity_capability_missing'

/**
 * Key names, compared after normalisation N and case-insensitively. The list applies to EVERY bridge command that the native chat
 * transport sends (assertNoKeyOverBridge runs on each one), so a key named pin, password, recoveryCode, recoveryWords or any other
 * name here is refused in any command, not only in the identity commands. The CRED names are CRED_NAMES (identityPayload.ts).
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(
	[
		'privateKeyHex',
		'walletPrivateKey',
		'privateKeyArmor',
		'privateKey',
		'pgpPrivateKeyArmored',
		'pgpPrivateKey',
		'pgpPassphrase',
		'mnemonic',
		'mnemonicPhrase',
		'phrase',
		// the CRED names that the list above does not already carry.
		...CRED_NAMES,
	].map((k) => normalizeForCompare(k).toLowerCase()),
)

/** A string that carries PGP private armor (after normalisation: spaces and format characters removed, upper case). */
function isPrivateArmorText(s: string): boolean {
	const n = normalizeForCompare(s).toUpperCase()
	return n.includes('PRIVATEKEYBLOCK') || n.includes('BEGINPGPPRIVATEKEY')
}

/** Returns the first key name (or a value kind) that must not cross the bridge, or null. */
export function findKeyOverBridge(value: unknown): string | null {
	if (typeof value === 'string') return isPrivateArmorText(value) ? '(private armor text)' : null
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = findKeyOverBridge(item)
			if (hit !== null) return hit
		}
		return null
	}
	if (value && typeof value === 'object') {
		for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_NAMES.has(normalizeForCompare(name).toLowerCase())) return name
			const hit = findKeyOverBridge(item)
			if (hit !== null) return hit
		}
	}
	return null
}

/** Throws before anything is sent. The message names the field only. */
export function assertNoKeyOverBridge(command: unknown, where: string): void {
	const hit = findKeyOverBridge(command)
	if (hit !== null) throw new Error(`${where}: key material refused (${hit})`)
}
