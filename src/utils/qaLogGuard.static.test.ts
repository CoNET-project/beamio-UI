/**
 * @jest-environment node
 */
/** Every QA line call site is behind the build-time constant, so the line text is folded out of a build without the QA flag. */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')
const walk = (d: string, out: string[] = []): string[] => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const f = path.join(d, e.name)
		if (e.isDirectory()) walk(f, out)
		else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(f)
	}
	return out
}

describe('qaLine call sites', () => {
	it('each call is guarded by process.env.REACT_APP_QA_BRIDGE_COUNTER on the same line (qaLog.ts and the counter module guard themselves)', () => {
		const bad: string[] = []
		for (const f of walk(SRC)) {
			const rel = path.relative(SRC, f)
			if (rel === 'utils/qaLog.ts' || rel === 'utils/qaChainReadCounter.ts') continue
			fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
				if (/\bqaLine\(/.test(line) && !/^\s*import /.test(line) && !line.includes("process.env.REACT_APP_QA_BRIDGE_COUNTER === 'true'")) bad.push(`${rel}:${i + 1}`)
			})
		}
		expect(bad).toEqual([])
	})
})
