#!/bin/sh
# Install Dak: the `dak` command and the Dak app, from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/personaflowai/dak/main/install.sh | sh
# Options (environment): DAK_NO_APP=1 installs only the command; DAK_BIN_DIR picks where it goes.
set -e
REPO="personaflowai/dak"
BIN_DIR="${DAK_BIN_DIR:-$HOME/.local/bin}"
case "$(uname -s)" in Darwin) ;; *) echo "Dak runs on macOS only for now." >&2; exit 1 ;; esac
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Unsupported Mac: $(uname -m)" >&2; exit 1 ;; esac
BASE="https://github.com/$REPO/releases/latest/download"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "Downloading Dak for $ARCH…"
curl -fsSL "$BASE/dak-darwin-$ARCH" -o "$TMP/dak"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
(cd "$TMP" && grep " dak-darwin-$ARCH\$" SHA256SUMS | sed "s/dak-darwin-$ARCH/dak/" | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch; not installing." >&2; exit 1; }
mkdir -p "$BIN_DIR"
install -m 0755 "$TMP/dak" "$BIN_DIR/dak"
echo "Installed $BIN_DIR/dak"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to your PATH, e.g.: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;; esac

if [ -z "$DAK_NO_APP" ]; then
  curl -fsSL "$BASE/Dak-macos-$ARCH.zip" -o "$TMP/Dak.zip"
  (cd "$TMP" && grep " Dak-macos-$ARCH.zip\$" SHA256SUMS | sed "s/Dak-macos-$ARCH.zip/Dak.zip/" | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch; not installing the app." >&2; exit 1; }
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Dak.app"
  ditto -x -k "$TMP/Dak.zip" "$HOME/Applications"
  # The app is not notarized yet, so macOS would refuse to open a downloaded copy. You
  # chose to install it by running this script; this clears the download flag on it only.
  xattr -dr com.apple.quarantine "$HOME/Applications/Dak.app" 2>/dev/null || true
  echo "Installed $HOME/Applications/Dak.app"
fi

"$BIN_DIR/dak" --version
echo "Next: open Dak (it walks you through connecting your agents), or run: dak help"
