/**
 * the closed notice and the stopped-retries notice. Clear: idle, then confirm, then the outcome. The copy is the tu key
 * (tu is identity here). The native calls are fakes. SYNTHETIC values only.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShellIdentityClosedNotice, ShellRetryExhaustedNotice } from './ShellIdentityClosedNotice'
import { clearShellChatIdentity, setIdentityClosed } from '../services/shellIdentityClosed'
import { requestShellRetryNow, setShellRetryExhausted } from '../services/shellChatRetryCap'
import { nativeRecoveryOpen } from '../services/nativeRecovery'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('../services/nativeChatRouteRegister', () => ({ requestNativeAck: jest.fn(), nextReqId: () => 1, probeNativeCapabilities: jest.fn() }))
jest.mock('../services/nativeRecovery', () => ({ nativeRecoveryOpen: jest.fn(async () => ({ ok: true })) }))
jest.mock('../services/shellIdentityClosed', () => {
	const actual = jest.requireActual('../services/shellIdentityClosed')
	return { ...actual, clearShellChatIdentity: jest.fn() }
})
jest.mock('../services/shellChatRetryCap', () => {
	const actual = jest.requireActual('../services/shellChatRetryCap')
	return { ...actual, requestShellRetryNow: jest.fn() }
})

const clearMock = clearShellChatIdentity as jest.MockedFunction<typeof clearShellChatIdentity>
const retryMock = requestShellRetryNow as jest.MockedFunction<typeof requestShellRetryNow>
const openMock = nativeRecoveryOpen as jest.MockedFunction<typeof nativeRecoveryOpen>

beforeEach(() => {
	clearMock.mockReset()
	retryMock.mockReset()
	openMock.mockClear()
	setIdentityClosed(null)
	setShellRetryExhausted(false)
})

describe('the closed notice from a clear', () => {
	it('shows the closed copy and the clear button; nothing is cleared before the confirmation', () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		render(<ShellIdentityClosedNotice />)
		expect(screen.getByText('chat.clear_failed.body')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'chat.clear_failed.entry' })).toBeTruthy()
		expect(clearMock).not.toHaveBeenCalled()
	})

	it('the button asks for a confirmation that says what is cleared and that a recovery code is needed', () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		render(<ShellIdentityClosedNotice />)
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_failed.entry' }))
		expect(screen.getByText('chat.clear_confirm.body')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'chat.clear_confirm.ok' })).toBeTruthy()
		expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy()
		expect(clearMock).not.toHaveBeenCalled()
	})

	it('cancel returns to the button without clearing', () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		render(<ShellIdentityClosedNotice />)
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_failed.entry' }))
		fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
		expect(screen.getByRole('button', { name: 'chat.clear_failed.entry' })).toBeTruthy()
		expect(clearMock).not.toHaveBeenCalled()
	})

	it('a confirmed clear that succeeds clears the closed state and runs the re-judgement', async () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		clearMock.mockResolvedValue({ kind: 'ok' })
		const onCleared = jest.fn()
		render(<ShellIdentityClosedNotice onCleared={onCleared} />)
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_failed.entry' }))
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_confirm.ok' }))
		await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1))
		expect(clearMock).toHaveBeenCalledTimes(1)
	})

	it('a refusal (unregister_refused) shows the refusal copy and keeps the clear button', async () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		clearMock.mockResolvedValue({ kind: 'refused' })
		render(<ShellIdentityClosedNotice />)
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_failed.entry' }))
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_confirm.ok' }))
		expect(await screen.findByText('chat.clear_refused.body')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'chat.clear_failed.entry' })).toBeTruthy()
	})

	it('clear_failed again keeps the notice with no refusal copy', async () => {
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		clearMock.mockResolvedValue({ kind: 'failed', code: 'clear_failed' })
		render(<ShellIdentityClosedNotice />)
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_failed.entry' }))
		fireEvent.click(screen.getByRole('button', { name: 'chat.clear_confirm.ok' }))
		await waitFor(() => expect(screen.getByRole('button', { name: 'chat.clear_failed.entry' })).toBeTruthy())
		expect(screen.queryByText('chat.clear_refused.body')).toBeNull()
		expect(screen.getByText('chat.clear_failed.body')).toBeTruthy()
	})
})

describe('the closed notice from an import switch', () => {
	it('the button is the import retry and opens the native import page; nothing is cleared from here', () => {
		setIdentityClosed({ reason: 'unregister_refused', source: 'import' })
		render(<ShellIdentityClosedNotice />)
		expect(screen.queryByRole('button', { name: 'chat.clear_failed.entry' })).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: 'chat.import_retry.entry' }))
		expect(openMock).toHaveBeenCalledTimes(1)
		expect(clearMock).not.toHaveBeenCalled()
	})
})

describe('the stopped-retries notice', () => {
	it('shows the unavailable title and the copy, and the button is the manual retry', () => {
		render(<ShellRetryExhaustedNotice />)
		expect(screen.getByText('shell_chat_unavailable_title')).toBeTruthy()
		expect(screen.getByText('chat.retry_exhausted.body')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'retry' }))
		expect(retryMock).toHaveBeenCalledTimes(1)
	})
})
