#!/bin/sh
# A Dak.app other people's Macs open without a warning: signed with a Developer ID,
# notarized by Apple, the ticket stapled, zipped for a GitHub release.
#
# Needs an Apple Developer account (paid) and two things set up once:
#   1. A "Developer ID Application" certificate in your login keychain.
#   2. A notarytool profile: xcrun notarytool store-credentials dak-notary \
#        --apple-id you@example.com --team-id ABCDE12345 --password <app-specific password>
#
# Then:  DAK_SIGN_ID="Developer ID Application: Your Name (ABCDE12345)" sh mac/release.sh
set -e
cd "$(dirname "$0")"
: "${DAK_SIGN_ID:?Set DAK_SIGN_ID to your Developer ID Application identity (security find-identity -v -p codesigning lists it).}"
PROFILE="${DAK_NOTARY_PROFILE:-dak-notary}"

sh build.sh   # builds mac/Dak.app with an ad-hoc signature
APP="$PWD/Dak.app"

# The bundled dak binary is signed first, then the app around it. Hardened runtime is
# required for notarization; Bun's compiled binary needs JIT, hence the entitlement.
ENT="$PWD/.build/dak.entitlements"
cat > "$ENT" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
XML
codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$DAK_SIGN_ID" "$APP/Contents/Resources/dak"
codesign --force --options runtime --timestamp --sign "$DAK_SIGN_ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"

ZIP="$PWD/Dak.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
spctl --assess --type execute --verbose "$APP"
echo "Ready to publish: $ZIP"
