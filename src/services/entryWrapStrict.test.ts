/**
 * @jest-environment node
 *
 *  2.4 (2026-11-13): the outer entry wrap is strict. A wrap that cannot be made skips that
 * entry; the inner armor is never POSTed unwrapped; an entry without a PGP key is not a target.
 * Runs the SDK build (vendor/conet-chat-sdk/dist) and the real GossipCore.postToEntries path.
 */
import { createMessage, decrypt, encrypt, enums, generateKey, readKey, readMessage, readPrivateKey } from 'openpgp'
import {
	EntryWrapError,
	armorToString,
	hasEntryPgpKey,
	wrapArmorToEntryRoute,
	wrapWouldHitSameNode,
} from '@conet.project/chat-sdk'
import { GossipCore } from '../../vendor/conet-chat-sdk/dist/worker/gossip-core.js'
import {
	ReadableStream as NodeReadableStream,
	TransformStream as NodeTransformStream,
	WritableStream as NodeWritableStream,
} from 'stream/web'

// The zlib path of openpgp (used by the SDK) needs the web-stream globals; Node has them, the jest node env does not expose them.
{
	const g = globalThis as Record<string, unknown>
	g.ReadableStream ??= NodeReadableStream
	g.TransformStream ??= NodeTransformStream
	g.WritableStream ??= NodeWritableStream
}

type KeyPair = { publicArmored: string; privateArmored: string }

const newKey = async (name: string): Promise<KeyPair> => {
	const { privateKey, publicKey } = await generateKey({
		type: 'ecc',
		curve: 'curve25519Legacy',
		userIDs: [{ name }],
		format: 'armored',
	})
	return { publicArmored: publicKey, privateArmored: privateKey }
}

/** Inner armor as the sender builds it: encrypted to the recipient's user PGP key. */
const innerTo = async (recipientPublicArmored: string, text: string): Promise<string> => {
	const encryptionKeys = await readKey({ armoredKey: recipientPublicArmored })
	const message = await createMessage({ text })
	return armorToString(
		await encrypt({ message, encryptionKeys, config: { preferredCompressionAlgorithm: enums.compression.zlib } }),
	)
}

const decryptWith = async (armor: string, privateArmored: string): Promise<string> => {
	const { data } = await decrypt({
		message: await readMessage({ armoredMessage: armor }),
		decryptionKeys: await readPrivateKey({ armoredKey: privateArmored }),
		format: 'utf8',
	})
	return String(data)
}

const emit = {
	message: () => undefined,
	group: () => undefined,
	voiceFrame: () => undefined,
	voiceGap: () => undefined,
	voiceConflict: () => undefined,
	status: () => undefined,
	log: () => undefined,
	presence: () => undefined,
}

/** Core with `nodes` set and every POST recorded (domain and parsed body). */
const coreWith = (nodes: unknown[]) => {
	const posts: Array<{ domain: string; data: string }> = []
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const domain = String(url).replace(/^https?:\/\//, '').split('.')[0]
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as { data: string }
			posts.push({ domain, data: body.data })
		}
		return { ok: true, status: 200, text: async () => '{"ok":true}' } as unknown as Response
	}) as typeof fetch
	const core = new GossipCore(emit as never, (async () => {
		throw new Error('not used here')
	}) as never) as unknown as Record<string, unknown>
	core.cfg = { identity: { ownRouteArmoredPublicKey: '' }, runtime: { sendFanout: 3, outerWrap: false, reconnectBaseMs: 4000, reconnectMaxMs: 30000 } }
	core.nodes = nodes
	return { core, posts, restore: () => (globalThis.fetch = realFetch) }
}

const post = (core: Record<string, unknown>, inner: string) =>
	(core.postToEntries as (inner: string, exclude: Set<string>) => Promise<boolean>).call(core, inner, new Set<string>())

describe('hasEntryPgpKey', () => {
	it('is true only for an armored PGP public key', async () => {
		const k = await newKey('entry')
		expect(hasEntryPgpKey({ armoredPublicKey: k.publicArmored })).toBe(true)
		expect(hasEntryPgpKey({ armoredPublicKey: '' })).toBe(false)
		expect(hasEntryPgpKey({})).toBe(false)
		expect(hasEntryPgpKey(undefined)).toBe(false)
		expect(hasEntryPgpKey({ armoredPublicKey: 'not a key' })).toBe(false)
	})
})

describe('wrapArmorToEntryRoute (strict)', () => {
	it('returns an armor that only the entry key opens to the inner armor', async () => {
		const entry = await newKey('entry')
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'hello')
		const wrapped = await wrapArmorToEntryRoute(inner, entry.publicArmored)
		expect(wrapped).not.toBe(inner)
		expect(await decryptWith(wrapped, entry.privateArmored)).toBe(inner)
	})

	it('throws no_entry_key for an entry without a PGP key (never the inner armor)', async () => {
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'x')
		await expect(wrapArmorToEntryRoute(inner, '')).rejects.toMatchObject({ reason: 'no_entry_key' })
	})

	it('throws not_pgp when the input is not armor', async () => {
		const entry = await newKey('entry')
		await expect(wrapArmorToEntryRoute('plain text', entry.publicArmored)).rejects.toMatchObject({ reason: 'not_pgp' })
	})

	it('throws unsafe_route when the wrap would make the entry the inner key (same node)', async () => {
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'x')
		expect(await wrapWouldHitSameNode(inner, recipient.publicArmored)).toBe(true)
		await expect(wrapArmorToEntryRoute(inner, recipient.publicArmored)).rejects.toMatchObject({ reason: 'unsafe_route' })
	})

	it('the error is an EntryWrapError (callers can tell it from other failures)', async () => {
		await expect(wrapArmorToEntryRoute('x', '')).rejects.toBeInstanceOf(EntryWrapError)
	})
})

describe('GossipCore.postToEntries never posts the inner armor unwrapped', () => {
	it('skips an entry with no PGP key and wraps the one that has a key', async () => {
		const entry = await newKey('entry-b')
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'hello')
		const { core, posts, restore } = coreWith([
			{ domain: 'NOKEY', armoredPublicKey: '', ip_addr: '10.0.0.1', region: 'x', nftNumber: 0 },
			{ domain: 'ENTRYB', armoredPublicKey: entry.publicArmored, ip_addr: '10.0.0.2', region: 'x', nftNumber: 1 },
		])
		try {
			expect(await post(core, inner)).toBe(true)
		} finally {
			restore()
		}
		expect(posts.map((p) => p.domain)).toEqual(['ENTRYB'])
		expect(posts[0].data).not.toBe(inner)
		expect(await decryptWith(posts[0].data, entry.privateArmored)).toBe(inner)
	})

	it('posts nothing when the only entry cannot be wrapped (same node)', async () => {
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'hello')
		const { core, posts, restore } = coreWith([
			{ domain: 'SAMENODE', armoredPublicKey: recipient.publicArmored, ip_addr: '10.0.0.3', region: 'x', nftNumber: 2 },
		])
		try {
			expect(await post(core, inner)).toBe(false)
		} finally {
			restore()
		}
		expect(posts).toEqual([])
	})

	it('posts nothing when there are no entries at all', async () => {
		const recipient = await newKey('recipient')
		const inner = await innerTo(recipient.publicArmored, 'hello')
		const { core, posts, restore } = coreWith([])
		try {
			expect(await post(core, inner)).toBe(false)
		} finally {
			restore()
		}
		expect(posts).toEqual([])
	})
})
