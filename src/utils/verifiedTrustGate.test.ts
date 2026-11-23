/**
 * @jest-environment node
 */
/**
 * BCHAT section 40 (R87): the held "Verify and send" sequence and the stored-trust gate. Real key fixtures (openpgp) and the real
 * resolveTrustedRoute / sendWithFreshRoute; the page wiring is checked by a static test. SYNTHETIC keys only.
 */
import { generateKey } from 'openpgp'
import { fingerprintOfArmor, resolveTrustedRoute, sendWithFreshRoute } from './recipientPublicKey'
import { gateChatFromStore, nextMemoryTrustWriter, verifyModeDecision } from './verifiedTrustGate'
import { storedKeyFingerprint } from './pgpFingerprint'

const ADDRESS = '0x3333333333333333333333333333333333333333'
let KEY_A = ''
let KEY_B = ''
let FP_A = ''
let FP_B = ''

beforeAll(async () => {
	KEY_A = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'a' }], format: 'armored' })).publicKey.trim()
	KEY_B = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'b' }], format: 'armored' })).publicKey.trim()
	FP_A = await fingerprintOfArmor(KEY_A)
	FP_B = await fingerprintOfArmor(KEY_B)
}, 60_000)

const fetchOf = (key: string) => jest.fn(async () => ({ status: 'ok' as const, publicArmored: key, routersArmoreds: 'route-1', routePgpKeyID: 'r1' }))
/** The memory copy as the page holds it, with a verified fingerprint that the stored copy may not have. */
const memoryChat = (verifiedFp?: string) => ({
	address: ADDRESS,
	chatData: {
		publicArmored: KEY_A,
		routersArmoreds: 'route-1',
		keyFingerprint: storedKeyFingerprint(FP_A),
		verifiedFingerprint: verifiedFp ? storedKeyFingerprint(verifiedFp) : undefined,
	},
})

/** The sequence of BCHAT 40: held-rebuild, held-retry(fresh, pinned=false), trust-write(trusted=false, verified=true), then the send. */
async function sendAttempt(chat: ReturnType<typeof memoryChat>, storedVerified: string | null, mode: 'fresh' | 'verify', hasPinned: boolean) {
	const gate = gateChatFromStore(chat, storedVerified)
	const trust = await resolveTrustedRoute(gate, fetchOf(KEY_A))
	const code = trust.ok ? 'ok' : trust.code === 'first_fetch_pending' ? 'first_fetch_pending' : 'other'
	if (verifyModeDecision({ mode, hasPinned, trust: code }) === 'open_panel') return { panel: true as const, sent: false }
	const send = jest.fn(async () => true)
	await sendWithFreshRoute(gate, 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_A), send })
	return { panel: false as const, sent: send.mock.calls.length > 0 }
}

describe('the held "Verify and send" after a reload (BCHAT 40)', () => {
	it('the reproduced sequence: memory has a verified fingerprint, storage has none: no send, the verify panel opens', async () => {
		const r = await sendAttempt(memoryChat(FP_A), null, 'verify', false)
		expect(r).toEqual({ panel: true, sent: false })
	})

	it('the stored trust is the only trust: a memory-only fingerprint sends nothing through the fresh gate', async () => {
		const send = jest.fn(async () => true)
		const gate = gateChatFromStore(memoryChat(FP_A), null)
		const res = await sendWithFreshRoute(gate, 'hi', 'pk', ['n'], { fetchKeys: fetchOf(KEY_A), send })
		expect(res).toMatchObject({ ok: false, code: 'first_fetch_pending' })
		expect(send).not.toHaveBeenCalled()
	})

	it('after "Verified, continue" the trust is stored: the held message is sent on the verified key', async () => {
		const r = await sendAttempt(memoryChat(FP_A), storedKeyFingerprint(FP_A), 'fresh', false)
		expect(r).toEqual({ panel: false, sent: true })
	})

	it('a stored fingerprint that differs from the key read now is fingerprint_changed: not sent', async () => {
		const gate = gateChatFromStore(memoryChat(), storedKeyFingerprint(FP_B))
		const trust = await resolveTrustedRoute(gate, fetchOf(KEY_A))
		expect(trust).toMatchObject({ ok: false, code: 'fingerprint_changed' })
	})

	it('a verify press with the key already on screen (pinned) is not a panel: it goes to the send path', () => {
		expect(verifyModeDecision({ mode: 'verify', hasPinned: true, trust: 'first_fetch_pending' })).toBe('send')
	})

	it('the trust writer label: a trust confirmation sets trust; a refresh of an existing value is carried; none without a value', () => {
		expect(nextMemoryTrustWriter('none', { trusted: true, hadVerified: false, hasVerified: true })).toBe('trust')
		expect(nextMemoryTrustWriter('none', { trusted: false, hadVerified: true, hasVerified: true })).toBe('carried')
		expect(nextMemoryTrustWriter('trust', { trusted: false, hadVerified: true, hasVerified: true })).toBe('trust')
		expect(nextMemoryTrustWriter('carried', { trusted: false, hadVerified: false, hasVerified: false })).toBe('none')
	})
})

describe('the held bubble follows the stored trust (BCHAT 43)', () => {
	const { heldBubble } = require('./verifiedTrustGate')
	const fp = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01'
	const stored = (x: string) => storedKeyFingerprint(x)

	it('no stored trust: Not verified yet', () => {
		expect(heldBubble({ sendFingerprint: fp, storedVerified: null, storedKeyFingerprint: stored })).toBe('first_fetch_pending')
	})

	it('stored trust for the same key: the bubble offers the send again, not Not verified yet', () => {
		expect(heldBubble({ sendFingerprint: fp, storedVerified: stored(fp), storedKeyFingerprint: stored })).toBe('trusted_resend')
	})

	it('stored trust for another key: a changed key', () => {
		expect(heldBubble({ sendFingerprint: fp, storedVerified: stored('1111'), storedKeyFingerprint: stored })).toBe('fingerprint_changed')
	})
})

describe('the gate copy helper (R90)', () => {
	const { gateCopyWithStore } = require('./verifiedTrustGate')
	it('a memory-only fingerprint is not trust: the gate copy has none, the trace says memory only', () => {
		const { gate, trace } = gateCopyWithStore(memoryChat(FP_A), null, 'trust')
		expect(gate.chatData.verifiedFingerprint).toBeUndefined()
		expect(trace).toEqual({ memory: true, stored: false, memWriter: 'trust' })
	})
	it('the stored value is the gate value', () => {
		const { gate } = gateCopyWithStore(memoryChat(), storedKeyFingerprint(FP_A), 'none')
		expect(gate.chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP_A))
	})
})
