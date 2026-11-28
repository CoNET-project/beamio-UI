/**
 * @jest-environment node
 */
// how an entry answer is read (sendAnswer.ts), what it lets the queue do (sendReceiptPolicy.ts), and that the armor of a sendId is reused, never encrypted again.
import fs from 'fs'
import path from 'path'
import { ethers } from 'ethers'
import { createMessage, encrypt, generateKey, readKey } from 'openpgp'
import { armorDigest, armorMatchesRecipient, asPgpMessageArmor, classifySendAnswer, hashPgpArmorText } from './sendAnswer'
import vectors from './postAckHashVectors.json'
import { decideReceipt } from './sendReceiptPolicy'
import { createQueueStore, createSendQueue, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { base64JsonCodec } from './chatDraftStore'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const ARMOR = '-----BEGIN PGP MESSAGE-----\nfake\n-----END PGP MESSAGE-----'
const DIGEST = armorDigest(ARMOR)

describe('the digest h: the shared vectors, and the trim the node applies first', () => {
	it('the 8 shared vectors (the TS and Rust nodes check the same file): keccak256 of the string as given', () => {
		expect(vectors.vectors).toHaveLength(8)
		for (const v of vectors.vectors) expect(hashPgpArmorText(v.input)).toBe(v.h)
		expect(hashPgpArmorText('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
	})
	it('the client digest is over the trimmed armor cut after the END marker: a trailing newline, blank lines or junk after the marker do not change it (vectors 2, 3, 5 and 6 are one armor)', () => {
		const v = vectors.vectors
		const clean = v[1].input
		expect(armorDigest(v[1].input)).toBe(v[1].h)
		expect(armorDigest(v[2].input)).toBe(v[1].h) // a trailing newline
		expect(armorDigest(v[4].input)).toBe(v[1].h) // two trailing newlines
		expect(armorDigest(v[5].input)).toBe(v[1].h) // text after the END marker is cut
		expect(asPgpMessageArmor(v[2].input)).toBe(clean)
		// mailbox work path: NO CRLF -> LF; the armor keeps its CR, only the outside is trimmed and the tail after the END marker is cut
		expect(asPgpMessageArmor(v[3].input)).toBe(v[3].input.trim())
		expect(asPgpMessageArmor(v[3].input)).toContain('\r\n')
		expect(armorDigest(v[3].input)).toBe(hashPgpArmorText(v[3].input.trim()))
		expect(armorDigest(v[3].input)).not.toBe(v[1].h) // not the digest of the LF form
		expect(armorDigest('-----BEGIN PGP MESSAGE-----\r\n\r\nwcFMA0\r\n=abcd\r\n-----END PGP MESSAGE-----\r\nafter\r\n')).toBe(hashPgpArmorText('-----BEGIN PGP MESSAGE-----\r\n\r\nwcFMA0\r\n=abcd\r\n-----END PGP MESSAGE-----'))
		// the raw string with its newline is NOT what the node hashes
		expect(hashPgpArmorText(v[2].input)).not.toBe(armorDigest(v[2].input))
	})
	it('not a PGP message armor: no trim result (null); the digest then falls back to the text itself', () => {
		expect(asPgpMessageArmor('plain text')).toBeNull()
		expect(asPgpMessageArmor('-----BEGIN PGP MESSAGE-----\nno end')).toBeNull()
		expect(armorDigest('plain text')).toBe(hashPgpArmorText('plain text'))
	})
	it('stored and duplicate are both a positive receipt for the same digest (duplicate only means it is still kept; after the recipient\'s ACK a retry answers stored)', () => {
		expect(classifySendAnswer(JSON.stringify({ ok: true, stored: true, h: DIGEST }), DIGEST)).toBe('bound')
		expect(classifySendAnswer(JSON.stringify({ ok: true, duplicate: true, h: DIGEST }), DIGEST)).toBe('bound')
		// store_failed is not positive, and an answer without h from an old node is not either
		expect(classifySendAnswer(JSON.stringify({ ok: false, error: 'store_failed' }), DIGEST)).toBe('reject')
		expect(classifySendAnswer(JSON.stringify({ ok: true, stored: true }), DIGEST)).toBe('reject')
	})
})

describe('classifySendAnswer: one answer of the entry', () => {
	it('an empty body is the legacy answer: transport acceptance only', () => {
		expect(classifySendAnswer('', DIGEST)).toBe('legacy_empty')
		expect(classifySendAnswer('  \n ', DIGEST)).toBe('legacy_empty')
	})
	it('a body that could not be read (null) is unknown, never an empty body and never a receipt', () => {
		expect(classifySendAnswer(null, DIGEST)).toBe('reject')
	})
	it('{"ok":true,"stored":true,"h":digest of THIS armor} is a bound receipt (case of the hex does not matter)', () => {
		expect(classifySendAnswer(JSON.stringify({ ok: true, stored: true, h: DIGEST }), DIGEST)).toBe('bound')
		expect(classifySendAnswer(JSON.stringify({ ok: true, stored: true, h: DIGEST.toUpperCase().replace('0X', '0x') }), DIGEST)).toBe('bound')
	})
	it('another message\'s digest, no digest, ok:false, ok missing, and bodies that are not ours are all rejected', () => {
		const other = ethers.keccak256(ethers.toUtf8Bytes('another armor'))
		expect(classifySendAnswer(JSON.stringify({ ok: true, h: other }), DIGEST)).toBe('reject') // an unrelated receipt
		expect(classifySendAnswer(JSON.stringify({ ok: true }), DIGEST)).toBe('reject')
		expect(classifySendAnswer(JSON.stringify({ ok: false, error: 'no_route' }), DIGEST)).toBe('reject')
		expect(classifySendAnswer(JSON.stringify({ ok: false, h: DIGEST }), DIGEST)).toBe('reject')
		expect(classifySendAnswer(JSON.stringify({ h: DIGEST }), DIGEST)).toBe('reject')
		expect(classifySendAnswer('<html>502 Bad Gateway</html>', DIGEST)).toBe('reject')
		expect(classifySendAnswer('"ok"', DIGEST)).toBe('reject')
		expect(classifySendAnswer('null', DIGEST)).toBe('reject')
		expect(classifySendAnswer('[]', DIGEST)).toBe('reject')
	})
	it('a duplicate answer (the same digest again) is the same bound receipt, not a second message', () => {
		const a = classifySendAnswer(JSON.stringify({ ok: true, stored: false, duplicate: true, h: DIGEST }), DIGEST)
		const b = classifySendAnswer(JSON.stringify({ ok: true, stored: true, h: DIGEST }), DIGEST)
		expect([a, b]).toEqual(['bound', 'bound'])
	})
})

describe('decideReceipt: the only way out is a bound receipt (or the recipient\'s delivery receipt, handled where the message turns delivered)', () => {
	it('bound -> confirmed; an empty 200 or no classification -> awaiting', () => {
		expect(decideReceipt({ kind: 'bound', digest: DIGEST })).toBe('confirmed')
		expect(decideReceipt({ kind: 'legacy_empty', digest: DIGEST })).toBe('awaiting')
		expect(decideReceipt(null)).toBe('awaiting')
	})
	it('there is no switch that relaxes it: no policy parameter, no env / URL / storage / remote-config read, no "release" mode in the source', () => {
		const src = fs.readFileSync(path.join(__dirname, 'sendReceiptPolicy.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
		expect(src).not.toMatch(/process\.env|location|URLSearchParams|localStorage|sessionStorage|fetch\(|window|import\.meta|release/i)
		expect(decideReceipt.length).toBe(1) // one parameter: the receipt
		expect(src).not.toMatch(/LEGACY_EMPTY|policy/i)
		// the whole client source: nothing outside the tests names such a switch
		const root = path.join(__dirname, '..')
		const hits: string[] = []
		const walk = (d: string) => {
			for (const f of fs.readdirSync(d)) {
				const p = path.join(d, f)
				if (fs.statSync(p).isDirectory()) walk(p)
				else if (/\.(ts|tsx|js)$/.test(f) && !/\.test\./.test(f)) {
					const t = fs.readFileSync(p, 'utf8')
					if (/LEGACY_EMPTY_RECEIPT_POLICY|acceptLegacyEmpty|legacyEmptyReceipt/.test(t)) hits.push(p)
				}
			}
		}
		walk(root)
		expect(hits).toEqual([])
	})
	it('chat.tsx lets go of an item only through decideReceipt or the delivered status, never on "sent" alone', () => {
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const decision = await releaseDecisionOf\(\{ sendId: proofSid, peer: String\(chatData\.address \|\| ''\), receipt, evidence: receiptStoreRef\.current \}\)/)
		expect(chat).toMatch(/decision === 'confirmed' \? \{ kind: 'sent', persisted \} : \{ kind: 'awaiting', persisted \}/)
		// a delivered message is let go only after its delivered mark is durable (markDeliveredDurable), and then only with the sender's copy persisted
		expect(chat).not.toMatch(/if \(m\.status === 'delivered'\) return \{ kind: 'sent'/) // the row status is no evidence: only the receipt releases (receiptRelease.test.ts)
		expect(chat).toMatch(/if \(m\.status === 'sent' \|\| m\.status === 'delivered'\) \{[\s\S]*?return deliverText\(m\.id as string, wire, Date\.now\(\)\)/)
	})
})

describe('armor reuse: a retry of the same sendId posts the first armor, never a second ciphertext', () => {
	it('armorMatchesRecipient: true for an armor encrypted to the recipient\'s key, false for another recipient, for garbage and for an empty string', async () => {
		const a = await generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'a' }], format: 'armored' })
		const b = await generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'b' }], format: 'armored' })
		const toA = await encrypt({ message: await createMessage({ text: 'hello' }), encryptionKeys: await readKey({ armoredKey: a.publicKey }) })
		expect(await armorMatchesRecipient(toA, a.publicKey)).toBe(true)
		expect(await armorMatchesRecipient(toA, b.publicKey)).toBe(false) // the recipient's key changed: a new armor must be made
		expect(await armorMatchesRecipient('garbage', a.publicKey)).toBe(false)
		expect(await armorMatchesRecipient('', a.publicKey)).toBe(false)
	}, 30000)

	function memoryDisk() {
		const docs = new Map<string, string>()
		const adapter: QueueDocAdapter = {
			read: async (id) => docs.get(id) ?? null,
			put: async (id, text) => { docs.set(id, text) },
			remove: async (id) => { docs.delete(id) },
			list: async (prefix) => [...docs.keys()].filter((k) => k.startsWith(prefix)),
		}
		return { docs, adapter }
	}
	const EOA = '0xaaaa000000000000000000000000000000000001'
	const item: QueueItem = { v: 1, sendId: 's1', peer: '0xcccc000000000000000000000000000000000003', text: 'x', createdAt: 1, queuedAt: 1 }

	it('the first attempt stores the armor and its digest in the item\'s own document BEFORE any request; after a restart the retry finds it; a failed store means no armor and nothing to send', async () => {
		const disk = memoryDisk()
		const mk = () => createSendQueue({ store: createQueueStore({ eoa: EOA, doc: disk.adapter, codec: base64JsonCodec() }), peer: item.peer, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true })
		const q1 = mk()
		await q1.enqueue(item)
		expect(q1.armorOf('s1')).toBeUndefined()
		await q1.recordArmor('s1', ARMOR, DIGEST)
		expect(q1.armorOf('s1')).toBe(ARMOR)
		q1.dispose()
		const q2 = mk() // a restart
		const [loaded] = await q2.load()
		expect(loaded.armor).toBe(ARMOR)
		expect(loaded.armorDigest).toBe(DIGEST)
		expect(q2.armorOf('s1')).toBe(ARMOR)
		// the stored copy is the same document (an upsert), not a second one
		expect([...disk.docs.keys()]).toHaveLength(1)
	})

	it('a failed store of the armor rejects and leaves the item as it was', async () => {
		let fail = false
		const docs = new Map<string, string>()
		const adapter: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { if (fail) throw new Error('persist_failed'); docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
		const q = createSendQueue({ store: createQueueStore({ eoa: EOA, doc: adapter, codec: base64JsonCodec() }), peer: item.peer, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true })
		await q.enqueue(item)
		fail = true
		await expect(q.recordArmor('s1', ARMOR, DIGEST)).rejects.toThrow('persist_failed')
		expect(q.armorOf('s1')).toBeUndefined()
	})

	it('sendMessage posts the stored armor when it matches the recipient and stores a freshly made one before the first request (source wiring)', () => {
		const src = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
		expect(src).toMatch(/const storedArmor = opts\?\.armor\?\.armor\s*if \(storedArmor && \(await armorMatchesRecipient\(storedArmor, pgpPublic\)\)\) \{[\s\S]*?postData = storedArmor/)
		expect(src).toMatch(/await opts\.armor\.record\(postData, postDigest\)[\s\S]*?armor could not be stored; not sent/)
		// the record call sits before the wrap and the POST loop
		expect(src.indexOf('await opts.armor.record(postData, postDigest)')).toBeLessThan(src.indexOf('wrapArmorToMailboxWork(postData'))
		expect(src).toMatch(/const answer = await res\.text\(\)\.then\(\(t\) => t, \(\) => null\)\s*const verdict = classifySendAnswer\(answer, postDigest\)/)
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const got = await armorContextFor\(\{ rowSendId: \(messagesRef\.current \|\| \[\]\)\.find\(x => x\.id === tempId\)\?\.sendId, wire, queue: sendQueueRef\.current \}\)/)
		expect(chat).toMatch(/if \(armorUnreadable\) \{ lastSendCodeRef\.current = 'send_failed'; ok = false \} else ok = await sendChatToRecipient\(wire, \{ armor: armorCtx/)
		expect(chat).toMatch(/heldArmorUnreadable \? false : await sendChatToRecipient\(held\.text/)
	})
})
