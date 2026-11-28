/**
 * R-16 render check: a native-side lock hides "Forgot passcode?"; the page lock shows it.
 */
import { render, screen } from '@testing-library/react'
import PasscodeLockScreen from './PasscodeLockScreen'

jest.mock('../services/beamio', () => ({
	unlockWalletVaultWithPasscode: jest.fn(),
	wipeLocalWalletForRestore: jest.fn(),
	chatDraftDocAdapter: { list: jest.fn(async () => []) },
}))

describe('R-16 render: forgot-passcode by lock kind', () => {
	it('shows "Forgot passcode?" for the page lock (default)', () => {
		render(<PasscodeLockScreen onUnlocked={() => {}} />)
		expect(screen.getByText('Forgot passcode?')).toBeTruthy()
	})

	it('shows "Forgot passcode?" for the explicit page lock', () => {
		render(<PasscodeLockScreen lock="page" onUnlocked={() => {}} />)
		expect(screen.getByText('Forgot passcode?')).toBeTruthy()
	})

	it('hides "Forgot passcode?" for a native lock', () => {
		render(<PasscodeLockScreen lock="native" onUnlocked={() => {}} />)
		expect(screen.queryByText('Forgot passcode?')).toBeNull()
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the reset with unsent messages: the count, the effect, Back cancels, deletion only after the user confirmed
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
import { fireEvent, waitFor } from '@testing-library/react'
import { chatDraftDocAdapter, wipeLocalWalletForRestore } from '../services/beamio'
import { resetChatWriteLockForTest } from '../services/chatWriteLock'

describe('forgot-passcode reset and unsent messages', () => {
	const wipe = wipeLocalWalletForRestore as unknown as jest.Mock
	const adapter = chatDraftDocAdapter as unknown as { list: jest.Mock }
	const open = async () => {
		render(<PasscodeLockScreen onUnlocked={() => {}} />)
		fireEvent.click(screen.getByText('Forgot passcode?'))
		await waitFor(() => expect(adapter.list).toHaveBeenCalled())
	}
	const deleteButton = () => screen.getByRole('button', { name: 'Delete and re-import' }) as HTMLButtonElement
	beforeEach(() => {
		wipe.mockReset().mockResolvedValue(undefined)
		adapter.list.mockReset()
		Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload: jest.fn() } })
	})

	it('with 2 unsent messages: the screen shows the count and the effect; the delete button needs both checkboxes; Back deletes nothing', async () => {
		adapter.list.mockImplementation(async (p: string) => (p === 'chat-queue-v1:' ? ['chat-queue-v1:0xa:s1', 'chat-queue-v1:0xa:s2'] : []))
		await open()
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning')).toBeTruthy())
		expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('2 messages that have not been sent')
		expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('will never be sent')
		const [unsentBox, genericBox] = screen.getAllByRole('checkbox')
		fireEvent.click(genericBox)
		expect(deleteButton().disabled).toBe(true) // the generic confirmation alone is not enough
		fireEvent.click(deleteButton())
		expect(wipe).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: 'Back' })) // cancel
		expect(wipe).not.toHaveBeenCalled()
		void unsentBox
	})
	it('cancelling (Back) forgets the confirmations: opening the reset again needs both checkboxes again', async () => {
		adapter.list.mockImplementation(async (p: string) => (p === 'chat-queue-v1:' ? ['chat-queue-v1:0xa:s1'] : []))
		await open()
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning')).toBeTruthy())
		for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
		expect(deleteButton().disabled).toBe(false)
		fireEvent.click(screen.getByRole('button', { name: 'Back' }))
		fireEvent.click(screen.getByText('Forgot passcode?'))
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning')).toBeTruthy())
		expect(deleteButton().disabled).toBe(true)
		expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => !b.checked)).toBe(true)
		expect(wipe).not.toHaveBeenCalled()
	})
	it('confirmed: both checkboxes, then the wipe runs once WITH includeUnsent', async () => {
		adapter.list.mockImplementation(async (p: string) => (p === 'chat-queue-v1:' ? ['chat-queue-v1:0xa:s1'] : []))
		await open()
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning')).toBeTruthy())
		for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
		expect(deleteButton().disabled).toBe(false)
		fireEvent.click(deleteButton())
		await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
		expect(wipe).toHaveBeenCalledWith({ includeUnsent: true })
	})
	it('nothing unsent but the cloud copy cannot be told: the second confirmation is still required (what was only saved on this device may be lost); the wipe leaves the unsent classes alone', async () => {
		adapter.list.mockResolvedValue([])
		await open()
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('cannot tell whether all sent and received messages have been saved'))
		expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('may not be recoverable')
		const boxes = screen.getAllByRole('checkbox')
		expect(boxes.length).toBe(2)
		fireEvent.click(boxes[1]!)
		expect(deleteButton().disabled).toBe(true)
		fireEvent.click(boxes[0]!)
		expect(deleteButton().disabled).toBe(false)
		fireEvent.click(deleteButton())
		await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
		expect(wipe).toHaveBeenCalledWith({ includeUnsent: false })
	})
	it('while the summary is still being read the button is disabled', async () => {
		adapter.list.mockImplementation(() => new Promise<string[]>(() => undefined))
		await open()
		for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
		expect(deleteButton().disabled).toBe(true)
		fireEvent.click(deleteButton())
		expect(wipe).not.toHaveBeenCalled()
	})
	it('a listing that fails is treated as "may be unsent": the warning and the extra confirmation apply', async () => {
		adapter.list.mockRejectedValue(new Error('x'))
		await open()
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('could not check'))
		expect(screen.getAllByRole('checkbox').length).toBe(2)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the order of the reset: confirmations, then the deletion FINISHES, then one reload through the single reload entry
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the reset reloads only after a confirmed deletion that has finished', () => {
	const wipe = wipeLocalWalletForRestore as unknown as jest.Mock
	const adapter = chatDraftDocAdapter as unknown as { list: jest.Mock }
	let reload: jest.Mock
	const deleteButton = () => screen.getByRole('button', { name: 'Delete and re-import' }) as HTMLButtonElement
	const turn = () => new Promise((r) => setTimeout(r, 20))
	const open = async () => {
		render(<PasscodeLockScreen onUnlocked={() => {}} />)
		fireEvent.click(screen.getByText('Forgot passcode?'))
		await waitFor(() => expect(screen.getByTestId('reset-unsent-warning').textContent).toContain('1 message'))
	}
	const confirmAll = () => { for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box) }
	beforeEach(() => {
		resetChatWriteLockForTest()
		wipe.mockReset().mockResolvedValue(undefined)
		adapter.list.mockReset().mockImplementation(async (p: string) => (p === 'chat-queue-v1:' ? ['chat-queue-v1:0xa:s1'] : []))
		reload = jest.fn()
		Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
	})
	it('not confirmed at all, or only one of the two confirmations: nothing is deleted and nothing reloads', async () => {
		await open()
		fireEvent.click(deleteButton())
		for (const box of screen.getAllByRole('checkbox')) {
			fireEvent.click(box)
			fireEvent.click(deleteButton())
			await turn()
			expect([wipe.mock.calls.length, reload.mock.calls.length]).toEqual([0, 0])
			fireEvent.click(box)
		}
	})
	it('the handler itself refuses without both confirmations, whatever the button says', async () => {
		await open()
		const [first] = screen.getAllByRole('checkbox')
		fireEvent.click(first!)
		deleteButton().disabled = false
		fireEvent.click(deleteButton())
		await turn()
		expect([wipe.mock.calls.length, reload.mock.calls.length]).toEqual([0, 0])
	})
	it('while the deletion has not finished there is no reload; when it has, exactly one', async () => {
		let done!: () => void
		wipe.mockImplementation(() => new Promise<void>((r) => { done = r }))
		await open()
		confirmAll()
		fireEvent.click(deleteButton())
		await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
		await turn()
		expect(reload).not.toHaveBeenCalled()
		done()
		await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
		await turn()
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('a deletion that fails: no reload', async () => {
		wipe.mockRejectedValue(new Error('idb'))
		await open()
		confirmAll()
		fireEvent.click(deleteButton())
		await waitFor(() => expect(wipe).toHaveBeenCalledTimes(1))
		await turn()
		expect(reload).not.toHaveBeenCalled()
	})
})

describe('reset when only the history side may be unsaved (nothing in the queue or the input)', () => {
	const wipe = wipeLocalWalletForRestore as unknown as jest.Mock
	const adapter = chatDraftDocAdapter as unknown as { list: jest.Mock }
	let reload: jest.Mock
	const deleteButton = () => screen.getByRole('button', { name: 'Delete and re-import' }) as HTMLButtonElement
	const turn = () => new Promise((r) => setTimeout(r, 20))
	beforeEach(() => {
		resetChatWriteLockForTest()
		wipe.mockReset().mockResolvedValue(undefined)
		adapter.list.mockReset().mockResolvedValue([])
		reload = jest.fn()
		Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
	})
	for (const [label, reader, words] of [
		['only unarchived messages', async () => 2, '2 sent or received messages have not been saved'],
		['only an unknown state (the read fails)', async () => { throw new Error('history unreadable') }, 'cannot tell whether all sent and received messages have been saved'],
	] as const) {
		const open = async () => {
			fireEvent.click(screen.getByText('Forgot passcode?'))
			await waitFor(() => expect(screen.getByTestId('reset-unsent-warning').textContent).toContain(words))
		}
		it(`${label}: a second confirmation is required; cancelling keeps everything; confirmed, it deletes once and reloads once`, async () => {
			render(<PasscodeLockScreen onUnlocked={() => {}} readUnarchived={reader as () => Promise<number>} />)
			await open()
			expect(screen.getByTestId('reset-unsent-warning').textContent).not.toContain('will never be sent')
			const [second, generic] = screen.getAllByRole('checkbox')
			fireEvent.click(generic!)
			expect(deleteButton().disabled).toBe(true)
			fireEvent.click(deleteButton())
			fireEvent.click(second!)
			expect(deleteButton().disabled).toBe(false)
			fireEvent.click(screen.getByRole('button', { name: 'Back' })) // cancel with everything ticked
			await turn()
			expect([wipe.mock.calls.length, reload.mock.calls.length]).toEqual([0, 0])
			await open()
			expect(deleteButton().disabled).toBe(true) // the confirmations are forgotten
			for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
			fireEvent.click(deleteButton())
			await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
			expect(wipe).toHaveBeenCalledWith({ includeUnsent: false })
			expect(wipe).toHaveBeenCalledTimes(1)
		})
		it(`${label}: a deletion that stops part way (it rejects after some of it was done) does not reload`, async () => {
			let partly = 0
			wipe.mockImplementation(async () => { partly += 1; throw new Error('chat_aux_wipe_failed') })
			render(<PasscodeLockScreen onUnlocked={() => {}} readUnarchived={reader as () => Promise<number>} />)
			await open()
			for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
			fireEvent.click(deleteButton())
			await waitFor(() => expect(partly).toBe(1))
			await turn()
			expect(reload).not.toHaveBeenCalled()
		})
	}
})
