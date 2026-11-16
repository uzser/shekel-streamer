#!/bin/sh
# Entry point (runs as root, then drops to user "app").
# 1. Egress firewall: only the tinyproxy user may open connections to the outside.
# 2. tinyproxy allows only the host names in /etc/shekel/allowlist (+ option allowed_domains).
# 3. Secrets: /data/options.json stays root-only; a copy goes to tmpfs for the app, and the app
#    deletes it after reading.
set -eu

PROXY=http://127.0.0.1:8888
OPTIONS=/data/options.json

firewall() {
  cmd=$1
  $cmd -F OUTPUT
  $cmd -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "$cmd" = iptables ]; then
    # Docker's DNS server 127.0.0.11: only the proxy may resolve names (no DNS leak for the app).
    # Docker forwards the queries from this network namespace as root, so root may send DNS out.
    $cmd -A OUTPUT -o lo -d 127.0.0.11 -m owner --uid-owner tinyproxy -j ACCEPT
    $cmd -A OUTPUT -o lo -d 127.0.0.11 -j REJECT
    $cmd -A OUTPUT -p udp --dport 53 -m owner --uid-owner 0 -j ACCEPT
    $cmd -A OUTPUT -p tcp --dport 53 -m owner --uid-owner 0 -j ACCEPT
  fi
  $cmd -A OUTPUT -o lo -j ACCEPT
  $cmd -A OUTPUT -m owner --uid-owner tinyproxy -j ACCEPT
  $cmd -A OUTPUT -j REJECT
}

if ! firewall iptables; then
  echo "FATAL: cannot set the egress firewall (iptables owner match). Not starting." >&2
  exit 3
fi
# IPv6 may be off in the container; then there is no IPv6 route to block.
firewall ip6tables 2>/dev/null || echo "note: ip6tables not available, IPv6 egress not filtered" >&2
echo "egress firewall: on (only tinyproxy may connect out)"

node -e '
  const options = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const pattern of options.allowed_domains || []) console.log(pattern);
' "$OPTIONS" >> /etc/shekel/allowlist
echo "allowed hosts:" $(cat /etc/shekel/allowlist)

tinyproxy -d -c /etc/shekel/tinyproxy.conf &
PROXY_PID=$!
sleep 1

# /data: root-owned and not listable; the app writes only to its own subfolders.
chown root:root /data "$OPTIONS"
chmod 0711 /data
chmod 0600 "$OPTIONS"
mkdir -p /data/db /data/profiles
chown -R app /data/db /data/profiles
chmod 0700 /data/db /data/profiles

install -o app -m 0600 "$OPTIONS" /dev/shm/options.json

# One-time files: the owner puts them into the add-on config folder (/config here).
# history-import.json: old history; backfill.json: a longer sync that posts only recent rows.
# They move to the app's own folder; the app deletes each one after a successful run.
for name in history-import backfill; do
  if [ -f "/config/$name.json" ]; then
    mv "/config/$name.json" "/data/db/$name.json"
    chown app "/data/db/$name.json"
    chmod 0600 "/data/db/$name.json"
    echo "$name file found"
  fi
done

export CONFIG_FILE=/dev/shm/options.json CONFIG_FILE_DELETE=true \
       SQLITE_PATH=/data/db/shekel-streamer.db BROWSER_PROFILES_DIR=/data/profiles \
       PROXY_SERVER=$PROXY HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY NODE_USE_ENV_PROXY=1 \
       IMPORT_FILE=/data/db/history-import.json BACKFILL_FILE=/data/db/backfill.json HOME=/tmp

set +e
su-exec app node /app/src/app.js
code=$?
kill "$PROXY_PID" 2>/dev/null
rm -f /dev/shm/options.json
exit $code
