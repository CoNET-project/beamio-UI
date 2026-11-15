/**
 * the page's forbidden names cover the whole CRED set . Before this change the
 * identity guard and the bridge guard together covered 7 of the 15 names. Each name is refused on the identity commands (provisionIdentity,
 * init shape) and by the bridge guard, at the top level and nested, in any letter case. SYNTHETIC values only.
 */
import { CRED_NAMES, findForbiddenKey, IDENTITY_FORBIDDEN_KEYS } from './identityPayload'
import { findKeyOverBridge } from './bridgeGuard'

/** The 15 names of.4 (the six of.4's first line and the nine it adds). */
const FIFTEEN_CRED_NAMES = [
	'privateKeyHex',
	'privateKeyArmored',
	'pgpPrivateKeyArmored',
	'pgpPassphrase',
	'walletPrivateKey',
	'mnemonic',
	'recoveryCode',
	'pin',
	'password',
	'accountPassword',
	'encrypKeyArmored',
	'privateKeyArmor',
	'privateKeyArmorWrap',
	'mnemonicPhrase',
	'recoveryWords',
]

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'

describe('the CRED set is complete', () => {
	it('every name of is in CRED_NAMES', () => {
		for (const name of FIFTEEN_CRED_NAMES) expect(CRED_NAMES).toContain(name)
	})

	it('the vector list is still a subset (the vector check is unchanged)', () => {
		for (const name of IDENTITY_FORBIDDEN_KEYS) expect(CRED_NAMES).toContain(name)
	})

	it('the 8 names the listed as missing are now covered', () => {
		for (const name of ['privateKeyArmored', 'recoveryCode', 'pin', 'password', 'accountPassword', 'encrypKeyArmored', 'privateKeyArmorWrap', 'recoveryWords']) {
			expect(CRED_NAMES).toContain(name)
		}
	})

	it('no name appears twice', () => {
		expect(new Set(CRED_NAMES.map((k) => k.toLowerCase())).size).toBe(CRED_NAMES.length)
	})
})

describe.each(FIFTEEN_CRED_NAMES)('the identity guard refuses the CRED name %s', (name) => {
	it('nested under identity (the init shape)', () => {
		expect(findForbiddenKey({ identity: { eoaAddress: EOA, [name]: 'synthetic' } })).toBe(name)
	})

	it('at the top level (the provisionIdentity shape), in upper case', () => {
		expect(findForbiddenKey({ eoa: EOA, [name.toUpperCase()]: 'synthetic' })).toBe(name.toUpperCase())
	})
})

describe.each(FIFTEEN_CRED_NAMES)('the bridge guard refuses the CRED name %s', (name) => {
	it('under a command, at depth', () => {
		expect(findKeyOverBridge({ type: 'chatCommand', payload: { nested: [{ [name]: 'synthetic' }] } })).toBe(name)
	})
})
