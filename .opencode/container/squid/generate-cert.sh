#!/bin/sh
# Generate the Squid proxy CA certificate and key.
# Run this script from the .opencode/container/ directory before building.
set -e

CERT_DIR="squid-cert"
CERT_FILE="${CERT_DIR}/squid-cert.pem"
KEY_FILE="${CERT_DIR}/squid-key.pem"

mkdir -p "$CERT_DIR"

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  echo "Certificate already exists at ${CERT_FILE}. Skipping generation."
  echo "Delete ${CERT_DIR}/ to regenerate."
  exit 0
fi

echo "Generating self-signed CA certificate..."
openssl req -new -newkey rsa:2048 -days 3650 -nodes \
  -x509 -subj "/C=US/ST=Local/L=Proxy/O=OpenCode/CN=OpenCode-Proxy-CA" \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE"

echo "Certificate generated:"
echo "  ${CERT_FILE}"
echo "  ${KEY_FILE}"
echo ""
echo "Now rebuild: docker compose up -d --build"
