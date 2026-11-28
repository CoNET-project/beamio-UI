/**
 * what an entry answer lets the send queue do with an item. There is NO switch that relaxes this: the only way out of the queue is a positive proof for the SAME sendId.
 *
 * An HTTP 200 with an EMPTY body does not say whether the message was stored, so it never lets an item leave the queue by itself:
 *   - bound receipt `{"ok":true,"stored":true|"duplicate":true,"h":"0x<keccak256 of the inner armor>"}`, one of the two exactly the boolean true -> confirmed.
 *     Whichever of the two proofs arrives first and passes its checks releases THIS item; the other one arriving later is a harmless repeat. Reading is never waited for.
 *   - the recipient's delivery receipt for this sendId (beamio_chat_delivery_receipt_v1; the message turns "delivered") -> confirmed (chat.tsx resume)
 *   - an empty 200 (or no classification, e.g. the shells' native sender) -> awaiting: the item stays, shown as "awaiting confirmation"; the stored
 *     armor is posted again with back-off (the mailbox keeps identical armor once) until one of the two proofs arrives
 *   - read failure, ok:false, another digest, a body that is not ours -> a failed attempt (sendAnswer.ts), retried
 */
import type { SendReceipt } from './sendAnswer'

export type ReceiptDecision = 'confirmed' | 'awaiting'

export function decideReceipt(receipt: SendReceipt | null): ReceiptDecision {
	return receipt && receipt.kind === 'bound' ? 'confirmed' : 'awaiting'
}
