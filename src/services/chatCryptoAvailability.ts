/**
 * Chat capability from the PGP signals (Y.94 1 and 2). PGP is not an account judgement: a missing PGP never decides that a wallet is
 * lost (the account is judged by the mnemonic only, Y.85, Y.89). These signals only decide whether the chat encryption actions are
 * enabled (Y.81). The full Y.81 availability (read-only history, retry schedule) is extended in the next batch.
 */
export type ChatPgpInput = {
	/** identityPublic pgpReady (§25.48.4): false when the PGP material is not complete. */
	pgpReady: boolean
	/** pgpUpgradeState code (§25.52Y.62); `pgp_migration_retry` means the key migration waits for a retry. */
	pgpUpgradeState?: string | null
	/** `pgp_source_unavailable` (PR.1.1): the PGP source is temporarily unavailable. */
	pgpSourceUnavailable?: boolean
}

/** Chat encryption actions (send, decrypt, sign) are enabled only when the PGP material is complete and not waiting for a retry. */
export function chatEnabledOf(input: ChatPgpInput): boolean {
	if (!input.pgpReady) return false
	if (input.pgpUpgradeState === 'pgp_migration_retry') return false
	if (input.pgpSourceUnavailable) return false
	return true
}
