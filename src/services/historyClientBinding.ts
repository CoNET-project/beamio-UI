/**
 * Which account a worker client may feed (a reviewed blocker).
 *
 * A worker client is created for one account (its eoaAddress is fixed at creation). A later account change does not stop it by itself, so a
 * client can still be alive while the page already holds another account. The page reads and applies history only when the client's
 * account is the current account. Both sides are compared in lower case. SYNTHETIC values only.
 */

/** True only when a client exists, it is bound to an account, and that account is the current one. */
export const canReadForAccount = (boundEoa: string | null | undefined, account: string): boolean =>
	!!account && !!boundEoa && boundEoa.toLowerCase() === account.toLowerCase()

/** A history buffer batch from a client bound to `boundEoa` is applied only while `currentAccount` is that account. */
export const shouldApplyBufferBatch = (boundEoa: string | null | undefined, currentAccount: string): boolean =>
	canReadForAccount(boundEoa, currentAccount)

/**
 * What a gossip start does, given the live client.
 * - `start`: no gossip is live: start one.
 * - `skip`: a live client is bound to the current account (or the account or the client is not known yet, or the shell owns the listen):
 *   nothing is started, as before.
 * - `restart`: a live browser client is bound to ANOTHER account: stop it, then start for the current account. Without this, a gossip
 *   flag kept the old client, and the new account had no client of its own.
 */
export type GossipStartDecision = 'start' | 'skip' | 'restart'

export const gossipStartDecision = (input: {
	gossip: boolean
	bound: string | null | undefined
	account: string
	shell: boolean
}): GossipStartDecision => {
	if (!input.gossip) return 'start'
	if (input.shell || !input.account || !input.bound) return 'skip'
	return input.bound.toLowerCase() === input.account.toLowerCase() ? 'skip' : 'restart'
}

/**
 * An inbound line belongs to the account of the client that decrypted it. The envelope carries no recipient field (the sender's
 * `from` and the signature only, chat.ts sendMessage), and the worker decrypts with the client's own key. So a line is passed on only while
 * that client's account is the current account.
 */
export const inboundLineForAccount = (boundEoa: string | null | undefined, currentAccount: string | null): boolean =>
	currentAccount === null || canReadForAccount(boundEoa, currentAccount)

/**
 * Whether the parameters of the live listen (kept from its start) still belong to the current account. The voice
 * route restart reuses them: after an account change they must not be reused (the listen would again be the old account's). An unknown
 * account or no recorded account keeps the old behaviour.
 */
export const listenParamsFitAccount = (listenEoa: string | null | undefined, account: string): boolean =>
	!listenEoa || !account || listenEoa.toLowerCase() === account.toLowerCase()

/**
 * What an account change does to a live client). `restart`only when the account really changes (a mount, or the
 * first account, is not a change), a live browser client is bound to another account, and the start can go on (gossipStartDecision).
 */
export const accountChangeAction = (input: {
	previousAccount: string
	account: string
	gossip: boolean
	bound: string | null | undefined
	shell: boolean
}): 'none' | 'restart' => {
	if (!input.previousAccount || !input.account) return 'none'
	if (input.previousAccount.toLowerCase() === input.account.toLowerCase()) return 'none'
	return gossipStartDecision({ gossip: input.gossip, bound: input.bound, account: input.account, shell: input.shell }) === 'restart'
		? 'restart'
		: 'none'
}
