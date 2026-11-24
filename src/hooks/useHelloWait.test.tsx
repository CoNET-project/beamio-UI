import { act, render, screen } from '@testing-library/react'
import { ShellChatGate } from '../components/ShellChatUnavailableNotice'
import ShellChatUnavailableNotice from '../components/ShellChatUnavailableNotice'
import { setNativeIdentityCapability, onNativeIdentityRetryRequested } from '../services/nativeIdentityProbeRetry'
import { setShellChatUiState } from '../services/shellChatUiState'
import { resetSharedHelloForTest, probeNativeCapabilities } from '../services/nativeChatRouteRegister'
import { HELLO_POLL_MS } from './useHelloWait'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('../services/chat', () => ({ regeneratePgpKeyByUser: jest.fn() }))

const w = window as unknown as { CashTreesIOS?: unknown }

beforeEach(() => {
	jest.useFakeTimers()
	resetSharedHelloForTest()
	w.CashTreesIOS = { chatModuleCommand: () => undefined }
	setShellChatUiState('chat_unavailable')
})
afterEach(() => {
	jest.useRealTimers()
	delete w.CashTreesIOS
})

describe('the chat-unavailable notice by hello state', () => {
	it('no valid answer yet, inside the window: "preparing the wallet", never the update text, with a retry button', () => {
		setNativeIdentityCapability('unanswered')
		void probeNativeCapabilities(10_000)
		render(<ShellChatUnavailableNotice />)
		expect(screen.getByText('native_preparing_wallet')).toBeTruthy()
		expect(screen.queryByText('shell_chat_unavailable_body')).toBeNull()
		expect(screen.getByText('native_not_ready_retry_action')).toBeTruthy()
	})
	it('a status not asked yet ("unknown") is also waiting, not "please update"', () => {
		setNativeIdentityCapability('unknown')
		void probeNativeCapabilities(10_000)
		render(<ShellChatUnavailableNotice />)
		expect(screen.queryByText('shell_chat_unavailable_body')).toBeNull()
	})
	it('only a valid hello without the capability ("missing") shows the update text, with no retry button', () => {
		setNativeIdentityCapability('missing')
		render(<ShellChatUnavailableNotice />)
		expect(screen.getByText('shell_chat_unavailable_body')).toBeTruthy()
		expect(screen.queryByText('native_not_ready_retry_action')).toBeNull()
	})
	it('after the 180 s window with no answer: the "try later" text with the retry button (never the update text), and a read-only poll every 30 s while visible', () => {
		setNativeIdentityCapability('unanswered')
		void probeNativeCapabilities(10_000)
		let polls = 0
		const off = onNativeIdentityRetryRequested(() => void polls++)
		render(<ShellChatUnavailableNotice />)
		// the whole window passes with nothing in flight (both hello requests ended without an answer)
		act(() => {
			jest.advanceTimersByTime(181_000)
		})
		expect(screen.queryByText('shell_chat_unavailable_body')).toBeNull()
		const before = polls
		act(() => {
			jest.advanceTimersByTime(HELLO_POLL_MS * 2)
		})
		expect(polls - before).toBe(2)
		off()
	})
	it('a hidden page does not poll', () => {
		setNativeIdentityCapability('unanswered')
		void probeNativeCapabilities(10_000)
		let polls = 0
		const off = onNativeIdentityRetryRequested(() => void polls++)
		render(<ShellChatUnavailableNotice />)
		act(() => {
			jest.advanceTimersByTime(181_000)
		})
		const before = polls
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
		act(() => {
			jest.advanceTimersByTime(HELLO_POLL_MS * 3)
		})
		expect(polls - before).toBe(0)
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
		off()
	})
	void ShellChatGate
})
