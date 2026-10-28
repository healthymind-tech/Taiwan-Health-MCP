#!/bin/sh
# ops-v1 O5: run a development / test command inside a memory- and CPU-capped cgroup scope, so it is
# OOM-killed on its own instead of starving the production containers that share this host.
#
#   scripts/dev/run-limited.sh <command> [args...]
#   DEV_MEM_MAX=3G DEV_CPU_QUOTA=150% scripts/dev/run-limited.sh npm run typecheck
#
# Defaults: 4G memory, no swap, 200% CPU (two cores), nice 10. Needs systemd user scopes
# (systemd-run --user); without them it refuses rather than running uncapped.
set -e
MEM=${DEV_MEM_MAX:-4G}
CPU=${DEV_CPU_QUOTA:-200%}
if ! systemd-run --user --scope --quiet -p MemoryMax=16M true 2>/dev/null; then
  echo "run-limited: systemd user scopes are unavailable; not running uncapped" >&2
  exit 2
fi
exec systemd-run --user --scope --quiet -p MemoryMax="$MEM" -p MemorySwapMax=0 -p CPUQuota="$CPU" nice -n 10 "$@"
