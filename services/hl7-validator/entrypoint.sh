#!/bin/sh
# VALIDATOR_IG   package#version loaded into this validator (required)
# VALIDATOR_TX   terminology server (default https://tx.fhir.org; "n/a" = none)
# JAVA_XMX       heap (default 2400m) — keep below the container's mem_limit
set -eu
: "${VALIDATOR_IG:?VALIDATOR_IG (package#version) is required}"
exec java "-Xmx${JAVA_XMX:-2400m}" -jar /opt/validator/validator_cli.jar server 8080 -allowNetworkAccess \
  -version 4.0.1 -ig "${VALIDATOR_IG}" -tx "${VALIDATOR_TX:-https://tx.fhir.org}"
