#!/bin/sh
# Builds Dak.app: the Swift shell plus the dak binary inside it.
# Light on purpose: one Swift file and one Bun compile, no Xcode project.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

# DAK_ARCH=arm64|x64 builds for that chip (a release builds both); left out, this Mac's own.
if [ -n "$DAK_ARCH" ]; then
  SWIFT_ARCH=$([ "$DAK_ARCH" = "x64" ] && echo x86_64 || echo arm64)
  (cd "$ROOT" && bun run build:release >/dev/null)
  DAK_BIN="$ROOT/dist/release/dak-darwin-$DAK_ARCH"
  SWIFT_FLAGS="--arch $SWIFT_ARCH"
else
  (cd "$ROOT" && bun run build >/dev/null)
  DAK_BIN="$ROOT/dist/dak"
  SWIFT_FLAGS=""
fi
swift build -c release --product Dak $SWIFT_FLAGS 2>&1 | grep -E "error|warning: unre|Compiling|Build complete" || true

VERSION=$(cd "$ROOT" && bun -e 'console.log(require("./package.json").version)')
APP="$PWD/Dak.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$(swift build -c release $SWIFT_FLAGS --show-bin-path)/Dak" "$APP/Contents/MacOS/Dak"
cp "$DAK_BIN" "$APP/Contents/Resources/dak"
cp "$PWD/Dak.icns" "$APP/Contents/Resources/Dak.icns"
# macOS 26 takes an app's icon from its compiled asset catalog (CFBundleIconName) in places
# such as notifications; the .icns stays as the fallback. actool comes with Xcode.
ICON_NAME=""
if xcrun --find actool >/dev/null 2>&1; then
  xcrun actool "$PWD/Assets.xcassets" --compile "$APP/Contents/Resources" --platform macosx \
    --minimum-deployment-target 13.0 --app-icon AppIcon --output-partial-info-plist "$PWD/.build/icon-partial.plist" >/dev/null 2>&1 \
    && ICON_NAME="<key>CFBundleIconName</key><string>AppIcon</string>"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Dak</string>
  <key>CFBundleDisplayName</key><string>Dak</string>
  <key>CFBundleIdentifier</key><string>dev.dak.app</string>
  <key>CFBundleExecutable</key><string>Dak</string>
  <key>CFBundleIconFile</key><string>Dak</string>
  $ICON_NAME
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# Ad-hoc signature: enough for notifications on this Mac. Distribution needs a real one.
# The explicit requirement names the app by its identifier, not by this build's hash, so
# macOS remembers a permission you grant (reading ~/Documents for Ask, notifications)
# across rebuilds instead of asking again after each one.
codesign --force --deep --sign - -r='designated => identifier "dev.dak.app"' "$APP" >/dev/null 2>&1
echo "Built $APP"

# --install puts it in ~/Applications, so Spotlight, Launchpad and the Dock find it.
if [ "$1" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  # The app ID changed from dev.dak.inbox to dev.dak.app (15 Nov 2026: a fresh record in
  # Notification Center, which had kept a blank icon). Carry the app's saved data across once:
  # reading places, Reviewed ticks, draft comments and unsent replies live in WebKit's store.
  osascript -e 'tell application id "dev.dak.inbox" to quit' >/dev/null 2>&1 && sleep 2 || true
  # A running Dak keeps serving its old copy; it restarts on the next open.
  for d in WebKit HTTPStorages; do
    if [ -d "$HOME/Library/$d/dev.dak.inbox" ] && [ ! -e "$HOME/Library/$d/dev.dak.app" ]; then
      cp -R "$HOME/Library/$d/dev.dak.inbox" "$HOME/Library/$d/dev.dak.app"
    fi
  done
  rm -rf "$HOME/Applications/Dak.app"
  cp -R "$APP" "$HOME/Applications/Dak.app"
  touch "$HOME/Applications/Dak.app"
  # One copy per app ID: macOS takes the notification icon from whichever copy it has on
  # record, so the build copy is unregistered and removed, and the installed one re-read.
  LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  "$LSR" -u "$APP" >/dev/null 2>&1 || true
  rm -rf "$APP"
  "$LSR" -f "$HOME/Applications/Dak.app" >/dev/null 2>&1 || true
  echo "Installed $HOME/Applications/Dak.app"
fi
