/**
 * NFC 认领私钥上传：暂停后的回归门禁（项目方 2026-11-12，"暂时去掉调用"）。
 *
 * 源码文本检查：不得出现已暂停的端点标识符（不区分大小写），与 scripts/verify-no-key-upload.mjs 第 1 项一致。
 * 标识符拆开书写，本文件自身不会命中。
 * fetch 请求体的私钥字段检查由脚本负责（需 TypeScript 语法树，jest 中不重复实现）。
 * 深链行为（识别后返回暂停状态、不发请求）由浏览器验证覆盖，见回执第 13 节。
 */
import fs from 'fs'
import path from 'path'

const FORBIDDEN_TEXT = ['nfcLink', 'AppClaimWithKey'].join('').toLowerCase()
const SRC_ROOT = path.resolve(__dirname, '..')
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md'])

function walk(dir: string): string[] {
	const out: string[] = []
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === 'node_modules') continue
		const p = path.join(dir, ent.name)
		if (ent.isDirectory()) out.push(...walk(p))
		else if (ent.isFile() && TEXT_EXT.has(path.extname(ent.name))) out.push(p)
	}
	return out
}

describe('NFC 认领私钥上传已暂停：回归门禁', () => {
	it('源码中不出现已暂停的端点标识符（不区分大小写）', () => {
		const hits = walk(SRC_ROOT)
			.filter((f) => fs.readFileSync(f, 'utf8').toLowerCase().includes(FORBIDDEN_TEXT))
			.map((f) => path.relative(SRC_ROOT, f))
		expect(hits).toEqual([])
	})
})
