/**
 * @jest-environment node
 *
 * account create goes ONLY through createRecover; the native create (nativeAccountCreateOpen and everything built on it) is deleted from the page.
 * The driven counterpart (createRecover called exactly once with the typed tag and password, native create opened 0 times) is in CreateUsernamePinScreen.createFailure.render.test.tsx ("driven to the end").
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const page = readFileSync(join(root, 'pages/Home/CreateUsernamePinScreen.tsx'), 'utf8')

describe('create goes only through createRecover; the native create is gone from the page', () => {
	it.each(['handleShellCreate', 'handleShellRegister', 'showShellOpenFailure', 'nativeAccountCreateOpen', 'onNativeAccountCreateResult'])('%s no longer exists in CreateUsernamePinScreen.tsx', (name) => {
		expect(page).not.toContain(name)
	})

	it('the page does not import the native create module at all', () => {
		expect(page).not.toMatch(/from\s+["']@\/services\/nativeRecovery["']/)
	})

	it('createRecover is called in exactly one place: handleCreateWallet, with the typed tag and password', () => {
		expect(page.match(/createRecover\(/g) ?? []).toHaveLength(1)
		const create = page.slice(page.indexOf('const handleCreateWallet'))
		expect(create).toContain('kks = await createRecover(trimmedTag, pwd, { mustReuseKey: reuseExistingKey })')
	})

	it('nothing else in the page code path sends a native create command (no NATIVE_ACCOUNT_CREATE_OPEN_COMMAND outside the bridge file)', () => {
		const walk = (dir: string, out: string[] = []): string[] => {
			const fs = require('node:fs') as typeof import('node:fs')
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name)
				if (e.isDirectory()) walk(p, out)
				else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
			}
			return out
		}
		const code = (f: string): string => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n') // comments may still name the old step
		const callers = walk(root).filter((f) => /nativeAccountCreateOpen\(/.test(code(f)) && !/services\/nativeRecovery\.ts$/.test(f))
		expect(callers).toEqual([])
	})
})
