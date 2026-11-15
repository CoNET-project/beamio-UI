/**
 * The SHA-256 used for history keys. Checked against the standard vectors and against node's crypto on text with
 * multi-byte characters. SYNTHETIC values only.
 */
import { createHash } from 'crypto'
import { sha256Hex, sha256OfText, utf8Bytes } from './sha256'

describe('sha256', () => {
	it('matches the standard FIPS 180-4 vectors', () => {
		expect(sha256OfText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
		expect(sha256OfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
		// A two-block message: node's own SHA-256 (the value checked against node in the next case, not a remembered vector).
		expect(sha256OfText('abcdbcdecdefdefghijklmnopqrstnopqrstu')).toBe(
			createHash('sha256').update('abcdbcdecdefdefghijklmnopqrstnopqrstu').digest('hex'),
		)
	})

	it('matches node crypto for lengths around the 55, 56, 63 and 64-byte padding boundaries', () => {
		for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 200]) {
			const text = 'x'.repeat(n)
			expect(sha256OfText(text)).toBe(createHash('sha256').update(text).digest('hex'))
		}
	})

	it('matches node crypto for multi-byte UTF-8 text', () => {
		const samples = ['中文消息', 'emoji 😀 mix', 'Ünïcödé — ✓', '{"text":"你好","from":"me"}']
		for (const text of samples) {
			expect(sha256OfText(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
		}
	})

	it('the byte encoding is UTF-8 (a 4-byte character is four bytes)', () => {
		expect(Array.from(utf8Bytes('a€😀'))).toEqual([0x61, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80])
	})

	it('takes bytes directly', () => {
		expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	})
})
