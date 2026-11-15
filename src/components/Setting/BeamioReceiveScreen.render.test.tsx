/**
 * the receive card shows the BeamioTag once the account arrives after the screen has mounted (the case that left the
 * card showing "@"after a reload). A real render; the context value changes between renders. SYNTHETIC values only.
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BeamioReceiveScreen from './BeamioReceiveScreen'

// The account context is a mutable value, so the test can make the account arrive after mount.
const mockCtx: Record<string, unknown> = {}
jest.mock('@/providers/DaemonProvider', () => ({ useDaemonContext: () => mockCtx }), { virtual: true })
jest.mock('@/components/assets/32x32.svg', () => 'icon.svg', { virtual: true })
jest.mock('@/components/button/CopyButton', () => () => null, { virtual: true })
jest.mock('@/components/button/AppButton', () => ({ AppButton: () => null }), { virtual: true })
jest.mock(
	'@/services/beamio',
	() => ({
		formatAmountReadable: (n: unknown) => String(n),
		formatWithThousands: (n: unknown) => String(n),
		AuthorizationSign: jest.fn(),
		redeemCodeHash: jest.fn(),
	}),
	{ virtual: true },
)
jest.mock('@/pages/Browser/RedeemSuccessScreen', () => () => null, { virtual: true })
jest.mock('@/utils/deprecatedBeamioConet', () => ({ checkDeprecatedBeamioConetMemo: () => false }), { virtual: true })
jest.mock('@/locale/beamioLocale', () => ({ tu: (key: string) => key }), { virtual: true })
jest.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }))

const ADDRESS = '0x6e7a4E4aB3be01c8014E64d0C6aDdba7047Db51a'

beforeEach(() => {
	for (const k of Object.keys(mockCtx)) delete mockCtx[k]
	Object.assign(mockCtx, {
		darkModle: false,
		setDarkModle: jest.fn(),
		setProfiles: jest.fn(),
		setBeamio: jest.fn(),
		profiles: [],
		myAddress: ADDRESS,
		beamio: undefined,
	})
})

describe('the receive card shows the BeamioTag when the account arrives after mount', () => {
	it('with no account at mount, the card shows no tag; once the account arrives, the next render shows it', () => {
		const { container, rerender } = render(
			<MemoryRouter>
				<BeamioReceiveScreen />
			</MemoryRouter>,
		)
		expect(container.textContent).not.toContain('@developTemp2')

		mockCtx.beamio = { accountName: 'developTemp2' }
		rerender(
			<MemoryRouter>
				<BeamioReceiveScreen />
			</MemoryRouter>,
		)
		expect(container.textContent).toContain('@developTemp2')
	})

	it('a tag that changes later is shown as the new one (the card does not keep the first value)', () => {
		mockCtx.beamio = { accountName: 'developTemp2' }
		const { container, rerender } = render(
			<MemoryRouter>
				<BeamioReceiveScreen />
			</MemoryRouter>,
		)
		expect(container.textContent).toContain('@developTemp2')

		mockCtx.beamio = { accountName: 'developTemp9' }
		rerender(
			<MemoryRouter>
				<BeamioReceiveScreen />
			</MemoryRouter>,
		)
		expect(container.textContent).toContain('@developTemp9')
		expect(container.textContent).not.toContain('@developTemp2')
	})

	it('the full EOA from the context is rendered on the card (one exact check, no alternative paths)', () => {
		const { container } = render(
			<MemoryRouter>
				<BeamioReceiveScreen />
			</MemoryRouter>,
		)
		// The card prints the full address (not only the abbreviated one). The QR canvas is mocked, so the address is read from text.
		expect(container.textContent).toContain(ADDRESS)
	})
})
