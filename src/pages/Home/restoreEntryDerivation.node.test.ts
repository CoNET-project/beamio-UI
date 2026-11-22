/**
 * @jest-environment node
 *
 * C-2: the fixed sample derives the fixed address with the real derivation (ethers). The node environment is used because ethers cannot
 * derive inside jsdom (cross-realm bytes). The render test (RestoreWalletUnifiedScreen.render.test.tsx) decrypts nothing: it mocks the
 * restore calls and checks that both entries hand the same phrase to the restore; this file checks what that phrase derives to.
 */
import { ethers } from 'ethers'
import { C2_SAMPLE_EOA, C2_SAMPLE_PHRASE } from './restoreEntryFixture'

describe('C-2: the sample derives the fixed address (real derivation)', () => {
	it('the BIP-39 sample phrase derives 0x9858effd232b4033e47d90003d41ec34ecaeda94', () => {
		expect(ethers.Wallet.fromPhrase(C2_SAMPLE_PHRASE).address.toLowerCase()).toBe(C2_SAMPLE_EOA)
	})
})
