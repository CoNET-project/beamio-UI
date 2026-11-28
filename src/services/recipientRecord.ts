/**
 * The AddressPGP answer for one wallet, read into three exclusive results (the global RPC rule).
 *
 * `ok`: a valid key and route. `no_record`: a valid empty answer, the wallet has not registered a PGP key. `network_error`: a failed
 * call, a timeout, an undecodable answer, or an incomplete registration (a key without a route or the reverse). A failed read is never
 * `no_record`, so the UI and the send path can show, hold or retry each one differently.
 *
 * The chain call is injected, so the rules are tested without a provider.
 */

import type { RecordSource } from '../utils/chainPgpTrust'

export type RecipientLookup =
	| { status: 'ok'; publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; userPgpKeyID?: string; source?: RecordSource }
	| { status: 'no_record' }
	| { status: 'network_error'; reason: string }
	/** A programming or build fault (a missing ABI function, a TypeError): not a network read result, never retried as one. */
	| { status: 'internal_error'; reason: string }

/** Thrown by the reader when the contract has no `searchKey` (a build without the ABI fragment). */
export class RecipientInternalError extends Error {
	readonly reason: string

	constructor(reason: string) {
		super(`internal_error: ${reason}`)
		this.name = 'RecipientInternalError'
		this.reason = reason
	}
}

/**
 * the browser's own failure to reach the network is a TypeError (the fetch API rejects with TypeError for every network-level failure; the MESSAGE is
 * implementation-defined). It is a network failure, not a fault in our code: the contact is held, retried automatically, and the user gets Retry (the safe direction).
 * The class is TypeError AND a known engine wording; a TypeError with any other message (undefined access, a missing function, a bad argument) stays a programming error and is
 * still reported as internal_error. Wordings, as measured or documented:
 *  - Chrome: "Failed to fetch" (closed port, DNS failure, CORS block, bad scheme alike)
 *  - Node/undici (measured, v22): "fetch failed"
 *  - Safari / WKWebView (the iOS shell): "Load failed" (also older "The network connection was lost.", "The Internet connection appears to be offline."): documented, NOT measured here
 *  - Firefox: "NetworkError when attempting to fetch resource.": documented, NOT measured here
 * The wording KEY (never the text) is logged when a lookup is classified this way, so a device capture shows which wording a shell produced.
 */
const FETCH_WORDINGS: ReadonlyArray<readonly [string, RegExp]> = [
	['failed_to_fetch', /^failed to fetch$/i],
	['load_failed', /^load failed$/i],
	['networkerror', /^networkerror when attempting to fetch resource\.?$/i],
	['fetch_failed', /^fetch failed$/i],
	['connection_lost', /^the network connection was lost\.?$/i],
	['offline', /^the internet connection appears to be offline\.?$/i],
	// more WKWebView / Android WebView network wordings (documented, NOT measured here); each is a failure to reach the network, never a fault in our code
	['timed_out', /^the request timed out\.?$/i],
	['host_not_found', /^a server with the specified hostname could not be found\.?$/i],
	['no_connect', /^could not connect to the server\.?$/i],
	['cancelled', /^cancell?ed$/i],
	['request_failed', /^network request failed$/i],
]
export const fetchTypeErrorWording = (ex: unknown): string | null => {
	if (typeof ex !== 'object' || ex === null) return null
	if (String((ex as { name?: unknown }).name ?? '') !== 'TypeError') return null
	const message = String((ex as { message?: unknown }).message ?? '').trim()
	for (const [key, re] of FETCH_WORDINGS) if (re.test(message)) return key
	return null
}
export const isFetchNetworkTypeError = (ex: unknown): boolean => fetchTypeErrorWording(ex) !== null

/** A fault in our own code (not an RPC or network failure): TypeError, ReferenceError, or a RecipientInternalError. Matched by name across realms. A fetch network TypeError is not one (isFetchNetworkTypeError). */
export const isProgrammingError = (ex: unknown): boolean => {
	if (isFetchNetworkTypeError(ex)) return false
	const name = typeof ex === 'object' && ex !== null ? String((ex as { name?: unknown }).name ?? '') : ''
	return name === 'TypeError' || name === 'ReferenceError' || name === 'RecipientInternalError'
}

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
 * Reads one AddressPGP answer. A failed call or an empty answer from `searchKey` is `network_error` (a TypeError-class fault is `internal_error`); a valid empty answer is `no_record`.
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
		// A fault in our own code is reported as such (with its class), never as a network failure.
		if (isProgrammingError(ex)) {
			return { status: 'internal_error', reason: ex instanceof RecipientInternalError ? ex.reason : String((ex as { name?: unknown }).name) }
		}
		const wording = fetchTypeErrorWording(ex)
		if (wording) return { status: 'network_error', reason: `fetch_typeerror:${wording}` }
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
