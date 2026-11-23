/**
 * @jest-environment node
 *

 * The pre-read valid path drops a held signer of another account WITHOUT changing the in-memory profile (review, item 2).
 * Synthetic test vector only (the public BIP-39 test phrase); no real or QA account.
 */
import { ethers } from 'ethers'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'
import { holdShellSessionFromPhrase, releaseShellSessionSignerHold, shellSessionEoa } from './shellSessionSigner'

const PUBLIC_TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = ethers.Wallet.fromPhrase(PUBLIC_TEST_PHRASE).address.toLowerCase()

describe('releaseShellSessionSignerHold leaves the in-memory profile unchanged', () => {
	it('after a hold, the release drops the held signer and keeps the profile armor as it was', () => {
		setCoNET_Data({ profiles: [{ keyID: EOA, privateKeyArmor: '' }] } as never)
		const held = holdShellSessionFromPhrase(PUBLIC_TEST_PHRASE, EOA)
		expect(held.kind).toBe('ok')
		const armorBefore = (CoNET_Data as { profiles: { privateKeyArmor: string }[] }).profiles[0].privateKeyArmor
		expect(armorBefore.length).toBeGreaterThan(0) // the hold puts the key on the in-memory profile of the same account

		releaseShellSessionSignerHold()

		expect(shellSessionEoa()).toBe('')
		const armorAfter = (CoNET_Data as { profiles: { privateKeyArmor: string }[] }).profiles[0].privateKeyArmor
		expect(armorAfter).toBe(armorBefore) // not blanked: no empty privateKeyArmor is left for a later write to carry
	})

	it('with nothing held, the release does nothing', () => {
		setCoNET_Data({ profiles: [{ keyID: EOA, privateKeyArmor: 'kept' }] } as never)
		releaseShellSessionSignerHold()
		expect((CoNET_Data as { profiles: { privateKeyArmor: string }[] }).profiles[0].privateKeyArmor).toBe('kept')
	})
})
