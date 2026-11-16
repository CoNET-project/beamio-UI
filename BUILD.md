# PWA build (QA and release inputs)

Package manager: npm, matching the production script (`scripts/deployBeamioPwa.sh` runs `npm install --legacy-peer-deps`).
The lockfile is `package-lock.json` only; `yarn.lock` is not kept.

Steps from a clean export of a commit:

1. `npm ci --legacy-peer-deps` (uses `package-lock.json`).
2. Build the vendored chat SDK (gitignored output, required before the app build):
   `cd vendor/conet-chat-sdk && npm run build && cd -` (runs `tsc -p tsconfig.json`).
3. Shell QA build: `npm run build:shell-qa-embedded` with `BUILD_PATH` set to a directory outside the repository.
4. Remove source maps and `sourceMappingURL` comments before packing the QA ZIP (see the QA packaging rule).

Record the commit, Node/npm versions, the lockfile hash, the vendor `dist` tree hash and the build log with each handoff.
