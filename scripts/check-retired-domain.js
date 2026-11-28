#!/usr/bin/env node
// Fails when a build output (or any directory given) names the blocked web domain, in any spelling found in source or bundles: nothing the page ships may point at it.
// The only exemption is the application identifier of the same letters (the mobile package id), and only when it is not part of a URL host or an address.
// Usage: node scripts/check-retired-domain.js <dir> [...]   |   node scripts/check-retired-domain.js --self-test
'use strict'
const fs = require('fs')
const path = require('path')

// written in two parts so this file does not name the domain itself
const NAME = ['beamio', 'app']
const SEP = String.raw`(?:\\{0,4}\.|%2e|%252e|\\u002e|\\x2e|\[\.\]|\.?["']\s*\+\s*["']\.?)`
const pattern = () => new RegExp(`${NAME[0]}${SEP}${NAME[1]}(?![a-z0-9_])`, 'gi')
const APP_ID = `com.${NAME.join('.')}`

// the one rule text the page keeps to RECOGNISE old addresses and refuse them (src/utils/retiredHost.ts). Exactly this, between quotes; counted and reported.
const BLOCK_RULE = `blocked-host=${NAME.join('.')}`
const ruleOccurrences = (text) => [`"${BLOCK_RULE}"`, `'${BLOCK_RULE}'`, `\`${BLOCK_RULE}\``].reduce((n, q) => n + text.split(q).length - 1, 0)

function findIn(text) {
	const hits = []
	const re = pattern()
	for (let m; (m = re.exec(text)); ) {
		const start = m.index - 4
		const isAppId = start >= 0 && text.slice(start, m.index + m[0].length) === APP_ID &&
			!/[\/@.\\]/.test(text.charAt(start - 1)) && !/^(?:[\/:]|\.[a-z0-9])/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 2))
		const ruleStart = m.index - 'blocked-host='.length
		const isBlockRule = ruleStart >= 1 && text.slice(ruleStart, m.index + m[0].length) === BLOCK_RULE && /["'`]/.test(text.charAt(ruleStart - 1)) && text.charAt(m.index + m[0].length) === text.charAt(ruleStart - 1)
		if (!isAppId && !isBlockRule) hits.push({ index: m.index, context: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ') })
	}
	return hits
}

function* files(root) {
	const stat = fs.statSync(root)
	if (stat.isFile()) { yield root; return }
	for (const name of fs.readdirSync(root).sort()) yield* files(path.join(root, name))
}

function selfTest() {
	const d = NAME.join('.')
	const must = [`https://${d}/app/update.json`, `"www.${d}"`, `/${NAME[0]}\\.${NAME[1]}/`, `${NAME[0]}%2E${NAME[1]}`, `"${NAME[0]}."+"${NAME[1]}"`, `https://${APP_ID}/x`, `x@${APP_ID}`, `a.${APP_ID}`, `${APP_ID}/path`, `cashtrees.${d}`, d.toUpperCase()]
	must.push(`blocked-host=${d}`, `"blocked-host=${d}/x"`, `"x blocked-host=${d}"`)
	const mustNot = [`"blocked-host=${d}"`, `id=${APP_ID}"`, `"${APP_ID}"`, `package=${APP_ID};end`, `${NAME[0]}.ca/app/`, `${d}le`, `the ${NAME[0]} ${NAME[1]}`]
	const bad = [...must.filter((s) => findIn(s).length === 0).map((s) => `missed: ${s}`), ...mustNot.filter((s) => findIn(s).length !== 0).map((s) => `false hit: ${s}`)]
	if (bad.length) { console.error(bad.join('\n')); process.exit(1) }
	console.log(`retired-domain check self-test: ${must.length} detected, ${mustNot.length} ignored`)
}

if (require.main === module) {
	const args = process.argv.slice(2)
	if (args[0] === '--self-test') { selfTest(); process.exit(0) }
	if (!args.length) { console.error('usage: check-retired-domain.js <dir> [...] | --self-test'); process.exit(2) }
	selfTest()
	let scanned = 0
	let total = 0
	for (const root of args) {
		for (const file of files(root)) {
			// a packed bundle cannot be read as text here: unpack it and scan the directory
			if (/\.zip$/i.test(file)) { console.error(`retired-domain check: unpack before scanning: ${file}`); process.exit(2) }
			scanned += 1
			const content = fs.readFileSync(file, 'latin1')
			for (let i = ruleOccurrences(content); i > 0; i -= 1) console.log(`retired-domain check: allowed block rule (recognises and refuses old addresses, requests nothing): ${path.relative(process.cwd(), file)}`)
			for (const hit of findIn(content)) { total += 1; console.error(`${path.relative(process.cwd(), file)} @${hit.index}: ${hit.context}`) }
		}
	}
	if (!scanned) { console.error('retired-domain check: nothing to scan'); process.exit(2) }
	if (total) { console.error(`retired-domain check FAILED: ${total} reference(s) in ${scanned} file(s)`); process.exit(1) }
	console.log(`retired-domain check: 0 references in ${scanned} files`)
}
module.exports = { findIn }
