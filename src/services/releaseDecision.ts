/**
 * May the answer of a POST release its queue item? Only on one of the two proofs for THIS sendId, whichever is there first (sendReceiptPolicy.ts): a bound receipt in the answer, or the recipient's verified
 * delivery receipt from THIS contact (heard by this page, or stored on disk). The status of a row in the list is not a proof and is not asked.
 */
import { decideReceipt, type ReceiptDecision } from './sendReceiptPolicy'
import { hasDeliveryReceipt } from './deliveryReceiptBus'
import type { SendReceipt } from './sendAnswer'

export async function releaseDecisionOf(input: { sendId: string | undefined; peer: string; receipt: SendReceipt | null; evidence: { has(peer: string, sendId: string): Promise<boolean> } | null }): Promise<ReceiptDecision> {
	const peer = input.peer.trim().toLowerCase()
	if (input.sendId && peer) {
		if (hasDeliveryReceipt(input.sendId, peer)) return 'confirmed'
		if ((await input.evidence?.has(peer, input.sendId).catch(() => false)) === true) return 'confirmed'
	}
	return decideReceipt(input.receipt)
}
