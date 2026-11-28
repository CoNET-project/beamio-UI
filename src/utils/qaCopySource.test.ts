// the source of the first copy shown after a mount (record / queue / library / app_history) and the persistence rule of an unregistered conversation probe. Hook variant only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { qaClassifyCopies, qaClassifyCopyNames, qaFirstCopySourceOf, qaNoteCopy, qaSendIdOfEntry, qaSetFirstCopySource, resetQaCopySourceForTest } from './qaCopySource'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const A = '1767225600000-aaaa1111'
const B = '1767225600001-bbbb2222'
const C = '1767225600002-cccc3333'
const D = '1767225600003-dddd4444'

describe('first-copy source classification', () => {
	beforeEach(() => resetQaCopySourceForTest())
	it('a message that was only in the stored record (with a body) is `record`', () => {
		expect(qaClassifyCopies([A], new Set([A]))).toBe('record')
	})
	it('a message put back from the send queue is `queue`, even when the record also lists it', () => {
		qaNoteCopy('queue', [A])
		expect(qaClassifyCopies([A], new Set([A]))).toBe('queue')
	})
	it('a message added by the library read merge is `library`; one added by the App-level history restore is `app_history`', () => {
		qaNoteCopy('library', [A])
		qaNoteCopy('app_history', [B])
		expect(qaClassifyCopies([A], new Set())).toBe('library')
		expect(qaClassifyCopies([B], new Set())).toBe('app_history')
	})
	it('a mix is the distinct names in a fixed order joined with _; an id nobody noted and the record does not hold is `unknown`', () => {
		qaNoteCopy('app_history', [B])
		qaNoteCopy('library', [A])
		qaNoteCopy('queue', [C])
		expect(qaClassifyCopyNames([B, A, C, D], new Set())).toEqual(['queue', 'library', 'app_history', 'unknown'])
		expect(qaClassifyCopies([B, A], new Set())).toBe('library_app_history')
		expect(qaClassifyCopies([], new Set())).toBe('unknown')
	})
	it('the output is plain words only: never an id, never a body', () => {
		qaNoteCopy('library', [A])
		const out = qaClassifyCopies([A, B], new Set([B]))
		expect(out).toMatch(/^[a-z_]+$/)
		expect(out).not.toContain('aaaa1111')
		qaSetFirstCopySource('0xAAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee', 'Library 1767225600000-aaaa1111!')
		expect(qaFirstCopySourceOf('0xAAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee')).toBe('ibraryaaaa')
		expect(qaFirstCopySourceOf('0x0000000000000000000000000000000000000001')).toBeNull() // another conversation: no answer
	})
	it('the sendId of a history entry is its own field, else the one inside its JSON body (the body is only parsed)', () => {
		expect(qaSendIdOfEntry({ sendId: A })).toBe(A)
		expect(qaSendIdOfEntry({ body: JSON.stringify({ sendId: B, text: 'SECRET' }) })).toBe(B)
		expect(qaSendIdOfEntry({ body: 'not json' })).toBeNull()
		expect(qaSendIdOfEntry({})).toBeNull()
	})
})

describe('first-copy source wiring (hook variant only)', () => {
	it('chat.tsx notes `queue` at the queue put-back, `library` at the library merge and classifies at the first copy; the output is the source name', () => {
		const chat = src('../pages/chat/chat.tsx')
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaNoteCopy\('queue', unlisted\.map\(/)
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) \{\s*const had = new Set\(prev\.map\(\(m\) => m\.sendId\)[^\n]*\n\s*qaNoteCopy\('library', /)
		expect(chat).toMatch(/const sourceNames = qaClassifyCopyNames\(shownIds, recordIds\)\s*\n\s*qaSetFirstCopySource\(peerLower, qaClassifyCopies\(shownIds, recordIds\)\)\s*\n\s*for \(const name of sourceNames\) qaEvent\('first_copy_src', undefined, name\)/)
	})
	it('the App-level history restore notes `app_history` for the messages it ADDED, only behind the compile-time switch', () => {
		const restore = src('../services/historyRestoreApply.ts')
		expect(restore).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && added > 0\) \{[\s\S]*qaNoteCopy\('app_history'/)
	})
	it('the state export carries firstCopySource in the conversation and the state line prints it as c.cs', () => {
		const qa = src('qaAckOrder.ts')
		expect(qa).toMatch(/firstCopySource: qaFirstCopySourceOf\(str\(conv\.address\)\)/)
		expect(qa).toMatch(/cp: state\.conversation\.capable, cs: state\.conversation\.firstCopySource,/)
	})
})

describe('freeze blocker 3: persistMode is read live and an unregistered probe is not null', () => {
	const prev = process.env.REACT_APP_QA_ACK_ORDER_HOOK
	afterEach(() => {
		if (prev === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		else process.env.REACT_APP_QA_ACK_ORDER_HOOK = prev
	})
	it('no conversation probe: the export says `unregistered` (probe and mode), the line prints pm=unregistered; a registered probe that is silent stays null', async () => {
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		const none = await mod.qaExportState()
		expect(none.conversation).toBeNull()
		expect(none.conversationPersist).toEqual({ probe: 'unregistered', mode: 'unregistered' })
		const line = mod.qaStateLine(none as never, 1)
		expect(JSON.parse(line.slice('[QA-STATE] '.length)).c).toEqual({ pm: 'unregistered' })
		mod.qaRegisterProbe('conversation', () => ({ address: '0x1' }))
		const silent = await mod.qaExportState()
		expect(silent.conversationPersist).toEqual({ probe: 'registered', mode: null })
	})
	it('the registered probe is evaluated at EVERY export: the mode that changed between two exports is the second value', async () => {
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		let mode = 'record'
		mod.qaRegisterProbe('conversation', () => ({ address: '0x1', persistMode: mode, capable: true }))
		expect((await mod.qaExportState()).conversationPersist).toEqual({ probe: 'registered', mode: 'record' })
		mode = 'library'
		const second = await mod.qaExportState()
		expect(second.conversationPersist.mode).toBe('library')
		expect(second.conversation?.persistMode).toBe('library')
		mod.qaRegisterProbe('conversation', null)
		expect((await mod.qaExportState()).conversationPersist.mode).toBe('unregistered')
	})
})
