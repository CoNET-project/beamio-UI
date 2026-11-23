/**
 * Unit g (rev 2, runtime): a native passcode_not_provided write is a pending sync: kept, not counted, not a failure, and flushed once the passcode is
 * provided. The harness is the one of shellRecordStore.defer.test.ts (synthetic record, the bridge is mocked).
 *
 * a write the store does not take (migrating, or a conflict) is kept as an intent: the
 * page's change as field-level operations against the store state it read. It is never written back as it was. Once a read answers
 * ok, the change is applied to the record just read at its current revision. A field both sides changed keeps the page's edit when it
 * is page-editable, otherwise the store's value; the conflict is logged by field name only. The persisted intent holds the
 * change only, never the chat history or a key; on a storage quota it is held in memory and the pending notice shows.
 */
import { publishNativePwaLog } from '../utils/cashTreesNativePwaLog'
import { pendingServerSyncNoticeVisible, resetPendingServerSyncForTest } from './pendingServerSync'
import { applyDelta, changesOf, DEFERRED_WRITE_KEY, deferredWriteForTest, knownRevForTest, resetShellRecordForTest, resumeDeferredWrite, shellRecordRead, shellRecordWrite } from './shellRecordStore'
import { backoffDelayMs } from './retryBackoff'
import { sendShellRecordCommand } from './shellRecordTransport'

jest.mock('./nativeChatRouteRegister', () => ({
	nextReqId: jest.fn(() => 1),
}))
jest.mock('./shellRecordTransport', () => ({
	sendShellRecordCommand: jest.fn(),
}))
jest.mock('../utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: jest.fn(),
}))


const ADDR = '0x1563915e194D8CfBA1943570603F7606A3115508'
const PEER = '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB'
const KEY = '0x' + '2'.repeat(64)

type Loose = Record<string, any>
const readOkWith = (record: Loose) => ({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'ok', rev: (record as { rev?: number }).rev, record } } })
const writeOkWith = (rev: number) => ({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'ok', rev } } })
const conflictAnswer = { kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'conflict', currentRev: 9 } } }
const migrating = { kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'migrating' } } }

const base = (): Loose => ({
	rev: 4,
	schemaVersion: 2,
	profiles: [{ keyID: ADDR, privateKeyArmor: KEY, accountName: 'Old', chats: [] }],
	beamio: { accountName: 'Old', firstName: 'Old', language: 'zh-CN' },
})
/** The store's record after the migration imported the account name and a chat history. */
const imported = (): Loose => ({
	rev: 5,
	schemaVersion: 2,
	profiles: [{ keyID: ADDR, privateKeyArmor: KEY, accountName: 'Imported', chats: [{ address: PEER, messages: [{ text: 'hi' }] }] }],
	beamio: { accountName: 'Imported', firstName: 'Imported', language: 'zh-CN' },
})
/** The page's own change made during the migration: only the language. */
const pageChange = (): Loose => {
	const r = base()
	r.beamio.language = 'en'
	return r
}

const flush = async () => {
	for (let i = 0; i < 60; i++) await Promise.resolve()
}

const sentWrites = (): Loose[] =>
	(sendShellRecordCommand as jest.Mock).mock.calls.map((c) => c[0] as Loose).filter((c) => c.type === 'shellRecordWrite')

beforeEach(() => {
	resetShellRecordForTest()
	resetPendingServerSyncForTest()
	;(sendShellRecordCommand as jest.Mock).mockReset()
	;(publishNativePwaLog as jest.Mock).mockReset()
	window.localStorage.clear()
})

/** Starts a deferral: the page reads `base`, then writes `change` while the store is migrating. */
async function defer(change: Loose): Promise<void> {
	;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
	await shellRecordRead()
	;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(migrating)
	await shellRecordWrite(change)
}

const passcodeNotReady = { kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'not_ready', notReadyReason: 'passcode_not_provided' } } }

describe('unit g runtime: a passcode_not_provided write is a pending sync and is flushed after the passcode', () => {
	it('kept and not counted while the passcode is missing; the flush writes once the passcode is provided', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			const before = deferredWriteForTest()!
			expect(before).not.toBeNull()
			const attemptsBefore = before.attempts
			// the timed flush reads ok, then the write answers passcode_not_provided
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())).mockResolvedValueOnce(passcodeNotReady)
			jest.advanceTimersByTime(3000)
			await flush()
			const kept = deferredWriteForTest()
			expect(kept).not.toBeNull() // the intent is kept
			expect(kept!.attempts).toBe(attemptsBefore) // not counted: not an exhausted retry
			expect(kept!.refused).toBeUndefined() // not a refusal
			expect(kept!.exhausted).toBeFalsy()
			expect(kept!.notReady).toBeUndefined() // not the not_ready ceiling
			const writesWhileMissing = sentWrites().length
			// the passcode is provided: the read and the write answer ok, and the flush runs now
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())).mockResolvedValueOnce(writeOkWith(5))
			resumeDeferredWrite()
			jest.advanceTimersByTime(120_000)
			await flush()
			expect(sentWrites().length).toBeGreaterThan(writesWhileMissing) // the flush really executed
			expect(sentWrites().at(-1)!.record.beamio.language).toBe('en')
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})
})
