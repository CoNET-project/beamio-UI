/**
 * The page's full read of the local decrypted corpus (a reviewed blocker).
 *
 * The bridge no longer reads the whole history after each load (that was the replay). A load delivers only the entries it
 * downloaded and decrypted, so the chats are rebuilt from the full corpus once, in these cases:
 * - the account and its signing key are present, and the worker client is ready (mount with a key, restore, re-import, or a new client);
 * - the key arrives later (a mount without a key does not lose the read: it is deferred until the key is there);
 * - the account changes (a re-import or a restore on the same device, with or without a page reload).
 *
 * rules:
 * - the read runs only while the active worker client is bound to the current account (historyClientBinding.ts). A client bound to
 *   another account (an old client that was not stopped) reads nothing; the read waits for a client that is bound to the account (a new
 *   client gives a new epoch, which triggers the sync again). Nothing is counted as done in that case.
 * - the account is the one the page uses for its owner (accountEoaFor), passed in by the App. It is compared in lower case.
 * - a failed read is retried at most CORPUS_READ_MAX_ATTEMPTS times per account and client. A profile update, or a key that comes and
 *   goes, does not start the attempts again: only a new account or a new client does.
 * - the seen set of merged entries is cleared (onReset) only when the account goes empty or changes. A key that is briefly missing
 *   for the same account does not clear it, so entries the user deleted in this session are not merged back.
 * - a result is applied only while the account is still the current one (isCurrent), and only if it was read for that account.
 *
 * The log line carries the reason and the number of entries only, never an address. SYNTHETIC values only.
 */
import type { HistoryEntry } from '@conet.project/chat-sdk'
import { canReadForAccount } from './historyClientBinding'

/** Delay before a retry after a failed read. Engineering default, not a project decision. */
export const CORPUS_READ_RETRY_MS = 2_000
/** Attempts per account and client, including the first. Engineering default, not a project decision. */
export const CORPUS_READ_MAX_ATTEMPTS = 3

export type CorpusReadReason = 'mount' | 'key_ready' | 'account_changed' | 'worker_ready'

export interface CorpusReadState {
	/** The account (accountEoaFor of the signing key). Empty when there is no account yet. */
	account: string
	/** True when the page holds the signing key for the account. */
	keyReady: boolean
	/** Counts the worker clients that have become ready. 0 means no client yet. */
	epoch: number
}

export interface CorpusReadDeps {
	/** Reads the full corpus. Resolves null when the read is not possible (a failure). Called only when the client is bound to the account. */
	read: () => Promise<HistoryEntry[] | null>
	/** Applies the entries for `account` to the page (the App's merge). */
	apply: (entries: HistoryEntry[], account: string) => void
	/** The account the active worker client is bound to (lower case), or null when there is no client. */
	boundAccount: () => string | null
	/** True while `account` is still the page's current account. A result for another account is not applied. Default: always true. */
	isCurrent?: (account: string) => boolean
	/** Clears the page's seen set of merged entries. Called when the account goes empty or changes. */
	onReset?: () => void
	/** Schedules a retry. Defaults to setTimeout. */
	schedule?: (fn: () => void, ms: number) => void
	/** A numbers-only log line. */
	log?: (line: string) => void
	/** Delay before a retry after a failed read. Default CORPUS_READ_RETRY_MS. */
	retryMs?: number
	/** Attempts per account and client, including the first. Default CORPUS_READ_MAX_ATTEMPTS. */
	maxAttempts?: number
}

export interface CorpusReadScheduler {
	/** Called whenever the account, the key presence, the worker epoch or the profile changes. Idempotent for the same state. */
	sync(state: CorpusReadState): void
	/** For tests and inspection. */
	state(): { doneFor: string | null; inFlight: string | null; attempts: number }
}

export function createCorpusReadScheduler(deps: CorpusReadDeps): CorpusReadScheduler {
	const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))
	const retryMs = deps.retryMs ?? CORPUS_READ_RETRY_MS
	const maxAttempts = deps.maxAttempts ?? CORPUS_READ_MAX_ATTEMPTS
	const log = deps.log ?? (() => undefined)
	const isCurrent = deps.isCurrent ?? (() => true)

	let last: CorpusReadState | null = null
	let doneFor: string | null = null
	let inFlight: string | null = null
	/** The key (account and client) the attempts count for. The attempts are not reset by a key that comes and goes. */
	let attemptKey: string | null = null
	let attempts = 0
	/** Bumped when the state no longer matches the read in flight, so a late result is dropped. */
	let gen = 0

	const reasonOf = (prev: CorpusReadState | null, next: CorpusReadState): CorpusReadReason => {
		if (!prev) return 'mount'
		if (!prev.keyReady) return 'key_ready'
		if (prev.account.toLowerCase() !== next.account) return 'account_changed'
		return 'worker_ready'
	}

	const run = (account: string, key: string, reason: CorpusReadReason): void => {
		const myGen = gen
		inFlight = key
		const failed = (): void => {
			if (myGen !== gen) return
			inFlight = null
			attempts += 1
			log(`[history] corpus read failed reason=${reason} attempt=${attempts}`)
			if (attempts < maxAttempts) {
				schedule(() => {
					if (myGen === gen && last) sync(last)
				}, retryMs)
			}
		}
		let pending: Promise<HistoryEntry[] | null>
		try {
			pending = deps.read()
		} catch {
			failed()
			return
		}
		pending.then((entries) => {
			if (myGen !== gen) return
			if (entries === null) {
				failed()
				return
			}
			inFlight = null
			doneFor = key
			attempts = 0
			log(`[history] corpus read reason=${reason} entries=${entries.length}`)
			if (!entries.length) return
			if (!isCurrent(account)) {
				log(`[history] corpus read dropped reason=${reason}: the account changed`)
				return
			}
			deps.apply(entries, account)
		}, failed)
	}

	const sync = (state: CorpusReadState): void => {
		const prev = last
		last = state
		const account = state.account.toLowerCase()
		if (!account) {
			if (prev?.account) deps.onReset?.()
			gen += 1
			doneFor = null
			inFlight = null
			attemptKey = null
			attempts = 0
			return
		}
		if (prev && prev.account.toLowerCase() !== account) deps.onReset?.()
		if (!state.keyReady || state.epoch <= 0) {
			// No key, or no client yet. A read in flight is dropped. A read already done for this account and client is kept: a key
			// that comes back for the same account and client does not repeat the full read. The attempts of this key are kept too.
			gen += 1
			inFlight = null
			return
		}
		const key = `${account}#${state.epoch}`
		if (key === doneFor || key === inFlight) return
		if (inFlight !== null && inFlight !== key) {
			// A read for another key is in flight: its result is dropped.
			gen += 1
			inFlight = null
		}
		if (key !== attemptKey) {
			attemptKey = key
			attempts = 0
		}
		// the attempts of this key are used up: a profile update does not start them again.
		if (attempts >= maxAttempts) return
		if (!canReadForAccount(deps.boundAccount(), account)) {
			// The active client is not bound to this account (an old client, or none yet). Nothing is read and nothing is counted as done;
			// the next worker epoch (a new client) syncs again.
			log(`[history] corpus read waits reason=${reasonOf(prev, state)}: the active client is not bound to the current account`)
			return
		}
		run(account, key, reasonOf(prev, state))
	}

	return {
		sync,
		state: () => ({ doneFor, inFlight, attempts }),
	}
}
