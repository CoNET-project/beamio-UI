// ethers and openpgp are bundled ONCE (craco.config.js re-resolves the SDK's imports from the app). Nothing may depend on the two copies being separate: no instanceof against a class
// of either library, in the app or in the SDK source; and the craco rule covers every subpath and only the imports that come from the SDK directory.
import fs from 'fs'
import path from 'path'

const walk = (dir: string, out: string[] = []): string[] => {
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f)
		if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p, out) } else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) out.push(p)
	}
	return out
}
const LIB_CLASSES = /instanceof\s+(?:ethers\.)?(Wallet|HDNodeWallet|Contract|ContractFactory|JsonRpcProvider|BrowserProvider|Provider|Signer|Interface|Result|Transaction|SigningKey|Mnemonic|Message|Key|PublicKey|PrivateKey|SignedMessage|Signature|CleartextMessage|PacketList|KeyID)\b/

describe('one copy of ethers and openpgp', () => {
	it('no instanceof against a class of ethers or openpgp, in the app or in the SDK source (nothing relies on the two copies being isolated)', () => {
		const root = path.join(__dirname, '..', '..')
		const hits: string[] = []
		for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'vendor', 'conet-chat-sdk', 'src'))]) {
			const t = fs.readFileSync(f, 'utf8')
			if (LIB_CLASSES.test(t)) hits.push(path.relative(root, f))
		}
		expect(hits).toEqual([])
	})

	it('the craco rule: both packages and every subpath, only for imports issued from the SDK directory, applied to the main compilation and (by hook copy) the worker child compilations', () => {
		const craco = fs.readFileSync(path.join(__dirname, '../../craco.config.js'), 'utf8')
		expect(craco).toMatch(/new webpack\.NormalModuleReplacementPlugin\(\/\^\(ethers\|openpgp\)\(\\\/\.\*\)\?\$\/, \(resource\) => \{/)
		expect(craco).toMatch(/if \(\/\[\\\\\/\]conet-chat-sdk\[\\\\\/\]\/\.test\(String\(resource\.context \|\| ''\)\)\) resource\.context = __dirname/)
		const re = /^(ethers|openpgp)(\/.*)?$/
		for (const ok of ['ethers', 'openpgp', 'ethers/lib.esm/index.js', 'openpgp/dist/openpgp.min.mjs', 'openpgp/lightweight']) expect(re.test(ok)).toBe(true)
		for (const no of ['ethers-extra', 'openpgpjs', '@scope/ethers', './ethers']) expect(re.test(no)).toBe(false)
		const ctx = /[\\/]conet-chat-sdk[\\/]/
		expect(ctx.test('/x/vendor/conet-chat-sdk/dist/crypto.js')).toBe(true)
		expect(ctx.test('/x/src/services/chat.ts')).toBe(false)
	})
})
