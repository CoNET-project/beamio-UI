/**
 * Self-drawn passcode keypad. SYNTHETIC values only. The keypad must not contain any text input (frozen protocol 〇之一 item 9).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import PasscodeKeypad from './PasscodeKeypad'
import { applyPasscodeKey } from './passcodeKeypadReducer'

const GOOD = '12395784'

const renderPad = (value: string, extra: Partial<React.ComponentProps<typeof PasscodeKeypad>> = {}) => {
	const onChange = jest.fn()
	const onConfirm = jest.fn()
	const onSkip = jest.fn()
	const utils = render(
		<PasscodeKeypad
			value={value}
			onChange={onChange}
			onConfirm={onConfirm}
			onSkip={onSkip}
			confirmLabel="设定"
			skipLabel="以后再说"
			deleteLabel="删除"
			{...extra}
		/>,
	)
	return { ...utils, onChange, onConfirm, onSkip }
}

describe('applyPasscodeKey', () => {
	it('appends a digit', () => {
		expect(applyPasscodeKey('1239', '5')).toBe('12395')
	})
	it('caps the length at twelve digits', () => {
		expect(applyPasscodeKey('123456789012', '3')).toBe('123456789012')
	})
	it('delete removes the last digit and does nothing on empty', () => {
		expect(applyPasscodeKey('1239', 'delete')).toBe('123')
		expect(applyPasscodeKey('', 'delete')).toBe('')
	})
	it('refuses anything that is not a digit key', () => {
		expect(applyPasscodeKey('12', 'x' as never)).toBe('12')
	})
})

describe('PasscodeKeypad', () => {
	it('contains no text input, so the digits cannot be pasted or autofilled', () => {
		const { container } = renderPad('')
		expect(container.querySelector('input')).toBeNull()
		expect(container.querySelector('textarea')).toBeNull()
	})

	it('a digit button calls onChange with the appended value', () => {
		const { onChange } = renderPad('1239')
		fireEvent.click(screen.getByRole('button', { name: '5' }))
		expect(onChange).toHaveBeenCalledWith('12395')
	})

	it('the delete button removes one digit', () => {
		const { onChange } = renderPad('1239')
		fireEvent.click(screen.getByRole('button', { name: '删除' }))
		expect(onChange).toHaveBeenCalledWith('123')
	})

	it('设定 stays disabled while the value fails the policy, and enables for a valid passcode', () => {
		const { rerender, onConfirm } = renderPad('1234')
		expect((screen.getByRole('button', { name: '设定' }) as HTMLButtonElement).disabled).toBe(true)
		rerender(
			<PasscodeKeypad value={GOOD} onChange={() => undefined} onConfirm={onConfirm} onSkip={() => undefined} confirmLabel="设定" skipLabel="以后再说" deleteLabel="删除" />,
		)
		const set = screen.getByRole('button', { name: '设定' }) as HTMLButtonElement
		expect(set.disabled).toBe(false)
		fireEvent.click(set)
		expect(onConfirm).toHaveBeenCalledWith(GOOD)
	})

	it('以后再说 calls onSkip and is available without any digits', () => {
		const { onSkip } = renderPad('')
		fireEvent.click(screen.getByRole('button', { name: '以后再说' }))
		expect(onSkip).toHaveBeenCalledTimes(1)
	})

	it('a disabled keypad sends no key', () => {
		const { onChange } = renderPad('1239', { disabled: true })
		expect((screen.getByRole('button', { name: '5' }) as HTMLButtonElement).disabled).toBe(true)
		fireEvent.click(screen.getByRole('button', { name: '5' }))
		expect(onChange).not.toHaveBeenCalled()
	})

	it('the dot line shows the length only, never the digits', () => {
		renderPad(GOOD)
		const line = screen.getByLabelText('8/12')
		expect(line.textContent).toBe('••••••••')
		expect(line.textContent).not.toContain('1')
	})
})
