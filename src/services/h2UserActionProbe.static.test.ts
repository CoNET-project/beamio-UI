/**
 * Review 92a2c059 H2: a read for a user action that does not feed the page copy takes the probe (checkStorage({ probe: true })), so
 * it does not move the write basis. The start-up read (App init, which builds the page copy) keeps the baseline read. A removed guard
 * fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('H2: user-action storage checks take the probe', () => {
	it('the four user-action callers call checkStorage({ probe: true })', () => {
		const market = read('src/pages/Vouchers/Market.tsx')
		expect(market.split('checkStorage({ probe: true })').length - 1).toBe(2)
		expect(read('src/hooks/useCouponUserLike.ts')).toContain('checkStorage({ probe: true })')
		expect(read('src/utils/ephemeralCouponClaimWallet.ts')).toContain('checkStorage({ probe: true })')
		expect(read('src/components/launchPage/BeamioInstallOnboarding.tsx')).toContain('checkStorage({ probe: true })')
	})

	it('the start-up read in App init keeps the baseline read (it builds the page copy)', () => {
		expect(read('src/App.tsx')).toContain('const fromStore = await checkStorage()')
	})

	it('checkStorageWithStatus has a probe branch with its own in-flight read', () => {
		const beamio = read('src/services/beamio.ts')
		expect(beamio).toContain('readStorageWithStatus(true, { probe: true })')
		expect(beamio).toContain('checkStorageProbeInFlight')
	})

	it('the passcode unlock read is a probe', () => {
		const vault = read('src/services/passcode/walletVault.ts')
		const at = vault.indexOf('export async function unlockWalletPasscode')
		expect(vault.slice(at, at + 900)).toContain('await probeRead(stores)')
	})
})
