/**
 * Locked page for a native shell with no key. The page asks the shell to open its import screen and never
 * takes a key. SYNTHETIC: no key material in this file.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NativeKeyImportRequired from './NativeKeyImportRequired'
import { openNativeKeyImport, readNativeWalletStatus } from '../services/nativeKeyState'

jest.mock('../services/nativeKeyState', () => ({
	openNativeKeyImport: jest.fn(),
	readNativeWalletStatus: jest.fn(),
}))

// The copy comes from the locale files (checked in locale tests); here the key is returned so the test sees which line shows.
jest.mock('../locale/beamioLocale', () => ({
	tu: (key: string) => key,
}))

const openMock = openNativeKeyImport as jest.MockedFunction<typeof openNativeKeyImport>
const statusMock = readNativeWalletStatus as jest.MockedFunction<typeof readNativeWalletStatus>

beforeEach(() => {
	openMock.mockReset()
	statusMock.mockReset()
})

describe('NativeKeyImportRequired', () => {
	it('shows no text input: the key is typed only on the native import screen', () => {
		const { container } = render(<NativeKeyImportRequired />)
		expect(container.querySelector('input, textarea')).toBeNull()
	})

	it('the import button asks the shell to open its import screen, and shows no error when it opens', async () => {
		openMock.mockResolvedValue('opened')
		render(<NativeKeyImportRequired />)
		fireEvent.click(screen.getAllByRole('button')[0])
		await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1))
		expect(screen.queryByRole('alert')).toBeNull()
	})

	it('a refused or unavailable import screen shows the failure line', async () => {
		openMock.mockResolvedValue('not_supported')
		render(<NativeKeyImportRequired />)
		fireEvent.click(screen.getAllByRole('button')[0])
		expect(await screen.findByRole('alert')).toBeTruthy()
	})

	it('after the import screen opens, walletStatus is read only once the page is visible again', async () => {
		openMock.mockResolvedValue('opened')
		statusMock.mockResolvedValue('no_key')
		render(<NativeKeyImportRequired />)
		fireEvent.click(screen.getAllByRole('button')[0])
		await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1))
		// Let the opened result land and the return listeners attach.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0))
		})
		expect(statusMock).not.toHaveBeenCalled()
		document.dispatchEvent(new Event('visibilitychange'))
		await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1))
	})

	it('a not_available import screen shows the failure line and reads no status', async () => {
		openMock.mockResolvedValue('not_available')
		render(<NativeKeyImportRequired />)
		fireEvent.click(screen.getAllByRole('button')[0])
		expect(await screen.findByRole('alert')).toBeTruthy()
		expect(statusMock).not.toHaveBeenCalled()
	})
})
