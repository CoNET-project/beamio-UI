// the simulated transport fault (qaTransportFault.ts, QaTransportFaultSwitch.tsx), the worker-ready re-read, and the three new hook events. All hook-variant only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import QaTransportFaultSwitch from '../components/QaTransportFaultSwitch'
import { onQaFaultChange, qaFaultHits, qaFaultMode, qaTransportFaultGate, resetQaTransportFaultForTest, setQaFaultMode } from './qaTransportFault'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
beforeEach(() => { resetQaTransportFaultForTest(); jest.useRealTimers() })

describe('the gate', () => {
	it('off: the send goes on and nothing is counted', async () => {
		expect(await qaTransportFaultGate(8000)).toBe(false)
		expect(qaFaultHits()).toBe(0)
	})
	it('network_error: this attempt fails at once and is counted; back to off: the next attempt goes through (the service is restored)', async () => {
		setQaFaultMode('network_error')
		expect(await qaTransportFaultGate(8000)).toBe(true)
		expect(await qaTransportFaultGate(8000)).toBe(true)
		expect(qaFaultHits()).toBe(2)
		setQaFaultMode('off')
		expect(await qaTransportFaultGate(8000)).toBe(false)
		expect(qaFaultHits()).toBe(2)
	})
	it('timeout: the attempt waits for its whole budget and then fails', async () => {
		jest.useFakeTimers()
		setQaFaultMode('timeout')
		let done = false
		const p = qaTransportFaultGate(8000).then((v) => { done = true; return v })
		await Promise.resolve()
		jest.advanceTimersByTime(7999)
		await Promise.resolve()
		expect(done).toBe(false)
		jest.advanceTimersByTime(2)
		await expect(p).resolves.toBe(true)
		expect(qaFaultHits()).toBe(1)
	})
	it('an unknown mode is refused (the mode stays); listeners hear a change and a throwing listener stops nobody', () => {
		const heard: string[] = []
		onQaFaultChange(() => { throw new Error('x') })
		onQaFaultChange(() => heard.push(qaFaultMode()))
		setQaFaultMode('network_error')
		setQaFaultMode('bogus' as never)
		expect(qaFaultMode()).toBe('network_error')
		expect(heard).toEqual(['network_error'])
	})
	it('memory only: no storage, no log, no URL parameter, no network call, no WebSocket', () => {
		const code = src('qaTransportFault.ts').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|debugLog|location\.|URLSearchParams|fetch\(|WebSocket/)
	})
})

describe('the on-screen switch', () => {
	it('three buttons set the mode of this page; the pressed one is marked; the hit counter is shown', () => {
		render(<QaTransportFaultSwitch />)
		expect(screen.getByTestId('qa-transport-fault').getAttribute('data-mode')).toBe('off')
		expect(screen.getByText('模拟传输故障')).toBeTruthy()
		fireEvent.click(screen.getByTestId('qa-fault-network_error'))
		expect(qaFaultMode()).toBe('network_error')
		expect(screen.getByTestId('qa-fault-network_error').getAttribute('aria-pressed')).toBe('true')
		fireEvent.click(screen.getByTestId('qa-fault-timeout'))
		expect(qaFaultMode()).toBe('timeout')
		fireEvent.click(screen.getByTestId('qa-fault-off'))
		expect(qaFaultMode()).toBe('off')
		expect(screen.getByTestId('qa-transport-fault').getAttribute('data-mode')).toBe('off')
		act(() => { setQaFaultMode('network_error') })
		expect(screen.getByTestId('qa-transport-fault').getAttribute('data-mode')).toBe('network_error')
	})
})

describe('hook variant only: the call sites and the mount sit behind the compile-time switch', () => {
	it('chat.ts: the gate sits after the armor is stored and before any node is picked, so a real node is never marked bad', () => {
		const chat = src('chat.ts')
		const gate = chat.indexOf('qaTransportFaultGate(SEND_ATTEMPT_TIMEOUT_MS)')
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && \(await qaTransportFaultGate\(SEND_ATTEMPT_TIMEOUT_MS\)\)\) \{\s*console\.warn\('\[sendMessage\] simulated transport fault'\)\s*return false\s*\}/)
		expect(gate).toBeGreaterThan(chat.indexOf('await opts.armor.record(postData, postDigest)'))
		expect(gate).toBeLessThan(chat.indexOf('pickGossipEntryNodesForSend(entryPool, 1, tried)'))
		expect(chat.indexOf('markGossipNodeBad(node.domain)', gate)).toBeGreaterThan(gate) // the first call after the gate is in the loop, so the gate comes first
	})
	it('chatWorkerBridge.ts: the native send fails before the command is posted', () => {
		const b = src('chatWorkerBridge.ts')
		expect(b).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && \(await qaTransportFaultGate\(NATIVE_FAULT_TIMEOUT_MS\)\)\) \{\s*qaSendStage\('simulated_transport_fault'\)\s*return false\s*\}/)
		// and it sits before the native send (the interface's prepare / send), so nothing leaves when the fault is on
		expect(b.indexOf('qaTransportFaultGate(NATIVE_FAULT_TIMEOUT_MS)')).toBeLessThan(b.indexOf('await sendViaNative({'))
	})
	it('the switch is mounted only under process.env.REACT_APP_QA_ACK_ORDER_HOOK === \'true\', and nothing else imports the module', () => {
		expect(src('../index.tsx')).toMatch(/\{process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && <QaTransportFaultSwitch \/>\}/)
		for (const f of ['../App.tsx', '../pages/chat/chat.tsx', '../utils/chatDeliveryReceipt.ts']) expect(src(f)).not.toMatch(/qaTransportFault|QaTransportFaultSwitch/)
	})
	it('the state and the hook line carry the mode and the hit count', () => {
		const qa = src('../utils/qaAckOrder.ts')
		expect(qa).toMatch(/const transportFault = \{ mode: code\(qaFaultMode\(\)\), hits: num\(qaFaultHits\(\)\) \}/)
		expect(qa).toMatch(/ft: \{ m: state\.transportFault\.mode, n: state\.transportFault\.hits \}/)
	})
})

describe('the worker becoming ready asks the conversation for a re-read', () => {
	const chat = src('../pages/chat/chat.tsx')
	it('chat.tsx re-reads on the worker-ready event, through the same tick the 10 one-second retries use', () => {
		expect(chat).toMatch(/useEffect\(\(\) => onWorkerReady\(\(\) => setHistoryRereadTick\(\(t\) => t \+ 1\)\), \[\]\)/)
		expect(chat).toMatch(/\}, \[chatData\.address, historyRereadTick\]\)/) // the read effect depends on the tick
		expect(chat).toMatch(/\tonWorkerReady,\n/)
		// the 10 steps stay as they were
		expect(chat).toMatch(/if \(localHistoryRead\.kind !== 'not_read' \|\| historyRereadTick >= 10\) return/)
	})
	it('the worker-ready subscription is released with the component and is the bridge\'s own listener set', () => {
		const b = src('chatWorkerBridge.ts')
		expect(b).toMatch(/export const onWorkerReady = \(cb: \(\) => void\): \(\(\) => void\) => \{\s*workerReadyListeners\.add\(cb\)\s*return \(\) => \{\s*workerReadyListeners\.delete\(cb\)/)
		expect(b).toMatch(/for \(const cb of workerReadyListeners\) \{\s*try \{\s*cb\(\)/)
	})
})

describe('three hook events and the live persistence rule in the state line', () => {
	it('chat_worker_ready (App), library_state_first_answer (bridge, once), history_reread_exhausted (chat, once per stretch): each behind the switch', () => {
		expect(src('../App.tsx')).toMatch(/onWorkerReady\(\(\) => \{ setWorkerEpoch\(\(n\) => n \+ 1\); if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) qaEvent\('chat_worker_ready'\); void refreshEvidenceOnWorkerReady\(\) \}\)/)
		const b = src('chatWorkerBridge.ts')
		expect(b).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && answer !== null && answer !== undefined && !qaLibraryStateAnswered\) \{ qaLibraryStateAnswered = true; qaEvent\('library_state_first_answer'\) \}/)
		const chat = src('../pages/chat/chat.tsx')
		expect(chat).toMatch(/if \(localHistoryRead\.kind === 'not_read' && historyRereadTick >= 10 && !qaRereadExhaustedRef\.current\) \{ qaRereadExhaustedRef\.current = true; qaEvent\('history_reread_exhausted'\) \}/)
	})
	it('the event names survive the sanitizer in full (the longest is 26 characters)', async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		const mod = await import('../utils/qaAckOrder')
		for (const n of ['chat_worker_ready', 'library_state_first_answer', 'history_reread_exhausted']) mod.qaEvent(n)
		expect(mod.qaEventList().map((e) => e.n)).toEqual(expect.arrayContaining(['chat_worker_ready', 'library_state_first_answer', 'history_reread_exhausted']))
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})
	it('the conversation probe gives the CURRENT libraryPersistModeFor and capability, read live; the line prints them as pm and cp', () => {
		const chat = src('../pages/chat/chat.tsx')
		expect(chat).toMatch(/persistMode: libraryPersistModeFor\(String\(profiles\?\.\[0\]\?\.keyID \|\| ''\)\.toLowerCase\(\)\), capable: localChatLibraryCapable\(\) \}\)\)/)
		const qa = src('../utils/qaAckOrder.ts')
		expect(qa).toMatch(/pm: state\.conversation\.persistMode, cp: state\.conversation\.capable,/)
		expect(qa).toMatch(/persistMode: code\(conv\.persistMode\) \|\| null/)
	})
})
