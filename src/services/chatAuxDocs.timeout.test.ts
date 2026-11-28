/**
 * @jest-environment node
 */
// A read of the reset summary that never answers must not leave the reset button disabled for good.
import { canConfirmReset, readUnsentSummary } from './chatAuxDocs'

const never = <T,>() => new Promise<T>(() => undefined)
it.each([
	['the unarchived count', () => readUnsentSummary({ list: async () => [] }, never, 20), { unarchived: 'unknown', unknown: false }],
	['the document listing', () => readUnsentSummary({ list: never }, async () => 0, 20), { unarchived: 0, unknown: true }],
])('%s hangs: it is reported as unknown, and the reset needs the second confirmation and nothing more', async (_n, read, expected) => {
	const summary = await read()
	expect(summary).toMatchObject(expected)
	expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: false, summary, busy: false })).toBe(false)
	expect(canConfirmReset({ confirmGeneric: true, confirmUnsent: true, summary, busy: false })).toBe(true)
})
