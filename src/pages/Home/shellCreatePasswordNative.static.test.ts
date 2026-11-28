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
})

describe('shell create: the pending native create', () => {
	const page = read('pages/Home/CreateUsernamePinScreen.tsx')
})
