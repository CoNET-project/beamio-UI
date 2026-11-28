/**
 * the sendId of a text send and the armor context of that sendId, in one small pure function (chat.tsx deliverTextInner and the held retry use it).
 * - the sendId comes from the message row; when the row is not found by its temp id (the list was rebuilt meanwhile) it comes from the wire, which carries it
 * - the armor context comes from the queue (`armorContext`), which reads the item's own document when it has no slot in memory
 * - it THROWS when the item's document cannot be read: the caller keeps the attempt pending (it must never send without the context: that would be a second ciphertext)
 * - no queue (no account / no key yet): no context, and the send is not persisted at all (a known gap: nothing can be reused without a queue)
 */
import { wireSendId } from './nativeSendProtocol'
import type { SendArmorContext } from './sendAnswer'

export interface ArmorQueueLike { armorContext(sendId: string): Promise<SendArmorContext | undefined> }

export async function armorContextFor(input: { rowSendId?: string | null; wire: string; queue: ArmorQueueLike | null | undefined }): Promise<{ sendId: string | null; ctx: SendArmorContext | undefined }> {
	const sendId = (input.rowSendId && String(input.rowSendId).trim()) || wireSendId(input.wire)
	if (!sendId || !input.queue) return { sendId: sendId || null, ctx: undefined }
	return { sendId, ctx: await input.queue.armorContext(sendId) }
}

let unreadableCount = 0
/** a counted, content-free log line for an attempt held back because the queue document could not be read */
export function noteArmorContextUnreadable(log: (line: string) => void = (l) => console.warn(l)): number {
	unreadableCount += 1
	log(`[send] armor_context_unreadable n=${unreadableCount}`)
	return unreadableCount
}
