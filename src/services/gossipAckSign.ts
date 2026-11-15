/**
 * Signing of gossip messages through (interface notice 26). The page no longer builds an ethers.Wallet from the
 * account key to sign a mailbox ack or a receipt: the key is handed once to the main-thread wallet core, which unlocks for the
 * account, and the signature is made there (`gossip` kind, shape checked first).
 */
import { shellPublicEoaOrEmpty } from './nativeIdentityPublic'
import { ethers } from 'ethers'
import { accountKeyOf, walletCore } from './walletCore'
import { isShellContext } from './shellContext'
import { nativeSignGossip } from './nativeSigning'
import { accountAddressOf } from './shellProfile'
import { CoNET_Data } from '../utils/globals'

const with0x = (privateKeyHex: string): string => `0x${privateKeyHex.trim().replace(/^0x/i, '')}`

/** The EOA of an account key, checksummed (the form the ack carries as `walletAddress`). Derivation only: no signing. */
export function eoaOfKey(privateKeyHex: string): string {
	return ethers.computeAddress(with0x(privateKeyHex))
}

/**
 * A signing account exists: a key on the page (browser), or a shell whose native layer holds the key. In a shell the page has
 * no key (the profile is stripped, 2026-11-13), so the check cannot depend on the key alone.
 */
export function canSignAccount(privateKeyArmor?: string): boolean {
	return !!privateKeyArmor?.trim() || isShellContext()
}

/**
 * The account EOA (checksummed). A shell has no key on the page: the EOA is the account's keyID (`accountAddressOf`),
 * and the native layer checks it against the unlocked account.
 */
export function accountEoaFor(privateKeyArmor?: string): string {
	if (privateKeyArmor?.trim()) return eoaOfKey(privateKeyArmor)
	// Shell: the public EOA from identityPublic; the profile holds no key in a shell.
	if (isShellContext()) {
		const eoa = shellPublicEoaOrEmpty()
		if (eoa) return eoa
	}
	return accountAddressOf(CoNET_Data?.profiles?.[0]) || ''
}

/**
 * Signs `message` (the exact string the caller gives) with the account key through. Throws the wallet core's error code
 * when the shape is refused or the wallet cannot be unlocked for the account.
 */
export async function signGossipAckMessage(privateKeyHex: string, message: string): Promise<{ eoa: string; signature: string }> {
	if (isShellContext()) {
		// Shell: the native layer holds the key. `gossipSign` checks the shape first, so the EOA here is the one it accepted.
		const out = await nativeSignGossip(message)
		if (!out.ok) throw new Error(out.reason)
		const eoa = ethers.getAddress(String((JSON.parse(message) as { walletAddress?: unknown }).walletAddress ?? ''))
		return { eoa, signature: out.signature }
	}
	const eoa = eoaOfKey(privateKeyHex)
	const cur = walletCore.status()
	if (cur.state !== 'unlocked' || cur.accountKey !== accountKeyOf(eoa)) {
		if (!walletCore.unlock(privateKeyHex, eoa)) throw new Error('wallet_unlock_failed')
	}
	const session = walletCore.openSession()
	try {
		const signature = (await walletCore.call({
			command: 'signGossip',
			accountKey: accountKeyOf(eoa),
			session,
			payload: { kind: 'gossip', message },
		})) as string
		return { eoa, signature }
	} finally {
		walletCore.closeSession(session)
	}
}
