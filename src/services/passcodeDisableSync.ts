/**
 * Closing the passcode (2026-11-22, item 5): the order is fixed and every step is injected, so the rule is testable without the
 * stores. 1 verify the passcode; 2 write the plain mnemonic and read it back; 3 replace the ciphertext record; 4 clear the cooldown; then, in
 * the background, one pwaWalletSync with the plain phrase. The sync is never called before the earlier steps succeeded, and never on a
 * failure (a failed verify, a failed or unconfirmed write, a failed replace). Nothing here logs a value.
 */
export interface DisablePasscodeSteps {
	/** Returns the plain phrase when the passcode is right; null when it is wrong or the record cannot be checked. */
	verifyPasscode: (passcode: string) => Promise<string | null>
	/** Writes the plain phrase and reads it back; true only when the read-back matches. */
	writePlainAndReadBack: (phrase: string, eoa: string) => Promise<boolean>
	/** Replaces the ciphertext record (after the plain read-back). */
	replaceCipher: (eoa: string) => Promise<boolean>
	/** Clears the cooldown of the account. */
	clearCooldown: (eoa: string) => Promise<void>
	/** The background pwaWalletSync with the plain phrase (never awaited by the caller's UI). */
	syncPlain: (phrase: string, eoa: string) => void
}

export type DisablePasscodeOutcome = 'disabled' | 'wrong_passcode' | 'write_failed' | 'replace_failed'

export async function disablePasscodeThenSync(passcode: string, eoa: string, steps: DisablePasscodeSteps): Promise<DisablePasscodeOutcome> {
	const phrase = await steps.verifyPasscode(passcode)
	if (phrase === null) return 'wrong_passcode'
	if (!(await steps.writePlainAndReadBack(phrase, eoa))) return 'write_failed'
	if (!(await steps.replaceCipher(eoa))) return 'replace_failed'
	await steps.clearCooldown(eoa)
	steps.syncPlain(phrase, eoa)
	return 'disabled'
}
