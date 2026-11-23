/**
 * @jest-environment node
 *
 * Spec r2.3 item 41 and rule (b) (2026-11-16): the native import entry is retired. The locked page NativeKeyImportRequired is deleted,
 * and no production source of the PWA holds an import entry, an import command or its copy. Rewritten from the render test of the
 * import button: the entry is asserted absent. Source check only; no key material is used.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')

function productionSources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		if (statSync(full).isDirectory()) {
			if (name !== '__fixtures__' && name !== 'node_modules') productionSources(full, out)
			continue
		}
		if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.static\.test\./.test(name)) out.push(full)
	}
	return out
}

describe('the native import entry does not exist (spec r2.3 item 41, rule (b))', () => {
	it('the locked import page file is deleted', () => {
		expect(existsSync(join(__dirname, 'NativeKeyImportRequired.tsx'))).toBe(false)
	})

	it('no production source calls openNativeKeyImport, sends nativeImportOpen, or shows the import copy', () => {
		const hits: string[] = []
		for (const file of productionSources(SRC)) {
			const text = readFileSync(file, 'utf8')
			if (/openNativeKeyImport|nativeImportOpen|native_key_required_import|NativeKeyImportRequired/.test(text)) hits.push(file)
		}
		expect(hits).toEqual([])
	})
})
