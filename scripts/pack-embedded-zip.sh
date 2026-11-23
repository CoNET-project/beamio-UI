#!/bin/bash
# Packs build/ into the single SilentPassUI.zip that the native shells embed (BUILD-EMBEDDED-ZIP.md rule 6).
# usage: scripts/pack-embedded-zip.sh [build-dir] [output-zip]
#   build-dir defaults to build; output-zip is required (put it outside the repository so `git status` stays empty)
# Deterministic: same input tree gives the same bytes on any host that has Info-ZIP `zip` (TZ, locale and umask are fixed here).
# It does not build. Run `npm run build:shell-embedded` (or build:shell-qa-embedded) first.
set -euo pipefail
export TZ=UTC LC_ALL=C
umask 022
BUILD_DIR="${1:-build}"
OUT="${2:?output ZIP path required (outside the repository)}"
STAMP=202611210000   # fixed mtime for every entry, touch -t format
EXPECT_NODE="$(tr -d 'v \n' < "$(dirname "$0")/../.nvmrc")"

# 1. Info-ZIP only: no other archiver is used in its place
if ! command -v zip >/dev/null 2>&1 || ! zip -v 2>&1 | head -3 | grep -q 'Info-ZIP'; then
	echo "pack-embedded-zip: Info-ZIP 'zip' is required and was not found; no other tool is used instead" >&2
	exit 2
fi
# 2. Node version: warn when it differs from the frozen build environment (.nvmrc); the build itself is not run here
ACTUAL_NODE="$(node -v 2>/dev/null | tr -d 'v')"
if [ "$ACTUAL_NODE" != "$EXPECT_NODE" ]; then
	echo "pack-embedded-zip: WARNING node $ACTUAL_NODE differs from the frozen environment $EXPECT_NODE (.nvmrc); the build output may differ" >&2
fi
[ -d "$BUILD_DIR" ] || { echo "pack-embedded-zip: build directory not found: $BUILD_DIR" >&2; exit 2; }
[ -f "$BUILD_DIR/update.json" ] || { echo "pack-embedded-zip: $BUILD_DIR/update.json missing (build with build:shell-embedded)" >&2; exit 2; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/pack-embedded-zip.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$BUILD_DIR"/. "$STAGE"/

# 3. no source maps, no sourceMappingURL lines
find "$STAGE" -name '*.map' -type f -delete
find "$STAGE" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) -print0 | while IFS= read -r -d '' f; do
	if grep -q 'sourceMappingURL=' "$f"; then
		grep -v 'sourceMappingURL=' "$f" > "$f.tmp" || true
		cat "$f.tmp" > "$f"   # keeps the file mode of $f
		rm -f "$f.tmp"
	fi
done

# 4. one mode for everything (files 644, directories 755) and one mtime
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
find "$STAGE" -exec touch -t "$STAMP" {} +

# 5. no nested ZIP; exactly one update.json at the root
if find "$STAGE" -type f -iname '*.zip' | grep -q .; then echo "pack-embedded-zip: a nested ZIP is present in the build; refused" >&2; exit 3; fi
[ "$(find "$STAGE" -name update.json -type f | wc -l | tr -d ' ')" = "1" ] && [ -f "$STAGE/update.json" ] || { echo "pack-embedded-zip: update.json must exist exactly once, at the root" >&2; exit 3; }

# 6. sorted list, zip -X -D
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
( cd "$STAGE" && find . -type f | sed 's|^\./||' | sort | zip -X -D -q "$OUT_ABS" -@ )

echo "zip:     $OUT_ABS"
echo "entries: $(unzip -Z1 "$OUT_ABS" | wc -l | tr -d ' ')"
if command -v shasum >/dev/null 2>&1; then echo "sha256:  $(shasum -a 256 "$OUT_ABS" | cut -d' ' -f1)"; else echo "sha256:  $(sha256sum "$OUT_ABS" | cut -d' ' -f1)"; fi
