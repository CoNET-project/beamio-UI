import { pageRecordIsExplicitEmptyMnemonic, PWA_EMPTY_SIGNAL_TYPE, PWA_EMPTY_SIGNAL_STATE } from './pwaEmptySignal'

describe('pageRecordIsExplicitEmptyMnemonic', () => {
	it('empty store is explicit empty', () => {
		expect(pageRecordIsExplicitEmptyMnemonic(null, 'empty')).toBe(true)
	})

	it('loaded with no mnemonicPhrase is explicit empty (incl. key_only private-key rows)', () => {
		expect(pageRecordIsExplicitEmptyMnemonic({ profiles: [{ keyID: '0x' + '11'.repeat(20), privateKeyArmor: '0xab' }] }, 'loaded')).toBe(true)
		expect(pageRecordIsExplicitEmptyMnemonic({}, 'loaded')).toBe(true)
	})

	it('phrase / envelope / other are not explicit empty', () => {
		expect(pageRecordIsExplicitEmptyMnemonic({ mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }, 'loaded')).toBe(false)
		expect(
			pageRecordIsExplicitEmptyMnemonic(
				{ mnemonicPhrase: { v: 3, mode: 'passcode', alg: 'AES-256-GCM', kdf: 'x', salt: 's', iv: 'i', ct: 'c', eoa: '0x' + '22'.repeat(20) } },
				'loaded',
			),
		).toBe(false)
		expect(pageRecordIsExplicitEmptyMnemonic({ mnemonicPhrase: 123 }, 'loaded')).toBe(false)
	})

	it('unavailable / locked never send', () => {
		expect(pageRecordIsExplicitEmptyMnemonic(null, 'unavailable')).toBe(false)
		expect(pageRecordIsExplicitEmptyMnemonic(null, 'locked')).toBe(false)
	})
})

describe('wire constants', () => {
	it('match the shell contract', () => {
		expect(PWA_EMPTY_SIGNAL_TYPE).toBe('pwaEmptySignal')
		expect(PWA_EMPTY_SIGNAL_STATE).toBe('explicit_empty')
	})
})
