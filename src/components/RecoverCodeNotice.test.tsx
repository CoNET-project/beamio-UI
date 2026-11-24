import { fireEvent, render, screen } from '@testing-library/react'
import RecoverCodeNotice from './RecoverCodeNotice'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))

describe('RecoverCodeNotice', () => {
	it('shows the code; continue stays disabled until the user confirms it was saved; then it continues once', () => {
		const onDone = jest.fn()
		render(<RecoverCodeNotice code="3yZe7d" onDone={onDone} />)
		expect(screen.getByTestId('recover-code').textContent).toBe('3yZe7d')
		const go = screen.getByTestId('recover-code-continue') as HTMLButtonElement
		expect(go.disabled).toBe(true)
		fireEvent.click(go)
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId('recover-code-saved'))
		expect(go.disabled).toBe(false)
		fireEvent.click(go)
		expect(onDone).toHaveBeenCalledTimes(1)
	})
	it('keeps the code out of storage and the console', () => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
		render(<RecoverCodeNotice code="3yZe7d" onDone={() => undefined} />)
		expect(JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage)).not.toContain('3yZe7d')
		expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain('3yZe7d')
		log.mockRestore()
		warn.mockRestore()
	})
})
