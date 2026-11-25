/**
 * @jest-environment node
 *
 * Static checks for: the restore result that is ok keeps the public address; the gate shows the retry state before
 * the PGP notice. Reads source only; no key material.
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('the public address is kept only on an ok restore', () => {
	it('the recovery ok branch keeps the eoa through rememberNativeEoa (which persists it), and does not reload (directive)', () => {
		const src = read('pages/Home/RestoreWalletUnifiedScreen.tsx')
		expect(src).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa, cooldownSec \}\) => \{[\s\S]*?if \(code === 'ok'\) \{[\s\S]*?rememberNativeEoa\(eoa\)/)
		expect(src).not.toMatch(/if \(code === 'ok'\) \{[\s\S]{0,400}window\.location\.reload\(\)/)
		expect(read('services/nativeWallet.ts')).toMatch(/export function rememberNativeEoa[\s\S]*?persistShellEoa\(nativeEoaHint\)/)
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
