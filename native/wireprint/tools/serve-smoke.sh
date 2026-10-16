#!/usr/bin/env bash
# Smoke test for src/server/listener.zig + src/server/tls_openssl.zig. Localhost only.
#
#   tools/serve-smoke.sh            # build tools/serve_smoke.zig, run 5 local clients, check the server log
#
# Env: PORT (8447), SMOKE_DIR (${TMPDIR:-/tmp}/wireprint-serve-smoke), OPENSSL_PREFIX (/opt/homebrew/opt/openssl@3).
#
# Clients, in order (the server stops after exactly these 5 accepted connections):
#   #1 curl --http2            full handshake, ALPN h2; server reads the h2 preface, writes one empty SETTINGS,
#                              closes -> curl fails (expected: exit 16, HTTP/2 framing layer)
#   #2 curl http://            plaintext on the TLS port -> peek fails with NotHandshake, server keeps going
#   #3 curl --http1.1          ALPN offers only http/1.1 -> fatal no_application_protocol alert (curl exit 35)
#   #4 openssl s_client        full handshake, saves the session (NewSessionTicket) to sess.pem
#   #5 openssl s_client        resumes from sess.pem -> session_reused=true, pre_shared_key (0029) last
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8447}"
SMOKE="${SMOKE_DIR:-${TMPDIR:-/tmp}/wireprint-serve-smoke}"
OPENSSL_PREFIX="${OPENSSL_PREFIX:-/opt/homebrew/opt/openssl@3}"
OPENSSL="$OPENSSL_PREFIX/bin/openssl"
CAP="$SMOKE/capture"
LOG="$SMOKE/server.log"

mkdir -p "$SMOKE"
rm -rf "$CAP" "$LOG" "$SMOKE"/client-*.out "$SMOKE/sess.pem"

# --- 1. self-signed certificate for localhost -------------------------------------------------------------
if [ ! -s "$SMOKE/cert.pem" ] || [ ! -s "$SMOKE/key.pem" ]; then
  "$OPENSSL" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$SMOKE/key.pem" -out "$SMOKE/cert.pem" -days 30 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1 || { echo "FAIL: openssl req"; exit 1; }
fi

# --- 2. build the smoke executable (same module graph as build.zig's `lib`; build.zig is not touched) -------
printf 'pub const openssl: bool = true;\n' > "$SMOKE/build_options.zig"
(
  cd "$ROOT" && zig build-exe \
    --dep wireprint -Mroot=tools/serve_smoke.zig \
    --dep build_options --dep fixtures --dep spec -I"$OPENSSL_PREFIX/include" -Mwireprint=src/root.zig \
    -Mbuild_options="$SMOKE/build_options.zig" \
    -Mfixtures=fixtures/root.zig \
    -Mspec=spec/root.zig \
    -L"$OPENSSL_PREFIX/lib" -lssl -lcrypto -lc \
    --name serve-smoke -femit-bin="$SMOKE/serve-smoke"
) || { echo "FAIL: zig build-exe"; exit 1; }

# --- 3. server ------------------------------------------------------------------------------------------
"$SMOKE/serve-smoke" --cert "$SMOKE/cert.pem" --key "$SMOKE/key.pem" --port "$PORT" --max 5 --capture "$CAP" \
  >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

for _ in $(seq 1 100); do
  grep -q "listening on" "$LOG" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.05
done
grep -q "listening on" "$LOG" || { echo "FAIL: server did not start"; cat "$LOG"; exit 1; }

# --- 4. clients (localhost only) ---------------------------------------------------------------------------
curl -sk -v --http2 --max-time 15 "https://localhost:$PORT/" >"$SMOKE/client-1.out" 2>&1; rc1=$?
curl -s --max-time 15 "http://localhost:$PORT/" >"$SMOKE/client-2.out" 2>&1; rc2=$?
curl -sk -v --http1.1 --max-time 15 "https://localhost:$PORT/" >"$SMOKE/client-3.out" 2>&1; rc3=$?
# `sleep 1 |`: s_client must stay up until the TLS 1.3 NewSessionTicket arrives.
sleep 1 | "$OPENSSL" s_client -connect "127.0.0.1:$PORT" -servername localhost -alpn h2 \
  -sess_out "$SMOKE/sess.pem" >"$SMOKE/client-4.out" 2>&1; rc4=$?
sleep 1 | "$OPENSSL" s_client -connect "127.0.0.1:$PORT" -servername localhost -alpn h2 \
  -sess_in "$SMOKE/sess.pem" >"$SMOKE/client-5.out" 2>&1; rc5=$?

server_rc=0
for _ in $(seq 1 200); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.05; done
if kill -0 "$SERVER_PID" 2>/dev/null; then server_rc=124; else wait "$SERVER_PID"; server_rc=$?; fi
trap - EXIT

# --- 5. checks -------------------------------------------------------------------------------------------
fails=0
check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@"; then echo "PASS  $desc"; else echo "FAIL  $desc"; fails=$((fails + 1)); fi
}
logrx() { grep -Eq "$1" "$LOG"; }
size_of() { wc -c <"$1" | tr -d ' '; }

check "server exited 0 after --max 5"                        test "$server_rc" -eq 0
check "#1 first record peeked (content_type=22)"             logrx '#1 first record: content_type=22 '
check "#1 handshake ok with alpn=h2 sni=localhost"           logrx '#1 TLS ok: .* alpn=h2 sni=localhost '
check "#1 handler read the h2 preface over TLS"              logrx 'smoke #1: HTTP/2 preface matches'
check "#1 curl exit 16 (no h2 response; expected)"           test "$rc1" -eq 16
check "#2 plaintext rejected by peek (NotHandshake)"         logrx '#2 no complete TLS record: NotHandshake'
check "#3 ALPN without h2 -> handshake failed"               logrx '#3 TLS handshake failed: Accept'
check "#3 curl exit 35 (no_application_protocol)"            test "$rc3" -eq 35
check "#4 full handshake, session_reused=false"              logrx '#4 TLS ok: .* session_reused=false '
check "#5 resumed, session_reused=true"                      logrx '#5 TLS ok: .* session_reused=true '
check "#5 OpenSSL ext order ends with pre_shared_key 0029"   logrx '#5 TLS ok: .*openssl_ext_order=\[[0-9a-f,]*,0029\]'
check "#5 s_client reports Reused"                           grep -q '^Reused,' "$SMOKE/client-5.out"
for n in 1 3 4 5; do
  f="$CAP/clienthello-$n.bin"
  total=$(sed -nE "s/.*#$n first record: .* total=([0-9]+) bytes.*/\1/p" "$LOG")
  check "capture clienthello-$n.bin = ${total:-?} bytes (5 + record length)" \
    test -s "$f" -a "$(size_of "$f" 2>/dev/null || echo 0)" = "${total:-x}"
done
check "no capture for the plaintext connection #2"           test ! -e "$CAP/clienthello-2.bin"

echo
echo "client exit codes: #1=$rc1 #2=$rc2 #3=$rc3 #4=$rc4 #5=$rc5; server=$server_rc"
echo "server log: $LOG"
echo "--- server log (listener / tls_openssl / smoke lines) ---"
grep -E 'listener|tls_openssl|smoke' "$LOG"
echo "---"
if [ "$fails" -ne 0 ]; then echo "SMOKE FAILED ($fails check(s))"; exit 1; fi
echo "SMOKE OK"
