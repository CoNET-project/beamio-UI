/**
 * the temporary account passcode is not copied to the clipboard (1, clause 3). The copy entry is
 * removed; the display with its show and hide toggle stays. Source guard only; no passcode value is used or printed.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')

/** Non-test source files under src (fixtures and tests excluded). */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === '__fixtures__' || name === 'node_modules') continue
		const full = join(dir, name)
		if (statSync(full).isDirectory()) sourceFiles(full, out)
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full)
	}
	return out
}

describe('the temporary account passcode is never copied to the clipboard', () => {
	const view = readFileSync(join(SRC, 'pages', 'BountyBoard', 'AgentTempAccountStates.tsx'), 'utf8')

	it('the copy entry for the passcode is removed from the temp-account view', () => {
		expect(view).not.toContain("copyText('pw'")
		expect(view).not.toContain('Copy temporary password')
		expect(view).not.toContain("copiedKey === 'pw'")
	})

	it('the display of the passcode with its show and hide toggle stays (display is not an exit under)', () => {
		expect(view).toContain("aria-label={revealPw ? 'Hide password' : 'Show password'}")
		expect(view).toContain('{revealPw ? temp.accessPassword')
	})

	it('no non-test source passes the passcode to a clipboard write or to copyText', () => {
		const hits: string[] = []
		for (const f of sourceFiles(SRC)) {
			const lines = readFileSync(f, 'utf8').split('\n')
			lines.forEach((line, i) => {
				if (/accessPassword/.test(line) && /(copyText\(|writeText\()/.test(line)) {
					hits.push(`${relative(SRC, f)}:${i + 1}`)
				}
			})
		}
		expect(hits).toEqual([])
	})
})
