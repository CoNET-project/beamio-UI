/**
 * Local-library unlock through walletCore (–25.4). The page's walletCore holds the account key. The
 * worker receives only the three local subkeys (K_id, K_idx, DEK), returned by the whitelisted deriveSubkeys command.
 * The key itself never leaves walletCore, and the worker never receives it.
 */
import { lockLocalChat, unlockLocalChatKeys } from './chatWorkerBridge'
import { walletCore } from './walletCore'

/** Unlock walletCore for this account and hand the local subkeys to the worker. False when locked or refused. */
export async function unlockChatLocalWallet(privateKeyArmor: string, eoa: string): Promise<boolean> {
	if (!walletCore.unlock(privateKeyArmor, eoa)) return false
	try {
		const session = walletCore.openSession()
		const accountKey = walletCore.status().accountKey
		const keys = (await walletCore.call({ command: 'deriveSubkeys', accountKey, session, payload: {} })) as {
			kIdHex: string
			kIdxHex: string
			dekHex: string
		}
		walletCore.closeSession(session)
		return await unlockLocalChatKeys({ kIdHex: keys.kIdHex, kIdxHex: keys.kIdxHex, dekHex: keys.dekHex })
	} catch {
		return false
	}
}

/** Lock walletCore (drops the key and sessions) and the worker library (zeroes the subkeys; the file stays). */
export async function lockChatLocalWallet(): Promise<boolean> {
	walletCore.lock()
	return lockLocalChat()
}
