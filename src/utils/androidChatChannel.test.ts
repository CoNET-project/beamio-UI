/**
 * the Android chat channel. With window.BeamioChat the page sends commands as JSON strings through postMessage, sends
 * sign answers as objects, and receives the shell's JSON strings on onmessage, dispatched as the cashtreesandroid event. Without it,
 * the legacy CashTreesAndroid methods are used. origin_refused is a failure. SYNTHETIC values only.
 */
import { publishNativePwaLog } from './cashTreesNativePwaLog'
import {
	androidChatChannelKind,
	installBeamioChatReceiver,
	isChatChannelFailure,
	postAndroidChatCommand,
	postAndroidSignResponse,
} from './androidChatChannel'

jest.mock('./cashTreesNativePwaLog', () => ({
	publishNativePwaLog: jest.fn(),
}))

const w = window as unknown as { BeamioChat?: unknown; CashTreesAndroid?: unknown }
const realTop = window.top

function setTop(value: unknown) {
	Object.defineProperty(window, 'top', { value, configurable: true })
}

afterEach(() => {
	delete w.BeamioChat
	delete w.CashTreesAndroid
	setTop(realTop)
	;(publishNativePwaLog as jest.Mock).mockReset()
})

describe('trusted top frame only (0.52.935 rule, carried into 0.53.30)', () => {
	it('same-origin child frame with window.BeamioChat: kind is not beamio, nothing is sent, the receiver is a no-op', () => {
		setTop({}) // a different window object: a child frame
		const host: { postMessage?: unknown; onmessage?: unknown } = { postMessage: jest.fn() }
		w.BeamioChat = host
		expect(androidChatChannelKind()).toBe('none')
		expect(postAndroidChatCommand({ type: 'walletStatus', reqId: 1 })).toBe(false)
		expect(postAndroidSignResponse({ reqId: 1, ok: true })).toBe(false)
		expect(host.postMessage).not.toHaveBeenCalled()
		expect(installBeamioChatReceiver()).toBeNull()
		expect(host.onmessage).toBeUndefined()
	})

	it('cross-origin child frame (reading window.top throws) with window.BeamioChat: not trusted, nothing is sent', () => {
		Object.defineProperty(window, 'top', {
			configurable: true,
			get() {
				throw new Error('SecurityError')
			},
		})
		const host: { postMessage?: unknown; onmessage?: unknown } = { postMessage: jest.fn() }
		w.BeamioChat = host
		expect(androidChatChannelKind()).toBe('none')
		expect(postAndroidChatCommand({ type: 'walletStatus', reqId: 2 })).toBe(false)
		expect(host.postMessage).not.toHaveBeenCalled()
		expect(installBeamioChatReceiver()).toBeNull()
	})

	it('top frame (window.top === window.self) with window.BeamioChat: trusted, the channel and receiver are used', () => {
		setTop(window.self)
		const host: { postMessage?: unknown; onmessage?: unknown } = { postMessage: jest.fn() }
		w.BeamioChat = host
		expect(androidChatChannelKind()).toBe('beamio')
		expect(postAndroidChatCommand({ type: 'walletStatus', reqId: 3 })).toBe(true)
		expect(host.postMessage).toHaveBeenCalledTimes(1)
		expect(installBeamioChatReceiver()).not.toBeNull()
		expect(host.onmessage).toEqual(expect.any(Function))
	})
})

describe('channel selection', () => {
	it('window.BeamioChat present: the new channel is used', () => {
		w.BeamioChat = { postMessage: jest.fn() }
		expect(androidChatChannelKind()).toBe('beamio')
	})

	it('no BeamioChat, CashTreesAndroid.chatModuleCommand present: the legacy channel is used', () => {
		w.CashTreesAndroid = { chatModuleCommand: jest.fn() }
		expect(androidChatChannelKind()).toBe('legacy')
	})

	it('neither: none', () => {
		expect(androidChatChannelKind()).toBe('none')
	})
})

describe('commands', () => {
	it('new channel: the command is sent as a JSON string with the same fields, and the legacy method is not called', () => {
		const postMessage = jest.fn()
		const legacy = { chatModuleCommand: jest.fn() }
		w.BeamioChat = { postMessage }
		w.CashTreesAndroid = legacy
		const cmd = { type: 'walletStatus', reqId: 7 }
		expect(postAndroidChatCommand(cmd)).toBe(true)
		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith(JSON.stringify(cmd))
		expect(legacy.chatModuleCommand).not.toHaveBeenCalled()
	})

	it('new channel present without postMessage: the command is not sent and the legacy method is not used', () => {
		const legacy = { chatModuleCommand: jest.fn() }
		w.BeamioChat = {}
		w.CashTreesAndroid = legacy
		expect(postAndroidChatCommand({ type: 'walletStatus', reqId: 1 })).toBe(false)
		expect(legacy.chatModuleCommand).not.toHaveBeenCalled()
	})

	it('legacy channel: the command is sent through chatModuleCommand as a JSON string', () => {
		const legacy = { chatModuleCommand: jest.fn() }
		w.CashTreesAndroid = legacy
		const cmd = { type: 'walletStatus', reqId: 3 }
		expect(postAndroidChatCommand(cmd)).toBe(true)
		expect(legacy.chatModuleCommand).toHaveBeenCalledWith(JSON.stringify(cmd))
	})

	it('no channel: false', () => {
		expect(postAndroidChatCommand({ type: 'walletStatus', reqId: 1 })).toBe(false)
	})
})

describe('sign responses', () => {
	const payload = { reqId: 9, ok: true, signature: '0xSYNTHETIC' }

	it('new channel: the answer is a JSON string with type chatModuleSignResponse and the same fields (never a bare object)', () => {
		const postMessage = jest.fn()
		const legacy = { chatModuleSignResponse: jest.fn() }
		w.BeamioChat = { postMessage }
		w.CashTreesAndroid = legacy
		expect(postAndroidSignResponse(payload)).toBe(true)
		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'chatModuleSignResponse', ...payload }))
		expect(typeof postMessage.mock.calls[0][0]).toBe('string')
		expect(legacy.chatModuleSignResponse).not.toHaveBeenCalled()
	})

	it('legacy channel: chatModuleSignResponse is called with the JSON string', () => {
		const legacy = { chatModuleSignResponse: jest.fn() }
		w.CashTreesAndroid = legacy
		expect(postAndroidSignResponse(payload)).toBe(true)
		expect(legacy.chatModuleSignResponse).toHaveBeenCalledWith(JSON.stringify(payload))
	})
})

describe('receiving on the new channel', () => {
	it('a JSON string on onmessage is dispatched as the cashtreesandroid event with the parsed object as detail', () => {
		const host: { postMessage?: unknown; onmessage?: ((ev: unknown) => void) | null } = { postMessage: jest.fn() }
		w.BeamioChat = host
		const listener = jest.fn()
		window.addEventListener('cashtreesandroid', listener)
		try {
			installBeamioChatReceiver()
			const detail = { action: 'chatModuleEvent', event: { type: 'ack', reqId: 4, ok: true } }
			host.onmessage?.(JSON.stringify(detail))
			expect(listener).toHaveBeenCalledTimes(1)
			expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(detail)
		} finally {
			window.removeEventListener('cashtreesandroid', listener)
		}
	})

	it('a chatModuleSignRequest is dispatched the same way', () => {
		const host: { postMessage?: unknown; onmessage?: ((ev: unknown) => void) | null } = { postMessage: jest.fn() }
		w.BeamioChat = host
		const listener = jest.fn()
		window.addEventListener('cashtreesandroid', listener)
		try {
			installBeamioChatReceiver()
			const detail = { action: 'chatModuleSignRequest', reqId: 5, digest: '0xSYNTHETIC' }
			host.onmessage?.(JSON.stringify(detail))
			expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(detail)
		} finally {
			window.removeEventListener('cashtreesandroid', listener)
		}
	})

	it('a message that is not a JSON object is dropped', () => {
		const host: { postMessage?: unknown; onmessage?: ((ev: unknown) => void) | null } = { postMessage: jest.fn() }
		w.BeamioChat = host
		const listener = jest.fn()
		window.addEventListener('cashtreesandroid', listener)
		try {
			installBeamioChatReceiver()
			expect(() => host.onmessage?.('not json')).not.toThrow()
			expect(() => host.onmessage?.(JSON.stringify(42))).not.toThrow()
			expect(listener).not.toHaveBeenCalled()
		} finally {
			window.removeEventListener('cashtreesandroid', listener)
		}
	})

	it('without window.BeamioChat, installing does nothing', () => {
		expect(installBeamioChatReceiver()).toBeNull()
	})
})

describe('origin_refused is a failure, and only its code is logged', () => {
	it('isChatChannelFailure: origin_refused and any refused ack are failures; a success ack is not', () => {
		expect(isChatChannelFailure({ type: 'ack', reqId: 1, ok: false, error: 'origin_refused' })).toBe(true)
		expect(isChatChannelFailure({ type: 'ack', reqId: 1, ok: false, error: 'no_key' })).toBe(true)
		expect(isChatChannelFailure({ type: 'ack', reqId: 1, ok: true })).toBe(false)
		expect(isChatChannelFailure({ type: 'chatModuleEvent' })).toBe(false)
		expect(isChatChannelFailure(null)).toBe(false)
	})

	it('an origin_refused ack is still dispatched as the failure it is, and the log carries the code only', () => {
		const host: { postMessage?: unknown; onmessage?: ((ev: unknown) => void) | null } = { postMessage: jest.fn() }
		w.BeamioChat = host
		const listener = jest.fn()
		window.addEventListener('cashtreesandroid', listener)
		try {
			installBeamioChatReceiver()
			host.onmessage?.(JSON.stringify({ type: 'ack', reqId: 2, ok: false, error: 'origin_refused' }))
			const detail = (listener.mock.calls[0][0] as CustomEvent).detail as { ok: boolean; error: string }
			expect(detail.ok).toBe(false)
			expect(detail.error).toBe('origin_refused')
			const logged = (publishNativePwaLog as jest.Mock).mock.calls.map((c) => String(c[1])).join('\n')
			expect(logged).toContain('origin_refused')
			expect(logged).not.toContain('reqId')
		} finally {
			window.removeEventListener('cashtreesandroid', listener)
		}
	})
})
