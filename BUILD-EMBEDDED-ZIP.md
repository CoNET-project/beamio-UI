# Building the PWA ZIP embedded in a native shell

Scope: the single `SilentPassUI.zip` that the iOS and Android shells embed. Not the public web build, not the public OTA manifest.

## Rules

1. Build only from a clean worktree at a committed revision. No symbolic links to another worktree's `node_modules`.
2. Install dependencies from the lockfiles in that worktree:
   - root: `npm ci --legacy-peer-deps`
   - SDK: `npm --prefix vendor/conet-chat-sdk ci --ignore-scripts`
3. Record `git status` (raw output) before and after the install and after the build. Each must be empty for a release build.
4. The shell ZIP may be packed only from the `build/` produced by `npm run build:shell-qa-embedded` or `npm run build:shell-embedded`.
   Never pack a shell ZIP from the `build/` of `build`, `build:embedded`, `build:qa-embedded`, `build:qa-candidate` or `build:react`. The build-time injection
   (`scripts/inject-qa-update-json.js`) writes `build/update.json` from `package.json` only. It is wired only into the shell ZIP
   scripts (`build:shell-embedded`, `build:shell-qa-embedded`). Other build scripts must not inject.
5. Never change the repository `public/update.json` for a ZIP. It is the public OTA manifest and changes only in an approved OTA publication.
6. Package: run `PACK_OUT=/path/outside/the/repo/SilentPassUI.zip npm run pack:shell-embedded` (`scripts/pack-embedded-zip.sh [build-dir] <output-zip>`; the build directory defaults to `build`, the output path is required and must be outside the repository so that `git status` stays empty). The script copies `build/` to a staging directory, removes `*.map` and the `sourceMappingURL` lines from `*.js`, `*.css` and `*.html`, sets `TZ=UTC`, `LC_ALL=C` and
   `umask 022`, sets every file to mode 644 and every directory to 755, sets all timestamps to `202611210000`, lists the files with `LC_ALL=C sort`, and creates the archive with
   `zip -X -D -q -@`. It needs Info-ZIP `zip` and stops with an error if it is missing (no other archiver is used). It prints the path, the entry count and the SHA-256, and warns when the Node
   version differs from `.nvmrc` (the frozen build environment, Node 22.23.3). The ZIP must contain exactly one `update.json` at the root and no nested ZIP; the script refuses otherwise.
7. Record, with the ZIP:
   - the build script name (`build:shell-qa-embedded` or `build:shell-embedded`) and the environment variables actually set by that script (record the expansion used, not a generic list)
     (`GENERATE_SOURCEMAP`, `REACT_APP_BEAMIO_BOOT_TRACE`, `REACT_APP_SHELL_BUILD`, `REACT_APP_PGP_IDENTITY_CREATE_ENABLED`, `PUBLIC_URL`),
     as actually set by the script used. `build:shell-embedded` does not set `GENERATE_SOURCEMAP`, `REACT_APP_BEAMIO_BOOT_TRACE` or `REACT_APP_PGP_IDENTITY_CREATE_ENABLED`;
   - the absolute path, the version, the full SHA-256, the commit, the Node and npm versions;
   - the exact entry count (the number reported by the ZIP listing; no approximate values);
   - the `vendor/conet-chat-sdk` version and the per-file SHA-256 manifest of its `dist/`;
   - the per-file SHA-256 manifest of the ZIP entries, which must match the unpacked content line by line;
   - the exact command lines.
8. A ZIP is an internal release only after an independent clean rebuild from the same commit gives the same SHA-256.
9. Disclaimer: a matching independent rebuild proves reproducibility only. It is not functional acceptance of the app or of any shell.
