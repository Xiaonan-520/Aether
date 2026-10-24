#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Admin-auth end-to-end check, run against a REAL gateway process on localhost.
#
# Uses a throwaway temp data dir (real SQLite, real migrations), a real HTTP
# listener on a free loopback port, and fabricated credentials. It never talks
# to any remote host and never touches an existing deployment.
#
#   ./scripts/auth-e2e.sh
#
# Exits non-zero on the first failed assertion.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${AUTH_E2E_PORT:-18083}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-auth-e2e.XXXXXX")"
LOG="${DATA_DIR}/gateway.log"
PID=""

# Fabricated test credentials — deliberately unlike anything real.
export GATEWAY_API_KEY="e2e-gateway-key-not-real-0001"
export GATEWAY_SECRET="e2e-secret-material-0123456789"
export GATEWAY_ADMIN_TOKEN="e2e-static-admin-token-0001"
export DATA_DIR
export HTTP_HOST="127.0.0.1"
export HTTP_PORT="$PORT"
export LOG_LEVEL="warn"
export TZ="UTC"

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m×\033[0m %s\n' "$1"; exit 1; }

# assert_status <expected> <actual> <label>
assert_status() {
  [ "$1" = "$2" ] || fail "$3 (expected HTTP $1, got $2)"
  pass "$3"
}

# assert_contains <haystack> <needle> <label>
assert_contains() {
  case "$1" in
    *"$2"*) pass "$3" ;;
    *) fail "$3 (missing: $2)" ;;
  esac
}

# assert_not_contains <haystack> <needle> <label>
assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (leaked: $2)" ;;
    *) pass "$3" ;;
  esac
}

# post <path> <json> [token] -> body\n<status> on the last line
post() {
  local path="$1" body="$2" token="${3:-}"
  local args=(-sS -o /tmp/e2e-body.$$ -w '%{http_code}' -X POST
              -H 'Content-Type: application/json' -d "$body")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  local code
  code=$(curl "${args[@]}" "${BASE}${path}" 2>/dev/null || echo 000)
  RESP_BODY=$(cat /tmp/e2e-body.$$ 2>/dev/null || true)
  rm -f /tmp/e2e-body.$$
  RESP_CODE="$code"
}

get() {
  local path="$1" token="${2:-}"
  local args=(-sS -o /tmp/e2e-body.$$ -w '%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  local code
  code=$(curl "${args[@]}" "${BASE}${path}" 2>/dev/null || echo 000)
  RESP_BODY=$(cat /tmp/e2e-body.$$ 2>/dev/null || true)
  rm -f /tmp/e2e-body.$$
  RESP_CODE="$code"
}

json_field() { python3 -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1],""))' "$1" 2>/dev/null <<<"$RESP_BODY"; }

EMAIL="e2e-admin@aether.test"
PASSWORD="e2e-correct-password-123"

echo "== environment =="
echo "  data dir: $DATA_DIR"
echo "  base url: $BASE"
node -v | sed 's/^/  node: /'

echo "== starting gateway =="
( cd "$ROOT" && node dist/http/index.js >"$LOG" 2>&1 ) &
PID=$!

for i in $(seq 1 60); do
  if curl -sf "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "gateway died during startup:"
    tail -30 "$LOG"
    exit 1
  fi
  sleep 0.5
  [ "$i" -eq 60 ] && { echo "gateway did not become healthy"; tail -30 "$LOG"; exit 1; }
done
pass "gateway is healthy on 127.0.0.1:${PORT}"

echo "== registration =="
get /api/auth/status
assert_status 200 "$RESP_CODE" "status is public (no credential)"
assert_contains "$RESP_BODY" '"initialized":false' "status reports uninitialized on an empty database"

post /api/auth/register '{"email":"","password":"'"$PASSWORD"'"}'
assert_status 400 "$RESP_CODE" "registration rejects an empty email"

post /api/auth/register '{"email":"'"$EMAIL"'","password":"short"}'
assert_status 400 "$RESP_CODE" "registration rejects a password below the minimum"

post /api/auth/register '{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'"}'
assert_status 201 "$RESP_CODE" "first registration succeeds"
assert_not_contains "$RESP_BODY" "$PASSWORD" "registration response does not echo the password"
assert_not_contains "$RESP_BODY" 'scrypt$' "registration response does not echo a digest"
SESSION_TOKEN=$(json_field token)
[ -n "$SESSION_TOKEN" ] || fail "registration did not return a session token"
pass "registration returned a session token"

post /api/auth/register '{"email":"second@aether.test","password":"another-long-password"}'
assert_status 409 "$RESP_CODE" "public registration is closed permanently"

get /api/auth/status
assert_contains "$RESP_BODY" '"initialized":true' "status reports initialized after registration"
assert_not_contains "$RESP_BODY" "$EMAIL" "anonymous status does not leak the admin email"

echo "== concurrent first registration =="
# Fresh database, many simultaneous registrations: exactly one may win.
CONC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-auth-race.XXXXXX")"
CONC_PORT=$((PORT + 1))
(
  cd "$ROOT"
  DATA_DIR="$CONC_DIR" HTTP_PORT="$CONC_PORT" node dist/http/index.js >"$CONC_DIR/log" 2>&1
) &
CONC_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${CONC_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
codes=""
for n in $(seq 1 10); do
  (
    curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
      -H 'Content-Type: application/json' \
      -d '{"email":"race'"$n"'@aether.test","password":"concurrent-password"}' \
      "http://127.0.0.1:${CONC_PORT}/api/auth/register" 2>/dev/null
  ) &
  RACE_PIDS="${RACE_PIDS:-} $!"
done > "$CONC_DIR/codes" 2>/dev/null
# Wait only for the curl jobs — a bare `wait` would also block on the
# background gateway process started above.
for p in $RACE_PIDS; do wait "$p" 2>/dev/null || true; done
codes=$(sort "$CONC_DIR/codes" | tr '\n' ' ')
count201=$(grep -c '^201$' "$CONC_DIR/codes" || true)
if [ "$count201" = "1" ]; then
  pass "concurrent registration produced exactly one 201 (codes: $codes)"
else
  fail "concurrent registration produced $count201 successes (codes: $codes)"
fi
kill "$CONC_PID" 2>/dev/null || true
wait "$CONC_PID" 2>/dev/null || true
rm -rf "$CONC_DIR"

echo "== login =="
post /api/auth/login '{"email":"'"$EMAIL"'","password":"wrong-password-here"}'
assert_status 401 "$RESP_CODE" "wrong password is rejected"
WRONG_BODY="$RESP_BODY"

post /api/auth/login '{"email":"ghost@aether.test","password":"'"$PASSWORD"'"}'
assert_status 401 "$RESP_CODE" "unknown email is rejected"
[ "$RESP_BODY" = "$WRONG_BODY" ] || fail "unknown-email and wrong-password responses differ (account enumeration)"
pass "unknown email and wrong password are indistinguishable"

post /api/auth/login '{"email":"  E2E-ADMIN@AETHER.TEST  ","password":"'"$PASSWORD"'"}'
assert_status 200 "$RESP_CODE" "login normalizes the email and accepts the right password"
LOGIN_TOKEN=$(json_field token)
[ -n "$LOGIN_TOKEN" ] || fail "login did not return a token"
[ "$LOGIN_TOKEN" != "$SESSION_TOKEN" ] || fail "login reissued the registration token instead of a fresh one"
pass "login issued a fresh session token"

echo "== session access =="
get /api/accounts "$LOGIN_TOKEN"
assert_status 200 "$RESP_CODE" "a session token grants access to /api/accounts"

get /api/auth/me "$LOGIN_TOKEN"
assert_status 200 "$RESP_CODE" "/api/auth/me returns the identity"
assert_contains "$RESP_BODY" "$EMAIL" "/api/auth/me reports the admin email"
assert_contains "$RESP_BODY" '"staticToken":false' "/api/auth/me marks a session credential"

get /v1/models "$LOGIN_TOKEN"
assert_status 401 "$RESP_CODE" "a session token is NOT valid on /v1"

get /api/accounts "$GATEWAY_API_KEY"
assert_status 401 "$RESP_CODE" "the gateway API key is NOT valid on /api"

echo "== logout =="
post /api/auth/logout '{}' "$LOGIN_TOKEN"
assert_status 200 "$RESP_CODE" "logout succeeds"

get /api/accounts "$LOGIN_TOKEN"
assert_status 401 "$RESP_CODE" "the revoked session can no longer reach /api"

get /api/accounts "$SESSION_TOKEN"
assert_status 200 "$RESP_CODE" "logging out one session leaves the other session valid"

echo "== static admin token compatibility =="
get /api/accounts "$GATEWAY_ADMIN_TOKEN"
assert_status 200 "$RESP_CODE" "GATEWAY_ADMIN_TOKEN still works"

get /api/auth/me "$GATEWAY_ADMIN_TOKEN"
assert_contains "$RESP_BODY" '"staticToken":true' "/api/auth/me identifies the static token"
assert_contains "$RESP_BODY" '"user":null' "the static token has no user identity"

post /api/auth/logout '{}' "$GATEWAY_ADMIN_TOKEN"
assert_status 200 "$RESP_CODE" "logout with the static token is an accepted no-op"
get /api/accounts "$GATEWAY_ADMIN_TOKEN"
assert_status 200 "$RESP_CODE" "the static token still works after that no-op"

echo "== login throttling =="
for i in 1 2 3 4 5; do
  post /api/auth/login '{"email":"'"$EMAIL"'","password":"wrong-password-here"}' >/dev/null
done
post /api/auth/login '{"email":"'"$EMAIL"'","password":"'"$PASSWORD"'"}'
assert_status 429 "$RESP_CODE" "repeated failures throttle the identity"

echo "== credential separation =="
get /api/console/overview "$SESSION_TOKEN"
assert_status 200 "$RESP_CODE" "a session token reaches console endpoints"

echo "== database contents =="
DB="${DATA_DIR}/gateway.db"
[ -f "$DB" ] || fail "gateway.db was not created"
python3 - "$DB" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
users = db.execute("SELECT email, password_hash FROM admin_users").fetchall()
assert len(users) == 1, f"expected exactly 1 admin row, found {len(users)}"
email, digest = users[0]
assert digest.startswith("scrypt$"), "password is not stored as a scrypt digest"
assert "e2e-correct-password-123" not in digest, "plaintext password found in the database"
sessions = db.execute("SELECT token_hash, revoked_at, expires_at FROM admin_sessions").fetchall()
assert len(sessions) >= 1, "no sessions were persisted"
for token_hash, _revoked, _exp in sessions:
    assert len(token_hash) == 64, "session token is not stored as a sha256 hex digest"
    assert token_hash.startswith("adm-") is False, "raw session token was stored"
schema = db.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
assert schema == 3, f"expected schema version 3, got {schema}"
print(f"  \033[32m✓\033[0m database: {len(users)} admin row(s), {len(sessions)} session row(s), schema v{schema}")
print(f"  \033[32m✓\033[0m password stored as a scrypt digest; no plaintext")
print(f"  \033[32m✓\033[0m session tokens stored as sha256 digests only")
PY

echo "== upgrade path: legacy database without auth tables =="
LEGACY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-auth-legacy.XXXXXX")"
python3 - "$LEGACY_DIR/gateway.db" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
# Simulate a v2 database created before this feature existed.
db.executescript("""
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT INTO schema_version VALUES (1, 0), (2, 0);
CREATE TABLE providers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT NOT NULL,
  status TEXT NOT NULL, credential_key TEXT NOT NULL UNIQUE, authenticated INTEGER NOT NULL DEFAULT 0,
  token_expiry_at INTEGER, refreshable INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 100,
  metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE credentials (credential_key TEXT PRIMARY KEY, ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL, tag BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE models (model_id TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT,
  capabilities_json TEXT NOT NULL, PRIMARY KEY (model_id, provider));
CREATE TABLE quotas (account_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE credit_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  provider TEXT NOT NULL, claim_type TEXT NOT NULL, claim_date TEXT NOT NULL,
  claimed_at INTEGER NOT NULL, outcome_json TEXT NOT NULL,
  UNIQUE(account_id, claim_type, claim_date));
CREATE TABLE jobs (id TEXT PRIMARY KEY, provider TEXT, account_id TEXT, job_type TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  level TEXT NOT NULL, provider TEXT, account_id TEXT, job_id TEXT, kind TEXT NOT NULL,
  message TEXT, payload_json TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  last_used_at INTEGER, expires_at INTEGER, revoked_at INTEGER);
INSERT INTO providers VALUES ('fake','Fake','{}',1);
INSERT INTO api_keys VALUES ('k1','legacy','gw-legacy','deadbeef',1,0,NULL,NULL,NULL);
""")
db.commit()
PY
LEGACY_PORT=$((PORT + 2))
(
  cd "$ROOT"
  DATA_DIR="$LEGACY_DIR" HTTP_PORT="$LEGACY_PORT" node dist/http/index.js >"$LEGACY_DIR/log" 2>&1
) &
LEGACY_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${LEGACY_PORT}/healthz" >/dev/null 2>&1 && break
  if ! kill -0 "$LEGACY_PID" 2>/dev/null; then
    echo "legacy-upgrade gateway died:"; tail -20 "$LEGACY_DIR/log"; exit 1
  fi
  sleep 0.5
done
python3 - "$LEGACY_DIR/gateway.db" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
version = db.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
assert version == 3, f"legacy db did not migrate to v3 (got {version})"
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for needed in ("admin_users", "admin_sessions"):
    assert needed in tables, f"missing table after migration: {needed}"
legacy_keys = db.execute("SELECT COUNT(*) FROM api_keys").fetchone()[0]
assert legacy_keys == 1, "migration lost pre-existing data"
print("  \033[32m✓\033[0m legacy v2 database migrated to v3 without data loss")
PY
# the migrated instance must also accept a first registration
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"email":"upgraded@aether.test","password":"upgraded-password-1"}' \
  "http://127.0.0.1:${LEGACY_PORT}/api/auth/register")
assert_status 201 "$code" "first registration works on a migrated database"
kill "$LEGACY_PID" 2>/dev/null || true
wait "$LEGACY_PID" 2>/dev/null || true
rm -rf "$LEGACY_DIR"

echo "== no credential leakage in the log =="
if grep -q "$PASSWORD" "$LOG" 2>/dev/null; then
  fail "the password appears in the gateway log"
fi
pass "no password in the gateway log"
if grep -q "scrypt\$" "$LOG" 2>/dev/null; then
  fail "a password digest appears in the gateway log"
fi
pass "no password digest in the gateway log"

echo
echo "ALL CHECKS PASSED"
