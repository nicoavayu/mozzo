#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKEND_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$BACKEND_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$BACKEND_DIR/.env"
  set +a
fi

SOURCE_DB=${1:-${DATABASE_PATH:-"$BACKEND_DIR/database.sqlite"}}
BACKUP_DIR=${BACKUP_DIR:-"$BACKEND_DIR/backups"}
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
DEST_PATH=${2:-"$BACKUP_DIR/mozzo-$TIMESTAMP.sqlite"}

mkdir -p "$(dirname "$DEST_PATH")"

(
cd "$BACKEND_DIR"
node - "$SOURCE_DB" "$DEST_PATH" <<'NODE'
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const source = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);

if (!fs.existsSync(source)) {
  console.error(`Source database not found: ${source}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });

const db = new sqlite3.Database(source, sqlite3.OPEN_READONLY, (error) => {
  if (error) {
    console.error(`Failed to open source database: ${error.message}`);
    process.exit(1);
  }
});

const backup = db.backup(destination);

backup.step(-1, (error) => {
  if (error) {
    console.error(`SQLite backup failed: ${error.message}`);
    db.close(() => process.exit(1));
    return;
  }

  db.close((closeError) => {
    if (closeError) {
      console.error(`Backup succeeded but close failed: ${closeError.message}`);
      process.exit(1);
      return;
    }

    console.log(`SQLite backup created at ${destination}`);
  });
});
NODE
)
