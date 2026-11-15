/**
 * (transport choice to) and (replies to, origin to). The page
 * sends through one transport; an injected window.BeamioShellRecord is used alone (no fallback, even when it cannot be used);
 * replies come on the injected object's onmessage and are matched by reqId; a request times out after 10 seconds.
 */
import { sendShellRecordCommand, sendWindowOnlyCommand, setPageOriginForTest, shellRecordTransportKind, SHELL_RECORD_REPLY_TIMEOUT_MS } from './shellRecordTransport'

const CMD = { type: 'shellRecordRead', reqId: 77 }
const ANDROID_ORIGIN = 'https://appassets.androidplatform.net'
const w = window as unknown as Record<string, unknown>

beforeEach(() => {
	delete w.BeamioShellRecord
	delete w.CashTreesIOS
	delete w.CashTreesAndroid
	delete w.webkit
	setPageOriginForTest(null)
})

type Host = { postMessage: jest.Mock; onmessage: ((ev: unknown) => void) | null }

/** An injected object. `reply` is called with each sent request; its return value (if any) is delivered on onmessage. */
function injectedHost(reply?: (reqId: unknown) => unknown): Host {
	const host: Host = { postMessage: jest.fn(), onmessage: null }
	host.postMessage.mockImplementation((msg: string) => {
		const req = JSON.parse(msg) as { reqId: unknown }
		const answer = reply ? reply(req.reqId) : undefined
		if (answer !== undefined) host.onmessage?.({ data: JSON.stringify(answer) })
	})
	w.BeamioShellRecord = host
	return host
}

const ok = (reqId: unknown, result: Record<string, unknown> = { code: 'absent' }) => ({ type: 'ack', reqId, ok: true, result })

describe('TP: the transport choice (2)', () => {
	it('Android injected, origin allowed: the injected object answers', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		w.CashTreesAndroid = { getNfcStatus: () => 'ok' }
		const host = injectedHost((reqId) => ok(reqId))
		expect(shellRecordTransportKind()).toBe('window')
		const a = await sendShellRecordCommand(CMD)
		expect(a).toEqual({ kind: 'payload', payload: { type: 'ack', reqId: 77, ok: true, result: { code: 'absent' } } })
		expect(host.postMessage).toHaveBeenCalledTimes(1)
	})

	it('Android injected, origin not allowed: origin_refused, nothing sent, the chat channel not used', async () => {
		setPageOriginForTest('https://evil.example')
		const chat = jest.fn()
		w.CashTreesAndroid = { getNfcStatus: () => 'ok', chatModuleCommand: chat }
		const host = injectedHost((reqId) => ok(reqId))
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'origin_refused' })
		expect(host.postMessage).not.toHaveBeenCalled()
		expect(chat).not.toHaveBeenCalled()
	})

	it('Android not injected: not_supported, and the chat channel is never used', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		const chat = jest.fn()
		w.CashTreesAndroid = { getNfcStatus: () => 'ok', chatModuleCommand: chat }
		expect(shellRecordTransportKind()).toBe('not_supported')
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'not_supported' })
		expect(chat).not.toHaveBeenCalled()
	})

	it('iOS injected: the injected object is used', async () => {
		w.CashTreesIOS = { chatModuleCommand: jest.fn() }
		const host = injectedHost((reqId) => ok(reqId))
		expect(shellRecordTransportKind()).toBe('window')
		await sendShellRecordCommand(CMD)
		expect(host.postMessage).toHaveBeenCalledTimes(1)
	})

	it('iOS injected, origin not in the list the shell gave: origin_refused, no fallback to the chat channel', async () => {
		setPageOriginForTest('https://other.example')
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat }
		const host = injectedHost((reqId) => ok(reqId))
		Object.assign(host, { allowedOrigins: ['https://app.example'] })
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'origin_refused' })
		expect(host.postMessage).not.toHaveBeenCalled()
		expect(chat).not.toHaveBeenCalled()
	})

	it('iOS not injected, origin allowed: the chat module channel answers (its reply comes as a shell event)', async () => {
		const chat = jest.fn((p: { command: { reqId: number } }) => {
			setTimeout(() => {
				window.dispatchEvent(
					new CustomEvent('cashtreesios', {
						detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId: p.command.reqId, ok: true, result: { code: 'absent' } } },
					}),
				)
			}, 0)
		})
		w.CashTreesIOS = { chatModuleCommand: chat }
		expect(shellRecordTransportKind()).toBe('chat')
		const a = await sendShellRecordCommand(CMD)
		expect(a).toEqual({ kind: 'payload', payload: { type: 'ack', reqId: 77, ok: true, result: { code: 'absent' } } })
		expect(chat).toHaveBeenCalledWith({ action: 'chatModuleCommand', command: CMD })
	})

	it('iOS not injected, origin not in the list: origin_refused, nothing sent', async () => {
		setPageOriginForTest('https://other.example')
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat, allowedOrigins: ['https://app.example'] }
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'origin_refused' })
		expect(chat).not.toHaveBeenCalled()
	})

	it('a browser has no channel: none, and nothing is sent', async () => {
		expect(shellRecordTransportKind()).toBe('none')
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'none' })
	})

	it('Android not injected, the chat module channel present: not_supported; the chat channel is never used', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		const chat = jest.fn()
		w.CashTreesAndroid = { getNfcStatus: () => 'ok', chatModuleCommand: chat }
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'not_supported' })
		expect(chat).not.toHaveBeenCalled()
	})

	it('iOS with no chat module channel: none (no fallback exists)', async () => {
		w.webkit = { messageHandlers: { CashTreesIOS: {} } }
		expect(shellRecordTransportKind()).toBe('none')
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'none' })
	})

	it('an injected object that cannot be used is unavailable, and the chat channel is not used (no fallback)', async () => {
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat }
		w.BeamioShellRecord = { onmessage: null } // defined, but no postMessage
		expect(shellRecordTransportKind()).toBe('window')
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'unavailable' })
		expect(chat).not.toHaveBeenCalled()
	})
})

describe('RP: replies on the injected object (4)', () => {
	beforeEach(() => {
		jest.useFakeTimers()
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	it('an ok reply with the matching reqId resolves the request', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify(ok(77, { code: 'ok', rev: 3 })) })
		expect(await p).toEqual({ kind: 'payload', payload: ok(77, { code: 'ok', rev: 3 }) })
	})

	it('a reply with an unknown reqId is ignored; the request keeps waiting', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify(ok(9999)) })
		host.onmessage?.({ data: JSON.stringify(ok(77, { code: 'absent' })) })
		expect(await p).toEqual({ kind: 'payload', payload: ok(77, { code: 'absent' }) })
	})

	it('a duplicate reply: the first one is the answer, the second is ignored', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify(ok(77, { code: 'absent' })) })
		host.onmessage?.({ data: JSON.stringify(ok(77, { code: 'ok', rev: 99 })) })
		expect(await p).toEqual({ kind: 'payload', payload: ok(77, { code: 'absent' }) })
	})

	it('no reply within 10 seconds is timeout; a late reply is ignored', async () => {
		expect(SHELL_RECORD_REPLY_TIMEOUT_MS).toBe(10_000)
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		jest.advanceTimersByTime(10_000)
		expect(await p).toEqual({ kind: 'timeout' })
		expect(() => host.onmessage?.({ data: JSON.stringify(ok(77)) })).not.toThrow()
	})

	it('a non-ack envelope (the old shellRecordResult event) is ignored', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify({ type: 'shellRecordResult', reqId: 77, code: 'ok' }) })
		host.onmessage?.({ data: JSON.stringify(ok(77)) })
		expect(await p).toEqual({ kind: 'payload', payload: ok(77) })
	})

	it('ok:false with an error code is the native answer (reject with its code)', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: 77, ok: false, error: 'origin_refused' }) })
		expect(await p).toEqual({ kind: 'payload', payload: { type: 'ack', reqId: 77, ok: false, error: 'origin_refused' } })
	})

	it('a malformed reply is ignored and a valid reply still completes the request', async () => {
		const host = injectedHost()
		const p = sendShellRecordCommand(CMD)
		host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: 77, ok: true }) }) // ok without result
		host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: 77, ok: false, error: 5 }) }) // error not a string
		host.onmessage?.({ data: 'not json' })
		host.onmessage?.({ data: JSON.stringify(ok(77, { code: 'absent' })) })
		expect(await p).toEqual({ kind: 'payload', payload: ok(77, { code: 'absent' }) })
	})

	it('a reqId that is still open is not sent again', async () => {
		injectedHost()
		const first = sendShellRecordCommand(CMD)
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'unavailable' })
		jest.advanceTimersByTime(10_000)
		expect(await first).toEqual({ kind: 'timeout' })
	})
})

describe('OR: the origin is checked page-side before sending; a reply is not checked for origin here (5)', () => {
	it('an origin that is not allowed: nothing is sent and there is no reply', async () => {
		setPageOriginForTest('https://evil.example')
		w.CashTreesAndroid = { getNfcStatus: () => 'ok' }
		const host = injectedHost((reqId) => ok(reqId))
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'origin_refused' })
		expect(host.postMessage).not.toHaveBeenCalled()
	})

	it('an allowed origin and a valid reqId: one reply completes the request', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		w.CashTreesAndroid = { getNfcStatus: () => 'ok' }
		injectedHost((reqId) => ok(reqId))
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'payload', payload: ok(77) })
	})

	it('an allowed origin and a reply with reqId null (bad_request) matches no open request: it is ignored', async () => {
		jest.useFakeTimers()
		try {
			setPageOriginForTest(ANDROID_ORIGIN)
			w.CashTreesAndroid = { getNfcStatus: () => 'ok' }
			const host = injectedHost()
			const p = sendShellRecordCommand(CMD)
			host.onmessage?.({ data: JSON.stringify({ type: 'ack', reqId: null, ok: false, error: 'bad_request' }) })
			jest.advanceTimersByTime(10_000)
			expect(await p).toEqual({ kind: 'timeout' })
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('an injection that is present is the only channel (no fallback to the chat module)', () => {
	it('iOS, window.BeamioShellRecord = null (present, unusable): unavailable; the chat channel is not used', async () => {
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat }
		w.BeamioShellRecord = null
		expect(shellRecordTransportKind()).toBe('window')
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'unavailable' })
		expect(chat).not.toHaveBeenCalled()
	})

	it('iOS, window.BeamioShellRecord = undefined (present, unusable): unavailable; the chat channel is not used', async () => {
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat }
		w.BeamioShellRecord = undefined
		expect(await sendShellRecordCommand(CMD)).toEqual({ kind: 'unavailable' })
		expect(chat).not.toHaveBeenCalled()
	})

	it('iOS, the property is not present at all: the chat channel answers', async () => {
		const chat = jest.fn()
		w.CashTreesIOS = { chatModuleCommand: chat }
		expect(shellRecordTransportKind()).toBe('chat')
	})
})

describe('window-only commands never use the chat channel (walletEoaAddress, walletCredential)', () => {
	it('no injected object and a chat channel present: not_supported, and the chat channel is never called', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		const chat = jest.fn()
		w.CashTreesAndroid = { getNfcStatus: () => 'ok', chatModuleCommand: chat }
		expect(await sendWindowOnlyCommand({ type: 'walletCredential', reqId: 1 })).toEqual({ kind: 'not_supported' })
		expect(chat).not.toHaveBeenCalled()
	})
	it('an injected object is used alone', async () => {
		setPageOriginForTest(ANDROID_ORIGIN)
		const host = injectedHost((reqId) => ok(reqId, { eoa: '0x' + '9'.repeat(40) }))
		const answer = await sendWindowOnlyCommand({ type: 'walletEoaAddress', reqId: 3 })
		expect(answer.kind).toBe('payload')
		expect(host.postMessage).toHaveBeenCalledTimes(1)
	})
})

