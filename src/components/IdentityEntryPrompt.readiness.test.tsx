/**
 * a silent retry is not a fix. A press on a disabled control while the wallet is being prepared gets a VISIBLE status at once, the status changes when the wallet is ready,
 * and the dialog (with Retry) still comes if the silent window runs out. Acceptance is on the iOS simulator by mobile QA; this pins the shared PWA behaviour.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import IdentityEntryPrompt from './IdentityEntryPrompt'
import { IDENTITY_ENTRY_PROMPT_EVENT, IDENTITY_PROMPT_SILENT_WINDOW_MS, IDENTITY_READY_FLASH_MS, readinessFeedbackOf } from '../services/identityEntryPrompt'
import { onNativeIdentityRetryRequested } from '../services/nativeIdentityProbeRetry'
import { isShellChatLive } from '../services/shellChatLive'
import { tu } from '../locale/beamioLocale'
import { readFileSync } from 'fs'
import { join } from 'path'

jest.mock('../services/shellChatCapability', () => ({ shellChatBlockedNow: jest.fn(() => false) }))
jest.mock('../services/shellChatLive', () => ({ isShellChatLive: jest.fn(() => false) }))

const live = isShellChatLive as unknown as jest.Mock
const status = () => screen.queryByTestId('identity-readiness-status')

describe('readinessFeedbackOf (pure)', () => {
	it('the table: preparing while waiting and not live; ready right after live; the dialog covers the status; nothing when idle', () => {
		const f = readinessFeedbackOf
		expect(f({ waiting: true, live: false, dialogOpen: false, readyFlash: false })).toBe('preparing')
		expect(f({ waiting: true, live: false, dialogOpen: true, readyFlash: false })).toBe('none')
		expect(f({ waiting: false, live: false, dialogOpen: false, readyFlash: false })).toBe('none')
		expect(f({ waiting: false, live: true, dialogOpen: false, readyFlash: true })).toBe('ready')
		expect(f({ waiting: false, live: true, dialogOpen: false, readyFlash: false })).toBe('none')
		expect(f({ waiting: true, live: true, dialogOpen: false, readyFlash: false })).toBe('none') // already live: nothing to wait for
	})
})

describe('the shared PWA shows the readiness; a silent retry alone is not the answer', () => {
	beforeEach(() => { live.mockReset().mockReturnValue(false); jest.useFakeTimers() })
	afterEach(() => { jest.useRealTimers() })

	it('a blocked press shows "preparing the wallet" at once (before any 30 s), and the native side is asked again', () => {
		const retry = jest.fn()
		const off = onNativeIdentityRetryRequested(retry)
		render(<IdentityEntryPrompt />)
		expect(status()).toBeNull()
		act(() => { window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT)); jest.advanceTimersByTime(5) })
		expect(status()?.getAttribute('data-state')).toBe('preparing')
		expect(status()?.textContent).toBe(tu('native_preparing_wallet'))
		expect(screen.queryByRole('dialog')).toBeNull()
		expect(retry).toHaveBeenCalled()
		act(() => { jest.advanceTimersByTime(14_000) })
		expect(status()?.getAttribute('data-state')).toBe('preparing') // still visible at 15 s
		off()
	})

	it('when the wallet becomes ready the status changes to "ready" and then goes away; no dialog is ever shown', () => {
		render(<IdentityEntryPrompt />)
		act(() => { window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT)); jest.advanceTimersByTime(5) })
		expect(status()?.getAttribute('data-state')).toBe('preparing')
		live.mockReturnValue(true)
		act(() => { jest.advanceTimersByTime(600) })
		expect(status()?.getAttribute('data-state')).toBe('ready')
		expect(status()?.textContent).toBe(tu('native_wallet_ready'))
		act(() => { jest.advanceTimersByTime(IDENTITY_READY_FLASH_MS + 10) })
		expect(status()).toBeNull()
		expect(screen.queryByRole('dialog')).toBeNull()
	})

	it('when the window runs out the status gives way to the dialog with Retry (the earlier behaviour stays)', () => {
		render(<IdentityEntryPrompt />)
		act(() => { window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT)); jest.advanceTimersByTime(5) })
		expect(status()).not.toBeNull()
		act(() => { jest.advanceTimersByTime(IDENTITY_PROMPT_SILENT_WINDOW_MS + 10) })
		expect(screen.queryByRole('dialog')).not.toBeNull()
		expect(status()).toBeNull()
		expect(screen.queryByRole('button', { name: tu('native_not_ready_retry_action') })).not.toBeNull()
		fireEvent.click(screen.getByRole('button', { name: tu('close') }))
		expect(screen.queryByRole('dialog')).toBeNull()
	})

	it('a press while the chat is already live shows nothing', () => {
		live.mockReturnValue(true)
		render(<IdentityEntryPrompt />)
		act(() => { window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT)); jest.advanceTimersByTime(IDENTITY_PROMPT_SILENT_WINDOW_MS + 10) })
		expect(status()).toBeNull()
		expect(screen.queryByRole('dialog')).toBeNull()
	})

	it('the copy exists in both locale files; the component sets the visible status BEFORE the silent re-ask is left alone (static)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const en = readFileSync(join(__dirname, '../locale/en.json'), 'utf8')
		const zh = readFileSync(join(__dirname, '../locale/zh-CN.json'), 'utf8')
		expect(en).toMatch(/"native_wallet_ready": "Wallet is ready"/)
		expect(zh).toMatch(/"native_wallet_ready": "钱包已就绪"/)
		expect(tu('native_wallet_ready')).toBeTruthy()
		expect(tu('native_wallet_ready')).not.toBe('native_wallet_ready')
		const src = readFileSync(join(__dirname, 'IdentityEntryPrompt.tsx'), 'utf8')
		expect(src).toMatch(/requestNativeIdentityRetry\(\)\s*setWaiting\(true\)/)
		expect(src).toMatch(/data-testid="identity-readiness-status"/)
	})
})
