/**
 * the unavailable screen for needs_native_recovery has the native import page as its main
 * guide (nativeImportOpen). The recovery-code entry (nativeRecoveryOpen) stays as a secondary link. The
 * copy keys are existing ones. Source guard; no key or passcode value is used.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const noKey = readFileSync(join(__dirname, 'NativeKeyImportRequired.tsx'), 'utf8')

const block = (() => {
	const at = gate.indexOf("{storageUnavailable === 'native_recovery_needed' ? (")
	expect(at).toBeGreaterThan(0)
	return gate.slice(at, gate.indexOf(') : null}', at) + 1)
})()

describe('the unavailable screen guides to the native import page first', () => {
	it('the main button is the import button and calls the import handler (nativeImportOpen)', () => {
		const main = block.indexOf("onClick={() => void importWalletNative()}")
		expect(main).toBeGreaterThan(0)
		expect(block.slice(0, main)).toContain('type="button"')
		expect(block.indexOf("tu('native_key_required_import')")).toBeGreaterThan(0)
		expect(block.indexOf("tu('native_key_required_import')")).toBeLessThan(block.indexOf("tu('use_recovery_code')"))
	})

	it('the import handler sends nativeImportOpen and waits for the return only when the page opened', () => {
		expect(gate).toContain("import { installNativeNoKeyWatcher, openNativeKeyImport } from '@/services/nativeKeyState'")
		const at = gate.indexOf('const importWalletNative = async () => {')
		expect(at).toBeGreaterThan(0)
		const body = gate.slice(at, at + 300)
		expect(body).toContain('await openNativeKeyImport()')
		expect(body).toContain("if (out === 'opened') setAwaitingImportReturn(true)")
		expect(body).toContain("else setNativeRecoveryNotice(tu('native_key_import_failed'))")
	})

	it('the recovery-code entry remains as a secondary link (underlined text, not the primary white button)', () => {
		const rec = block.indexOf("tu('use_recovery_code')")
		expect(rec).toBeGreaterThan(0)
		const before = block.slice(0, rec)
		expect(before.lastIndexOf('className="px-3 py-3 text-sm text-white/75 underline"')).toBeGreaterThan(before.lastIndexOf('<button'))
		expect(block).toContain('nativeRecoveryOpen()')
	})

	it('the secondary link has a tap area of at least 44x44 points by padding alone (text-sm line 20px + py-3 = 44px); its copy and colour are unchanged', () => {
		const rec = block.indexOf("tu('use_recovery_code')")
		const before = block.slice(0, rec)
		const cls = before.slice(before.lastIndexOf('className="'), before.lastIndexOf('>') + 1)
		expect(cls).toContain('px-3')
		expect(cls).toContain('py-3')
		expect(cls).toContain('text-sm text-white/75 underline')
	})

	it('the no_key page (NativeKeyImportRequired) keeps the import button as its main guide', () => {
		expect(noKey).toContain("tu('native_key_required_import')")
		expect(noKey).toContain('openNativeKeyImport')
	})

	it('the return of the import page reloads the app once on visibilitychange only; the new code does not read walletStatus directly (the reloaded boot reads it by the existing path)', () => {
		expect(gate).toContain("if (document.visibilityState !== 'visible') return\n\t\t\twindow.location.reload()")
		expect(gate).not.toMatch(/readNativeWalletStatus/)
		expect(gate).not.toContain("window.addEventListener('focus', recheck)")
	})
})

describe('the copy keys used on the unavailable screen exist in both locales', () => {
	const keys = ['native_key_required_import', 'native_key_import_failed', 'use_recovery_code']
	const localeDir = join(__dirname, '..', 'locale')
	for (const f of ['en.json', 'zh-CN.json']) {
		it(`${f} has ${keys.join(', ')}`, () => {
			const found = new Set<string>()
			const walk = (node: unknown): void => {
				if (node && typeof node === 'object') {
					for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
						if (keys.includes(k) && typeof v === 'string' && v.length > 0) found.add(k)
						walk(v)
					}
				}
			}
			walk(JSON.parse(readFileSync(join(localeDir, f), 'utf8')))
			for (const k of keys) expect(found.has(k)).toBe(true)
		})
	}
})
