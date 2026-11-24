import { act, render, screen } from '@testing-library/react'
import { ShellChatGate } from './ShellChatUnavailableNotice'
import { setFirstIdentitySetup } from '../services/shellFirstIdentitySetup'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('../services/chat', () => ({ regeneratePgpKeyByUser: jest.fn() }))

afterEach(() => act(() => setFirstIdentitySetup('idle')))

describe('ShellChatGate during the first identity setup (QA builds)', () => {
	it('setting up: the notice, no button, no chat', () => {
		render(<ShellChatGate><div data-testid="chat" /></ShellChatGate>)
		expect(screen.getByTestId('chat')).toBeTruthy()
		act(() => setFirstIdentitySetup('setting_up'))
		expect(screen.getByTestId('first-identity-setting-up')).toBeTruthy()
		expect(screen.queryByTestId('chat')).toBeNull()
		expect(screen.queryAllByRole('button')).toHaveLength(0)
		expect(screen.getByText('chat.identity_setting_up.title')).toBeTruthy()
	})
	it('failed: the failure notice, no button; idle again: the chat returns', () => {
		render(<ShellChatGate><div data-testid="chat" /></ShellChatGate>)
		act(() => setFirstIdentitySetup('failed'))
		expect(screen.getByTestId('first-identity-failed')).toBeTruthy()
		expect(screen.queryAllByRole('button')).toHaveLength(0)
		act(() => setFirstIdentitySetup('idle'))
		expect(screen.getByTestId('chat')).toBeTruthy()
	})
})
