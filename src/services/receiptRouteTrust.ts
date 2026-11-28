/**
 * The trust rule of the native receipt route, as one piece of logic with its dependencies injected (chat.ts wires the real ones):
 * - the stored verified fingerprint is read from the page's stored copy (the page IndexedDB, the same source the send gate uses), never from the
 *   in-memory chat list, which a later write can overwrite without the fingerprint;
 * - a contact is OFFERED only when that stored fingerprint equals the key just read; it is REMOVED when a key was read and the stored fingerprint is missing or
 *   differs, and also when the chain definitively has no consistent valid key (no record, an invalid key); it is KEPT as it is (never newly offered)
 *   when no key could be read (network error, internal error), when the stored copy cannot be read, or when the contact has no row.
 * - an unverified contact is read once per gate window (never removed first, so a repeated offer cannot flap the route); the read's decision offers it only for a key
 *   trusted from the chain (chainPgpTrust.ts) and removes it for any other key.
 */
import { routeEligibility, readKeyOfDecision, type RouteEligibility } from './nativeRouteTable'
import type { OfferGate } from './routeOfferGate'

export type StoredTrust = { readable: boolean; hasRow: boolean; verified?: string }

export type TrustDecisionLike =
	| { ok: true; fingerprint?: string; publicArmored: string; routersArmoreds: string; firstPin?: boolean }
	| { ok: false; code: string; held?: { fingerprint?: string; publicArmored: string; routersArmoreds: string } }

export type RouteTrustDeps = {
	/** The row in the in-memory chat list (CoNET_Data): whether it exists and the fingerprint it holds. */
	memoryRow(address: string): { hasRow: boolean; verified?: string }
	/** The row in the page's STORED copy (page IndexedDB). `readable` false: the read failed (nothing can be concluded). */
	storedTrust(address: string): Promise<StoredTrust>
	apply(address: string, eligibility: RouteEligibility, route: { publicArmored: string; routersArmoreds: string } | undefined): 'offered' | 'removed' | 'unchanged'
	/** A fresh read of the contact's key and the trust decision (reaches observe() through the decision observer). */
	readKey(address: string): Promise<void>
	gate: OfferGate
	log?: (line: string) => void
}

/** Codes of a decision that mean the chain definitively has no consistent valid key for the contact. */
const DEFINITIVE_NO_KEY = new Set(['recipient_no_record', 'recipient_key_invalid'])

// QA lines only exist in a build with the QA flag (a build-time constant, so the text is folded out of every other build)
const QA_LOG = process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true'

export function createReceiptRouteTrust(deps: RouteTrustDeps) {
	return {
		/** One trust decision from a fresh read of a contact (any call site): offer, remove or keep. */
		async observe(address: string, decision: TrustDecisionLike, src: 'observer' | 'offer' = 'observer'): Promise<void> {
			const key = readKeyOfDecision(decision as never)
			const code = decision.ok ? 'ok' : decision.code
			const definitive = !decision.ok && DEFINITIVE_NO_KEY.has(decision.code)
			if (!key?.fingerprint && !definitive) {
				if (QA_LOG) deps.log?.(`route decision src=${src} code=${code} elig=keep`)
				return
			}
			const mem = deps.memoryRow(address)
			const stored = await deps.storedTrust(address).catch((): StoredTrust => ({ readable: false, hasRow: false }))
			const eligibility = routeEligibility({
				rowKnown: mem.hasRow || stored.hasRow,
				storedVerified: stored.verified,
				storedReadable: stored.readable,
				freshFingerprint: key?.fingerprint,
				definitiveNoKey: definitive,
				chainTrusted: decision.ok && decision.firstPin === true,
			})
			const did = deps.apply(address, eligibility, key)
			if (QA_LOG) deps.log?.(`route decision src=${src} code=${code} elig=${eligibility} row=${mem.hasRow ? 1 : 0}${stored.hasRow ? 1 : 0} mv=${mem.verified ? 1 : 0} sv=${stored.verified ? 1 : 0} rd=${stored.readable ? 1 : 0} fp=${key?.fingerprint ? 1 : 0} did=${did} a=${address.slice(0, 8).toLowerCase()}`)
		},
		/**
		 * Reads a known contact's key and applies the rule. A contact the STORED copy shows as unverified is judged without any network read (removed if it
		 * had been offered); a stored copy that cannot be read changes nothing. Reads are joined per contact and spaced out; `force` (the user just verified)
		 * reads again at once.
		 */
		async offer(address: string, opts?: { force?: boolean }): Promise<void> {
			const mem = deps.memoryRow(address)
			const stored = await deps.storedTrust(address).catch((): StoredTrust => ({ readable: false, hasRow: false }))
			if (!mem.hasRow && !stored.hasRow) return
			if (!stored.readable) {
				if (QA_LOG) deps.log?.('route offer src=offer elig=keep rd=0')
				return
			}
			// no immediate 'remove' for a contact whose stored copy has no verified value. The read decides (observe: a chain-trusted key is offered,
			// any other key removes it, a failed read keeps what was there). While the offer gate skips the read (it spaces reads of one contact by 3 minutes), the
			// previous judgement stays: a route is not removed before the new read answers
			// (true, false, true) for a chain-trusted contact that only receives.
			if (!stored.verified && QA_LOG) deps.log?.(`route offer src=offer_nosv elig=read row=${mem.hasRow ? 1 : 0}${stored.hasRow ? 1 : 0} a=${address.slice(0, 8).toLowerCase()}`)
			await deps.gate.run(address, () => deps.readKey(address), opts?.force === true)
		},
	}
}

const storedTrustInvalidators = new Set<() => void>()
/** Drops every stored-record cache (account change, identity cleared): the next decision reads the stored record again. */
export function invalidateStoredTrust(): void {
	for (const f of storedTrustInvalidators) f()
}

type StoredProfiles = unknown[] | null | undefined
type StoredProfile = { chats?: Array<{ address?: string; chatData?: { verifiedFingerprint?: string } }> }

/**
 * The reader of the page's stored copy for the trust rule. One read of the stored record (which can be several MB and is decrypted on every read) serves
 * every address for `ttlMs`; reads that start while one is running join it. A failed read is never cached (the next call tries again). `invalidate()`
 * drops the cache (call it right after the user's verification is saved, so the next decision sees it).
 * `readable` is false when the record cannot be read (null): nothing can be concluded from it.
 */
export function createStoredTrustReader(
	readProfiles: () => Promise<StoredProfiles>,
	opts: { now: () => number; ttlMs: number; readFingerprint: (raw: string | null | undefined) => string | undefined },
) {
	let inflight: Promise<StoredProfiles> | null = null
	let cached: { at: number; profiles: NonNullable<StoredProfiles> } | null = null
	// every invalidation starts a new generation: a read that started in an older one is neither joined nor cached
	let generation = 0
	const load = async (): Promise<StoredProfiles> => {
		if (cached && opts.now() - cached.at < opts.ttlMs) return cached.profiles
		if (!inflight) {
			const mine = generation
			const run: Promise<StoredProfiles> = readProfiles()
				.then((p) => {
					if (p && mine === generation) cached = { at: opts.now(), profiles: p }
					return p
				})
				.finally(() => {
					if (inflight === run) inflight = null
				})
			inflight = run
		}
		return inflight
	}
	const invalidate = (): void => {
		generation += 1
		cached = null
		inflight = null
	}
	storedTrustInvalidators.add(invalidate)
	return {
		invalidate,
		async read(address: string): Promise<StoredTrust> {
			const profiles = await load()
			if (!profiles) return { readable: false, hasRow: false }
			const a = String(address ?? '').trim().toLowerCase()
			const row = ((profiles[0] as StoredProfile | undefined)?.chats ?? []).find((c) => String(c?.address ?? '').toLowerCase() === a)
			return { readable: true, hasRow: !!row, verified: opts.readFingerprint(row?.chatData?.verifiedFingerprint) }
		},
	}
}
