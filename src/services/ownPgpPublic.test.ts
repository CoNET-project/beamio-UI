/**
 * the account's own PGP public material is read with identityPublic in the shell. In the shell the record's
 * chatManager.pgpKey is never touched (a getter that throws proves it); the browser keeps its record.
 */
import { cachedOwnPgpPublic, loadOwnPgpPublicMaterial, shellPgpForServerRequest } from './ownPgpPublic'
import { readNativeIdentityPublic, shellOwnPgpPublicCached } from './nativeIdentityPublic'
import { isShellContext } from './shellContext'

jest.mock('./nativeIdentityPublic', () => ({
	readNativeIdentityPublic: jest.fn(),
	shellOwnPgpPublicCached: jest.fn(),
}))
jest.mock('./shellContext', () => ({ isShellContext: jest.fn() }))

const recordThatMustNotBeRead = (): unknown => {
	const profile = {}
	Object.defineProperty(profile, 'chatManager', {
		get() {
			throw new Error('the record chatManager was read in the shell')
		},
	})
	return profile
}

describe('own PGP public material', () => {
	beforeEach(() => {
		;(isShellContext as jest.Mock).mockReturnValue(true)
	})

	it('shell: the keyID and public armor come from identityPublic, and the record is not read', async () => {
		;(readNativeIdentityPublic as jest.Mock).mockResolvedValue({
			kind: 'ok',
			eoa: '0x' + '1'.repeat(40),
			accountKey: 'k',
			pgpReady: true,
			pgpKeyID: 'KID',
			pgpPublicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
			ownRouteArmoredPublicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
		})
		const out = await loadOwnPgpPublicMaterial(recordThatMustNotBeRead() as any)
		expect(out).toEqual({ keyID: 'KID', publicArmor: '-----BEGIN PGP PUBLIC KEY BLOCK-----' })
	})

	it('shell: not ready or unavailable gives an empty result, never the record', async () => {
		;(readNativeIdentityPublic as jest.Mock).mockResolvedValue({ kind: 'not_ready' })
		expect(await loadOwnPgpPublicMaterial(recordThatMustNotBeRead() as any)).toEqual({ keyID: '', publicArmor: '' })
		;(readNativeIdentityPublic as jest.Mock).mockResolvedValue({ kind: 'ok', eoa: '0x', accountKey: 'k', pgpReady: false })
		expect(await loadOwnPgpPublicMaterial(recordThatMustNotBeRead() as any)).toEqual({ keyID: '', publicArmor: '' })
	})

	it('shell: the synchronous read gives the last identityPublic answer, not the record', () => {
		;(shellOwnPgpPublicCached as jest.Mock).mockReturnValue({ keyID: 'CACHED', publicArmor: 'ARM' })
		expect(cachedOwnPgpPublic(recordThatMustNotBeRead() as any)).toEqual({ keyID: 'CACHED', publicArmor: 'ARM' })
	})

	it('browser: the record is the source (no native side)', async () => {
		;(isShellContext as jest.Mock).mockReturnValue(false)
		const profile = { chatManager: { pgpKey: { keyID: 'BK', publicKey: 'BP' } } }
		expect(await loadOwnPgpPublicMaterial(profile)).toEqual({ keyID: 'BK', publicArmor: 'BP' })
		expect(cachedOwnPgpPublic(profile)).toEqual({ keyID: 'BK', publicArmor: 'BP' })
		expect(readNativeIdentityPublic).not.toHaveBeenCalled()
	})

	it('a server request gets the PGP material only once identityPublic is ready (retry), never an empty value', async () => {
		const ready = { kind: 'ok', eoa: '0x' + '1'.repeat(40), accountKey: 'k', pgpReady: true, pgpKeyID: 'KID', pgpPublicKeyArmored: 'ARM', ownRouteArmoredPublicKey: 'ROUTE' }
		;(readNativeIdentityPublic as jest.Mock).mockResolvedValueOnce({ kind: 'not_ready' }).mockResolvedValueOnce(ready)
		expect(await shellPgpForServerRequest(3, 0)).toEqual({ keyID: 'KID', publicArmor: 'ARM' })
		expect(readNativeIdentityPublic).toHaveBeenCalledTimes(2)
	})

	it('when identityPublic never becomes ready the request is deferred (null); an unready PGP state counts as not ready', async () => {
		;(readNativeIdentityPublic as jest.Mock).mockReset()
		;(readNativeIdentityPublic as jest.Mock).mockResolvedValue({ kind: 'ok', eoa: '0x', accountKey: 'k', pgpReady: false })
		expect(await shellPgpForServerRequest(2, 0)).toBeNull()
		expect(readNativeIdentityPublic).toHaveBeenCalledTimes(2)
	})
})
