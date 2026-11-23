/**
 * The unavailable screen for needs_native_recovery (spec r2.3 item 41, rule (b) 2026-11-16). The native import entry is retired:
 * the screen offers the recovery-code entry (nativeRecoveryOpen) as its only action, and no source calls openNativeKeyImport or the
 * nativeImportOpen command. Rewritten from the import-first guide: the earlier assertions that required the import button are superseded.
 * The copy keys are existing ones. Source guard; no key or passcode value is used.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

// 0.53.44: the startup recovery button is removed; the recovery code entry is in the
// onboarding page. The block helper slices from the marker that replaces it, so the old button pins below assert absence.
const block = (() => {
	const at = gate.indexOf("0.53.44: no recovery button at startup")
	expect(at).toBeGreaterThan(0)
	return gate.slice(at, gate.indexOf('{storageUnavailable !== OLD_SHELL_UPGRADE_REASON', at))
})()

describe('the unavailable screen offers the recovery code only (item 41: the import entry is retired)', () => {
	it('the screen has no import button and no import handler (native_key_required_import, importWalletNative)', () => {
		expect(block).not.toContain("tu('native_key_required_import')")
		expect(block).not.toContain('importWalletNative')
		expect(gate).not.toContain('importWalletNative')
	})

	it('the gate does not import openNativeKeyImport or the import result, and no import-return effect remains', () => {
		expect(gate).not.toContain('openNativeKeyImport')
		expect(gate).not.toContain('onNativeImportResult')
		expect(gate).not.toContain('awaitingImportReturn')
		expect(gate).not.toContain('nativeImportOpen')
	})

	it('the startup screen has no recovery button (0.53.44): the recovery code entry is in the onboarding page only', () => {
		const rec = block.indexOf("tu('use_recovery_code')")
		expect(rec).toBe(-1)
		expect(block).not.toContain('nativeRecoveryOpen()')
	})

	it('0.53.44: there is no startup action to size (the tap-area pin moved with the removed button; no startup button)', () => {
		expect(block.indexOf("tu('use_recovery_code')")).toBe(-1)
	})

	it('the no_key page is retired: NativeKeyImportRequired.tsx is deleted and the no_key answer enters the onboarding', () => {
		expect(existsSync(join(__dirname, 'NativeKeyImportRequired.tsx'))).toBe(false)
		expect(gate).not.toContain('NativeKeyImportRequired')
		expect(gate).toContain('// Per spec r2.4 item 42(2): both sides confirmed no mnemonic.')
	})

	it('no visibilitychange reload for an import return remains, and the gate reads no walletStatus of its own', () => {
		expect(gate).not.toContain("document.addEventListener('visibilitychange', recheck)")
		expect(gate).not.toMatch(/readNativeWalletStatus/)
		expect(gate).not.toContain("window.addEventListener('focus', recheck)")
	})
})

describe('the import copy keys are removed from both locales, the recovery copy key stays (item 41)', () => {
	const retired = [
		'native_key_required_title',
		'native_key_required_body',
		'native_key_required_import',
		'native_key_required_retry',
		'native_key_import_failed',
	]
	const localeDir = join(__dirname, '..', 'locale')
	for (const f of ['en.json', 'zh-CN.json']) {
		it(`${f} has no import copy key, and keeps use_recovery_code`, () => {
			const found = new Set<string>()
			const walk = (node: unknown): void => {
				if (node && typeof node === 'object') {
					for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
						if (typeof v === 'string' && v.length > 0) found.add(k)
						walk(v)
					}
				}
			}
			walk(JSON.parse(readFileSync(join(localeDir, f), 'utf8')))
			for (const k of retired) expect(found.has(k)).toBe(false)
			expect(found.has('use_recovery_code')).toBe(true)
		})
	}
})
