/**
 * A background shell record write refused by the native layer (origin_refused) raises the update prompt, as a refused read does.
 * The record is read first (ok), then the write is refused; the event is raised once and nothing is written.
 */
import { onAppUpdateRequired } from './appUpdatePrompt'
import { shellRecordRead, shellRecordWrite, resetShellRecordForTest } from './shellRecordStore'
import { sendShellRecordCommand } from './shellRecordTransport'

jest.mock('./nativeChatRouteRegister', () => ({ nextReqId: jest.fn(() => 1) }))
jest.mock('./shellRecordTransport', () => ({ sendShellRecordCommand: jest.fn() }))
jest.mock('../utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

const ADDR = '0x1563915e194D8CfBA1943570603F7606A3115508'
const KEY = '0x' + '2'.repeat(64)

describe('a refused shell write raises the update prompt', () => {
	beforeEach(() => {
		jest.clearAllMocks()
		resetShellRecordForTest()
	})

	it('origin_refused on a write notifies once; a read that answers ok before it is unaffected', async () => {
		const record = {
			rev: 4,
			schemaVersion: 2,
			profiles: [{ keyID: ADDR, privateKeyArmor: KEY, accountName: 'Old', chats: [] }],
			beamio: { accountName: 'Old', firstName: 'Old', language: 'zh-CN' },
		}
		;(sendShellRecordCommand as jest.Mock)
			.mockResolvedValueOnce({ kind: 'payload', payload: { type: 'ack', reqId: 1, ok: true, result: { code: 'ok', record } } })
			.mockResolvedValueOnce({ kind: 'origin_refused' })
		const listener = jest.fn()
		const off = onAppUpdateRequired(listener)
		const read = await shellRecordRead()
		expect(read.status).toBe('ok')
		// the write is refused: the caller sees the refusal, and the update prompt is raised once before it
		await expect(shellRecordWrite({ ...record, beamio: { ...record.beamio, language: 'en' } })).rejects.toThrow('origin_refused')
		expect(listener).toHaveBeenCalledTimes(1)
		const writes = (sendShellRecordCommand as jest.Mock).mock.calls.map((c) => c[0] as { type: string }).filter((c) => c.type === 'shellRecordWrite')
		expect(writes.length).toBe(1)
		off()
	})
})
