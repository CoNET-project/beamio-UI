/**
 * @jest-environment node
 *
 * Shell account creation: the wallet password is not typed in the WebView; the native create page
 * takes it. The shell submit needs no page-side password rule and passes an empty password. Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf8')

describe('shell create: no wallet password is typed in the WebView', () => {
	const page = read('pages/Home/CreateUsernamePinScreen.tsx')

	it('the password block is not rendered in a shell', () => {
		expect(page).toMatch(/const shellNative = isShellContext\(\)/)
		expect(page).toMatch(/\{!shellNative \? \(<>[\s\S]*?<\/>\) : null\}/)
	})

	it('the shell submit does not require a page-side password and passes an empty one', () => {
		expect(page).toMatch(/const canSubmit = tagValid && \(shellNative \|\| pwdRulesOk\)/)
		expect(page).toMatch(/const p = shellNative \? '' : password\.trim\(\)/)
		expect(page).toMatch(/if \(!shellNative && \(!l \|\| !m \|\| !n\)\) return/)
	})

	it('the shell branch opens the native create before any page-side account creation', () => {
		const shell = page.indexOf("'[createAccount] shell: native create requested'")
		const open = page.indexOf('await nativeAccountCreateOpen(trimmedTag)', shell)
		const pageCreate = page.indexOf('kks = await createRecover(', shell)
		expect(shell).toBeGreaterThan(0)
		expect(open).toBeGreaterThan(shell)
		expect(pageCreate).toBeGreaterThan(open)
	})
})

describe('shell create: the pending native create follows rule (a)', () => {
	const page = read('pages/Home/CreateUsernamePinScreen.tsx')

	it('pending is set only when the native page opens, and no second open is sent while it is pending', () => {
		//pending is set only when the ack's page is "opened"; none, absent or another page value waits for the result event.
		expect(page).toMatch(/if \(opened\.page === 'opened'\) \{[\s\S]{0,200}nativeCreatePendingRef\.current = true/)
		expect(page).toMatch(/if \(nativeCreatePendingRef\.current\) \{[\s\S]{0,200}return\s*\}[\s\S]{0,3000}const opened = await nativeAccountCreateOpen\(trimmedTag\)/)
	})

	it('ok and cancel clear pending; a failed result keeps it; unmount clears it', () => {
		// r11 §11 (CT, NC-AE): ok is the only establishing result. already_exists is handed back to the entry judgement and never announces.
		expect(page).toMatch(/if \(code === 'ok'\) \{[\s\S]{0,600}nativeCreatePendingRef\.current = false/)
		// the wallet is announced as established synchronously, before any async read.
		expect(page).toMatch(/if \(code === 'ok'\) \{[\s\S]{0,400}announceNativeWalletEstablished\(\)/)
		expect(page).toMatch(/if \(code === 'already_exists'\) \{[\s\S]{0,400}requestNativeIdentityRetry\(\)/)
		expect(page.slice(page.indexOf("if (code === 'already_exists')"), page.indexOf("if (code === 'already_exists')") + 500)).not.toMatch(/announceNativeWalletEstablished\(\)/)
		expect(page).toMatch(/if \(code === 'cancelled'\) \{\s*nativeCreatePendingRef\.current = false/)
		const failed = page.indexOf("if (code === 'write_failed' || code === 'readback_failed') {")
		expect(failed).toBeGreaterThan(0)
		expect(page.slice(failed, failed + 500)).not.toMatch(/nativeCreatePendingRef\.current = false/)
		expect(page).toMatch(/return \(\) => \{\s*off\(\)[\s\S]{0,160}nativeCreatePendingRef\.current = false/)
	})
})
