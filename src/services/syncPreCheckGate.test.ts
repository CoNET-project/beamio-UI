/**
 * The pre-check before the native mnemonic sync (review, item 1 (2)). Covered here at the decision
 * level: a locked, unknown, unavailable or timed-out native answer is "pending", so the sync is not sent, and the first native write (held
 * by the store gate) cannot be opened by it. The entry gate's own call site is not rendered in this suite (see the response).
 */
import { runSyncPreCheck } from './syncPreCheck'

describe('the pre-check: only a confirmed unlocked native side lets the sync run', () => {
	it('locked, unknown, unavailable or a timeout is pending (the sync is not sent)', async () => {
		await expect(runSyncPreCheck(async () => 'unlocked' as never, async () => 'locked' as never)).resolves.toBe('pending')
		await expect(runSyncPreCheck(async () => 'unknown' as never, async () => 'unlocked' as never)).resolves.toBe('pending')
		await expect(runSyncPreCheck(async () => 'unlocked' as never, async () => 'unavailable' as never)).resolves.toBe('pending')
		await expect(runSyncPreCheck(async () => { throw new Error('timeout') }, async () => 'unlocked' as never)).resolves.toBe('pending')
	})
	it('positive control: a present wallet, unlocked, lets the sync run', async () => {
		await expect(runSyncPreCheck(async () => 'present' as never, async () => 'unlocked' as never)).resolves.toBe('sync')
	})
})
