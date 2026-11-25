/**
 * 0.53.51: the decision to resume an onboarding create that was interrupted (R2271-DEF-CREATE-RESUME-1, design r1..r4).
 *
 * After a restart the device already holds the native key, so the entry gate goes straight to the home and never reaches the create page.
 * `resumeCreateCheck(eoa)` decides, for the wallet the gate just identified, whether the user must be sent back to the create page with the
 * tag locked. It sends the user back ONLY when all of these hold: this device has a pending record for the wallet, and the registry
 * says "unregistered" on TWO different hosts with the right chain id (condition A), and, when step 3 may have been sent, the minimum wait
 * has passed (condition B = B1 AND B2). Any failed, slow, mixed or odd answer is "uncertain": nothing is routed, nothing is cleared.
 *
 * This file is plain logic with injected reads and clocks so every branch is testable. It never logs a tag or an address.
 */
import { clearPendingCreateTag, readPendingCreateRecord } from './pendingCreateTag'
import type { RegistrationState } from './beamio'

/** B1 without `a` (step 3 may have been sent, no 2xx seen): wall-clock minutes since `s`. Named so it can be raised from the server data. */
export const RESUME_B1_NO_ACK_MS = 5 * 60_000
/** B1 with `a` (the server answered 2xx; the chain may lag behind a queue): wall-clock minutes since `a`. */
export const RESUME_B1_WITH_ACK_MS = 30 * 60_000
/** B2: two "unregistered" reads in this process, this far apart on the monotonic clock. */
export const RESUME_B2_READ_GAP_MS = 2 * 60_000
/** The whole check never holds the entry longer than this. */
export const RESUME_CHECK_TIMEOUT_MS = 8_000
const RECHECK_MIN_MS = 30_000
const RECHECK_MAX_MS = 5 * 60_000

export type ResumeVerdict =
	| { kind: 'none' }
	| { kind: 'resume'; tag: string }
	| { kind: 'registered' }
	| { kind: 'uncertain'; why: string; recheckInMs: number }

export type ResumeDeps = {
	/** wall clock, ms */
	now: () => number
	/** monotonic clock, ms (performance.now): not moved by a clock change; may stand still while the device sleeps (that only makes the wait longer) */
	mono: () => number
	/** one host's registration state of (tag, wallet) */
	read: (rpcUrl: string, tag: string, eoa: string) => Promise<RegistrationState>
	primaryUrl: string
	secondaryUrl: string
	timeoutMs?: number
}

/** the "unregistered" reads of this process, per wallet (monotonic times); reset by anything that is not a consistent "unregistered" */
const unregisteredReads = new Map<string, number[]>()

export function resetResumeCreateForTest(): void {
	unregisteredReads.clear()
	firedFor.clear()
	queued = null
}

/** A synchronous local read: is there a pending record for this wallet at all? (the only thing the gate does when there is none) */
export function hasPendingCreateRecord(eoa: string): boolean {
	return readPendingCreateRecord(eoa) !== null
}

const withTimeout = (p: Promise<RegistrationState>, ms: number): Promise<RegistrationState> =>
	new Promise((resolve) => {
		const t = setTimeout(() => resolve('unknown'), ms)
		p.then(
			(v) => {
				clearTimeout(t)
				resolve(v)
			},
			() => {
				clearTimeout(t)
				resolve('unknown')
			},
		)
	})

export async function resumeCreateCheck(eoaRaw: string, deps: ResumeDeps): Promise<ResumeVerdict> {
	const eoa = eoaRaw.trim().toLowerCase()
	const rec = readPendingCreateRecord(eoa)
	if (!rec) return { kind: 'none' }
	const ms = deps.timeoutMs ?? RESUME_CHECK_TIMEOUT_MS
	const [p, q] = await Promise.all([withTimeout(deps.read(deps.primaryUrl, rec.tag, eoa), ms), withTimeout(deps.read(deps.secondaryUrl, rec.tag, eoa), ms)])
	// positive evidence is enough on its own: the registry holds this account, so there is nothing to resume
	if (p === 'registered' || q === 'registered') {
		unregisteredReads.delete(eoa)
		clearPendingCreateRecordSafe(eoa)
		return { kind: 'registered' }
	}
	// condition A: both hosts say "unregistered"
	if (!(p === 'unregistered' && q === 'unregistered')) {
		unregisteredReads.delete(eoa)
		return { kind: 'uncertain', why: p === 'unknown' || q === 'unknown' ? 'read_failed' : 'hosts_differ', recheckInMs: RECHECK_MIN_MS * 2 }
	}
	// step 3 never sent (no `s`), or an older record (`s` unknown): condition A alone
	if (rec.legacy || rec.s === undefined) {
		unregisteredReads.delete(eoa)
		return { kind: 'resume', tag: rec.tag }
	}
	// condition B: B1 (wall clock) AND B2 (two reads in this process, apart on the monotonic clock)
	const now = deps.now()
	const base = rec.a ?? rec.s
	if (now < base) {
		unregisteredReads.delete(eoa)
		return { kind: 'uncertain', why: 'clock_went_back', recheckInMs: RECHECK_MAX_MS }
	}
	const reads = unregisteredReads.get(eoa) ?? []
	reads.push(deps.mono())
	if (reads.length > 10) reads.shift()
	unregisteredReads.set(eoa, reads)
	const b1Need = rec.a !== undefined ? RESUME_B1_WITH_ACK_MS : RESUME_B1_NO_ACK_MS
	const b1Left = b1Need - (now - base)
	const b2Left = reads.length >= 2 ? RESUME_B2_READ_GAP_MS - (reads[reads.length - 1] - reads[0]) : RESUME_B2_READ_GAP_MS
	if (b1Left <= 0 && b2Left <= 0) {
		unregisteredReads.delete(eoa)
		return { kind: 'resume', tag: rec.tag }
	}
	const wait = Math.max(b1Left, b2Left, RECHECK_MIN_MS)
	return { kind: 'uncertain', why: b1Left > 0 ? 'min_wait' : 'second_read_pending', recheckInMs: Math.min(wait, RECHECK_MAX_MS) }
}

function clearPendingCreateRecordSafe(eoa: string): void {
	try {
		clearPendingCreateTag(eoa)
	} catch {
		/* a failed clear leaves the record; the next check clears it */
	}
}

// ---- the resume route as an event: once per wallet per process, never while the user is busy ---------------------------------------------

/** wallets for which a resume route was already started in this process */
const firedFor = new Set<string>()
let queued: { eoa: string; tag: string } | null = null

/** Marks the wallet as routed in this process. Returns true when it was already marked (a repeat must be ignored). */
export function markResumeFired(eoa: string): boolean {
	const k = eoa.trim().toLowerCase()
	const was = firedFor.has(k)
	firedFor.add(k)
	return was
}

export type ResumeBusyProbe = () => boolean
const busyProbes = new Set<ResumeBusyProbe>()
/** A signal that the user is busy (a call, the settings, the passcode screen, a native flow, the create page itself). Returns the remover. */
export function registerResumeBusyProbe(probe: ResumeBusyProbe): () => void {
	busyProbes.add(probe)
	return () => {
		busyProbes.delete(probe)
	}
}
export const isIdleForResume = (): boolean => {
	for (const p of busyProbes) {
		try {
			if (p()) return false
		} catch {
			return false
		}
	}
	return true
}

/**
 * The later route (after the home is shown): `start` is called at most once per wallet per process, and only when idle; when busy the
 * request waits in a one-entry queue until `flushQueuedResume` is called on an idle signal. A request for a wallet already routed is dropped.
 */
export function requestResumeRoute(eoa: string, tag: string, start: (eoa: string, tag: string) => void): 'started' | 'queued' | 'dropped' {
	const k = eoa.trim().toLowerCase()
	if (firedFor.has(k)) return 'dropped'
	if (!isIdleForResume()) {
		queued = { eoa: k, tag }
		return 'queued'
	}
	firedFor.add(k)
	queued = null
	start(k, tag)
	return 'started'
}

/** Called on an idle signal (route change, call end, unlock, flow end, foreground, the visible poll). */
export function flushQueuedResume(start: (eoa: string, tag: string) => void): 'started' | 'idle' | 'busy' {
	if (!queued) return 'idle'
	if (firedFor.has(queued.eoa)) {
		queued = null
		return 'idle'
	}
	if (!isIdleForResume()) return 'busy'
	const q = queued
	queued = null
	firedFor.add(q.eoa)
	start(q.eoa, q.tag)
	return 'started'
}

export function hasQueuedResume(): boolean {
	return queued !== null
}
