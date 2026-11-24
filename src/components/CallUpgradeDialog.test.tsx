import { fireEvent, render, screen } from '@testing-library/react'
import CallUpgradeDialog from './CallUpgradeDialog'
import { getCashTreesNativeNfcHost, openExternalUrl } from '../utils/cashTreesNativeNfc'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
jest.mock('../utils/cashTreesNativeNfc', () => ({ getCashTreesNativeNfcHost: jest.fn(), openExternalUrl: jest.fn() }))

const host = getCashTreesNativeNfcHost as jest.Mock
const open = openExternalUrl as jest.Mock

beforeEach(() => {
	host.mockReset()
	open.mockReset()
})

describe('the old-shell update prompt', () => {
	it('iOS: one App Store button; nothing opens until the user taps it; then exactly that URL opens', () => {
		host.mockReturnValue('ios')
		render(<CallUpgradeDialog onClose={() => undefined} />)
		expect(open).not.toHaveBeenCalled()
		expect(screen.queryByTestId('call-upgrade-link-website')).toBeNull()
		expect(screen.queryByTestId('call-upgrade-link-google_play')).toBeNull()
		fireEvent.click(screen.getByTestId('call-upgrade-link-app_store'))
		expect(open).toHaveBeenCalledTimes(1)
		expect(open).toHaveBeenCalledWith('https://apps.apple.com/us/app/beamio-smart-local-pass/id6755375110')
	})
	it('Android: two separate buttons, each opening its own URL', () => {
		host.mockReturnValue('android')
		render(<CallUpgradeDialog onClose={() => undefined} />)
		expect(screen.queryByTestId('call-upgrade-link-app_store')).toBeNull()
		fireEvent.click(screen.getByTestId('call-upgrade-link-website'))
		expect(open).toHaveBeenLastCalledWith('https://beamio.ca/beamio-android.apk')
		fireEvent.click(screen.getByTestId('call-upgrade-link-google_play'))
		expect(open).toHaveBeenLastCalledWith('https://play.google.com/store/apps/details?id=com.beamio.app')
		expect(open).toHaveBeenCalledTimes(2)
	})
	it('the copy is the existing update line; the close button only closes', () => {
		host.mockReturnValue('android')
		const onClose = jest.fn()
		render(<CallUpgradeDialog onClose={onClose} />)
		expect(screen.getByText('call.upgrade.chat')).toBeTruthy()
		fireEvent.click(screen.getByTestId('call-upgrade-close'))
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(open).not.toHaveBeenCalled()
	})
})
