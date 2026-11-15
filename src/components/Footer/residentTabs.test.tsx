/**
 * A (review of the home footer patch): the scroll hide belongs to the home page only. The four main tab pages keep the
 * global bar and its search resident. Also pins the App-level footer wiring: the start loading state does not write showFooter false,
 * and /home renders Home. SYNTHETIC values only.
 */
import { fireEvent, render, screen } from '@testing-library/react'
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

function setScrollRange(node: HTMLDivElement | null) {
	if (!node) return
	Object.defineProperties(node, {
		scrollHeight: { configurable: true, value: 1200 },
		clientHeight: { configurable: true, value: 600 },
	})
}

function Page({ path }: { path: string }) {
	return (
		<MemoryRouter initialEntries={[path]}>
			<div data-testid="page-scroll" ref={setScrollRange} />
			<Footer visible />
		</MemoryRouter>
	)
}

function scroll(node: HTMLElement, top: number) {
	node.scrollTop = top
	fireEvent.scroll(node)
}

describe('the main tab pages keep the global bar resident', () => {
	for (const path of ['/wallet', '/chat', '/discover', '/bountyboard']) {
		it(`${path}: a downward scroll does not hide the search or the bar`, () => {
			render(<Page path={path} />)
			const search = screen.getByRole('button', { name: 'search' }) as HTMLButtonElement
			const scroller = screen.getByTestId('page-scroll')
			scroll(scroller, 120)
			scroll(scroller, 300)
			scroll(scroller, 600)
			expect(search.disabled).toBe(false)
			expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
		})
	}
})

describe('the App-level footer wiring', () => {
	const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')
	const footer = readFileSync(join(__dirname, 'index.tsx'), 'utf8')

	it('the start loading state does not write showFooter false (no sticky hidden flag from the boot screen)', () => {
		expect(app).not.toMatch(/if \(isInitialLoading\) setShowFooter\(false\)/)
		expect(app).toContain('<Footer visible={showFooter && !isInitialLoading} />')
	})

	it('/home renders Home inside the entry gate, and the footer keeps its home scroll rule only on the home route', () => {
		expect(app).toContain('<Route path="/home" element={<Home />} />')
		expect(footer).toContain('const isHomeRoute = /^\\/(?:home\\/?)?$/i.test(pathname)')
		expect(footer).toContain('|| !isHomeRoute) return')
	})
})
