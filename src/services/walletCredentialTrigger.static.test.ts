/**
 * The page copy from the native wallet: the gate asks walletCredential only when the native wallet is ready and the page
 * holds no wallet record, and it stores nothing else. Reads the gate source.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')

describe('the page copy is restored only when the native wallet is ready and the page record is empty', () => {
	// The "ready branch restores the page copy in the background (no await)" pin was deleted on purpose: removed the init-level
	// call `void restorePageCopy(native.eoa)` with the walletStatus ready route. A valid pre-read now restores through decidePrereadEntry
	// (copyValidatedEntry.ts), which awaits a bounded page read; that is not the background restore this pin guarded.
	// Rewritten for the current rule (1c): the restore writes the blob and the restored mnemonic together, through the record's own write
	// path (wrapForDisk inside storeSystemDataAndWait), then reads it back. The mnemonic is a plain field only in memory.
	it('the restore asks for the credential only after an empty page record, writes the blob with the mnemonic, and reads it back', () => {
		const start = gate.indexOf('const restorePageCopy = async')
		const body = gate.slice(start, gate.indexOf('const init = async', start))
		expect(body.indexOf("if (stored.status !== 'empty') return 'none'")).toBeLessThan(body.indexOf('readWalletCredential()'))
		expect(body).toContain('recoveredPageRecord(seed, answer.mnemonic, answer.blob)')
		expect(body).toContain('await storeSystemDataAndWait()')
		expect(body).toContain('checkStoredRecord(await readStoredRecordForVerify(), eoa)')
		// code only: comment lines may name the mnemonic (the native-lock comment inside the body does); a plain mnemonic field in code is refused
		const code = body.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
		expect(code).not.toMatch(/mnemonic\s*:/)
	})
})
