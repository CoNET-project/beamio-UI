/**
 * getAccount classification: only the AccountNotFound() revert is "no record"; every other failure is a lookup failure.
 * The deprecated rpc-old registry is no longer referenced by the service.
 */
import fs from 'fs'
import path from 'path'
import { ethers } from 'ethers'
import { isAccountNotFoundError } from './accountLookupErrors'

/** Offline encoding probe: the registry ABI in the repo must encode and decode AccountNotFound() exactly as the revert would carry it. */
const registryAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'ABI', 'beamio-AccountRegistry.json'), 'utf8'))

describe('AccountNotFound classification', () => {
	const selector = ethers.id('AccountNotFound()').slice(0, 10)

	it('treats a decoded AccountNotFound revert as no record', () => {
		expect(isAccountNotFoundError({ revert: { name: 'AccountNotFound' } })).toBe(true)
	})

	it('treats a raw AccountNotFound() revert payload as no record', () => {
		expect(isAccountNotFoundError({ data: selector })).toBe(true)
		expect(isAccountNotFoundError({ error: { data: selector + '0'.repeat(64) } })).toBe(true)
	})

	it('encodes and decodes AccountNotFound() from the repo ABI (offline, not a chain probe)', () => {
		const iface = new ethers.Interface(registryAbi)
		const data = iface.encodeErrorResult('AccountNotFound', [])
		expect(data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true)
		expect(iface.parseError(data)?.name).toBe('AccountNotFound')
		expect(isAccountNotFoundError({ data })).toBe(true)
	})

	it('does not treat a timeout, a network error or another revert as no record', () => {
		expect(isAccountNotFoundError(new Error('registry_read_timeout'))).toBe(false)
		expect(isAccountNotFoundError(new Error('could not detect network'))).toBe(false)
		expect(isAccountNotFoundError({ revert: { name: 'SomeOtherError' } })).toBe(false)
		expect(isAccountNotFoundError({ data: '0x12345678' })).toBe(false)
		expect(isAccountNotFoundError(null)).toBe(false)
	})

	it('no longer references the deprecated rpc-old registry in the service', () => {
		const source = fs.readFileSync(path.join(__dirname, 'beamio.ts'), 'utf8')
		expect(source).not.toMatch(/rpc-old\.conet\.network/)
		expect(source).not.toMatch(/legacyBeamioAccountSC/)
		expect(source).not.toMatch(/LEGACY_ACCOUNT_REGISTRY/)
	})
})
