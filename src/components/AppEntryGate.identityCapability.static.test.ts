/**
 * A shell without identity.native-keys.v1 shows the unified state on the
 * chat and identity entries only. It does not replace the app: pages that need no identity keep working. The gate keeps the app
 * decided and renders its children. A real not-ready keeps its own prompt. Reads the source; the decision itself is tested in
 * shellEntryDecision.test.ts.
 */
import fs from 'fs'
import path from 'path'

const gate = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('AppEntryGate and the missing identity capability', () => {
	it('the capability state comes from the hello probe and the decision is the shared pure function', () => {
		expect(gate).toContain("import { identityCapabilityFrom, shellEntryFor, type IdentityCapabilityState } from '@/services/shellEntryDecision'")
		expect(gate).toContain('identityCapabilityFrom(await probeNativeCapabilities())')
	})

	it('the missing capability is carried as the same code (IDENTITY_CAPABILITY_MISSING) into the gate state', () => {
		expect(gate).toContain("import { IDENTITY_CAPABILITY_MISSING } from '@/services/bridgeGuard'")
		expect(gate).toContain('showStorageUnavailable(IDENTITY_CAPABILITY_MISSING)')
	})

	it('the missing capability does not replace the app: the gate is decided and renders its children (Outlet)', () => {
		expect(gate).toContain('if (reason === IDENTITY_CAPABILITY_MISSING) {')
		const branch = gate.slice(gate.indexOf('if (reason === IDENTITY_CAPABILITY_MISSING) {'))
		expect(branch.slice(0, 200)).toContain('setGateDecided(true)')
		expect(gate).toContain('<Outlet />')
	})

	it('the gate renders no full-screen chat-unavailable notice (the chat and identity entries show it)', () => {
		expect(gate).not.toContain('storageUnavailable === IDENTITY_CAPABILITY_MISSING')
		expect(gate).not.toContain('<ShellChatUnavailableNotice')
		expect(gate).not.toContain("from '@/components/ShellChatUnavailableNotice'")
	})

	it('the chat routes keep their own guard (ShellChatGate) and identity-independent routes are not wrapped in it', () => {
		const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8')
		expect(app).toContain('<Route path="/Chat" element={<ShellChatGate><Chat /></ShellChatGate>} />')
		expect(app).toContain('<Route path="/settings" element={<MyWallet />} />')
	})

	it('the check runs before the no_key branch, so a shell without the capability never reaches the page-wallet path', () => {
		const check = gate.indexOf('shellEntryFor(identity, native)')
		const noKey = gate.indexOf("[AppEntryGate] native wallet: no key")
		expect(check).toBeGreaterThan(0)
		expect(noKey).toBeGreaterThan(check)
	})

	it('a real not-ready keeps the existing prompt: the native_wallet_ reason and its copy are unchanged', () => {
		expect(gate).toContain("showStorageUnavailable(`native_wallet_${native.status}`)")
		expect(gate).toContain('<h1 className="text-xl font-semibold">Native wallet is not ready</h1>')
	})
})
