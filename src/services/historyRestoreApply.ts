/**
 * The history restore that rebuilds the page's chats from decrypted entries (the rebuild needs a runtime test).
 *
 * The App used to hold this logic in its closure, so it could not be run. The two steps are now plain functions:
 * - planRestoreBatch: keeps the entries not merged yet (the seen set), groups them by peer, creates the missing chat stubs (the App
 *   passes the stub creator, which needs the signing key), and records the mergeable entries as merged;
 * - mergeRestoreIntoProfile: merges the planned entries into a profile (chats, messages, phone calls). It is the body of the App's
 *   setProfiles update, and it is pure: the App keeps the state write, the storage write and the logs.
 *
 * Behaviour is the same as the former closure. An empty owner (the account is unknown) skips nothing and marks nothing.
 * SYNTHETIC values only.
 */
import type { HistoryEntry } from '@conet.project/chat-sdk'
import { ethers } from 'ethers'
import { markHistoryEntriesSeen, unseenHistoryEntries } from './historyRestoreSeen'
import { mergeHistoryEntriesIntoMessages } from './chatHistoryMirror'
import { mergePhoneCallRecord, sameCallId } from '../utils/voiceCallSession'
import { qaNoteCopy, qaSendIdOfEntry } from '../utils/qaCopySource'

export interface RestorePlan {
	/** The account the entries were checked for (lower case). */
	owner: string
	/** The entries not merged yet, in their order. */
	fresh: HistoryEntry[]
	/** The fresh entries of each peer (lower-case address). */
	byPeer: Map<string, HistoryEntry[]>
	/** The chat stubs created for peers the profile did not have yet. */
	created: Map<string, chatData>
	/** The entries to record as merged, once the plan is committed: the fresh entries of the peers that have a chat. */
	markable: HistoryEntry[]
}

export interface PlanRestoreInput {
	entries: HistoryEntry[]
	/** The account (lower case). Empty means unknown: nothing is skipped and nothing is marked. */
	owner: string
	/** The seen set of merged entries (historyRestoreSeen.ts). Updated for the entries that were merged. */
	seen: Set<string>
	/** The peers that already have a chat in the profile now (lower case). */
	existingPeers: ReadonlySet<string>
	/** Creates the chat for a peer that has none. A rejection skips that peer. */
	createStub: (peer: string) => Promise<chatData>
	isCancelled: () => boolean
	yieldToUi?: () => Promise<void>
	/** Called once the batch is grouped, before any stub is created (for the App's log). */
	onBatch?: (peers: number, entries: number) => void
	/** Stubs created before a yield to the UI. */
	yieldEvery?: number
}

export interface RestoreLog {
	level: 'info' | 'warn'
	message: string
}

export interface MergeRestoreResult {
	/** The profile after the merge (the same object when nothing changed). */
	profile: profile | undefined
	changed: boolean
	logs: RestoreLog[]
}

/**
 * Plans one batch. Returns null when there is nothing to do (no fresh entry, no valid peer, or the run was cancelled). Nothing is marked
 * here: the entries of a peer that has a chat (existing or created) are recorded as merged only when the plan is committed
 * (commitRestorePlan), so a plan that is dropped or not committed leaves nothing marked.
 */
export async function planRestoreBatch(input: PlanRestoreInput): Promise<RestorePlan | null> {
	const owner = (input.owner || '').toLowerCase()
	const fresh = unseenHistoryEntries(owner, input.seen, input.entries)
	if (fresh.length === 0) return null

	const byPeer = new Map<string, HistoryEntry[]>()
	for (const e of fresh) {
		const p = (e?.peer || '').toLowerCase()
		if (!p || p === 'all' || !ethers.isAddress(p)) continue
		const arr = byPeer.get(p) || []
		arr.push(e)
		byPeer.set(p, arr)
	}
	if (byPeer.size === 0) return null
	input.onBatch?.(byPeer.size, fresh.length)

	const created = new Map<string, chatData>()
	const yieldEvery = input.yieldEvery ?? 3
	let peerIdx = 0
	for (const peer of byPeer.keys()) {
		if (input.isCancelled()) return null
		if (input.existingPeers.has(peer)) continue
		try {
			created.set(peer, await input.createStub(peer))
		} catch {
			// The App logs the failure of the stub; the peer's entries are not merged in this batch.
		}
		peerIdx += 1
		if (input.yieldToUi && peerIdx % yieldEvery === 0) await input.yieldToUi()
	}
	if (input.isCancelled()) return null

	// The peers whose chat is in the profile now (existing or just created) take their entries; these are recorded as merged on commit.
	const mergeable = new Set(
		[...byPeer.keys()].filter((peer) => created.has(peer) || input.existingPeers.has(peer)),
	)
	const markable = fresh.filter((e) => mergeable.has((e.peer || '').toLowerCase()))
	return { owner, fresh, byPeer, created, markable }
}

/** Records the plan's mergeable entries as merged. Called only by commitRestorePlan, after the account check. */
export const markRestorePlanSeen = (plan: RestorePlan, seen: Set<string>): void => {
	markHistoryEntriesSeen(plan.owner, seen, plan.markable)
}

/**
 * The state update of a committed plan: the profile list and the account of the page now. Nothing is merged and nothing is marked
 * when the page's account is no longer the account of the plan (it changed after the batch was planned): the list comes back unchanged.
 */
export function commitRestorePlan(
	list: profile[],
	plan: RestorePlan,
	accountNow: string,
	seen: Set<string>,
): { list: profile[]; changed: boolean; logs: RestoreLog[] } {
	if (!list[0]) return { list, changed: false, logs: [] }
	if ((accountNow || '').toLowerCase() !== plan.owner) return { list, changed: false, logs: [] }
	markRestorePlanSeen(plan, seen)
	const result = mergeRestoreIntoProfile(list[0], plan)
	if (!result.changed || !result.profile) return { list, changed: false, logs: result.logs }
	const next = [...list]
	next[0] = result.profile
	return { list: next, changed: true, logs: result.logs }
}

/**
 * Merges the planned entries into a profile. A peer without a chat in the profile takes the stub the plan created; a peer whose chat
 * gains no message and has no new stub is left as it is. Phone-call records in the entries are merged into the call list.
 */
export function mergeRestoreIntoProfile(current: profile | undefined, plan: RestorePlan): MergeRestoreResult {
	const logs: RestoreLog[] = []
	if (!current) return { profile: current, changed: false, logs }

	let chats: chatData[] = Array.isArray(current.chats) ? [...current.chats] : []
	let phoneCalls: PhoneCallRecord[] = Array.isArray(current.phoneCalls) ? [...current.phoneCalls] : []
	let localChanged = false
	for (const [peer, es] of plan.byPeer) {
		let idx = chats.findIndex((c) => (c?.address || '').toLowerCase() === peer)
		let sessionCreated = false
		if (idx < 0) {
			const stub = plan.created.get(peer)
			if (!stub) continue
			chats.unshift(stub)
			idx = 0
			sessionCreated = true
			localChanged = true
		}
		const beforeCount = Array.isArray(chats[idx].messages) ? chats[idx].messages.length : 0
		const { messages, added } = mergeHistoryEntriesIntoMessages(chats[idx].messages, es)
		// hook variant only (G1-b, first-copy source): the messages this App-level restore ADDED to the page's chat are marked `app_history` (ids only, in memory; nothing is printed)
		if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && added > 0) {
			const had = new Set((Array.isArray(chats[idx].messages) ? chats[idx].messages : []).map((m) => m?.sendId).filter((x): x is string => typeof x === 'string'))
			qaNoteCopy('app_history', es.map(qaSendIdOfEntry).filter((x): x is string => !!x && !had.has(x)))
		}
		for (const entry of es) {
			try {
				const callRecord = (JSON.parse(entry.body) as ChatMessage)?.callRecord
				if (!callRecord?.callId) continue
				const old = phoneCalls.find((item) => sameCallId(item.callId, callRecord.callId) || sameCallId(item.sessionId, callRecord.sessionId))
				const nextCall = mergePhoneCallRecord(old, callRecord)
				if (!nextCall) continue
				if (
					old &&
					old.status === nextCall.status &&
					old.createdAt === nextCall.createdAt &&
					old.endedAt === nextCall.endedAt &&
					old.direction === nextCall.direction
				) continue
				phoneCalls = [
					...phoneCalls.filter((item) => !sameCallId(item.callId, nextCall.callId) && !sameCallId(item.sessionId, nextCall.sessionId)),
					nextCall,
				].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)
				localChanged = true
			} catch {
				// Non-call chat history entries are handled below.
			}
		}
		logs.push({
			level: added === es.length ? 'info' : 'warn',
			message: `[historyRestore] merge peer=${peer.slice(0, 10)}…${peer.slice(-8)} entries=${es.length} added=${added} before=${beforeCount} after=${messages.length}`,
		})
		if (added <= 0 && !sessionCreated) continue
		if (!sessionCreated) {
			chats = [...chats]
			localChanged = true
			idx = chats.findIndex((c) => (c?.address || '').toLowerCase() === peer)
			if (idx < 0) continue
		}
		const last = messages[messages.length - 1]
		chats[idx] = {
			...chats[idx],
			messages,
			// History restore is catch-up: do not inflate unread badges.
			unreadCount: 0,
			...(last?.createdAt != null ? { lastReadTs: Number(last.createdAt) } : {}),
		}
	}
	if (!localChanged) return { profile: current, changed: false, logs }
	return { profile: { ...current, chats, phoneCalls }, changed: true, logs }
}

export interface HistoryApplierDeps {
	/** The account of the page now (lower case), or '' when there is none. */
	accountNow: () => string
	/** The signing key of the profile now, or '' when there is none. */
	keyNow: () => string
	/** The account a signing key belongs to (accountEoaFor). */
	accountOfKey: (privateKeyArmor: string) => string
	/**
	 * Shell: the page holds no signing key, so the account of a batch is checked against the public EOA of the native identity (identityPublic).
	 * A batch whose account is not that EOA is dropped. When given, keyNow and accountOfKey are not used (no key exists on the page).
	 */
	shellAccountCheck?: (account: string) => boolean
	/** The seen set of merged entries (historyRestoreSeen.ts). */
	seen: Set<string>
	/** True once the page is gone (unmounted). */
	isCancelled: () => boolean
	/** The peers that have a chat in the profile now (lower case). Read when a batch runs, not when it is queued. */
	existingPeersNow: () => ReadonlySet<string>
	/** Creates the chat for a peer, with the key of the account the batch belongs to. */
	createStubFor: (privateKeyArmor: string, peer: string) => Promise<chatData>
	/** Merges the plan into the page state. The merge checks the account again. Returns a handle whose `changed` the state update sets. */
	commit: (plan: RestorePlan) => { changed: boolean }
	/** After the merge: the storage write and the peers' tag hydration. */
	afterCommit: (plan: RestorePlan, handle: { changed: boolean }) => Promise<void>
	yieldToUi?: () => Promise<void>
	onBatch?: (peers: number, entries: number) => void
	log?: (line: string) => void
}

/**
 * The queue of history batches (a reviewed blocker). A batch is queued for the account the page has WHEN IT IS QUEUED,
 * and it runs only while that account is still the page's account:
 * - when it is queued, its account is fixed (`enqueue`); a batch with no account is not queued;
 * - when it runs, before any plan, the account must be unchanged, and the key must belong to that account (accountOfKey === account);
 * - while it plans (stubs), it stops as soon as the account changes, so nothing is marked as merged for another account;
 * - the merge in the state update checks the account again (the App's commit).
 * A batch that fails does not stop the batches queued after it.
 */
export function createHistoryApplier(deps: HistoryApplierDeps): {
	enqueue: (entries: HistoryEntry[]) => void
	idle: () => Promise<void>
} {
	const log = deps.log ?? (() => undefined)
	let chain: Promise<void> = Promise.resolve()

	const enqueue = (entries: HistoryEntry[]): void => {
		if (!entries?.length) return
		const account = (deps.accountNow() || '').toLowerCase()
		if (!account) {
			log('[historyRestore] batch not queued: no account')
			return
		}
		if (unseenHistoryEntries(account, deps.seen, entries).length === 0) return

		chain = chain
			.then(async () => {
				const stale = (): boolean => deps.isCancelled() || (deps.accountNow() || '').toLowerCase() !== account
				if (stale()) {
					log('[historyRestore] batch dropped: the account changed before it ran')
					return
				}
				let pk = ''
				if (deps.shellAccountCheck) {
					// shell: no page key; the account must be the native identity's EOA
					if (!deps.shellAccountCheck(account)) {
						log('[historyRestore] batch dropped: the account is not the native identity of this shell')
						return
					}
				} else {
					pk = deps.keyNow()
					if (!pk) {
						log('[historyRestore] skip: no signing key yet')
						return
					}
					if ((deps.accountOfKey(pk) || '').toLowerCase() !== account) {
						log('[historyRestore] batch dropped: the signing key is not the key of the queued account')
						return
					}
				}
				const plan = await planRestoreBatch({
					entries,
					owner: account,
					seen: deps.seen,
					existingPeers: deps.existingPeersNow(),
					createStub: (peer) => deps.createStubFor(pk, peer),
					isCancelled: stale,
					yieldToUi: deps.yieldToUi,
					onBatch: deps.onBatch,
				})
				// planRestoreBatch checks `stale` before it marks anything, so a stale plan marks nothing.
				if (!plan) return
				if (stale()) {
					log('[historyRestore] batch dropped: the account changed while it planned')
					return
				}
				const handle = deps.commit(plan)
				await deps.afterCommit(plan, handle)
			})
			.catch((ex: unknown) => {
				log(`[historyRestore] batch failed: ${(ex as Error)?.message ?? String(ex)}`)
			})
	}

	return {
		enqueue,
		idle: () => chain,
	}
}
