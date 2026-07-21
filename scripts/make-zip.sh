#!/usr/bin/env bash
# scripts/make-zip.sh — build the Docky sideload/release zip: only what the plugin needs.
#
# This is how a Docky release archive is produced. It lives in the repo (rather than
# in someone's ~/bin) so the distributed artifact is reproducible by anyone with a
# checkout — CI, a fresh machine, or a contributor.
#
# Archiving the whole tracked tree yields ~4.9 MB, and 97% of that is
# docs/images/*.png — a single screenshot is 910 KB, larger than all the plugin code
# combined. Documentation is read on GitHub, never off a Deck's filesystem, and
# plugin.json's publish.image is an absolute raw.githubusercontent URL, so neither
# the install path nor the store listing needs those bytes shipped.
#
# So this builds from an explicit ALLOWLIST: if a file isn't needed to run or install
# the plugin, it isn't in the zip. Result is ~110 KB. An allowlist (not an exclude
# list) so a directory added later can't silently bloat releases again — it has to be
# opted in here, in a diff someone reviews.
#
# Shape is what Decky Loader requires: a single top-level `Docky/` folder with
# `Docky/plugin.json` at depth 1.
#
#   scripts/make-zip.sh                  # build dist/, package, verify -> ./Docky.zip
#   scripts/make-zip.sh -o /tmp/D.zip    # write somewhere else
#   scripts/make-zip.sh --no-build       # package the dist/index.js already on disk
#   scripts/make-zip.sh --verify FILE    # only inspect an existing zip, build nothing
#   scripts/make-zip.sh --list           # build, then print every entry with sizes

set -uo pipefail
export GIT_PAGER=cat

# Repo root = this script's parent dir, resolved through symlinks. Deliberately NOT
# $PWD or a hardcoded $HOME path: the packaging must describe THIS checkout, whichever
# one the script was invoked from.
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." 2>/dev/null && pwd)"
OUT="Docky.zip"
DO_BUILD=1
VERIFY_ONLY=""
DO_LIST=0

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# Everything the plugin needs at run/install time, and nothing else.
#   plugin.json  loader manifest (MUST be at Docky/plugin.json)
#   main.py      Decky Plugin wrapper + trigger watcher
#   py_modules   the engine
#   dist         built frontend bundle (gitignored — injected from the worktree)
#   assets       steam-wait-x.sh + autostart .desktop, deployed by install.sh
#   *.sh         install/uninstall for source-style installs
#   package.json version/name metadata
#   LICENSE README.md CHANGELOG.md   small, and expected in a distributed archive
# Deliberately EXCLUDED: docs/ (4.7 MB of screenshots), src/ (build input only),
# tsconfig.json, rollup.config.js, pnpm-lock.yaml, .gitignore, CONTRIBUTING.md.
INCLUDE=(
  plugin.json
  package.json
  main.py
  py_modules
  assets
  install.sh
  uninstall.sh
  LICENSE
  README.md
  CHANGELOG.md
)

# Entries that MUST exist in the finished zip or the plugin cannot load.
REQUIRED=(
  Docky/plugin.json
  Docky/main.py
  Docky/dist/index.js
  Docky/py_modules/docky.py
  Docky/py_modules/sunshine.py
)

usage() {
  cat <<EOF
Usage: scripts/make-zip.sh [-o OUT] [--no-build] [--list]
       scripts/make-zip.sh --verify FILE

  -o, --out FILE   Where to write the zip (default: ./Docky.zip).
      --no-build   Skip 'pnpm run build'; package the existing dist/index.js.
      --list       Print every entry in the finished zip with sizes.
      --verify F   Inspect an existing zip and exit (no build, no packaging).
  -h, --help       Show this help.

Builds from HEAD (tracked files only) plus the built, gitignored dist/index.js.
Uncommitted edits to included files are therefore NOT packaged — commit first.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)    OUT="${2:?-o needs a path}"; shift 2 ;;
    --no-build)  DO_BUILD=0; shift ;;
    --list)      DO_LIST=1; shift ;;
    --verify)    VERIFY_ONLY="${2:?--verify needs a file}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *)           red "Unknown option: $1"; echo; usage; exit 1 ;;
  esac
done

command -v python3 >/dev/null || { red "python3 not found — required to build/inspect the zip."; exit 1; }

# Report what's in a zip and assert the loader-critical entries are present.
inspect() {
  python3 - "$1" "${REQUIRED[@]}" <<'PY'
import sys, zipfile, json, collections
path, required = sys.argv[1], sys.argv[2:]
try:
    z = zipfile.ZipFile(path)
except Exception as e:
    print("NOT A READABLE ZIP: %s" % e); sys.exit(1)
names = z.namelist()
tops = {n.split('/')[0] for n in names}
if tops != {"Docky"}:
    print("FAIL: expected a single top-level 'Docky/' folder, got: %s" % sorted(tops)); sys.exit(1)
missing = [r for r in required if r not in names]
if missing:
    print("FAIL: missing required entries: %s" % missing); sys.exit(1)
for bad in ("Docky/docs/", "Docky/src/"):
    if any(n.startswith(bad) for n in names):
        print("WARN: %s present — the zip is larger than it needs to be" % bad)
try:
    ver = json.loads(z.read("Docky/plugin.json")).get("version")
except Exception:
    print("FAIL: plugin.json is not valid JSON"); sys.exit(1)
by = collections.Counter()
for i in z.infolist():
    p = i.filename.split('/')
    by[p[1] if len(p) > 1 and p[1] else '(root)'] += i.compress_size
total = sum(by.values())
print("  version:  %s" % ver)
print("  entries:  %d" % len(names))
print("  size:     %.0f KB compressed" % (total / 1024))
for k, v in by.most_common(6):
    print("    %-16s %6.0f KB" % (k, v / 1024))
PY
}

if [ -n "$VERIFY_ONLY" ]; then
  bold "Inspecting $VERIFY_ONLY"
  inspect "$VERIFY_ONLY" || exit 1
  grn "Zip is well-formed."
  exit 0
fi

cd "$REPO" || { red "Repo not found: $REPO"; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { red "$REPO is not a git repo."; exit 1; }

bold "Packaging Docky from $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
[ -n "$(git status --porcelain)" ] && \
  ylw "Note: working tree is dirty — the zip is built from HEAD, so uncommitted edits are NOT included."

if [ "$DO_BUILD" -eq 1 ]; then
  command -v pnpm >/dev/null || { red "pnpm not found — use --no-build to package the existing dist/."; exit 1; }
  ylw "Building frontend (pnpm run build)…"
  pnpm run build >/dev/null 2>&1 || { red "pnpm run build failed — not packaging a stale bundle."; exit 1; }
fi
[ -f dist/index.js ] || { red "dist/index.js missing — run without --no-build, or 'pnpm run build' first."; exit 1; }

# git archive with pathspecs gives us the allowlist straight from HEAD; the built
# bundle is gitignored, so python appends it afterwards.
stage="$(mktemp -d)" || { red "mktemp failed."; exit 1; }
trap 'rm -rf "$stage"' EXIT
tmpzip="$stage/Docky.zip"

git archive --format=zip --prefix=Docky/ -o "$tmpzip" HEAD -- "${INCLUDE[@]}" \
  || { red "git archive failed — are all allowlisted paths tracked at HEAD?"; exit 1; }

python3 - "$tmpzip" dist/index.js <<'PY' || { red "failed to inject dist/index.js."; exit 1; }
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "a", zipfile.ZIP_DEFLATED) as z:
    z.write(sys.argv[2], "Docky/dist/index.js")
PY

bold "Verifying…"
inspect "$tmpzip" || { red "Refusing to emit a zip that failed verification."; exit 1; }

if [ "$DO_LIST" -eq 1 ]; then
  echo
  bold "Contents:"
  python3 -c "
import sys, zipfile
for i in sorted(zipfile.ZipFile(sys.argv[1]).infolist(), key=lambda x: -x.compress_size):
    print('  %8.1f KB  %s' % (i.compress_size/1024, i.filename))
" "$tmpzip"
fi

mkdir -p "$(dirname "$OUT")" 2>/dev/null
mv -f "$tmpzip" "$OUT" || { red "Could not write $OUT"; exit 1; }
echo
grn "Wrote $OUT"
