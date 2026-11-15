/**
 * The route key is omitted when absent, and a present key must be PGP armor. SYNTHETIC values.
 */
import { assertPublicIdentity, publicIdentityFields } from './identityPayload'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PGP = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC-PUBLIC-ONLY\n-----END PGP PUBLIC KEY BLOCK-----'

describe('the route key is omitted, never sent as an empty string', () => {
	it('an absent route key is not a key in the payload', () => {
		expect(Object.keys(publicIdentityFields({ eoaAddress: EOA, ownRouteArmoredPublicKey: '' }))).toEqual(['eoa'])
		expect(Object.keys(publicIdentityFields({ eoaAddress: EOA }))).toEqual(['eoa'])
	})

	it('a present route key is sent as given (PGP armor)', () => {
		expect(publicIdentityFields({ eoaAddress: EOA, ownRouteArmoredPublicKey: PGP })).toEqual({ eoa: EOA, ownRouteArmoredPublicKey: PGP })
	})

	it('the guard accepts an identity without the route key', () => {
		expect(() => assertPublicIdentity({ identity: { eoa: EOA } }, 'init')).not.toThrow()
	})

	it('the guard refuses a route key that is not PGP public armor', () => {
		expect(() => assertPublicIdentity({ identity: { eoa: EOA, ownRouteArmoredPublicKey: 'synthetic-plain' } }, 'init')).toThrow(/bad_identity/)
	})
})
