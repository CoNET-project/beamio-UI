#!/usr/bin/env node
// Warns (does not stop) when the running Node differs from the frozen build environment in .nvmrc.
const fs = require('fs')
const path = require('path')
const want = fs.readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim().replace(/^v/, '')
const have = process.versions.node
if (have !== want) {
	console.warn(`check-node-version: WARNING node ${have} differs from the frozen build environment ${want} (.nvmrc); the build output may differ from the recorded one`)
} else {
	console.log(`check-node-version: node ${have} matches .nvmrc`)
}
