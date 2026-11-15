/**
 * @jest-environment node
 *
 * Shell chat start (25.2), read from the source: in a shell, initChat starts the chat from the native public
 * identity and returns before any step that reads or uses the wallet key on the page. The browser path is unchanged.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const chat = readFileSync(join(__dirname, 'chat.ts'), 'utf8')
const body = (() => {
	const at = chat.indexOf('export const initChat = async')
	const end = chat.indexOf('\nexport const ', at + 1)
	return chat.slice(at, end < 0 ? undefined : end)
})()

describe('initChat in a shell', () => {
	it('starts from the native public identity, then returns before the browser path', () => {
		const shell = body.indexOf('if (isShellContext()) {')
		const native = body.indexOf('startShellChatFromNativeIdentity(')
		const browserStart = body.indexOf('\n\tinitChatInProgress = true', shell + 1)
		expect(shell).toBeGreaterThan(0)
		expect(native).toBeGreaterThan(shell)
		expect(body.slice(shell, browserStart)).toMatch(/return\s*\n\s*\}/)
	})

	it('the shell branch comes before the browser page-key check and every page-key step', () => {
		const shell = body.indexOf('if (isShellContext()) {')
		const keyCheck = body.indexOf('initChat abort: privateKeyArmor invalid or missing')
		const ownChain = body.indexOf('getOwnKeysFromCoNETPGPSC(profile.privateKeyArmor)')
		const register = body.indexOf('regiestChatRoute(profile.privateKeyArmor')
		expect(keyCheck).toBeGreaterThan(shell)
		expect(ownChain).toBeGreaterThan(shell)
		expect(register).toBeGreaterThan(shell)
	})

	it('the browser path keeps its key check (no change outside a shell)', () => {
		expect(body).toMatch(/if \(!profile\.privateKeyArmor \|\| !isValidEthersPrivateKey\(profile\.privateKeyArmor\)\)/)
	})

	it('the shell start passes no private field to the listen', () => {
		const deps = chat.slice(chat.indexOf('const shellChatStartDeps'), chat.indexOf('export const initChat = async'))
		expect(deps).not.toMatch(/pgpPrivateKeyArmored/)
		expect(deps).toMatch(/signAccount: refuseShellSigning/)
		expect(deps).not.toMatch(/new ethers\.Wallet\(/)
	})
})
