/**
 * Policy checks on the source: the phrase never reaches a log or a console line, the copy keys exist in all three locales, and
 * the new page-copy branch is reached only from the shell branch of the gate (the browser path is not changed).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')
const credential = src('services', 'walletCredential.ts')
const gate = src('components', 'AppEntryGate.tsx')

describe('the phrase never reaches a log', () => {
	it('the credential module logs and prints nothing', () => {
		expect(credential).not.toMatch(/publishNativePwaLog|console\.|debugger/)
	})
	it('the page-copy restore logs only the action, never the answer or the phrase', () => {
		const start = gate.indexOf('const restorePageCopy = async')
		const body = gate.slice(start, gate.indexOf('const init = async', start))
		const logs = body.match(/publishNativePwaLog\([^\n]*\)/g) ?? []
		expect(logs.length).toBeGreaterThan(0)
		for (const line of logs) expect(line).not.toMatch(/mnemonic|answer|blob|phrase/i)
	})
})

describe('the copy for the update prompt exists in every locale', () => {
	for (const locale of ['en', 'zh', 'jp']) {
		it(`${locale}: title and body`, () => {
			const dict = JSON.parse(src('locales', locale, 'translation.json')) as Record<string, string>
			expect(dict.app_update_required_title).toBeTruthy()
			expect(dict.app_update_required_body).toBeTruthy()
		})
	}
})

describe('the new branches are reached only from the shell branch of the gate', () => {
	it('the local home and the page-copy restore sit inside the native-shell branch, before the browser storage read', () => {
		const init = gate.slice(gate.indexOf('const init = async () => {'), gate.indexOf('const init = async () => {') + 9000)
		const shellBranch = init.indexOf('if (nativeShellRef.current) {')
		const localMode = init.indexOf('judgeLocalOnly({')
		const restore = init.indexOf('void restorePageCopy(native.eoa)')
		const browserRead = init.indexOf('const storageResult = await checkStorageWithTransientRetry()')
		expect(shellBranch).toBeGreaterThan(-1)
		expect(localMode).toBeGreaterThan(shellBranch)
		expect(restore).toBeGreaterThan(shellBranch)
		expect(browserRead).toBeGreaterThan(restore)
	})
})
