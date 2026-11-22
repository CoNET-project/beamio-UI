/**
 *pwaWalletSync and nativeMnemonicPreread over the REAL production transport
 * (sendPwaWalletSync / sendNativeMnemonicPreread → sendShellWalletSyncCommand → window.BeamioShellRecord).
 * A fake shell answers on the injected object's onmessage, in the flat envelope {type:"ack", reqId, ok, result?|error?, reason?}.
 * The fake records every request, so the cases can check what the page sent. SYNTHETIC values only
 * (the phrase is the public BIP-39 test vector, not an account).
 * Test-double note: this file maps its one public phrase to its public EOA. It checks the wire behaviour when the derivation equals the
 * mapped value; it does not check the derivation itself. The derivation is covered by the node-environment vector tests.
 */
//the sync now checks that the canonical phrase derives to the EOA before it sends. Derivation does not run in the jsdom realm
// (see mnemonicEoaCrossImpl.test.ts, node environment), so the one public test phrase is mapped to its public EOA here. Only this phrase.
jest.mock('./shellLegacyIdbInit', () => {
	const actual = jest.requireActual('./shellLegacyIdbInit')
	return {
		...actual,
		mnemonicEoa: (p: unknown) =>
			typeof p === 'string' && p.trim() === 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
				? '0x9858effd232b4033e47d90003d41ec34ecaeda94'
				: '',
	}
})

import { createShellMnemonicSync, SHELL_MNEMONIC_SYNC_COMMAND } from './shellMnemonicSync'
import { mapSyncReply, pwaWalletSyncTransportAvailable, sendNativeMnemonicPreread, sendPwaWalletSync } from './pwaWalletSyncTransport'
import { getShellSyncState, resetShellSyncStatus } from './shellSyncStatus'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const ORIGIN = window.location.origin

type Envelope = { ok: true; result: Record<string, unknown> } | { ok: false; error: string; reason?: string } | 'silent'
type Req = { type: string; reqId: number; seq?: number; eoa?: string; phrase?: string }

let sent: Req[] = []
/** The fake shell: `script(req, n)` returns the envelope for the n-th request. Every request is recorded. */
function installShell(script: (req: Req, n: number) => Envelope, allowedOrigins: string[] = [ORIGIN]) {
	sent = []
	const host: { postMessage: (raw: string) => void; onmessage: ((ev: { data: string }) => void) | null; allowedOrigins: string[] } = {
		allowedOrigins,
		onmessage: null,
		postMessage: (raw: string) => {
			const req = JSON.parse(raw) as Req
			sent.push(req)
			const reply = script(req, sent.length)
			if (reply === 'silent') return
			host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: req.reqId, ...reply }) })
		},
	}
	;(window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord = host
}

const removeShell = () => {
	delete (window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord
}

const noWait = async () => undefined
/** The production sender and re-read with the fast retry policy (the shipped policy is 2 s, 10 s, 30 s). */
function syncOverRealBridge() {
	return createShellMnemonicSync({
		send: (command, txId, mnemonic, eoa) => sendPwaWalletSync(command, txId, mnemonic, eoa),
		reread: (seq) => sendNativeMnemonicPreread(seq),
		retryDelaysMs: [1, 1, 1],
		wait: noWait,
		log: () => undefined,
		bridgeAvailable: () => pwaWalletSyncTransportAvailable(),
	})
}

const OK_UPDATED: Envelope = { ok: true, result: { sync: 'updated' } }
const OK_IDEMPOTENT: Envelope = { ok: true, result: { sync: 'idempotent' } }
const fail = (error: string, reason?: string): Envelope => ({ ok: false, error, ...(reason ? { reason } : {}) })

beforeEach(() => {
	resetShellSyncStatus()
	removeShell()
	sent = []
})
afterAll(() => removeShell())

describe('pwaWalletSync request and reply mapping', () => {
	it('the request is {type, reqId, eoa, phrase, seq}; updated is ok; the state is synced', async () => {
		installShell(() => OK_UPDATED)
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'synced', tx: 1 })
		expect(sent.length).toBe(1)
		expect(Object.keys(sent[0]).sort()).toEqual(['eoa', 'phrase', 'reqId', 'seq', 'type'])
		expect(sent[0].type).toBe(SHELL_MNEMONIC_SYNC_COMMAND)
		expect(sent[0].seq).toBe(1)
		expect(sent[0].eoa).toBe(EOA)
		expect(sent[0].phrase).toBe(PHRASE)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('idempotent (same account, same phrase) is ok as well; the state stays synced', async () => {
		installShell(() => OK_IDEMPOTENT)
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'synced', tx: 1 })
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('write_failed with reason internal_state: one attempt, no automatic retry; retryable; the reason is kept (PHRASE_ONLY: the native side keeps answering the same)', async () => {
		installShell((req) => (req.type === 'nativeMnemonicPreread' ? { ok: true, result: { state: 'valid' } } : fail('write_failed', 'internal_state')))
		const out = await syncOverRealBridge().sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND).length).toBe(1)
		expect(sent.filter((r) => r.type === 'nativeMnemonicPreread').length).toBe(0)
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'internal_state' })
	})

	it('write_failed with reason storage_write is kept as storage_write', async () => {
		installShell((req) => (req.type === 'nativeMnemonicPreread' ? { ok: true, result: { state: 'absent' } } : fail('write_failed', 'storage_write')))
		const out = await syncOverRealBridge().sync(PHRASE, EOA)
		expect(out).toMatchObject({ kind: 'failed', code: 'write_failed', reason: 'storage_write', retryable: true })
	})

	it('a transport retry of the same transaction reuses its reqId and seq (the same request)', async () => {
		installShell(() => fail('readback_failed'))
		await syncOverRealBridge().sync(PHRASE, EOA)
		const writes = sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND)
		expect(writes.length).toBe(4)
		expect(new Set(writes.map((r) => r.reqId)).size).toBe(1)
		expect(new Set(writes.map((r) => r.seq)).size).toBe(1)
	})

	it('a user retry after a failed write re-reads first; unknown holds: no pwaWalletSync is sent and the page keeps the failure', async () => {
		let preread: 'unknown' | 'valid' = 'valid'
		installShell((req) => (req.type === 'nativeMnemonicPreread' ? { ok: true, result: { state: preread } } : fail('write_failed', 'internal_state')))
		const sync = syncOverRealBridge()
		expect((await sync.sync(PHRASE, EOA)).kind).toBe('failed')
		expect(sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND).length).toBe(1)
		preread = 'unknown'
		expect(await sync.sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 2, code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND).length).toBe(1)
		expect(sent.filter((r) => r.type === 'nativeMnemonicPreread').length).toBe(1)
	})

	it('PHRASE_ONLY (E5.1): every pwaWalletSync answers write_failed/internal_state; one attempt each, no automatic retry; the same account is never ok; the state is the native-unavailable failure, never syncing', async () => {
		installShell((req) => (req.type === 'nativeMnemonicPreread' ? { ok: true, result: { state: 'valid' } } : fail('write_failed', 'internal_state')))
		const sync = syncOverRealBridge()
		expect(await sync.sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND).length).toBe(1)
		// a user retry (a new sync) re-reads, sends once more and fails the same way: nothing is reported as synced
		expect(await sync.sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 2, code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(sent.filter((r) => r.type === SHELL_MNEMONIC_SYNC_COMMAND).length).toBe(2)
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'internal_state' })
		expect(getShellSyncState().kind).not.toBe('syncing')
	})

	it('only the first ack for a reqId counts: a second reply with the same reqId is ignored; the caller sees the first result', async () => {
		// a host that answers the same request twice: a refusal first (the shell\'s own), then an ok that must not be read
		const host: { postMessage: (raw: string) => void; onmessage: ((ev: { data: string }) => void) | null; allowedOrigins: string[] } = {
			allowedOrigins: [ORIGIN],
			onmessage: null,
			postMessage: (raw: string) => {
				const req = JSON.parse(raw) as Req
				sent.push(req)
				host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: req.reqId, ok: false, error: 'stale_seq' }) })
				host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: req.reqId, ok: true, result: { sync: 'updated' } }) })
			},
		}
		;(window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord = host
		const out = await sendPwaWalletSync(SHELL_MNEMONIC_SYNC_COMMAND, 7, PHRASE, EOA)
		expect(out).toEqual({ code: 'stale_seq' })
		expect(sent.length).toBe(1)
	})

	it('key_over_bridge_refused: not retried, failed and not retryable', async () => {
		installShell(() => fail('key_over_bridge_refused'))
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'key_over_bridge_refused', retryable: false })
		expect(sent.length).toBe(1)
	})

	it('untrusted_source and bad_request: not retried, failed and not retryable', async () => {
		for (const code of ['untrusted_source', 'bad_request'] as const) {
			installShell(() => fail(code))
			expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code, retryable: false })
			expect(sent.length).toBe(1)
			resetShellSyncStatus()
		}
	})

	it('stale_seq while this is the latest transaction: a retryable unconfirmed state (not superseded, not syncing); the page shows it', async () => {
		installShell(() => fail('stale_seq'))
		const out = await syncOverRealBridge().sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'stale_seq', retryable: true })
		expect(sent.length).toBe(1)
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'stale_seq', retryable: true })
		expect(getShellSyncState().kind).not.toBe('syncing')
	})


	it('an ok reply without result.sync is not a success: no_answer, retryable', async () => {
		installShell(() => ({ ok: true, result: {} }))
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'no_answer', retryable: true })
	})

	it('an unknown error text is not a wire code: no_answer, retryable', async () => {
		installShell(() => fail('readback_failed'))
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toMatchObject({ kind: 'failed', code: 'no_answer', retryable: true })
	})

	it('a shell with no usable channel: unavailable at the start (no request); a sync with no answer is retryable', async () => {
		;(window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord = { allowedOrigins: [ORIGIN] }
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'no_answer', retryable: true })
		expect(sent.length).toBe(0)
	})

	it('a page origin the shell does not allow: nothing is sent; untrusted_source, not retried', async () => {
		installShell(() => OK_UPDATED, ['https://not-this-page.example'])
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'untrusted_source', retryable: false })
		expect(sent.length).toBe(0)
	})

	it('a browser (no shell channel): unavailable, nothing is sent, the state is not changed', async () => {
		expect(await syncOverRealBridge().sync(PHRASE, EOA)).toEqual({ kind: 'unavailable', tx: 1 })
		expect(getShellSyncState()).toEqual({ kind: 'idle' })
	})

	it('a malformed request is never sent: bad_request without a request (bad seq, bad eoa, bad phrase)', async () => {
		installShell(() => OK_UPDATED)
		expect(await sendPwaWalletSync(SHELL_MNEMONIC_SYNC_COMMAND, 0, PHRASE, EOA)).toEqual({ code: 'bad_request' })
		expect(await sendPwaWalletSync(SHELL_MNEMONIC_SYNC_COMMAND, 1, PHRASE, '0xABC')).toEqual({ code: 'bad_request' })
		expect(await sendPwaWalletSync(SHELL_MNEMONIC_SYNC_COMMAND, 1, 'Not A Phrase!', EOA)).toEqual({ code: 'bad_request' })
		expect(sent.length).toBe(0)
	})
})

describe('nativeMnemonicPreread (valid | absent | unknown; anything else is unknown)', () => {
	it('valid, absent and unknown map as the shell states; a missing state is unknown', async () => {
		installShell((req) => ({ ok: true, result: { state: req.seq === 1 ? 'valid' : req.seq === 2 ? 'absent' : undefined } }) as Envelope)
		expect(await sendNativeMnemonicPreread(1)).toBe('valid')
		expect(await sendNativeMnemonicPreread(2)).toBe('absent')
		expect(await sendNativeMnemonicPreread(9)).toBe('unknown')
	})

	it('a refused or silent preread is unknown', async () => {
		installShell(() => fail('untrusted_source'))
		expect(await sendNativeMnemonicPreread(4)).toBe('unknown')
		installShell(() => 'silent')
		removeShell()
		expect(await sendNativeMnemonicPreread(5)).toBe('unknown')
	})
})

describe('mapSyncReply (the closed wire set)', () => {
	it('maps each wire answer; write_failed without a reason is internal_state', () => {
		expect(mapSyncReply({ ok: true, result: { sync: 'updated' } })).toEqual({ code: 'ok' })
		expect(mapSyncReply({ ok: true, result: { sync: 'idempotent' } })).toEqual({ code: 'ok' })
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'storage_write' })).toEqual({ code: 'write_failed', reason: 'storage_write' })
		expect(mapSyncReply({ ok: false, error: 'write_failed' })).toEqual({ code: 'write_failed', reason: 'internal_state' })
		expect(mapSyncReply({ ok: false, error: 'key_over_bridge_refused' })).toEqual({ code: 'key_over_bridge_refused' })
		expect(mapSyncReply({ ok: true, result: { sync: 'other' } })).toEqual({ code: 'no_answer' })
	})
})
