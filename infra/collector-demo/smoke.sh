#!/bin/sh
# Self-contained collector-demo smoke test (ADR-0021, GATE 5).
#
# Brings up the demo stack (postgres + app + emulated printer + collector), waits for the
# collector to poll the printer twice and push a REAL SNMP utilisation signal outbound to the
# app, and asserts — directly against the database — that the signal landed on the seeded
# LAB-0005 asset and moved its utilisation. This is the headless proof of the same fact the UI
# shows on the asset detail page.
#
# Run from the repo root:  sh infra/collector-demo/smoke.sh
# Requires Docker + the compose plugin. CI runs this; it needs no external network.

set -eu

COMPOSE="docker compose -f infra/collector-demo/docker-compose.yml"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-240}"

cleanup() {
  echo "--- tearing down ---"
  $COMPOSE down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- bringing up the collector demo stack (building images) ---"
$COMPOSE up -d --build

psql() {
  $COMPOSE exec -T postgres psql -U oat -d oat -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

echo "--- waiting up to ${TIMEOUT_SECONDS}s for the collector to deliver an SNMP utilisation signal ---"
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  util=$(psql "select count(*) from signal_event where source='snmp' and type='utilisation'" || echo 0)
  active=$(psql "select count(*) from asset where tag='LAB-0005' and \"lastActiveAt\" is not null" || echo 0)

  if [ "${util:-0}" -ge 1 ] && [ "${active:-0}" -ge 1 ]; then
    echo ""
    echo "PASS: the collector delivered a real SNMP utilisation signal to LAB-0005."
    echo "      signal_event snmp/utilisation rows = ${util}; LAB-0005.lastActiveAt is set."
    exit 0
  fi

  echo "  ...not yet (utilisation rows=${util:-0}, lastActiveAt set=${active:-0}); waiting"
  sleep 5
done

echo ""
echo "FAIL: no collector-delivered SNMP utilisation signal on LAB-0005 within ${TIMEOUT_SECONDS}s."
echo "--- collector logs ---"
$COMPOSE logs collector | tail -50 || true
echo "--- app logs ---"
$COMPOSE logs app | tail -30 || true
exit 1
