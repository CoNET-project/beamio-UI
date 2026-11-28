/**
 * The unsent file and recording drafts of the conversations, held per wallet and conversation OUTSIDE every component. A conversation that is unmounted (or another one that is shown) changes nothing here:
 * whatever is still counted as unsent (pendingSends.ts) still has its content, and coming back to the conversation shows it and can send it again. Memory only: nothing here is written anywhere.
 *
 * The rule for a recording: it is counted from the send click until the message is ACCEPTED (queue item on disk) or the user discards it. A failed attempt keeps the recording, the count and the attempt
 * (same sendId, same sealed bytes). The rule for a file: chatMediaSend.ts counts it from the click; removing its draft is what ends the count of a job that was not accepted.
 */
import { prepareVoiceAttempt, releaseMediaJob, sendMediaJobs, type MediaJob, type MediaSendContext, type VoiceAttempt } from './chatMediaSend'
import { beginPending, endPending, onClearAllPendingSends } from './pendingSends'

export interface HeldVoice {
	recording: Blob
	durationMs: number
	sending: boolean
	/** the in-flight token, set from the first send click */
	token: string | null
}

interface VoiceSlot { view: HeldVoice; attempt: { current: VoiceAttempt<unknown> | null } }

const voices = new Map<string, VoiceSlot>()
const files = new Map<string, ReadonlyArray<{ id: string }>>()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()
const NO_FILES: never[] = []

const keyOf = (wallet: string, peer: string): string => `${wallet.trim().toLowerCase()}|${peer.trim().toLowerCase()}`
const changed = (): void => { for (const l of [...listeners]) { try { l() } catch { /* a listener decides nothing */ } } }
export function subscribeDrafts(listener: () => void): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

export const heldVoice = (wallet: string, peer: string): HeldVoice | null => voices.get(keyOf(wallet, peer))?.view ?? null

/** a finished recording. A recording that is already counted as unsent is never replaced: it is sent or discarded first. */
export function holdRecording(wallet: string, peer: string, input: { recording: Blob; durationMs: number }): boolean {
	const key = keyOf(wallet, peer)
	const old = voices.get(key)
	if (old && (old.view.sending || old.view.token)) return false
	voices.set(key, { view: { recording: input.recording, durationMs: input.durationMs, sending: false, token: null }, attempt: { current: null } })
	changed()
	return true
}

/** the user discards the recording. While it is being sent nothing happens: neither the recording nor its count goes. */
export function discardVoice(wallet: string, peer: string): boolean {
	const key = keyOf(wallet, peer)
	const slot = voices.get(key)
	if (!slot || slot.view.sending) return false
	voices.delete(key)
	endPending(slot.view.token)
	changed()
	return true
}

export type VoiceSendResult = { kind: 'accepted' } | { kind: 'not_saved' } | { kind: 'failed'; error: unknown } | { kind: 'skipped' }

export interface VoiceSendSteps<E, M> {
	newSendId: () => string
	now: () => number
	seal: (recording: Blob, durationMs: number) => Promise<E>
	upload: (sealed: E) => Promise<string>
	job: (attempt: { sendId: string; createdAt: number; sealed: E; fragmentHash: string }) => Omit<MediaJob<M>, 'countedByCaller'>
	/** asked at the click, before anything is awaited: the conversation of the click */
	context: () => MediaSendContext<M>
}

export async function sendHeldVoice<E, M>(wallet: string, peer: string, steps: VoiceSendSteps<E, M>): Promise<VoiceSendResult> {
	const key = keyOf(wallet, peer)
	const slot = voices.get(key)
	if (!slot || slot.view.sending) return { kind: 'skipped' }
	const set = (patch: Partial<HeldVoice>) => { slot.view = { ...slot.view, ...patch }; changed() }
	const context = steps.context()
	set({ sending: true, token: slot.view.token ?? beginPending(wallet, 'voice') })
	/** accepted: the message holds the recording from here on */
	const release = () => {
		if (voices.get(key) !== slot) return
		voices.delete(key)
		endPending(slot.view.token)
		changed()
	}
	try {
		const attempt = await prepareVoiceAttempt<E>(slot.attempt as { current: VoiceAttempt<E> | null }, {
			recording: slot.view.recording,
			peer: context.peer,
			newSendId: steps.newSendId,
			now: steps.now,
			seal: () => steps.seal(slot.view.recording, slot.view.durationMs),
			upload: steps.upload,
		})
		const outcome = await sendMediaJobs([{ ...steps.job(attempt), countedByCaller: true }], { ...context, show: (message, jobId) => { context.show(message, jobId); release() } })
		if (!outcome.accepted.length) return { kind: 'not_saved' }
		release()
		return { kind: 'accepted' }
	} catch (error) {
		return { kind: 'failed', error }
	} finally {
		if (voices.get(key) === slot) set({ sending: false })
	}
}

export const heldFiles = <J extends { id: string }>(wallet: string, peer: string): J[] => (files.get(keyOf(wallet, peer)) as J[] | undefined) ?? NO_FILES

/** the same shape as a state updater. A draft that leaves the list is gone: the count of a job that was not accepted ends with it (and only then). */
export function updateHeldFiles<J extends { id: string }>(wallet: string, peer: string, update: (previous: J[]) => J[]): void {
	const key = keyOf(wallet, peer)
	const previous = heldFiles<J>(wallet, peer)
	const next = update(previous)
	if (next === previous) return
	if (next.length) files.set(key, next)
	else files.delete(key)
	const kept = new Set(next.map((j) => j.id))
	for (const j of previous) if (!kept.has(j.id)) releaseMediaJob(wallet, j.id)
	changed()
}

/** the upload of a file draft can be stopped from any mount of its conversation */
export const holdUploadController = (jobId: string, controller: AbortController): void => { controllers.set(jobId, controller) }
export const abortUpload = (jobId: string): void => { controllers.get(jobId)?.abort(); controllers.delete(jobId) }
export const forgetUploadController = (jobId: string): void => { controllers.delete(jobId) }

/** only with the in-flight tokens, for the reload that follows the confirmed local reset */
const dropAll = (): void => {
	for (const c of controllers.values()) c.abort()
	controllers.clear()
	voices.clear()
	files.clear()
	changed()
}
onClearAllPendingSends(dropAll)
export const resetDraftHolderForTest = (): void => { voices.clear(); files.clear(); controllers.clear() }
