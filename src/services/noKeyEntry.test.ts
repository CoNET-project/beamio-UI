/**
 * walletEoaAddress answers `no_key`. Cases follow the shared vectors page-copy-nokey-vectors.v1.json (sha 4972aa8c…3d93 (page-copy-nokey v1, Y.157),
 * spec 25.52Y.151 / 25.52Y.153), PNK-01 to PNK-05. PNK-05 (the native layer holds the key and reports an address) is the
 * unchanged address path and is covered by the gate's existing tests.
 */
import { decideNoKeyEntry, type NoKeyFacts } from './noKeyEntry'

describe('walletEoaAddress no_key mapping (PNK vectors)', () => {
	it('PNK-01: no no_key copy, walletStatus no_key and kPresent false -> none, onboarding', () => {
		const facts: NoKeyFacts = { walletStatus: 'no_key', kPresent: false }
		expect(decideNoKeyEntry(facts, 'empty')).toBe('onboarding')
	})

	it('PNK-02: a page copy present -> recovery entry only, not none, no automatic retry', () => {
		const facts: NoKeyFacts = { walletStatus: 'no_key', kPresent: false }
		expect(decideNoKeyEntry(facts, 'present')).toBe('native_key_missing')
	})

	it('PNK-03: kPresent missing -> needs recovery, retry unknown, never none', () => {
		const facts: NoKeyFacts = { walletStatus: 'no_key', kPresent: undefined }
		expect(decideNoKeyEntry(facts, 'empty')).toBe('retry')
	})

	it('PNK-04: kPresent true -> needs recovery, recovery entry only, never none', () => {
		const facts: NoKeyFacts = { walletStatus: 'no_key', kPresent: true }
		expect(decideNoKeyEntry(facts, 'empty')).toBe('native_key_missing')
	})

	it('a page copy present with no native facts (facts null) -> recovery entry only, never none', () => {
		expect(decideNoKeyEntry(null, 'present')).toBe('native_key_missing')
	})

	it('a page copy present with kPresent true -> recovery entry only, never none', () => {
		expect(decideNoKeyEntry({ walletStatus: 'no_key', kPresent: true }, 'present')).toBe('native_key_missing')
	})

	it('no facts or an unreadable page record never maps to none', () => {
		expect(decideNoKeyEntry(null, 'empty')).toBe('retry')
		expect(decideNoKeyEntry({ walletStatus: 'no_key', kPresent: false }, 'unknown')).toBe('retry')
		expect(decideNoKeyEntry({ walletStatus: 'locked', kPresent: false }, 'empty')).toBe('retry')
	})
})
