/**
 * @jest-environment node
 *
 * Static checks for the bridge key rule (interface notice 27).: the PWA key bridge
 * calls (setNativeChatPgpSecrets, injectNativeChatPgpSecretsFromProfile) are removed, and no native bridge file names a key field
 * as an object key. The runtime checks are in the transport and bridge-guard tests.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name === '__fixtures__' || name === 'node_modules') continue
			sourceFiles(p, out)
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
			out.push(p)
		}
	}
	return out
}

const RETIRED_BRIDGE_CALLS = ['setNativeChatPgpSecrets', 'injectNativeChatPgpSecrets', 'NativeChatPgpSecretsPayload']

/** Files that send commands to a native shell. None may write a key field as an object key. */
const NATIVE_BRIDGE_FILES = [
	'services/nativeConetChatTransport.ts',
	'services/androidNativeChatClient.ts',
	'services/nativeKeyState.ts',
	'utils/cashTreesNativeNfc.ts',
	'utils/cashTreesPushBind.ts',
	'utils/cashTreesIOSBridge.ts',
]
const KEY_FIELD_AS_OBJECT_KEY = /\b(walletPrivateKey|pgpPrivateKeyArmored|pgpPassphrase|privateKeyHex|privateKeyArmor|mnemonicPhrase|mnemonic)\s*:/

describe('the PWA key bridge calls are gone', () => {
	it('no non-test source names a retired PGP-secrets bridge call', () => {
		const hits: string[] = []
		for (const file of sourceFiles(SRC)) {
			const text = readFileSync(file, 'utf8')
			for (const name of RETIRED_BRIDGE_CALLS) {
				if (text.includes(name)) hits.push(`${relative(SRC, file)}: ${name}`)
			}
		}
		expect(hits).toEqual([])
	})

	it('no native bridge file writes a key field as an object key', () => {
		const hits: string[] = []
		for (const rel of NATIVE_BRIDGE_FILES) {
			const text = readFileSync(join(SRC, rel), 'utf8')
			const lines = text.split('\n')
			lines.forEach((line, i) => {
				if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
				if (KEY_FIELD_AS_OBJECT_KEY.test(line)) hits.push(`${rel}:${i + 1}`)
			})
		}
		expect(hits).toEqual([])
	})
})
