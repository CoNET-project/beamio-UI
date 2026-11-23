/**
 * The local voice marker (`voiceVerified`) is written only by the ingestion gate (v70 §77). A history copy, a merge and a
 * backfill strip it, so history can never mark a row.
 */
jest.mock('./chatWorkerBridge', () => ({ appendWorkerHistory: jest.fn() }))

import { mergeHistoryEntriesIntoMessages, withoutLocalVoiceMarker } from './chatHistoryMirror'

const body = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ id: 'h-1', from: 'them', text: '{"type":"voice_end_v1"}', createdAt: 1700000000000, status: 'sent', ...over })

describe('history never carries the voice marker (v70 §77)', () => {
	test('a history body with voiceVerified:true is merged without the marker', () => {
		const out = mergeHistoryEntriesIntoMessages([], [{ body: body({ voiceVerified: true }), dir: 'in', ts: 1700000000000 } as never])
		expect(out.added).toBe(1)
		expect(out.messages[0]).not.toHaveProperty('voiceVerified')
	})
	test('a history row without the marker stays unmarked', () => {
		const out = mergeHistoryEntriesIntoMessages([], [{ body: body(), dir: 'in', ts: 1700000000000 } as never])
		expect(out.messages[0]).not.toHaveProperty('voiceVerified')
	})
	test('the strip helper removes only the marker and does not mutate the input', () => {
		const original = { id: 'x', text: 'y', voiceVerified: true }
		const stripped = withoutLocalVoiceMarker(original)
		expect(stripped).toEqual({ id: 'x', text: 'y' })
		expect(original.voiceVerified).toBe(true)
	})
	test('an existing marked local row is kept as it is (merge only strips what it copies)', () => {
		const local = [{ id: 'l-1', from: 'them', text: 't', createdAt: 1, voiceVerified: true } as never]
		const out = mergeHistoryEntriesIntoMessages(local, [])
		expect(out.messages[0]).toHaveProperty('voiceVerified', true)
	})
})
