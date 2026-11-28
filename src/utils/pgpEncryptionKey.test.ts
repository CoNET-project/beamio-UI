/**
 * @jest-environment node
 */
// a key with SEVERAL subkeys. The record's userPgpKeyID names the key that actually encrypts (OpenPGP's getEncryptionKey: the newest valid encryption subkey),
// not the first subkey, not the last, not an expired one and not the primary key. SYNTHETIC keys generated here.
import { generateKey, readKey } from 'openpgp'
import { openPgpEncryptionKeyFingerprintOfArmor, openPgpFingerprintOfArmor } from './pgpFingerprint'
import { sendWithFreshRoute, type RecipientLookup } from './recipientPublicKey'

const WL = '0x684b0ac760cEE9c9b85de36d69746420648Cf9e2'
const CONTACT = '0x' + 'ab12'.repeat(10)
const DAY = 86_400_000

let ARMOR = ''
let PRIMARY_FP = ''
const ids: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' }
const fps: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' }

beforeAll(async () => {
	const now = Date.now()
	const at = (ms: number) => new Date(now - ms)
	const { publicKey } = await generateKey({
		type: 'curve25519',
		userIDs: [{ name: 'multi' }],
		format: 'armored',
		date: at(30 * DAY),
		subkeys: [
			{ date: at(20 * DAY) }, // A: the first subkey, valid, old
			{ date: at(1 * DAY) }, // B: the newest VALID encryption subkey: the one that encrypts
			{ date: at(2 * DAY), keyExpirationTime: 86_400 }, // C: created after A, expired a day ago, the LAST in older-than-B order
			{ date: at(12 * 3_600_000), keyExpirationTime: 3_600 }, // D: the newest created, but expired (11 hours ago)
		],
	})
	ARMOR = publicKey.trim()
	PRIMARY_FP = await openPgpFingerprintOfArmor(ARMOR)
	const key = await readKey({ armoredKey: ARMOR })
	const subs = key.subkeys
	expect(subs).toHaveLength(4)
	;(['A', 'B', 'C', 'D'] as const).forEach((k, i) => {
		ids[k] = subs[i].getKeyID().toHex().toUpperCase()
		fps[k] = subs[i].getFingerprint().toLowerCase()
	})
}, 120_000)

const read = (userPgpKeyID: string): jest.Mock<Promise<RecipientLookup>, []> =>
	jest.fn(async (): Promise<RecipientLookup> => ({ status: 'ok', publicArmored: ARMOR, routersArmoreds: 'route-1', routePgpKeyID: 'r1', userPgpKeyID, source: { chainId: 224422, contract: WL, queriedAddress: CONTACT } }))

describe('the key that encrypts, with several subkeys', () => {
	it('is the newest VALID encryption subkey: not the first, not the last, not the newest-created expired one, not the primary', async () => {
		const enc = await openPgpEncryptionKeyFingerprintOfArmor(ARMOR)
		expect(enc).toBe(fps.B)
		expect(enc).not.toBe(fps.A)
		expect(enc).not.toBe(fps.C)
		expect(enc).not.toBe(fps.D)
		expect(enc).not.toBe(PRIMARY_FP)
	})

	const send = async (id: string) => {
		const sent = jest.fn(async () => true)
		const pinned = jest.fn()
		const r = await sendWithFreshRoute({ address: CONTACT, chatData: {} }, 'hi', 'pk', ['n'], { fetchKeys: read(id), send: sent, onFirstPinned: pinned })
		return { r, sent, pinned }
	}

	it('a record naming that subkey is sent directly and pins the PRIMARY fingerprint', async () => {
		const { r, sent, pinned } = await send(ids.B)
		expect(r.ok).toBe(true)
		expect(sent).toHaveBeenCalledTimes(1)
		expect(pinned).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: PRIMARY_FP }))
	})
	it.each([
		['the first subkey', 'A'],
		['an expired subkey created before the valid one', 'C'],
		['the newest-created but expired subkey', 'D'],
	] as const)('a record naming %s is held (it is not the key that encrypts)', async (_label, which) => {
		const { r, sent, pinned } = await send(ids[which])
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(sent).not.toHaveBeenCalled()
		expect(pinned).not.toHaveBeenCalled()
	})
	it('a record naming the primary key is held', async () => {
		const { r, sent } = await send((await readKey({ armoredKey: ARMOR })).getKeyID().toHex().toUpperCase())
		expect(r).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(sent).not.toHaveBeenCalled()
	})
})
