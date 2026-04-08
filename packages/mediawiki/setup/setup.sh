#!/bin/bash
# First-boot setup via PHP maintenance scripts (no API auth needed)
set -e

MW="/var/www/html"
DATA="/var/www/data"

log() { echo "[setup] $*"; }

# Ensure Derek's password is set correctly
php "$MW/maintenance/run.php" changePassword --user=Derek --password='Yugioh4444!' 2>&1 || true
log "Password ensured"

# ── Main Page ──────────────────────────────────────────────────────────────────
php "$MW/maintenance/run.php" edit \
    --no-rc --user="Derek" --summary="OpenFS: main page" \
    "Main_Page" < "$MW/setup/main-page.wiki" 2>&1
log "Main_Page set"

# ── Common CSS ─────────────────────────────────────────────────────────────────
php "$MW/maintenance/run.php" edit \
    --no-rc --user="Derek" --summary="OpenFS: custom styles" \
    "MediaWiki:Common.css" < "$MW/setup/common.css" 2>&1
log "Common.css set"

# ── Sidebar ────────────────────────────────────────────────────────────────────
php "$MW/maintenance/run.php" edit \
    --no-rc --user="Derek" --summary="OpenFS: sidebar" \
    "MediaWiki:Sidebar" < "$MW/setup/sidebar.wiki" 2>&1
log "Sidebar set"

# ── OpenFS Terminal page ───────────────────────────────────────────────────────
php "$MW/maintenance/run.php" edit \
    --no-rc --user="Derek" --summary="OpenFS: terminal page" \
    "OpenFS_Terminal" < "$MW/setup/terminal-page.wiki" 2>&1
log "OpenFS_Terminal page set"

log "Setup complete."
touch "$DATA/.openfs-setup-done"
