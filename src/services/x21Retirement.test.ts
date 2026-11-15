/**
 * @jest-environment node
 *
 * is retired (decided by the project owner 2026-11-12: no old-key bridge transfer). The PWA must not initiate or
 * answer any key transfer. to on the PWA side are checked here, statically, against the non-test sources.
 * SYNTHETIC values only.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')
const RETIRED_TOKENS = [
	'walletTransferOnce',
	'walletTransferRequest',
	'walletTransferResult',
	'walletTransferStatus',
	'walletTransferSwitched',
	'x21Handoff',
	'copyForTransfer',
	'X21_CONDITION_8',
	'installX21',
	'nativeX21Bridge',
]

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name === '__fixtures__' || name === 'node_modules') continue
			sourceFiles(p, out)
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
			out.push(p)
		}
	}
	return out
}

describe('the PWA has no walletTransferOnce sender and no responder', () => {
	it('no non-test source mentions a retired name (static scan)', () => {
		const hits: string[] = []
		for (const file of sourceFiles(SRC)) {
			const text = readFileSync(file, 'utf8')
			for (const token of RETIRED_TOKENS) {
				if (text.includes(token)) hits.push(`${relative(SRC, file)}: ${token}`)
			}
		}
		expect(hits).toEqual([])
	})
})
