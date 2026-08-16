#!/bin/bash
# [2026-08-16 FAZA1] Packing backup — kriticni podatki skladisca + rotacija.
# Zajame: packed-orders.json, packing-notes.json, sessions.json, notifications.json,
# queue.json, data.json + konsistenten snapshot topsellers.db (VACUUM INTO).
# Cron: vsakih 6h. Obdrzi zadnjih 30.
set -euo pipefail

APP="/home/ec2-user/apps/packing"
BAKDIR="/home/ec2-user/backups/packing"
KEEP=30
TS="$(date +%Y-%m-%dT%H-%M-%S)"
TMP="$BAKDIR/tmp-$TS"

mkdir -p "$TMP"

# 1) JSON datoteke (kopija je dovolj — atomicni zapisi jamcijo konsistenten fajl)
for f in data/packed-orders.json data/packing-notes.json data/sessions.json \
         packing-notes.json notifications.json queue.json data.json; do
  [ -f "$APP/$f" ] && cp "$APP/$f" "$TMP/$(basename $f)" || true
done

# 2) SQLite: konsistenten snapshot + preverjanje integritete
if [ -f "$APP/data/topsellers.db" ]; then
  node -e '
  const { DatabaseSync } = require("node:sqlite");
  const src = process.argv[1], out = process.argv[2];
  const d = new DatabaseSync(src);
  d.exec("VACUUM INTO \047" + out + "\047");
  const b = new DatabaseSync(out, { readOnly: true });
  const ic = b.prepare("PRAGMA integrity_check").all();
  if (!(ic.length === 1 && ic[0].integrity_check === "ok")) { console.error("integrity FAIL"); process.exit(2); }
  const n = b.prepare("SELECT COUNT(*) c FROM orders").get().c;
  console.log("[packing-backup] topsellers.db OK (" + n + " orders)");
  ' "$APP/data/topsellers.db" "$TMP/topsellers.db"
fi

# 3) Preveri, da je packed-orders veljaven JSON in NI prazen (varovalka pred backupom smeti)
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1]));
const n = Object.keys(d).length;
if (n < 10) { console.error("[packing-backup] packed-orders sumljivo majhen (" + n + ") - ABORT"); process.exit(3); }
console.log("[packing-backup] packed-orders OK (" + n + " zapisov)");
' "$TMP/packed-orders.json"

# 4) Arhiv + rotacija
OUT="$BAKDIR/packing-$TS.tar.gz"
tar -czf "$OUT" -C "$TMP" .
rm -rf "$TMP"
ls -1t "$BAKDIR"/packing-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "[packing-backup] done: $OUT ($(du -h "$OUT" | cut -f1)), kept last $KEEP"
