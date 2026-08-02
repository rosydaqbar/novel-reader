import { ProjectDb } from './storage/projectDb.js';
import { SCHEMA_VERSION } from './storage/schema.js';
import { createSqliteAdapter } from './storage/sqliteAdapters.js';
import { flattenCodexEntries, serializeNovel } from './storage/markdownBridge.js';
import {
  hasHandlePermission,
  listCodexEntries as listLegacyCodexEntries,
  listVolumes as listLegacyVolumes,
  readCodexEntry as readLegacyCodexEntry,
  readCompiledCodexEntries as readLegacyCompiledCodexEntries,
  readVolume as readLegacyVolume,
  supportsProjectFiles,
  verifyHandlePermission
} from './localDatasource.js';

const SQLITE_HEADER = Uint8Array.from([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0]);
const MIN_SQLITE_BYTES = 100;
const FILE_API_MESSAGE = 'Project files require Chromium File System Access APIs. Use Chrome, Edge, or Brave.';

export const PROJECT_EXTENSION = '.novel';
export const PROJECT_MIME = 'application/novel-reader-project';
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
export { supportsProjectFiles };

let sqlJsPromise;

export class BrowserProjectFileError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'BrowserProjectFileError';
    this.code = code;
  }
}

export class BrowserProjectFile {
  constructor({ rawDb, projectDb, fileHandle = null, fileName, fileFingerprint = null } = {}) {
    if (!rawDb || !projectDb) throw new TypeError('A raw SQL.js database and ProjectDb are required.');
    this._rawDb = rawDb;
    this._projectDb = projectDb;
    this.fileHandle = fileHandle;
    this.fileName = fileName || fileHandle?.name || null;
    this._fileFingerprint = fileFingerprint;
    this._closed = false;
    this._pendingSaveCount = 0;
    this._saveChain = Promise.resolve();
  }

  get rawDb() {
    this._assertOpen();
    return this._rawDb;
  }

  get projectDb() {
    this._assertOpen();
    return this._projectDb;
  }

  get closed() {
    return this._closed;
  }

  get saving() {
    return this._pendingSaveCount > 0;
  }

  exportBytes() {
    this._assertOpen();
    return this._rawDb.export();
  }

  async save(options = {}) {
    this._assertOpen();
    this._pendingSaveCount += 1;
    const operation = this._saveChain.catch(() => {}).then(() => this._save(options));
    this._saveChain = operation;
    return operation.finally(() => {
      this._pendingSaveCount -= 1;
    });
  }

  async _save(options) {
    this._assertOpen();
    const lockManager = options.lockManager ?? globalThis.navigator?.locks;
    if (typeof lockManager?.request === 'function') {
      const projectId = this._projectDb.getProjectMeta().projectUuid;
      return lockManager.request(`novel-reader-project:${projectId}`, { mode: 'exclusive' }, () => this._saveUnlocked(options));
    }
    return this._saveUnlocked(options);
  }

  async _saveUnlocked(options) {
    this._assertOpen();
    let fileHandle = options.fileHandle ?? (options.saveAs ? null : this.fileHandle);
    if (!fileHandle) {
      const fileSystem = requireProjectFileApis(options.fileSystem);
      fileHandle = await fileSystem.showSaveFilePicker(projectSavePickerOptions(
        options.suggestedName ?? this.fileName ?? defaultProjectFileName(this._projectDb)
      ));
    }
    assertWritableFileHandle(fileHandle);
    if (options.verifyPermission !== false && !(await verifyHandlePermission(fileHandle))) {
      throw new BrowserProjectFileError('PROJECT_PERMISSION_DENIED', 'Read and write permission is required to save the project file.');
    }

    if (fileHandle === this.fileHandle && this._fileFingerprint && !options.overwriteExternalChanges) {
      const currentFile = await fileHandle.getFile();
      const currentBytes = new Uint8Array(await currentFile.arrayBuffer());
      if (!sameFingerprint(this._fileFingerprint, fingerprintFile(currentFile, currentBytes))) {
        throw new BrowserProjectFileError(
          'PROJECT_FILE_CHANGED',
          'The project file changed outside this editor. Reopen it or use Save As to avoid overwriting those changes.'
        );
      }
    }

    const bytes = this.exportBytes();
    if (bytes.byteLength > MAX_PROJECT_BYTES) {
      throw new BrowserProjectFileError('PROJECT_TOO_LARGE', `Project files are limited to ${MAX_PROJECT_BYTES} bytes.`);
    }
    await writeFileHandle(fileHandle, bytes);
    const savedFile = await fileHandle.getFile();
    this.fileHandle = fileHandle;
    this.fileName = fileHandle.name || this.fileName;
    this._fileFingerprint = fingerprintFile(savedFile, bytes);
    return { fileHandle, fileName: this.fileName, byteLength: bytes.byteLength };
  }

  close() {
    if (this._closed) return false;
    if (this.saving) {
      throw new BrowserProjectFileError('PROJECT_SAVE_IN_PROGRESS', 'Wait for the project save to finish before closing it.');
    }
    this._closed = true;
    const projectDb = this._projectDb;
    this._projectDb = null;
    this._rawDb = null;
    projectDb.close();
    return true;
  }

  _assertOpen() {
    if (this._closed) {
      throw new BrowserProjectFileError('PROJECT_CLOSED', 'The project database is closed.');
    }
  }
}

export function initializeSqlJs() {
  sqlJsPromise ??= Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url')
  ]).then(([sqlJsModule, wasmModule]) => {
    const initSqlJs = sqlJsModule.default ?? sqlJsModule;
    return initSqlJs({ locateFile: () => wasmModule.default });
  });
  return sqlJsPromise;
}

export function validateProjectBytes(input, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_PROJECT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer.');
  const bytes = toUint8Array(input);
  if (bytes.byteLength > maxBytes) {
    throw new BrowserProjectFileError('PROJECT_TOO_LARGE', `Project files are limited to ${maxBytes} bytes.`);
  }
  if (bytes.byteLength < MIN_SQLITE_BYTES || !hasSqliteHeader(bytes)) {
    throw new BrowserProjectFileError('INVALID_PROJECT_HEADER', 'The selected file is not a SQLite project file.');
  }
  return bytes;
}

export async function loadProjectFile(fileHandle, options = {}) {
  assertReadableFileHandle(fileHandle);
  const hasPermission = options.requestPermission === false
    ? await hasHandlePermission(fileHandle)
    : await verifyHandlePermission(fileHandle);
  if (!hasPermission) {
    throw new BrowserProjectFileError('PROJECT_PERMISSION_DENIED', 'Read and write permission is required to open the project file.');
  }

  const file = await fileHandle.getFile();
  const maxBytes = options.maxBytes ?? MAX_PROJECT_BYTES;
  if (file.size > maxBytes) {
    throw new BrowserProjectFileError('PROJECT_TOO_LARGE', `Project files are limited to ${maxBytes} bytes.`);
  }
  const bytes = validateProjectBytes(await file.arrayBuffer(), { maxBytes });
  return createBrowserProject(bytes, {
    fileHandle,
    fileName: file.name || fileHandle.name,
    fileFingerprint: fingerprintFile(file, bytes),
    loadSqlJs: options.loadSqlJs
  });
}

export async function openProjectFile(options = {}) {
  const fileSystem = requireProjectFileApis(options.fileSystem);
  const [fileHandle] = await fileSystem.showOpenFilePicker(projectOpenPickerOptions());
  return loadProjectFile(fileHandle, options);
}

export async function createInMemoryProject(options = {}) {
  const project = await createBrowserProject(null, {
    fileName: options.fileName,
    loadSqlJs: options.loadSqlJs
  });
  const meta = initialProjectMeta(options);
  if (Object.keys(meta).length) project.projectDb.updateProjectMeta(meta);
  return project;
}

export async function importMarkdownDatasource(rootHandle, options = {}) {
  if (!rootHandle || typeof rootHandle.getDirectoryHandle !== 'function') {
    throw new TypeError('A readable datasource directory handle is required.');
  }

  const sourceVolumes = await listLegacyVolumes(rootHandle);
  const volumeNumbers = new Set();
  for (const volume of sourceVolumes) {
    if (volumeNumbers.has(volume.number)) {
      throw new BrowserProjectFileError(
        'MARKDOWN_DUPLICATE_VOLUME',
        `Multiple markdown files resolve to volume ${volume.number}.`
      );
    }
    volumeNumbers.add(volume.number);
  }
  const sourceCodex = await listLegacyCodexEntries(rootHandle);
  const codexSummaries = flattenCodexEntries(sourceCodex);
  const compiledCodexEntries = codexSummaries.length ? [] : await readLegacyCompiledCodexEntries(rootHandle);
  const codexCount = codexSummaries.length || compiledCodexEntries.length;
  if (!sourceVolumes.length && !codexCount) {
    throw new BrowserProjectFileError(
      'MARKDOWN_SOURCE_EMPTY',
      'No supported novel volumes or codex entries were found in the selected folder.'
    );
  }

  const project = await createInMemoryProject({ loadSqlJs: options.loadSqlJs });
  try {
    const db = project.projectDb;
    let projectTitle = '';
    for (let index = 0; index < sourceVolumes.length; index += 1) {
      const sourceVolume = sourceVolumes[index];
      options.onProgress?.({
        stage: 'volumes',
        current: index + 1,
        total: sourceVolumes.length,
        label: sourceVolume.filename
      });
      const { novel } = await readLegacyVolume(rootHandle, sourceVolume.id);
      const volume = db.createVolume({ number: sourceVolume.number, title: novel.title });
      db.putNovel(volume.id, novel, { reindexMentions: false });
      projectTitle ||= novel.title;
    }

    for (let index = 0; index < codexSummaries.length; index += 1) {
      const summary = codexSummaries[index];
      options.onProgress?.({
        stage: 'codex',
        current: index + 1,
        total: codexSummaries.length,
        label: summary.name
      });
      const entry = await readLegacyCodexEntry(rootHandle, summary.category, summary.id);
      db.createCodexEntry(entry, { reindexMentions: false });
    }

    for (let index = 0; index < compiledCodexEntries.length; index += 1) {
      const entry = compiledCodexEntries[index];
      options.onProgress?.({
        stage: 'codex',
        current: index + 1,
        total: compiledCodexEntries.length,
        label: entry.name
      });
      db.createCodexEntry(entry, { reindexMentions: false });
    }

    const title = projectTitle || options.title || 'Imported Project';
    db.updateProjectMeta({ title });
    let mentionCount = 0;
    const importedVolumes = db.listVolumes();
    for (let index = 0; index < importedVolumes.length; index += 1) {
      const volume = importedVolumes[index];
      options.onProgress?.({
        stage: 'mentions',
        current: index + 1,
        total: importedVolumes.length,
        label: volume.label
      });
      mentionCount += db.rebuildMentionIndex(volume.id);
    }
    project.fileName = ensureExtension(title, PROJECT_EXTENSION);
    return {
      project,
      volumeCount: sourceVolumes.length,
      codexCount,
      mentionCount
    };
  } catch (error) {
    try {
      project.close();
    } catch {}
    if (isWasmMemoryError(error)) {
      throw new BrowserProjectFileError(
        'MARKDOWN_IMPORT_MEMORY',
        'The browser ran out of WebAssembly memory while converting this datasource. Use the Node migration command for an unusually large project.',
        { cause: error }
      );
    }
    throw error;
  }
}

export async function createProjectFile(options = {}) {
  const fileSystem = requireProjectFileApis(options.fileSystem);
  const suggestedName = ensureExtension(
    options.suggestedName ?? options.meta?.title ?? options.title ?? 'Untitled Project',
    PROJECT_EXTENSION
  );
  const fileHandle = await fileSystem.showSaveFilePicker(projectSavePickerOptions(suggestedName));
  const project = await createInMemoryProject(options);
  try {
    await project.save({ fileHandle, verifyPermission: options.verifyPermission });
    return project;
  } catch (error) {
    project.close();
    throw error;
  }
}

export function exportProjectBytes(project) {
  return requireBrowserProject(project).exportBytes();
}

export function saveProjectFile(project, options = {}) {
  return requireBrowserProject(project).save(options);
}

export function closeProjectFile(project) {
  return requireBrowserProject(project).close();
}

export async function exportVolumeMarkdown(project, volumeId, options = {}) {
  const lifecycle = requireBrowserProject(project);
  const volume = lifecycle.projectDb.getVolume(volumeId);
  if (!volume) throw new Error(`Volume ${volumeId} was not found.`);
  const markdown = options.novel
    ? serializeNovel(options.novel, { codexEntries: flattenCodexEntries(lifecycle.projectDb.listCodex()) })
    : lifecycle.projectDb.exportToMarkdown(volumeId);
  const fileSystem = requireProjectFileApis(options.fileSystem);
  const fileHandle = await fileSystem.showSaveFilePicker(markdownSavePickerOptions(
    options.suggestedName ?? volume.filename
  ));
  assertWritableFileHandle(fileHandle);
  if (options.verifyPermission !== false && !(await verifyHandlePermission(fileHandle))) {
    throw new BrowserProjectFileError('PROJECT_PERMISSION_DENIED', 'Write permission is required to export Markdown.');
  }
  await writeFileHandle(fileHandle, markdown);
  return { fileHandle, fileName: fileHandle.name, volumeId };
}

async function createBrowserProject(bytes, options = {}) {
  const SQL = await (options.loadSqlJs ?? initializeSqlJs)();
  if (typeof SQL?.Database !== 'function') throw new TypeError('The SQL.js loader did not return a Database constructor.');
  const rawDb = bytes == null ? new SQL.Database() : new SQL.Database(bytes);
  try {
    if (bytes != null) validateOpenedDatabase(rawDb);
    const projectDb = new ProjectDb(rawDb);
    return new BrowserProjectFile({
      rawDb,
      projectDb,
      fileHandle: options.fileHandle,
      fileName: options.fileName,
      fileFingerprint: options.fileFingerprint
    });
  } catch (error) {
    rawDb.close();
    throw error;
  }
}

function validateOpenedDatabase(rawDb) {
  const adapter = createSqliteAdapter(rawDb);
  const version = Number(adapter.get('PRAGMA user_version')?.user_version ?? 0);
  if (version !== SCHEMA_VERSION) {
    throw new BrowserProjectFileError(
      'UNSUPPORTED_PROJECT_VERSION',
      `Only project schema version ${SCHEMA_VERSION} is supported.`
    );
  }
  adapter.exec('PRAGMA foreign_keys = ON');
  const integrity = adapter.all('PRAGMA integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new BrowserProjectFileError('INVALID_PROJECT_INTEGRITY', 'The project database failed its integrity check.');
  }
  if (adapter.all('PRAGMA foreign_key_check').length) {
    throw new BrowserProjectFileError('INVALID_PROJECT_REFERENCES', 'The project database contains invalid references.');
  }
}

function fingerprintFile(file, bytes) {
  return {
    size: Number(file?.size ?? bytes.byteLength),
    lastModified: Number(file?.lastModified ?? 0),
    hash: hashBytes(bytes)
  };
}

function sameFingerprint(left, right) {
  return left.size === right.size && left.lastModified === right.lastModified && left.hash === right.hash;
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isWasmMemoryError(error) {
  return error instanceof WebAssembly.RuntimeError
    && /memory access out of bounds|out of memory/i.test(error.message);
}

async function writeFileHandle(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {}
    throw error;
  }
}

function requireProjectFileApis(scope) {
  const fileSystem = scope ?? (typeof window === 'undefined' ? null : window);
  if (!supportsProjectFiles(fileSystem)) {
    throw new BrowserProjectFileError('PROJECT_FILE_API_UNAVAILABLE', FILE_API_MESSAGE);
  }
  return fileSystem;
}

function projectOpenPickerOptions() {
  return {
    id: 'novel-reader-project',
    multiple: false,
    excludeAcceptAllOption: true,
    types: [projectFileType()]
  };
}

function projectSavePickerOptions(suggestedName) {
  return {
    id: 'novel-reader-project',
    suggestedName: ensureExtension(suggestedName, PROJECT_EXTENSION),
    excludeAcceptAllOption: true,
    types: [projectFileType()]
  };
}

function markdownSavePickerOptions(suggestedName) {
  return {
    id: 'novel-reader-markdown-export',
    suggestedName: ensureExtension(suggestedName, '.md'),
    excludeAcceptAllOption: false,
    types: [{ description: 'Markdown document', accept: { 'text/markdown': ['.md'] } }]
  };
}

function projectFileType() {
  return { description: 'Novel Reader project', accept: { [PROJECT_MIME]: [PROJECT_EXTENSION] } };
}

function initialProjectMeta(options) {
  const source = options.meta ?? options.projectMeta ?? options;
  const meta = {};
  for (const key of ['title', 'author', 'description']) {
    if (source[key] != null) meta[key] = String(source[key]);
  }
  return meta;
}

function defaultProjectFileName(projectDb) {
  return ensureExtension(projectDb.getProjectMeta().title || 'Untitled Project', PROJECT_EXTENSION);
}

function ensureExtension(value, extension) {
  const name = String(value || '').trim() || `Untitled${extension}`;
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Project data must be an ArrayBuffer or typed array.');
}

function hasSqliteHeader(bytes) {
  return SQLITE_HEADER.every((value, index) => bytes[index] === value);
}

function assertReadableFileHandle(fileHandle) {
  if (!fileHandle || typeof fileHandle.getFile !== 'function') {
    throw new TypeError('A readable FileSystemFileHandle is required.');
  }
}

function assertWritableFileHandle(fileHandle) {
  if (!fileHandle || typeof fileHandle.createWritable !== 'function') {
    throw new TypeError('A writable FileSystemFileHandle is required.');
  }
}

function requireBrowserProject(project) {
  if (!(project instanceof BrowserProjectFile)) throw new TypeError('A BrowserProjectFile is required.');
  return project;
}
