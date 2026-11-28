/**
 * the recipient's delivery receipt (`beamio_chat_delivery_receipt_v1`, bound to a sendId) as an EVENT, the moment it arrives.
 *
 * App.tsx emits here first; the open conversation's queue settles the item at once (the message turns delivered, is written, then the item leaves). A receipt that arrives while the conversation
 * is not open is remembered for this page load, so the queue of that conversation finds it when it is opened. This bus is memory only; the durable evidence is receiptEvidence.ts.
 */
type Listener = (sendId: string, from: string) => void

/**
 * QA trace of the receipts (hook variant only; the switch is a compile-time constant, so a production build keeps none of it): what arrived, from whom (last 6 characters), what the open conversation did
 * with it: whether the receipt reached the page, whether it was taken for another contact, and what the queue did.
 */
export interface ReceiptTraceEntry { at: number; id: string; from: string; outcome: string }
const trace: ReceiptTraceEntry[] = []
export function recordReceiptOutcome(sendId: string, from: string, outcome: string): void {
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return
	trace.push({ at: Date.now(), id: String(sendId || '').slice(-8), from: String(from || '').toLowerCase().slice(-6), outcome: String(outcome || '').replace(/[^a-z_]/g, '').slice(0, 24) })
	if (trace.length > 40) trace.shift()
}
export const receiptTrace = (): ReceiptTraceEntry[] => (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true' ? [...trace] : [])

const MAX_REMEMBERED = 1000
const received = new Set<string>()
const listeners = new Set<Listener>()

export function emitDeliveryReceipt(sendId: string, from: string): void {
	const id = keyOf(sendId, from)
	if (!id) return
	recordReceiptOutcome(sendId, from, 'emitted')
	received.add(id)
	if (received.size > MAX_REMEMBERED) {
		const oldest = received.values().next().value as string
		received.delete(oldest)
	}
	for (const l of [...listeners]) {
		try {
			l(String(sendId).trim(), String(from).trim().toLowerCase())
		} catch {
			/* a listener that throws does not stop the others */
		}
	}
}

/** The receipt belongs to the chat of the contact it came from: the same sendId from another address is another receipt. */
const keyOf = (sendId: string, from: string): string => {
	const id = String(sendId || '').trim()
	const peer = String(from || '').trim().toLowerCase()
	return id && peer ? `${peer}:${id}` : ''
}

export const hasDeliveryReceipt = (sendId: string, from: string): boolean => received.has(keyOf(sendId, from))

export function onDeliveryReceipt(listener: Listener): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/** Test hook: a cold start of the module state. */
export function resetDeliveryReceiptBusForTest(): void {
	received.clear()
	listeners.clear()
}
