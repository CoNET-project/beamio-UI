import {
	INBOUND_DEDUPE_MARKER_MAX,
	addDedupeMarkers,
	hasDedupeMarker,
	normalizeArmorHash,
} from './inboundDedupeMarkers'

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

describe('inbound dedupe markers', () => {
	it('keeps only canonical armor hashes', () => {
		expect(normalizeArmorHash(`  ${hash(255).toUpperCase().replace('0X', '0x')} `)).toBe(hash(255))
		expect(normalizeArmorHash('0x1234')).toBe('')
		expect(normalizeArmorHash('{"text":"a body"}')).toBe('')
		expect(normalizeArmorHash(undefined)).toBe('')
	})

	it('adds markers in order and skips duplicates', () => {
		const out = addDedupeMarkers([hash(1)], [hash(2), hash(2), hash(3)])
		expect(out).toEqual([hash(1), hash(2), hash(3)])
	})

	it('a hash seen again moves to the newest place', () => {
		expect(addDedupeMarkers([hash(1), hash(2)], [hash(1)])).toEqual([hash(2), hash(1)])
	})

	it('drops values that are not armor hashes, so no body is ever stored', () => {
		const out = addDedupeMarkers(undefined, ['{"type":"voice_end_v1"}', hash(9), ''])
		expect(out).toEqual([hash(9)])
	})

	it('caps the list and drops the oldest markers first', () => {
		const many = Array.from({ length: INBOUND_DEDUPE_MARKER_MAX + 3 }, (_, i) => hash(i + 1))
		const out = addDedupeMarkers(undefined, many)
		expect(out).toHaveLength(INBOUND_DEDUPE_MARKER_MAX)
		expect(out[0]).toBe(hash(4))
		expect(out[out.length - 1]).toBe(hash(INBOUND_DEDUPE_MARKER_MAX + 3))
	})

	it('finds a marker by its canonical hash only', () => {
		const markers = [hash(7)]
		expect(hasDedupeMarker(markers, hash(7).toUpperCase().replace('0X', '0x'))).toBe(true)
		expect(hasDedupeMarker(markers, hash(8))).toBe(false)
		expect(hasDedupeMarker(markers, 'not-a-hash')).toBe(false)
		expect(hasDedupeMarker(undefined, hash(7))).toBe(false)
	})
})
