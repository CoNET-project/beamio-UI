/**
 * The shared identity hint: while the hello is unanswered it says the native side is not ready yet and offers a manual
 * retry. Otherwise it keeps the unified unavailable copy and offers no retry.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import ShellChatUnavailableNotice from './ShellChatUnavailableNotice'
// the restore notice loads the chat module, which does not load under jest; this test reads only the identity hint.
jest.mock('./PgpRestoreFailedNotice', () => ({ __esModule: true, default: () => null }))
import { onNativeIdentityRetryRequested, setNativeIdentityCapability } from '../services/nativeIdentityProbeRetry'
import { tu } from '../locale/beamioLocale'

afterEach(() => {
	setNativeIdentityCapability('unknown')
})

describe('the identity hint while the native hello is unanswered', () => {
	it('shows the not-ready hint and a retry action that requests a probe', () => {
		setNativeIdentityCapability('unanswered')
		const retry = jest.fn()
		const off = onNativeIdentityRetryRequested(retry)
		render(<ShellChatUnavailableNotice />)
		// inside the hello window the text says the wallet is getting ready; the retry action is there from the start
		expect(screen.getByText(tu('native_preparing_wallet'))).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: tu('native_not_ready_retry_action') }))
		expect(retry).toHaveBeenCalledTimes(1)
		off()
	})
})

describe('the identity hint once the capability is confirmed missing', () => {
	it('keeps the unified copy and offers no retry', () => {
		setNativeIdentityCapability('missing')
		render(<ShellChatUnavailableNotice />)
		expect(screen.getByText(tu('shell_chat_unavailable_body'))).toBeTruthy()
		expect(screen.queryByRole('button', { name: tu('native_not_ready_retry_action') })).toBeNull()
	})
})
