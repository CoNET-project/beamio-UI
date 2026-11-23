/**
 * (interface ): the address_mismatch latch. A refused account is not sent `init`again in this session, until
 * a successful init or a wallet event clears it. Another account is never blocked. A refusal for another reason is not latched.
 * SYNTHETIC addresses only.
 */
import { ADDRESS_MISMATCH, createInitRefusalLatch } from './nativeInitRefusal'
import { readFileSync } from 'fs'
import { join } from 'path'

const A = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const B = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('the address_mismatch latch', () => {
	it('a refused account is latched: the next init for it is skipped, and the refusal is reported once', () => {
		const latch = createInitRefusalLatch()
		expect(latch.skipInit(B)).toBe(false)
		expect(latch.noteRefusal(B, ADDRESS_MISMATCH)).toBe(true)
		expect(latch.skipInit(B)).toBe(true)
		expect(latch.takeRefusal()).toBe(ADDRESS_MISMATCH)
		expect(latch.takeRefusal()).toBeNull()
	})

	it('another account is not blocked by the latch', () => {
		const latch = createInitRefusalLatch()
		latch.noteRefusal(B, ADDRESS_MISMATCH)
		expect(latch.skipInit(A)).toBe(false)
	})

	it('a refusal for another reason is not latched', () => {
		const latch = createInitRefusalLatch()
		expect(latch.noteRefusal(A, 'not_ready')).toBe(false)
		expect(latch.noteRefusal(A, 'native_ack_failed')).toBe(false)
		expect(latch.skipInit(A)).toBe(false)
		expect(latch.takeRefusal()).toBeNull()
	})

	it('a wallet event (clear) lets the next init for the account go out again', () => {
		const latch = createInitRefusalLatch()
		latch.noteRefusal(B, ADDRESS_MISMATCH)
		latch.clear()
		expect(latch.skipInit(B)).toBe(false)
	})

	it('a successful init (noteReady) clears the latch', () => {
		const latch = createInitRefusalLatch()
		latch.noteRefusal(B, ADDRESS_MISMATCH)
		latch.noteReady()
		expect(latch.skipInit(B)).toBe(false)
	})

	it('a later refusal for another account moves the latch to that account', () => {
		const latch = createInitRefusalLatch()
		latch.noteRefusal(B, ADDRESS_MISMATCH)
		latch.noteRefusal(A, ADDRESS_MISMATCH)
		expect(latch.skipInit(A)).toBe(true)
		expect(latch.skipInit(B)).toBe(false)
	})
})

describe('the bridge and the wallet wire the latch', () => {
	const bridge = readFileSync(join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
	const wallet = readFileSync(join(__dirname, 'nativeWallet.ts'), 'utf8')
	const chat = readFileSync(join(__dirname, 'chat.ts'), 'utf8')

	it('the listen start checks the latch before it sends init', () => {
		const guard = bridge.indexOf('initLatch.skipInit(p.eoaAddress)')
		const init = bridge.indexOf('client.init()', guard) // R79-watchdog: the init may sit inside the ready watchdog
		expect(guard).toBeGreaterThan(0)
		expect(init).toBeGreaterThan(guard)
	})

	it('a successful init clears the latch; a failed init records the refusal', () => {
		expect(bridge).toContain('initLatch.noteReady()')
		expect(bridge).toContain('initLatch.noteRefusal(eoaAddress, restoreCode)')
	})

	it('the bridge clears the latch on the wallet events, and the native wallet ready path clears it too', () => {
		expect(bridge).toContain('[BEAMIO_WALLET_READY_EVENT, NATIVE_WALLET_ESTABLISHED_EVENT]')
		expect(wallet).toContain('forgetInitRefusal()')
	})

	it('the shell start reads the refusal, so it does not retry', () => {
		expect(chat).toContain('listenRefusal: () => takeListenRefusal()')
	})
})

describe('the closed reasons of the init refusal', () => {
	it('clear_failed and unregister_refused are reported once and never latched', () => {
		const latch = createInitRefusalLatch()
		expect(latch.noteIdentityClosed('clear_failed')).toBe(true)
		expect(latch.takeIdentityClosed()).toBe('clear_failed')
		expect(latch.takeIdentityClosed()).toBeNull()
		expect(latch.noteIdentityClosed('unregister_refused')).toBe(true)
		expect(latch.takeIdentityClosed()).toBe('unregister_refused')
		expect(latch.skipInit(A)).toBe(false)
	})

	it('another init failure replaces the pending closed reason with none', () => {
		const latch = createInitRefusalLatch()
		latch.noteIdentityClosed('clear_failed')
		expect(latch.noteIdentityClosed('native_ack_failed')).toBe(false)
		expect(latch.takeIdentityClosed()).toBeNull()
	})

	it('a successful init clears a pending closed reason', () => {
		const latch = createInitRefusalLatch()
		latch.noteIdentityClosed('clear_failed')
		latch.noteReady()
		expect(latch.takeIdentityClosed()).toBeNull()
	})
})
