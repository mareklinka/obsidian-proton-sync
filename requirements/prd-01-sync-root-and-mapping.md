# PRD: Sync Root & Mapping

## Overview
Establish and manage a common Proton Drive container folder named `obsidian-notes`, and define deterministic mapping rules between local vault paths and remote nodes. Each vault has its own sync root folder under this container.

## Goals
- Create or locate a common Proton Drive container folder named `obsidian-notes`.
- Create or locate a single root folder for each vault under the common container.
- Provide stable path mapping between local file paths and remote node identifiers.
- Persist root identifiers to resume sync without re-discovery.

## Non-Goals
- Conflict resolution logic.
- Upload/download implementation details.

## User Stories
- As a user, I want my vault to sync into a single Proton Drive folder so I can locate it easily.
- As a user, I want the plugin to remember the sync root so it doesn’t recreate folders each time.

## Requirements
- Create or locate a common Proton Drive container folder named `obsidian-notes` to hold all vault roots.
- Detect existing sync root by stored node UID or by metadata tag (if available).
- Create a new sync root folder when none exists.
- Place each vault’s sync root folder under the common container to avoid cluttering the user’s Drive root.
- Store root identifiers locally (node UID).
- Store the common container identifier locally to avoid re-creating it.
- Generate a stable `vaultId` (UUID) per vault and persist it locally; do not derive it solely from vault name.
- Run container/root discovery after successful authentication and on vault open, reusing cached identifiers unless explicitly reset.
- Define mapping rules (e.g., vault-relative path → remote path; handle path normalization and forbidden characters).
- Mapping must detect and resolve collisions deterministically (e.g., append a stable hash suffix) and persist the final mapping.
- Support multiple vaults with separate roots.
- Sync targets are limited to the user’s personal Proton Drive space; shared locations are out of scope.
- Remote operations must use node UIDs after discovery; name/path lookups are only for discovery and recovery.
- Folder creation must ensure intermediate parents exist; empty folders should be represented remotely.
- Obsidian API constraints:
  - Treat the Obsidian vault as the authoritative local scope; sync must operate on vault-relative paths only.
  - Use `Vault.getAbstractFileByPath()` for fast existence checks within the vault; use `DataAdapter.exists()` only when adapter-level access is required.
  - Use `Vault.read()`/`Vault.cachedRead()` for plaintext reads, `Vault.modify()`/`Vault.process()` for writes, and `Vault.create()`/`Vault.createFolder()` for new content to keep Obsidian metadata consistent.
  - Use `Vault.readBinary()` for binary attachments; do not re-encode binary data when uploading.
  - Use `Vault.delete()` or `Vault.trash()` for deletes to respect Obsidian’s file lifecycle.
  - `.obsidian` may be configured under `vault.configDir` (not always literally `.obsidian`); treat it as a special local config directory and sync it by default to allow roaming settings.

## Data Model
- SyncContainer:
  - containerNodeUid
  - containerName (fixed: obsidian-notes)
  - createdAt
  - updatedAt
- SyncRoot:
  - vaultId
  - remoteNodeUid
  - createdAt
  - updatedAt
- PathMap:
  - localPath
  - remoteNodeUid
  - remotePath
  - updatedAt

## UX/Settings
- Display sync root name and location in settings (read-only initially).

## Risks/Notes
- Proton Drive may have path/name constraints (e.g., characters not allowed).
- Root discovery must be resilient to renames or moved folders.
- Proton Drive names are not guaranteed to be unique; use node UIDs for all operations after discovery.
- Listing children may require pagination and may be eventually consistent; avoid relying solely on name lookups.
- Sanitization can cause path collisions; collision handling must be stable across platforms and persisted.
- Case-insensitive file systems can cause `Note.md` vs `note.md` conflicts; detect and resolve deterministically.
- Supporting shared locations is explicitly out of scope.

## Acceptance Criteria
- On first run, the common container folder `obsidian-notes` is created or discovered.
- On first run, a per-vault root folder is created or discovered under the common container.
- On restart, the same root is reused without duplication.
- Path mapping is deterministic and reversible for all valid vault paths.
- Mapping collisions are resolved deterministically and persisted (e.g., hash suffixes).
- Empty local folders are represented as folders on Proton Drive.
- Discovery runs after auth and on vault open; cached identifiers are reused unless reset.
- Sync operations use Obsidian Vault APIs for files inside the vault, avoiding adapter-only access unless required for hidden paths.
- The vault config directory (`vault.configDir`) is included in sync by default with no additional configuration.

## Code Examples & Verification

### Example 1: Ensure common container (`obsidian-notes`)

**Goal:** Create or reuse the shared container folder in the user’s personal Drive.

```ts
async function ensureSyncContainer(client: ProtonApiClient): Promise<{ uid: string }>
{
  const existing = await client.findChildByName({ parentUid: 'root', name: 'obsidian-notes' });
  if (existing)
  {
    return { uid: existing.uid };
  }

  const created = await client.createFolder({ parentUid: 'root', name: 'obsidian-notes' });
  return { uid: created.uid };
}
```

**Explanation:**
- Proton Drive is treated as a hierarchy of nodes under a personal root.
- We look up the container by name under the root node; if not found, we create it.
- The returned `uid` is persisted as `SyncContainer.containerNodeUid` so we don’t repeat discovery.

**Verification checklist:**
- The folder `obsidian-notes` exists at the root of the user’s Drive after the first run.
- Subsequent runs do not create duplicates; the same `uid` is reused.

### Example 2: Ensure per-vault root under container

**Goal:** Create or reuse a vault-specific folder under `obsidian-notes`.

```ts
async function ensureVaultRoot(
  client: ProtonApiClient,
  containerUid: string,
  vaultId: string,
  vaultName: string
): Promise<{ uid: string }>
{
  const expectedName = `${vaultName}-${vaultId}`;
  const existing = await client.findChildByName({ parentUid: containerUid, name: expectedName });
  if (existing)
  {
    return { uid: existing.uid };
  }

  const created = await client.createFolder({ parentUid: containerUid, name: expectedName });
  return { uid: created.uid };
}
```

**Explanation:**
- The vault root name must be deterministic to support re-discovery.
- Use a stable identifier (e.g., `vaultId`) to avoid collisions if two vaults share names.
- The returned `uid` is persisted as `SyncRoot.remoteNodeUid` for this vault.

**Verification checklist:**
- Each vault gets a dedicated folder under `obsidian-notes`.
- Reopening the vault reuses the same folder without duplicates.

### Example 3: Map vault-relative path to remote path

**Goal:** Produce a stable mapping between a vault-relative path and a remote node path.

```ts
function stableHash(input: string): string
{
  let hash = 0;
  for (let i = 0; i < input.length; i += 1)
  {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function mapToRemotePath(
  vaultRelativePath: string,
  existingRemotePaths: Set<string>
): string
{
  const normalized = vaultRelativePath.replace(/\\/g, '/');
  const sanitized = normalized.replace(/[:*?"<>|]/g, '_');

  if (!existingRemotePaths.has(sanitized))
  {
    existingRemotePaths.add(sanitized);
    return sanitized;
  }

  const hashed = `${sanitized}__h=${stableHash(normalized)}`;
  existingRemotePaths.add(hashed);
  return hashed;
}
```

**Explanation:**
- Paths are normalized to forward slashes for consistency.
- Disallowed characters are sanitized to ensure remote compatibility.
- `existingRemotePaths` should be derived from the persisted `PathMap` for the vault.
- If sanitization collides, append a stable hash suffix and persist the mapping.

**Verification checklist:**
- The same local path always maps to the same remote path.
- The mapping is consistent across Windows/macOS/Linux.
- When collisions occur, the hash suffix is applied and persists across sessions.

### Example 4: Read/Write using Obsidian Vault APIs and mirror to Proton Drive

**Goal:** Use Obsidian’s Vault APIs for local changes, then reflect those changes remotely.

```ts
async function syncNoteUpdate(
  vault: Vault,
  client: ProtonApiClient,
  rootUid: string,
  file: TFile,
  pathMap: Map<string, { remoteNodeUid: string; remotePath: string }>
): Promise<void>
{
  const isBinary = file.extension !== 'md' && file.extension !== 'txt';
  const remotePath = mapToRemotePath(file.path, new Set());
  const mapped = pathMap.get(file.path);
  const remoteNodeUid = mapped?.remoteNodeUid;

  const remoteNode = remoteNodeUid
    ? { uid: remoteNodeUid }
    : await client.findChildByPath({ parentUid: rootUid, path: remotePath });

  if (!remoteNode)
  {
    if (isBinary)
    {
      const content = await vault.readBinary(file);
      const created = await client.createBinaryFile({ parentUid: rootUid, path: remotePath, contents: content });
      pathMap.set(file.path, { remoteNodeUid: created.uid, remotePath });
      return;
    }

    const content = await vault.read(file);
    const created = await client.createFile({ parentUid: rootUid, path: remotePath, contents: content });
    pathMap.set(file.path, { remoteNodeUid: created.uid, remotePath });
    return;
  }

  pathMap.set(file.path, { remoteNodeUid: remoteNode.uid, remotePath });

  if (isBinary)
  {
    const content = await vault.readBinary(file);
    await client.updateBinaryFile({ nodeUid: remoteNode.uid, contents: content });
    return;
  }

  const content = await vault.read(file);
  await client.updateFile({ nodeUid: remoteNode.uid, contents: content });
}
```

**Explanation:**
- `vault.read()` ensures Obsidian’s file cache and metadata remain consistent for text files.
- Binary attachments use `vault.readBinary()` and binary upload APIs to avoid re-encoding.
- A remote path is derived from `file.path` (vault-relative) and resolved to a node UID, then cached in `pathMap` for reuse.
- The remote file is created or updated based on existence.

**Verification checklist:**
- Editing a note updates the corresponding file on Proton Drive.
- The remote content matches the local file contents byte-for-byte.

### Example 5: Sync the vault config directory (`vault.configDir`)

**Goal:** Ensure Obsidian’s config folder is synced by default for roaming settings.

```ts
async function syncConfigFolder(
  vault: Vault,
  client: ProtonApiClient,
  rootUid: string
): Promise<void>
{
  const configDir = vault.configDir; // e.g. ".obsidian"
  const files = vault.getFiles().filter((file) => file.path.startsWith(`${configDir}/`));

  for (const file of files)
  {
    await syncNoteUpdate(vault, client, rootUid, file);
  }
}
```

**Explanation:**
- `vault.configDir` may not be literally `.obsidian`, so it must be read dynamically.
- The config folder is treated as ordinary vault content and synced automatically.

**Verification checklist:**
- Changes under the config directory appear in the remote vault root.
- A second device pulling the vault sees updated settings and UI state.
