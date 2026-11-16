/**
 * Diagnostics (0.53.5): every shell record read logs its caller label, the status or reason code, and the milliseconds.
 * The log lines never carry a record, a key, a field value or an address. Static check of the log lines and the labels.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const store = readFileSync(join(__dirname, 'shellRecordStore.ts'), 'utf8')
const beamio = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
const logLines = store.split('\n').filter((l) => l.includes('[shellRecordRead]') && (l.includes('publishNativePwaLog(') || l.trim().startsWith('`[shellRecordRead]')))

describe('shell record read diagnostics (caller label, codes and times only)', () => {
	it('every read log line carries the caller label', () => {
		expect(logLines.length).toBe(3)
		for (const l of logLines) expect(l).toMatch(/source/)
	})

	it('the log lines carry no record, key, field or address value', () => {
		// the tag itself is the fixed prefix; the rest of each line is checked
		const joined = logLines.map((l) => l.replace('[shellRecordRead]', '')).join('\n')
		expect(joined).not.toMatch(/record|privateKey|mnemonic|keyID|eoa|address|profiles|armor/i)
	})

	it('the internal callers and the init path set a label', () => {
		expect(store).toContain("source: 'deferred'")
		expect(store).toContain("source: 'removal'")
		expect(beamio).toContain("source: options.probe ? 'probe' : 'init'")
	})
})
