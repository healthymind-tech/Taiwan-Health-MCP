#!/bin/bash
# One command for any IG corpus: differential comparison with the official answers + release simulation.
#   scripts/parity/corpus/measure.sh --ig us-core,ch-core --tag first [--commit <rev>] [--corrections file] [--shards 4] [--blind]
# Corpus layout: ~/ref/parity_corpus/<ig>/ (manifest.jsonl + *.official.json). Runs against the measurement database (55432),
# from a detached worktree at <rev> (default HEAD), so later commits don't touch the run. A shard killed by its memory cap
# resumes from what it wrote. Output: ~/tools/validator-oracle/corpus/<tag>/report.md.
# --blind: the first measurement of an IG is its blind score: it is appended to mcp_proposal/parity_v3/blind_scores.md
# and an IG already in that file is refused.
set -u
# the main checkout (also when started from a worktree: .env and the private ledger live there)
REPO=$(cd "$(git -C "$(dirname "$0")" rev-parse --git-common-dir)/.." && pwd)
IGS=""; TAG=""; REV=HEAD; CORR=""; SHARDS=4; BLIND=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ig) IGS=$2; shift 2 ;; --tag) TAG=$2; shift 2 ;; --commit) REV=$2; shift 2 ;;
    --corrections) CORR=$2; shift 2 ;; --shards) SHARDS=$2; shift 2 ;; --blind) BLIND=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[ -n "$IGS" ] && [ -n "$TAG" ] || { sed -n 2,7p "$0"; exit 2; }
ROOT=${PARITY_CORPUS:-$HOME/ref/parity_corpus}
OUT=$HOME/tools/validator-oracle/corpus/$TAG
LEDGER=$REPO/mcp_proposal/parity_v3/blind_scores.md
# one worktree per run: two measurements at once never share a checkout
WT=$HOME/tools/validator-oracle/measure-wt/$TAG
if [ $BLIND = 1 ]; then
  for ig in ${IGS//,/ }; do
    if grep -q "^## blind: $ig " "$LEDGER" 2>/dev/null; then echo "refusing: $ig already has its blind score in $LEDGER"; exit 3; fi
  done
fi
[ -e "$OUT" ] && { echo "refusing: $OUT exists"; exit 3; }
mkdir -p "$OUT/src"
for ig in ${IGS//,/ }; do
  [ -f "$ROOT/$ig/manifest.jsonl" ] || { echo "no corpus at $ROOT/$ig"; exit 2; }
  ln -sfn "$ROOT/$ig" "$OUT/src/$ig"
done
COMMIT=$(git -C "$REPO" rev-parse --short "$REV") || exit 2
mkdir -p "$(dirname "$WT")"
[ -e "$WT/.git" ] || git -C "$REPO" worktree add -q --detach "$WT" "$COMMIT" || exit 2
git -C "$WT" checkout -q --detach "$COMMIT" || exit 2
ln -sfn "$REPO/node-server/node_modules" "$WT/node-server/node_modules"
PW=$(grep '^POSTGRES_PASSWORD=' "$REPO/.env" | cut -d= -f2-)
export DATABASE_URL="postgresql://mcp:${PW}@127.0.0.1:55432/taiwan_health" LOG_LEVEL=error
cd "$WT/node-server" || exit 2
run_shard() {
  local k=$1 try=0 excl=""
  while [ $try -lt 4 ]; do
    systemd-run --user --scope -q -p MemoryMax=3G -p CPUQuota=150% nice -n 10 \
      node --max-old-space-size=2500 --import tsx scripts/parity/corpus/run.ts "$OUT/src" --raw-text --shard "$k/$SHARDS" \
      ${excl:+--exclude-from "$excl"} --json "$OUT/shard$k.$try.json" > "$OUT/shard$k.$try.log" 2>&1 && return 0
    excl="${excl:+$excl,}$OUT/shard$k.$try.json"; try=$((try + 1))
  done
  echo "shard $k failed $try times"
}
for k in $(seq 0 $((SHARDS - 1))); do run_shard "$k" & done
wait
node --max-old-space-size=12000 --import tsx scripts/parity/corpus/report.ts "$OUT"/shard*.json ${CORR:+--corrections "$CORR"} --commit "$COMMIT" \
  --md "$OUT/report.md" --plan "$OUT/plan.json" --top 30 --cmd "measure.sh --ig $IGS --tag $TAG --commit $COMMIT${CORR:+ --corrections $CORR}" > "$OUT/report.log" 2>&1
sed -n '/^## Per-IG/,/^## All corpus/p;/^## Release simulation/,/^Unsafe/p' "$OUT/report.md" | cut -d'|' -f2-13 | cut -c1-150
echo "report: $OUT/report.md (code $COMMIT)"
git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
if [ $BLIND = 1 ]; then
  for ig in ${IGS//,/ }; do
    { echo; echo "## blind: $ig (code $COMMIT, $(date -u +%FT%TZ), first measurement, not to be changed)"; grep -E "^\| ($ig|IG) " "$OUT/report.md"; } >> "$LEDGER"
  done
fi
