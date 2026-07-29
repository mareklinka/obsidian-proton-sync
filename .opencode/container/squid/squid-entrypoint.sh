#!/bin/sh
set -e

CERT_DIR="/etc/squid/ssl_cert"
CERT_FILE="${CERT_DIR}/squid-cert.pem"
KEY_FILE="${CERT_DIR}/squid-key.pem"
SSL_DB_DIR="/squid-data/ssl_db"

# Verify that the CA certificate and key exist (generated on host)
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[squid-entrypoint] ERROR: Certificate not found at ${CERT_DIR}"
  echo "[squid-entrypoint] Run ./generate-cert.sh in the container config directory first."
  exit 1
fi

# Initialize the SSL certificate database if not already done.
# squid's security_file_certgen -c calls mkdir() and treats EEXIST as
# failure, so we only run -c when the database is truly missing.
if [ ! -f "$SSL_DB_DIR/index.txt" ]; then
  # Remove stale directory (if mkdir left a partial state) so certgen -c succeeds
  rm -rf "$SSL_DB_DIR"
  echo "[squid-entrypoint] Initializing SSL bump database..."
  /usr/lib/squid/security_file_certgen -s "$SSL_DB_DIR" -c -M 4MB
  chown -R squid:squid "$SSL_DB_DIR"
  ls -la "$SSL_DB_DIR"
else
  echo "[squid-entrypoint] SSL bump database already initialized."
fi

# remove the PID file to allow container restart
if [ -e /var/run/squid.pid ]; then
	rm -f /var/run/squid.pid
fi

# Parse config to validate
squid -f /etc/squid/squid.conf -k parse

# Start squid with remaining arguments (from CMD)
echo "[squid-entrypoint] Starting Squid..."
exec squid "$@"
