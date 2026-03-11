import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const VERSION_FILE = 'VERSION';
const TARGET_FILES = ['package.json', 'manifest.json'];
const PLAIN_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const execFileAsync = promisify(execFile);

async function main() {
  const rootDir = process.cwd();
  const versionFilePath = path.join(rootDir, VERSION_FILE);
  const version = await readVersion(versionFilePath);
  const filesNeedingUpdate = await getFilesNeedingUpdate(rootDir, version);

  if (filesNeedingUpdate.length > 0) {
    await ensureVersionChangeIsIsolated(rootDir, filesNeedingUpdate);
  }

  let updatedFileCount = 0;

  for (const relativePath of filesNeedingUpdate) {
    const updated = await syncJsonVersion(path.join(rootDir, relativePath), version);
    if (updated) {
      updatedFileCount += 1;
    }
  }

  const message =
    updatedFileCount > 0
      ? `Synchronized version ${version} to ${updatedFileCount} file(s).`
      : `Version ${version} is already synchronized.`;

  process.stdout.write(`${message}\n`);
}

async function readVersion(filePath) {
  const rawVersion = await readFile(filePath, 'utf8');
  const version = rawVersion.trim();

  if (!version) {
    throw new Error(`${VERSION_FILE} is empty. Expected a plain semver version like 1.2.3.`);
  }

  if (!PLAIN_SEMVER_PATTERN.test(version)) {
    throw new Error(
      `${VERSION_FILE} must contain a plain semver version without suffixes (for example 1.2.3). Received: ${JSON.stringify(version)}`
    );
  }

  return version;
}

async function getFilesNeedingUpdate(rootDir, version) {
  const filesNeedingUpdate = [];

  for (const relativePath of TARGET_FILES) {
    const filePath = path.join(rootDir, relativePath);
    const currentVersion = await readJsonVersion(filePath);

    if (currentVersion !== version) {
      filesNeedingUpdate.push(relativePath);
    }
  }

  return filesNeedingUpdate;
}

async function readJsonVersion(filePath) {
  const rawJson = await readFile(filePath, 'utf8');
  const parsedJson = JSON.parse(rawJson);

  if (!isPlainObject(parsedJson)) {
    throw new Error(`${path.basename(filePath)} must contain a top-level JSON object.`);
  }

  if (typeof parsedJson.version !== 'string') {
    throw new Error(`${path.basename(filePath)} is missing a string version field.`);
  }

  return parsedJson.version;
}

async function ensureVersionChangeIsIsolated(rootDir, filesNeedingUpdate) {
  const editedFiles = await getEditedFiles(rootDir);
  const disallowedFiles = editedFiles.filter(relativePath => relativePath !== VERSION_FILE);

  if (disallowedFiles.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to synchronize ${filesNeedingUpdate.join(', ')} because other edited files are present: ${disallowedFiles.join(', ')}. ` +
      `Commit or stash those changes first, then commit the version bump separately.`
  );
}

async function getEditedFiles(rootDir) {
  const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: rootDir });

  return stdout
    .split(/\r?\n/u)
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .map(parseStatusLinePath)
    .filter(relativePath => relativePath.length > 0);
}

function parseStatusLinePath(statusLine) {
  const pathPortion = statusLine.slice(3);
  const renamedSegments = pathPortion.split(' -> ');

  return renamedSegments.at(-1) ?? '';
}

async function syncJsonVersion(filePath, version) {
  const rawJson = await readFile(filePath, 'utf8');
  const parsedJson = JSON.parse(rawJson);

  if (parsedJson.version === version) {
    return false;
  }

  parsedJson.version = version;
  await writeFile(filePath, `${JSON.stringify(parsedJson, null, 2)}\n`, 'utf8');

  return true;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Version sync failed: ${message}\n`);
  process.exitCode = 1;
});
