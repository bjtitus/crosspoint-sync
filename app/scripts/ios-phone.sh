#!/bin/sh
# Build a debug-signed IPA and install + launch it on the connected iPhone.
set -e
cd "$(dirname "$0")/.."
# A paired iPhone, the connected one first (devicectl can reach a paired, unplugged
# phone over Wi-Fi when it's unlocked).
device=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | jq -r '[.result.devices[]
  | select(.hardwareProperties.reality == "physical" and .hardwareProperties.deviceType == "iPhone"
      and .connectionProperties.pairingState == "paired")]
  | sort_by(.connectionProperties.tunnelState != "connected")[0].identifier // empty')
[ -n "$device" ] || { echo "No paired iPhone found." >&2; exit 1; }
npx tauri ios build --export-method debugging
xcrun devicectl device install app --device "$device" "src-tauri/gen/apple/build/arm64/CrossPoint Sync.ipa"
xcrun devicectl device process launch --terminate-existing --device "$device" com.crosspointreader.sync
