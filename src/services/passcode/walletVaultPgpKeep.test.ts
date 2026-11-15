/**
 * @jest-environment node
 *
 * Plan N: in a shell the write copy holds the page's own fields only. The stored record (with the PGP key) is in the
 * native store. The write path reads the stored record only through the bridge, which answers without the PGP private key (the
 * native side strips it); the page copy never carries it. The browser build is unchanged.
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { setCoNET_Data, CoNET_Data } from '../../utils/globals'
import { wrapForDisk } from './walletVault'

const PGP = 'PGP-PRIV-ARMOR-XYZ'
const EOA = '0x' + '2'.repeat(64)
// public BIP39 test vector (zero entropy), not a user's phrase
const stored = () => ({
	mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
	isReady: true,
	profiles: [{ keyID: '0x' + '1'.repeat(40), privateKeyArmor: EOA, isPrimary: true, chatManager: { pgpKey: { publicKey: 'PUB', privateKey: PGP } } }],
})

const makeStores = (init: Record<string, unknown>) => {
	let devKey: CryptoKey | null = null
	const readInit = jest.fn(async () => JSON.parse(JSON.stringify(init)))
	return {
		stores: {
			readInit,
			writeInit: async () => undefined,
			readMeta: async () => ({ failures: 0 }),
			writeMeta: async () => undefined,
			deviceKeys: {
				load: async () => devKey,
				save: async (k: CryptoKey) => {
					devKey = k
				},
			},
		} as never,
		readInit,
	}
}

describe('plan N: the write path in a shell never puts the stored PGP key into the page copy', () => {
	const saved = process.env.REACT_APP_SHELL_BUILD
	afterEach(() => {
		if (saved === undefined) delete process.env.REACT_APP_SHELL_BUILD
		else process.env.REACT_APP_SHELL_BUILD = saved
	})

	it('shell: the write copy has no PGP private key; the stored record is read once, through the bridge', async () => {
		process.env.REACT_APP_SHELL_BUILD = 'true'
		setCoNET_Data(stored() as never)
		const pageCopy = JSON.parse(JSON.stringify(CoNET_Data))
		const { stores, readInit } = makeStores(stored())
		const out = await wrapForDisk(stores, pageCopy)
		expect(JSON.stringify(out).includes(PGP)).toBe(false)
		expect(JSON.stringify(CoNET_Data).includes(PGP)).toBe(false)
		// wrapForPersist reads the stored record for the wrap slots only; the PGP key is never in what the page writes.
		expect(readInit).toHaveBeenCalledTimes(1)
	})

	it('shell: the EOA key is written as before (its own slot)', async () => {
		process.env.REACT_APP_SHELL_BUILD = 'true'
		setCoNET_Data(stored() as never)
		const pageCopy = JSON.parse(JSON.stringify(CoNET_Data))
		const { stores } = makeStores(stored())
		const out = (await wrapForDisk(stores, pageCopy)) as any
		expect(JSON.stringify(out).includes(EOA)).toBe(false)
		expect(out.profiles[0].keyID).toBe('0x' + '1'.repeat(40))
	})

	it('browser: the written record is the page copy, unchanged', async () => {
		delete process.env.REACT_APP_SHELL_BUILD
		setCoNET_Data(stored() as never)
		const pageCopy = JSON.parse(JSON.stringify(CoNET_Data))
		const { stores } = makeStores(stored())
		const out = await wrapForDisk(stores, pageCopy)
		expect(JSON.stringify(out).includes(PGP)).toBe(true)
	})
})
