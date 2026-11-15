/**
 * The page copy from the native wallet: the gate asks walletCredential only when the native wallet is ready and the page
 * holds no wallet record, and it stores nothing else. Reads the gate source.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')

describe('the page copy is restored only when the native wallet is ready and the page record is empty', () => {
	it('the ready branch enters on the native wallet and restores the page copy in the background (a held read never blocks the entry)', () => {
		const enter = gate.indexOf('applyNativeWallet(native.eoa)\n\t\t\t\t\t')
		const restore = gate.indexOf('void restorePageCopy(native.eoa)', enter)
		expect(enter).toBeGreaterThan(-1)
		expect(restore).toBeGreaterThan(enter)
		expect(gate.slice(enter, restore)).not.toContain('await')
	})
	it('the restore asks for the credential only after an empty page record, and stores only the blob', () => {
		const start = gate.indexOf('const restorePageCopy = async')
		const body = gate.slice(start, gate.indexOf('const init = async', start))
		expect(body.indexOf("if (stored.status !== 'empty') return 'none'")).toBeLessThan(body.indexOf('readWalletCredential()'))
		expect(body).toContain('walletCredentialBlob: answer.blob')
		expect(body).not.toMatch(/mnemonic\s*:/)
	})
})
