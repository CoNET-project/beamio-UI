/**
 * The first downward scroll on home hides the global bar and its search, even when the home scroller mounts after the footer effect
 * (the scroll baseline starts from 0). Found in the browser check of the candidate on the first wheel scroll after the home mounted.
 * SYNTHETIC values only.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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

function setScrollRange(node: HTMLDivElement | null) {
	if (!node) return
	Object.defineProperties(node, {
		scrollHeight: { configurable: true, value: 1200 },
		clientHeight: { configurable: true, value: 600 },
	})
}

it('a first downward scroll after the home mounts hides the search at once', () => {
	render(
		<MemoryRouter initialEntries={['/home']}>
			<div data-home-main-scroll ref={setScrollRange} data-testid="home-scroll" />
			<Footer visible />
		</MemoryRouter>,
	)
	const search = screen.getByRole('button', { name: 'search' }) as HTMLButtonElement
	const main = screen.getByTestId('home-scroll')
	main.scrollTop = 120
	fireEvent.scroll(main)
	expect(search.disabled).toBe(true)
})
