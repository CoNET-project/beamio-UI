#!/usr/bin/env node
/**
 * Build-time injection for an internal QA shell ZIP.
 *
 * It writes build/update.json for the embedded ZIP ONLY. The repository file public/update.json (the public OTA manifest) is never
 * changed by this script. The version and file name come from package.json at build time.
 *
 * Usage: node scripts/inject-qa-update-json.js [buildDir] (default: build)
 * Run after the React build (wired into build:shell-qa-embedded).
 */
const fs = require('fs')
const path = require('path')

const buildDir = process.argv[2] || 'build'
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const ver = String(pkg.version || '').trim()
if (!/^\d+(\.\d+){1,3}$/.test(ver)) {
	console.error(`inject-qa-update-json: package.json version is not a plain version: ${ver}`)
	process.exit(1)
}
const target = path.join(buildDir, 'update.json')
if (!fs.existsSync(buildDir)) {
	console.error(`inject-qa-update-json: build directory not found: ${buildDir}`)
	process.exit(1)
}
fs.writeFileSync(target, JSON.stringify({ ver, filename: `SilentPassUI-${ver}.zip` }, null, '\t') + '\n')
console.log(`inject-qa-update-json: wrote ${target} ver=${ver}`)
