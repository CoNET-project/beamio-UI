/**
 * @jest-environment node
 */
// the recipient refresh asks for a FRESH chain check only for a first contact (no pinned value). SYNTHETIC values.
import { refreshRecipient, resolveTrustedRoute, sendWithFreshRoute, type RecipientLookup } from './recipientPublicKey'
import { storedKeyFingerprint } from './pgpFingerprint'
import { generateKey } from 'openpgp'

const CONTACT = '0x' + 'ab12'.repeat(10)
let KEY = ''
beforeAll(async () => {
	KEY = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })).publicKey.trim()
}, 60_000)

const ok = (): RecipientLookup => ({ status: 'ok', publicArmored: KEY, routersArmoreds: 'route-1', routePgpKeyID: 'r1', userPgpKeyID: 'x' })
const fetchSpy = () => jest.fn(async (_a: string, _o?: { freshChain?: boolean }): Promise<RecipientLookup> => ok())
const FP = 'a'.repeat(40)

describe('first contact asks for a fresh chain check; a pinned contact does not', () => {
	it('no pinned value: the reader is told freshChain (refresh, trusted route, text send)', async () => {
		const f = fetchSpy()
		await refreshRecipient({ address: CONTACT, chatData: {} }, f)
		await resolveTrustedRoute({ address: CONTACT, chatData: {} }, f)
		await sendWithFreshRoute({ address: CONTACT, chatData: {} }, 'hi', 'pk', ['n'], { fetchKeys: f, send: jest.fn(async () => true) })
		expect(f).toHaveBeenCalledTimes(3)
		for (const call of f.mock.calls) expect(call[1]).toEqual({ freshChain: true })
	})
	it('a pinned contact: the plain call (the session answer serves), no freshChain', async () => {
		const f = fetchSpy()
		const chat = { address: CONTACT, chatData: { verifiedFingerprint: storedKeyFingerprint(FP) } }
		await refreshRecipient(chat, f)
		await resolveTrustedRoute(chat, f)
		for (const call of f.mock.calls) expect(call[1]).toBeUndefined()
		expect(f).toHaveBeenCalledTimes(2)
	})
	it('an old value without the OpenPGP scheme is no pin: still a first contact', async () => {
		const f = fetchSpy()
		await refreshRecipient({ address: CONTACT, chatData: { verifiedFingerprint: 'sha256:' + 'b'.repeat(64) } }, f)
		expect(f.mock.calls[0][1]).toEqual({ freshChain: true })
	})
	it('a fetcher that ignores the option still works (one-argument readers)', async () => {
		const oneArg = jest.fn(async (_a: string): Promise<RecipientLookup> => ok())
		expect((await refreshRecipient({ address: CONTACT, chatData: {} }, oneArg as never)).ok).toBe(true)
	})
})
