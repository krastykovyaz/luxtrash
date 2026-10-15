#!/usr/bin/env bash
# Daily backup of everything Bin Duty keeps: every house database (copied with
# SQLite's own .backup, safe while the app is running), the server secret the
# chat and signed links depend on, and the task/chat photos. Keeps 14 days.
#
# Runs nightly from a systemd timer (cron is not installed on this server; the
# other apps' backups use timers too). Install once, as root:
#   cp scripts/bin-duty-backup.service scripts/bin-duty-backup.timer /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now bin-duty-backup.timer
# Check it: systemctl list-timers bin-duty-backup.timer
# Restore: stop the app (pm2 stop bin-duty), copy the files back into
# server/data/ (same layout), start it again.
set -euo pipefail

DATA="${BIN_DUTY_DATA:-/root/projects/bin-duty/server/data}"
DEST_ROOT="${BIN_DUTY_BACKUPS:-/root/backups/bin-duty}"
KEEP_DAYS=14
DEST="$DEST_ROOT/$(date +%Y-%m-%d)"

umask 077
mkdir -p "$DEST/houses"
sqlite3 "$DATA/bin-duty.sqlite" ".backup '$DEST/bin-duty.sqlite'"
sqlite3 "$DATA/houses.sqlite" ".backup '$DEST/houses.sqlite'"
for db in "$DATA"/houses/*.sqlite; do
  [ -e "$db" ] || continue
  sqlite3 "$db" ".backup '$DEST/houses/$(basename "$db")'"
done
[ -f "$DATA/chat-secret" ] && cp "$DATA/chat-secret" "$DEST/"
tar -czf "$DEST/photos.tar.gz" -C "$DATA" task-photos chat-photos 2>/dev/null || true

# Only remove dated folders this script made, older than KEEP_DAYS.
find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??' -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "Bin Duty backup written to $DEST ($(du -sh "$DEST" | cut -f1))"
