/**
 * SHA-256 (FIPS 180-4) over bytes, returned as lowercase hex. Written out here because the hash helpers in the app's libraries do not
 * accept the byte arrays of every runtime (the jest test realm, for one). Checked against the standard vectors and node's crypto in
 * sha256.test.ts. SYNTHETIC use only in the tests.
 */
const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
	0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
	0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
	0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
	0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
	0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

export function sha256Hex(data: Uint8Array): string {
	const bitLen = data.length * 8
	const padLen = Math.ceil((data.length + 9) / 64) * 64
	const buf = new Uint8Array(padLen)
	buf.set(data)
	buf[data.length] = 0x80
	const dv = new DataView(buf.buffer)
	dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000))
	dv.setUint32(padLen - 4, bitLen >>> 0)
	const H = H0.slice()
	const W = new Array<number>(64)
	for (let off = 0; off < padLen; off += 64) {
		for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4)
		for (let t = 16; t < 64; t++) {
			const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3)
			const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10)
			W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0
		}
		let a = H[0]
		let b = H[1]
		let c = H[2]
		let d = H[3]
		let e = H[4]
		let f = H[5]
		let g = H[6]
		let h = H[7]
		for (let t = 0; t < 64; t++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
			const ch = (e & f) ^ (~e & g)
			const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
			const maj = (a & b) ^ (a & c) ^ (b & c)
			const t2 = (S0 + maj) >>> 0
			h = g
			g = f
			f = e
			e = (d + t1) >>> 0
			d = c
			c = b
			b = a
			a = (t1 + t2) >>> 0
		}
		H[0] = (H[0] + a) >>> 0
		H[1] = (H[1] + b) >>> 0
		H[2] = (H[2] + c) >>> 0
		H[3] = (H[3] + d) >>> 0
		H[4] = (H[4] + e) >>> 0
		H[5] = (H[5] + f) >>> 0
		H[6] = (H[6] + g) >>> 0
		H[7] = (H[7] + h) >>> 0
	}
	return H.map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** The UTF-8 bytes of a text, encoded by hand (the same bytes as TextEncoder for valid text). */
export function utf8Bytes(text: string): Uint8Array {
	const out: number[] = []
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0
		if (cp < 0x80) out.push(cp)
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
		else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
		else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
	}
	return Uint8Array.from(out)
}

/** The SHA-256 of a text's UTF-8 bytes, as lowercase hex. */
export const sha256OfText = (text: string): string => sha256Hex(utf8Bytes(text))
