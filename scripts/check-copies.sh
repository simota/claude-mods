#!/bin/sh
# Mods share no code, so a few files are copies of another mod's; each pair must stay identical.
set -eu
cd "$(dirname "$0")/.."
status=0
for pair in \
  'mods/done-gate/hooks/shell.ts mods/zukan/hooks/shell.ts' \
  'mods/done-gate/hooks/shell.ts mods/hit-rate/hooks/shell.ts' \
  'mods/done-gate/hooks/shell.ts mods/kachi/hooks/shell.ts' \
  'mods/zukan/hooks/mask.ts mods/side-effect-ledger/hooks/mask.ts' \
  'mods/zukan/hooks/mask.ts mods/artifact-shelf/hooks/mask.ts' \
  'mods/zukan/hooks/mask.ts mods/browser-cam/hooks/mask.ts' \
  'mods/zukan/hooks/mask.ts mods/stack-dock/hooks/mask.ts' \
  'mods/cross-check/hooks/fingerprint.ts mods/ci-rehearsal/hooks/fingerprint.ts'; do
  set -- $pair
  if ! cmp -s "$1" "$2"; then
    echo "check-copies: $2 differs from $1" >&2
    status=1
  fi
done
exit $status
