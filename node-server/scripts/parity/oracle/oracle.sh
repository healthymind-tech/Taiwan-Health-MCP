#!/bin/bash
# The validator_cli 7.0.1 oracle of the parity harnesses. The host has no Java: every JVM runs in a throw-away container
# (validator image = JRE 21; the drivers are compiled once on the matching JDK image). One JVM at a time (flock).
#
#   oracle.sh setup                                     compile the drivers, create the work dir
#   oracle.sh fhirpath [out.json]                       FHIRPath suite -> jar results (fhirpath/run.ts --oracle)
#   oracle.sh suite [out.jsonl] [--only a,b]            official validator cases -> jar outcomes (testcases/run.ts --oracle)
#   oracle.sh validate <input...> [validator_cli options]   the CLI itself on your files, e.g.
#       oracle.sh validate my.json -ig tw.gov.mohw.twcore#1.0.0 -profile https://example.org/StructureDefinition/x
#     prints the OperationOutcome (JSON) on stdout; the CLI's log goes to stderr.
#
# Env: ORACLE_WORK (default ~/tools/validator-oracle), VALIDATOR_JAR (default ~/tools/validator-cli/validator_cli.jar),
# FHIR_TEST_CASES (default ~/ref/fhir-test-cases), HL7_CORE_SRC (default ~/ref/hl7-core-7.0.1), ORACLE_WAIT (lock wait, s),
# ORACLE_PACKAGES (a package cache to use instead of the work dir's: the first build of the OID indexes commits row by
# row and takes minutes per package on this disk, seconds on tmpfs).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${ORACLE_WORK:-$HOME/tools/validator-oracle}
JAR=${VALIDATOR_JAR:-$HOME/tools/validator-cli/validator_cli.jar}
TC=${FHIR_TEST_CASES:-$HOME/ref/fhir-test-cases}
CORE=${HL7_CORE_SRC:-$HOME/ref/hl7-core-7.0.1}
JDK_IMAGE=eclipse-temurin:21-jdk
JRE_IMAGE=taiwan-health-mcp-hl7-validator:latest
MIN_AVAILABLE_MB=4000
NAME=twh-jar-oracle-$$
TX_DIR=txCache/org.hl7.fhir.validation/4.0.1

# docker run with the limits of the parity brief; a watchdog stops the container when host memory runs short
jvm() {
  (
    while sleep 15; do
      if [ "$(free -m | awk '/Mem:/{print $7}')" -lt "$MIN_AVAILABLE_MB" ]; then
        echo "oracle: available memory under ${MIN_AVAILABLE_MB} MB, stopping $NAME" >&2
        docker stop -t 5 "$NAME" >/dev/null 2>&1 || true
        break
      fi
    done
  ) 8>&- &
  watchdog=$!
  trap 'kill "$watchdog" 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  docker run --rm --name "$NAME" --cpus=2 --memory=4g --cpu-shares=128 --user "$(id -u):$(id -g)" \
    -e HOME=/work/home -e TZ=UTC \
    -v "$JAR:/oracle/validator_cli.jar:ro" -v "$WORK:/work" -v "$TC:/tc:ro" -w /work/run \
    ${ORACLE_PACKAGES:+-v "$ORACLE_PACKAGES:/work/home/.fhir/packages"} \
    --entrypoint nice "$JRE_IMAGE" -n 19 \
    java -Xmx2800m -XX:+ExitOnOutOfMemoryError -Duser.home=/work/home -Djava.io.tmpdir=/work/tmp -Duser.timezone=UTC -Dfile.encoding=UTF-8 \
    -Dfhir.settings.path=/work/fhir-settings.json "$@"
}

with_lock() {
  exec 8>"$WORK/jvm.lock"
  flock -w "${ORACLE_WAIT:-7200}" 8 || { echo "oracle: another JVM holds the lock" >&2; exit 1; }
}

setup() {
  mkdir -p "$WORK"/{home/.fhir,tmp,run,classes,out,in}
  # the package cache needs write access for its locks and for packages a case still has to download
  [ -d "$WORK/home/.fhir/packages" ] || cp -r "$HOME/.fhir/packages" "$WORK/home/.fhir/packages"
  if [ ! -d "$WORK/$TX_DIR" ]; then
    mkdir -p "$(dirname "$WORK/$TX_DIR")"
    cp -r "$CORE/org.hl7.fhir.validation/src/test/resources/$TX_DIR" "$WORK/$TX_DIR"
  fi
  [ -f "$WORK/fhir-settings.json" ] || echo '{"txFhirDevelopment": "https://tx.fhir.org"}' >"$WORK/fhir-settings.json"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$JAR:/oracle/validator_cli.jar:ro" -v "$HERE/java:/src:ro" -v "$WORK/classes:/classes" \
    --entrypoint javac "$JDK_IMAGE" -nowarn -cp /oracle/validator_cli.jar -d /classes \
    /src/org/junit/jupiter/api/Assertions.java /src/oracle/SuiteOracle.java /src/oracle/FhirPathOracle.java
  echo "oracle: ready in $WORK"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  setup) setup ;;
  fhirpath)
    with_lock
    jvm -cp /work/classes:/oracle/validator_cli.jar oracle.FhirPathOracle --tc /tc --tx-cache "/work/$TX_DIR-fhirpath" --out /work/out/fhirpath-jar.json
    [ -z "${1:-}" ] || cp "$WORK/out/fhirpath-jar.json" "$1"
    echo "oracle: ${1:-$WORK/out/fhirpath-jar.json}"
    ;;
  suite)
    with_lock
    dest=""
    if [ -n "${1:-}" ] && [ "${1#--}" = "$1" ]; then dest=$1; shift; fi
    jvm -cp /work/classes:/oracle/validator_cli.jar oracle.SuiteOracle --tc /tc --tx-cache /work/txCache --out /work/out/suite-jar.jsonl "$@"
    [ -z "$dest" ] || cp "$WORK/out/suite-jar.jsonl" "$dest"
    echo "oracle: ${dest:-$WORK/out/suite-jar.jsonl}"
    ;;
  validate)
    with_lock
    job=$(mktemp -d "$WORK/in/job.XXXXXX")
    args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -*) args+=("$1"); shift; if [ $# -gt 0 ]; then args+=("$1"); shift; fi ;;
        *) cp "$1" "$job/"; args+=("/work/in/$(basename "$job")/$(basename "$1")"); shift ;;
      esac
    done
    jvm -jar /oracle/validator_cli.jar "${args[@]}" -version 4.0.1 -tx https://tx.fhir.org \
      -output "/work/in/$(basename "$job")/outcome.json" >&2 || true
    cat "$job/outcome.json"
    rm -rf "$job"
    ;;
  *) sed -n 2,15p "$0"; exit 2 ;;
esac
