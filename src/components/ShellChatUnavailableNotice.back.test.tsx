/**
 * Android review (7edc841f, G2 batch 1): where the unavailable notice replaces a full-screen page, the user must be able to leave.
 * With `onBack` the notice shows one button that calls it; without it (the route-level gate) nothing changes.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import ShellChatUnavailableNotice from './ShellChatUnavailableNotice'

// jest does not resolve the `@/` alias used inside the locale module; the copy is not under test here.
jest.mock('../locale/beamioLocale', () => ({ tu: (key: string) => key }))
// The other notices pull in the PGP stack, which does not load under jest here; the default export does not use them.
jest.mock('./PgpRestoreFailedNotice', () => () => null)
jest.mock('./PgpFirstIdentityNotice', () => () => null)
jest.mock('../services/pgpRestore', () => ({
	getPgpRestoreFailure: () => null,
	subscribePgpRestoreFailure: () => () => undefined,
}))
jest.mock('../services/shellIdentitySource', () => ({
	getShellFirstIdentity: () => false,
	getShellIdentityPending: () => false,
	subscribeShellFirstIdentity: () => () => undefined,
	subscribeShellIdentityPending: () => () => undefined,
}))

describe('ShellChatUnavailableNotice: back control', () => {
	it('with onBack: one button, and a click calls onBack', () => {
		const onBack = jest.fn()
		render(<ShellChatUnavailableNotice onBack={onBack} />)
		const buttons = screen.getAllByRole('button')
		expect(buttons).toHaveLength(1)
		fireEvent.click(buttons[0])
		expect(onBack).toHaveBeenCalledTimes(1)
	})

	it('without onBack (the route-level gate): no button', () => {
		render(<ShellChatUnavailableNotice />)
		expect(screen.queryAllByRole('button')).toHaveLength(0)
	})
})
