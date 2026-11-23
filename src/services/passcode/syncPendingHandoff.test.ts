/**
 * @jest-environment node
 *
 * f3 follow-up (item 1): a sync_pending set is handed to the app's registered mechanism, once, with the cipher and the account.
 * No retry is added here. Synthetic values only.
 */
import { handOffSyncPending, setSyncPendingHandler } from './syncPendingHandoff'

const CIPHER = { v: 3, mode: 'passcode', eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94', ct: 'synthetic' }
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

afterEach(() => setSyncPendingHandler(null))

describe('sync_pending hand-off', () => {
	it('with no registered mechanism nothing is sent and nothing is retried here', () => {
		expect(handOffSyncPending(CIPHER, EOA)).toBe(false)
	})

	it('with the mechanism registered, the cipher and the account are handed over once', () => {
		const calls: Array<[Record<string, unknown>, string]> = []
		setSyncPendingHandler((c, e) => {
			calls.push([c, e])
		})
		expect(handOffSyncPending(CIPHER, EOA)).toBe(true)
		expect(calls).toEqual([[CIPHER, EOA]])
	})

	it('removing the registration stops the hand-off', () => {
		const calls: unknown[] = []
		setSyncPendingHandler(() => {
			calls.push(1)
		})
		setSyncPendingHandler(null)
		expect(handOffSyncPending(CIPHER, EOA)).toBe(false)
		expect(calls).toHaveLength(0)
	})
})

describe('sync_pending 交给已注册的后台同步（注册后才接管）', () => {
	afterEach(() => setSyncPendingHandler(null))

	it('未注册时不发送，返回 false', () => {
		expect(handOffSyncPending({ v: 3, ct: 'x' }, '0x' + '1'.repeat(40))).toBe(false)
	})

	it('注册后把密文与 EOA 交给注册方，且 handOff 本身不标记完成（完成只由注册方的读回确认决定）', () => {
		const seen: Array<[Record<string, unknown>, string]> = []
		setSyncPendingHandler((c, e) => {
			seen.push([c, e])
		})
		const cipher = { v: 3, ct: 'ct-synthetic' }
		expect(handOffSyncPending(cipher, '0xabc')).toBe(true)
		expect(seen).toEqual([[cipher, '0xabc']])
	})

	it('注销后不再交接', () => {
		const h = jest.fn()
		setSyncPendingHandler(h)
		setSyncPendingHandler(null)
		expect(handOffSyncPending({ v: 3 }, '0xabc')).toBe(false)
		expect(h).not.toHaveBeenCalled()
	})
})
