/**
 * @jest-environment node
 */
/**
 * Cross-implementation vectors for the mnemonic-to-EOA derivation. The official BIP-39 vectors are stored (see mnemonicVectorsLoader.ts);
 * the 23-case set and the 100-case SYNTHETIC set (12/15/18/21/24 words, 20 each) are generated at run time. The SHA256 of each
 * generated set is pinned below; a changed generator fails the pin. Neither set corresponds to an account.
 * Checked per case: mnemonicEoa against expected_eoa; the wire emission against pwa_sync_emits (see pwaWalletSyncCanonical.test.ts);
 * the word-count distribution. The wire itself is checked in pwaWalletSyncCanonical.test.ts through the real sync function (canonicalised).
 * (isMnemonicPhrase) is pinned and deferred.
 */
import { mnemonicEoa } from './shellLegacyIdbInit'
import { isMnemonicPhrase } from './walletCredential'
import { loadVectors, officialFileSha256, type VectorCase } from './mnemonicVectorsLoader'

// SHA256 pins of the generated sets (canonical JSON) and of the stored official file.
const PIN = {
	official: '001dbd65d95e6ee2dde82f7da835a2b914dd86fcfa3a7ba5c01f22064377e759',
	sdk23: 'a9ce1f818a60a5191f5dc75cb1425246a5642b5812042892f16781a7b32c11d4',
	synthetic100: '433a770da36944dab5ba3a2aafd95cce92bd07b618d5a04d3246a7896e0027ee',
}

const sdk23 = loadVectors('sdk23').cases
const loadSynthetic = () => loadVectors('synthetic100').cases

const wordCount = (c: VectorCase) => c.input.trim().split(/\s+/).length

describe('shared vectors: the files are the verified ones', () => {
	it('the official file and the generated sets match their pinned SHA256', () => {
		expect(officialFileSha256()).toBe(PIN.official)
		expect(loadVectors('sdk23').sha256).toBe(PIN.sdk23)
		expect(loadVectors('synthetic100').sha256).toBe(PIN.synthetic100)
	})
	it('23-case file has 23 cases and 100-case synthetic file has 100', () => {
		expect(sdk23).toHaveLength(23)
		expect(loadSynthetic()).toHaveLength(100)
	})
})

describe('23 SDK cases: mnemonicEoa agrees with the expectation on every case', () => {
	it.each(sdk23.map((c) => [c.id, c] as const))('%s', (_id, c) => {
		const out = mnemonicEoa(c.input)
		if (c.expect_behaviour === 'accept') expect(out).toBe(c.expected_eoa)
		else expect(out).toBe('')
	})
})

describe('100 synthetic cases: mnemonicEoa agrees with expected_eoa on every case', () => {
	it('every accepted case derives to its expected EOA (failures listed by id)', () => {
		const random = loadSynthetic()
		const failures = random.filter((c) => mnemonicEoa(c.input) !== (c.expected_eoa ?? '')).map((c) => c.id)
		expect(failures).toEqual([])
	})
	it('word-count distribution: 12, 15, 18, 21, 24 words, 20 each, all accepted', () => {
		const random = loadSynthetic()
		const dist: Record<number, number> = {}
		for (const c of random) {
			const n = wordCount(c)
			dist[n] = (dist[n] ?? 0) + 1
		}
		expect(dist).toEqual({ 12: 20, 15: 20, 18: 20, 21: 20, 24: 20 })
		expect(random.every((c) => c.expect_behaviour === 'accept')).toBe(true)
		// the file's own word_count field agrees with the split count
		expect(random.filter((c) => c.word_count !== undefined && c.word_count !== wordCount(c))).toEqual([])
	})
})

describe('23 SDK cases: sync wire and page validator', () => {
	// SDK accepts; isMnemonicPhrase (12/24 words, raw input, lower case, single spaces) does not. Current PWA behaviour pinned.
	const PAGE_VALIDATOR_REJECTS_SDK_ACCEPTED = ['trim-spaces', 'trim-tab-newline', 'inner-multi-space', 'inner-tab-newline', 'nbsp-between', 'ideographic-space', 'uppercase', 'mixed-case', 'fullwidth-nfkd', 'tab-inside', 'newline-inside', 'std15', 'std18', 'std21']
	it('isMnemonicPhrase rejects exactly the pinned SDK-accepted spellings', () => {
		const rejected = sdk23.filter((c) => c.expect_behaviour === 'accept' && !isMnemonicPhrase(c.input)).map((c) => c.id)
		expect(rejected.sort()).toEqual([...PAGE_VALIDATOR_REJECTS_SDK_ACCEPTED].sort())
	})
})
