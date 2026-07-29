# Generate the Squid proxy CA certificate and key.
# Run from the .opencode/container/ directory before building.
# Requires: PowerShell 7+ (pwsh) on Windows \u2014 no openssl needed.

$ErrorActionPreference = 'Stop'

$certDir = 'squid-cert'
$certFile = Join-Path $certDir 'squid-cert.pem'
$keyFile = Join-Path $certDir 'squid-key.pem'

New-Item -ItemType Directory -Force -Path $certDir | Out-Null

if ((Test-Path $certFile) -and (Test-Path $keyFile)) {
    Write-Host "Certificate already exists at ${certFile}. Skipping generation."
    Write-Host "Delete ${certDir}/ to regenerate."
    exit 0
}

Write-Host 'Generating self-signed CA certificate...'

$cert = New-SelfSignedCertificate `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -DnsName 'OpenCode-Proxy-CA' `
    -Subject 'CN=OpenCode-Proxy-CA, O=OpenCode, L=Proxy, S=Local, C=US' `
    -KeyExportPolicy Exportable `
    -KeyLength 2048 `
    -KeyAlgorithm RSA `
    -NotAfter (Get-Date).AddDays(3650) `
    -NotBefore (Get-Date) `
    -HashAlgorithm SHA256 `
    -KeyUsageProperty All `
    -KeyUsage DigitalSignature, CertSign, CRLSign `
    -Type Custom `
    -TextExtension @('2.5.29.19={text}critical,true')

$RSACng = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
$KeyBytes = $RSACng.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob)
$pemContent = [System.Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
@"
-----BEGIN CERTIFICATE-----
${pemContent}
-----END CERTIFICATE-----
"@ | Out-File -FilePath $certFile -Encoding utf8 -NoNewline

$pkcs8B64 = [Convert]::ToBase64String($KeyBytes, [System.Base64FormattingOptions]::InsertLineBreaks)
$keyPem = @"
-----BEGIN PRIVATE KEY-----
${pkcs8B64}
-----END PRIVATE KEY-----
"@
$keyPem | Out-File -FilePath $keyFile -Encoding utf8 -NoNewline

Remove-Item "Cert:\CurrentUSer\My\$($cert.Thumbprint)" -Force

Write-Host 'Certificate generated:'
Write-Host "  ${certFile}"
Write-Host "  ${keyFile}"
Write-Host ''
Write-Host 'Now rebuild: docker compose up -d --build'