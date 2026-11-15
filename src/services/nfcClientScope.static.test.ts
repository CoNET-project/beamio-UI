/**
 * @jest-environment node
 *
 * Client NFC scope (2026-11-13), read from the sources:
 *  - the shell hides the NFC top-up and NFC pay entries (POS-owned, suspended this round); the browser keeps them;
 *  - the shell reads cards through the neutral shell read, never through Web NFC and never through a bind action;
 *  - the simulated bind UI in renderAction is gone (residue).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('shell hides NFC top-up and NFC pay (POS-owned, suspended)', () => {
	const v1 = read('src/pages/Pay/components/TenKeyInput.tsx')
	const v2 = read('src/pages/Pay/components/TenKeyInputV2.tsx')

	it('both keypads import the shell test', () => {
		expect(v1).toMatch(/import \{ isShellContext \} from '@\/services\/shellContext'/)
		expect(v2).toMatch(/import \{ isShellContext \} from '@\/services\/shellContext'/)
	})

	it('the NFC pay prop is withheld in a shell (the button is not drawn)', () => {
		expect(v1).toMatch(/onPaymentWithNfc=\{isShellContext\(\) \? undefined : handlePaymentWithNfc\}/)
		expect(v2).toMatch(/onPaymentWithNfc=\{isShellContext\(\) \? undefined : handlePaymentWithNfc\}/)
	})

	it('the NFC top-up prop and sheet are withheld in a shell (V2)', () => {
		expect(v2).toMatch(/onNfcTopup=\{isShellContext\(\) \? undefined : handleNfcTopup\}/)
		expect(v2).toMatch(/\{!isShellContext\(\) && \(\s*<NfcTopupBottomSheet/)
	})

	it('the handlers return early in a shell as well', () => {
		expect(v1).toMatch(/const handlePaymentWithNfc = async \(\) => \{\s*\/\/ Shell[^\n]*\n\s*if \(isShellContext\(\)\) return/)
		expect(v2).toMatch(/const handleNfcTopup = \(\) => \{\s*\/\/ Shell[^\n]*\n\s*if \(isShellContext\(\)\) return/)
		expect(v2).toMatch(/const handlePaymentWithNfc = async \(\) => \{\s*\/\/ Shell[^\n]*\n\s*if \(isShellContext\(\)\) return/)
	})
})

describe('page-side NFC top-up signing is refused in a shell', () => {
	it('services/beamio nfcTopup returns before any page-held key is used', () => {
		const src = read('src/services/beamio.ts')
		const at = src.indexOf('export const nfcTopup = async')
		const guard = src.indexOf('if (isShellContext()) return', at)
		const sign = src.indexOf('wallet.signTypedData', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(sign).toBeGreaterThan(guard)
	})

	it('the top-up session NFC branch returns before the page-held key is resolved', () => {
		const src = read('src/utils/discoverUsdcTopupSession.ts')
		const at = src.indexOf('export async function completeDiscoverUsdcTopupBeneficiary')
		const guard = src.indexOf('if (isShellContext()) return', at)
		const key = src.indexOf('resolveSigningPrivateKeyArmor(params.profile)', at)
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(at)
		expect(key).toBeGreaterThan(guard)
	})
})

describe('shell card read goes through the neutral read, not Web NFC or a bind action', () => {
	const hook = read('src/hooks/useNfcRead.ts')

	it('the hook checks the shell before Web NFC and calls the neutral read', () => {
		const shell = hook.indexOf('if (isShellContext()) {')
		const web = hook.indexOf("if (!('NDEFReader' in window))")
		expect(shell).toBeGreaterThan(0)
		expect(web).toBeGreaterThan(shell)
		expect(hook).toMatch(/import \{ nativeNfcUidRead \} from '@\/services\/nativeNfcUidRead'/)
	})

	it('no source outside the tests uses a bind action for reading', () => {
		const files = [
			'src/hooks/useNfcRead.ts',
			'src/services/nativeNfcUidRead.ts',
			'src/pages/Pay/components/TenKeyInput.tsx',
			'src/pages/Pay/components/TenKeyInputV2.tsx',
		]
		for (const f of files) expect(read(f)).not.toMatch(/startPhysicalCardBind|cancelPhysicalCardBind/)
	})
})

describe('renderAction: the simulated bind UI is removed ( residue)', () => {
	const ra = read('src/renderAction/index.tsx')

	it('no scanner state, no timer that marks a card as bound, no bind overlay', () => {
		expect(ra).not.toMatch(/showNFCScanner|setShowNFCScanner/)
		expect(ra).not.toMatch(/isPhysicalCardBound|setIsPhysicalCardBound/)
		expect(ra).not.toMatch(/setTimeout\(\(\) => \{[\s\S]{0,120}setHasAAWallet/)
	})

	it('no bind entry points or their labels', () => {
		expect(ra).not.toMatch(/Sync NFC Card|Option 2: Got a Card|bind_physical_card|Card Linked/)
	})
})

describe('payByNfcUid is refused in a shell before any request, and is unchanged in the browser', () => {
	const src = read('src/services/beamio.ts')
	const at = src.indexOf('export const payByNfcUid = async')
	const end = src.indexOf('export const toBase64', at)
	const body = src.slice(at, end)
	const guard = body.indexOf('if (isShellContext()) return')
	const fetchAt = body.indexOf('fetch(')

	it('the shell guard returns the accurate error before the request is made', () => {
		expect(at).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(-1)
		expect(fetchAt).toBeGreaterThan(guard)
		expect(body.slice(guard, fetchAt)).toContain("'NFC payment is not available in this app.'")
	})

	it('the shell refusal touches no key: nothing before the guard reads a profile or a private key', () => {
		expect(body.slice(0, guard)).not.toMatch(/privateKey|CoNET_Data|profiles|ethers\.Wallet/)
	})

	it('the browser path is unchanged: the same endpoint, the same request body, and the same result shape', () => {
		expect(body).toContain('fetch(`${beamioApi}/api/payByNfcUid`, {')
		expect(body).toContain('body: JSON.stringify(params),')
		expect(body).toMatch(/return \{\s*success: res\.ok && data\.success !== false,/)
	})
})

