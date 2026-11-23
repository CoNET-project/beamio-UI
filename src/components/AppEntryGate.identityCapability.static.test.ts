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
		// Rewritten for the current rule: missingIdentityNotReadyEntry (the identity-missing local-home exit) is retired; the page is read first.
		expect(gate).toContain("import { identityCapabilityFrom, identityEntryDisplay, shellEntryFor, type IdentityCapabilityState } from '@/services/shellEntryDecision'")
		expect(gate).toContain('identityCapabilityFrom(await probeNativeCapabilities())')
	})

	// Rewritten for the current rule (PWA first): the page mnemonic is read before the hello and before the native status wait; the
	// status queries have 10 s timeouts and never decide a valid page mnemonic.
	it('the page is read before the hello, and the hello before the native passcode status read (the status queries have 10 s timeouts)', () => {
		const page = gate.indexOf('const first = await takePageMnemonicRead()')
		const hello = gate.indexOf('identity = await shellIdentityState()')
		const statusRead = gate.indexOf('const passcode = await capStatusRead(reqId, queryNativePasscodeStatus')
		expect(page).toBeGreaterThan(0)
		expect(hello).toBeGreaterThan(page)
		expect(statusRead).toBeGreaterThan(hello)
	})

	// The "missing capability carried as IDENTITY_CAPABILITY_MISSING into the gate state" pin was deleted on purpose: removed the
	// showStorageUnavailable(IDENTITY_CAPABILITY_MISSING) producers, and a missing capability is now the start wait (2026-11-16 rule).

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

	it('the capability check runs before the pre-read and before the page-wallet path, so a shell without the capability never reaches it', () => {
		const check = gate.indexOf('if (!identityDeclared) {')
		const pre = gate.indexOf('const lateAnswer = lateReadRef.current.lateAnswer')
		const pageWalletPath = gate.indexOf('const storageResult = await checkStorageWithTransientRetry()')
		expect(check).toBeGreaterThan(0)
		expect(pre).toBeGreaterThan(check)
		expect(pageWalletPath).toBeGreaterThan(check)
	})

	// Rewritten for the current rule (spec item 42(2)(3)): a real not-ready is unknown, so it no longer sets the native_wallet_ reason.
	// The screen copy stays in the file for the reason's render mapping.
	it('a real not-ready is the startup wait: the native_wallet_ reason is not set, and its copy stays', () => {
		expect(gate).not.toContain("showStorageUnavailable(`native_wallet_${native.status}`)")
		expect(gate).toContain('<h1 className="text-xl font-semibold">Native wallet is not ready</h1>')
	})
})
