/**
 * The canonical form of a typed mnemonic, as the Chat SDK derives it(MnemonicDerivation.kt
 * canonicalPhrase): remove ASCII whitespace at both ends, lower-case, split on the JavaScript whitespace class, NFKD each word, and join
 * with a single space. It does not check the word list, the word count or the checksum: that is the derivation's job (mnemonicEoa).
 * The derivation of the key is unchanged; only the text sent to the shell is normalised.
 */
export function canonicalPhrase(raw: string): string {
	const text = typeof raw === 'string' ? raw : ''
	return text
		.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '')
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 0)
		.map((w) => w.normalize('NFKD'))
		.join(' ')
}
