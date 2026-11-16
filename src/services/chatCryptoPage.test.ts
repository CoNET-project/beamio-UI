/**
 * Y.81 (CA-01 to CA-06) and Y.102 as seen by the chat page (batch 2). SYNTHETIC values only.
 */
import { chatCryptoAvailabilityOf } from './chatCryptoRetry'
import { cryptoActionsEnabled, cryptoInputOf, cryptoNoticeOf, nextCryptoRetry } from './chatCryptoPage'

const READY = { pgpUpgradeRetry: false, pgpMigrationRetry: false, offline: false, localHistoryReadable: true, localHistoryEmpty: false }
const page = (over: Partial<typeof READY>) => chatCryptoAvailabilityOf(cryptoInputOf({ ...READY, ...over }))

describe('Y.81 and Y.102 on the chat page', () => {
	it('CA-01: PGP ready and history readable: no notice, actions enabled', () => {
		const a = page({})
		expect(cryptoNoticeOf(a, 0)).toBeNull()
		expect(cryptoActionsEnabled(a)).toBe(true)
	})

	it('Y.102 2: PGP ready and history readable but empty: a normal empty session, no notice', () => {
		const a = page({ localHistoryEmpty: true })
		expect(cryptoNoticeOf(a, 0)).toBeNull()
		expect(a.emptySession).toBe(true)
	})

	it('Y.102 3: PGP ready and history unreadable: the history notice, actions stay enabled (crypto complete)', () => {
		const a = page({ localHistoryReadable: false })
		expect(cryptoNoticeOf(a, 0)).toBe('chat_history_unavailable')
		expect(cryptoActionsEnabled(a)).toBe(true)
	})

	it('CA-02: PGP waiting (migration retry): read only, actions disabled, the crypto notice on the schedule', () => {
		const a = page({ pgpMigrationRetry: true })
		expect(a.history).toBe('readonly')
		expect(cryptoActionsEnabled(a)).toBe(false)
		expect(cryptoNoticeOf(a, 0)).toBe('chat_crypto_retrying')
	})

	it('CA-03: offline cold start: actions disabled, the notice, L never used', () => {
		const a = page({ offline: true, pgpUpgradeRetry: true })
		expect(cryptoActionsEnabled(a)).toBe(false)
		expect(a.useL).toBe(false)
	})

	it('CA-04: no readable history while PGP waits: a notice, never "no session", actions disabled', () => {
		const a = page({ pgpMigrationRetry: true, localHistoryReadable: false })
		expect(a.history).toBe('hidden_with_retry')
		expect(cryptoNoticeOf(a, 0)).toBe('chat_crypto_retrying')
		expect(cryptoActionsEnabled(a)).toBe(false)
	})

	it('CA-05: the schedule is 30 s, 2 min, 10 min; after that the notice says still retrying, with a manual retry only', () => {
		const a = page({ pgpMigrationRetry: true })
		expect(cryptoNoticeOf(a, 0)).toBe('chat_crypto_retrying')
		expect(nextCryptoRetry(0, 'none')).toEqual({ immediate: false, delayMs: 30_000 })
		expect(nextCryptoRetry(1, 'none')).toEqual({ immediate: false, delayMs: 120_000 })
		expect(nextCryptoRetry(2, 'none')).toEqual({ immediate: false, delayMs: 600_000 })
		expect(cryptoNoticeOf(a, 3)).toBe('chat_crypto_still_retrying')
		expect(nextCryptoRetry(3, 'none')).toEqual({ immediate: false, delayMs: null })
	})

	it('CA-06: offline to online retries once, at once', () => {
		expect(nextCryptoRetry(0, 'offline_to_online').immediate).toBe(true)
		expect(nextCryptoRetry(0, 'none').immediate).toBe(false)
	})

	it('one notice at most: both PGP migration signals together give a single Y.81 notice, not two', () => {
		const a = page({ pgpUpgradeRetry: true, pgpMigrationRetry: true })
		expect(cryptoNoticeOf(a, 0)).toBe('chat_crypto_retrying')
		expect(cryptoInputOf({ ...READY, pgpUpgradeRetry: true, pgpMigrationRetry: true }).pgpSource).toBe('pgp_source_unavailable')
	})

	it('PGP ready never reads as a missing PGP or a missing session (the input carries no such state)', () => {
		const input = cryptoInputOf(READY)
		expect(input.kPgpVerified).toBe(true)
		expect(input.pgpSource).toBe('ok')
	})
})

describe('Y.81 wiring on the chat page (static)', () => {
	const { readFileSync } = require('fs') as typeof import('fs')
	const { join } = require('path') as typeof import('path')
	const chat = readFileSync(join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')

	it('the page reads the Y.81 model and shows one notice (no second PGP notice)', () => {
		expect(chat).toContain('cryptoInputOf({ pgpUpgradeRetry, pgpMigrationRetry')
		expect(chat).toContain('cryptoNoticeOf(chatCryptoAvail, cryptoAttempt)')
		expect(chat).toContain('{chatCryptoNotice !== null && (')
		expect(chat).not.toContain("{tu('pgp_migration_retry_notice')}")
		expect(chat).not.toContain("{tu('chat_pgp_migration_retry_title')}")
	})

	it('the send entry points are gated by the encryption availability', () => {
		const gates = chat.split('if (!chatActionsRef.current) return').length - 1
		expect(gates).toBeGreaterThanOrEqual(4)
	})

	it('the retry schedule and the online retry are wired', () => {
		expect(chat).toContain('nextCryptoRetry(cryptoAttempt, \'none\')')
		expect(chat).toContain("window.addEventListener('online', up)")
	})
})

describe('Y.81 gate and real history signal on the chat page (R45 blockers)', () => {
	const { readFileSync } = require('fs') as typeof import('fs')
	const { join } = require('path') as typeof import('path')
	const chat = readFileSync(join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')

	it('every decrypt entry point outside the send path is gated: voice fragments and chat file manifests', () => {
		expect(chat).toContain('if (!chatCryptoDecryptGate.enabled) { setLoading(false); return }')
		expect(chat).toContain('if (!chatCryptoDecryptGate.enabled) return')
		// the gate sits before each decrypt call
		const v = chat.indexOf('void decryptVoiceFragment(manifest, controller.signal)')
		expect(chat.lastIndexOf('chatCryptoDecryptGate.enabled', v)).toBeGreaterThan(chat.lastIndexOf('const controller', v))
		const f = chat.indexOf('void decryptChatFileManifest(manifest, controller.signal)')
		expect(chat.lastIndexOf('chatCryptoDecryptGate.enabled', f)).toBeGreaterThan(f - 400)
	})

	it('the decrypt gate is set from the same availability as the send gate on each render', () => {
		expect(chat).toContain('chatCryptoDecryptGate.enabled = chatActionsRef.current')
	})

	it('the composer button is disabled consistently with the gate', () => {
		expect(chat).toContain('disabled={voiceSending || !chatCryptoActionsOn}')
	})

	it('the local history signal comes from the local library read, not a hard-coded value', () => {
		expect(chat).not.toContain('localHistoryReadable: true, localHistoryEmpty: false }))')
		expect(chat).toContain('localHistoryReadable: localHistoryState.readable')
		expect(chat).toContain("setLocalHistoryState(page && page.source === 'local' ? { readable: true, empty: page.items.length === 0 } : { readable: false, empty: false })")
	})
})
