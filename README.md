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
