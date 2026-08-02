import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProjectDb } from '../src/storage/projectDb.js';
import { SCHEMA_VERSION } from '../src/storage/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const MIN_SQLITE_BYTES = 100;

export const PROJECT_MIME = 'application/novel-reader-project';
export const DEFAULT_PROJECT_PATH = path.join(rootDir, 'datasource', 'project.novel');
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;

export class ProjectFileError extends Error {
  constructor(code, message, status = 400, options) {
    super(message, options);
    this.name = 'ProjectFileError';
    this.code = code;
    this.status = status;
  }
}

export class ProjectServer {
  constructor(options = {}) {
    this.projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH);
    this.busyTimeoutMs = positiveInteger(options.busyTimeoutMs, 5000);
    this.maxImportBytes = positiveInteger(options.maxImportBytes, MAX_PROJECT_BYTES);
    this.projectDb = null;
    this.importInProgress = false;
    this._open();
  }

  getProjectDb() {
    if (!this.projectDb) throw new ProjectFileError('PROJECT_CLOSED', 'The project database is closed.', 503);
    return this.projectDb;
  }

  close() {
    if (!this.projectDb) return;
    this.projectDb.close();
    this.projectDb = null;
  }

  exportSnapshot() {
    const database = this.getProjectDb().adapter.raw;
    return Buffer.from(database.serialize());
  }

  async importSnapshot(input, options = {}) {
    if (this.importInProgress) {
      throw new ProjectFileError('PROJECT_IMPORT_IN_PROGRESS', 'Another project import is already in progress.', 409);
    }
    this.importInProgress = true;
    try {
      return await this._importSnapshot(input, options);
    } finally {
      this.importInProgress = false;
    }
  }

  async _importSnapshot(input, options = {}) {
    const bytes = normalizeProjectBytes(input, this.maxImportBytes);
    const directory = path.dirname(this.projectPath);
    await mkdir(directory, { recursive: true });
    const stagedPath = temporaryPath(this.projectPath, 'import');
    const backupPath = temporaryPath(this.projectPath, 'backup');
    let backupCreated = false;
    let installed = false;

    try {
      await writeFile(stagedPath, bytes, { flag: 'wx' });
      validateProjectFile(stagedPath, this.busyTimeoutMs);

      if (!options.replace && !this.isEmpty()) {
        throw new ProjectFileError(
          'PROJECT_EXISTS',
          'The current project contains data. Pass replace=true to replace it.',
          409
        );
      }

      try {
        this.close();
        await removeSqliteSidecars(this.projectPath);
        if (existsSync(this.projectPath)) {
          await rename(this.projectPath, backupPath);
          backupCreated = true;
        }
        await rename(stagedPath, this.projectPath);
        installed = true;
        this._open(true);
      } catch (error) {
        await this._restoreBackup({ backupPath, backupCreated, installed });
        throw new ProjectFileError('PROJECT_IMPORT_FAILED', 'The project file could not be activated.', 400, { cause: error });
      }

      if (backupCreated) await rm(backupPath, { force: true });
      return this.getProjectDb().getProjectMeta();
    } finally {
      await removeSqliteFiles(stagedPath);
      if (this.projectDb && backupCreated) await removeSqliteFiles(backupPath);
    }
  }

  isEmpty() {
    const db = this.getProjectDb();
    const meta = db.getProjectMeta();
    const codexCount = Object.values(db.listCodex()).reduce((total, entries) => total + entries.length, 0);
    return db.listVolumes().length === 0
      && codexCount === 0
      && !meta.title
      && !meta.author
      && !meta.description;
  }

  _open(requireExisting = false) {
    mkdirSync(path.dirname(this.projectPath), { recursive: true });
    let raw;
    try {
      raw = new BetterSqlite3(this.projectPath, { fileMustExist: requireExisting });
      const projectDb = new ProjectDb(raw);
      applySafePragmas(projectDb, this.busyTimeoutMs);
      this.projectDb = projectDb;
    } catch (error) {
      if (raw?.open) raw.close();
      throw error;
    }
  }

  async _restoreBackup({ backupPath, backupCreated, installed }) {
    this.close();
    if (installed) await removeSqliteFiles(this.projectPath);
    if (backupCreated) await rename(backupPath, this.projectPath);
    if (backupCreated || existsSync(this.projectPath)) this._open(true);
    else this._open();
  }
}

export async function migrateMarkdownProject(options = {}) {
  const sourceDir = path.resolve(options.sourceDir ?? options.source ?? path.join(rootDir, 'datasource'));
  const outputPath = path.resolve(options.outputPath ?? options.output ?? path.join(sourceDir, 'project.novel'));
  const force = Boolean(options.force);

  if (existsSync(outputPath) && !force) {
    throw new ProjectFileError('PROJECT_EXISTS', 'The output project file already exists. Use --force to replace it.', 409);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const stagedPath = temporaryPath(outputPath, 'migration');
  const volumes = await discoverMarkdownVolumes(sourceDir);
  const codexEntries = await discoverCodexEntries(sourceDir);
  if (!volumes.length && !codexEntries.length) {
    throw new ProjectFileError('MIGRATION_SOURCE_EMPTY', 'No supported novel volumes or codex entries were found in the source.', 400);
  }
  const server = new ProjectServer({ projectPath: stagedPath });

  try {
    const db = server.getProjectDb();
    let firstTitle = '';
    for (const volume of volumes) {
      db.createVolume({ number: volume.number, title: '' });
      db.importFromMarkdown(`volume${volume.number}`, volume.markdown, { reindexMentions: false });
      firstTitle ||= db.getNovel(`volume${volume.number}`).title;
    }
    for (const entry of codexEntries) {
      db.importCodexEntryFromMarkdown(entry.category, entry.id, entry.markdown, { reindexMentions: false });
    }
    if (firstTitle) db.updateProjectMeta({ title: firstTitle });
    let mentionCount = 0;
    for (const volume of db.listVolumes()) mentionCount += db.rebuildMentionIndex(volume.id);
    server.close();

    if (force) {
      await replaceStagedFile(stagedPath, outputPath);
    } else {
      await copyFile(stagedPath, outputPath, fsConstants.COPYFILE_EXCL);
      await rm(stagedPath, { force: true });
    }

    return {
      outputPath,
      volumeCount: volumes.length,
      codexCount: codexEntries.length,
      mentionCount
    };
  } catch (error) {
    server.close();
    if (error?.code === 'EEXIST') {
      throw new ProjectFileError('PROJECT_EXISTS', 'The output project file already exists. Use --force to replace it.', 409, { cause: error });
    }
    throw error;
  } finally {
    server.close();
    await removeSqliteFiles(stagedPath);
  }
}

export const migrateToNovel = migrateMarkdownProject;

export async function discoverMarkdownVolumes(sourceDir) {
  const volumeFiles = await numberedMarkdownFiles(path.join(sourceDir, 'volumes'), /^volume(\d+)\.md$/);
  const actFiles = await numberedMarkdownFiles(path.join(sourceDir, 'acts'), /^act(\d+)\.md$/);
  assertUniqueVolumeNumbers(volumeFiles, 'volumes');
  assertUniqueVolumeNumbers(actFiles, 'acts');
  const selected = new Map(volumeFiles.map((file) => [file.number, file]));
  for (const act of actFiles) {
    if (!selected.has(act.number)) selected.set(act.number, act);
  }

  if (!selected.size) {
    const legacyPath = path.join(sourceDir, 'novel.md');
    if (existsSync(legacyPath)) selected.set(1, { number: 1, filePath: legacyPath });
  }

  return Promise.all(
    [...selected.values()]
      .sort((left, right) => left.number - right.number)
      .map(async (file) => ({ ...file, markdown: await readFile(file.filePath, 'utf8') }))
  );
}

function assertUniqueVolumeNumbers(files, sourceName) {
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.number)) {
      throw new ProjectFileError(
        'MIGRATION_DUPLICATE_VOLUME',
        `Multiple ${sourceName} files resolve to volume ${file.number}.`,
        400
      );
    }
    seen.add(file.number);
  }
}

function applySafePragmas(projectDb, busyTimeoutMs) {
  projectDb.adapter.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
  `);
}

function validateProjectFile(filePath, busyTimeoutMs) {
  let raw;
  let projectDb;
  try {
    raw = new BetterSqlite3(filePath, { fileMustExist: true, timeout: busyTimeoutMs });
    const userVersion = Number(raw.pragma('user_version', { simple: true }));
    if (userVersion !== SCHEMA_VERSION) {
      throw new ProjectFileError('UNSUPPORTED_PROJECT_VERSION', `Only project schema version ${SCHEMA_VERSION} is supported.`, 400);
    }
    raw.pragma('foreign_keys = ON');
    raw.pragma('trusted_schema = OFF');
    raw.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const integrity = raw.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new ProjectFileError('INVALID_PROJECT_INTEGRITY', 'The project database failed its integrity check.', 400);
    }
    const foreignKeys = raw.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) {
      throw new ProjectFileError('INVALID_PROJECT_REFERENCES', 'The project database contains invalid references.', 400);
    }
    projectDb = new ProjectDb(raw);
    applySafePragmas(projectDb, busyTimeoutMs);
    projectDb.getProjectMeta();
  } catch (error) {
    if (error instanceof ProjectFileError) throw error;
    throw new ProjectFileError('INVALID_PROJECT_FILE', 'The uploaded data is not a valid project file.', 400, { cause: error });
  } finally {
    if (projectDb) projectDb.close();
    else if (raw?.open) raw.close();
  }
}

function normalizeProjectBytes(input, maxBytes) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (bytes.length > maxBytes) {
    throw new ProjectFileError('PROJECT_TOO_LARGE', `Project files are limited to ${maxBytes} bytes.`, 413);
  }
  if (bytes.length < MIN_SQLITE_BYTES || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new ProjectFileError('INVALID_PROJECT_HEADER', 'The uploaded data is not a SQLite project file.', 400);
  }
  if (![1, 2].includes(bytes[18]) || ![1, 2].includes(bytes[19])) {
    throw new ProjectFileError('INVALID_SQLITE_VERSION', 'The project file uses an unsupported SQLite file format.', 400);
  }
  return bytes;
}

async function discoverCodexEntries(sourceDir) {
  const entries = [];
  for (const category of ['characters', 'locations', 'lore']) {
    const categoryDir = path.join(sourceDir, 'codex', category);
    for (const directory of await readDirectoryOrEmpty(categoryDir)) {
      if (!directory.isDirectory()) continue;
      const entryPath = path.join(categoryDir, directory.name, 'entry.md');
      try {
        entries.push({ category, id: directory.name, markdown: await readFile(entryPath, 'utf8') });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return entries;
}

async function numberedMarkdownFiles(directory, pattern) {
  return (await readDirectoryOrEmpty(directory))
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(pattern);
      return match ? { number: Number(match[1]), filePath: path.join(directory, entry.name) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.number - right.number);
}

async function readDirectoryOrEmpty(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function temporaryPath(targetPath, label) {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${label}-${randomUUID()}.tmp`);
}

async function removeSqliteSidecars(filePath) {
  await Promise.all([
    rm(`${filePath}-wal`, { force: true }),
    rm(`${filePath}-shm`, { force: true })
  ]);
}

async function removeSqliteFiles(filePath) {
  await Promise.all([rm(filePath, { force: true }), removeSqliteSidecars(filePath)]);
}

async function replaceStagedFile(stagedPath, outputPath) {
  const backupPath = temporaryPath(outputPath, 'migration-backup');
  let backupCreated = false;
  try {
    await removeSqliteSidecars(outputPath);
    if (existsSync(outputPath)) {
      await rename(outputPath, backupPath);
      backupCreated = true;
    }
    await rename(stagedPath, outputPath);
    if (backupCreated) await rm(backupPath, { force: true });
  } catch (error) {
    if (backupCreated && !existsSync(outputPath)) await rename(backupPath, outputPath);
    throw error;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
