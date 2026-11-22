/**
 * @jest-environment node
 *
 * HC-LOCK pwaWalletSync: a locked reply is `locked`, not no_answer, so it is not retried by itself.
 */
import { mapSyncReply } from './pwaWalletSyncTransport'

describe('pwaWalletSync locked (L-SYNC)', () => {
	it('an envelope error locked maps to locked, not no_answer (so the driver does not retry it)', () => {
		expect(mapSyncReply({ ok: false, error: 'locked' })).toEqual({ code: 'locked' })
	})

	it('regression: an unknown error is still no_answer; ok stays ok', () => {
		expect(mapSyncReply({ ok: false, error: 'something_else' })).toEqual({ code: 'no_answer' })
		expect(mapSyncReply({ ok: true, result: { sync: 'updated' } })).toEqual({ code: 'ok' })
	})
})
