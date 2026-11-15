# Provenance

- Source revision (full commit of the internal development repository): `91ae47a28e3e09afba59d4aa7d59f3f0aa147121`
- Parent of the source revision: `3d2be2157d25c5a6d90a37b10c48d9e6a086b8a0`
- PWA version: 0.53.0 (`package.json`)
- Snapshot method: `git archive` of the source revision, then the exclusions and the modifications listed below. The git history of the internal repository is not included.
- Initial commit of this repository: the first commit on `main`, made from the snapshot. Its full SHA is recorded in the release notes after the first push.

## Included

- `src/` (application source, after the exclusions below), `public/` (static assets, PWA manifest, service-worker helper pages), `vendor/conet-chat-sdk/` (CoNET Chat SDK source, MIT; its build output is not included, see below).
- Build and package configuration: `package.json`, `package-lock.json`, `yarn.lock`, `.nvmrc`, `.gitignore`, `.yarnrc.yml`, `craco.config.js`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`.
- `MIT_LICENSE` (kept byte-for-byte from the source revision) and `README.md`.
- `package-lock.json` is kept as it was in the source revision. It resolves 1,455 packages through `registry.npmmirror.com`, a public npm mirror, and 312 packages through `registry.npmjs.org`. See the requirements section of `README.md`.
- Images under `public/` and `src/`: 37 PNG, 2 JPEG, 6 WebP (Pexels photographs), and one ICO file. The project owner confirmed on 2026-11-15 that these images may be published with the source, with their original attribution retained. See the licence section of `README.md`.

## Excluded (not in this repository)

- Development tooling and build configuration not published with the source: `docs/`, `scripts/`, `temp/`, `.github/`, `.vscode/`.
- `.env.production`: no code reads the switch it contained (see the modifications below).
- `.yarn/install-state.gz`: a generated yarn install cache, not source. It is not needed to build the application.
- `src/pages/Home/assets/allnodes.json`: data file not published with the source.
- `vendor/conet-chat-sdk/dist/` (116 files): build output of the CoNET Chat SDK. The SDK's `prepare` script regenerates it during `npm ci`.
- Test-only fixtures (11) under `src/services/__fixtures__/`, omitted together with their readers: `chat-route-register-vectors.v1.json`, `identity-native-keys-vectors.v1.json`, `gossip-sign-vectors.v1.json`, `native-open-vectors.v1.json`, `chat-route-decision-vectors.v1.json`, `native-recovery-vectors.v1.json`, `pgp-migration-vectors.v1.json`, `negative-tests-v1.json`, `identity-public-vectors.v1.json`, `gate-state-vectors.v1.json`, `no-key-reject-vectors.v1.json`. A synthetic replacement will be added in the follow-up.
- CoNET Chat SDK vector, schema and generator files (7): `vendor/conet-chat-sdk/spec/chat-daemon-vectors.v1.json`, `vendor/conet-chat-sdk/spec/sendkey-vectors.v1.json`, `vendor/conet-chat-sdk/spec/chat-daemon-protocol.v1.schema.json`, `vendor/conet-chat-sdk/scripts/genDaemonVectors.ts`, `vendor/conet-chat-sdk/scripts/genDaemonSchema.ts`, `vendor/conet-chat-sdk/scripts/testDaemonConformance.ts`, `vendor/conet-chat-sdk/scripts/testSendKeyVectors.ts`.
- Test files (28), omitted because they read an omitted fixture or SDK vector file, or because their test data contains PGP armour header lines:
  - `src/services/chatRouteRegister.test.ts`
  - `src/services/nativeChatRouteRegister.test.ts`
  - `src/services/walletCore.gossip.test.ts`
  - `src/services/identityPayload.test.ts`
  - `src/services/nativeOpenVectors.test.ts`
  - `src/services/shellChatState.test.ts`
  - `src/services/ownPgpBlob.test.ts`
  - `src/services/pgpBlob.test.ts`
  - `src/services/walletCore.test.ts`
  - `src/services/chatLocalWallet.test.ts`
  - `src/services/nativeConetChatTransport.nodes.test.ts`
  - `src/services/androidNativeChatClient.keys.test.ts`
  - `src/services/androidNativeChatClient.capability.test.ts`
  - `src/services/nativeConetChatTransport.keys.test.ts`
  - `src/services/negativeTests.test.ts`
  - `src/services/gossipAckSign.test.ts`
  - `src/services/walletCorePgp.test.ts`
  - `src/services/passcode/walletVault.test.ts`
  - `src/services/passcode/walletWrap.test.ts`
  - `src/services/nativeRecoveryVectors.test.ts`
  - `src/services/bridgeGuard.test.ts`
  - `src/services/nativeIdentityPublic.test.ts`
  - `src/services/pgpBlob.strict.test.ts`
  - `src/utils/peerChatPrivateArmored.test.ts`
  - `src/services/pgpMigrationClient.test.ts`
  - three further files in `src/services/` (a shell record refusal test, a gate-state vector test and a no-key rejection vector test). Their names carried internal labels, so they are not listed by name here.
- Module removed with its switch: `src/services/previewSupport.ts`.
- A development copy register (translation working table): not published with the source.
- PGP armour header lines (`-----BEGIN PGP ... BLOCK-----`, and the `BEGIN PGP PRIVATE KEY` detector string) appear in some source and test files as detector inputs or synthetic test data. They contain no key material. Three test files carry a `TEST ONLY` comment beside the header they use: `src/services/shellRecordSanitizer.test.ts`, `src/services/shellRecordStore.test.ts`, `src/utils/recipientPublicKey.test.ts`.

## Modifications relative to the source revision

Code and configuration:

- `package.json`: four script entries removed: `verify:no-key-upload`, `verify:shell-no-pgp-key-read`, `verify:shell-no-pgp-key-read:build`, `build:loader`. They pointed to internal gate files that are not in this repository. No dependency or build-command change.
- `src/api/index.ts`: the unused debug export `testRequest` and its import removed.
- `src/index.tsx`: the compile-time preview-support branch removed.
- `vendor/conet-chat-sdk/package.json`: scripts `test:conformance`, `test:vectors` and `spec:schema` removed (they ran omitted generators and tests), and the conformance step removed from the `test` chain.
- `vendor/conet-chat-sdk/README.md`: table rows and sentences that describe the removed vector, schema and generator files removed.
- `vendor/conet-chat-sdk/src/protocol.ts`: a comment that named an omitted file rewritten; one description string had an internal label removed. No field or value changed.
- `src/services/x21Retirement.test.ts`: the test block that read an omitted fixture removed. The static scan that remains is unchanged.
- `src/services/shellIdentityClosed.static.test.ts`: the assertion that read the omitted copy register removed. The test still checks that the copy keys exist in both locales.
- `src/services/backupViewAndUrlRestore.test.ts`: one regular expression that matches a source comment changed to match the comment after the label removal. The test checks the same text.
- Identifiers renamed to neutral names: the migration function and type names in `src/services/chatLocalMigration.ts`, `src/services/chatLocalMigrationCore.ts` and `src/services/chatLocalPurge.test.ts`; test constants in `src/services/credForbiddenNames.test.ts`, `src/services/shellChatStart.test.ts` and `src/services/nativeKeyState.test.ts`.
- Eleven test files renamed because their file names carried internal labels. The old names are not listed here; the new names are in the tree.

Test data and strings:

- The mnemonic values in `src/services/passcode/walletVaultPgpKeep.test.ts` and `src/utils/keyOnlyEntry.test.ts` replaced with the public BIP39 test vector of zero entropy. The two tests use the value only as a stored or present field.
- A placeholder route key ID in `src/utils/recipientPublicKey.trust.test.ts` replaced with a neutral placeholder.
- Case identifiers in `src/services/browserInboundAck.vectors.test.ts` and table names in `src/services/nativeSignRequestShapes.test.ts` replaced with neutral names.
- `src/locales/en/translation.json`: one phrase in the recovery-phrase notice reworded to neutral text.
- Log and copy strings in `src/services/shellChatStart.ts`, `src/services/chatWorkerBridge.ts`, `src/services/chat.ts` and related files: internal labels removed from the text. No condition or branch changed.
- Internal labels (review, task and specification-section identifiers) removed from comments and test titles across the snapshot. Counts are given in the next section.

## Internal label removal: counts

The same detector was run on the source revision and on this snapshot, over the same set of files (text files of the snapshot; dependency-lock hashes and SVG path data are not counted). Categories: review-number labels (`R` followed by digits), `r`-numbered and `r3`-family labels, `RC` labels, `D-class` labels, `T-n` labels, specification section numbers (`§` and `25.nn` codes), `item N` references, project-manager review references, and `P-` codes.

- Source revision, same files: 2,695 matches in 350 files.
- This snapshot: 0 matches.

Not removed in this snapshot: references to design-specification terms in prose (for example `spec, option A`), and the state names `G0` to `G2` used in the code. These are product terms, not review labels. Three comment lines in `vendor/conet-chat-sdk/src/call-signal.ts`, `vendor/conet-chat-sdk/src/daemon.ts` and `vendor/conet-chat-sdk/src/wire.ts` still name the omitted file `spec/chat-daemon-vectors.v1.json`. The file is not in this repository.

Code changes: apart from the files named in this section, no TypeScript or JavaScript file changed except in comments and string contents. The following files have changes beyond comments and strings (identifier, structure or assertion changes): `src/api/index.ts`, `src/index.tsx`, `src/services/backupViewAndUrlRestore.test.ts`, `src/services/chatLocalMigration.ts`, `src/services/chatLocalMigrationCore.ts`, `src/services/chatLocalPurge.test.ts`, `src/services/credForbiddenNames.test.ts`, `src/services/shellChatStart.test.ts`, `src/services/shellIdentityClosed.static.test.ts`, `src/services/x21Retirement.test.ts`. The comparison that supports this statement removes comments and normalises string contents; the release evidence lists the files that differ only in strings.

## Passcode vector files kept, with metadata-only edits

Two JSON files under `src/services/passcode/` are kept, not omitted, because production code imports them at build time:

- `passcode-tokens.v1.json`, imported by `src/services/passcode/passcodeTokens.ts`.
- `passcode-vectors.v1.json`, imported by `src/services/passcode/passcodeFlow.ts`, and read by the test `src/services/passcode/passcodeRules.test.ts`.

Their values are unchanged. Only metadata strings were edited. Comparing the parsed JSON with the source revision, the only differing values are:

- `passcode-tokens.v1.json`: `/spec` and `/source`.
- `passcode-vectors.v1.json`: `/spec` and `/status`.

Because the file bytes changed, the test that pins the hash of `passcode-vectors.v1.json` was re-pinned to the sha256 prefix of the snapshot copy, `fec956944a45ca52`. The original prefix from the source revision, `7993ad8510ce3063`, no longer applies to this copy.

## Planned follow-up

Synthetic test vectors for the removed tests and fixtures will be added in a follow-up commit. They will be labelled `TEST ONLY`, generated for this repository, and every derived value will be recomputed. The follow-up does not change the consumer application code.

## Status

Initial snapshot. Not yet pushed to `main` at the time this file was written; the release notes record the pushed commit, the remote read-back, and the ZIP built from it.

Known issue in this source revision: on a device that already holds a native wallet record, a cold start can stay at the entry gate ("Native wallet is not ready"). The code path is present in the source revision (`src/services/chat.ts`, `src/services/nativeConetChatTransport.ts`). A fix is planned as the first follow-up commit.
