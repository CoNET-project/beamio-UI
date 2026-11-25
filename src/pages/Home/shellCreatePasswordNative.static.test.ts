/**
 * @jest-environment node
 *
 * 0.53.50 (plan r3-create): the shell create page is the PWA page. It collects the BeamioTag and the password like the browser; the password goes
 * to the native layer in accountCreateRegister over the trusted shell adapter, after the headless native create (nativeAccountCreateOpen). The page
 * generates no key. Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf8')

describe('shell create: the password is typed in the page like the browser', () => {
	const page = read('pages/Home/CreateUsernamePinScreen.tsx')

	it('the password block is always rendered and always required (no shell exception)', () => {
		expect(page).not.toMatch(/shellNoPassword/)
		expect(page).toMatch(/const canSubmit = tagValid && pwdRulesOk && termsAccepted/)
		expect(page).toMatch(/id="create-wallet-password"/)
		expect(page).toMatch(/\{\.\.\.secretFieldProps\('pin'\)\}/)
	})

	it('the shell branch runs the three steps and never creates a key in the page', () => {
		const create = page.slice(page.indexOf('const handleCreateWallet'))
		const shell = create.indexOf('await handleShellCreate(trimmedTag, pwd)')
		const pageCreate = create.indexOf('kks = await createRecover(')
		expect(shell).toBeGreaterThan(0)
		expect(pageCreate).toBeGreaterThan(shell)
		const fn = page.slice(page.indexOf('const handleShellCreate'), page.indexOf('const handleCreateWallet'))
		const open = fn.indexOf('await nativeAccountCreateOpen(trimmedTag)')
		const wait = fn.indexOf('await stepDone')
		const register = fn.indexOf('await handleShellRegister(trimmedTag, pwd)')
		expect(open).toBeGreaterThan(0)
		expect(wait).toBeGreaterThan(open)
		expect(register).toBeGreaterThan(wait)
		expect(fn).not.toMatch(/createRecover|generateKeyPair|createOrGetWallet/)
	})

	it('the capability account.page-create.v1 is checked before anything is sent', () => {
		const fn = page.slice(page.indexOf('const handleShellCreate'), page.indexOf('const handleCreateWallet'))
		expect(fn.indexOf('await hasPageCreate()')).toBeGreaterThan(0)
		expect(fn.indexOf('await hasPageCreate()')).toBeLessThan(fn.indexOf('await nativeAccountCreateOpen(trimmedTag)'))
	})
})

describe('shell create: the pending native create', () => {
	const page = read('pages/Home/CreateUsernamePinScreen.tsx')

	it('pending is set after an accepted open, and no second open is sent while it is pending', () => {
		const fn = page.slice(page.indexOf('const handleShellCreate'), page.indexOf('const handleCreateWallet'))
		expect(fn).toMatch(/if \(nativeCreatePendingRef\.current\) \{[\s\S]{0,200}return\s*\}[\s\S]{0,4000}const opened = await nativeAccountCreateOpen\(trimmedTag\)/)
		expect(fn).toMatch(/nativeCreatePendingRef\.current = true\s*\/\/[\s\S]{0,200}startNativeWait\(\)/)
	})

	it('a result for the page-run create (ok, already_exists) goes to step 2; other codes keep their copy; unmount clears pending', () => {
		const start = page.indexOf('onNativeAccountCreateResult((accepted)')
		const listener = page.slice(start, page.indexOf('return () => {', start))
		expect(listener).toMatch(/const waiter = shellCreateWaitRef\.current/)
		expect(listener).toMatch(/accepted\.code === 'ok' \|\| accepted\.code === 'already_exists'/)
		expect(listener).toMatch(/waiter\(\{ kind: 'failed' \}\)/)
		expect(page).toMatch(/if \(code === 'cancelled'\) \{\s*nativeCreatePendingRef\.current = false/)
		expect(page).toMatch(/return \(\) => \{\s*off\(\)[\s\S]{0,160}nativeCreatePendingRef\.current = false/)
	})

	it('already_exists completes the registration only for an account the registry holds no tag for; otherwise the entry judgement', () => {
		const fn = page.slice(page.indexOf('const handleShellCreate'), page.indexOf('const handleCreateWallet'))
		expect(fn).toMatch(/step\.kind === 'exists' && !\(await canCompleteRegistration\(\)\)[\s\S]{0,200}requestNativeIdentityRetry\(\)/)
		expect(page).toMatch(/lookup\.status === 'no_account'/)
	})
})
