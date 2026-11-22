/**
 * S-15 (not_available: the old shell or a native side without the feature) and the gateway wiring of the cleanup command.
 * The gateway is mocked at requestNativeAck, so the test sees the exact command the page sends through the gateway.
 * Behaviour only: a refused or not_available answer deletes nothing, creates nothing and keeps the pending marker; at most one send per start.
 */
import { CLEANUP_DONE_KEY, CLEANUP_PENDING_KEY, resetCleanupGuardsForTest, startCleanupAfterRecovery } from './accountCleanupPending'
import { ACCOUNT_CLEANUP_TIMEOUT_MS } from './accountCleanupOld'

const mockRequest = jest.fn()
jest.mock('./nativeChatRouteRegister', () => ({ requestNativeAck: (...args: unknown[]) => mockRequest(...args) }))

const A = '0x' + 'a'.repeat(40)

function memStore() {
	const m = new Map<string, string>()
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		keys: () => [...m.keys()],
		has: (k: string) => m.has(k),
		put: (k: string, v: string) => void m.set(k, v),
	}
}
const notAvailable = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_available' } })
const ok = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: true, result: { cleanupPending: false, keptUnattributed: 0 } } })

beforeEach(() => {
	resetCleanupGuardsForTest()
	mockRequest.mockReset()
})

describe('S-15 native not_available (old shell, or the feature not enabled): no deletion, no creation, pending kept', () => {
	it('the answer is a refusal: pending kept, done absent, the new-account records untouched', async () => {
		const store = memStore()
		store.put('wallet.v1.new', '{"eoa":"new"}')
		mockRequest.mockImplementation(notAvailable)
		const out = await startCleanupAfterRecovery(store, A, () => 'K-15')
		expect(out).toEqual({ kind: 'refused', code: 'not_available' })
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
		expect(store.getItem('wallet.v1.new')).toBe('{"eoa":"new"}')
		expect(store.keys().filter((k) => k.startsWith('wallet.v1.'))).toEqual(['wallet.v1.new'])
	})
	it('not_available is not resumed inside the same start (only clear_incomplete is retried)', async () => {
		const store = memStore()
		mockRequest.mockImplementation(notAvailable)
		await startCleanupAfterRecovery(store, A, () => 'K-15')
		expect(mockRequest).toHaveBeenCalledTimes(1)
	})
	it('no answer at all (timeout or unavailable gateway) is a refusal too, and the pending marker stays', async () => {
		const store = memStore()
		mockRequest.mockImplementation(() => Promise.resolve({ kind: 'timeout' }))
		const out = await startCleanupAfterRecovery(store, A, () => 'K-15')
		expect(out.kind).toBe('refused')
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
	})
	it('a persistent refusal sends at most once per start: each new start sends once more, never a loop', async () => {
		const store = memStore()
		mockRequest.mockImplementation(notAvailable)
		await startCleanupAfterRecovery(store, A, () => 'K-15')
		resetCleanupGuardsForTest()
		await startCleanupAfterRecovery(store, A, () => 'K-15')
		expect(mockRequest).toHaveBeenCalledTimes(2)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
	})
	it('a later ok after the feature is enabled clears the marker and writes done', async () => {
		const store = memStore()
		mockRequest.mockImplementation(notAvailable)
		await startCleanupAfterRecovery(store, A, () => 'K-15')
		resetCleanupGuardsForTest()
		mockRequest.mockImplementation(ok)
		const out = await startCleanupAfterRecovery(store, A, () => 'K-15')
		expect(out).toEqual({ kind: 'ok' })
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(true)
	})
})

describe('gateway wiring: the command goes through requestNativeAck with the four-field shape only', () => {
	it('the page sends accountCleanupOld through the gateway with the cleanup timeout and the command reqId', async () => {
		const store = memStore()
		mockRequest.mockImplementation(ok)
		await startCleanupAfterRecovery(store, A, () => 'K-GW')
		expect(mockRequest).toHaveBeenCalledTimes(1)
		const [cmd, timeout, reqId] = mockRequest.mock.calls[0] as [Record<string, unknown>, number, number]
		expect(Object.keys(cmd).sort()).toEqual(['accountKey', 'idempotencyKey', 'reqId', 'type'])
		expect(cmd.type).toBe('accountCleanupOld')
		expect(cmd.accountKey).toBe(A)
		expect(cmd.idempotencyKey).toBe('K-GW')
		expect(timeout).toBe(ACCOUNT_CLEANUP_TIMEOUT_MS)
		expect(reqId).toBe(cmd.reqId)
	})
	it('no confirmation field exists in the command, even when a recovery result is passed in', async () => {
		const store = memStore()
		mockRequest.mockImplementation(ok)
		await startCleanupAfterRecovery(store, A, () => 'K-GW2')
		const cmd = mockRequest.mock.calls[0][0] as Record<string, unknown>
		expect(cmd).not.toHaveProperty('confirmed')
		expect(cmd).not.toHaveProperty('confirmation')
		expect(cmd).not.toHaveProperty('nativeAddress')
	})
})
