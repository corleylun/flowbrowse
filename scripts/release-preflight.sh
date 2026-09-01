#!/usr/bin/env bash
# Release preflight — verify every prerequisite the runbook merely ASSERTS.
#
# Written 2026-08-27 after a machine migration (Intel Mac -> Mac mini M4) silently broke three
# things at once, each discovered only mid-release:
#   1. node_modules/electron was the migrated x86_64 binary on an arm64 host  -> nothing would run
#   2. the build scripts pinned no arch, so they inherited the host's         -> shipped x64-only,
#      and would have silently flipped to arm64-only (breaking every Intel user)
#   3. the Developer ID signing identity did NOT migrate (private keys never do), though the
#      our notes claimed it was in the login keychain                           -> could not sign
#
# Run this BEFORE starting a release. It checks the machine, not the documentation.
#   ./scripts/release-preflight.sh          # build prerequisites
#   ./scripts/release-preflight.sh --sign   # also check signing + notarization credentials
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32mok  \033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n     -> %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mwarn\033[0m %s\n     -> %s\n' "$1" "$2"; WARN=$((WARN+1)); }

CHECK_SIGN=0
[ "${1:-}" = "--sign" ] && CHECK_SIGN=1

echo "== host =="
HOST_ARCH=$(uname -m)
NODE_ARCH=$(node -p "process.arch" 2>/dev/null || echo "?")
[ "$HOST_ARCH" = "arm64" ] && EXPECT_ARCH="arm64" || EXPECT_ARCH="x64"
if [ "$NODE_ARCH" = "$EXPECT_ARCH" ]; then ok "node is native ($NODE_ARCH on $HOST_ARCH)"
else bad "node arch $NODE_ARCH on $HOST_ARCH host" "node is not native; reinstall node for $EXPECT_ARCH"; fi

echo "== electron =="
EBIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ "$(uname -s)" = "Linux" ] && EBIN="node_modules/electron/dist/electron"
if [ ! -e "$EBIN" ]; then
  bad "electron binary missing" "npm install electron; if the postinstall is blocked, run: node node_modules/electron/install.js"
else
  BIN_ARCH=$(file -b "$EBIN" | grep -oE "arm64|x86_64" | head -1)
  case "$BIN_ARCH" in
    arm64)  BIN_NORM=arm64 ;;
    x86_64) BIN_NORM=x64 ;;
    *)      BIN_NORM="?" ;;
  esac
  if [ "$BIN_NORM" = "$EXPECT_ARCH" ]; then ok "electron binary is native ($BIN_ARCH)"
  else bad "electron binary is $BIN_ARCH but host is $HOST_ARCH" "rm -rf node_modules/electron && npm install electron@\$(node -p \"require('./package.json').devDependencies.electron.replace('^','')\")"; fi

  WANT_EV=$(node -p "(require('./package.json').devDependencies.electron||'').replace(/[^0-9.]/g,'')" 2>/dev/null)
  GOT_EV=$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || echo "?")
  if [ -n "$WANT_EV" ] && [ "$WANT_EV" = "$GOT_EV" ]; then ok "electron version matches package.json ($GOT_EV)"
  else warn "electron installed $GOT_EV, package.json wants $WANT_EV" "run npm install to reconcile"; fi
fi

echo "== build scripts pin an architecture =="
# The migration trap: an unpinned script silently builds for whatever the host happens to be.
for s in dist:mac dist:mac:signed; do
  if node -p "require('./package.json').scripts['$s']||''" | grep -q -- "--universal"; then ok "$s pins --universal"
  else bad "$s does not pin an arch" "add --universal, or it builds for the host arch only"; fi
done
if node -p "require('./package.json').scripts['dist:linux']||''" | grep -q -- "--x64"; then ok "dist:linux pins --x64"
else bad "dist:linux does not pin an arch" "add --x64, or an arm64 host produces arm64 Linux artifacts nobody downloads"; fi

echo "== rosetta (needed to build the Linux AppImage on Apple Silicon) =="
# electron-builder shells out to appimagetool, which ships as an x86_64 binary. On an arm64 Mac
# without Rosetta that spawn fails with errno -86 (EBADARCH) and ONLY the AppImage target dies —
# the tar.gz still builds, so a piped build can look like it succeeded. Hit 2026-08-27.
if [ "$HOST_ARCH" = "arm64" ]; then
  if [ -d /Library/Apple/usr/libexec/oah ]; then ok "Rosetta present (appimagetool can run)"
  else warn "Rosetta not installed - the AppImage target will fail with errno -86" "softwareupdate --install-rosetta --agree-to-license (the tar.gz target is unaffected)"; fi
else ok "native x86_64 host (appimagetool runs directly)"; fi

if [ "$CHECK_SIGN" = "1" ]; then
  echo "== signing identity =="
  IDS=$(security find-identity -v -p codesigning 2>/dev/null)
  if printf '%s' "$IDS" | grep -q "Developer ID Application"; then
    ok "Developer ID Application identity present"
    # Expiry: a cert that dies mid-release is the same surprise, later.
    SHA=$(printf '%s' "$IDS" | grep "Developer ID Application" | head -1 | awk '{print $2}')
    END=$(security find-certificate -c "Developer ID Application" -p 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -n "$END" ]; then
      END_S=$(date -j -f "%b %d %T %Y %Z" "$END" +%s 2>/dev/null || echo 0)
      NOW_S=$(date +%s); DAYS=$(( (END_S - NOW_S) / 86400 ))
      if [ "$END_S" != "0" ] && [ "$DAYS" -lt 30 ]; then warn "signing cert expires in $DAYS days ($END)" "reissue in Xcode -> Accounts -> Manage Certificates"
      elif [ "$END_S" != "0" ]; then ok "signing cert valid for $DAYS more days"; fi
    fi
    printf '       %s\n' "$SHA"
  else
    bad "no Developer ID Application identity in the keychain search list" \
        "Xcode -> Settings -> Accounts -> [your Developer ID team] -> Manage Certificates -> + -> Developer ID Application. NOTE: private keys do NOT survive Migration Assistant, and an iCloud-keychain import is invisible to codesign - it must be the LOGIN keychain."
  fi

  echo "== notarization credentials =="
  # Presence only - never print a value.
  for v in APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
    if [ -n "${!v:-}" ]; then ok "$v is set"
    else bad "$v is not set" "export it for this shell; app-specific passwords cannot be retrieved, only regenerated at appleid.apple.com"; fi
  done
  if xcrun --find notarytool >/dev/null 2>&1; then ok "notarytool available"
  else bad "notarytool not found" "install Xcode (not just the Command Line Tools)"; fi
fi

echo
printf 'preflight: %d ok, %d warn, %d FAIL\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "Fix the failures above before releasing."; exit 1; }
