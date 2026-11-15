/**
 * Shell: one signing operation that needs the EOA key. The native EOA is read first; the sealed credential blob from the page
 * record is unsealed by the native layer, and the key is derived for this operation only (see shellOperationKey). A native refusal
 * or a mismatch stops the operation before anything is signed.
 */
import { readWalletEoaAddress } from './walletEoaAddress'
import { ShellOperationKeyError, withShellOperationKey, type ShellOperationSession } from './shellOperationKey'

export async function runShellEoaOperation<T>(
	blob: string | null | undefined,
	use: (session: ShellOperationSession) => Promise<T>,
): Promise<T> {
	const native = await readWalletEoaAddress()
	if (native.kind !== 'address') throw new ShellOperationKeyError(native.code)
	return withShellOperationKey({ blob, expectedEoa: native.eoa }, use)
}
