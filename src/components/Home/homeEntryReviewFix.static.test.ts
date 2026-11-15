/**
 * Android review (7edc841f, G2 batch 1 fixes): the pay-mode pay QR is not signed in a shell without the chat capability, and the
 * two full-screen replacements have a way back. Read from source; a removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const home = readFileSync(join(__dirname, 'Home.tsx'), 'utf8')
const loading = readFileSync(join(__dirname, '..', '..', 'pages', 'Home', 'LoadingPage.tsx'), 'utf8')

describe('Home pay QR: no signing without the chat capability', () => {
	it('the pay effect returns before signing when the entry is disabled', () => {
		expect(home).toContain('if (!profile?.privateKeyArmor || identityEntryDisabled) {')
		const sign = home.indexOf('signAAtoEOA_USDC_with_BeamioContainerMainRelayedOpenOnConet(\n')
		expect(sign).toBeGreaterThan(-1)
		expect(home.indexOf('if (!profile?.privateKeyArmor || identityEntryDisabled) {')).toBeLessThan(sign)
	})

	it('the effect re-runs when the entry state changes', () => {
		expect(home).toContain('setProfiles, identityEntryDisabled])')
	})

	it('the pay panel shows the unified copy, not the unlock copy, when disabled', () => {
		expect(home).toContain("identityEntryDisabled ? tu('shell_chat_unavailable_body')")
	})
})

describe('full-screen unavailable notice has a way back', () => {
	it('Home coupon overlay: back returns to the choice list', () => {
		expect(home).toContain("<ShellChatUnavailableNotice onBack={() => setActivateGiftVoucherScreen('')} />")
	})

	it('LoadingPage settings coupon screen: back returns to the wallet screen', () => {
		expect(loading).toContain("<ShellChatUnavailableNotice onBack={() => setSettingsOpen('WalletReadyScreen')} />")
	})
})
