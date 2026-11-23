/**
 * a key-only account (private key, no local mnemonic, outside a shell build) enters the app. Its init branch does not
 * set the loading flag, so the global bar and its search show on the home page. The branch still hydrates the profile and binds push,
 * and it does not start gossip. SYNTHETIC values only.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'fs'
import { join } from 'path'
import Footer from './index'

jest.mock('@/providers/DaemonProvider', () => ({
	useDaemonContext: () => ({
		hasNewVersion: false,
		darkModle: false,
		isInitialLoading: false,
		messageCount: 0,
		setMessageCount: jest.fn(),
		setShowFooter: jest.fn(),
		setChatSearchOpen: jest.fn(),
	}),
}))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/services/beamio', () => ({}))
jest.mock('../../utils/globals', () => ({}))

const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')

/** The key-only entry branch of the init: from its condition to its closing brace (two tabs deep in App.tsx). */
// 2026-11-17: the key-only enter branch is gone; no valid mnemonic is not an entry.
function keyOnlyBranch(): string {
	const start = app.indexOf("if (keyOnlyEntry === 'hold_no_key') {")
	expect(start).toBeGreaterThan(-1)
	const end = app.indexOf('\n\t\t}', start)
	expect(end).toBeGreaterThan(start)
	return app.slice(start, end)
}

// Per: "只要没有助记词，就进入 onboarding 页面": a key without a valid mnemonic is not an entry. The branch does not
// hold the loading flag and does not bind push; the entry gate decides onboarding or retry.
describe('a key without a valid mnemonic is not an entry: no loading hold, no push bind, the gate decides', () => {
	it('the enter_key_only branch is removed from the App', () => {
		expect(app).not.toContain("enter_key_only")
	})

	it('the branch does not hold the loading flag, does not bind push, and starts no chat', () => {
		const branch = keyOnlyBranch()
		expect(branch).not.toMatch(/setIsInitialLoading\(true\)/)
		expect(branch).not.toContain('ensureNativePushBoundForWallet')
		expect(branch).not.toMatch(/initChat\(/)
	})

	it('the App wiring is unchanged: Footer follows the loading flag', () => {
		expect(app).toContain('<Footer visible={showFooter && !isInitialLoading} />')
	})

	it('a home page with the loading flag clear shows the search, enabled', () => {
		render(
			<MemoryRouter initialEntries={['/']}>
				<Footer visible />
			</MemoryRouter>,
		)
		const search = screen.getByRole('button', { name: 'search' }) as HTMLButtonElement
		expect(search.disabled).toBe(false)
	})
})
