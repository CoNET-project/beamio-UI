/**
 * H2: a probe read (a user-action check) does not replace the page copy, its language or the store; the start-up
 * read does. Scenario: the start-up read carries a pending change; a probe read happens; a plain save of the page copy keeps the intent.
 */
import { commitStoredRead, type StoredReadEffects } from './walletCopyCommit'
import { deferredWriteForTest, resetShellRecordForTest, shellRecordRead, shellRecordWrite } from './shellRecordStore'
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

type Loose = Record<string, any>
const ADDR = '0x1563915e194D8CfBA1943570603F7606A3115508'
const KEY = '0x' + '2'.repeat(64)
const base = (): Loose => ({
	rev: 4,
	schemaVersion: 2,
	profiles: [{ keyID: ADDR, privateKeyArmor: KEY, accountName: 'Old', chats: [] }],
	beamio: { accountName: 'Old', firstName: 'Old', language: 'zh-CN' },
})
const readOkWith = (record: Loose) => ({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record } } })
const writeOkWith = (rev: number) => ({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'ok', rev } } })
const conflictAnswer = { kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'conflict', currentRev: 9 } } }
const migrating = { kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'migrating' } } }

/** The page copy as the storage layer would hand it over: a fake that records what was set. */
function copyEffects(): { fx: StoredReadEffects; copy: { value: Loose | null; writes: number; languages: string[] } } {
	const copy = { value: null as Loose | null, writes: 0, languages: [] as string[] }
	const fx: StoredReadEffects = {
		setCopy: (data) => {
			copy.value = data as Loose | null
		},
		writeBack: () => {
			copy.writes += 1
		},
		applyLanguage: (language) => {
			copy.languages.push(language)
		},
	}
	return { fx, copy }
}

beforeEach(() => {
	resetShellRecordForTest()
	;(sendShellRecordCommand as jest.Mock).mockReset()
	window.localStorage.clear()
})

describe('H2: what a store read may do to the page copy', () => {
	it('a probe read touches neither the copy, nor the language, nor the store', async () => {
		const { fx, copy } = copyEffects()
		await commitStoredRead({ probe: true }, { cleaned: base(), hadPeerPrivateArmored: true }, fx)
		await commitStoredRead({ probe: true }, null, fx)
		expect(copy).toEqual({ value: null, writes: 0, languages: [] })
	})

	it('the start-up read sets the copy, writes back a cleaned copy once, and applies the stored language', async () => {
		const { fx, copy } = copyEffects()
		await commitStoredRead({}, { cleaned: base(), hadPeerPrivateArmored: true }, fx)
		expect(copy.value).toEqual(base())
		expect(copy.writes).toBe(1)
		expect(copy.languages).toEqual(['zh-CN'])
		await commitStoredRead({}, null, fx)
		expect(copy.value).toBeNull()
	})

	it('H2 scenario: start-up read (pending change restored), probe read, plain save: the pending change is still held', async () => {
		jest.useFakeTimers()
		try {
			// A migrating write leaves the language change pending (basis rev 4; the store still says zh-CN).
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base())).mockResolvedValueOnce(migrating)
			await shellRecordRead()
			const pending = base()
			pending.beamio.language = 'en'
			await shellRecordWrite(pending)
			expect(deferredWriteForTest()).not.toBeNull()
			// Restart: the start-up read builds the page copy, which carries the pending change.
			resetShellRecordForTest(true)
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			const startup = await shellRecordRead()
			const { fx, copy } = copyEffects()
			await commitStoredRead({}, { cleaned: (startup as Loose).record, hadPeerPrivateArmored: false }, fx)
			expect(copy.value!.beamio.language).toBe('en')
			// A user-action check (probe) reads the store (zh-CN). The copy is not replaced.
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(readOkWith(base()))
			const probe = await shellRecordRead({ probe: true })
			await commitStoredRead({ probe: true }, { cleaned: (probe as Loose).record, hadPeerPrivateArmored: false }, fx)
			expect(copy.value!.beamio.language).toBe('en')
			// A plain save of the copy keeps the pending change (it is written against the basis, so it conflicts and stays held).
			;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(conflictAnswer)
			await shellRecordWrite(copy.value!)
			expect(deferredWriteForTest()).not.toBeNull()
			expect(deferredWriteForTest()!.ops.map((op) => op.p.join('.'))).toEqual(['beamio.language'])
		} finally {
			jest.useRealTimers()
		}
	})
})
