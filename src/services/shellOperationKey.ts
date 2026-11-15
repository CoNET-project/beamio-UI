/**
 * One operation with the EOA key of a shell wallet. The native layer unseals the credential; the page derives the
 * EOA from the phrase with the same default path the browser uses, checks it against the native EOA, runs the operation, and then revokes the
 * session. Nothing is stored. Any mismatch fails closed: no fallback, no random wallet. PGP never enters this path.
 */
import { ethers } from 'ethers'
import { readWalletCredentialUnseal } from './walletCredential'

export type ShellOperationKeyCode = 'no_blob' | 'bad_expected_eoa' | 'eoa_mismatch' | 'released' | string

export class ShellOperationKeyError extends Error {
	readonly code: ShellOperationKeyCode
	constructor(code: ShellOperationKeyCode) {
		super(code)
		this.name = 'ShellOperationKeyError'
		this.code = code
	}
}

/** The operation's view of the key. It works only while the operation runs; after it ends, every read throws `released`. */
export type ShellOperationSession = {
	readonly eoa: string
	signingKey(): string
}

/**
 * Runs `use` with a session for the wallet whose sealed credential is `blob`, and whose public EOA is `expectedEoa`. The phrase and the
 * derived key are local to this call and are dropped when it returns or throws.
 */
export async function withShellOperationKey<T>(
	input: { blob: string | null | undefined; expectedEoa: string },
	use: (session: ShellOperationSession) => Promise<T>,
): Promise<T> {
	if (!input.blob) throw new ShellOperationKeyError('no_blob')
	if (!ethers.isAddress(input.expectedEoa)) throw new ShellOperationKeyError('bad_expected_eoa')
	const expected = input.expectedEoa.toLowerCase()
	const slot: { key: string | null } = { key: null }
	try {
		const answer = await readWalletCredentialUnseal(input.blob)
		if (answer.kind !== 'credential') throw new ShellOperationKeyError(answer.code)
		const derived = ethers.Wallet.fromPhrase(answer.mnemonic)
		if (derived.address.toLowerCase() !== expected || answer.eoa.toLowerCase() !== expected) {
			throw new ShellOperationKeyError('eoa_mismatch')
		}
		slot.key = derived.privateKey
		const session: ShellOperationSession = {
			eoa: expected,
			signingKey: () => {
				if (slot.key === null) throw new ShellOperationKeyError('released')
				return slot.key
			},
		}
		return await use(session)
	} finally {
		slot.key = null
	}
}
