/**
 * the four stores of the chat page's small documents (draft, queue, receipt, delivered) are created in ONE place and only when the key is right.
 *
 * A browser page whose key armor is not known yet (its first mount; the key state is set a render later and the page's effect then runs again) has only the keyless codec: base64 JSON. A draft, a queue item or a
 * receipt written then would be PLAINTEXT on disk and unreadable for ever by the keyed page (AES-GCM). So without a key a browser gets NO stores and writes NOTHING; the page runs again when the key is there.
 * A native shell has no page key by design and gets the keyless variant (base64 JSON, NOT encryption, as before).
 * Pure over the document adapter, so the rule is tested by counting the adapter's calls.
 */
import { createDraftStore, type DraftCodec, type DraftStore } from './chatDraftStore'
import { createDeliveredStore, type DeliveredStore } from './deliveredMarks'
import { createReceiptStore, type ReceiptStore } from './receiptEvidence'
import { createQueueStore, type QueueDocAdapter, type QueueStore } from './sendQueue'
import { docTaggerFor, mayUseChatDocs, queueCodecFor, type DocTagger } from './sendQueueCodec'

export interface ChatDocStores {
	codec: DraftCodec
	tags: DocTagger
	draftStore: DraftStore
	queueStore: QueueStore
	receiptStore: ReceiptStore
	deliveredStore: DeliveredStore
}

/** null when this is a browser without its key armor: nothing is created and nothing may be written */
export function createChatDocStores(input: { eoa: string; privateKey: string | undefined | null; nativeShell: boolean; doc: QueueDocAdapter }): ChatDocStores | null {
	const tags = docTaggerFor(input.privateKey, input.eoa)
	if (!mayUseChatDocs(tags, input.nativeShell)) return null
	const codec = queueCodecFor(input.privateKey)
	return {
		codec,
		tags,
		draftStore: createDraftStore({ eoa: input.eoa, doc: input.doc, codec }),
		queueStore: createQueueStore({ eoa: input.eoa, doc: input.doc, codec }),
		receiptStore: createReceiptStore({ eoa: input.eoa, doc: input.doc, codec, tags }),
		deliveredStore: createDeliveredStore({ eoa: input.eoa, doc: input.doc, codec, tags }),
	}
}
