/**
 * the chain write of a new chat identity is a build-time switch. Only the QA build sets it to true; the production and store
 * builds keep it false. Tests read the decision function, the package.json build scripts, and the re-export the command path uses.
 */
import fs from 'fs'
import path from 'path'
import { pgpIdentityCreateEnabledFor, PGP_IDENTITY_CREATE_ENABLED } from './pgpIdentityCreateFlag'
import { PGP_IDENTITY_CREATE_ENABLED as FROM_COMMAND_PATH, nativeGenerateNewPgpKey } from '../services/nativePgpRestore'
import { grantPgpCreateEligibility } from '../services/pgpIdentityEligibility'

const ROOT = path.resolve(__dirname, '..', '..')
const scripts = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
const FLAG = 'REACT_APP_PGP_IDENTITY_CREATE_ENABLED'

describe('the decision (pgpIdentityCreateEnabledFor)', () => {
	it('a production build (flag not set) is false', () => {
		expect(pgpIdentityCreateEnabledFor(undefined)).toBe(false)
	})

	it('only the exact value "true" turns it on; anything else is false', () => {
		for (const raw of ['', 'false', '1', 'TRUE', 'True', 'yes', ' true']) {
			expect(pgpIdentityCreateEnabledFor(raw)).toBe(false)
		}
		expect(pgpIdentityCreateEnabledFor('true')).toBe(true)
	})
})

describe('the build scripts (production stays false, QA sets it)', () => {
	it.each(['build:react', 'build:embedded', 'build'])('%s (production) does not set the flag', (name) => {
		expect(scripts[name]).toBeDefined()
		expect(scripts[name]).not.toContain(FLAG)
	})

	it('build:qa-embedded sets the flag to true and builds the same embedded bundle as build:embedded', () => {
		expect(scripts['build:qa-embedded']).toContain(`${FLAG}=true`)
		expect(scripts['build:qa-embedded']).toContain('npm run build:embedded')
	})

	it('no script sets the flag to anything but true (no false or other value is set anywhere)', () => {
		for (const cmd of Object.values(scripts)) {
			if (cmd.includes(FLAG)) expect(cmd).toContain(`${FLAG}=true`)
		}
	})
})

describe('the command path reads the same switch', () => {
	it('the test run (no flag set) has the switch off', () => {
		expect(process.env[FLAG]).toBeUndefined()
		expect(PGP_IDENTITY_CREATE_ENABLED).toBe(false)
		expect(FROM_COMMAND_PATH).toBe(PGP_IDENTITY_CREATE_ENABLED)
	})

	it('without the first-identity eligibility the create call is refused before any command is sent (first-identity rule)', async () => {
		await expect(nativeGenerateNewPgpKey('0x' + '11'.repeat(20))).resolves.toEqual({ ok: false, reason: 'not_eligible' })
	})

	it('with the eligibility and the switch off, the create call is refused as not_enabled before any command is sent', async () => {
		grantPgpCreateEligibility('0x' + '11'.repeat(20))
		await expect(nativeGenerateNewPgpKey('0x' + '11'.repeat(20))).resolves.toEqual({ ok: false, reason: 'not_enabled' })
	})
})
