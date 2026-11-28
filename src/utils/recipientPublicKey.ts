/**
 * The recipient's public key and mailbox route for a send (-4/-5 and
 * 1).
 *
 * The lookup is three-valued (`ok`, `no_record`, `network_error`), and the three never mix: a failed call is `network_error`, never
 * `no_record`. A send fetches the recipient's current key and route first. A failed fetch holds the send (`route_unconfirmed`).
 *
 * Trust: a key is released to a send only when its fingerprint is the one the user verified. With no verified key yet the send is
 * held (`first_fetch_pending`); with another key it is held (`fingerprint_changed`). A held send carries the key that was read. When the user
 * compares the fingerprint on screen and verifies or accepts it, the key the user saw is the one sent and written (`sendWithPinnedRoute`):
 * it is not fetched again at that moment.
 *
 * The fingerprint is the OpenPGP standard fingerprint, not a hash of the armor text. The fetch is injected, so the rules can be
 * tested without the chat stack.
 */
import { openPgpFingerprintOfArmor, openPgpEncryptionKeyFingerprintOfArmor, readStoredKeyFingerprint } from './pgpFingerprint'
import { chainRecordTrust, type RecordSource } from './chainPgpTrust'
import { fetchTypeErrorWording, isProgrammingError } from '../services/recipientRecord'

export type RecipientKeyFailure = 'recipient_key_unavailable' | 'recipient_key_invalid' | 'recipient_no_record' | 'network_error'
export type RecipientKeyResult = { ok: true; publicArmored: string } | { ok: false; code: RecipientKeyFailure }

const PGP_PUBLIC_BLOCK = '-----BEGIN PGP PUBLIC KEY BLOCK-----'

export function isPgpPublicArmor(value: unknown): value is string {
	return typeof value === 'string' && value.trim().startsWith(PGP_PUBLIC_BLOCK)
}

/** The three exclusive results of an AddressPGP read (chat.ts lookupRecipientRecord has the same shape). */
export type RecipientLookup =
	| { status: 'ok'; publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; userPgpKeyID?: string; source?: RecordSource }
	| { status: 'no_record' }
	| { status: 'network_error'; reason: string }
	| { status: 'internal_error'; reason: string }

/**
 * `freshChain`: the first contact (no pinned value yet) is allowed to rely on the chain record, so the reader must have asked the RPC for its chain id for THIS
 * lookup, not reuse a session answer. A contact that already has a pinned value does not need it: the pin is the anchor and a record from another chain only fails the pin.
 */
export type FetchRecipientRoute = (address: string, opts?: { freshChain?: boolean }) => Promise<RecipientLookup>

export interface RecipientChat {
	address?: string
	/** keyFingerprint: the fingerprint at the last successful fetch. verifiedFingerprint: the fingerprint the user compared or accepted. Both are stored with the OpenPGP scheme prefix. */
	chatData?: { publicArmored?: string; routersArmoreds?: string; keyFingerprint?: string; verifiedFingerprint?: string } | null
}

/** A key and route that were read for a send: the held send keeps them, and the user's verification sends and writes exactly these. */
export interface HeldKey {
	publicArmored: string
	routersArmoreds: string
	routePgpKeyID?: string
	/** The OpenPGP fingerprint of `publicArmored` (lowercase hex). */
	fingerprint: string
}

/** The OpenPGP standard fingerprint of a public key. */
export async function fingerprintOfArmor(armor: string): Promise<string> {
	return openPgpFingerprintOfArmor(armor)
}

async function lookupOrNetworkError(address: string, fetchRoute: FetchRecipientRoute, opts?: { freshChain?: boolean }): Promise<RecipientLookup> {
	try {
		const lookup = await (opts?.freshChain ? fetchRoute(address, { freshChain: true }) : fetchRoute(address))
		return lookup ?? { status: 'network_error', reason: 'empty_answer' }
	} catch (ex) {
		// a fetch network TypeError is a network failure (held, retried), not a programming error (recipientRecord.isProgrammingError)
		if (isProgrammingError(ex)) {
			const name = typeof ex === 'object' && ex !== null ? String((ex as { name?: unknown }).name ?? '') : ''
			return { status: 'internal_error', reason: name }
		}
		const wording = fetchTypeErrorWording(ex)
		return { status: 'network_error', reason: wording ? `fetch_typeerror:${wording}` : 'exception' }
	}
}

/**
 * The recipient's public armor for a send. A valid armor in the chat copy is used as it is (no lookup). Otherwise the lookup decides:
 * `no_record` and `network_error` are different failures, and an invalid key is `recipient_key_invalid`.
 */
export async function resolveRecipientPublicArmored(chat: RecipientChat | null | undefined, fetchRoute: FetchRecipientRoute): Promise<RecipientKeyResult> {
	const local = chat?.chatData?.publicArmored
	if (isPgpPublicArmor(local)) return { ok: true, publicArmored: local.trim() }
	const address = (chat?.address ?? '').trim()
	if (!address) return { ok: false, code: 'recipient_key_unavailable' }
	const lookup = await lookupOrNetworkError(address, fetchRoute)
	if (lookup.status === 'no_record') return { ok: false, code: 'recipient_no_record' }
	if (lookup.status === 'network_error') return { ok: false, code: 'network_error' }
	// a fault in our own code is not a network failure: the key is unavailable (its own copy), not "could not read"
	if (lookup.status === 'internal_error') return { ok: false, code: 'recipient_key_unavailable' }
	if (!isPgpPublicArmor(lookup.publicArmored)) return { ok: false, code: 'recipient_key_invalid' }
	return { ok: true, publicArmored: lookup.publicArmored.trim() }
}

/** (owner): the recipient's key and route are read every 5 minutes while the chat is open (pending confirmation). */
export const RECIPIENT_REFRESH_PERIOD_MS = 5 * 60 * 1000

/**  /.5a: a held send (route_unconfirmed) is tried again after these delays, then waits for the user. */
export const RECIPIENT_ROUTE_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000]

/** A re-read of the recipient's key and route. `changed`: either value differs from the chat copy. `fingerprintChanged`: the key differs from the one stored at the last successful fetch. */
export type RecipientRefresh =
	| {
			ok: true
			changed: boolean
			publicArmored: string
			routersArmoreds: string
			routePgpKeyID?: string
			fingerprint: string
			fingerprintChanged: boolean
			/** The key id the chain record carries, and where the read came from (see chainPgpTrust.ts). Absent for a read that did not come from the chain reader. */
			userPgpKeyID?: string
			source?: RecordSource
			/** The fingerprint of the key that encrypts (the encryption subkey): the record's userPgpKeyID is its key ID. Empty when it cannot be read. */
			encryptionFingerprint?: string
	  }
	| { ok: false; code: 'recipient_no_record' | 'network_error' | 'recipient_key_unavailable' | 'recipient_key_invalid' }

/**
 * Re-reads the recipient's key and route. `no_record` is `recipient_no_record`; `network_error`, an incomplete registration (a key without a
 * route or the reverse), and an undecodable answer are `network_error`. An armor that is not a readable OpenPGP key is
 * `recipient_key_invalid`.
 */
export async function refreshRecipient(chat: RecipientChat | null | undefined, fetchRoute: FetchRecipientRoute): Promise<RecipientRefresh> {
	const address = (chat?.address ?? '').trim()
	if (!address) return { ok: false, code: 'recipient_key_unavailable' }
	// no pinned value yet = a first contact: the chain id is asked fresh for this lookup (single RPC, one extra eth_chainId)
	const firstContact = !readStoredKeyFingerprint(chat?.chatData?.verifiedFingerprint)
	const lookup = await lookupOrNetworkError(address, fetchRoute, firstContact ? { freshChain: true } : undefined)
	if (lookup.status === 'no_record') return { ok: false, code: 'recipient_no_record' }
	if (lookup.status === 'network_error') return { ok: false, code: 'network_error' }
	if (lookup.status === 'internal_error') return { ok: false, code: 'recipient_key_unavailable' }
	const publicArmored = lookup.publicArmored.trim()
	const routersArmoreds = lookup.routersArmoreds.trim()
	if (!routersArmoreds) return { ok: false, code: 'network_error' }
	if (!isPgpPublicArmor(publicArmored)) return { ok: false, code: 'recipient_key_invalid' }
	let fingerprint: string
	try {
		fingerprint = await fingerprintOfArmor(publicArmored)
	} catch {
		return { ok: false, code: 'recipient_key_invalid' }
	}
	let encryptionFingerprint = ''
	try {
		encryptionFingerprint = await openPgpEncryptionKeyFingerprintOfArmor(publicArmored)
	} catch {
		encryptionFingerprint = ''
	}
	const oldPublic = (chat?.chatData?.publicArmored ?? '').trim()
	const oldRoute = (chat?.chatData?.routersArmoreds ?? '').trim()
	// The reference is the verified fingerprint when there is one (the trust anchor), otherwise the last fetched one. Only values in the OpenPGP scheme
	// are read; an unlabelled value (an earlier build) is no reference .
	const previous = readStoredKeyFingerprint(chat?.chatData?.verifiedFingerprint) ?? readStoredKeyFingerprint(chat?.chatData?.keyFingerprint)
	return {
		ok: true,
		changed: publicArmored !== oldPublic || routersArmoreds !== oldRoute,
		publicArmored,
		routersArmoreds,
		routePgpKeyID: lookup.routePgpKeyID,
		fingerprint,
		fingerprintChanged: !!previous && previous !== fingerprint,
		userPgpKeyID: lookup.userPgpKeyID,
		source: lookup.source,
		encryptionFingerprint,
	}
}

/** The result of a send. `route_unconfirmed`: the route could not be read (held, retried). `fingerprint_changed` and `first_fetch_pending`: held, with the key that was read (`held`). */
export type RouteSendResult =
	| { ok: true; viaUnconfirmedRoute: boolean }
	| { ok: false; code: 'route_unconfirmed' | 'fingerprint_changed' | 'first_fetch_pending' | 'send_failed' | RecipientKeyFailure; held?: HeldKey }

/** The trust decision for one send to a contact, without the send: a route to use, or the held code and the key that was read. */
export type TrustedRoute =
	| {
			ok: true
			publicArmored: string
			routersArmoreds: string
			routePgpKeyID?: string
			fingerprint: string
			refreshed: Extract<RecipientRefresh, { ok: true }>
			/** true: no verified value existed and the chain record carried the key (chainPgpTrust.ts): this fingerprint is to be recorded as the first pinned value after the send. */
			firstPin?: boolean
	  }
	| { ok: false; code: 'route_unconfirmed' | 'fingerprint_changed' | 'first_fetch_pending' | RecipientKeyFailure; held?: HeldKey }

/**
 * Reads the contact's key and route now, and decides whether a send may use it. A network error is `route_unconfirmed`; a key the user
 * has not verified is `first_fetch_pending`; a key other than the verified one is `fingerprint_changed`. Both holds carry the key that was read.
 */
export async function resolveTrustedRoute(chat: RecipientChat | null | undefined, fetchKeys: FetchRecipientRoute): Promise<TrustedRoute> {
	const fresh = await refreshRecipient(chat, fetchKeys)
	return decideTrustedRoute(chat, fresh)
}

/**
 * records the first pinned fingerprint for a contact whose key was allowed by the chain-trust rule (route.firstPin). The recorder is installed by the page
 * (chat.ts) and writes only for a contact that already has a row; it never throws into the caller. Text sends pin through sendWithFreshRoute's onFirstPinned instead.
 */
export type FirstPinned = { publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; fingerprint: string }
let firstPinRecorder: ((address: string, pinned: FirstPinned) => void) | null = null
export function setFirstPinRecorder(fn: ((address: string, pinned: FirstPinned) => void) | null): void {
	firstPinRecorder = fn
}
export function recordFirstPinFor(address: string | undefined, route: { firstPin?: boolean; publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; fingerprint: string }): void {
	const a = String(address ?? '').trim()
	if (!a || route.firstPin !== true || !firstPinRecorder) return
	try {
		firstPinRecorder(a, { publicArmored: route.publicArmored, routersArmoreds: route.routersArmoreds, routePgpKeyID: route.routePgpKeyID, fingerprint: route.fingerprint })
	} catch {
		// recording a pin never changes the decision
	}
}

/** Observer of every trust decision made from a fresh read (the shell's native receipt route table follows it). */
let trustDecisionObserver: ((address: string, decision: TrustedRoute) => void) | null = null
export function setTrustDecisionObserver(fn: ((address: string, decision: TrustedRoute) => void) | null): void {
	trustDecisionObserver = fn
}

/**
 * The trust decision for a fresh read of a contact's key: the same rule for a send and for the receipt route (verified fingerprint present and equal
 * to the key just read; otherwise held). The observer, if set, sees every decision.
 */
export function decideTrustedRoute(chat: RecipientChat | null | undefined, fresh: RecipientRefresh): TrustedRoute {
	const decision = ((): TrustedRoute => {
		if (!fresh.ok) return { ok: false, code: fresh.code === 'network_error' ? 'route_unconfirmed' : fresh.code }
		const held: HeldKey = {
			publicArmored: fresh.publicArmored,
			routersArmoreds: fresh.routersArmoreds,
			routePgpKeyID: fresh.routePgpKeyID,
			fingerprint: fresh.fingerprint,
		}
		const verified = readStoredKeyFingerprint(chat?.chatData?.verifiedFingerprint)
		if (!verified) {
			// the product rule: a first contact whose key comes from the whitelisted AddressPGP contract, for this contact's address, with the
			// fingerprint of the key in use equal to the record's, is trusted (no notice). Anything else is held as before.
			const chain = chainRecordTrust({ contactAddress: chat?.address, source: fresh.source, userPgpKeyID: fresh.userPgpKeyID, fingerprint: fresh.fingerprint, encryptionFingerprint: fresh.encryptionFingerprint })
			if (!chain.trusted) return { ok: false, code: 'first_fetch_pending', held }
			return {
				ok: true,
				publicArmored: fresh.publicArmored,
				routersArmoreds: fresh.routersArmoreds,
				routePgpKeyID: fresh.routePgpKeyID,
				fingerprint: fresh.fingerprint,
				refreshed: fresh,
				firstPin: true,
			}
		}
		if (fresh.fingerprint !== verified) return { ok: false, code: 'fingerprint_changed', held }
		return {
			ok: true,
			publicArmored: fresh.publicArmored,
			routersArmoreds: fresh.routersArmoreds,
			routePgpKeyID: fresh.routePgpKeyID,
			fingerprint: fresh.fingerprint,
			refreshed: fresh,
		}
	})()
	const address = String(chat?.address ?? '').trim()
	if (address && trustDecisionObserver) {
		try {
			trustDecisionObserver(address, decision)
		} catch {
			// an observer never changes a decision
		}
	}
	return decision
}

/**
 * A send that fetches the recipient's key and route first (every send). A network error holds the send (`route_unconfirmed`); a valid
 * empty record is `recipient_no_record` and is not held; a key that is not the verified one is held with the key that was read.
 */
export async function sendWithFreshRoute<TNodes>(
	chat: RecipientChat | null | undefined,
	text: string,
	privateKeyArmor: string,
	nodes: TNodes,
	deps: {
		fetchKeys: FetchRecipientRoute
		send: (pgpPublic: string, text: string, privateKeyArmor: string, nodes: TNodes) => Promise<boolean>
		onRefreshed?: (refreshed: Extract<RecipientRefresh, { ok: true }>) => void
		/** Called after a delivered send whose key was trusted from the chain with no verified value yet: record `fingerprint` as the first pinned value. */
		onFirstPinned?: (pinned: { publicArmored: string; routersArmoreds: string; routePgpKeyID?: string; fingerprint: string }) => void
	},
): Promise<RouteSendResult> {
	const route = await resolveTrustedRoute(chat, deps.fetchKeys)
	if (!route.ok) return { ok: false, code: route.code, held: route.held }
	deps.onRefreshed?.(route.refreshed)
	if (await deps.send(route.publicArmored, text, privateKeyArmor, nodes)) {
		// the key that was used for encryption is the one recorded (route.publicArmored and route.fingerprint come from the same read)
		if (route.firstPin) {
			try {
				deps.onFirstPinned?.({ publicArmored: route.publicArmored, routersArmoreds: route.routersArmoreds, routePgpKeyID: route.routePgpKeyID, fingerprint: route.fingerprint })
			} catch {
				// recording the pin never changes the result of a delivered send
			}
		}
		return { ok: true, viaUnconfirmedRoute: false }
	}
	return { ok: false, code: 'send_failed' }
}

/**
 * The user's verification or acceptance of a held key: the key the user saw on screen is sent and written as the
 * verified one. No fetch is made here: a different key now is not what the user compared.
 */
export async function sendWithPinnedRoute<TNodes>(
	text: string,
	privateKeyArmor: string,
	nodes: TNodes,
	deps: {
		pinned: HeldKey
		send: (pgpPublic: string, text: string, privateKeyArmor: string, nodes: TNodes) => Promise<boolean>
		onAccepted: (pinned: HeldKey) => void
	},
): Promise<RouteSendResult> {
	deps.onAccepted(deps.pinned)
	if (await deps.send(deps.pinned.publicArmored, text, privateKeyArmor, nodes)) return { ok: true, viaUnconfirmedRoute: false }
	return { ok: false, code: 'send_failed' }
}

/** The copy-free code of a held or refused send, for a screen that does not send. */
export function isHeldRouteCode(code: string | undefined): boolean {
	return code === 'route_unconfirmed' || code === 'fingerprint_changed' || code === 'first_fetch_pending'
}

/**
 * The user's explicit choice "send anyway": the cached key and route of the chat copy are used, marked as sent via an unconfirmed route.
 * No fetch is made here. The cached key is held to the same trust rule.
 */
export async function sendViaCachedRoute<TNodes>(
	chat: RecipientChat | null | undefined,
	text: string,
	privateKeyArmor: string,
	nodes: TNodes,
	deps: { send: (pgpPublic: string, text: string, privateKeyArmor: string, nodes: TNodes) => Promise<boolean> },
): Promise<RouteSendResult> {
	const cached = chat?.chatData?.publicArmored
	if (!isPgpPublicArmor(cached)) return { ok: false, code: 'recipient_key_unavailable' }
	let fingerprint: string
	try {
		fingerprint = await fingerprintOfArmor(cached.trim())
	} catch {
		return { ok: false, code: 'recipient_key_invalid' }
	}
	const held: HeldKey = {
		publicArmored: cached.trim(),
		routersArmoreds: (chat?.chatData?.routersArmoreds ?? '').trim(),
		fingerprint,
	}
	const verified = readStoredKeyFingerprint(chat?.chatData?.verifiedFingerprint)
	if (!verified) return { ok: false, code: 'first_fetch_pending', held }
	if (fingerprint !== verified) return { ok: false, code: 'fingerprint_changed', held }
	if (await deps.send(cached.trim(), text, privateKeyArmor, nodes)) return { ok: true, viaUnconfirmedRoute: true }
	return { ok: false, code: 'send_failed' }
}

/** A refusal of a send from a screen other than the chat page: the three held codes, or a failed key read. */
export type RecipientSendRefusal = RecipientKeyFailure | 'route_unconfirmed' | 'fingerprint_changed' | 'first_fetch_pending'

export type RecipientForSend =
	| { ok: true; publicArmored: string; routersArmoreds: string }
	| { ok: false; code: RecipientSendRefusal }

/**
 * The key for a send from a screen other than the chat page: the same trust rule as a chat send, so a contact the user has
 * not verified is refused (`first_fetch_pending`) and the screen does not send.
 */
export async function resolveRecipientForSend(chat: RecipientChat | null | undefined, fetchRoute: FetchRecipientRoute): Promise<RecipientForSend> {
	const route = await resolveTrustedRoute(chat, fetchRoute)
	if (!route.ok) return { ok: false, code: route.code }
	// a screen other than the chat text send (payment, group, gift, receipt, call) uses the key the chain-trusted rule allowed: the first pinned value is recorded
	// here too, so a later key change on this contact is fingerprint_changed on every path, not only after a text send.
	recordFirstPinFor(chat?.address, route)
	return { ok: true, publicArmored: route.publicArmored, routersArmoreds: route.routersArmoreds }
}
