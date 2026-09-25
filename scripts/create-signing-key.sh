#!/usr/bin/env bash
# Creates the permanent Android release signing key for HSN AutoReply and (optionally)
# uploads it to GitHub Secrets with the GitHub CLI. Run it ONCE on your own computer.
#
#   bash scripts/create-signing-key.sh  [owner/repo]
#
# Requirements: keytool (any JDK 17+), openssl, and optionally `gh` (logged in).
# Nothing secret is printed. The key is written OUTSIDE the repository.
set -euo pipefail

REPO="${1:-}"
DIR="${HSN_SIGNING_DIR:-$HOME/hsn-autoreply-signing}"
KS="$DIR/hsn-autoreply-release.jks"
ALIAS="hsn-autoreply"

if [ -e "$KS" ]; then
  echo "Keystore already exists at $KS — refusing to overwrite (changing the key breaks app updates)."
  exit 1
fi
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

PASS="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)"
keytool -genkeypair -v -keystore "$KS" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=HSN AutoReply, O=HSN, C=YE" >/dev/null 2>&1

printf '%s' "$PASS" > "$DIR/keystore-password.txt"
keytool -list -v -keystore "$KS" -storepass "$PASS" | grep -E "SHA256:" | head -1 > "$DIR/certificate-sha256.txt"

echo "✔ Keystore created: $KS"
echo "✔ Password saved to: $DIR/keystore-password.txt (store/key password are identical)"
echo "✔ Certificate fingerprint: $(cat "$DIR/certificate-sha256.txt")"

if command -v gh >/dev/null 2>&1 && [ -n "$REPO" ]; then
  base64 < "$KS" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
  printf '%s' "$PASS" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO"
  printf '%s' "$PASS" | gh secret set ANDROID_KEY_PASSWORD --repo "$REPO"
  printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo "$REPO"
  echo "✔ GitHub Secrets set on $REPO"
else
  echo "ℹ Add these GitHub Secrets manually (Settings › Secrets and variables › Actions):"
  echo "   ANDROID_KEYSTORE_BASE64 = output of: base64 -w0 \"$KS\""
  echo "   ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD = contents of keystore-password.txt"
  echo "   ANDROID_KEY_ALIAS = $ALIAS"
fi
echo
echo "⚠ BACK UP the folder $DIR to two safe places (e.g. an encrypted USB drive + a password manager)."
echo "  If this key is lost, installed apps can never be updated — users would have to uninstall first."
