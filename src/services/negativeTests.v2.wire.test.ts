/**
 * The PWA-observable cases of negative-tests-v2. The fixture is a byte copy; its `shellOrigin` is a fixture value and
 * reaches no build. The native-only cases (storage and passcode lock families, the native signing function, the log
 * scan, and the native domain tags) are not asserted here. Synthetic values only.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isTrustedBridgeSource } from '../bridge/bridgeSource'
import { WALLET_COMMANDS, walletCore } from './walletCore'
import { assertNoKeyMaterial, IDENTITY_FORBIDDEN_KEYS } from './identityPayload'

const RAW = readFileSync(join(__dirname, '__fixtures__', 'negative-tests-v2.json'))
const FIXTURE = JSON.parse(RAW.toString('utf8')) as {
	shellOrigin: string
	bridgeSource: { cases: { id: string; src: { isMainFrame: boolean; origin: string }; expect: boolean }[] }
	importPolicy: { forbiddenImportCommandNames: string[]; cases: { id: string; command: string; carriesKey: boolean }[] }
}

describe('negative-tests-v2: the fixture is the pinned byte copy', () => {
	it('its sha256 is the pinned value', () => {
		expect(createHash('sha256').update(RAW).digest('hex')).toBe(
			'86b836ef90586a665acfe1d935e5b3e10236a4cad07e7f93ef252ef4ef82aaef',
		)
	})
})

describe('negative-tests-v2: the bridge source rule (T-119 to T-control)', () => {
	it('each case is accepted or refused as the fixture expects, against the fixture origin', () => {
		for (const c of FIXTURE.bridgeSource.cases) {
			expect({ id: c.id, accepted: isTrustedBridgeSource(c.src, FIXTURE.shellOrigin) }).toEqual({ id: c.id, accepted: c.expect })
		}
	})
})

describe('negative-tests-v2: the import policy (T-127 to T-127d)', () => {
	it('no forbidden import command is on the wallet command list, and the retired transfer is not either', () => {
		for (const name of FIXTURE.importPolicy.forbiddenImportCommandNames) {
			expect(WALLET_COMMANDS).not.toContain(name)
		}
		expect(WALLET_COMMANDS).not.toContain('walletTransferOnce')
	})

	it('a payload that carries key material is refused before it is sent (init and provisionIdentity)', () => {
		const keyed = FIXTURE.importPolicy.cases.filter((c) => c.carriesKey && (c.command === 'init' || c.command === 'provisionIdentity'))
		expect(keyed.map((c) => c.command).sort()).toEqual(['init', 'provisionIdentity'])
		for (const c of keyed) {
			expect(() => assertNoKeyMaterial({ [IDENTITY_FORBIDDEN_KEYS[0]]: 'synthetic' }, c.command)).toThrow('key material refused')
		}
	})
})

describe('negative-tests-v2: the removed signing command (T-130-14)', () => {
	it('pgpSign is not on the command list, and it answers unknown_command while the wallet is locked', async () => {
		expect(WALLET_COMMANDS).not.toContain('pgpSign')
		await expect(walletCore.call({ command: 'pgpSign' } as never)).rejects.toMatchObject({ code: 'unknown_command' })
	})
})
