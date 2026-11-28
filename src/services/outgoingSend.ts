/**
 * a chat message leaves the device only after its recoverable record is on disk, and every write holds the chat write lock until it has really committed
 * or failed.
 *
 * - createOutgoingPersister: the writes of outgoing messages (the `sending` record, then the sent / failed state) run one after the other; each one takes the write lock in the same turn
 *   as the caller's change of the message list and releases it when that write has committed or failed (finally: a failed write never leaves the lock held).
 * - awaitRecord: the answer to "is the record on disk?" for the send that is about to go out. A rejected write is `persist_failed`; it is never turned into success. The caller then sends nothing,
 *   keeps the message as failed (persist_failed) with Retry, and the lock is already released.
 * No timer, no network answer and no animation counts as written; only the commit does (beamio.commitForChat).
 */
import { beginChatWrite, noteMessageSaving, noteMessageSaved, noteRequestInFlight, noteRequestSettled } from './chatWriteLock'

export type RecordOutcome = 'recorded' | 'persist_failed'

export async function awaitRecord(record: Promise<void> | null | undefined): Promise<RecordOutcome> {
	try {
		await record
		return 'recorded'
	} catch {
		return 'persist_failed'
	}
}

/**
 * `write` performs one durable write and rejects when the record did not land. The returned function starts one write under the lock and resolves / rejects with it.
 * With a message id: until the first successful write of that message it counts as memory-only (chatWriteLock.noteMessageSaving), so a destructive reload stays held after a
 * failed write; a successful write releases that (noteMessageSaved) and the held reload runs once.
 */
export function createOutgoingPersister(write: () => Promise<void>): (messageId?: string) => Promise<void> {
	let tail: Promise<void> = Promise.resolve()
	return (messageId?: string) => {
		if (messageId) noteMessageSaving(messageId)
		const release = beginChatWrite()
		const run = tail
			.catch(() => undefined)
			.then(write)
			.then(() => {
				if (messageId) noteMessageSaved(messageId)
			})
			.finally(release)
		tail = run
		return run
	}
}

/**
 * The send sequence in one place (the first send and the retry use it): wait for the record, send nothing when it did not land.
 * `onPersistFailed` marks the message failed (persist_failed) so Retry shows. Returns what happened.
 */
export async function sendWithRecord(input: {
	record: Promise<void> | null | undefined
	deliver: () => Promise<void>
	onPersistFailed: () => void
	/** the message id; while its request is in flight a reload the app asks for is held (released in finally, success or failure) */
	inFlightId?: string
	/** the record has landed (called before the request goes out) */
	onRecorded?: () => void
}): Promise<'sent' | 'persist_failed'> {
	if ((await awaitRecord(input.record)) === 'persist_failed') {
		input.onPersistFailed()
		return 'persist_failed'
	}
	input.onRecorded?.()
	if (input.inFlightId) noteRequestInFlight(input.inFlightId)
	try {
		await input.deliver()
	} finally {
		if (input.inFlightId) noteRequestSettled(input.inFlightId)
	}
	return 'sent'
}

/** The retry of a failed message: back to `sending`, then the same sequence as a first send (record first; nothing is sent when it does not land). */
export async function retryWithRecord(input: {
	markSending: () => void
	persist: () => Promise<void>
	deliver: () => Promise<void>
	onPersistFailed: () => void
	inFlightId?: string
	onRecorded?: () => void
}): Promise<'sent' | 'persist_failed'> {
	input.markSending()
	return sendWithRecord({ record: input.persist(), deliver: input.deliver, onPersistFailed: input.onPersistFailed, inFlightId: input.inFlightId, onRecorded: input.onRecorded })
}
