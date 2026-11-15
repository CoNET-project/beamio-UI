import { fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import Footer from './index'

const mockOpenSearch = jest.fn()

jest.mock('@/providers/DaemonProvider', () => ({
	useDaemonContext: () => ({
		hasNewVersion: false,
		darkModle: false,
		isInitialLoading: false,
		messageCount: 0,
		setMessageCount: jest.fn(),
		setShowFooter: jest.fn(),
		setChatSearchOpen: mockOpenSearch,
	}),
}))
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('@/services/beamio', () => ({}))
jest.mock('../../utils/globals', () => ({}))

function Pathname() {
	return <output>{useLocation().pathname}</output>
}

function setScrollRange(node: HTMLDivElement | null) {
	if (!node) return
	Object.defineProperties(node, {
		scrollHeight: { configurable: true, value: 1200 },
		clientHeight: { configurable: true, value: 600 },
	})
}

function Screen({ visible }: { visible: boolean }) {
	return (
		<>
			<div data-home-main-scroll ref={setScrollRange} data-testid="home-scroll">
				<div ref={setScrollRange} data-testid="nested-scroll" />
			</div>
			<Footer visible={visible} />
			<Pathname />
			<Link to="/home">Open Home</Link>
		</>
	)
}

function scroll(node: HTMLElement, top: number) {
	node.scrollTop = top
	fireEvent.scroll(node)
}

it('keeps search and Chat available initially, hides on downward Home scroll and reveals on upward scroll', () => {
	render(<MemoryRouter initialEntries={['/home']}><Screen visible /></MemoryRouter>)
	const main = screen.getByTestId('home-scroll')
	const search = screen.getByRole('button', { name: 'search' }) as HTMLButtonElement
	expect(search.disabled).toBe(false)
	scroll(screen.getByTestId('nested-scroll'), 60)
	scroll(screen.getByTestId('nested-scroll'), 120)
	expect(search.disabled).toBe(false)

	for (const top of [3, 6, 9]) scroll(main, top)
	expect(search.disabled).toBe(true)
	expect(screen.queryByRole('button', { name: 'chat' })).toBeNull()

	scroll(main, 700) // WebKit can report a value beyond the scrollable range.
	scroll(main, 635)
	expect(search.disabled).toBe(true)
	scroll(main, 580)
	expect(search.disabled).toBe(false)
	fireEvent.click(search)
	expect(mockOpenSearch).toHaveBeenCalledWith(true)
	fireEvent.click(screen.getByRole('button', { name: 'chat' }))
	expect(screen.getByText('/chat')).toBeTruthy()
})

it('reveals after a sheet closes, after returning to the top, and on re-entering Home', () => {
	const view = (visible: boolean) => <MemoryRouter><Screen visible={visible} /></MemoryRouter>
	const { rerender } = render(view(true))
	const main = screen.getByTestId('home-scroll')
	scroll(main, 80)
	expect(screen.queryByRole('button', { name: 'search' })).toBeNull()
	rerender(view(false))
	rerender(view(true))
	expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
	scroll(main, 150)
	expect(screen.queryByRole('button', { name: 'search' })).toBeNull()
	scroll(main, -5)
	expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
	scroll(main, 90)
	expect(screen.queryByRole('button', { name: 'search' })).toBeNull()
	fireEvent.click(screen.getByRole('link', { name: 'Open Home' }))
	expect(screen.getByText('/home')).toBeTruthy()
	expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
})
