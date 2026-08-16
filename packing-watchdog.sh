#!/bin/bash
# [2026-08-16 FAZA1] Packing watchdog — cron vsakih 5 min.
# 1) /api/health -> ce ne odgovori ali ok:false: zabelezi + po 2 zaporednih napakah pm2 restart (self-heal).
# 2) Alarm kanal: ce obstaja /home/ec2-user/.packing-alert-webhook (Slack webhook ali
#    Telegram "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>"), poslje sporocilo.
#    Dokler ga ni, alarmi ostanejo v $LOG.
set -u

LOG="/home/ec2-user/packing-watchdog.log"
FAILCNT="/tmp/packing-watchdog.failcount"
HOOKFILE="/home/ec2-user/.packing-alert-webhook"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

alert() {
    echo "$TS ALARM: $1" >> "$LOG"
    if [ -f "$HOOKFILE" ]; then
        URL="$(cat "$HOOKFILE")"
        case "$URL" in
            *telegram*) curl -sm 10 "$URL" --data-urlencode "text=📦 PACKING: $1" >/dev/null 2>&1 || true ;;
            *)          curl -sm 10 -X POST -H 'Content-Type: application/json' -d "{\"text\":\"📦 PACKING: $1\"}" "$URL" >/dev/null 2>&1 || true ;;
        esac
    fi
}

BODY="$(curl -sm 15 http://localhost:3006/api/health 2>/dev/null || true)"
OK="$(echo "$BODY" | python3 -c 'import json,sys
try: print("1" if json.load(sys.stdin).get("ok") else "0")
except Exception: print("0")' 2>/dev/null || echo 0)"

if [ "$OK" = "1" ]; then
    # zdrav -> pocisti stevec; ce je bil prej alarm, javi okrevanje
    if [ -s "$FAILCNT" ] && [ "$(cat "$FAILCNT")" -ge 2 ]; then alert "OK - aplikacija spet zdrava"; fi
    echo 0 > "$FAILCNT"
    exit 0
fi

N=$(( $(cat "$FAILCNT" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$FAILCNT"
echo "$TS health FAIL #$N body=${BODY:0:200}" >> "$LOG"

if [ "$N" -eq 2 ]; then
    alert "health FAIL 2x zapored - izvajam pm2 restart packing. Zadnji odgovor: ${BODY:0:150}"
    /usr/local/bin/pm2 restart packing >/dev/null 2>&1 || pm2 restart packing >/dev/null 2>&1 || true
elif [ "$N" -ge 4 ]; then
    alert "packing SE VEDNO down po restartu (fail #$N) - potreben rocni poseg!"
fi
