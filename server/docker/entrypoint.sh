#!/bin/sh
# Cloudy all-in-one entrypoint: runs PostgreSQL and the Cloudy server in one container.
#
# Started as root (the normal case), it only prepares: names the PUID:PGID user, gives Cloudy's folders to it,
# then starts itself again as PUID:PGID with no capabilities left, under tini as process 1. Everything after that,
# including stopping and supervising the processes, runs as that user. The root part needs CHOWN, SETUID and
# SETGID (docker-compose.yml adds exactly these). Started as non-root (docker run --user), it runs directly.
#
# Environment (usually from .env):
#   PUID / PGID   user and group both processes run as (default 1000; APP_USER=uid:gid from older .env files still works)
#   DATABASE_URL  use an external PostgreSQL instead of the embedded one
#   DB_DIR        embedded database folder (default /var/lib/cloudy/db; keep it on a local disk)
#   DATA_DIR      Cloudy's files (default /data; may be an NFS mount)
set -eu

APP_USER=${APP_USER:-1000:1000}
UID_=${PUID:-${APP_USER%%:*}}
GID_=${PGID:-${APP_USER##*:}}
DB_DIR=${DB_DIR:-/var/lib/cloudy/db}
DATA_DIR=${DATA_DIR:-/data}
SOCK_DIR=/run/cloudy
PG_MAJOR=17
PG_BIN=/usr/lib/postgresql/$PG_MAJOR/bin
CAPS="the container needs the CHOWN, SETUID and SETGID capabilities at startup (in docker-compose.yml: cap_add: [CHOWN, SETUID, SETGID])"
export DATA_DIR

log() { echo "[cloudy] $*"; }
die() { echo "[cloudy] ERROR: $*" >&2; exit 1; }

# Gives a folder (and everything in it) to PUID:PGID, unless it already belongs to them.
own() {
  [ "$(stat -c %u:%g "$1")" != "$UID_:$GID_" ] || return 0
  log "giving $1 to $UID_:$GID_"
  chown -R "$UID_:$GID_" "$1"
}

# An older .env next to the short docker-compose.yml (env_file passes it in; the old compose files never did): these
# folders now come from the volumes lines, so a custom one would start on empty storage or a new, empty database.
# The old defaults (app-data, db-data) are the volumes the short file uses, so they only get a note.
if [ -z "${CLOUDY_PREPARED:-}" ]; then
  for old in DATA_PATH:app-data DB_PATH:db-data APP_PORT:8080 APP_BIND:0.0.0.0; do
    name=${old%%:*}
    eval "val=\${$name:-}"
    if [ -z "$val" ] || [ "$val" = "${old#*:}" ]; then
      [ -z "$val" ] || log "note: $name in .env is no longer used (the short docker-compose.yml has it built in); you can remove it."
    elif [ "$name" = APP_PORT ] || [ "$name" = APP_BIND ]; then
      log "WARNING: $name=$val in .env has no effect with the short docker-compose.yml: set the port in its ports line."
    else
      die "$name=$val is set in .env, but the short docker-compose.yml takes this folder from its volumes lines. Move it there (see \"Moving to the short compose and .env files\" in the README), then remove $name from .env."
    fi
  done
fi
export CLOUDY_PREPARED=1   # the checks above run once, not again after the switch to PUID:PGID

# ---------------------------------------------------------------- as root: prepare, then start again as PUID:PGID
if [ "$(id -u)" = 0 ]; then
  for n in "$UID_" "$GID_"; do
    case "$n" in '' | *[!0-9]*) die "PUID and PGID must be numbers such as 1000 (got PUID='$UID_' PGID='$GID_')" ;; esac
  done
  [ "$UID_" != 0 ] || die "PUID must not be 0 (root)"

  # The capabilities first, so a missing one gives this message rather than a failure inside useradd.
  # The switch to a non-root uid clears every capability (and no-new-privileges keeps them from coming back).
  AS_APP="setpriv --reuid=$UID_ --regid=$GID_ --clear-groups"
  $AS_APP true 2>/dev/null || die "cannot switch to $UID_:$GID_: $CAPS."
  probe=$(mktemp)
  chown "$UID_:$GID_" "$probe" 2>/dev/null || { rm -f "$probe"; die "cannot change file owners: $CAPS."; }
  rm -f "$probe"

  # PostgreSQL refuses to run as a nameless user.
  getent group "$GID_" >/dev/null || groupadd -g "$GID_" cloudy
  getent passwd "$UID_" >/dev/null || useradd -M -d /tmp -s /usr/sbin/nologin -u "$UID_" -g "$GID_" cloudy

  mkdir -p "$SOCK_DIR" "$DATA_DIR"
  own "$SOCK_DIR"
  # Cloudy's files: only when the app can't write there (an NFS export with root_squash refuses; the app then
  # stops with a message naming the uid:gid that needs access).
  if ! $AS_APP test -w "$DATA_DIR"; then
    log "giving $DATA_DIR to $UID_:$GID_"
    chown -R "$UID_:$GID_" "$DATA_DIR" 2>/dev/null || true
  fi

  if [ -z "${DATABASE_URL:-}" ]; then
    mkdir -p "$DB_DIR"
    # Root has no right to read a 0700 folder of another user here, so a changed PUID needs one manual step.
    own "$DB_DIR" 2>/dev/null ||
      die "cannot give the database folder to $UID_:$GID_: it belongs to $(stat -c %u:%g "$DB_DIR"). Set PUID/PGID back to that owner, or change the owner once: for the default volume \"docker run --rm -v cloudy_db-data:/f debian chown -R $UID_:$GID_ /f\", for a host folder \"sudo chown -R $UID_:$GID_ <folder>\"."
    # Data dirs from the old Alpine images use locales like en_US.utf8, which this image lacks. musl sorts every
    # locale by code point, exactly like glibc's C.utf8, so alias the missing names to it (indexes stay valid).
    # The folder is private to PUID (0700), so it is read as that user.
    for loc in $($AS_APP sed -n "s/^lc_[a-z]* = '\([^']*\)'.*/\1/p" "$DB_DIR/postgresql.conf" 2>/dev/null | sort -u); do
      case "$loc" in *.[uU][tT][fF]8 | *.[uU][tT][fF]-8) ;; *) continue ;; esac
      alias="/usr/lib/locale/${loc%%.*}.utf8"
      [ -e "$alias" ] || ln -s C.utf8 "$alias" 2>/dev/null || true
    done
  fi

  # tini as process 1 passes docker stop on to this script, which then stops both processes cleanly.
  exec $AS_APP /usr/bin/tini -s -- "$0" "$@"
fi

# Started as non-root without an init (docker run --user): still run under tini.
[ "$$" != 1 ] || exec /usr/bin/tini -s -- "$0" "$@"

# ---------------------------------------------------------------- as PUID:PGID: database, then the server
pg_pid=""
if [ -z "${DATABASE_URL:-}" ]; then
  mkdir -p "$DB_DIR"
  chmod 700 "$DB_DIR"
  if [ -s "$DB_DIR/PG_VERSION" ]; then
    have=$(cat "$DB_DIR/PG_VERSION")
    if [ "$have" != "$PG_MAJOR" ]; then
      echo "Database in $DB_DIR is PostgreSQL $have but this image runs $PG_MAJOR." >&2
      echo "Back it up with the previous image (pg_dump) and restore it into a fresh database volume." >&2
      exit 1
    fi
  else
    log "initialising database in $DB_DIR"
    "$PG_BIN/initdb" -D "$DB_DIR" -U cloudy --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  fi

  # Unix socket only: the database is not reachable from outside the container.
  "$PG_BIN/postgres" -D "$DB_DIR" -c listen_addresses='' -c unix_socket_directories="$SOCK_DIR" \
    -c hba_file=/etc/cloudy/pg_hba.conf -c jit=off &
  pg_pid=$!

  i=0
  until "$PG_BIN/pg_isready" -q -h "$SOCK_DIR" -U cloudy -d postgres; do
    i=$((i + 1))
    if [ $i -gt 60 ] || ! kill -0 "$pg_pid" 2>/dev/null; then echo "PostgreSQL failed to start" >&2; exit 1; fi
    sleep 1
  done
  psql() { "$PG_BIN/psql" -h "$SOCK_DIR" -d postgres "$@"; }
  # Databases created by older two-container installs already have it.
  # One-time migration for databases created before the project was named Cloudy (role/database "filecloud").
  if ! psql -U cloudy -tAc "SELECT 1" >/dev/null 2>&1 && psql -U filecloud -tAc "SELECT 1" >/dev/null 2>&1; then
    log "migrating database from its previous name"
    psql -U filecloud -qc "CREATE ROLE cloudy SUPERUSER LOGIN"
    if psql -U cloudy -tAc "SELECT 1 FROM pg_database WHERE datname='filecloud'" | grep -q 1; then
      psql -U cloudy -qc "ALTER DATABASE filecloud RENAME TO cloudy"
      psql -U cloudy -qc "ALTER DATABASE cloudy OWNER TO cloudy"
    fi
  fi
  if ! psql -U cloudy -tAc "SELECT 1 FROM pg_database WHERE datname='cloudy'" | grep -q 1; then
    psql -U cloudy -qc "CREATE DATABASE cloudy"
  fi
  export DATABASE_URL="postgres://cloudy@localhost/cloudy?host=$SOCK_DIR"
  log "PostgreSQL $PG_MAJOR ready"
fi

node --disable-warning=ExperimentalWarning /app/src/server.ts &
app_pid=$!

# shellcheck disable=SC2329 # called by the trap below
shutdown() {
  log "stopping"
  kill -TERM "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  if [ -n "$pg_pid" ]; then
    kill -INT "$pg_pid" 2>/dev/null || true   # PostgreSQL "fast" shutdown
    wait "$pg_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

# If either process dies, stop the other and exit so Docker's restart policy kicks in.
while kill -0 "$app_pid" 2>/dev/null && { [ -z "$pg_pid" ] || kill -0 "$pg_pid" 2>/dev/null; }; do
  sleep 2 &
  wait $! || true
done
log "a process exited unexpectedly"
kill -TERM "$app_pid" 2>/dev/null || true
[ -n "$pg_pid" ] && kill -INT "$pg_pid" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
