/**
 * Sending files and voice from a conversation (the page's only path for them; chat.tsx supplies its own pieces).
 *
 *  1. At the click, before anything is awaited, every job is CLAIMED and registered as in flight: a second click (or a second pass) finds nothing left to send, and the wallet counts them as unsent.
 *  2. Every job is accepted first, one after the other: queue document on disk, then the bubble (sendFlow.acceptQueuedWire). A job that is not accepted keeps its draft; its claim is released (it can be tried again) and it STAYS counted as unsent until it is accepted or its draft is removed.
 *  3. Only then are the accepted messages delivered, in order: account record, then the request.
 * The conversation is fixed at the click. If the page shows another conversation by the time a job would be accepted, the job is not accepted (its draft stays); a message accepted already is neither shown in
 * the other conversation nor delivered from it: its queue item stays and its own conversation brings it back.
 */
import { acceptQueuedWire, deliverQueuedWire } from './sendFlow'
import type { SendQueue, AttemptResult } from './sendQueue'
import { beginPending, endPending } from './pendingSends'

export interface MediaJob<M> {
	/** stable id of the draft job (file job id, or one id per recording) */
	jobId: string
	sendId: string
	createdAt: number
	wire: string
	message: M
	/** the caller counts this job itself, from before this call until its draft is gone (a recording: mediaDraftHolder.ts) */
	countedByCaller?: boolean
}

export interface MediaSendContext<M> {
	wallet: string
	peer: string
	queue: Pick<SendQueue, 'enqueue' | 'run'> | null
	/** does the page still show the conversation of the click */
	isCurrent: () => boolean
	/** shows the accepted message and releases its draft */
	show: (message: M, jobId: string) => void
	persist: (message: M) => Promise<unknown>
	onPersistFailed: (message: M) => void
	deliver: (message: M, wire: string) => Promise<AttemptResult>
}

/** jobs claimed by a running pass, per wallet (module level: it outlives the component that started the pass) */
const claimed = new Set<string>()
const claimKey = (wallet: string, jobId: string) => `${wallet.toLowerCase()}:${jobId}`
/** the in-flight token of a job that has not been accepted yet: one per job however often it is tried */
const waitingTokens = new Map<string, string>()
/** the draft of a job is gone (the user removed it): it is not unsent any more. An accepted job has no token here. */
export function releaseMediaJob(wallet: string, jobId: string): void {
	const key = claimKey(wallet, jobId)
	const token = waitingTokens.get(key)
	if (token === undefined || claimed.has(key)) return
	waitingTokens.delete(key)
	endPending(token)
}
export const isMediaJobClaimed = (wallet: string, jobId: string): boolean => claimed.has(claimKey(wallet, jobId))

export async function sendMediaJobs<M>(jobs: ReadonlyArray<MediaJob<M>>, ctx: MediaSendContext<M>): Promise<{ accepted: string[]; notAccepted: string[]; skipped: string[] }> {
	const skipped: string[] = []
	const mine: Array<{ job: MediaJob<M>; key: string }> = []
	// synchronous: no await before every job is claimed and counted
	for (const job of jobs) {
		const key = claimKey(ctx.wallet, job.jobId)
		if (claimed.has(key)) { skipped.push(job.jobId); continue }
		claimed.add(key)
		if (!job.countedByCaller && !waitingTokens.has(key)) waitingTokens.set(key, beginPending(ctx.wallet, 'media'))
		mine.push({ job, key })
	}
	const accepted: MediaJob<M>[] = []
	const notAccepted: string[] = []
	for (const { job, key } of mine) {
		let ok = false
		if (ctx.isCurrent()) ok = await acceptQueuedWire({ queue: ctx.queue, peer: ctx.peer, sendId: job.sendId, createdAt: job.createdAt, wire: job.wire })
		if (ok) {
			accepted.push(job)
			// the draft is released only now; the claim of an accepted job is kept (its draft is gone, it can never be sent under a second sendId)
			if (ctx.isCurrent()) ctx.show(job.message, job.jobId)
			// the queue item is what is counted from here on
			const token = waitingTokens.get(key)
			waitingTokens.delete(key)
			endPending(token)
		} else {
			notAccepted.push(job.jobId)
			claimed.delete(key)
		}
	}
	for (const job of accepted) {
		if (!ctx.isCurrent()) break
		await deliverQueuedWire({ queue: ctx.queue!, sendId: job.sendId, persist: () => ctx.persist(job.message), onPersistFailed: () => ctx.onPersistFailed(job.message), deliver: () => ctx.deliver(job.message, job.wire) })
	}
	return { accepted: accepted.map((j) => j.jobId), notAccepted, skipped }
}

/** one recording on its way: the identity and the sealed bytes are made ONCE and kept with the recording, so every retry is the same message (same sendId, same payload), never a new one */
export interface VoiceAttempt<E> {
	recording: object
	peer: string
	sendId: string
	createdAt: number
	sealed?: E
	fragmentHash?: string
}

export async function prepareVoiceAttempt<E>(holder: { current: VoiceAttempt<E> | null }, input: { recording: object; peer: string; newSendId: () => string; now: () => number; seal: () => Promise<E>; upload: (sealed: E) => Promise<string> }): Promise<VoiceAttempt<E> & { sealed: E; fragmentHash: string }> {
	const peer = input.peer.trim().toLowerCase()
	let attempt = holder.current
	if (!attempt || attempt.recording !== input.recording || attempt.peer !== peer) {
		attempt = { recording: input.recording, peer, sendId: input.newSendId(), createdAt: input.now() }
		holder.current = attempt
	}
	attempt.sealed ??= await input.seal()
	attempt.fragmentHash ??= await input.upload(attempt.sealed)
	return attempt as VoiceAttempt<E> & { sealed: E; fragmentHash: string }
}

/** what the conversation page has: its refs and its own writers. Everything the send does with them is decided HERE, so that it is tested as the page runs it. */
export interface ConversationPieces<M extends { id?: unknown }> {
	wallet: string
	/** the conversation of the click */
	peer: string
	queueRef: { current: Pick<SendQueue, 'enqueue' | 'run'> | null }
	/** the address the page shows now */
	shownPeer: () => string
	messagesRef: { current: M[] | undefined | null }
	/** puts the list on screen and on the conversation record in memory */
	applyMessages: (next: M[]) => void
	persistOutgoing: (messageId: string) => Promise<unknown>
	markSendPersistFailed: (messageId: string) => void
	deliverTextRef: { current: (messageId: string, wire: string, t0: number) => Promise<AttemptResult> }
	releaseDraft: (jobId: string) => void
}

/** the context of one click, fixed to the conversation and the queue of that moment */
export function conversationMediaContext<M extends { id?: unknown }>(page: ConversationPieces<M>): MediaSendContext<M> {
	const peer = page.peer.trim().toLowerCase()
	const queue = page.queueRef.current
	return {
		wallet: page.wallet,
		peer,
		queue,
		isCurrent: () => page.shownPeer().trim().toLowerCase() === peer && page.queueRef.current === queue,
		show: (message, jobId) => {
			page.applyMessages([...(page.messagesRef.current || []), message])
			page.releaseDraft(jobId)
		},
		persist: (message) => page.persistOutgoing(String(message.id)),
		onPersistFailed: (message) => page.markSendPersistFailed(String(message.id)),
		deliver: (message, wire) => page.deliverTextRef.current(String(message.id), wire, Date.now()),
	}
}

export const resetMediaClaimsForTest = (): void => { claimed.clear(); waitingTokens.clear() }
