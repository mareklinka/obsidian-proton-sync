# Proton Drive Sync (Obsidian Plugin)

This is an Obsidian community plugin that will enable syncing vault files with Proton Drive.

## Development

- Install dependencies.
- Start the development build (watch mode).

### Code quality

- Run lint checks: `npm run lint`
- Auto-fix lint issues: `npm run lint:fix`
- Check formatting: `npm run format:check`
- Apply formatting: `npm run format`
- Run all checks (lint + format + tests): `npm run check`

The build outputs `main.js`, which Obsidian loads.

## Loading the plugin in Obsidian

Copy this folder into your vault at:

`.obsidian/plugins/proton-drive-sync`

Then enable the plugin in **Settings → Community plugins**.

## Browser sign-in and security keys

In plugin settings, choose **Sign in in browser (security key)**, then
**Open Proton sign-in**. Complete sign-in and approve the connection on
`https://account.proton.me/` using your security key/passkey or other configured
method. Keep Obsidian and the waiting dialog open. Return to Obsidian when Proton
finishes and set a local master password to encrypt the saved session.

This uses the protocol-v3 encrypted session-fork flow from Proton's official
[Drive SDK](https://github.com/ProtonDriveApps/sdk/blob/main/incubating/account/js/src/authWeb.ts).
The plugin identifies as an external Drive client. Proton handles the password,
CAPTCHA and WebAuthn on its own origin. An ephemeral AES-256 key travels in the
sign-in URL fragment; it is not included in an HTTP query, local callback, or log.
Do not share the sign-in link. The returned key-password payload is authenticated
with AES-GCM before being encrypted into the existing local secret store.

The plugin polls for up to ten minutes. Cancel or unloading the plugin stops
polling and attempts cleanup, including revocation of a session returned after
cancellation. Declining the local master-password prompt also revokes the new
session. No vault notes or configuration are uploaded during sign-in, and sign-in
does not start push/pull. Mobile browsers may suspend Obsidian in the background;
return to the app after completing browser sign-in so polling can resume.

Browser sign-in is an experimental integration and still needs live Windows and
iPad verification. It does not require disabling a security key or adding TOTP.

## Human verification during password-based login

When Proton requires a CAPTCHA, choose **Open CAPTCHA in browser** in the
plugin's verification dialog. Complete verification on `https://verify.proton.me/`,
then return to Obsidian and choose **I completed verification — Continue**.
Keep the dialog open while verifying. Two-factor authentication follows when
required by the account; do not disable it.

This uses Proton's external-browser verification flow, rather than embedding its
page in an iframe. The browser submits the solution to Proton; the plugin retries
the original login once with the challenge token. Clicking Continue without
successful verification cannot authorize login. If Proton rejects the retry,
reconnect to request a fresh challenge. Cancel closes the attempt without retrying.

Initial authentication requests time out after 30 seconds. No verification URLs, passwords,
or human-verification tokens are logged by this flow. Signing in does not start
a push or pull.

Password-based sign-in inside the plugin supports six-digit authenticator codes
for 2FA. Security-key-only accounts are directed to browser sign-in before
account-key loading. Keep security keys enabled.
