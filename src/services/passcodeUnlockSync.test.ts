/**
 * M6 (passcode-preserving unlock sync, spec v3): the PWA side, cases MP-01 .. MP-18 at the unit level (the sync mechanism with synthetic
 * credentials; the gate-level start paths are covered by the AppEntryGate suites).
 *
 * After the page unlock of a passcode account the page sends ONE pwaWalletSync{eoa, cipher, passcode, seq} and never the decrypted phrase.
 * A synced answer (ok, including an account switch) is a success; a refusal, a read fault, a timeout or no answer is a pending sync recorded
 * by the sync itself. Nothing is deleted or onboarded, there is no fallback to a plaintext phrase, and the passcode lives only in the one request.
 */
import { afterUiUnlock } from './passcode/uiUnlockNative'
import { createShellMnemonicSync } from './shellMnemonicSync'
import { mapCipherSyncReply, mapSyncReply } from './pwaWalletSyncTransport'
import { getShellSyncState, resetShellSyncStatus } from './shellSyncStatus'

const EOA = '0x1111111111111111111111111111111111111111'
const PASSCODE = '482915'
const CIPHER = { v: 3, mode: 'passcode', alg: 'AES-256-GCM', kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', eoa: EOA }

type Sent = Array<Record<string, unknown>>

const make = (reply: unknown | (() => never), opts?: { cipher?: Record<string, unknown> | null; capabilities?: string[]; answered?: boolean }) => {
	const sent: Sent = []
	const syncCalls: Array<{ cipher: Record<string, unknown>; eoa: string; passcode: string }> = []
	const logs: string[] = []
	const sync = createShellMnemonicSync({
		send: async () => 'ok',
		sendCipher: async (_tx, cipher, passcode) => {
			syncCalls.push({ cipher, eoa: String((cipher as { eoa?: unknown }).eoa), passcode: String(passcode) })
			if (typeof reply === 'function') (reply as () => never)()
			return reply as never
		},
		retryDelaysMs: [1, 1],
		wait: async () => undefined,
		log: (m) => logs.push(m),
		bridgeAvailable: () => true,
		nextSeq: (() => { let n = 0; return () => ++n })(),
	})
	const deps = {
		probe: async () => ({ answered: opts?.answered ?? true, capabilities: opts?.capabilities ?? [] }),
		send: async (cmd: Record<string, unknown>) => { sent.push(cmd); return null },
		readCipher: async () => (opts && 'cipher' in opts ? opts.cipher ?? null : CIPHER),
		syncCipher: (cipher: Record<string, unknown>, eoa: string, passcode: string) => sync.syncCipher(cipher, eoa, passcode),
	}
	return { deps, sent, syncCalls, logs }
}

beforeEach(() => resetShellSyncStatus())

describe('MP-01 / MP-02: the unlock of a passcode account sends one pwaWalletSync with the cipher and the passcode', () => {
	it('entry (shell without the capability): one cipher+passcode sync, no passcodeUnlock, continue', async () => {
		const m = make({ code: 'ok' })
		await expect(afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)).resolves.toBe('continue')
		expect(m.syncCalls).toEqual([{ cipher: CIPHER, eoa: EOA, passcode: PASSCODE }])
		expect(m.sent).toEqual([]) // no passcodeUnlock, no passcodeStatus, no phrase command
		expect(getShellSyncState().kind).toBe('synced')
	})
	it('the same with the capability declared: the sync replaces the old native unlock path', async () => {
		const m = make({ code: 'ok' }, { capabilities: ['wallet.passcode.v1'] })
		await expect(afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)).resolves.toBe('continue')
		expect(m.syncCalls.length).toBe(1)
		expect(m.sent).toEqual([])
	})
	it('a browser sends nothing', async () => {
		const m = make({ code: 'ok' })
		await expect(afterUiUnlock({ shell: false, eoa: EOA, passcode: PASSCODE }, m.deps)).resolves.toBe('continue')
		expect(m.syncCalls.length).toBe(0)
	})
})

describe('MP-04 / MP-05 / MP-06 / MP-11 / MP-17: a refusal or a failure is a pending sync; nothing else happens', () => {
	const cases: Array<[string, unknown]> = [
		['unlock_failed', { code: 'unlock_failed' }],
		['verify_failed', { code: 'verify_failed' }],
		['write_failed / internal_state', { code: 'write_failed', reason: 'internal_state' }],
		['write_failed / storage_write', { code: 'write_failed', reason: 'storage_write' }],
		['gate refused (key_over_bridge_refused)', { code: 'key_over_bridge_refused' }],
		['bad_request', { code: 'bad_request' }],
		['untrusted_source (older shell)', { code: 'untrusted_source' }],
		['no answer', { code: 'no_answer' }],
	]
	it.each(cases)('%s: continue into the app (the account is kept), the sync is recorded as failed, the passcode is sent once, no fallback to a phrase', async (_n, reply) => {
		const m = make(reply)
		await expect(afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)).resolves.toBe('continue')
		expect(m.syncCalls.length).toBe(1) // the request that carries the passcode is never retried
		expect(m.sent).toEqual([]) // no phrase, no passcodeUnlock
		const state = getShellSyncState()
		expect(state.kind).toBe('failed')
	})
	it('a throwing sender is a pending sync, never a crash or a hold', async () => {
		const m = make(() => { throw new Error('bridge down') })
		await expect(afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)).resolves.toBe('continue')
		expect(getShellSyncState().kind).toBe('failed')
	})
})

describe('MP-12 / MP-14: the passcode lives only in the one request; the phrase of a passcode account is never sent', () => {
	it('the passcode is in no log line, and the retry schedule is not used for the request that carries it', async () => {
		const m = make({ code: 'no_answer' })
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)
		expect(m.logs.join('\n')).not.toContain(PASSCODE)
		expect(m.syncCalls.length).toBe(1)
	})
	it('the page record holds no envelope for this account: the cipher path is not used (the older native check runs instead); no phrase is invented', async () => {
		const m = make({ code: 'ok' }, { cipher: null })
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)
		expect(m.syncCalls.length).toBe(0)
	})
	it('an envelope of another account is not synced as this account', async () => {
		const other = { ...CIPHER, eoa: '0x2222222222222222222222222222222222222222' }
		const m = make({ code: 'ok' }, { cipher: other })
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)
		expect(m.syncCalls.length).toBe(0)
	})
})

describe('MP-15 / MP-16 / MP-18: an account switch (updated) is a success, not a conflict', () => {
	it('cipher+passcode answer with sync:updated is a confirmed sync', () => {
		expect(mapCipherSyncReply({ type: 'ack', ok: true, result: { code: 'ok', decrypted: true, stored: true, readback: 'match', sync: 'updated' } }, true)).toEqual({ code: 'ok' })
	})
	it('phrase answers updated and idempotent are confirmed', () => {
		expect(mapSyncReply({ type: 'ack', ok: true, result: { eoa: EOA, sync: 'updated' } })).toEqual({ code: 'ok' })
		expect(mapSyncReply({ type: 'ack', ok: true, result: { eoa: EOA, sync: 'idempotent' } })).toEqual({ code: 'ok' })
	})
	it('the failure answer is flat: reason at the top level, both reasons are write_failed', () => {
		expect(mapSyncReply({ type: 'ack', ok: false, error: 'write_failed', reason: 'internal_state' })).toEqual({ code: 'write_failed', reason: 'internal_state' })
		expect(mapSyncReply({ type: 'ack', ok: false, error: 'write_failed', reason: 'storage_write' })).toEqual({ code: 'write_failed', reason: 'storage_write' })
	})
	it('the SDK shapes of a wrong passcode and a failed identity check ({ok:true, result:{code}}) map to their closed codes, not to no_answer', () => {
		expect(mapCipherSyncReply({ type: 'ack', ok: true, result: { code: 'unlock_failed' } }, true)).toEqual({ code: 'unlock_failed' })
		expect(mapCipherSyncReply({ type: 'ack', ok: true, result: { code: 'verify_failed' } }, true)).toEqual({ code: 'verify_failed' })
		// the older envelope-error shape stays
		expect(mapCipherSyncReply({ type: 'ack', ok: false, error: 'unlock_failed' }, true)).toEqual({ code: 'unlock_failed' })
		expect(mapCipherSyncReply({ type: 'ack', ok: false, error: 'verify_failed' }, true)).toEqual({ code: 'verify_failed' })
		// anything else that is ok:true without the full confirmation is still not a completion
		expect(mapCipherSyncReply({ type: 'ack', ok: true, result: { code: 'ok', stored: true } }, true).code).toBe('no_answer')
	})
	it('unchanged (a plaintext request refused because the native record is a protected v3 set) is a handled answer, not no_answer', () => {
		expect(mapSyncReply({ type: 'ack', ok: true, result: { eoa: EOA, sync: 'unchanged' } })).toEqual({ code: 'ok' })
		expect(mapSyncReply({ type: 'ack', ok: true, result: { eoa: EOA, sync: 'other' } })).toEqual({ code: 'no_answer' })
	})
	it('a wrong passcode or a failed identity check is not retried (the passcode goes out once) and is recorded as the code', async () => {
		for (const code of ['unlock_failed', 'verify_failed'] as const) {
			resetShellSyncStatus()
			const m = make({ code })
			await afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, m.deps)
			expect(m.syncCalls.length).toBe(1)
			const st = getShellSyncState()
			expect(st.kind).toBe('failed')
			expect((st as { code?: string }).code).toBe(code)
		}
	})
})

describe('M6 v3.3: a refused store-only sync is settled by the next unlock, which sends the current envelope with the passcode', () => {
	it('the first sync (no passcode) is refused with bad_request and is not retried; the unlock sync with the passcode is accepted', async () => {
		const calls: Array<{ withPasscode: boolean; ct: string }> = []
		const logs: string[] = []
		const sync = createShellMnemonicSync({
			send: async () => 'ok',
			sendCipher: async (_tx, cipher, passcode) => {
				calls.push({ withPasscode: passcode !== undefined, ct: String((cipher as { ct?: unknown }).ct) })
				return passcode === undefined ? ({ code: 'bad_request' } as never) : ({ code: 'ok' } as never)
			},
			retryDelaysMs: [1, 1, 1],
			wait: async () => undefined,
			log: (m) => logs.push(m),
			bridgeAvailable: () => true,
			nextSeq: (() => { let n = 0; return () => ++n })(),
		})
		const NEW_ENVELOPE = { ...CIPHER, ct: 'Q1RfTkVX' }
		const background = await sync.syncCipher(NEW_ENVELOPE, EOA)
		expect(background).toMatchObject({ kind: 'failed', code: 'bad_request', retryable: false })
		expect(calls).toEqual([{ withPasscode: false, ct: 'Q1RfTkVX' }]) // sent once, no retry
		expect(getShellSyncState().kind).toBe('failed')
		const deps = {
			probe: async () => ({ answered: true, capabilities: [] as string[] }),
			send: async () => null,
			readCipher: async () => NEW_ENVELOPE as Record<string, unknown>,
			syncCipher: (c: Record<string, unknown>, e: string, p: string) => sync.syncCipher(c, e, p),
		}
		await expect(afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, deps)).resolves.toBe('continue')
		expect(calls[1]).toEqual({ withPasscode: true, ct: 'Q1RfTkVX' })
		expect(getShellSyncState().kind).toBe('synced')
		expect(logs.join('\n')).not.toContain(PASSCODE)
	})
})
