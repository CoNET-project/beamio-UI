/**
 * unit e: UI chat access guard. Real guard module; only walletVault's session drop is observed (jest.fn).
 * SYNTHETIC account values only.
 */
import React from 'react'
import { render, screen, act } from '@testing-library/react'

const mockLockWalletSession = jest.fn()
jest.mock('./walletVault', () => ({ lockWalletSession: (...a: unknown[]) => mockLockWalletSession(...a) }))

const ACCT_A = '0x1111111111111111111111111111111111111111'
const ACCT_B = '0x2222222222222222222222222222222222222222'

import * as guard from './chatAccessGuard'
import { ChatAccessBoundary } from './chatAccessBoundary'

const loadGuard = () => {
	let mod: typeof import('./chatAccessGuard') | undefined
	jest.isolateModules(() => {
		mod = require('./chatAccessGuard')
	})
	return mod!
}

beforeEach(() => {
	mockLockWalletSession.mockClear()
	jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
	jest.restoreAllMocks()
})

describe('chat access guard: state', () => {
	test('reload: a fresh module starts with no unlock record and no lock', () => {
		const g = loadGuard()
		g.unlockChatAccess(ACCT_A)
		expect(g.getChatAccessState().unlockedAccount).toBe(ACCT_A)
		const fresh = loadGuard()
		expect(fresh.getChatAccessState()).toEqual({ locked: false, unlockedAccount: null })
	})

	test('re-lock clears the unlock record and drops the passcode session key', () => {
		const g = loadGuard()
		g.unlockChatAccess(ACCT_A)
		g.lockChatAccess()
		expect(g.getChatAccessState()).toEqual({ locked: true, unlockedAccount: null })
		expect(mockLockWalletSession).toHaveBeenCalledTimes(1)
		expect(g.chatAccessRefused('history_read')).toBe(true)
	})

	test('unlock resumes access; an unlocked state refuses nothing', () => {
		const g = loadGuard()
		g.lockChatAccess()
		expect(g.chatAccessRefused('send')).toBe(true)
		g.unlockChatAccess(ACCT_A)
		expect(g.chatAccessRefused('send')).toBe(false)
		expect(g.chatAccessRefused('history_read')).toBe(false)
		expect(g.chatAccessRefused('history_load')).toBe(false)
		expect(g.chatAccessRefused('local_read')).toBe(false)
	})

	test('account switch: account A unlock is not carried to account B', () => {
		const g = loadGuard()
		g.unlockChatAccess(ACCT_A)
		g.clearChatAccessState(true)
		expect(g.getChatAccessState()).toEqual({ locked: true, unlockedAccount: null })
		expect(mockLockWalletSession).toHaveBeenCalledTimes(1)
		expect(g.chatAccessRefused('send')).toBe(true)
		g.unlockChatAccess(ACCT_B)
		expect(g.getChatAccessState().unlockedAccount).toBe(ACCT_B)
		expect(g.getChatAccessState().unlockedAccount).not.toBe(ACCT_A)
	})

	test('sign-out without a passcode drops the record but keeps no lock', () => {
		const g = loadGuard()
		g.unlockChatAccess(ACCT_A)
		g.clearChatAccessState(false)
		expect(g.getChatAccessState()).toEqual({ locked: false, unlockedAccount: null })
		expect(g.chatAccessRefused('send')).toBe(false)
	})
})

describe('chat access boundary (chat page)', () => {
	const renders = { count: 0 }
	const ChatInterfaceSpy = () => {
		renders.count++
		return <div data-testid="chat-interface" />
	}

	beforeEach(() => {
		renders.count = 0
		guard.unlockChatAccess(ACCT_A)
	})

	test('unlocked: the chat interface renders', () => {
		render(<ChatAccessBoundary><ChatInterfaceSpy /></ChatAccessBoundary>)
		expect(screen.getByTestId('chat-interface')).toBeTruthy()
		expect(renders.count).toBe(1)
	})

	test('locked: the chat interface is not rendered', () => {
		guard.lockChatAccess()
		render(<ChatAccessBoundary><ChatInterfaceSpy /></ChatAccessBoundary>)
		expect(screen.queryByTestId('chat-interface')).toBeNull()
		expect(screen.getByTestId('chat-access-locked')).toBeTruthy()
		expect(renders.count).toBe(0)
	})

	test('unlock after a lock mounts the chat interface', () => {
		guard.lockChatAccess()
		render(<ChatAccessBoundary><ChatInterfaceSpy /></ChatAccessBoundary>)
		expect(renders.count).toBe(0)
		act(() => guard.unlockChatAccess(ACCT_A))
		expect(screen.getByTestId('chat-interface')).toBeTruthy()
		expect(renders.count).toBe(1)
	})
})
