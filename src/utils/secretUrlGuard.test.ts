/**
 * Static guard: no source file may write the Recovery Code (MasterKey) into a
 * URL, and the dynamic manifest must stay removed. Reads src/ and public/ only.
 * Comment lines are skipped. secretUrlParams.ts documents the names and is exempt.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const ROOT = path.resolve(__dirname, '..', '..')
const EXEMPT = new Set([path.join(SRC, 'utils', 'secretUrlParams.ts')])

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			walk(full, out)
		} else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
			out.push(full)
		}
	}
	return out
}

/** Non-comment lines, with line numbers. */
function codeLines(file: string): Array<{ n: number; text: string }> {
	const lines = fs.readFileSync(file, 'utf8').split('\n')
	const out: Array<{ n: number; text: string }> = []
	let inBlock = false
	lines.forEach((raw, i) => {
		const t = raw.trim()
		if (inBlock) {
			if (t.includes('*/')) inBlock = false
			return
		}
		if (t.startsWith('/*')) {
			if (!t.includes('*/')) inBlock = true
			return
		}
		if (t.startsWith('//') || t.startsWith('*')) return
		out.push({ n: i + 1, text: raw })
	})
	return out
}

const SECRET = /(masterkey|recoverycode|recovercode|master_key)/i

const WRITE_PATTERNS: Array<{ label: string; rx: RegExp }> = [
	{ label: 'searchParams set/append with a secret name', rx: /\.(set|append)\(\s*['"`](masterkey|recoverycode|recovercode|master_key)['"`]/i },
	{ label: 'history replaceState/pushState with a secret name', rx: /(replaceState|pushState)\([^)]*(masterkey|recoverycode|recovercode)/i },
	{ label: 'location href/hash/replace with a secret name', rx: /location(\.(href|hash)\s*=|\.replace\()[^;]*(masterkey|recoverycode|recovercode)/i },
	{ label: 'query-string literal with a secret name', rx: /[?&#](masterkey|recoverycode|recovercode)=/i },
]

describe('static guard: Recovery Code never written into a URL', () => {
	const files = walk(SRC).filter((f) => !EXEMPT.has(f))

	it('scans a non-empty set of source files', () => {
		expect(files.length).toBeGreaterThan(100)
	})

	for (const { label, rx } of WRITE_PATTERNS) {
		it(`no source line matches: ${label}`, () => {
			const hits: string[] = []
			for (const f of files) {
				for (const { n, text } of codeLines(f)) {
					if (rx.test(text)) hits.push(`${path.relative(ROOT, f)}:${n}`)
				}
			}
			expect(hits).toEqual([])
		})
	}

	it('no code reads a secret name into a URL template (${} near a secret name in a URL)', () => {
		const hits: string[] = []
		for (const f of files) {
			for (const { n, text } of codeLines(f)) {
				if (/[?&#]\$\{[^}]*\}/.test(text) && SECRET.test(text)) hits.push(`${path.relative(ROOT, f)}:${n}`)
			}
		}
		expect(hits).toEqual([])
	})
})

describe('static guard: dynamic manifest stays removed', () => {
	const files = walk(SRC).filter((f) => !EXEMPT.has(f))

	it('no source module imports the removed updateManifestStartUrl helper', () => {
		const hits: string[] = []
		for (const f of files) {
			for (const { n, text } of codeLines(f)) {
				if (/updateManifestStartUrl/.test(text)) hits.push(`${path.relative(ROOT, f)}:${n}`)
			}
		}
		expect(hits).toEqual([])
		expect(fs.existsSync(path.join(SRC, 'utils', 'updateManifestStartUrl.ts'))).toBe(false)
	})

	it('no source line writes a start_url or a manifest link at runtime', () => {
		const hits: string[] = []
		for (const f of files) {
			for (const { n, text } of codeLines(f)) {
				if (/start_url/.test(text) || /rel\s*=\s*['"]manifest['"]/.test(text)) {
					hits.push(`${path.relative(ROOT, f)}:${n}`)
				}
			}
		}
		expect(hits).toEqual([])
	})

	it('public/manifest.json start_url is a fixed path with no query and no secret name', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'))
		expect(typeof manifest.start_url).toBe('string')
		expect(manifest.start_url).not.toMatch(/[?#]/)
		expect(JSON.stringify(manifest)).not.toMatch(SECRET)
	})

	it('public/index.html keeps a static manifest link and no secret name in inline URL code', () => {
		const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
		expect(html).toMatch(/<link rel="manifest" href="%PUBLIC_URL%\/manifest\.json"/)
		const inlineScripts = html.match(/<script[\s\S]*?<\/script>/g) || []
		const bad = inlineScripts.filter((s) => /(replaceState|pushState)[^;]*(masterkey|recoverycode|recovercode)/i.test(s))
		expect(bad).toEqual([])
	})
})
