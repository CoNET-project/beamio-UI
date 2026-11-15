/**
 * @jest-environment node
 *
 * S25 finding: new-account creation in a shell failed before POST /api/addUser, shown as "Network error".
 * The shell now creates the account natively; a local failure is typed, logged by step name only, and not shown as a
 * network error. Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')
const beamio = read('services/beamio.ts')
const screen = read('pages/Home/CreateUsernamePinScreen.tsx')
const native = read('services/nativeRecovery.ts')
const createStart = beamio.indexOf('export const createRecover = async')
const createBody = beamio.slice(createStart, beamio.indexOf('/**\n * Register a fresh BeamioTag', createStart))

describe('new account in a shell: native create, typed local errors (S25)', () => {
	it('every local failure inside createRecover is a typed LocalCreateError named by its step', () => {
		expect(beamio).toContain('export class LocalCreateError extends Error')
		expect(createBody).toContain("throw new LocalCreateError(!temp ? 'wallet_null'")
		expect(createBody).toContain("throw new LocalCreateError('private_key_missing')")
		expect(createBody).toContain('if (err instanceof LocalCreateError) throw err')
		expect(createBody).toContain('throw new LocalCreateError(step)')
		expect(createBody).not.toMatch(/if \(!temp[^\n]*\n\s*return null/)
	})

	it('the sign step of newUser is guarded and typed', () => {
		expect(beamio).toContain("throw new LocalCreateError('sign_failed')")
	})

	it('the per-step log uses the native channel (console is stripped in production) and carries step names and error types only', () => {
		const helper = beamio.slice(beamio.indexOf('const logRecoverStep = '), createStart)
		expect(helper).toContain('publishNativePwaLog(')
		expect(helper).not.toMatch(/\$\{(pin|pwd|recoverCode|wallet|phrase|temp|stored|img)/)
		expect(createBody).not.toContain('console.')
		expect(createBody.match(/logRecoverStep\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
	})

	it('a shell creates the account natively; the page never runs createRecover (which generates a key) in a shell', () => {
		const shellBranch = screen.indexOf('if (isShellContext()) {')
		const nativeOpen = screen.indexOf('await nativeAccountCreateOpen(trimmedTag)', shellBranch)
		const pageCreate = screen.indexOf('kks = await createRecover(trimmedTag, pwd, { mustReuseKey: reuseExistingKey })')
		expect(shellBranch).toBeGreaterThan(0)
		expect(nativeOpen).toBeGreaterThan(shellBranch)
		expect(pageCreate).toBeGreaterThan(nativeOpen)
		expect(screen).not.toContain('recoveryCreateOpen')
		expect(screen).toContain("'create_account_native_unavailable'")
		expect(screen).toContain("tu('create_account_try_later')")
		expect(screen).toContain('onNativeAccountCreateResult(')
	})

	it('a local failure shows the local copy, not the network copy', () => {
		expect(screen).toMatch(/catch \(ex\) \{\s*setCreateError\(tu\(ex instanceof LocalCreateError \? createRecoverCopyKey\(ex\.step\) : 'network_error_try_again'\)\)/)  // the step picks the copy key; the default stays the local copy
	})

	it('both locales carry the two new copy keys', () => {
		const has = (o: unknown, k: string): boolean =>
			!!o && typeof o === 'object' && (Object.prototype.hasOwnProperty.call(o, k) || Object.values(o as object).some((v) => has(v, k)))
		for (const f of ['locale/zh-CN.json', 'locale/en.json']) {
			const j = JSON.parse(read(f))
			expect(has(j, 'create_account_local_error')).toBe(true)
			expect(has(j, 'create_account_native_unavailable')).toBe(true)
		}
	})
})
