/**
 * G2 batch 1 (spec, option A): identity entries are disabled in a shell without the chat capability, through
 * one hook. The hook follows the shell's chat UI state. The three batch-1 entry points are checked from source: a removed guard
 * fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { act, renderHook } from '@testing-library/react'
import { setShellChatUiState } from '../services/shellChatUiState'
import { isShellContext } from '../services/shellChatCapability'
import { useIdentityEntryDisabled } from './useIdentityEntryDisabled'

jest.mock('../services/shellChatCapability', () => {
	const actual = jest.requireActual('../services/shellChatCapability')
	return { ...actual, isShellContext: jest.fn() }
})

const isShell = isShellContext as unknown as jest.Mock

beforeEach(() => {
	isShell.mockReturnValue(true)
	setShellChatUiState('browser_chat')
})

describe('useIdentityEntryDisabled', () => {
	it('a shell whose chat is unavailable disables identity entries', () => {
		setShellChatUiState('chat_unavailable')
		const { result } = renderHook(() => useIdentityEntryDisabled())
		expect(result.current).toBe(true)
	})

	it('a shell with the native chat capability keeps identity entries enabled', () => {
		setShellChatUiState('native_chat')
		const { result } = renderHook(() => useIdentityEntryDisabled())
		expect(result.current).toBe(false)
	})

	it('a browser build is never disabled', () => {
		isShell.mockReturnValue(false)
		setShellChatUiState('chat_unavailable')
		const { result } = renderHook(() => useIdentityEntryDisabled())
		expect(result.current).toBe(false)
	})

	it('follows the shell state: an entry turns on when the hello answer declares the capability', () => {
		setShellChatUiState('chat_unavailable')
		const { result } = renderHook(() => useIdentityEntryDisabled())
		expect(result.current).toBe(true)
		act(() => setShellChatUiState('native_chat'))
		expect(result.current).toBe(false)
	})
})

describe('the entry points read the hook or the shared capability check', () => {
	const home = readFileSync(join(__dirname, '..', 'components', 'Home', 'Home.tsx'), 'utf8')
	const loading = readFileSync(join(__dirname, '..', 'pages', 'Home', 'LoadingPage.tsx'), 'utf8')
	const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')

	it('Home: the activated coupon list is replaced by the unified notice when disabled', () => {
		expect(home).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		expect(home).toContain('identityEntryDisabled ? (\n\t\t\t\t\t\t\t\t\t\t<ShellChatUnavailableNotice onBack=')
	})

	it('LoadingPage: the settings coupon list is replaced by the unified notice when disabled', () => {
		expect(loading).toContain('const identityEntryDisabled = useIdentityEntryDisabled()')
		expect(loading).toContain("settingsOpen === 'ActiveCouponsScreen' && identityEntryDisabled ? (")
	})

	it('App: the coupon claim says the chat is unavailable, not that a password unlock is needed, in a shell without the capability', () => {
		expect(app).toContain('shellChatBlockedNow()')
		expect(app).toContain("tu('shell_chat_unavailable_body')")
		expect(app).toContain("tu('unlock_your_wallet_with_your_access_password_to_claim_coupons')")
	})
})
