#!/bin/zsh
# wireprint corpus capture rig for macOS.
#
# Drives a locally installed browser against `wireprint serve` WITHOUT any automation flags: the browser is
# launched with `open -a`, so it runs exactly as a user would run it (same profile, same Finch state).
# Each navigation is a fresh TLS connection because the server answers with GOAWAY and closes, so N
# navigations give N first-connection ClientHello samples plus session-resumption attempts.
#
# usage: tools/capture.sh <chrome|firefox|firefox-dev|safari|edge> [samples=5] [port=8443]
# env:   WIREPRINT_CERT / WIREPRINT_KEY  (default: a self-signed localhost cert generated on first use)
#        WIREPRINT_OUT                    (default: corpus/_raw/<browser>-<timestamp>)
# The browser must trust (or the user must click through) the certificate; with mkcert installed
# (`brew install mkcert && mkcert -install && mkcert localhost`) no clicking is needed.
set -euo pipefail
browser=${1:?browser}; samples=${2:-5}; port=${3:-8443}
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
bin=./zig-out/bin/wireprint
zig build  # always rebuild with default options (OpenSSL on); a -Dopenssl=false binary cannot serve
case $browser in
  chrome)      app="Google Chrome";           plist="/Applications/Google Chrome.app/Contents/Info.plist"; name=chrome ;;
  edge)        app="Microsoft Edge";          plist="/Applications/Microsoft Edge.app/Contents/Info.plist"; name=edge ;;
  firefox)     app="Firefox";                 plist="/Applications/Firefox.app/Contents/Info.plist"; name=firefox ;;
  firefox-dev) app="Firefox Developer Edition"; plist="/Applications/Firefox Developer Edition.app/Contents/Info.plist"; name=firefox ;;
  safari)      app="Safari";                  plist="/Applications/Safari.app/Contents/Info.plist"; name=safari ;;
  *) echo "unknown browser $browser" >&2; exit 2 ;;
esac
version=$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || echo unknown)
channel=stable; [[ $browser == firefox-dev ]] && channel=aurora
os=macos; os_version=$(sw_vers -productVersion); arch=$(uname -m)
stamp=$(date +%Y%m%dT%H%M%S)
out=${WIREPRINT_OUT:-corpus/_raw/$name-$version-$stamp}; mkdir -p "$out"
cert=${WIREPRINT_CERT:-$out/../localhost-cert.pem}; key=${WIREPRINT_KEY:-$out/../localhost-key.pem}
if [[ ! -f $cert ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout "$key" -out "$cert" >/dev/null 2>&1
  echo "generated self-signed cert $cert (browsers will warn once per host:port)"
fi
max=$(( samples * 4 ))
echo "serve on :$port -> $out ($app $version, $samples navigations)"
$bin serve --port "$port" --cert "$cert" --key "$key" --capture-dir "$out" --max-connections "$max" > "$out/serve.log" 2>&1 &
pid=$!
sleep 1
for i in $(seq 1 "$samples"); do
  open -a "$app" "https://localhost:$port/wireprint?browser=$name&sample=$i"
  sleep 4
done
sleep 3
kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
reports=("$out"/report-*.json(N))
echo "captured ${#reports[@]} reports; TLS/h2 summary:"
grep -E "^#" "$out/serve.log" | cut -c1-160 || true
if (( ${#reports[@]} == 0 )); then echo "no reports (certificate not accepted?)"; exit 1; fi
major=${version%%.*}
profile_dir=corpus/$name/$major/$os-$arch; mkdir -p "$profile_dir"
profile=$profile_dir/$version.json
$bin profile --name "$name" --version "$version" --channel "$channel" --os "$os" --os-version "$os_version" --arch "$arch" \
  --method "manual-open" --captured-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --raw-dir "$(basename "$out")" "${reports[@]}" > "$profile"
echo "profile written: $profile"
