/**
 * Plan N: the shell's wallet record path, read from the source. The shell reads and writes the native store; the
 * PouchDB `init` document and the Cache API copy are browser-only. A removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

describe('shell wallet record path (plan N)', () => {
	const beamio = read('src/services/beamio.ts')

	it('the startup read takes the native record in a shell and keeps the PouchDB read for the browser', () => {
		const at = beamio.indexOf('const readStorageWithStatus = async')
		// 2026-11-18: the window grew by the blob-compatibility probe await (idbBlobCompat); the pin still covers the whole read.
		const block = beamio.slice(at, at + 7000)
		// step 3: the shell startup read calls shellRecordRead directly (to take the copyValidated result), or readInitObject.
		expect(block).toMatch(/if \(isShellContext\(\)\) \{[\s\S]{0,1600}(readInitObject\(|shellRecordRead\(|shellNativeFirstRead\()/)
		expect(block).toMatch(/\} else \{[\s\S]{0,2600}database\.get\("init"/)
		// a read error maps through shellStorageErrorReason (native_record, native_recovery_needed, native_retry).
		// the error mapping sits in the native-first helper
		const helper = beamio.slice(beamio.indexOf('const shellNativeFirstRead = async'), at)
		expect(helper).toContain('shellStorageErrorReason(msg)')
		const wait = readFileSync(join(__dirname, 'shellStoreWait.ts'), 'utf8')
		expect(wait).toContain("'native_record'")
		expect(wait).toContain("'native_recovery_needed'")
		expect(wait).toContain("'native_retry'")
	})

	it('the shell read and write go through the native store helpers, not through PouchDB', () => {
		const at = beamio.indexOf('const readInitObject = async')
		const block = beamio.slice(at, at + 3000) // 3000: the read and the guarded writer (0.53.39) together
		expect(block).toMatch(/if \(isShellContext\(\)\) \{[\s\S]{0,400}shellRecordRead\(/)
		expect(block).toMatch(/const writeInitObject = async[\s\S]{0,1300}shellRecordWrite\(data\)/) // the refusal check (0.53.39) sits before the shell write
		expect(block).toContain('assertNoPgpPrivate(data)')
	})

	it('the write path uses persistInitRecord; the Cache API copy and the PouchDB write are browser-only', () => {
		const at = beamio.indexOf('const persistInitRecord = async')
		// step 3: the shell branch carries the fresh-write guard (prepareShellFreshWrite) before its return.
		const block = beamio.slice(at, at + 2400)
		expect(block).toMatch(/if \(isShellContext\(\)\) \{[\s\S]{0,2000}return\s*\}/)
		expect(block.indexOf('cacheStorageBackup(encodeInitRaw(record))')).toBeGreaterThan(block.indexOf('return'))
		expect(beamio).toContain('await persistInitRecord(temp)')
		expect(beamio).not.toMatch(/await storageHashData\("init", dataB64\)\s*\n\s*stored = true/)
	})

	it('the shell starts the PGP migration once after the wallet is established (background, no UI)', () => {
		const gate = read('src/components/AppEntryGate.tsx')
		expect(gate).toMatch(/if \(nativeShellRef\.current\) void startPgpMigrationOnce\(\)/)
		expect(gate).toContain("import { startPgpMigrationOnce } from '@/services/pgpMigrationRunner'")
	})
})
