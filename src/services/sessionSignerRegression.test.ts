/**
 * @jest-environment node
 *
 * Synthetic regression of the session-signer clearing. Only the public BIP-39 test phrases are used; no real or QA
 * account, no device, no credential.
 *
 * Scope (stated, not hidden): this runs in memory. The persisted read-back (write, run the path, read back and compare the stored bytes) needs the
 * device key store (a CryptoKey in IndexedDB), which fake-indexeddb cannot hold; that part is NOT covered here. The persisted guarantee rests on
 * the write layer keeping stored wraps for slots that are empty in memory (passcode/walletVault.ts, wrapForPersist), recorded in the review response.
 */
import { ethers } from 'ethers'
import { CoNET_Data, setCoNET_Data } from '@/utils/globals'
import { clearShellSessionSigner, holdShellSessionFromPhrase, releaseShellSessionSignerHold, shellSessionEoa } from './shellSessionSigner'
import { writeInitWithKeep } from './passcode/walletVault'

jest.mock('./chatLocalMigration', () => ({ lockChatLocalOnLogout: async () => false }))
jest.mock('./beamio', () => ({ lockWalletVaultOnLogout: async () => false }))
jest.mock('./nativeKeyState', () => ({ sendGlobalDestroyOnLogout: () => false }))
jest.mock('./shellEntryReset', () => ({ SHELL_ENTRY_RESET_EVENT: 'beamio:test-reset' }))

// Two public BIP-39 test vectors (no funds, no person).
const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const EOA_A = ethers.Wallet.fromPhrase(PHRASE_A).address.toLowerCase()
const EOA_B = ethers.Wallet.fromPhrase(PHRASE_B).address.toLowerCase()
const KEY_A = ethers.Wallet.fromPhrase(PHRASE_A).privateKey
const KEY_B = ethers.Wallet.fromPhrase(PHRASE_B).privateKey

type Fixture = { name: string; data: () => unknown }
// (a) an account whose key has a stored wrap; (b) an old plaintext key record without a wrap; (c) two accounts, the held one first.
const FIXTURES: Fixture[] = [
	{ name: '(a) key with a stored wrap', data: () => ({ profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, privateKeyArmorWrap: { mode: 'device', v: 1 } }] }) },
	{ name: '(b) legacy plaintext key, no wrap', data: () => ({ profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A }] }) },
	{
		name: '(c) two accounts (held first)',
		data: () => ({ profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A }, { keyID: EOA_B, privateKeyArmor: KEY_B }] }),
	},
]

const snapshot = (): string => JSON.stringify(CoNET_Data)

/** Each path below is exercised with the account A signer held, as the real paths are (a held key of another account is the trigger). */
const PATHS: Array<{ name: string; run: () => Promise<void>; heldAfter?: string }> = [
	{
		name: 'pre-read valid path (5dbad42): releaseShellSessionSignerHold',
		run: async () => releaseShellSessionSignerHold(),
	},
	{
		name: 'prepareShellEntry eoa-mismatch branch (8a900f5): releaseShellSessionSignerHold',
		run: async () => releaseShellSessionSignerHold(),
	},
	{
		name: 'onVaultLocked (8b4313c): releaseShellSessionSignerHold',
		run: async () => releaseShellSessionSignerHold(),
	},
	{
		name: 'account switch (shellSessionSigner, 0.53.39 review of 5dbad42, item 3): holdShellSessionFromPhrase for account B',
		run: async () => {
			expect(holdShellSessionFromPhrase(PHRASE_B, EOA_B).kind).toBe('ok')
		},
		heldAfter: EOA_B,
	},
	{
		name: 'signOutLocal (157d8de): signOutLocalWallet',
		run: async () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { signOutLocalWallet } = require('./signOutLocal')
			await signOutLocalWallet()
		},
	},
]

describe('synthetic regression: the signer clear never blanks a stored or in-memory private key', () => {
	for (const fx of FIXTURES) {
		for (const path of PATHS) {
			it(`${fx.name} / ${path.name}: the snapshot is unchanged and no privateKeyArmor is emptied`, async () => {
				setCoNET_Data(fx.data() as never)
				expect(holdShellSessionFromPhrase(PHRASE_A, EOA_A).kind).toBe('ok')
				const before = snapshot()
				const armorsBefore = (CoNET_Data as { profiles: Array<{ privateKeyArmor?: string }> }).profiles.map((p) => p.privateKeyArmor)

				await path.run()

				expect(snapshot()).toBe(before)
				const armorsAfter = (CoNET_Data as { profiles: Array<{ privateKeyArmor?: string }> }).profiles.map((p) => p.privateKeyArmor)
				expect(armorsAfter).toEqual(armorsBefore)
				for (const a of armorsAfter) expect(a === '' || a === undefined).toBe(false)
				expect(shellSessionEoa()).toBe(path.heldAfter ?? '') // the previous signer is dropped (switch: the new account is held)
				// the write layer, the production entry (writeInitWithKeep) on an in-memory store: the record written, read back and normalised
				// (JSON) is equal to the stored record before the write, byte for byte, for every account (criterion (a)).
				const stored = fx.data() as Record<string, unknown>
				let saved: unknown = JSON.parse(JSON.stringify(stored))
				const memStore = {
					readInit: async () => JSON.parse(JSON.stringify(saved)),
					probeInit: async () => JSON.parse(JSON.stringify(saved)),
					writeInit: async (data: unknown) => {
						saved = JSON.parse(JSON.stringify(data))
					},
				} as never
				await writeInitWithKeep(memStore, JSON.parse(snapshot()))
				expect(JSON.stringify(saved)).toBe(JSON.stringify(stored))
			})
		}
	}
})

describe('control: the detector catches the old behaviour', () => {
	it('the previous clearShellSessionSigner does blank the in-memory key (so the regression above would fail on it)', () => {
		setCoNET_Data({ profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A }] } as never)
		expect(holdShellSessionFromPhrase(PHRASE_A, EOA_A).kind).toBe('ok')
		clearShellSessionSigner()
		expect((CoNET_Data as { profiles: Array<{ privateKeyArmor?: string }> }).profiles[0].privateKeyArmor).toBe('')
	})
})
