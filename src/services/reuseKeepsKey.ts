/**
 * and the reviewer on de725dda: reusing an existing local key keeps the EOA and the private key.
 * A pure check, loadable under jest. createRecover uses it on the reuse path, so a changed key fails closed and nothing is written.
 */
export type ReusableWallet = { profiles?: ReadonlyArray<{ keyID?: unknown; privateKeyArmor?: unknown }> } | null | undefined

const firstKey = (w: ReusableWallet): { eoa: string; armor: string } => {
	const p = w?.profiles?.[0]
	const eoa = typeof p?.keyID === 'string' ? p.keyID.trim().toLowerCase() : ''
	const armor = typeof p?.privateKeyArmor === 'string' ? p.privateKeyArmor.trim() : ''
	return { eoa, armor }
}

/**
 * True when the wallet after the reuse step holds the same EOA and the same private key as before.
 * A record that has only a recovery phrase (no key yet) may gain its key by derivation; the EOA must then match a stored EOA if one exists.
 */
export const reuseKeepsKey = (before: ReusableWallet, after: ReusableWallet): boolean => {
	const a = firstKey(before)
	const b = firstKey(after)
	if (b.armor === '') return false
	if (a.armor === '') return a.eoa === '' || a.eoa === b.eoa
	return a.armor === b.armor && a.eoa === b.eoa
}
