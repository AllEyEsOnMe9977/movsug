#!/bin/bash
#
# backup-db.sh
#
# Dumps the MariaDB database, compresses it, uploads it to a Hetzner
# S3-compatible bucket, verifies the upload, and prunes old local backups.
#
# Intended for cron, e.g. once a day at 3am:
#   0 3 * * * /root/MovRecomm/src/scripts/backup-db.sh >> /var/log/movrecomm-backup.log 2>&1
#
# Requires .env to define: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
# S3_ENDPOINT, S3_BUCKET, DB_BACKUP_DIR (optional, defaults below).
#
# Exits non-zero on ANY failure — mysqldump error, compression error, or
# upload error — so cron logs and monitoring can catch failures reliably.
# Never overwrites a good local backup with a partial/failed one (uses a
# temp file + atomic rename).

set -euo pipefail  # fail fast, fail loud — no silent partial failures

# ── Load .env (only the vars we need, without polluting the shell) ──
ENV_FILE="/root/MovRecomm/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[Backup] FATAL: .env not found at $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# ── Config (with sane fallbacks) ──
BACKUP_DIR="${DB_BACKUP_DIR:-/root/MovRecomm/backups}"
RETENTION_DAYS=7          # how many days of LOCAL backups to keep (S3 keeps all)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="movies_backup_${TIMESTAMP}.sql.gz"
TMP_FILE="${BACKUP_DIR}/.tmp_${DUMP_FILE}"
FINAL_FILE="${BACKUP_DIR}/${DUMP_FILE}"
S3_URI="s3://${S3_BUCKET}/db-backups/${DUMP_FILE}"

mkdir -p "$BACKUP_DIR"

echo "[Backup] $(date -Is) — starting backup for database '${DB_NAME}'..."

# ── 1. Dump + compress, writing to a temp file first (atomic-safe) ──
# --single-transaction: consistent snapshot without locking tables (safe for InnoDB, which this app uses)
# --routines --triggers --events: captures everything, not just table data
if ! mysqldump \
      --host="$DB_HOST" \
      --port="$DB_PORT" \
      --user="$DB_USER" \
      --password="$DB_PASSWORD" \
      --single-transaction \
      --routines \
      --triggers \
      --events \
      "$DB_NAME" | gzip -9 > "$TMP_FILE"; then
  echo "[Backup] FATAL: mysqldump or compression failed. Aborting." >&2
  rm -f "$TMP_FILE"
  exit 1
fi

# ── 2. Sanity check: the dump must not be empty/corrupt ──
if [ ! -s "$TMP_FILE" ]; then
  echo "[Backup] FATAL: dump file is empty. Aborting, not uploading garbage." >&2
  rm -f "$TMP_FILE"
  exit 1
fi

# Verify the gzip stream itself isn't truncated/corrupted before trusting it
if ! gzip -t "$TMP_FILE"; then
  echo "[Backup] FATAL: dump file failed gzip integrity check. Aborting." >&2
  rm -f "$TMP_FILE"
  exit 1
fi

# Only now, after all checks pass, promote temp file to final name
mv "$TMP_FILE" "$FINAL_FILE"
DUMP_SIZE=$(du -h "$FINAL_FILE" | cut -f1)
echo "[Backup] Dump created and verified: ${FINAL_FILE} (${DUMP_SIZE})"

# ── 3. Upload to Hetzner S3-compatible bucket ──
if ! aws s3 cp "$FINAL_FILE" "$S3_URI" --endpoint-url "$S3_ENDPOINT"; then
  echo "[Backup] FATAL: upload to S3 failed. Local backup is still kept at ${FINAL_FILE}." >&2
  exit 1
fi
echo "[Backup] Uploaded to ${S3_URI}"

# ── 4. Verify the upload actually landed and matches the local file size ──
REMOTE_SIZE=$(aws s3api head-object \
  --bucket "$S3_BUCKET" \
  --key "db-backups/${DUMP_FILE}" \
  --endpoint-url "$S3_ENDPOINT" \
  --query 'ContentLength' --output text 2>/dev/null || echo "0")
LOCAL_SIZE=$(stat -c%s "$FINAL_FILE")

if [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]; then
  echo "[Backup] FATAL: uploaded size (${REMOTE_SIZE}) does not match local size (${LOCAL_SIZE}). Upload may be corrupt." >&2
  exit 1
fi
echo "[Backup] Upload verified: sizes match (${LOCAL_SIZE} bytes)."

# ── 5. Prune old LOCAL backups only (S3 copies are left untouched/permanent) ──
find "$BACKUP_DIR" -name "movies_backup_*.sql.gz" -mtime "+${RETENTION_DAYS}" -print -delete

echo "[Backup] $(date -Is) — backup completed successfully."