#!/usr/bin/env bash
# Smoke test of the container image with the hardened flags from docker-compose.yml (stdlib tools + Docker only).
#   tests/docker_smoke.sh [image]        (default cloudy:local; uses port 18080 and throwaway containers/volumes)
# Checks: starts with only PUID/PGID + admin env, every process runs as PUID with no capabilities, sign-in works
# over plain HTTP, a second start on the existing database works, docker stop is clean, a missing capability gives
# a clear error, and an old .env (APP_USER, ADMIN_USER, ADMIN_PASSWORD, default capabilities) still works.
set -euo pipefail

IMAGE=${1:-cloudy:local}
NAME=cloudy-smoke
PORT=18080
HARDENED=(--security-opt no-new-privileges:true --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID)
failed=0

ok() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; failed=1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$NAME-data" "$NAME-db" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start() { # start <extra docker run args...>
  cleanup
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$NAME-data:/data" -v "$NAME-db:/var/lib/cloudy/db" "$@" "$IMAGE" >/dev/null
}

healthy() { # waits until /status answers (or the container stops)
  for _ in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null 2>&1 && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || return 1
    sleep 1
  done
  return 1
}

signin() { # signin <user> <password>: signs in over HTTP, then reads /api/me with the cookie
  local jar headers
  jar=$(mktemp); headers=$(mktemp)
  curl -fsS -c "$jar" -D "$headers" -o /dev/null -H 'Content-Type: application/json' -H 'X-Cloudy-Request: 1' \
    -d "{\"user\":\"$1\",\"password\":\"$2\"}" "http://127.0.0.1:$PORT/api/login" &&
    ! grep -qi '^set-cookie:.*secure' "$headers" &&
    curl -fsS -b "$jar" -o /dev/null "http://127.0.0.1:$PORT/api/me"
  local rc=$?
  rm -f "$jar" "$headers"
  return $rc
}

as_puid() { # as_puid <uid>: tini (process 1), node and postgres run as <uid> with no effective/permitted capabilities
  local out
  # ([.] keeps the pattern from matching this sh -c command line itself)
  out=$(docker exec "$NAME" sh -c 'for p in $(pgrep -x tini) $(pgrep -f "/app/src/server[.]ts") $(pgrep -x postgres); do
    grep -E "^(Uid|CapEff|CapPrm|CapAmb):" /proc/$p/status; done') || return 1
  [ "$(grep -c '^Uid:' <<<"$out")" -ge 3 ] || return 1
  [ -z "$(grep '^Uid:' <<<"$out" | grep -vE "^Uid:[[:space:]]+$1([[:space:]]+$1){3}$" || true)" ] || return 1
  [ -z "$(grep -E '^Cap(Eff|Prm|Amb):' <<<"$out" | grep -v '0000000000000000$' || true)" ] || return 1
  [ "$(docker exec "$NAME" awk '/^Name:/ {print $2}' /proc/1/status)" = tini ]
}

echo "== hardened, PUID/PGID 1234, only the required env"
start "${HARDENED[@]}" -e PUID=1234 -e PGID=1234 -e CLOUDY_ADMIN_USERNAME=admin -e CLOUDY_ADMIN_PASSWORD=smoke-admin-password
if healthy; then ok "starts"; else fail "starts"; docker logs "$NAME" | tail -30; exit 1; fi
if as_puid 1234; then ok "runs as 1234 with no capabilities, tini is process 1"; else fail "runs as PUID without capabilities"; fi
if signin admin smoke-admin-password; then ok "sign-in over HTTP (cookie not Secure)"; else fail "sign-in over HTTP"; fi
docker restart "$NAME" >/dev/null
if healthy && signin admin smoke-admin-password; then ok "second start on the existing database"; else fail "second start"; docker logs "$NAME" | tail -30; fi
t0=$(date +%s)
docker stop "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$code" = 0 ] && [ $(($(date +%s) - t0)) -lt 9 ] && grep -q '\[cloudy\] stopping' <<<"$logs"; then
  ok "docker stop shuts down cleanly"
else
  fail "docker stop (exit $code)"
fi

expect_error() { # expect_error <text> <description> <docker run args...>: the container stops with <text> in its log
  local text=$1 what=$2 logs
  shift 2
  cleanup
  docker run -d --name "$NAME" -v "$NAME-data:/data" -v "$NAME-db:/var/lib/cloudy/db" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || break; sleep 1; done
  logs=$(docker logs "$NAME" 2>&1)
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && grep -qF "$text" <<<"$logs"; then ok "$what"; else fail "$what"; tail -5 <<<"$logs"; fi
}

echo "== refusals with a clear message"
CAPS_MSG='needs the CHOWN, SETUID and SETGID capabilities'
expect_error "$CAPS_MSG" "no cap_add (PUID 1000)" --security-opt no-new-privileges:true --cap-drop ALL
expect_error "$CAPS_MSG" "no cap_add (PUID 1234, before useradd)" --security-opt no-new-privileges:true --cap-drop ALL -e PUID=1234 -e PGID=1234
expect_error "$CAPS_MSG" "CHOWN missing" --security-opt no-new-privileges:true --cap-drop ALL --cap-add SETUID --cap-add SETGID -e PUID=1234 -e PGID=1234
expect_error 'DATA_PATH=/mnt/cloudy is set in .env' "old .env with a custom DATA_PATH" "${HARDENED[@]}" -e DATA_PATH=/mnt/cloudy

echo "== example password is never used"
start "${HARDENED[@]}" -e CLOUDY_ADMIN_PASSWORD=change-me-to-a-long-password -e DATA_PATH=app-data -e APP_PORT=8080
if healthy && ! signin admin change-me-to-a-long-password 2>/dev/null && grep -q 'Generated admin password' <<<"$(docker logs "$NAME" 2>&1)"; then
  ok "random password instead of the example (old default DATA_PATH/APP_PORT only noted)"
else
  fail "example password"
fi

echo "== old .env names, default capabilities"
start -e APP_USER=1000:1000 -e ADMIN_USER=oldadmin -e ADMIN_PASSWORD=smoke-old-password
if healthy && signin oldadmin smoke-old-password; then ok "APP_USER / ADMIN_USER / ADMIN_PASSWORD still work"; else fail "old .env names"; docker logs "$NAME" | tail -30; fi
if as_puid 1000; then ok "runs as 1000 with no capabilities"; else fail "old .env: runs as APP_USER"; fi

if [ $failed != 0 ]; then echo "docker smoke test FAILED"; exit 1; fi
echo "docker smoke test passed"
