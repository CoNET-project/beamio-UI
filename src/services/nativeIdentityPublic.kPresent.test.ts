/**
 * Y.90 kPresent (LS-01): the top-level field of an ok:false no_key answer, read only with identity.kpresent.v1.
 * Missing or non-boolean is absent (undetermined, so never confirmed none). An old shell without the capability is absent.
 */
import { IDENTITY_KPRESENT_CAPABILITY, kPresentFromNoKeyAnswer } from './nativeIdentityPublic'

const CAPS = [IDENTITY_KPRESENT_CAPABILITY]

describe('kPresent from a no_key answer (Y.90)', () => {
	it('false with the capability declared is false', () => {
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key', kPresent: false }, CAPS)).toBe(false)
	})

	it('true with the capability declared is true', () => {
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key', kPresent: true }, CAPS)).toBe(true)
	})

	it('missing is absent (never false)', () => {
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key' }, CAPS)).toBeUndefined()
	})

	it('non-boolean is absent (never false)', () => {
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key', kPresent: 'false' }, CAPS)).toBeUndefined()
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key', kPresent: 0 }, CAPS)).toBeUndefined()
	})

	it('without the capability declared, kPresent is ignored (absent)', () => {
		expect(kPresentFromNoKeyAnswer({ type: 'ack', ok: false, error: 'no_key', kPresent: false }, [])).toBeUndefined()
	})

	it('a null payload is absent', () => {
		expect(kPresentFromNoKeyAnswer(null, CAPS)).toBeUndefined()
	})
})
