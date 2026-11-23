/**
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

describe('migrating writes wait for a successful read', () => {
	it('a write before any read is refused (no bridge call)', async () => {
		await expect(shellRecordWrite({ profiles: [{ keyID: ADDR }] })).rejects.toThrow('not_read')
		expect(sendShellRecordCommand).not.toHaveBeenCalled()
	})

	it('a write answered with migrating is deferred, then sent after a read answers ok again (the page change applied)', async () => {
		jest.useFakeTimers()
		try {
			await defer({ ...pageChange(), note: 'latest' })
			expect(sendShellRecordCommand).toHaveBeenCalledTimes(2)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())).mockResolvedValueOnce(writeOkWith(5))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(sendShellRecordCommand).toHaveBeenCalledTimes(4)
			const sent = sentWrites().at(-1)!
			// only the page-editable fields are written; a field outside them is not sent.
			expect(sent.record.note).toBeUndefined()
			expect(sent.record.beamio.language).toBe('en')
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('a deferred write never overwrites imported data with the page copy', () => {
	it('the imported account name and chat history survive; the page change is applied on top of the record just read', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush()
			const sent = sentWrites().at(-1)!
			expect(sent.record.rev).toBe(5) // the store's current revision, not the page's old one
			expect(sent.record.profiles[0].accountName).toBe('Imported')
			expect(sent.record.profiles[0].chats).toEqual([{ address: PEER, messages: [{ text: 'hi' }] }])
			expect(sent.record.beamio.accountName).toBe('Imported')
			expect(sent.record.beamio.language).toBe('en')
			expect(JSON.stringify(sent.record)).not.toContain('"accountName":"Old"')
			expect(JSON.stringify(sent.record)).not.toContain(KEY) // the write never carries the EOA key
		} finally {
			jest.useRealTimers()
		}
	})

	it('a conflict keeps the intent: it is applied to a new read and sent after a backoff, not dropped', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(conflictAnswer)
			jest.advanceTimersByTime(3000)
			await flush()
			expect(deferredWriteForTest()).not.toBeNull()
			expect(deferredWriteForTest()!.attempts).toBe(1)
			const newer = { ...imported(), rev: 9 }
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(newer)).mockResolvedValueOnce(writeOkWith(10))
			jest.advanceTimersByTime(backoffDelayMs(3000, 1))
			await flush()
			expect(deferredWriteForTest()).toBeNull()
			expect(sentWrites().at(-1)!.record.profiles[0].accountName).toBe('Imported')
			expect(sentWrites().at(-1)!.record.beamio.language).toBe('en')
		} finally {
			jest.useRealTimers()
		}
	})

	it('a successful page write supersedes an older intent (the intent is not replayed later)', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			expect(deferredWriteForTest()).not.toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(writeOkWith(6))
			await shellRecordWrite(pageChange())
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('a field both sides changed', () => {
	it('a page-editable field keeps the page edit made during the migration; the log names the field, never the value', async () => {
		jest.useFakeTimers()
		try {
			const edited = base()
			edited.beamio.firstName = 'Mine'
			await defer(edited)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(sentWrites().at(-1)!.record.beamio.firstName).toBe('Mine')
			const logged = (publishNativePwaLog as jest.Mock).mock.calls.map((c) => String(c[1])).join('\n')
			expect(logged).toContain('beamio.firstName(page)')
			expect(logged).not.toContain('Mine')
			expect(logged).not.toContain('Imported')
		} finally {
			jest.useRealTimers()
		}
	})

	it('a field that is not page-editable is not written by the page; the store keeps its value, and the log names the path only', async () => {
		jest.useFakeTimers()
		try {
			const edited = pageChange() // an editable change makes the save; the non-editable one rides along
			edited.profiles[0].accountName = 'PageSide'
			await defer(edited)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(sentWrites().at(-1)!.record.profiles[0].accountName).toBe('Imported')
			const logged = (publishNativePwaLog as jest.Mock).mock.calls.map((c) => String(c[1])).join('\n')
			expect(logged).toContain('accountName')
			expect(logged).not.toContain('PageSide')
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('the persisted intent is the change only; a quota keeps it in memory with the notice', () => {
	it('the persisted intent holds the changed field, not the chat history, and no key', async () => {
		// The page read a record that already has a chat history; the page changes only the language.
		const withHistory = base()
		withHistory.profiles[0].chats = [{ address: PEER, messages: [{ text: 'OLD-HISTORY-TEXT' }] }]
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withHistory))
		await shellRecordRead()
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(migrating)
		await shellRecordWrite({ ...withHistory, beamio: { ...withHistory.beamio, language: 'en' } })
		const persisted = window.localStorage.getItem(DEFERRED_WRITE_KEY) as string
		expect(persisted).not.toBeNull()
		expect(persisted).toContain('language')
		expect(persisted).not.toContain('OLD-HISTORY-TEXT')
		expect(persisted).not.toContain(KEY)
		expect(persisted).not.toContain('privateKeyArmor')
	})

	it('a restart replays the persisted change onto the record read after it', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			resetShellRecordForTest(true) // restart: memory gone, storage kept
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			await shellRecordRead()
			jest.advanceTimersByTime(3000)
			await flush()
			const sent = sentWrites().at(-1)!
			expect(sent.record.profiles[0].accountName).toBe('Imported')
			expect(sent.record.beamio.language).toBe('en')
			expect(window.localStorage.getItem(DEFERRED_WRITE_KEY)).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	it('a storage quota keeps the intent in memory only and shows the pending notice; the notice goes when it is written', async () => {
		jest.useFakeTimers()
		const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError')
		})
		try {
			await defer(pageChange())
			expect(deferredWriteForTest()).not.toBeNull()
			expect(window.localStorage.getItem(DEFERRED_WRITE_KEY)).toBeNull()
			expect(pendingServerSyncNoticeVisible()).toBe(true)
			spy.mockRestore()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(deferredWriteForTest()).toBeNull()
			expect(pendingServerSyncNoticeVisible()).toBe(false)
		} finally {
			spy.mockRestore()
			jest.useRealTimers()
		}
	})
})

describe('the retry never gives up', () => {
	it('twelve migrating answers in a row: the intent is kept and the wait grows', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			for (let n = 0; n < 12; n++) {
				;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(migrating)
				jest.advanceTimersByTime(backoffDelayMs(3000, n))
				await flush()
			}
			expect(deferredWriteForTest()).not.toBeNull()
			expect(deferredWriteForTest()!.attempts).toBe(12)
			expect(backoffDelayMs(3000, 12)).toBeLessThanOrEqual(5 * 60_000)
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('the delta and the merge of keyed items and lists', () => {
	it('the page change is only the changed field: an unchanged profile is not in the delta', () => {
		const ops = changesOf(base(), pageChange())
		expect(ops).toEqual([{ k: 'set', p: ['beamio', 'language'], bh: true, b: 'zh-CN', vh: true, v: 'en' }])
	})

	it('a message the page added and a message the store added to the same chat are both kept', () => {
		const chat = (messages: Loose[]) => ({ address: PEER, messages })
		const b = { profiles: [{ keyID: ADDR, chats: [chat([{ text: 'm1' }])] }] }
		const ours = { profiles: [{ keyID: ADDR, chats: [chat([{ text: 'm1' }, { text: 'm2' }])] }] }
		const fresh = { profiles: [{ keyID: ADDR, chats: [chat([{ text: 'm1' }, { text: 'm3' }])] }] }
		const out = applyDelta(fresh, changesOf(b, ours)).record as Loose
		expect(out.profiles[0].chats[0].messages).toEqual([{ text: 'm1' }, { text: 'm3' }, { text: 'm2' }])
	})

	it('a chat the page removed is removed even when the store changed it', () => {
		const a = { address: '0x' + 'a'.repeat(40), messages: [] as Loose[] }
		const c = { address: '0x' + 'c'.repeat(40), messages: [] as Loose[] }
		const b = { profiles: [{ keyID: ADDR, chats: [a, c] }] }
		const ours = { profiles: [{ keyID: ADDR, chats: [a] }] }
		const fresh = { profiles: [{ keyID: ADDR, chats: [c, { ...a, messages: [{ text: 'imported' }] }] }] }
		const out = applyDelta(fresh, changesOf(b, ours)).record as Loose
		expect(out.profiles[0].chats.map((x: Loose) => x.address)).toEqual([a.address])
	})

	it('an empty delta leaves the record just read unchanged', () => {
		const fresh = imported()
		const out = applyDelta(fresh, changesOf(base(), base())).record
		expect(out).toEqual(fresh)
	})
})

describe('the save basis, the editable write, the blocked write after a timeout, the resume, the reply timeout', () => {
	it('a probe read (the pre-save read) does not move the copy basis; the save is checked against the revision the copy was made on', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
		await shellRecordRead()
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith({ ...base(), rev: 7 }))
		await shellRecordRead({ probe: true })
		expect(knownRevForTest()).toBe(4)
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(8))
		jest.useFakeTimers()
		try {
			await shellRecordWrite(pageChange())
			expect(sentWrites()[0].record.rev).toBe(4) // the write carries the copy's revision, not the probe's
			expect(deferredWriteForTest()).not.toBeNull() // the conflict is kept as an intent
		} finally {
			jest.useRealTimers()
		}
	})

	it('the write keeps the native-owned chats and profile fields; only the page-editable fields change', async () => {
		const native = base()
		native.profiles[0].chats = [{ address: PEER, messages: [{ text: 'NATIVE-CHAT' }] }]
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(native))
		await shellRecordRead()
		const seed = JSON.parse(JSON.stringify(native)) as Loose
		seed.profiles[0].chats = [{ address: PEER, messages: [{ text: 'SEED-COPY' }] }]
		seed.beamio.language = 'en'
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(writeOkWith(5))
		await shellRecordWrite(seed)
		const sent = sentWrites().at(-1)!
		expect(sent.record.beamio.language).toBe('en')
		expect(sent.record.rev).toBe(4)
		expect(JSON.stringify(sent.record)).toContain('NATIVE-CHAT')
		expect(JSON.stringify(sent.record)).not.toContain('SEED-COPY')
	})

	it('after a write with no answer nothing is written until a read has answered ok or absent', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			await shellRecordRead()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'timeout' })
			await shellRecordWrite(pageChange())
			const writesAfterTimeout = sentWrites().length
			expect(writesAfterTimeout).toBe(1)
			await shellRecordWrite({ ...pageChange(), beamio: { ...pageChange().beamio, firstName: 'Second' } })
			expect(sentWrites().length).toBe(writesAfterTimeout) // blocked: no second write
			expect(deferredWriteForTest()).not.toBeNull()
			// A read that answers ok completes the read; the retry then writes the change on the record just read.
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			await shellRecordRead({ probe: true })
			jest.advanceTimersByTime(3000)
			await flush()
			const sent = sentWrites().at(-1)!
			expect(sent.record.beamio.firstName).toBe('Second')
			expect(sent.record.beamio.language).toBe('en')
			expect(sent.record.profiles[0].accountName).toBe('Imported')
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	it('a persisted intent resumes without any storage read (the native wallet is ready at start)', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			await shellRecordRead()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(migrating)
			await shellRecordWrite(pageChange())
			resetShellRecordForTest(true) // restart: memory gone, storage kept; no read follows
			resumeDeferredWrite()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(sentWrites().at(-1)!.record.beamio.language).toBe('en')
			expect(window.localStorage.getItem(DEFERRED_WRITE_KEY)).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	// 0.53.44: only the record read waits 30 s for its reply; writes keep 10 s
	it('a record read waits up to 30 seconds for its reply (a reply inside that window is taken)', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
		await shellRecordRead()
		expect((sendShellRecordCommand as jest.Mock).mock.calls[0][1]).toBe(30_000)
	})

	it('accountName is the registered BeamioTag, not page-editable: a page change to it is not written; the editable change is', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
		await shellRecordRead()
		const edited = pageChange()
		edited.beamio.accountName = 'PageHandle'
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(writeOkWith(5))
		await shellRecordWrite(edited)
		const sent = sentWrites().at(-1)!
		expect(sent.record.beamio.accountName).toBe('Old')
		expect(sent.record.beamio.language).toBe('en')
		expect(JSON.stringify(sent.record)).not.toContain('PageHandle')
	})
})

describe('the save does not overwrite imported data, keeps the intent, and removes only what the user removed', () => {
	const CA = '0x' + 'a'.repeat(40)
	const CB = '0x' + 'b'.repeat(40)
	const CC = '0x' + 'c'.repeat(40)
	const withChats = (rev: number, chats: Loose[]): Loose => {
		const r = base()
		r.rev = rev
		r.profiles[0].chats = chats
		return r
	}

	it('a verification read after an import does not move the copy basis; a save of the stale copy is checked at the copy revision', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			await shellRecordRead() // the startup read builds the copy (rev 4)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())) // the import: store rev 5
			await shellRecordRead({ probe: true }) // the verification read
			expect(knownRevForTest()).toBe(4)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(pageChange()) // the stale copy: firstName 'Old', language edited
			expect(sentWrites().at(-1)!.record.rev).toBe(4)
			expect(deferredWriteForTest()).not.toBeNull()
			expect(deferredWriteForTest()!.ops.map((op) => op.p.join('.'))).toEqual(['beamio.language'])
		} finally {
			jest.useRealTimers()
		}
	})

	it('after a deferred write is applied to the record just read, a save of the same stale copy is still checked at the copy revision', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // migrating: the intent is the language change (basis rev 4)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush() // the rebase is accepted at rev 6
			expect(deferredWriteForTest()).toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(pageChange()) // the stale copy again
			expect(sentWrites().at(-1)!.record.rev).toBe(4)
			expect(deferredWriteForTest()!.ops.map((op) => op.p.join('.'))).toEqual(['beamio.language'])
		} finally {
			jest.useRealTimers()
		}
	})

	it('a save whose copy equals the basis clears an intent the user reverted; it is not replayed later', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			expect(deferredWriteForTest()).not.toBeNull()
			const calls = (sendShellRecordCommand as jest.Mock).mock.calls.length
			await shellRecordWrite(base()) // the language is back to zh-CN: no change against the basis
			expect(deferredWriteForTest()).toBeNull()
			expect((sendShellRecordCommand as jest.Mock).mock.calls.length).toBe(calls)
		} finally {
			jest.useRealTimers()
		}
	})

	it('deleting a chat is written from a freshly read record at its revision; the new chat and messages the store added are kept', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CA, messages: [{ text: 'm1' }] }, { address: CC, messages: [{ text: 'm2' }] }])))
			await shellRecordRead()
			const storeNow = withChats(5, [
				// b: a message the store added to the deleted chat goes with that chat (the user deleted the chat).
				{ address: CA, messages: [{ text: 'm1' }, { text: 'm9' }] },
				// kept: another chat, and its new message
				{ address: CC, messages: [{ text: 'm2' }, { text: 'm3' }] },
				// kept: a chat the store added
				{ address: CB, messages: [{ text: 'new' }] },
			])
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(storeNow)).mockResolvedValueOnce(writeOkWith(6))
			await shellRecordWrite(withChats(4, [{ address: CC, messages: [{ text: 'm2' }] }])) // the user deleted chat A
			const writes = sentWrites()
			expect(writes.length).toBe(1)
			expect(writes[0].record.rev).toBe(5) // written on the record just read, not on the stale basis
			const chats = writes[0].record.profiles[0].chats as Loose[]
			expect(chats.map((c) => c.address)).toEqual([CC, CB])
			expect(chats[0].messages.map((m: Loose) => m.text)).toEqual(['m2', 'm3'])
			expect(chats[1].messages).toEqual([{ text: 'new' }])
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	it('a message the user removed is not written (messages are native-owned); the store keeps its messages and nothing is sent', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CC, messages: [{ text: 'm1' }, { text: 'm2' }] }])))
			await shellRecordRead()
			const calls = (sendShellRecordCommand as jest.Mock).mock.calls.length
			await shellRecordWrite(withChats(4, [{ address: CC, messages: [{ text: 'm1' }] }])) // the user deleted m2
			expect((sendShellRecordCommand as jest.Mock).mock.calls.length).toBe(calls)
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	it('deleting a chat with no store change is written at the freshly read revision, and only that chat goes', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CA, messages: [] }, { address: CC, messages: [] }])))
		await shellRecordRead()
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CA, messages: [] }, { address: CC, messages: [] }])))
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(writeOkWith(5))
		await shellRecordWrite(withChats(4, [{ address: CC, messages: [] }]))
		const sent = sentWrites().at(-1)!
		expect(sent.record.rev).toBe(4)
		expect((sent.record.profiles[0].chats as Loose[]).map((c) => c.address)).toEqual([CC])
	})

	it('a removal the store does not take is kept as an intent, and the retry applies it to the record just read', async () => {
		jest.useFakeTimers()
		try {
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CA, messages: [] }, { address: CC, messages: [] }])))
			await shellRecordRead()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(5, [{ address: CA, messages: [] }, { address: CC, messages: [] }, { address: CB, messages: [] }]))).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(withChats(4, [{ address: CC, messages: [] }]))
			expect(deferredWriteForTest()!.ops.map((op) => op.k)).toEqual(['rm'])
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(7, [{ address: CA, messages: [] }, { address: CC, messages: [] }, { address: CB, messages: [] }]))).mockResolvedValueOnce(writeOkWith(8))
			jest.advanceTimersByTime(3000)
			await flush()
			const chats = sentWrites().at(-1)!.record.profiles[0].chats as Loose[]
			expect(chats.map((c) => c.address)).toEqual([CC, CB])
			expect(deferredWriteForTest()).toBeNull()
		} finally {
			jest.useRealTimers()
		}
	})

	it('b: deleting a chat removes the messages the store added to that chat (intended); other chats keep theirs', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(withChats(4, [{ address: CA, messages: [{ text: 'm1' }] }, { address: CC, messages: [] }])))
		await shellRecordRead()
		;(sendShellRecordCommand as jest.Mock)
			.mockResolvedValueOnce(readOkWith(withChats(5, [{ address: CA, messages: [{ text: 'm1' }, { text: 'added-to-deleted' }] }, { address: CC, messages: [{ text: 'added-to-kept' }] }])))
			.mockResolvedValueOnce(writeOkWith(6))
		await shellRecordWrite(withChats(4, [{ address: CC, messages: [] }]))
		const chats = sentWrites().at(-1)!.record.profiles[0].chats as Loose[]
		expect(chats.map((c) => c.address)).toEqual([CC])
		expect(JSON.stringify(chats)).not.toContain('added-to-deleted')
		expect(JSON.stringify(chats)).toContain('added-to-kept') // the other chat keeps the store's content (taken from the record just read)
	})

	it('(repro): a revert of a change that the store already holds (merged after a conflict) is written as a real change', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // migrating: the language change is the intent (basis rev 4)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush() // the merge is accepted: the store now holds language 'en' (rev 6); the basis is still rev 4
			expect(deferredWriteForTest()).toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(base()) // the user reverts the language to zh-CN
			expect(deferredWriteForTest()).not.toBeNull() // the revert is kept, not dropped as "no change"
			const storeNow: Loose = { ...imported(), rev: 6 }
			storeNow.beamio = { ...(storeNow.beamio as Loose), language: 'en' }
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(storeNow)).mockResolvedValueOnce(writeOkWith(7))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(deferredWriteForTest()).toBeNull()
			expect(sentWrites().at(-1)!.record.beamio.language).toBe('zh-CN')
			expect(sentWrites().at(-1)!.record.rev).toBe(6)
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('the restart copy, the blocked revert, the user-action probe', () => {
	it('H1 (repro): after a restart the page copy carries the deferred change; a plain save keeps the intent', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // migrating: the language change is the intent (basis rev 4)
			resetShellRecordForTest(true) // restart: memory gone, the intent is persisted
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())) // the startup read: the store still says zh-CN
			const copy = await shellRecordRead()
			expect(copy.status).toBe('ok')
			if (copy.status !== 'ok') return
			expect((copy.record.beamio as Loose).language).toBe('en') // the copy the page holds includes the pending change
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(copy.record) // a plain save of that copy
			expect(deferredWriteForTest()).not.toBeNull() // the intent is kept, not cleared as "no change against the basis"
		} finally {
			jest.useRealTimers()
		}
	})

	it('repro: a revert made while a write is blocked is recorded and written on the retry', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // the language change is the intent (basis rev 4)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(imported())).mockResolvedValueOnce(writeOkWith(6))
			jest.advanceTimersByTime(3000)
			await flush() // the merge is accepted: the store holds language 'en' (rev 6)
			expect(deferredWriteForTest()).toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'timeout' })
			await shellRecordWrite(pageChange()) // the language change again: no answer, so writes are blocked
			expect(deferredWriteForTest()).not.toBeNull()
			await shellRecordWrite(base()) // the user reverts the language while blocked
			const intent = deferredWriteForTest()!.ops.find((op) => op.k === 'set' && op.p.join('.') === 'beamio.language')
			expect(intent).toMatchObject({ vh: true, v: 'zh-CN' }) // the revert is recorded
			;(sendShellRecordCommand as jest.Mock)
				.mockResolvedValueOnce(readOkWith({ ...imported(), rev: 6, beamio: { ...(imported().beamio as Loose), language: 'en' } }))
				.mockResolvedValueOnce(writeOkWith(7))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(deferredWriteForTest()).toBeNull()
			expect(sentWrites().at(-1)!.record.beamio.language).toBe('zh-CN')
		} finally {
			jest.useRealTimers()
		}
	})

	it('unmerged (repro, blocked): a held change the user reverts while a write is blocked is dropped, not replayed', async () => {
		jest.useFakeTimers()
		try {
			const withTax = (lang: string) => {
				const r = base()
				r.beamio.language = lang
				r.beamio.tax = '5'
				return r
			}
			await defer(pageChange()) // migrating: the language change is held (the store still says zh-CN)
			expect(deferredWriteForTest()).not.toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'timeout' })
			await shellRecordWrite(withTax('en')) // a tax change: no answer, so writes are blocked
			const writesBefore = sentWrites().length
			await shellRecordWrite(withTax('zh-CN')) // the user reverts the language while blocked
			const ops = deferredWriteForTest()!.ops
			expect(ops.some((op) => op.k === 'set' && op.p.join('.') === 'beamio.language')).toBe(false) // the stale 'en' is not replayed
			expect(ops.some((op) => op.k === 'set' && op.p.join('.') === 'beamio.tax')).toBe(true)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())).mockResolvedValueOnce(writeOkWith(5))
			jest.advanceTimersByTime(3000)
			await flush()
			expect(sentWrites().length).toBe(writesBefore + 1)
			const last = sentWrites().at(-1)!
			expect(last.record.beamio.language).toBe('zh-CN')
			expect(last.record.beamio.tax).toBe('5')
		} finally {
			jest.useRealTimers()
		}
	})

	it('unmerged (repro, not blocked): a held change reverted together with another edit is dropped from the intent', async () => {
		jest.useFakeTimers()
		try {
			const withTax = (lang: string) => {
				const r = base()
				r.beamio.language = lang
				r.beamio.tax = '5'
				return r
			}
			await defer(pageChange()) // the language change is held
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(withTax('zh-CN')) // the language is back to zh-CN and a tax change is made
			const ops = deferredWriteForTest()!.ops
			expect(ops.some((op) => op.k === 'set' && op.p.join('.') === 'beamio.language')).toBe(false)
			expect(ops.some((op) => op.k === 'set' && op.p.join('.') === 'beamio.tax')).toBe(true)
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('a probe read that puts the record in the page copy keeps a held change', () => {
	const withTax = (record: Loose): Loose => ({ ...record, beamio: { ...(record.beamio as Loose), tax: '5' } })

	// Repro: the persistAndVerifyLocalWallet sequence. The page holds an unmerged language change; the probe read puts the record in the copy;
	// the next save changes tax. Fails on (the probe returned the stored 'zh-CN', so the held 'en' was read as a revert and dropped:
	// Expected "en", Received "zh-CN"). Passes on the commit, where a probe read returns the page's view.
	it('(repro): the copy from a probe read keeps the held change; the next save writes it, not the basis value', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // migrating: the language change is held (the store still says zh-CN, basis rev 4)
			expect(deferredWriteForTest()).not.toBeNull()
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			const probe = await shellRecordRead({ probe: true }) // persistAndVerifyLocalWallet: the probe that replaces the copy
			expect(probe.status).toBe('ok')
			if (probe.status !== 'ok') return
			expect((probe.record.beamio as Loose).language).toBe('en') // the copy holds the page's change
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(writeOkWith(5))
			await shellRecordWrite(withTax(probe.record)) // the next save of the replaced copy: a tax change
			const last = sentWrites().at(-1)!
			expect(last.record.beamio.tax).toBe('5')
			expect(last.record.beamio.language).toBe('en') // written, not reverted
			expect(deferredWriteForTest()).toBeNull() // accepted by the store: the intent is cleared
		} finally {
			jest.useRealTimers()
		}
	})

	it('the probe moves neither the copy basis nor the intent', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange()) // the language change is held (basis rev 4)
			const revBefore = knownRevForTest()
			const intentBefore = JSON.stringify(deferredWriteForTest()!.ops)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			await shellRecordRead({ probe: true })
			expect(knownRevForTest()).toBe(revBefore)
			expect(JSON.stringify(deferredWriteForTest()!.ops)).toBe(intentBefore)
		} finally {
			jest.useRealTimers()
		}
	})

	it('a raw read returns the stored record and keeps the intent (the retry and the removals apply it themselves)', async () => {
		jest.useFakeTimers()
		try {
			await defer(pageChange())
			const intentBefore = JSON.stringify(deferredWriteForTest()!.ops)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			const raw = await shellRecordRead({ probe: true, raw: true })
			expect(raw.status).toBe('ok')
			if (raw.status !== 'ok') return
			expect((raw.record.beamio as Loose).language).toBe('zh-CN')
			expect(JSON.stringify(deferredWriteForTest()!.ops)).toBe(intentBefore)
		} finally {
			jest.useRealTimers()
		}
	})
})

