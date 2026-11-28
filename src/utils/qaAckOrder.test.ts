// the receipt-order hook is a compile-time QA switch; without the switch it does nothing and has no global.
import fs from 'fs'
import path from 'path'

describe('qaAckOrder (test-only hook)', () => {
	it('without REACT_APP_QA_ACK_ORDER_HOOK=true: qaHoldAck returns at once and no global exists', async () => {
		const prev = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		expect(mod.QA_ACK_ORDER_HOOK).toBe(false)
		await mod.qaHoldAck('s1') // returns, does not wait
		expect((window as unknown as Record<string, unknown>).__beamioQaAckOrder).toBeUndefined()
		if (prev !== undefined) process.env.REACT_APP_QA_ACK_ORDER_HOOK = prev
	})

	it('a value other than "true" does not turn it on (no truthy coercion): only the exact string of the build', async () => {
		for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
			process.env.REACT_APP_QA_ACK_ORDER_HOOK = v
			jest.resetModules()
			const mod = await import('./qaAckOrder')
			expect(mod.QA_ACK_ORDER_HOOK).toBe(false)
		}
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
	})

	it('with the build switch: hold the next sends and release them in the order QA chooses (out of order)', async () => {
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		expect(mod.QA_ACK_ORDER_HOOK).toBe(true)
		const hook = (window as unknown as { __beamioQaAckOrder: { holdNext(n: number): void; release(id?: string): void; held(): string[] } }).__beamioQaAckOrder
		hook.holdNext(2)
		const order: string[] = []
		const p1 = mod.qaHoldAck('first').then(() => order.push('first'))
		const p2 = mod.qaHoldAck('second').then(() => order.push('second'))
		await mod.qaHoldAck('third') // not held: only two were asked for
		expect(hook.held()).toEqual(['first', 'second'])
		hook.release('second') // the second receipt arrives first
		await p2
		expect(order).toEqual(['second'])
		hook.release()
		await p1
		expect(order).toEqual(['second', 'first'])
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})

	it('the source gates every branch behind the compile-time constant and reads no URL, storage, global or remote setting; craco defines it from the build environment only', () => {
		const src = fs.readFileSync(path.join(__dirname, 'qaAckOrder.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
		expect(src).toMatch(/export const QA_ACK_ORDER_HOOK = process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'/)
		// every gate in the sources is the INLINE test, which DefinePlugin folds; the exported constant is kept only for tests, and nothing in the production sources reads it
		expect((src.match(/(?<![A-Za-z_.])QA_ACK_ORDER_HOOK(?![A-Za-z_])/g) ?? []).length).toBe(1)
		expect(src).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK !== 'true'\) return/)
		expect(src).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && typeof window !== 'undefined'\)/)
		expect(src).not.toMatch(/location|URLSearchParams|localStorage|sessionStorage|fetch\(|indexedDB|document\.cookie/)
		const craco = fs.readFileSync(path.join(__dirname, '../../craco.config.js'), 'utf8')
		expect(craco).toMatch(/'process\.env\.REACT_APP_QA_ACK_ORDER_HOOK': JSON\.stringify\(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' \? 'true' : 'false'\)/)
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/await qaHoldAck\(/)
	})

	it('the read-only state export carries only sendId, status, from, createdAt, the peer\'s last 6 characters, queue sendId / state / attempts and queue document sendIds: nothing else leaves, whatever a probe returns', async () => {
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		mod.qaRegisterProbe('chats', () => [{ address: '0xAAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee', messages: [{ sendId: 's1', status: 'sent', from: 'me', createdAt: 5, text: 'SECRET-TEXT', armor: 'SECRET-ARMOR', armorDigest: '0xSECRETDIGEST', fileMessageCipher: 'SECRET-CIPHER' }] }])
		mod.qaRegisterProbe('queue', () => [{ sendId: 's1', state: 'awaiting', attempts: 3, text: 'SECRET-TEXT', armor: 'SECRET-ARMOR', confirmedSince: null, lastAttemptAt: 7 }, { sendId: 's2', state: 'confirmed', attempts: 1, confirmedSince: Date.now() - 120_000, lastAttemptAt: 9, text: 'SECRET-TEXT' }])
		mod.qaRegisterProbe('kicks', () => [{ at: 11, trigger: 'heartbeat', online: false, started: 2, note: 'SECRET-TEXT' } as never, { at: 12, trigger: 'Bad Trigger With Spaces', online: true, started: 0 }])
		mod.qaRegisterProbe('docs', async () => ['chat-queue-v1:0xeoa:s1', 'chat-queue-v1:0xeoa:s2'])
		mod.qaRegisterProbe('conversation', () => ({ address: '0xAAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee', messages: [{ sendId: 's1', status: 'delivered', from: 'me', createdAt: 5, text: 'SECRET-TEXT', sendError: 'route_unconfirmed' }, { sendId: 's2', status: 'failed', from: 'me', createdAt: 6, sendError: 'A sentence with the contact key 0xABC' }], libraryAcked: ['s1'], libraryMode: true, purgedFlag: false, libraryState: 'purged' }))
		const hook = (window as unknown as { __beamioQaAckOrder: { state(): Promise<unknown> } }).__beamioQaAckOrder
		const state = (await hook.state()) as { chats: Array<{ peer: string; messages: Array<Record<string, unknown>> }>; queue: Array<Record<string, unknown>>; queueDocs: string[]; lock: Record<string, unknown> }
		expect(state.chats).toEqual([{ peer: 'eeeeee', messages: [{ sendId: 's1', status: 'sent', from: 'me', createdAt: 5 }] }])
		expect(state.queue).toEqual([{ sendId: 's1', state: 'awaiting', attempts: 3, confirmedSince: 0, lastAttemptAt: 7 }, { sendId: 's2', state: 'confirmed', attempts: 1, confirmedSince: expect.any(Number), lastAttemptAt: 9 }])
		const extra = state as unknown as { kicks: unknown; confirmedUnbacked: { count: number; oldestAgeMs: number } }
		expect(extra.kicks).toEqual([{ at: 11, trigger: 'heartbeat', online: false, started: 2 }, { at: 12, trigger: '', online: true, started: 0 }]) // a trigger that is not a plain code is dropped, no note leaves
		expect(extra.confirmedUnbacked.count).toBe(1)
		expect(extra.confirmedUnbacked.oldestAgeMs).toBeGreaterThanOrEqual(119_000)
		expect((state as unknown as { conversation: unknown }).conversation).toEqual({ peer: 'eeeeee', messages: [{ sendId: 's1', status: 'delivered', from: 'me', createdAt: 5, sendError: 'route_unconfirmed' }, { sendId: 's2', status: 'failed', from: 'me', createdAt: 6, sendError: '' }], libraryAcked: ['s1'], libraryMode: true, purgedFlag: false, libraryState: 'purged', persistMode: null, capable: null, mountAt: 0, seen: {}, libraryRead: null, firstCopySource: null }) // an error CODE leaves; a sentence never does
		expect(state.queueDocs).toEqual(['s1', 's2'])
		const text = JSON.stringify(state)
		for (const secret of ['SECRET-TEXT', 'SECRET-ARMOR', 'SECRET', '0xeoa', 'AAAAaaaa']) expect(text).not.toContain(secret)
		for (const v of Object.values(state.lock)) expect(['number', 'boolean']).toContain(typeof v)
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})

	it('without the build switch the probes cannot be registered and nothing is exported', async () => {
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		jest.resetModules()
		const mod = await import('./qaAckOrder')
		mod.qaRegisterProbe('chats', () => [{ address: '0x1', messages: [] }])
		const state = await mod.qaExportState()
		expect(state.chats).toEqual([])
		expect((window as unknown as Record<string, unknown>).__beamioQaAckOrder).toBeUndefined()
	})

	it('the probes are registered only inside the compile-time switch (App.tsx and chat.tsx)', () => {
		const app = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8')
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK !== 'true'\) return undefined\s*qaRegisterProbe\('chats'/)
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) \{[^}]*qaRegisterProbe\('queue', \(\) => queue\.snapshot\(\)\)[^}]*qaRegisterProbe\('conversation'/)
		expect(chat).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) \{ qaRegisterProbe\('queue', null\); qaRegisterProbe\('conversation', null\); qaRegisterProbe\('kicks', null\) \}/)
		expect(chat).toMatch(/qaRegisterProbe\('kicks', \(\) => queue\.kickLog\(\)\)/)
		const src = fs.readFileSync(path.join(__dirname, 'qaAckOrder.ts'), 'utf8')
		expect(src).toMatch(/export function qaRegisterProbe\(kind: 'chats' \| 'queue' \| 'docs' \| 'conversation' \| 'kicks' \| 'persist', fn: [^)]*\): void \{\s*if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK !== 'true'\) return/)
	})
})

describe('the state is printed to the console every 5 s (no debugger, no WebSocket)', () => {
	const state = {
		chats: [], queueDocs: ['a', 'b'], lock: { writing: false, unsaved: 0, queued: 2, awaiting: 1, dirtyDrafts: 0, inFlight: 0, heldReload: true, heldRefreshes: 0 },
		queue: [{ sendId: '1767225600000-aaaa1111', state: 'awaiting', attempts: 2, confirmedSince: 0, lastAttemptAt: 5 }, { sendId: '1767225600001-bbbb2222', state: 'confirmed', attempts: 1, confirmedSince: 9, lastAttemptAt: 9 }],
		kicks: [{ at: 1, trigger: 'load', online: true, started: 2 }, { at: 2, trigger: 'heartbeat', online: false, started: 0 }],
		confirmedUnbacked: { count: 1, oldestAgeMs: 123 },
		receiptHold: { held: 5, noKey: 2, unreadable: 1, disk: 1, permanent: 1 },
		transportFault: { mode: 'network_error', hits: 3 },
		receiveCounters: { totals: { arr: 7, dd: 3, ra: 1, re: 4, ro: 3, rf: 1, rk: 0, rn: 0 }, ids: [{ id: 'aaaa1111', arr: 2, dd: 1, ra: 0, re: 1, ro: 1, rf: 0, rk: 0, rn: 0 }] },
		receipts: [{ at: 7, id: 'aaaa1111', from: 'abcdef', outcome: 'no_queue_item' }],
		events: [{ at: 1, n: 'app_start', id: '', dt: 0, x: '' }, { at: 9, n: 'accepted', id: 'aaaa1111', dt: 42, x: '' }, { at: 12, n: 'kick', id: '', dt: 0, x: 'heartbeat' }],
		conversation: { peer: 'eeeeee', messages: [{ sendId: '1767225600000-aaaa1111', status: 'sent', from: 'me', createdAt: 5, sendError: 'route_unconfirmed' }], libraryAcked: ['1767225600001-bbbb2222'], libraryMode: true, purgedFlag: false, libraryState: 'purged', persistMode: 'library', capable: true, mountAt: 5, seen: { aaaa1111: 3 }, libraryRead: 'not_read' },
	}
	it('the line has the fixed tag and carries the queue, kicks, confirmedUnbacked and the conversation evidence, with ids cut to 8 characters', async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		const mod = await import('./qaAckOrder')
		const line = mod.qaStateLine(state as never, 1000)
		expect(line.startsWith('[QA-STATE] {')).toBe(true)
		const body = JSON.parse(line.slice('[QA-STATE] '.length))
		expect(body.t).toBe(1000)
		expect(body.q).toEqual([{ id: 'aaaa1111', s: 'awaiting', a: 2, cs: 0, la: 5 }, { id: 'bbbb2222', s: 'confirmed', a: 1, cs: 9, la: 9 }])
		expect(body.k).toEqual([{ at: 1, tr: 'load', on: 1, n: 2 }, { at: 2, tr: 'heartbeat', on: 0, n: 0 }])
		expect(body.cu).toEqual({ count: 1, oldestAgeMs: 123 })
		expect(body.qd).toBe(2)
		expect(body.rh).toEqual({ h: 5, k: 2, u: 1, d: 1, p: 1 }) // counters only
		expect(body.ft).toEqual({ m: 'network_error', n: 3 })
		expect(body.rx).toEqual({ t: { arr: 7, dd: 3, ra: 1, re: 4, ro: 3, rf: 1, rk: 0, rn: 0 }, i: [{ id: 'aaaa1111', arr: 2, dd: 1, ra: 0, re: 1, ro: 1, rf: 0, rk: 0, rn: 0 }] })
		expect(body.c).toEqual({ peer: 'eeeeee', ma: 5, sn: { aaaa1111: 3 }, lr: 'not_read', lm: true, pf: false, ls: 'purged', pm: 'library', cp: true, ack: ['bbbb2222'], m: [{ id: 'aaaa1111', s: 'sent', e: 'route_unconfirmed' }] })
		expect(body.c.pm).toBe('library') // the persistence rule as it is NOW, read live (not the cache of the last decision)
		expect(body.c.cp).toBe(true)
		expect(body.rc).toEqual([{ at: 7, id: 'aaaa1111', f: 'abcdef', o: 'no_queue_item' }])
		expect(body.ev).toEqual([{ at: 1, n: 'app_start' }, { at: 9, n: 'accepted', id: 'aaaa1111', dt: 42 }, { at: 12, n: 'kick', x: 'heartbeat' }])
		expect(body.lk).toEqual({ w: 0, u: 0, q: 2, aw: 1, d: 0, f: 0, h: 1 })
		expect(line).not.toContain('1767225600000-aaaa1111') // the full id never prints
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})
	it('a conversation of many messages is cut so that the line fits one logcat entry', async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		const mod = await import('./qaAckOrder')
		const many = { ...state, queue: Array.from({ length: 60 }, (_, i) => ({ sendId: `${1767225600000 + i}-xxxxxx${i}`, state: 'failed', attempts: i, confirmedSince: 0, lastAttemptAt: i })), conversation: { ...state.conversation, messages: Array.from({ length: 200 }, (_, i) => ({ sendId: `${1767225600000 + i}-yyyyyy${i}`, status: 'sent', from: 'me', createdAt: i, sendError: '' })) } }
		const line = mod.qaStateLine(many as never, 1)
		expect(line.length).toBeLessThanOrEqual(2800)
		expect(() => JSON.parse(line.slice('[QA-STATE] '.length))).not.toThrow()
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})
	it('the timer sits inside the compile-time switch, prints one console.info per 5 s, and never throws into the page; no WebSocket is involved', async () => {
		const src = fs.readFileSync(path.join(__dirname, 'qaAckOrder.ts'), 'utf8')
		expect(src).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && typeof window !== 'undefined'\) \{[\s\S]*?window\.setInterval\(\(\) => \{\s*void qaExportState\(\)\.then\(\(st\) => qaEmitStateLine\(qaStateLine\(st, Date\.now\(\)\)\)\)\.catch\(\(\) => undefined\)\s*\}, 5000\)\s*\}/)
		expect(src).not.toMatch(/WebSocket|ws:\/\//)
	})
	it('with the switch off nothing is installed and no line is printed', async () => {
		jest.resetModules()
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		jest.useFakeTimers()
		const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
		await import('./qaAckOrder')
		jest.advanceTimersByTime(30_000)
		expect(info.mock.calls.filter((c) => String(c[0]).startsWith('[QA-STATE]'))).toEqual([])
		info.mockRestore()
		jest.useRealTimers()
	})

	it('the line goes through the shells\' debug-log bridge (the production build strips console.*), and still to the console; a bridge that throws never reaches the page', async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		const mod = await import('./qaAckOrder')
		const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
		const calls: string[] = []
		const w = window as unknown as Record<string, unknown>
		w.CashTreesAndroid = { debugLog: (level: string, line: string) => { calls.push(`android:${level}:${line}`) } }
		mod.qaEmitStateLine('[QA-STATE] {"t":1}')
		expect(calls).toEqual(['android:info:[QA-STATE] {"t":1}'])
		delete w.CashTreesAndroid
		w.CashTreesIOS = { debugLog: (level: string, line: string) => { calls.push(`ios:${level}:${line}`) } }
		mod.qaEmitStateLine('[QA-STATE] {"t":2}')
		expect(calls[1]).toBe('ios:info:[QA-STATE] {"t":2}')
		w.CashTreesIOS = { debugLog: () => { throw new Error('bridge down') } }
		expect(() => mod.qaEmitStateLine('[QA-STATE] {"t":3}')).not.toThrow()
		expect(info.mock.calls.map((c) => c[0])).toEqual(['[QA-STATE] {"t":1}', '[QA-STATE] {"t":2}', '[QA-STATE] {"t":3}'])
		delete w.CashTreesIOS
		info.mockRestore()
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete w.__beamioQaAckOrder
	})
	it('the build strips console calls, which is why the bridge is used', () => {
		const craco = fs.readFileSync(path.join(__dirname, '../../craco.config.js'), 'utf8')
		expect(craco).toMatch(/drop_console: true/)
	})

	it('events: click, queue_doc_landed and accepted carry dt (ms since the click); attempt_start, post_answer, native_chat_ready, kick, network_up are recorded with ms timestamps; names and details are plain codes; ids are cut', async () => {
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.useFakeTimers('modern')
		jest.setSystemTime(new Date(1_800_000_000_000))
		const mod = await import('./qaAckOrder')
		mod.qaEvent('click')
		jest.setSystemTime(new Date(1_800_000_000_250))
		mod.qaEvent('queue_doc_landed', '1767225600000-aaaa1111')
		jest.setSystemTime(new Date(1_800_000_000_300))
		mod.qaEvent('accepted', '1767225600000-aaaa1111')
		mod.qaEvent('attempt_start', '1767225600000-aaaa1111')
		mod.qaEvent('post_answer', '1767225600000-aaaa1111')
		mod.qaEvent('native_chat_ready')
		mod.qaEvent('kick', undefined, 'heartbeat')
		mod.qaEvent('bad name!', undefined, 'bad detail 1')
		const list = mod.qaEventList()
		const by = (n: string) => list.filter((e) => e.n === n)
		expect(by('app_start').length).toBe(1)
		expect(by('queue_doc_landed')[0]).toMatchObject({ id: 'aaaa1111', dt: 250 })
		expect(by('accepted')[0]).toMatchObject({ id: 'aaaa1111', dt: 300 })
		expect(by('click')[0].dt).toBeUndefined()
		expect(by('kick')[0].x).toBe('heartbeat')
		expect(list.some((e) => e.n === 'badname')).toBe(true) // cut to plain letters
		expect(JSON.stringify(list)).not.toContain('1767225600000-aaaa1111')
		for (const e of list) expect(Number.isFinite(e.at)).toBe(true)
		window.dispatchEvent(new Event('online'))
		expect(mod.qaEventList().some((e) => e.n === 'network_up')).toBe(true)
		for (let i = 0; i < 200; i++) mod.qaEvent('kick')
		expect(mod.qaEventList().length).toBe(120)
		jest.useRealTimers()
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		delete (window as unknown as Record<string, unknown>).__beamioQaAckOrder
	})
	it('with the switch off no event is recorded and the list is empty; the call sites are all behind the compile-time constant', async () => {
		jest.resetModules()
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		const mod = await import('./qaAckOrder')
		mod.qaEvent('click')
		expect(mod.qaEventList()).toEqual([])
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		for (const name of ["qaEvent('click')", "qaEvent('queue_doc_landed'", "qaEvent('accepted'", "qaEvent('attempt_start'", "qaEvent(ok ? 'post_answer'", "qaEvent('native_chat_ready')", "qaEvent('kick'"]) {
			const at = chat.indexOf(name)
			expect(at).toBeGreaterThan(0)
			expect(chat.slice(Math.max(0, at - 120), at)).toMatch(/process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'/)
		}
	})
})

