/**
 * @jest-environment node
 */
// The page remembers the receipts it posted successfully; the receipt outbox must be able to post one again past that memory. Real sendDeliveryReceiptToSender; the POST is a double. Synthetic values.
import { ethers } from 'ethers'
import { sendDeliveryReceiptToSender } from './chatDeliveryReceipt'

if (!(globalThis as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
}

const KEY = new ethers.Wallet(`0x${'5a'.repeat(32)}`).privateKey

it('without resend a second call posts nothing and still answers true; with resend it posts again', async () => {
	let posts = 0
	const call = (resend: boolean) => sendDeliveryReceiptToSender({ resend, senderPublicArmored: 'synthetic-public', senderMailboxRoutePublicKey: 'synthetic-route', privateKeyArmor: KEY, entryNodes: [{} as never], sendId: 'm-resend', sendMessage: async () => { posts += 1; return true } })
	expect(await call(false)).toBe(true)
	expect(posts).toBe(1)
	expect(await call(false)).toBe(true)
	expect(posts).toBe(1)
	expect(await call(true)).toBe(true)
	expect(posts).toBe(2)
})
