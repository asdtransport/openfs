FROM mediawiki:1.43

# Store initial SQLite DBs in a seed location (survives volume mounts)
RUN mkdir -p /var/www/data-seed /var/www/data
COPY data/ /var/www/data-seed/

# Copy LocalSettings, branding assets, and setup scripts
COPY LocalSettings.php /var/www/html/LocalSettings.php
COPY openfs-icon.svg /var/www/html/openfs-icon.svg
COPY openfs-wordmark.svg /var/www/html/openfs-wordmark.svg
COPY setup/ /var/www/html/setup/
COPY entrypoint.sh /entrypoint.sh

# Fix permissions
RUN chmod +x /entrypoint.sh /var/www/html/setup/setup.sh \
 && chown -R www-data:www-data /var/www/data-seed /var/www/data /var/www/html/images

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
