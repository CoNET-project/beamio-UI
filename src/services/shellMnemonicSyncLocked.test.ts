/**
 * @jest-environment node
 *
 * HC-LOCK L-SYNC (driver): a locked reply ends the sync with code locked and is not retried; it is never counted as synced.
 */
import { createShellMnemonicSync } from './shellMnemonicSync'
import { resetShellSyncStatus } from './shellSyncStatus'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('shell mnemonic sync: locked is not retried and not synced (L-SYNC)', () => {
	beforeEach(() => resetShellSyncStatus())

	it('a locked answer ends at once with code locked and no second send', async () => {
		const send = jest.fn(async () => ({ code: 'locked' as const }))
		const onSynced = jest.fn()
		const sync = createShellMnemonicSync({
			send,
			retryDelaysMs: [1, 1, 1],
			wait: async () => undefined,
			log: () => undefined,
			bridgeAvailable: () => true,
			onSynced,
		})
		const result = await sync.sync(PHRASE, EOA)
		expect(send).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({ kind: 'failed', code: 'locked', retryable: false })
		expect(onSynced).not.toHaveBeenCalled()
	})
})
