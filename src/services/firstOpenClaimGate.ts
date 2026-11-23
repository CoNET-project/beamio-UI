/**
 * The claimBUnits gate on the first-open path (decided by the): a browser that enters Chat with no
 * PGP record, where the SDK confirms it, sends no automatic POST /api/claimBUnits. Other explicit entries are not changed. The gate reads the
 * AddressPGP answer in three states (absent is a definite empty answer; anything else is unknown). An unknown does not skip the claim: the
 * claim is not made on a failed read either (the gate fails closed on the first-open path only when the read says absent).
 * SYNTHETIC values only.
 */
import { chainReadFromLookup, isFirstOpenCandidate } from '@conet.project/chat-sdk'

export type ClaimGateLookup = { status: 'ok' | 'no_record' | 'network_error' | 'internal_error'; publicArmored?: string; routersArmoreds?: string }

/** Pure: true when the automatic claim must not be sent on this first-open path. A shell is never the browser path. */
export function skipAutoBUnitClaimForFirstOpen(input: { shell: boolean; lookup: ClaimGateLookup; localChatKeyComplete: boolean; pendingPresent: boolean }): boolean {
	if (input.shell) return false
	// an internal fault of our own code is an unknown chain read, like a network failure (the claim is not skipped on it)
	const chain = chainReadFromLookup(input.lookup.status === 'internal_error' ? { status: 'network_error' } : { ...input.lookup, status: input.lookup.status })
	if (chain !== 'absent') return false
	return isFirstOpenCandidate({
		restore: 'new_account',
		chain,
		// the backup is not read here: a record-less account with a backup is not a first identity; the flow itself keeps that protection
		chainBackup: 'absent',
		localOldIdentity: input.localChatKeyComplete && !input.pendingPresent,
		localPendingOwn: input.pendingPresent,
	})
}

