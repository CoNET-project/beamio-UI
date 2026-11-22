#!/usr/bin/env node
/**
 * Packaged check (S25 36d7b43 review): the shell terminal state must exist once in the built bundle.
 * Each marker is a string that only one module emits. Count across build/static/js/*.js; any count other than 1 fails the build
 * (a duplicated module would mean markShellTerminal and isShellTerminal read different copies).
 * Usage: node scripts/check-shell-terminal-single-copy.js <buildDir>
 */
const fs = require('fs')
const path = require('path')

const buildDir = process.argv[2] || 'build'
const jsDir = path.join(buildDir, 'static', 'js')
const MARKERS = [
  'terminal: user Retry, one probe', // AppEntryGate retryTerminalOnce
  'terminal update prompt; no read, no retry', // App init guard (terminal)
  'the single probe after Retry is still empty', // App empty-read branch
  'shell refused the page (untrusted_source)', // beamio.ts untrusted wait
]

if (!fs.existsSync(jsDir)) {
  console.error(`check-shell-terminal-single-copy: ${jsDir} not found`)
  process.exit(1)
}
const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'))
const text = new Map(files.map((f) => [f, fs.readFileSync(path.join(jsDir, f), 'utf8')]))
let ok = true
for (const marker of MARKERS) {
  let count = 0
  const where = []
  for (const [f, t] of text) {
    const n = t.split(marker).length - 1
    if (n) { count += n; where.push(`${f}:${n}`) }
  }
  const pass = count === 1
  if (!pass) ok = false
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${count} x "${marker}" ${where.join(' ')}`)
}
if (!ok) {
  console.error('check-shell-terminal-single-copy: a shell terminal marker is not single in the bundle')
  process.exit(1)
}
console.log('check-shell-terminal-single-copy: all markers single')
