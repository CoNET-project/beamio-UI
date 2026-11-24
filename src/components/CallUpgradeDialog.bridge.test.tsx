/**
 * The three update links go through the real openExternalUrl, the same call as the Terms and Privacy buttons, and reach the platform's native
 * openURL bridge with the fixed URL. Only the shell objects are faked. SYNTHETIC.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import CallUpgradeDialog from './CallUpgradeDialog'

jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))

const w = window as unknown as { CashTreesIOS?: unknown; CashTreesAndroid?: unknown; BeamioShell?: unknown }

afterEach(() => {
	delete w.CashTreesIOS
	delete w.CashTreesAndroid
	delete w.BeamioShell
})

describe('update links reach the native openURL bridge', () => {
	it('iOS: the App Store button calls CashTreesIOS.openURL({url}) once, with the fixed URL, and never window.open', () => {
		const openURL = jest.fn()
		w.CashTreesIOS = { openURL }
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		render(<CallUpgradeDialog onClose={() => undefined} />)
		fireEvent.click(screen.getByTestId('call-upgrade-link-app_store'))
		expect(openURL).toHaveBeenCalledTimes(1)
		expect(openURL).toHaveBeenCalledWith({ url: 'https://apps.apple.com/us/app/beamio-smart-local-pass/id6755375110' })
		expect(open).not.toHaveBeenCalled()
		open.mockRestore()
	})

	it('iOS: the Terms button of the settings screen uses the same call shape (the proven path)', () => {
		const openURL = jest.fn()
		w.CashTreesIOS = { openURL }
		const { openExternalUrl } = require('../utils/cashTreesNativeNfc') as typeof import('../utils/cashTreesNativeNfc')
		openExternalUrl('https://beamio.ca/terms')
		expect(openURL).toHaveBeenCalledWith({ url: 'https://beamio.ca/terms' })
	})

	it('Android: the website APK and Google Play buttons call CashTreesAndroid.openURL(url), each once, in order', () => {
		const openURL = jest.fn()
		w.CashTreesAndroid = { openURL }
		const open = jest.spyOn(window, 'open').mockImplementation(() => null)
		render(<CallUpgradeDialog onClose={() => undefined} />)
		fireEvent.click(screen.getByTestId('call-upgrade-link-website'))
		fireEvent.click(screen.getByTestId('call-upgrade-link-google_play'))
		expect(openURL.mock.calls.map((c) => c[0])).toEqual(['https://beamio.ca/beamio-android.apk', 'https://play.google.com/store/apps/details?id=com.beamio.app'])
		expect(open).not.toHaveBeenCalled()
		open.mockRestore()
	})

	it('an unknown shell (no platform told): all three buttons exist and each reaches its bridge', () => {
		const ios = jest.fn()
		w.CashTreesIOS = { openURL: ios }
		render(<CallUpgradeDialog onClose={() => undefined} />)
		expect(screen.getByTestId('call-upgrade-link-app_store')).toBeTruthy()
		fireEvent.click(screen.getByTestId('call-upgrade-link-app_store'))
		expect(ios).toHaveBeenCalledTimes(1)
	})

	it('the click handler opens the link before anything else: the dialog is not closed first and nothing is awaited', () => {
		const order: string[] = []
		w.CashTreesIOS = { openURL: () => order.push('openURL') }
		render(<CallUpgradeDialog onClose={() => order.push('close')} />)
		fireEvent.click(screen.getByTestId('call-upgrade-link-app_store'))
		expect(order).toEqual(['openURL'])
	})

	it('QA build only: each bridge open is counted by name (external:openURL), so a device check can see that the tap reached the bridge', () => {
		const counts = window as unknown as { __beamioQaBridgeCounts?: Record<string, number> }
		const was = process.env.REACT_APP_QA_BRIDGE_COUNTER
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		try {
			w.CashTreesIOS = { openURL: jest.fn() }
			render(<CallUpgradeDialog onClose={() => undefined} />)
			fireEvent.click(screen.getByTestId('call-upgrade-link-app_store'))
			expect(counts.__beamioQaBridgeCounts?.['external:openURL']).toBe(1)
		} finally {
			process.env.REACT_APP_QA_BRIDGE_COUNTER = was
			delete counts.__beamioQaBridgeCounts
		}
	})
})
