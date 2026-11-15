/**
 * wiring: the route, the page props and the createRecover guard are connected as the spec requires.
 * Source-level checks; the browser flow itself is not run here (no browser or device in this run).
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('wiring', () => {
	it('AppEntryGate routes a key without BeamioTag to the create page before the enter branch', () => {
		const src = read('components/AppEntryGate.tsx')
		const route = src.indexOf('beamioTagCreateNeeded({ shell: isShellContext(), presence, completedAccount: hasCompletedBeamioAccount(CoNETData), hasMnemonic: hasLocalPlaintextMnemonic(CoNETData) })')
		const enter = src.indexOf('if (hasAccount) {')
		expect(route).toBeGreaterThan(0)
		expect(enter).toBeGreaterThan(route)
		expect(src).toContain('goOnboarding(false, true)')
		expect(src).toContain('requireBeamioTagCreate={requireBeamioTagCreate}')
	})

	it('LoadingPage opens the create page directly (no hero, no restore) before any URL restore', () => {
		const src = read('pages/Home/LoadingPage.tsx')
		const direct = src.indexOf('if (requireBeamioTagCreate) {')
		const urlRestore = src.indexOf('if (beamioTagParam) {')
		expect(direct).toBeGreaterThan(0)
		expect(urlRestore).toBeGreaterThan(direct)
		const block = src.slice(direct, urlRestore)
		expect(block).toContain("setSettingsOpen('CreateUsernamePinScreen')")
		expect(block).not.toContain('RestoreWalletScreen')
		expect(src).toContain('reuseExistingKey={requireBeamioTagCreate}')
		expect(src).toContain('onRequestClose={requireBeamioTagCreate ? undefined')
	})

	it('CreateUsernamePinScreen passes the reuse requirement to createRecover and has no create or restore branch', () => {
		const src = read('pages/Home/CreateUsernamePinScreen.tsx')
		expect(src).toContain('createRecover(trimmedTag, pwd, { mustReuseKey: reuseExistingKey })')
		expect(src).toContain('hideBack={reuseExistingKey}')
		// The shell comment names createOrGetWallet without a call; the page never calls it.
		expect(src).not.toContain('createOrGetWallet(')
		expect(src).not.toContain('RestoreWallet')
	})

	it('the chrome hides its back control when the page has no back step', () => {
		const src = read('pages/Home/VerraFloatingNavChrome.tsx')
		expect(src).toContain("style={hideBack ? { display: 'none' } : undefined}")
	})

	it('createRecover refuses to create when the page requires reuse, before any createOrGetWallet call', () => {
		const src = read('services/beamio.ts')
		const start = src.indexOf('export const createRecover = async')
		expect(start).toBeGreaterThan(0)
		const body = src.slice(start, src.indexOf('export const', start + 10))
		const guard = body.indexOf('recoverAllowed(source, options.mustReuseKey === true)')
		const create = body.indexOf("createOrGetWallet('')")
		expect(guard).toBeGreaterThan(0)
		expect(create).toBeGreaterThan(guard)
	})
})
