#!/bin/bash
set -e

DATA=/var/www/data
SEED=/var/www/data-seed

# On first boot with a fresh volume, seed the SQLite databases
for f in my_wiki.sqlite my_wiki_jobqueue.sqlite my_wiki_l10n_cache.sqlite wikicache.sqlite; do
    if [ ! -f "$DATA/$f" ] && [ -f "$SEED/$f" ]; then
        cp "$SEED/$f" "$DATA/$f"
        chown www-data:www-data "$DATA/$f"
    fi
done

# Run first-boot wiki setup (pages, CSS, sidebar) once
if [ ! -f "$DATA/.openfs-setup-done" ]; then
    (sleep 5 && bash /var/www/html/setup/setup.sh >> /var/log/openfs-setup.log 2>&1) &
fi

# Start Apache (official mediawiki image entrypoint)
exec apache2-foreground
