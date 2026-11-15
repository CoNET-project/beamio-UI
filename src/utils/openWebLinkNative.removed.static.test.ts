/**
 * openWebLinkNative had no callers and used the legacy AndroidBridge; it is deleted. This guard fails if any source file
 * under src/ refers to it again. Reads source files only.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const SELF = path.resolve(__filename)

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		if (fs.statSync(full).isDirectory()) {
			if (name === 'node_modules') continue
			sourceFiles(full, out)
		} else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
			out.push(full)
		}
	}
	return out
}

describe('openWebLinkNative is removed and not referenced', () => {
	it('no source file under src/ mentions openWebLinkNative (except this guard)', () => {
		const hits = sourceFiles(SRC)
			.filter((file) => path.resolve(file) !== SELF)
			.filter((file) => fs.readFileSync(file, 'utf8').includes('openWebLinkNative'))
		expect(hits).toEqual([])
	})

	it('api/index.ts no longer declares it', () => {
		const text = fs.readFileSync(path.join(SRC, 'api', 'index.ts'), 'utf8')
		expect(text).not.toMatch(/export const openWebLinkNative/)
	})
})
