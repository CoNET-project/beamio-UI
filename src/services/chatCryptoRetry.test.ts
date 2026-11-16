/**
 * Y.81 CA-01 to CA-06 (chatAvailabilityCases in pgp-migration-vectors.v2.json, sha256 cce7b834…), the Y.102 three cases, and the Y.83 4
 * retry rule. SYNTHETIC values only.
 */
import { chatCryptoAvailabilityOf, chatCryptoRetryAfter, immediateRetriesOnNetworkRestore, storageLockActionAt } from './chatCryptoRetry'

const READABLE_WITH_ITEMS = { localHistoryReadable: true, localHistoryEmpty: false }
const UNREADABLE = { localHistoryReadable: false, localHistoryEmpty: false }

describe('Y.81 chat crypto availability (CA-01 to CA-06)', () => {
	it('CA-01: K_pgp verified: read and write on, no notice, no retry, L not used', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, ...READABLE_WITH_ITEMS })).toEqual({
			history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, emptySession: false, useL: false,
		})
	})

	it('CA-02: pgp_source_unavailable with local history: read only, actions disabled, the retry notice, the schedule runs', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'pgp_source_unavailable', offline: false, ...READABLE_WITH_ITEMS })).toEqual({
			history: 'readonly', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', emptySession: false, useL: false,
		})
	})

	it('CA-03: offline cold start with an old L present: L is not used, history read only', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'none', offline: true, ...READABLE_WITH_ITEMS })).toEqual({
			history: 'readonly', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', emptySession: false, useL: false,
		})
	})

	it('CA-04: no local history: never shown as "no session"; the retry notice and the schedule, actions disabled', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'pgp_source_unavailable', offline: true, ...UNREADABLE })).toEqual({
			history: 'hidden_with_retry', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', emptySession: false, useL: false,
		})
	})

	it('CA-05: the retry delays are 30 s, 2 min, 10 min, then manual', () => {
		expect([0, 1, 2].map((n) => chatCryptoRetryAfter(n))).toEqual([30_000, 120_000, 600_000])
		expect(chatCryptoRetryAfter(3)).toBe('manual')
	})

	it('CA-06: offline to online retries once, at once', () => {
		expect(immediateRetriesOnNetworkRestore('offline_to_online')).toBe(1)
		expect(immediateRetriesOnNetworkRestore('none')).toBe(0)
	})
})

describe('Y.102: crypto complete, the three history cases', () => {
	it('Y.102 1: crypto complete and history readable with items: no notice, no retry', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, ...READABLE_WITH_ITEMS })).toEqual({
			history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, emptySession: false, useL: false,
		})
	})

	it('Y.102 2: crypto complete and history readable but empty: a normal empty session, no notice, no retry', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, localHistoryReadable: true, localHistoryEmpty: true })).toEqual({
			history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, emptySession: true, useL: false,
		})
	})

	it('Y.102 3: crypto complete and history not readable: the history notice and the schedule, separate from the crypto notice, never "no session"', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, ...UNREADABLE })).toEqual({
			history: 'hidden_with_retry', encryptActions: 'enabled', hint: 'chat_history_unavailable', retry: 'schedule', emptySession: false, useL: false,
		})
	})

	it('Y.102: the empty-session flag is never set when the history is not readable, whatever the crypto state', () => {
		for (const kPgpVerified of [true, false]) {
			for (const pgpSource of ['ok', 'pgp_source_unavailable', 'none'] as const) {
				const out = chatCryptoAvailabilityOf({ kPgpVerified, pgpSource, offline: false, localHistoryReadable: false, localHistoryEmpty: true })
				expect(out.emptySession).toBe(false)
				expect(out.hint).not.toBeNull()
			}
		}
	})

	it('Y.102: the crypto notice and the history notice are different keys', () => {
		const crypto = chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'none', offline: false, ...UNREADABLE }).hint
		const history = chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, ...UNREADABLE }).hint
		expect(crypto).toBe('chat_crypto_retrying')
		expect(history).toBe('chat_history_unavailable')
		expect(crypto).not.toBe(history)
	})
})

describe('CA-04 (R35): every input without readable history shows a notice and the schedule', () => {
	it('every crypto state without readable history is hidden_with_retry with a notice and the schedule, never a "no session" state', () => {
		for (const kPgpVerified of [true, false]) {
			for (const pgpSource of ['ok', 'pgp_source_unavailable', 'none'] as const) {
				for (const offline of [true, false]) {
					const out = chatCryptoAvailabilityOf({ kPgpVerified, pgpSource, offline, ...UNREADABLE })
					expect(out.history).toBe('hidden_with_retry')
					expect(out.hint).not.toBeNull()
					expect(out.retry).toBe('schedule')
					expect(out.useL).toBe(false)
				}
			}
		}
	})
})

describe('Y.83 4 storage-derived lock: three retries, then the user-started recovery entry', () => {
	it('retries on the schedule for the first three attempts, then offers the recovery entry (never automatic)', () => {
		expect(storageLockActionAt(0)).toEqual({ kind: 'retry', delayMs: 30_000 })
		expect(storageLockActionAt(1)).toEqual({ kind: 'retry', delayMs: 120_000 })
		expect(storageLockActionAt(2)).toEqual({ kind: 'retry', delayMs: 600_000 })
		expect(storageLockActionAt(3)).toEqual({ kind: 'recovery_entry' })
		expect(storageLockActionAt(9)).toEqual({ kind: 'recovery_entry' })
	})
})
