/**
 * The page's decision when the native account answers `walletEoaAddress` with `no_key` (the native layer holds no key).
 *
 * - A page record (copy) is present: the native layer does not hold the key, so the state is definite: "the native key is
 *   missing, recovery is needed". Only the native recovery entry is shown. Nothing here creates an account, nothing is
 *   overwritten or deleted, and no EOA private key or mnemonic from the copy is handed to the native layer.
 * - No page record: onboarding only when the native layer confirms it: walletStatus is `no_key` and identityPublic reports
 *   `kPresent: false` (the kPresent answer is read only when the shell declares identity.kpresent.v1). Anything else is a retry.
 */
import { readNativeWalletStatus, type NativeWalletStatus } from './nativeKeyState'
import { readNativeIdentityPublic } from './nativeIdentityPublic'

export type NoKeyFacts = { walletStatus: NativeWalletStatus; kPresent: boolean | undefined }
export type NoKeyEntry = 'onboarding' | 'native_key_missing' | 'retry'
export type NoKeyPageRecord = 'empty' | 'present' | 'unknown'

export function decideNoKeyEntry(facts: NoKeyFacts | null, pageRecord: NoKeyPageRecord): NoKeyEntry {
	if (pageRecord === 'present') return 'native_key_missing'
	if (pageRecord !== 'empty') return 'retry'
	if (facts && facts.walletStatus === 'no_key' && facts.kPresent === false) return 'onboarding'
	return 'retry'
}

/** The native facts for the decision. Any failure is `null` (the caller retries). */
export async function readNoKeyFacts(): Promise<NoKeyFacts | null> {
	try {
		const walletStatus = await readNativeWalletStatus()
		if (walletStatus !== 'no_key') return { walletStatus, kPresent: undefined }
		const id = await readNativeIdentityPublic()
		return { walletStatus, kPresent: id.kind === 'no_key' ? id.kPresent : undefined }
	} catch {
		return null
	}
}
