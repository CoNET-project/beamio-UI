/**
 * @jest-environment node
 *
 * Static checks for: the restore result that is ok keeps the public address; the gate shows the retry state before
 * the PGP notice. Reads source only; no key material.
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('the public address is kept only on an ok native recovery exit or a created account', () => {
	it(' the page restore screen no longer takes a native result: the address is kept by the entry gate\'s native recovery exit on ok (rememberNativeEoa, which persists it), with no reload', () => {
		// the restore screen restores in the page; it has no native result listener and keeps no native address
		const screenCode = read('pages/Home/RestoreWalletUnifiedScreen.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
		expect(screenCode).not.toMatch(/onNativeRecoveryResult|rememberNativeEoa/)
		const gate = read('components/AppEntryGate.tsx')
		expect(gate).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa \}\) => \{[\s\S]*?if \(code === 'ok'\) \{[\s\S]*?rememberNativeEoa\(eoa\)/)
		expect(gate).not.toMatch(/if \(code === 'ok'\) \{[\s\S]{0,600}window\.location\.reload\(\)/)
		expect(read('services/nativeWallet.ts')).toMatch(/export function rememberNativeEoa[\s\S]*?persistShellEoa\(nativeEoaHint\)/)
	})
	it('a created account keeps its address the same way (rememberNativeEoa in the create screen), never on a guess', () => {
		const create = read('pages/Home/CreateUsernamePinScreen.tsx')
		expect(create).toMatch(/rememberNativeEoa\(wallet\)/)
	})

	it('the start file takes the persisted address only as an input, never as the entry or identity basis', () => {
		const src = read('services/shellChatStart.ts')
		expect(src).toMatch(/readPersistedEoa\(\)/)
		expect(src).not.toMatch(/readPersistedEoa\(\)[^\n]*\?\s*(enter|entry|started)/)
	})
})

describe('the gate shows the retry state before the PGP notice', () => {
	it('ShellChatGate checks identityPending before pgp', () => {
		const src = read('components/ShellChatUnavailableNotice.tsx')
		const i = src.indexOf('if (identityPending) return <ShellIdentityRetryNotice />')
		const j = src.indexOf('if (pgp) return <PgpRestoreFailedNotice')
		expect(i).toBeGreaterThan(0)
		expect(j).toBeGreaterThan(i)
	})
})
