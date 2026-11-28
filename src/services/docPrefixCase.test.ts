/**
 * @jest-environment node
 */
// `profiles[0].keyID` is not always the same spelling of the address (checksummed by the record sanitizer, lower case elsewhere, padded in a bad input). The three
// document families that are keyed by it (queue, receipt, delivered) must therefore build the SAME prefix for every spelling, in lower case, or one account would write into two families of documents. SYNTHETIC only.
import { readFileSync } from 'fs'
import { join } from 'path'
import { queueDocId, queueDocPrefix } from './sendQueue'
import { receiptDocId, receiptDocPrefix } from './receiptEvidence'
import { deliveredDocPrefix } from './deliveredMarks'
import { docTaggerFor } from './sendQueueCodec'

const LOWER = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const MIXED = '0x39581C72b8C7d0DE85ff22Cf3ae178aE813957AA'
const UPPER = '0x' + LOWER.slice(2).toUpperCase()
const PADDED = `  ${MIXED}\n`
const SPELLINGS = [LOWER, MIXED, UPPER, PADDED]
const ARMOR = '-----SYNTHETIC TAG KEY ARMOR-----'
const PEER = '0x2222222222222222222222222222222222222222'

describe('the prefix of the queue, receipt and delivered documents does not depend on how the keyID is spelled', () => {
	it('every spelling gives the same lower-case prefix in each of the three families', () => {
		for (const f of [queueDocPrefix, receiptDocPrefix, deliveredDocPrefix]) {
			const prefixes = new Set(SPELLINGS.map((s) => f(s)))
			expect(prefixes.size).toBe(1)
			const only = [...prefixes][0]
			expect(only).toBe(only.toLowerCase())
			expect(only.endsWith(`:${LOWER}:`)).toBe(true)
		}
	})
	it('the three families differ only by their own label (the same account part), so one spelling can never split an account across them', () => {
		const q = queueDocPrefix(MIXED)
		const r = receiptDocPrefix(MIXED)
		const d = deliveredDocPrefix(MIXED)
		expect([q, r, d].map((p) => p.slice(p.indexOf(':') + 1))).toEqual([`${LOWER}:`, `${LOWER}:`, `${LOWER}:`])
		expect([q, r, d].map((p) => p.slice(0, p.indexOf(':')))).toEqual(['chat-queue-v1', 'chat-receipt-v1', 'chat-delivered-v1'])
	})
	it('whole document ids agree too: the queue id and the receipt id of one message are the same for every spelling', () => {
		const sendId = '1767225600000-aaaa1111'
		const ids = SPELLINGS.map((s) => queueDocId(s, sendId))
		expect(new Set(ids).size).toBe(1)
		const t = docTaggerFor(ARMOR, LOWER)
		const rids = SPELLINGS.map((s) => receiptDocId(s, t, PEER, sendId))
		expect(new Set(rids).size).toBe(1)
	})
	it('the keyless tag key (a shell, or a browser before its key) is also spelling-independent; the keyed tag does not use the address at all', () => {
		const keyless = SPELLINGS.map((s) => docTaggerFor('', s).peerTag(PEER))
		expect(new Set(keyless).size).toBe(1)
		const keyed = SPELLINGS.map((s) => docTaggerFor(ARMOR, s).peerTag(PEER))
		expect(new Set(keyed).size).toBe(1)
		expect(docTaggerFor(ARMOR, LOWER).peerTag(PEER)).not.toBe(docTaggerFor('', LOWER).peerTag(PEER))
	})
	it('the page passes the SAME lower-case account to the three stores (no raw keyID reaches a prefix): chat.tsx lowercases it once for the queue, the receipts and the delivered marks', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const eoa = String\(profiles\?\.\[0\]\?\.keyID \|\| ''\)\.trim\(\)\.toLowerCase\(\)/)
		const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toMatch(/const eoaNow = String\(\(CoNET_Data as \{ profiles\?: Array<\{ keyID\?: string \}> \} \| undefined\)\?\.profiles\?\.\[0\]\?\.keyID \|\| ''\)\.toLowerCase\(\)/)
	})
})
