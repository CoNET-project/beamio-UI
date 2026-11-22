/**
 * Test-support loader for the mnemonic-to-EOA vectors. Imported by test files only, never by the app.
 *
 * The repository stores only the BIP-39 official English vectors listed in __fixtures__/bip39-official-english-vectors.json
 * (source named in its header; each entry is re-derived from its entropy here). Every other phrase is generated at run time:
 *   - 'sdk23': deterministic transforms of official phrases (spacing, case, width, invalid counts and checksums);
 *   - 'synthetic100': SYNTHETIC phrases from fixed entropy (SHA-256 of a fixed label).
 * The EOA is the ethers 6 address at m/44'/60'/0'/0/0. Nothing here corresponds to an account; nothing is funded or sent on chain.
 * Test files pin the SHA256 of the generated sets; a changed generator fails the pin.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'

export type VectorSet = 'sdk23' | 'synthetic100'

export type VectorCase = {
	id: string
	input: string
	sdk_accept: boolean
	pwa_sync_emits: boolean
	expect_behaviour: 'accept' | 'reject'
	expected_canonical: string | null
	expected_eoa: string | null
	word_count?: number
	note?: string
	[k: string]: unknown
}

export const OFFICIAL_FILE = 'bip39-official-english-vectors.json'

/** Re-derives every official entry from its entropy; throws when an entry does not match. */
export function officialPhrases(): Record<string, string> {
	const path = join(__dirname, '__fixtures__', OFFICIAL_FILE)
	if (!existsSync(path)) throw new Error(`official vector file missing: ${path}`)
	const doc = JSON.parse(readFileSync(path, 'utf8')) as { entries: { id: string; entropy: string; mnemonic: string }[] }
	const out: Record<string, string> = {}
	for (const e of doc.entries) {
		const phrase = ethers.Mnemonic.fromEntropy('0x' + e.entropy).phrase
		if (phrase !== e.mnemonic) throw new Error(`official entry ${e.id} does not match its entropy`)
		out[e.id] = e.mnemonic
	}
	return out
}

export function officialFileSha256(): string {
	return createHash('sha256').update(readFileSync(join(__dirname, '__fixtures__', OFFICIAL_FILE))).digest('hex')
}

const eoaOf = (phrase: string): string => ethers.Wallet.fromPhrase(phrase).address.toLowerCase()
const phraseOf = (hexBytes: string): string => ethers.Mnemonic.fromEntropy('0x' + hexBytes).phrase
const joinWith = (words: string[], seps: string[]): string => words.reduce((acc, w, i) => (i === 0 ? w : acc + seps[i - 1] + w), '')
const fullWidth = (s: string): string => Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('')

function accept(id: string, input: string, canonical: string): VectorCase {
	return {
		id,
		input,
		sdk_accept: true,
		pwa_sync_emits: input === canonical,
		expect_behaviour: 'accept',
		expected_canonical: canonical,
		expected_eoa: eoaOf(canonical),
	}
}

function reject(id: string, input: string): VectorCase {
	return { id, input, sdk_accept: false, pwa_sync_emits: false, expect_behaviour: 'reject', expected_canonical: null, expected_eoa: null }
}

function sdk23Cases(): VectorCase[] {
	const O = officialPhrases()
	const std12 = O['zero-12']
	const w = std12.split(' ')
	const rep = (s: string, n: number) => Array<string>(n).fill(s)
	const legal = O['legal-12']
	const std15 = phraseOf('00'.repeat(20))
	const std21 = phraseOf('00'.repeat(28))
	return [
		accept('std12', std12, std12),
		accept('std24', O['zero-24'], O['zero-24']),
		accept('std15', std15, std15),
		accept('std18', O['zero-18'], O['zero-18']),
		accept('std21', std21, std21),
		accept('std12-legal', legal, legal),
		accept('trim-spaces', `   ${std12}   `, std12),
		accept('trim-tab-newline', `\t${std12}\n`, std12),
		accept('inner-multi-space', joinWith(w, rep('   ', 11)), std12),
		accept('inner-tab-newline', joinWith(w, ['\t', ...rep(' \n ', 10)]), std12),
		accept('nbsp-between', joinWith(w, rep('\xa0', 11)), std12),
		accept('ideographic-space', joinWith(w, rep('　', 11)), std12),
		accept('uppercase', std12.toUpperCase(), std12),
		accept('mixed-case', ['Abandon', 'ABANDON', 'abandon', 'aBANDON', ...rep('abandon', 7), 'About'].join(' '), std12),
		accept('fullwidth-nfkd', [fullWidth('abandon'), ...w.slice(1)].join(' '), std12),
		accept('tab-inside', joinWith(w, ['\t', ...rep(' ', 10)]), std12),
		accept('newline-inside', joinWith(w, rep(' \n', 11)), std12),
		reject('bad-word', [...w.slice(0, 11), 'zzzzzz'].join(' ')),
		reject('bad-checksum', rep('abandon', 12).join(' ')),
		reject('bad-count-11', rep('abandon', 11).join(' ')),
		reject('bad-count-13', [...rep('abandon', 11), 'about', 'abandon'].join(' ')),
		reject('empty', ''),
		reject('non-english-japanese', ethers.Mnemonic.fromEntropy('0x' + '00'.repeat(16), null, ethers.wordlists.ja).phrase),
	]
}

const SYNTH_BYTES: Record<number, number> = { 12: 16, 15: 20, 18: 24, 21: 28, 24: 32 }

function synthetic100Cases(): VectorCase[] {
	const cases: VectorCase[] = []
	for (const wc of [12, 15, 18, 21, 24]) {
		for (let k = 0; k < 20; k++) {
			const label = `SYNTHETIC-vector|${wc}|${k}`
			const hex = createHash('sha256').update(label).digest('hex').slice(0, SYNTH_BYTES[wc] * 2)
			const phrase = phraseOf(hex)
			cases.push({
				id: `syn-${wc}-${String(k).padStart(2, '0')}`,
				input: phrase,
				word_count: wc,
				sdk_accept: true,
				pwa_sync_emits: true,
				expect_behaviour: 'accept',
				expected_canonical: phrase,
				expected_eoa: eoaOf(phrase),
				note: 'SYNTHETIC: generated at run time from a fixed label; no account, never funded or sent on chain.',
			})
		}
	}
	return cases
}

/** Returns the generated cases and the SHA256 of their canonical JSON (the value test files pin). */
export function loadVectors(set: VectorSet): { cases: VectorCase[]; sha256: string } {
	const cases = set === 'sdk23' ? sdk23Cases() : synthetic100Cases()
	return { cases, sha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex') }
}
