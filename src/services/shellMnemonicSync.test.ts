/**
 * rule 2026-11-16 (1502): page-to-shell mnemonic sync. Stub bridge only; the command name is a placeholder until .
 *the reply is a closed code (ok, stale_seq, write_failed, untrusted_source, bad_request; no_answer for a throw).
 * SYNTHETIC values only (the phrase is the public BIP-39 test vector, not an account).
 */
import { createShellMnemonicSync, SHELL_MNEMONIC_SYNC_COMMAND } from './shellMnemonicSync'
import { getShellSyncState, resetShellSyncStatus } from './shellSyncStatus'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const noWait = async () => undefined

function harness(send: jest.Mock, bridge = true) {
	const logs: string[] = []
	const sync = createShellMnemonicSync({
		send,
		retryDelaysMs: [1, 1, 1],
		wait: noWait,
		log: (m) => logs.push(m),
		bridgeAvailable: () => bridge,
	})
	return { sync, logs }
}

beforeEach(() => resetShellSyncStatus())

describe('page-to-shell mnemonic sync (stub bridge, placeholder command)', () => {
	it('a confirmed reply (ok) ends the sync as synced, with the placeholder command and a transaction number', async () => {
		const send = jest.fn(async () => 'ok' as const)
		const { sync } = harness(send)
		const out = await sync.sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'synced', tx: 1 })
		expect(send).toHaveBeenCalledTimes(1)
		expect((send.mock.calls[0] as unknown[])[0]).toBe(SHELL_MNEMONIC_SYNC_COMMAND)
		expect((send.mock.calls[0] as unknown[])[1]).toBe(1)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('same account again is idempotent: a second sync is a second transaction with the same payload, and the state stays synced', async () => {
		const send = jest.fn(async () => 'ok' as const)
		const { sync } = harness(send)
		await sync.sync(PHRASE, EOA)
		const second = await sync.sync(PHRASE, EOA)
		expect(second).toEqual({ kind: 'synced', tx: 2 })
		expect(send.mock.calls[0].slice(2)).toEqual(send.mock.calls[1].slice(2))
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('a transient failure (no answer, a throw) is retried and then confirmed; the sync never throws into the route', async () => {
		const send = jest
			.fn<Promise<'ok' | 'no_answer'>, []>()
			.mockResolvedValueOnce('no_answer')
			.mockRejectedValueOnce(new Error('bridge down'))
			.mockResolvedValueOnce('ok')
		const { sync, logs } = harness(send as unknown as jest.Mock)
		const out = await sync.sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'synced', tx: 1 })
		expect(send).toHaveBeenCalledTimes(3)
		expect(logs.length).toBe(2)
	})

	it('write_failed: a single attempt (no automatic retry), failed, retryable, with the code; the state shows it', async () => {
		const send = jest.fn(async () => 'write_failed' as const)
		const { sync } = harness(send)
		const out = await sync.sync(PHRASE, EOA)
		expect(out).toEqual({ kind: 'failed', tx: 1, code: 'write_failed', retryable: true })
		expect(send).toHaveBeenCalledTimes(1)
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'write_failed', retryable: true })
	})

	it('untrusted_source and bad_request are not retried: failed, not retryable', async () => {
		for (const code of ['untrusted_source', 'bad_request'] as const) {
			const send = jest.fn(async () => code)
			const { sync } = harness(send)
			const out = await sync.sync(PHRASE, EOA)
			expect(out).toEqual({ kind: 'failed', tx: 1, code, retryable: false })
			expect(send).toHaveBeenCalledTimes(1)
			expect(getShellSyncState()).toEqual({ kind: 'failed', code, retryable: false })
		}
	})

	it('stale_seq while this is the latest transaction: a retryable unconfirmed state, and the status says so (not syncing)', async () => {
		const send = jest.fn(async () => 'stale_seq' as const)
		const { sync } = harness(send)
		expect(await sync.sync(PHRASE, EOA)).toEqual({ kind: 'failed', tx: 1, code: 'stale_seq', retryable: true })
		expect(send).toHaveBeenCalledTimes(1)
		expect(getShellSyncState()).toEqual({ kind: 'failed', code: 'stale_seq', retryable: true })
	})

	it('a late reply to an older transaction is discarded when a newer transaction has started', async () => {
		let releaseOld: (v: 'ok') => void = () => undefined
		const send = jest
			.fn()
			.mockImplementationOnce(() => new Promise<'ok'>((resolve) => { releaseOld = resolve }))
			.mockResolvedValueOnce('ok')
		const { sync } = harness(send)
		const oldSync = sync.sync(PHRASE, EOA)
		const newSync = await sync.sync(PHRASE, EOA)
		expect(newSync).toEqual({ kind: 'synced', tx: 2 })
		releaseOld('ok')
		expect(await oldSync).toEqual({ kind: 'superseded', tx: 1 })
	})

	it('review b: a remount (a new sync instance, the ref cleared) sends the same pair again; the native answers idempotent (ok): confirmed, no error', async () => {
		// the page's send-once ref is per page session; a remount may send the same pair again. The native side answers an identical request
		// (same seq and content) with idempotent, which the transport maps to ok, and writes nothing twice (dependency noted in AppEntryGate).
		const first = jest.fn(async () => 'ok' as const)
		const { sync: beforeRemount } = harness(first)
		expect(await beforeRemount.sync(PHRASE, EOA)).toEqual({ kind: 'synced', tx: 1 })
		const again = jest.fn(async () => 'ok' as const)
		const { sync: afterRemount } = harness(again)
		expect(await afterRemount.sync(PHRASE, EOA)).toEqual({ kind: 'synced', tx: 1 })
		expect(again).toHaveBeenCalledTimes(1)
		expect(getShellSyncState()).toEqual({ kind: 'synced' })
	})

	it('no bridge (a browser build): no call is made, the outcome is unavailable and the state is not changed', async () => {
		const send = jest.fn(async () => 'ok' as const)
		const { sync } = harness(send, false)
		expect(await sync.sync(PHRASE, EOA)).toEqual({ kind: 'unavailable', tx: 1 })
		expect(send).not.toHaveBeenCalled()
		expect(getShellSyncState()).toEqual({ kind: 'idle' })
	})

	it('log lines never carry the mnemonic or the EOA', async () => {
		const send = jest.fn(async () => 'write_failed' as const)
		const { sync, logs } = harness(send)
		await sync.sync(PHRASE, EOA)
		for (const line of logs) {
			expect(line).not.toContain('abandon')
			expect(line.toLowerCase()).not.toContain(EOA)
		}
	})
})
