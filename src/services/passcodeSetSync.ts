/**
 * Setting or changing the passcode (2026-11-22, the decision item 2). Order, every step injected:
 * 1 seal the phrase under the new six-digit passcode (f1 v3 envelope);
 * 2 open the new envelope again in memory with the same passcode and check it: ok, the phrase is the one set, the EOA is the account
 *   (a mismatch is verify_failed, and the record is not written);
 * 3 write the envelope to the page record (IndexedDB);
 * 4 the first pwaWalletSync carries the passcode with the cipher ({..., cipher, passcode}); the switch is complete only on the shell's
 *   ok with decrypted:true. Any other answer (unlock_failed, verify_failed, no answer) is not complete: the written record stays as it is.
 * The passcode is used in memory and in that one request; it is never logged or stored by this module.
 */
export interface SetPasscodeSteps {
	seal: (phrase: string, eoa: string, passcode: string) => Promise<Record<string, unknown> | null>
	openInMemory: (envelope: Record<string, unknown>, passcode: string) => Promise<{ code: string; phrase?: string; eoa?: string }>
	writeRecord: (envelope: Record<string, unknown>) => Promise<boolean>
	firstSyncWithPasscode: (envelope: Record<string, unknown>, passcode: string) => Promise<'ok' | 'not_completed'>
}

export type SetPasscodeOutcome = 'complete' | 'seal_refused' | 'memory_check_failed' | 'write_failed' | 'sync_not_completed'

export async function setPasscodeThenSync(
	input: { phrase: string; eoa: string; passcode: string },
	steps: SetPasscodeSteps,
): Promise<SetPasscodeOutcome> {
	const eoa = input.eoa.toLowerCase()
	const envelope = await steps.seal(input.phrase.trim(), eoa, input.passcode)
	if (!envelope) return 'seal_refused'
	const opened = await steps.openInMemory(envelope, input.passcode)
	if (opened.code !== 'ok' || opened.phrase !== input.phrase.trim() || (opened.eoa ?? '').toLowerCase() !== eoa) return 'memory_check_failed'
	if (!(await steps.writeRecord(envelope))) return 'write_failed'
	return (await steps.firstSyncWithPasscode(envelope, input.passcode)) === 'ok' ? 'complete' : 'sync_not_completed'
}
