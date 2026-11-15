#!/bin/bash
# VALIDATOR_IG   package#version loaded into this validator (required)
# VALIDATOR_TX   terminology server (default https://tx.fhir.org; "n/a" = none)
# JAVA_XMX       heap (default 2048m) — with a 3 GB container: the JVM commits the whole heap under load and needs
#                ~0.6 GB more (metaspace, code, threads, buffers); 2400m left ~30 MB (v22 G3c, PAS: RSS 2.97 / 3 GB)
# WARM_MAX       IG example resources validated before the service reports ready (default 40; 0 = no warm-up)
# WATCHDOG_FAILS consecutive unanswered HTTP probes (30 s apart, 20 s each) before the JVM is killed (default 5)
# JAVA_EXTRA     more JVM options (appended)
#
# JVM memory (v22 G3c): the heap is bounded by -Xmx; an OutOfMemoryError exits the JVM (the restart policy brings a
# fresh one) instead of leaving a half-dead server; G1 returns idle heap to the OS (periodic GC every 5 min), so the
# container's RSS is not the high-water mark of a busy hour; metaspace is capped. GC log: /tmp/gc.log (2 x 10 MB,
# rotated; docker exec <container> cat /tmp/gc.log) has the live heap after each GC - the way to tell heap growth
# from reservation. The app also recycles each validator after OFFICIAL_VALIDATOR_RECYCLE_HOURS (draining it first).
#
# validator_cli's HTTP server handles one request at a time: a request stuck in terminology work (seen 2026-11-01:
# codeInValueSet over a large ValueSet, "Operation took too long") leaves the process alive but deaf, and Docker does
# not restart an unhealthy container. The watchdog kills the JVM then, so the restart policy brings a fresh one.
# Readiness (/tmp/validator-ready, checked by the healthcheck) is set only after the warm-up, so the app's
# depends_on: service_healthy waits for a validator with a warm terminology cache.
set -u
: "${VALIDATOR_IG:?VALIDATOR_IG (package#version) is required}"
PORT=8080
READY=/tmp/validator-ready
rm -f "$READY"

# shellcheck disable=SC2086 # JAVA_EXTRA is a list of options
java "-Xmx${JAVA_XMX:-2048m}" -XX:+ExitOnOutOfMemoryError -XX:MaxMetaspaceSize=512m -XX:G1PeriodicGCInterval=300000 \
  "-Xlog:gc:file=/tmp/gc.log:uptime:filecount=2,filesize=10m" ${JAVA_EXTRA:-} \
  -jar /opt/validator/validator_cli.jar server "$PORT" -allowNetworkAccess \
  -version 4.0.1 -ig "${VALIDATOR_IG}" -tx "${VALIDATOR_TX:-https://tx.fhir.org}" &
JPID=$!
trap 'kill -TERM "$JPID" 2>/dev/null; wait "$JPID"; exit 0' TERM INT

# any HTTP status line within $1 seconds
probe() {
  # (a bare `exec … 2>/dev/null` would silence the whole script's stderr: redirect only the open)
  { exec 3<>"/dev/tcp/127.0.0.1/$PORT"; } 2>/dev/null || return 1
  printf 'GET /version HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
  local line rc
  IFS= read -r -t "$1" line <&3
  rc=$?
  exec 3>&- 3<&-
  [[ $rc -eq 0 && $line == HTTP/* ]]
}

# POST one resource to /validateResource, waiting at most $2 seconds for the status line
validate_file() {
  local len
  len=$(wc -c <"$1")
  # (a bare `exec … 2>/dev/null` would silence the whole script's stderr: redirect only the open)
  { exec 3<>"/dev/tcp/127.0.0.1/$PORT"; } 2>/dev/null || return 1
  {
    printf 'POST /validateResource HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/fhir+json\r\nAccept: application/fhir+json\r\nContent-Length: %s\r\n\r\n' "$len"
    cat "$1"
  } >&3
  local line rc
  IFS= read -r -t "$2" line <&3
  rc=$?
  exec 3>&- 3<&-
  return $rc
}

until probe 5; do
  kill -0 "$JPID" 2>/dev/null || { wait "$JPID"; exit 1; }
  sleep 3
done

# warm-up: the IG's own examples (its codes, ValueSets and terminology calls), then ready
dir="/root/.fhir/packages/${VALIDATOR_IG}/package"
n=0 t0=$(date +%s)
for f in "$dir"/example/*.json "$dir"/*.json; do
  [ -f "$f" ] || continue
  [ "$n" -ge "${WARM_MAX:-40}" ] && break
  case "$(basename "$f")" in package.json | .index.json | StructureDefinition-* | ValueSet-* | CodeSystem-* | ImplementationGuide-* | SearchParameter-* | CapabilityStatement-* | OperationDefinition-* | ConceptMap-* | NamingSystem-*) continue ;; esac
  validate_file "$f" 300 || true
  n=$((n + 1))
done
echo "hl7-validator: warm-up done (${n} example resources, $(($(date +%s) - t0)) s); ready" >&2
touch "$READY"

fails=0
while kill -0 "$JPID" 2>/dev/null; do
  sleep 30 &
  wait $!
  if probe 20; then
    fails=0
  else
    fails=$((fails + 1))
    echo "hl7-validator watchdog: no HTTP answer (${fails}/${WATCHDOG_FAILS:-5})" >&2
  fi
  if [ "$fails" -ge "${WATCHDOG_FAILS:-5}" ]; then
    echo "hl7-validator watchdog: the validator stopped answering; killing it so the container restarts" >&2
    kill -9 "$JPID" 2>/dev/null
    exit 1
  fi
done
wait "$JPID"
exit $?
