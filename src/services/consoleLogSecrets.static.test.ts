/**
 * MP-19 / SC-09 (static half): the page must keep passcodes, mnemonics, private keys, cipher fields and decrypted results out of its
 * console and its native-log channel. The shells copy the page console text as it is into the platform log, so only the page can keep them out.
 *
 * Every call point of console.*, publishNativePwaLog, deps.log and log( in the non-test source (src and vendor/conet-chat-sdk/src) is checked:
 *  1. no secret-named identifier in an argument or a template interpolation (passcode, phrase, mnemonic, private key, cipher, ct, salt, iv, armor,
 *     secret, seed, decrypted, plain...);
 *  2. no whole-object print of a command, request, payload, answer, record or envelope;
 *  3. in the secret-handling modules, no free error text (error.message, stack, the error object): a code only (diagnosticCode);
 *  4. no `throw new Error(...)` that interpolates a secret-named identifier.
 * A call that must carry such a word in a literal string is not affected: string literals are removed before the check.
 */
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

const files = (): string[] =>
	execSync('git ls-files -z src vendor/conet-chat-sdk/src', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
		.toString('utf8')
		.split('\0')
		.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.|__tests__|\.static\.|\/devtools\/|副本/.test(f))

const CALL = /(?:console\.(?:log|info|warn|error|debug)|publishNativePwaLog\s*\(\s*['"`]\w+['"`]\s*,|\bdeps\.log|\blog\b(?=\())\s*\(/g
const FORBID = /\b(passcode|oldPasscode|newPasscode|phrase|mnemonic\w*|privateKey\w*|private_key|secret\w*|seed|cipher|envelope|armor|salt|iv|ct|decrypted|plain\w*)\b|\.ct\b|\.salt\b|\.iv\b/i
const WHOLE = /JSON\.stringify\(\s*(?:cmd|req|request|payload|answer|reply|result|record|data|envelope|cipher|body|msg|message|command)\b|,\s*(?:cmd|req|request|payload|answer|reply|record|envelope|cipher|command)\s*\)/
const ERR = /\b(?:err|error|e|ex|exc)\??\.(?:message|stack)|String\((?:err|error|e|ex)\)|,\s*(?:err|error|e|ex)\s*\)/
/** The modules that handle passcodes, mnemonics, private keys or ciphertext: no free error text from them. */
const SECRET_MODULES = /passcode|Passcode|shellMnemonicSync|pwaWalletSync|nativeRecovery|uiUnlock|walletVault|mnemonicCipher|shellRecord|PrereadPasscode|PasscodeLock|AppEntryGate|shellStoreWait|walletBootstrap|walletCore|nativeWallet|nativeKey|services\/beamio\.ts|services\/chat\.ts|pgpIdentity|nativePgpRestore/
/** Reviewed: an error text that is not secret (a network or chain failure with no key, phrase or ciphertext in scope). Matched by file and the start of the call. */
const ERR_ALLOWED: ReadonlyArray<RegExp> = [
	/services\/beamio\.ts::`checkBeamioAccountAPI: on-chain probe failed/,
	/services\/beamio\.ts::`checkBeamioAccount error/,
	/services\/beamio\.ts::`\[storageHashData\] Error:`/,
	/services\/chat\.ts::'\[regiestChatRoute\]'/,
	/services\/chat\.ts::`\[sendMessage\] \$\{url\}/,
	/services\/chat\.ts::'\[queryMailbox/,
]

type Hit = { file: string; line: number; kind: string; text: string }

const scan = (): Hit[] => {
	const hits: Hit[] = []
	for (const f of files()) {
		const s = readFileSync(join(ROOT, f), 'utf8')
		for (const m of s.matchAll(CALL)) {
			let depth = 1
			let j = (m.index ?? 0) + m[0].length
			const start = j
			while (j < s.length && depth > 0) {
				const c = s[j]
				if (c === '(' || c === '[' || c === '{') depth++
				else if (c === ')' || c === ']' || c === '}') depth--
				j++
			}
			const expr = s.slice(start, j - 1)
			const line = s.slice(0, m.index).split('\n').length
			const interp = [...expr.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ')
			const nonStr = expr.replace(/\$\{[^}]*\}/g, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
			// a code only (diagnosticCode(...)) is the allowed form of an error: it prints a listed code or `other`, never the text
			const code = `${interp} ${nonStr}`.replace(/diagnosticCode\([^)]*\)/g, '')
			const flat = expr.replace(/\s+/g, ' ').slice(0, 120)
			if (FORBID.test(code)) hits.push({ file: f, line, kind: 'secret_identifier', text: flat })
			if (WHOLE.test(code)) hits.push({ file: f, line, kind: 'whole_object', text: flat })
			if (ERR.test(code) && SECRET_MODULES.test(f) && !ERR_ALLOWED.some((r) => r.test(`${f}::${flat.trimStart()}`))) hits.push({ file: f, line, kind: 'free_error_text', text: flat })
		}
		for (const m of s.matchAll(/throw new Error\(([^)]*)\)/g)) {
			const interp = [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ')
			if (interp && FORBID.test(interp)) hits.push({ file: f, line: s.slice(0, m.index).split('\n').length, kind: 'secret_in_thrown_message', text: m[1].slice(0, 100) })
		}
	}
	return hits
}

describe('MP-19 / SC-09 static: no secret reaches a console or native-log call', () => {
	const hits = scan()
	it('scans a real tree (the call points are found)', () => {
		expect(files().length).toBeGreaterThan(300)
	})
	it('no call point or thrown message carries a secret-named value, a whole request, or free error text from a secret module', () => {
		expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} :: ${h.text}`)).toEqual([])
	})
})

describe('the detectors do detect (a scan that cannot fail proves nothing)', () => {
	it('a secret-named interpolation, a whole request print and a free error text are matched', () => {
		expect(FORBID.test('passcode')).toBe(true)
		expect(FORBID.test('first.phrase')).toBe(true)
		expect(FORBID.test('cipher.ct')).toBe(true)
		expect(FORBID.test('reqId')).toBe(false)
		expect(WHOLE.test('JSON.stringify(cmd)')).toBe(true)
		expect(WHOLE.test("'sent', cmd)")).toBe(true)
		expect(WHOLE.test('JSON.stringify(reqId)')).toBe(false)
		expect(ERR.test('err instanceof Error ? err.message : x')).toBe(true)
		expect(ERR.test("'failed', ex)")).toBe(true)
	})
})
