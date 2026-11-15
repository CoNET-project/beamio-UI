/**
 * @jest-environment node
 *
 * Option A as a rule (spec, accepted 2026-11-13): inside a shell, the identity paths are blocked unless the shell
 * declared `identity.native-keys.v1` (`native_chat`). The shell answer decides; nothing is assumed.
 */
import { resolveShellChatState, shellChatBlocked } from './shellChatCapability'
import { NATIVE_KEYS_CAPABILITY, ROUTE_REGISTER_CAPABILITY } from './shellChatState'

describe('blocked rule (option A)', () => {
	it('a browser is never blocked, whatever the state', () => {
		for (const state of ['browser_chat', 'native_chat', 'chat_unavailable'] as const) {
			expect(shellChatBlocked({ shell: false, state })).toBe(false)
		}
	})

	it('a shell is blocked unless it is native_chat (also before the answer, which is browser_chat in the store)', () => {
		expect(shellChatBlocked({ shell: true, state: 'chat_unavailable' })).toBe(true)
		expect(shellChatBlocked({ shell: true, state: 'browser_chat' })).toBe(true)
		expect(shellChatBlocked({ shell: true, state: 'native_chat' })).toBe(false)
	})
})

describe('resolution from the shell answer', () => {
	it('a shell with the chat capability is native_chat', () => {
		expect(resolveShellChatState({ buildKind: 'shell', bridge: true, caps: [NATIVE_KEYS_CAPABILITY] })).toBe('native_chat')
	})

	it('a shell without the chat capability is chat_unavailable, even if it declares route registration', () => {
		expect(resolveShellChatState({ buildKind: 'shell', bridge: true, caps: [ROUTE_REGISTER_CAPABILITY] })).toBe('chat_unavailable')
		expect(resolveShellChatState({ buildKind: 'shell', bridge: true, caps: [] })).toBe('chat_unavailable')
	})

	it('a shell build without the bridge is chat_unavailable (never the page-key path)', () => {
		expect(resolveShellChatState({ buildKind: 'shell', bridge: false, caps: [] })).toBe('chat_unavailable')
	})

	it('a browser page is browser_chat', () => {
		expect(resolveShellChatState({ buildKind: 'web', bridge: false, caps: [] })).toBe('browser_chat')
	})
})
