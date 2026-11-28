// the hook events that split the start window (preheat_*, history_tail_noted, chat_client_created, local_keys_delivered, library_read_*, preheat_await_*), the document-listing
// error counter, and the queue count next to the document count. Hook variant only.
import { readFileSync } from 'fs'
import { join } from 'path'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')

describe('behaviour (hook switch on)', () => {
	const load = async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		return import('./qaAckOrder')
	}
	afterEach(() => {
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})
	it('the preheat state changes are events: preheat_requested, then preheat_ready', async () => {
		const qa = await load()
		const pre = await import('../services/chatPreheat')
		pre.resetChatPreheatForTest()
		await pre.startChatPreheat({ accountKey: 'acct', shell: false, startWorker: () => Promise.resolve(), awaitHistoryTail: () => Promise.resolve(true), log: () => undefined })
		const names = qa.qaEventList().map((e) => e.n)
		expect(names).toEqual(expect.arrayContaining(['preheat_requested', 'preheat_ready']))
		expect(names.indexOf('preheat_requested')).toBeLessThan(names.indexOf('preheat_ready'))
	})
	it('a failed preheat is preheat_failed', async () => {
		const qa = await load()
		const pre = await import('../services/chatPreheat')
		pre.resetChatPreheatForTest()
		await pre.startChatPreheat({ accountKey: 'acct2', shell: false, startWorker: () => Promise.resolve(), awaitHistoryTail: () => Promise.resolve(false), log: () => undefined })
		expect(qa.qaEventList().map((e) => e.n)).toContain('preheat_failed')
	})
	it('a failing document listing is counted (it is not the same as "no documents"), and the line carries qd, qn (queue count) and de', async () => {
		const qa = await load()
		qa.qaRegisterProbe('docs', async () => { throw new Error('list failed') })
		qa.qaRegisterProbe('queue', () => [{ sendId: 'a-11111111', state: 'failed', attempts: 1 }])
		const s1 = await qa.qaExportState()
		const s2 = await qa.qaExportState()
		expect(s1.docsErrors).toBe(1)
		expect(s2.docsErrors).toBe(2)
		expect(s2.queueDocs).toEqual([])
		expect(s2.queue.length).toBe(1)
		const line = qa.qaStateLine(s2, 1)
		const body = JSON.parse(line.slice('[QA-STATE] '.length))
		expect(body.qd).toBe(0)
		expect(body.qn).toBe(1)
		expect(body.de).toBe(2)
	})
	it('event names survive the sanitizer in full (history_tail_noted, chat_client_created, local_keys_delivered, preheat_await_begin, library_read_start)', async () => {
		const qa = await load()
		for (const n of ['history_tail_noted', 'chat_client_created', 'local_keys_delivered', 'preheat_await_begin', 'preheat_await_end', 'library_read_start', 'library_read_end']) qa.qaEvent(n)
		expect(qa.qaEventList().map((e) => e.n).filter((n) => n !== 'app_start')).toEqual(['history_tail_noted', 'chat_client_created', 'local_keys_delivered', 'preheat_await_begin', 'preheat_await_end', 'library_read_start', 'library_read_end'])
	})
})

describe('hook variant only: every call site is behind the compile-time switch', () => {
	it('each qaEvent call of the new events is on a line with process.env.REACT_APP_QA_ACK_ORDER_HOOK === \'true\'', () => {
		const files: Record<string, string> = {
			chatPreheat: src('../services/chatPreheat.ts'),
			bridge: src('../services/chatWorkerBridge.ts'),
			chat: src('../pages/chat/chat.tsx'),
		}
		const names = ['preheat_', 'history_tail_noted', 'chat_client_created', 'local_keys_delivered', 'library_read_start', 'library_read_end', 'preheat_await_begin', 'preheat_await_end']
		for (const [file, text] of Object.entries(files)) {
			for (const line of text.split('\n')) {
				if (!/qaEvent\(/.test(line) || /^import /.test(line.trim())) continue
				if (!names.some((n) => line.includes(n))) continue
				expect({ file, ok: /process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'/.test(line) }).toEqual({ file, ok: true })
			}
		}
	})
	it('the sites exist where the start window is split', () => {
		expect(src('../services/chatPreheat.ts')).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\(`preheat_\$\{state\}`\)/)
		const b = src('../services/chatWorkerBridge.ts')
		expect(b).toMatch(/activeClient = client\n\tif \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('chat_client_created'\)/)
		expect(b).toMatch(/await h\.unlockLocal\(keys\)\n\t\tif \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('local_keys_delivered'\)/)
		expect(b).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && batch\?\.isTail\) qaEvent\('history_tail_noted'/)
		const c = src('../pages/chat/chat.tsx')
		expect(c).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('library_read_start'\)/)
		expect(c).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('library_read_end', undefined, readResult\.kind\)/)
		expect(c).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('preheat_await_begin'\)/)
		expect(c).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('preheat_await_end'\)/)
		expect(src('./qaAckOrder.ts')).toMatch(/catch \{ docs = \[\]; qaDocsErrors \+= 1 \}/)
	})
})
