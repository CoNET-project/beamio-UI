/**
 * @jest-environment node
 */
/**
 * The shell's new-account registration and first-identity status code: the page generates no key, forwards what the native layer gave, keeps
 * the password in one call, and the create page hands it over before any other create step. Source pins.
 */
import * as fs from 'fs'
import * as path from 'path'

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
const NEW_FILES = ['services/accountCreateRegister.ts', 'services/firstIdentityStatus.ts', 'services/firstIdentityReaction.ts', 'services/shellFirstIdentitySetup.ts', 'components/RecoverCodeNotice.tsx', 'utils/accountCreateRegisterFlag.ts']

describe('no key generation or derivation in the shell registration code', () => {
	for (const f of NEW_FILES) {
		it(`${f} has no generateKeyPair, openpgp, fromPhrase, createRandom or wallet construction`, () => {
			const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
			expect(code).not.toMatch(/generateKeyPair|openpgp|fromPhrase|createRandom|new ethers\.Wallet|Wallet\.from|HDNodeWallet|signMessage\(/)
		})
	}
	it('no pgpIdentityCreate or generate call because of a status event or a registration answer', () => {
		for (const f of ['services/firstIdentityStatus.ts', 'services/firstIdentityReaction.ts', 'services/accountCreateRegister.ts']) {
			expect(src(f)).not.toMatch(/pgpIdentityCreate|sendNativePgpIdentityCreate|nativeGenerateNewPgpKey/)
		}
	})
})

describe('the password stays in one call', () => {
	const reg = src('services/accountCreateRegister.ts')
	it('the only command that carries it is accountCreateRegister, built in one place', () => {
		expect(reg.match(/password,\s*\}|, password \}/g)?.length ?? 0).toBeLessThanOrEqual(1)
		expect(reg).toMatch(/return \{ type: ACCOUNT_CREATE_REGISTER_COMMAND, reqId, tag, password \}/)
	})
	it('log lines name lengths only; nothing else passes the password to a logger, a store or the QA counter', () => {
		const calls = reg.match(/publishNativePwaLog\([^;]*\)/g) ?? []
		for (const c of calls) expect(c).not.toMatch(/\$\{[^}]*(?<!Len)[^}]*\}/.source && /\$\{(input\.)?password\}/)
		expect(reg).not.toMatch(/noteBridgeCommand|localStorage|sessionStorage|indexedDB|storeSystemData/)
	})
	it('the create page clears the password as soon as the call returns and hands over before the old create path', () => {
		const page = src('pages/Home/CreateUsernamePinScreen.tsx')
		const fn = page.slice(page.indexOf('const handleShellRegister'), page.indexOf('const handleShellCreate'))
		expect(fn).toMatch(/finally \{[^}]*setPassword\(''\)/)
		const create = page.slice(page.indexOf('const handleCreateWallet'))
		expect(create.indexOf('await handleShellCreate(trimmedTag, pwd)')).toBeGreaterThan(0)
		expect(create.indexOf('await handleShellCreate(trimmedTag, pwd)')).toBeLessThan(create.indexOf('kks = await createRecover('))
		const shell = page.slice(page.indexOf('const handleShellCreate'), page.indexOf('const handleCreateWallet'))
		// the normal path registers after step 1 (the last register call); the resume branch (the device already holds the key) registers with no step 1, and sits before the open
		expect(shell.indexOf('await nativeAccountCreateOpen(trimmedTag)')).toBeLessThan(shell.lastIndexOf('await handleShellRegister(trimmedTag, pwd)'))
		expect(shell.indexOf('if (resumeEoaLower) {')).toBeLessThan(shell.indexOf('await nativeAccountCreateOpen(trimmedTag)'))
	})
	it('0.53.50: the password field of the shell is shown always (the page collects it like the browser)', () => {
		const page = src('pages/Home/CreateUsernamePinScreen.tsx')
		expect(page).not.toMatch(/shellNoPassword/)
		expect(page).toMatch(/id="create-wallet-password"/)
	})
})

describe('the flag is a build-time constant, QA only', () => {
	it('craco folds it, and no production script sets it', () => {
		const craco = fs.readFileSync(path.join(__dirname, '..', '..', 'craco.config.js'), 'utf8')
		expect(craco).toMatch(/'process\.env\.REACT_APP_NEW_ACCOUNT_REGISTRATION': JSON\.stringify\(process\.env\.REACT_APP_NEW_ACCOUNT_REGISTRATION === 'true' \? 'true' : 'false'\)/)
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
		for (const [name, cmd] of Object.entries(pkg.scripts)) {
			if (/REACT_APP_NEW_ACCOUNT_REGISTRATION=true/.test(cmd)) expect(name).toMatch(/qa/i)
		}
	})
})
