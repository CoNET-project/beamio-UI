/**
 * @jest-environment node
 *
 * The chat UI state in a shell (option A): a store with subscribers, read by the chat gate.
 */
import { getShellChatUiState, setShellChatUiState, subscribeShellChatUiState } from './shellChatUiState'

afterEach(() => setShellChatUiState('browser_chat'))

describe('shell chat UI state', () => {
	it('starts as the browser chat', () => {
		expect(getShellChatUiState()).toBe('browser_chat')
	})

	it('notifies subscribers on a change only, and stops after unsubscribe', () => {
		const seen: string[] = []
		const off = subscribeShellChatUiState((s) => seen.push(s))
		setShellChatUiState('chat_unavailable')
		setShellChatUiState('chat_unavailable')
		setShellChatUiState('native_chat')
		off()
		setShellChatUiState('browser_chat')
		expect(seen).toEqual(['chat_unavailable', 'native_chat'])
		expect(getShellChatUiState()).toBe('browser_chat')
	})
})
