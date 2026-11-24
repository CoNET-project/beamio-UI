/**
 * @jest-environment node
 */
import { parseIdentityPublicResult } from './nativeIdentityPublic'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const base = { eoa: EOA, accountKey: `${EOA}:default` }

describe('identityPublic: pgpReadyKnown', () => {
	it('pgpReady false with pgpReadyKnown false keeps the flag (unknown)', () => {
		expect(parseIdentityPublicResult({ ...base, pgpReady: false, pgpReadyKnown: false })).toEqual({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false, pgpReadyKnown: false })
	})
	it('pgpReady false without the field, or with true, is the plain "false" as before', () => {
		const plain = { kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false }
		expect(parseIdentityPublicResult({ ...base, pgpReady: false })).toEqual(plain)
		expect(parseIdentityPublicResult({ ...base, pgpReady: false, pgpReadyKnown: true })).toEqual(plain)
		expect(parseIdentityPublicResult({ ...base, pgpReady: false, pgpReadyKnown: 'no' })).toEqual(plain)
	})
	it('the other validations are unchanged: a bad eoa or a non-boolean pgpReady is bad_identity', () => {
		expect(parseIdentityPublicResult({ eoa: 'x', accountKey: 'a', pgpReady: false, pgpReadyKnown: false })).toEqual({ kind: 'bad_identity' })
		expect(parseIdentityPublicResult({ ...base, pgpReady: 'yes', pgpReadyKnown: false })).toEqual({ kind: 'bad_identity' })
	})
})

describe('identityPublic Ready: the three armors (frozen protocol v1 §3)', () => {
	const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxsBNBGsynthetic\n-----END PGP PUBLIC KEY BLOCK-----'
	const ready = { eoa: EOA, accountKey: `${EOA}:default`, pgpReady: true, pgpKeyID: 'syn-key-1', pgpPublicKeyArmored: ARMOR, ownRouteArmoredPublicKey: ARMOR }
	it('all three present: ok with pgpReady true', () => {
		expect(parseIdentityPublicResult(ready)).toMatchObject({ kind: 'ok', pgpReady: true, pgpKeyID: 'syn-key-1' })
	})
	it('an older shell that sends pgpReady true without the route armor (or the key ID) is not read as ready: bad_identity, never a half identity', () => {
		expect(parseIdentityPublicResult({ ...ready, ownRouteArmoredPublicKey: '' })).toEqual({ kind: 'bad_identity' })
		expect(parseIdentityPublicResult({ ...ready, ownRouteArmoredPublicKey: undefined })).toEqual({ kind: 'bad_identity' })
		expect(parseIdentityPublicResult({ ...ready, pgpKeyID: '' })).toEqual({ kind: 'bad_identity' })
	})
	it('an older shell that sends only pgpReady false and no armor stays the plain "false" (evaluate as before)', () => {
		expect(parseIdentityPublicResult({ eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false })).toEqual({ kind: 'ok', eoa: EOA, accountKey: `${EOA}:default`, pgpReady: false })
	})
})
