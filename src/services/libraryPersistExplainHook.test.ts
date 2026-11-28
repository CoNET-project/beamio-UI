// the account-level persistence probe in the hook variant (jsdom: the hook installs window.__beamioQaAckOrder). SYNTHETIC only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { profileEoaOf } from './chatLocalPurge'

describe('the probe in the hook variant', () => {
	const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
	it('the App registers it inside the compile-time gate, for the key the record write uses, and unregisters it', () => {
		const app = src('../App.tsx')
		expect(app).toMatch(/qaRegisterProbe\('persist', \(\) => libraryPersistExplain\(profileEoaOf\(\(CoNET_Data\?\.profiles \?\? \[\]\) as unknown\[\]\)\)\)/)
		expect(app).toMatch(/qaRegisterProbe\('persist', null\)/)
		const effect = app.slice(app.indexOf("if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return undefined\n\t\tqaRegisterProbe('chats'"))
		expect(effect.indexOf("qaRegisterProbe('persist', () =>")).toBeGreaterThan(0)
		expect(profileEoaOf([{ keyID: '0xAbC' }])).toBe('0xabc')
	})
	it('the export carries it (mode, flag, capable, state, evidence) as plain words; `unregistered` before the App registered it; the state line prints it as pp; the window method reads the same', async () => {
		const prev = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const qa = await import('../utils/qaAckOrder')
		expect(qa.qaPersistExport()).toEqual({ mode: 'unregistered', flag: null, capable: null, state: null, evidence: null })
		qa.qaRegisterProbe('persist', () => ({ mode: 'guarded', flag: false, capable: true, state: 'switched', evidence: 'present', note: 'SECRET' } as never))
		expect(qa.qaPersistExport()).toEqual({ mode: 'guarded', flag: false, capable: true, state: 'switched', evidence: 'present' })
		qa.qaRegisterProbe('persist', () => ({ mode: 'Bad Mode!', flag: 'yes', capable: 1, state: 'Has Space', evidence: 'x'.repeat(80) } as never))
		expect(qa.qaPersistExport()).toEqual({ mode: null, flag: null, capable: null, state: null, evidence: null })
		qa.qaRegisterProbe('persist', () => ({ mode: 'record', flag: false, capable: false, state: null, evidence: 'none' }))
		const st = await qa.qaExportState()
		expect(st.persist).toEqual({ mode: 'record', flag: false, capable: false, state: null, evidence: 'none' })
		const line = qa.qaStateLine(st as never, 1)
		expect(JSON.parse(line.slice('[QA-STATE] '.length)).pp).toEqual({ m: 'record', f: false, c: false, s: null, e: 'none' })
		const hook = (window as unknown as Record<string, { persistMode?: () => unknown }>).__beamioQaAckOrder
		expect(hook?.persistMode?.()).toEqual(st.persist)
		qa.qaRegisterProbe('persist', null)
		expect(qa.qaPersistExport().mode).toBe('unregistered')
		if (prev === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		else process.env.REACT_APP_QA_ACK_ORDER_HOOK = prev
	})
	it('without the build switch the probe cannot be registered: nothing is exported', async () => {
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		jest.resetModules()
		const qa = await import('../utils/qaAckOrder')
		qa.qaRegisterProbe('persist', () => ({ mode: 'record' }))
		expect(qa.qaPersistExport().mode).toBe('unregistered')
	})
})
