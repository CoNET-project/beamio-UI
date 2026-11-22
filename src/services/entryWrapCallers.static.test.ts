/**
 * @jest-environment node
 *
 *  2.4 (2026-11-13), read from the sources: no wrap bypass, no silent fallback to the inner
 * armor, no bare POST from the stored roster, and keyless entries are not targets.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

/** Body of an exported function, from its signature to the closing brace at column 0. */
const fnBody = (src: string, signature: string): string => {
	const at = src.indexOf(signature)
	if (at < 0) return ''
	const end = src.indexOf('\n}\n', at)
	return end < 0 ? src.slice(at) : src.slice(at, end + 3)
}

describe('SDK envelope: wrapArmorToEntryRoute is strict', () => {
	const envelope = read('vendor/conet-chat-sdk/src/envelope.ts')
	const body = fnBody(envelope, 'export async function wrapArmorToEntryRoute(')

	it('exists and is the only definition', () => {
		expect(body).not.toBe('')
		expect((envelope.match(/export async function wrapArmorToEntryRoute\(/g) || []).length).toBe(1)
	})

	it('never returns the inner armor as a fallback', () => {
		expect(body).not.toMatch(/return innerArmor/)
		expect(body).not.toMatch(/catch\s*\{\s*return/)
	})

	it('throws EntryWrapError for each refusal', () => {
		expect(body).toMatch(/throw new EntryWrapError\('no_entry_key'\)/)
		expect(body).toMatch(/throw new EntryWrapError\('not_pgp'\)/)
		expect(body).toMatch(/throw new EntryWrapError\('unsafe_route'\)/)
		expect(body).toMatch(/throw new EntryWrapError\('encrypt_failed', ex\)/)
	})
})

describe('SDK gossip core: every entry POST is wrapped; no outerWrap bypass', () => {
	const core = read('vendor/conet-chat-sdk/src/worker/gossip-core.ts')

	it('the outerWrap switch is gone from the send paths', () => {
		expect(core).not.toMatch(/outerWrap === false/)
		expect(core).not.toMatch(/\?\s*(innerArmor|inner)\s*:\s*await wrapArmorToEntryRoute/)
	})

	it('all wrap calls are awaited and their failure is not swallowed into the inner armor', () => {
		const calls = core.match(/wrapArmorToEntryRoute\(/g) || []
		const awaited = core.match(/await (?:withStepTimeout\()?wrapArmorToEntryRoute\(/g) || [] // the listen wrap runs under withStepTimeout
		// The import line names the function without a call; the calls are all awaited.
		expect(awaited.length).toBe(calls.length)
		expect(awaited.length).toBeGreaterThanOrEqual(7)
	})

	it('keyless entries are excluded from listen and query pools', () => {
		expect(core).toMatch(/const keyed = this\.nodes\.filter\(hasEntryPgpKey\)/)
		expect((core.match(/hasEntryPgpKey\(n\)/g) || []).length).toBeGreaterThanOrEqual(3)
	})
})

describe('PWA chat: no bare POST from the stored roster; keyless entries skipped', () => {
	const chat = read('src/services/chat.ts')
	const receipt = read('src/utils/chatDeliveryReceipt.ts')

	it('the legacy startGossip (unwrapped POST of a caller body) is removed', () => {
		expect(chat).not.toMatch(/^function startGossip\(/m)
		expect(chat).not.toMatch(/\bstartGossip\(/)
	})

	it('the query fallbacks wrap each target and never post the payload directly', () => {
		expect(chat).not.toMatch(/body: payload,/)
		expect((chat.match(/await wrapArmorToEntryRoute\(armored, node\.armoredPublicKey\)/g) || []).length).toBe(2)
		expect((chat.match(/hasEntryPgpKey\(n\)/g) || []).length).toBe(2)
	})

	it('the delivery receipt roster fallback wraps per entry and skips a failed wrap', () => {
		const fallback = receipt.slice(receipt.indexOf('const order = [...pool]'))
		expect(fallback).toMatch(/await wrapArmorToEntryRoute\(postData, node\.armoredPublicKey\)/)
		expect(fallback).toMatch(/body: JSON\.stringify\(\{ data: wrapped \}\)/)
		expect(fallback).not.toMatch(/body: payload/)
		expect(receipt).toMatch(/candidates = entryNodes\.filter\(n => !mailboxDomains\.has\(n\.domain\) && hasEntryPgpKey\(n\)\)/)
	})

	it('the consumer sendMessage keeps its mailbox wrap and still fails closed', () => {
		expect(chat).toMatch(/postData = await wrapArmorToMailboxWork\(postData, recipientRoute/)
		expect(chat).toMatch(/mailbox wrap Error![\s\S]{0,80}return false/)
	})
})
