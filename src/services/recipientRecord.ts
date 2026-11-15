/**
 * The AddressPGP answer for one wallet, read into three exclusive results (the global RPC rule).
 *
 * `ok`: a valid key and route. `no_record`: a valid empty answer, the wallet has not registered a PGP key. `network_error`: a failed
 * call, a timeout, an undecodable answer, or an incomplete registration (a key without a route or the reverse). A failed read is never
 * `no_record`, so the UI and the send path can show, hold or retry each one differently.
 *
 * The chain call is injected, so the rules are tested without a provider.
 */

export type RecipientLookup =
	| { status: 'ok'; publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; userPgpKeyID?: string }
	| { status: 'no_record' }
	| { status: 'network_error'; reason: string }

/** The fields of AddressPGP `searchKey` that the lookup reads. Armor is base64 as the contract returns it. */
export interface SearchKeyAnswer {
	userPublicKeyArmored?: string
	routePublicKeyArmored?: string
	userPgpKeyID?: string
	routePgpKeyID?: string
}

/** Thrown by a reader that must not turn a failed read into "no record" (getKeysFromCoNETPGPSC). */
export class RecipientReadError extends Error {
	readonly code = 'network_error' as const
	readonly reason: string

	constructor(reason: string) {
		super(`network_error: ${reason}`)
		this.name = 'RecipientReadError'
		this.reason = reason
	}
}

export const isRecipientReadError = (ex: unknown): ex is RecipientReadError =>
	ex instanceof RecipientReadError || (typeof ex === 'object' && ex !== null && (ex as { name?: unknown }).name === 'RecipientReadError')

/**
 * Reads one AddressPGP answer. A throw or an empty answer from `searchKey` is `network_error`; a valid empty answer is `no_record`.
 * `decode` turns the base64 armor into text; a decode failure is `network_error`.
 */
export async function readRecipientRecord(
	searchKey: () => Promise<SearchKeyAnswer>,
	decode: (base64: string) => string,
): Promise<RecipientLookup> {
	let info: SearchKeyAnswer | null | undefined
	try {
		info = await searchKey()
	} catch (ex) {
		return { status: 'network_error', reason: ex instanceof Error ? ex.message.slice(0, 80) : 'rpc' }
	}
	if (!info || typeof info !== 'object') return { status: 'network_error', reason: 'empty_answer' }
	let publicArmored = ''
	let routersArmoreds = ''
	try {
		publicArmored = info.userPublicKeyArmored ? decode(info.userPublicKeyArmored) : ''
		routersArmoreds = info.routePublicKeyArmored ? decode(info.routePublicKeyArmored) : ''
	} catch {
		return { status: 'network_error', reason: 'undecodable_answer' }
	}
	if (!publicArmored && !routersArmoreds) return { status: 'no_record' }
	if (!publicArmored || !routersArmoreds) return { status: 'network_error', reason: 'incomplete_registration' }
	return { status: 'ok', publicArmored, routersArmoreds, routePgpKeyID: info.routePgpKeyID, userPgpKeyID: info.userPgpKeyID }
}
