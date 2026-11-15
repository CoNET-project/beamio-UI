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
function keyOnlyBranch(): string {
	const start = app.indexOf("if (keyOnlyEntry === 'enter_key_only') {")
	expect(start).toBeGreaterThan(-1)
	const end = app.indexOf('\n\t\t}', start)
	expect(end).toBeGreaterThan(start)
	return app.slice(start, end)
}

describe('a key-only account enters the app with the global bar', () => {
	it('the key-only init branch does not set the loading flag', () => {
		expect(keyOnlyBranch()).not.toMatch(/setIsInitialLoading\(true\)/)
	})

	it('the branch keeps the profile hydration and the push binding, and does not start gossip', () => {
		const branch = keyOnlyBranch()
		expect(branch).toContain('setProfiles(profiles)')
		expect(branch).toContain('ensurePushDeviceTokenListener()')
		expect(branch).toContain('ensureNativePushBoundForWallet(profiles[0])')
		expect(branch).not.toMatch(/initChat\(/)
		expect(branch).toMatch(/return\s*$/)
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
