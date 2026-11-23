/**
 * @jest-environment node
 *
 * account-select CP-01..CP-08 (36(1) copy rule, the rule #10): a locale-based wording test over every locale file. Forbidden
 * meanings (找回私钥, 找回钱包) must not appear in any string value. The exemption table (恢复钱包, the existing entry name) is listed and
 * must not be treated as forbidden. This checks the shipped copy, not the vector's synthetic inputs.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const LOCALE_FILES = [
	'src/locale/zh-CN.json',
	'src/locale/en.json',
	'src/locale/zhToUiKey.json',
	'src/locales/zh/translation.json',
	'src/locales/jp/translation.json',
	'src/locales/en/translation.json',
]

/** Forbidden meanings (CP-03, CP-07): the copy suggests recovering a private key or "finding back" a wallet. */
const FORBIDDEN = ['找回私钥', '找回钱包']
/** Exemption table (CP-08): the existing entry name stays allowed. */
const EXEMPT = ['恢复钱包']

function stringValues(node: unknown, out: string[] = []): string[] {
	if (typeof node === 'string') out.push(node)
	else if (Array.isArray(node)) node.forEach((v) => stringValues(v, out))
	else if (node && typeof node === 'object') Object.values(node).forEach((v) => stringValues(v, out))
	return out
}

/** A value is a violation when it has a forbidden phrase that is not part of an exempt phrase. */
function violations(value: string): string[] {
	let rest = value
	for (const e of EXEMPT) rest = rest.split(e).join('')
	return FORBIDDEN.filter((f) => rest.includes(f))
}

const ROOT = join(__dirname, '..', '..')

describe('copy wording (36(1)): forbidden meanings are not in any locale file', () => {
	it.each(LOCALE_FILES)('%s has no forbidden meaning in any string value', (rel) => {
		const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
		const bad = stringValues(data).flatMap((v) => violations(v).map((f) => `${f} in: ${v.slice(0, 60)}`))
		expect(bad).toEqual([])
	})

	it('CP-08: the existing entry name 恢复钱包 is exempt (not a violation)', () => {
		expect(violations('恢复钱包')).toEqual([])
	})

	it('CP-03 / CP-07 (rule): a copy that suggests finding back a private key or wallet is a violation', () => {
		expect(violations('找回私钥')).toEqual(['找回私钥'])
		expect(violations('找回钱包')).toEqual(['找回钱包'])
	})

	it('CP-01 / CP-02 / CP-06: a title that mentions the mnemonic, a neutral title, and 创建助记词 are not violations', () => {
		expect(violations('用恢复码恢复助记词')).toEqual([])
		expect(violations('恢复入口')).toEqual([])
		expect(violations('创建助记词')).toEqual([])
	})

	it('CP-04 / CP-05: input prompts that ask for the recovery code are not violations', () => {
		expect(violations('输入恢复码')).toEqual([])
		expect(violations('请输入您的恢复码。')).toEqual([])
	})
})
