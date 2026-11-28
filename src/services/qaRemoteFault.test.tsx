// the hook-only "模拟远端提交失败" switch (qaRemoteFault.ts, QaRemoteFaultSwitch.tsx), the page's append wrapper that carries it, and the failure codes the wait loop reads.
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import QaRemoteFaultSwitch from '../components/QaRemoteFaultSwitch'
import { onQaRemoteFaultChange, qaRemoteFaultForAppend, qaRemoteFaultHits, qaRemoteFaultMode, resetQaRemoteFaultForTest, setQaRemoteFaultMode } from './qaRemoteFault'
import { appendFailureCodeOf, appendFailureOf, appendHistoryAck, clearAppendFailure, isRemoteFailure, noteAppendFailure, resetAppendFailuresForTest } from './historyAppendAck'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const HOOK = 'REACT_APP_QA_ACK_ORDER_HOOK'
const saved = process.env[HOOK]
beforeEach(() => { resetQaRemoteFaultForTest(); resetAppendFailuresForTest(); process.env[HOOK] = 'true' })
afterAll(() => { if (saved === undefined) delete process.env[HOOK]; else process.env[HOOK] = saved })

describe('the fault handed to an append', () => {
	it('off: nothing is handed out and nothing is counted', () => {
		expect(qaRemoteFaultForAppend()).toBeUndefined()
		expect(qaRemoteFaultHits()).toBe(0)
	})
	it('upload / pointer / timeout: that fault goes with every append while it is on, and is counted; off again: the next append has none', () => {
		setQaRemoteFaultMode('pointer')
		expect([qaRemoteFaultForAppend(), qaRemoteFaultForAppend()]).toEqual(['pointer', 'pointer'])
		expect(qaRemoteFaultHits()).toBe(2)
		setQaRemoteFaultMode('upload')
		expect(qaRemoteFaultForAppend()).toBe('upload')
		setQaRemoteFaultMode('timeout')
		expect(qaRemoteFaultForAppend()).toBe('timeout')
		setQaRemoteFaultMode('off')
		expect(qaRemoteFaultForAppend()).toBeUndefined()
		expect(qaRemoteFaultHits()).toBe(4)
	})
	it('a build that is not a hook build hands out nothing even when the mode was set', () => {
		setQaRemoteFaultMode('pointer')
		process.env[HOOK] = 'false'
		expect(qaRemoteFaultForAppend()).toBeUndefined()
		expect(qaRemoteFaultHits()).toBe(0)
	})
	it('an unknown mode is refused; listeners hear a change; a throwing listener stops nobody', () => {
		const heard: string[] = []
		onQaRemoteFaultChange(() => { throw new Error('x') })
		onQaRemoteFaultChange(() => heard.push(qaRemoteFaultMode()))
		setQaRemoteFaultMode('pointer')
		setQaRemoteFaultMode('bogus' as never)
		expect(qaRemoteFaultMode()).toBe('pointer')
		expect(heard).toEqual(['pointer'])
	})
	it('memory only: no storage, no log, no URL parameter, no network call, no WebSocket', () => {
		expect(code(src('qaRemoteFault.ts'))).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|debugLog|location\.|URLSearchParams|fetch\(|WebSocket/)
	})
})

describe('the on-screen switch', () => {
	it('four buttons set the mode; the pressed one is marked; the hit counter is shown', () => {
		render(<QaRemoteFaultSwitch />)
		expect(screen.getByTestId('qa-remote-fault').getAttribute('data-mode')).toBe('off')
		expect(screen.getByText('模拟远端提交失败')).toBeTruthy()
		fireEvent.click(screen.getByTestId('qa-remote-fault-pointer'))
		expect(qaRemoteFaultMode()).toBe('pointer')
		expect(screen.getByTestId('qa-remote-fault-pointer').getAttribute('aria-pressed')).toBe('true')
		fireEvent.click(screen.getByTestId('qa-remote-fault-upload'))
		expect(qaRemoteFaultMode()).toBe('upload')
		fireEvent.click(screen.getByTestId('qa-remote-fault-timeout'))
		expect(qaRemoteFaultMode()).toBe('timeout')
		fireEvent.click(screen.getByTestId('qa-remote-fault-off'))
		expect(qaRemoteFaultMode()).toBe('off')
		act(() => { setQaRemoteFaultMode('upload') })
		expect(screen.getByTestId('qa-remote-fault').getAttribute('data-mode')).toBe('upload')
	})
})

describe('the failure codes (what the wait loop reads)', () => {
	it('the worker text maps to a code: each remote step to its own, everything else to local', () => {
		expect(appendFailureCodeOf('remote_commit_failed:pointer')).toBe('pointer')
		expect(appendFailureCodeOf('remote_commit_failed:upload')).toBe('upload')
		expect(appendFailureCodeOf('remote_commit_failed:index_upload')).toBe('index')
		expect(appendFailureCodeOf('remote_commit_failed:no_fragment')).toBe('nofrag')
		expect(appendFailureCodeOf('remote_commit_failed:something_new')).toBe('pointer') // an unknown remote step is still a remote failure
		for (const t of ['library row not written', 'locked', 'worker_timeout', 'history not initialised', '', 'refused']) expect(appendFailureCodeOf(t)).toBe('local')
		expect(isRemoteFailure('pointer')).toBe(true)
		expect(isRemoteFailure('local')).toBe(false)
		expect(isRemoteFailure(undefined)).toBe(false)
	})
	it('appendHistoryAck reports the failure text, carries the options, and still never throws', async () => {
		const seen: unknown[][] = []
		const fails: string[] = []
		const entry = { peer: '0xaa', dir: 'in' as const, ts: 1, sendId: 's1', body: '{}' }
		const client = { history: { append: async (...a: unknown[]) => { seen.push(a); throw new Error('remote_commit_failed:pointer') } } }
		expect(await appendHistoryAck(client, entry, { onFail: (m) => fails.push(m), opts: { qaRemoteFault: 'pointer' } })).toBe(false)
		expect(fails).toEqual(['remote_commit_failed:pointer'])
		expect(seen[0]).toEqual([entry, { qaRemoteFault: 'pointer' }])
		// no options: the client is called with the entry alone (the product call is unchanged)
		const seen2: unknown[][] = []
		expect(await appendHistoryAck({ history: { append: async (...a: unknown[]) => { seen2.push(a) } } }, entry)).toBe(true)
		expect(seen2[0]).toEqual([entry])
		// a throwing hook never decides anything
		expect(await appendHistoryAck(client, entry, { onFail: () => { throw new Error('hook') } })).toBe(false)
	})
	it('the last failure of a sendId is kept, replaced by a newer one, cleared on success, and bounded', () => {
		noteAppendFailure('a', 'pointer')
		expect(appendFailureOf('a')).toBe('pointer')
		noteAppendFailure('a', 'local')
		expect(appendFailureOf('a')).toBe('local')
		clearAppendFailure('a')
		expect(appendFailureOf('a')).toBeUndefined()
		noteAppendFailure(undefined, 'pointer')
		expect(appendFailureOf(undefined)).toBeUndefined()
		for (let i = 0; i < 600; i++) noteAppendFailure(`id-${i}`, 'pointer')
		expect(appendFailureOf('id-0')).toBeUndefined()
		expect(appendFailureOf('id-599')).toBe('pointer')
	})
})

describe('hook variant only: every reader and the mount sit behind the inline compile-time switch', () => {
	it('chatWorkerBridge.ts: the fault is read and the option built only under the inline test, for an inbound append only; a success clears the failure code', () => {
		const b = code(src('chatWorkerBridge.ts'))
		expect(b).toMatch(/const fault = process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && entry\.dir === 'in' \? qaRemoteFaultForAppend\(\) : undefined/)
		expect(b).toMatch(/opts: process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && fault \? \{ qaRemoteFault: fault \} : undefined/)
		expect(b).toMatch(/if \(ok\) clearAppendFailure\(entry\.sendId\)/)
		expect(b.match(/qaRemoteFault/g)?.length).toBe(4) // the import path, the import name, the call (inside the inline gate) and the option (inside the inline gate)
	})
	it('the failure code is wired end to end: the bridge notes it per sendId, App hands the lookup to the mirror, the mirror hands it to the wait', () => {
		expect(code(src('chatWorkerBridge.ts'))).toMatch(/onFail: \(message\) => noteAppendFailure\(entry\.sendId, appendFailureCodeOf\(message\)\)/)
		expect(code(src('../App.tsx'))).toMatch(/ack: mirrorChatMessageToHistoryAck, failureOf: appendFailureOf, fireAndForget: mirrorChatMessageToHistory,/)
		expect(code(src('inboundMirror.ts'))).toMatch(/failure: input\.failureOf \? \(\) => input\.failureOf\?\.\(sendId\) : undefined/)
		expect(code(src('inboundDurable.ts'))).toMatch(/try \{ why = item\.mirror\.failure\?\.\(\) \} catch/)
	})
	it('the switch is mounted only under the inline test and nothing else imports the module or the component', () => {
		expect(src('../index.tsx')).toMatch(/\{process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && <QaRemoteFaultSwitch \/>\}/)
		for (const f of ['../App.tsx', '../pages/chat/chat.tsx', 'inboundDurable.ts', 'inboundMirror.ts', 'historyAppendAck.ts', 'inboundBatchSettle.ts']) expect(code(src(f))).not.toMatch(/qaRemoteFault|QaRemoteFaultSwitch/)
	})
	it('the SDK passes the option only under the inline test (client, worker entry, history): a product bundle holds no fault text', () => {
		const sdk = (rel: string) => code(readFileSync(join(__dirname, '../../vendor/conet-chat-sdk/src', rel), 'utf8'))
		expect(sdk('client.ts')).toMatch(/process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && opts\?\.qaRemoteFault \? \{ qaRemoteFault: opts\.qaRemoteFault \} : \{\}/)
		expect(sdk('worker/entry.ts')).toMatch(/process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' \? \{ qaRemoteFault: cmd\.qaRemoteFault \} : undefined/)
		const h = sdk('worker/history.ts')
		expect(h).toMatch(/const qaFault = process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' \? opts\?\.qaRemoteFault : undefined/)
		expect(h).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && qaFault\) \{/)
		expect((h.match(/qaRemoteFault/g) ?? []).length).toBe(2) // the type position of append's options and the one gated read
	})
	it('the wait loop emits remote_fail only under the inline test, with the hash tail and the code', () => {
		const d = code(src('inboundDurable.ts'))
		expect(d).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('remote_fail', item\.mirror\.sendId, `h\$\{item\.hash\.toLowerCase\(\)\.replace\(\/\[\^0-9a-f\]\/g, ''\)\.slice\(-8\)\}_\$\{why\}`\)/)
	})
	it('the wording exists in both locale files and the chat shows it in the message status row next to the not-saved one', () => {
		const en = JSON.parse(src('../locale/en.json')) as { ui: Record<string, string> }
		const zh = JSON.parse(src('../locale/zh-CN.json')) as { ui: Record<string, string> }
		expect(en.ui['chat.status.remote_pending']).toBe('Saved on this device. Remote commit pending, retrying.')
		expect(zh.ui['chat.status.remote_pending']).toBe('已保存在本设备，远端未提交，正在重试')
		const chat = src('../pages/chat/chat.tsx')
		expect(chat).toMatch(/!isMe && m\.sendId && remoteUnsentInboundIds\.has\(m\.sendId\)[\s\S]{0,200}tu\('chat\.status\.remote_pending'\)/)
		const at = chat.indexOf("tu('chat.status.remote_pending')")
		expect(at - chat.lastIndexOf('<div className={["mt-1 flex items-center gap-2"', at)).toBeLessThan(1400)
	})
})
