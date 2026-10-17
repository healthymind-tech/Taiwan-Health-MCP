#!/bin/sh
# Validate a corpus with our in-process validator and compare with the oracle.
#
#   DATABASE_URL=postgresql://... ./run.sh corpus/examples.json.gz examples [-v]
#
# Writes $OUT_DIR/local_<tag>.json (ours), $OUT_DIR/cmp_<tag>.json/.txt (comparison).
# Oracle responses are cached in $ORACLE_CACHE (see harness/oracle.py); uncached
# items are sent to validator.dicom.tw sequentially.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT_DIR=${OUT_DIR:-/tmp/twh-validator-audit}
mkdir -p "$OUT_DIR"
CORPUS=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
TAG=$2
shift 2
: "${DATABASE_URL:?set DATABASE_URL (the staging DB with the IG packages loaded)}"
(cd "$HERE/../.." && node --import tsx scripts/validator-audit/localValidate.ts "$CORPUS" "$OUT_DIR/local_$TAG.json")
python3 -I "$HERE/harness/compare_local.py" "$CORPUS" "$OUT_DIR/local_$TAG.json" "$OUT_DIR/cmp_$TAG.json" "$@" > "$OUT_DIR/cmp_$TAG.txt"
head -20 "$OUT_DIR/cmp_$TAG.txt"
