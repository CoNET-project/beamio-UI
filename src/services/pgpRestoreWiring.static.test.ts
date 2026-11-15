/**
 * @jest-environment node
 *
 * plan A: the page generates a PGP key in two places only: a new account (no record on chain), and the user's
 * click after a restore failure (regeneratePgpKeyByUser). The restore failures stop the start and are never retried
 * automatically (read from the sources, so a removed guard fails).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

describe(' wiring', () => {
	const chat = read('services/chat.ts')

	it('generatePgpKey is called twice: the new-account branch, and the user click in regeneratePgpKeyByUser', () => {
		expect((chat.match(/generatePgpKey\(/g) ?? []).length).toBe(2)
	})

	it('initBeamioPGPKeys classifies the restore before the new-account branch generates a key', () => {
		const restore = chat.indexOf("classifyOwnPgp({ read: own.read, localKeyID: '', hasLocalKey: false })")
		const newAccount = chat.indexOf("const keys = await generatePgpKey(profile.keyID,'')")
		expect(restore).toBeGreaterThan(0)
		expect(newAccount).toBeGreaterThan(restore)
	})

	it('the user click refuses in a shell, compares the chain before any generation, and registers only after generating', () => {
		const fn = chat.indexOf('export const regeneratePgpKeyByUser')
		const shellRefusal = chat.indexOf("if (isShellContext()) return { ok: false, reason: 'no_failure' }", fn)
		const compare = chat.indexOf('if (snapshotOfRead(own.read) !== shown) return', fn)
		const generate = chat.indexOf("const keys = await generatePgpKey(profile.keyID, '')", fn)
		const register = chat.indexOf('const registered = await regiestChatRoute(profile.privateKeyArmor, publicKey', fn)
		const persist = chat.indexOf('storeSystemDataAndWait()', fn)
		expect(fn).toBeGreaterThan(0)
		expect(shellRefusal).toBeGreaterThan(fn)
		expect(compare).toBeGreaterThan(shellRefusal)
		expect(generate).toBeGreaterThan(compare)
		expect(register).toBeGreaterThan(generate)
		expect(persist).toBeGreaterThan(register)
	})

	it('the page registers a key in one place only (the user click in a browser, not a shell)', () => {
		expect((chat.match(/regiestChatRoute\(profile\.privateKeyArmor, publicKey/g) ?? []).length).toBe(1)
	})

	it('initChat stops on a restore failure before any mailbox registration', () => {
		const classify = chat.indexOf('classifyOwnPgp({ read: ownChain.read')
		const plan = chat.indexOf('planOwnChatRoute({')
		expect(classify).toBeGreaterThan(0)
		expect(plan).toBeGreaterThan(classify)
		expect(chat).toMatch(/if \(pgpState\.kind === 'failure'\) \{[\s\S]{0,200}setGossip\(false\)[\s\S]{0,40}return/)
	})

	it('a restore failure is not retried automatically (no retry from an empty key read, nor from the start)', () => {
		expect(chat).toMatch(/if \(!started && getPgpRestoreFailure\(\)\) \{/)
		expect(chat).toMatch(/if \(getPgpRestoreFailure\(\)\) return\n\t+\/\/ Chain key unreadable right now[^\n]*\n\t+scheduleChatRetry\('own chain key unreadable'/)
		expect(chat).toMatch(/if \(getPgpRestoreFailure\(\)\) return\n\t\tscheduleChatRetry\('error'/)
	})

	it('a failed read clears a failure shown earlier, so the normal retry applies again', () => {
		expect(chat).toMatch(/if \(restore\.kind === 'read_error'\) setPgpRestoreFailure\(null\)/)
	})

	it('the native restore code reaches the store from the bridge catch', () => {
		expect(read('services/chatWorkerBridge.ts')).toMatch(/if \(isPgpRestoreFailure\(restoreCode\)\) setPgpRestoreFailure\(restoreCode\)/)
	})

	it('the failure page offers the click in a browser (regeneratePgpKeyByUser) and in a shell (native), and nothing else', () => {
		const notice = read('components/PgpRestoreFailedNotice.tsx')
		expect(notice).toMatch(/isShellContext\(\) \? await nativeGenerateNewPgpKey\(shellAccountKeyOrEmpty\(\)\) : await regeneratePgpKeyByUser\(\)/)
		expect(notice).toMatch(/onClick=\{\(\) => void generate\(\)\}/)
		expect(notice).not.toMatch(/\bgeneratePgpKey\(|\bregiestChatRoute\(/)
	})
})
