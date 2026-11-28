/**
 * 0.53.52: what the user sees for the SDK-driven first identity. "Setting up": text only. "Failed": text that says the next start retries, no button,
 * no retry control. "Identity pending" (a shell without the capability): text only. Real copy through tu. SYNTHETIC.
 */
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
jest.mock('../services/chat', () => ({ regeneratePgpKeyByUser: jest.fn() }))
import { FirstIdentityFailedNotice, FirstIdentitySettingUpNotice, ShellIdentityPendingNotice } from './ShellChatUnavailableNotice'

beforeAll(async () => {
	await i18next.changeLanguage('en')
})

describe('the three states show only text', () => {
	it('setting up: text, no button, no link', () => {
		render(<FirstIdentitySettingUpNotice />)
		expect(screen.getByTestId('first-identity-setting-up').textContent).toMatch(/being set up/)
		expect(screen.queryByRole('button')).toBeNull()
		expect(screen.queryByRole('link')).toBeNull()
	})
	it('failed: says the next start retries; no button, no retry control', () => {
		render(<FirstIdentityFailedNotice />)
		const el = screen.getByTestId('first-identity-failed')
		expect(el.textContent).toMatch(/next time the app starts/)
		expect(el.textContent).not.toMatch(/Can't read/)
		expect(screen.queryByRole('button')).toBeNull()
		expect(screen.queryByRole('link')).toBeNull()
	})
	it('identity pending (a shell that does not declare identity.first.status.v1): text, no button', () => {
		render(<ShellIdentityPendingNotice />)
		expect(screen.getByRole('status').textContent).toMatch(/pending/i)
		expect(screen.queryByRole('button')).toBeNull()
	})
	it('failed, in Chinese: says the next start retries', async () => {
		await i18next.changeLanguage('zh-CN')
		render(<FirstIdentityFailedNotice />)
		expect(screen.getByTestId('first-identity-failed').textContent).toMatch(/下次启动/)
		expect(screen.queryByRole('button')).toBeNull()
		await i18next.changeLanguage('en')
	})
})
