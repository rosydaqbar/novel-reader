import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';

import {
  BrowserProjectFileError,
  MAX_PROJECT_BYTES,
  PROJECT_MIME,
  createInMemoryProject,
  createProjectFile,
  exportVolumeMarkdown,
  importMarkdownDatasource,
  loadProjectFile,
  openProjectFile,
  supportsProjectFiles,
  validateProjectBytes
} from '../src/browserDb.js';
import {
  clearRecentProjectHandle,
  loadRecentDatasourceHandle,
  loadRecentProjectHandle,
  saveRecentDatasourceHandle,
  saveRecentProjectHandle,
  supportsLocalFiles
} from '../src/localDatasource.js';

let sqlJsPromise;
const loadSqlJs = () => (sqlJsPromise ??= initSqlJs());

test('browser lifecycle exports SQLite bytes, awaits file close, reopens, and guards closed state', async () => {
  const project = await createInMemoryProject({
    loadSqlJs,
    meta: { title: 'Browser Lifecycle', author: 'Writer' }
  });
  const volume = project.projectDb.createVolume({ number: 1, title: 'Book One' });
  const chapter = project.projectDb.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Opening' });
  const scene = project.projectDb.createScene({ chapterId: chapter.id, heading: 'Scene 1' });
  project.projectDb.setParagraphs(scene.id, ['Persisted in browser memory.']);

  const initialBytes = project.exportBytes();
  assert.deepEqual([...initialBytes.subarray(0, 16)], [...sqliteHeader()]);

  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const handle = createMemoryFileHandle('lifecycle.novel', { closeGate });
  let saveResolved = false;
  const saving = project.save({ fileHandle: handle }).then((result) => {
    saveResolved = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveResolved, false, 'save does not report success before writable.close resolves');
  assert.deepEqual(handle.events, ['createWritable', 'write', 'close']);
  assert.throws(
    () => project.close(),
    (error) => error instanceof BrowserProjectFileError && error.code === 'PROJECT_SAVE_IN_PROGRESS'
  );
  releaseClose();
  const saved = await saving;
  assert.equal(saved.fileName, 'lifecycle.novel');
  assert.equal(saved.byteLength, handle.bytes.byteLength);

  const reopened = await loadProjectFile(handle, { loadSqlJs });
  assert.equal(reopened.projectDb.getProjectMeta().title, 'Browser Lifecycle');
  assert.equal(reopened.projectDb.getNovel('volume1').chapters[0].scenes[0].paragraphs[0], 'Persisted in browser memory.');
  assert.equal(reopened.close(), true);
  assert.equal(reopened.close(), false);
  assert.throws(() => reopened.exportBytes(), closedProjectError);
  assert.throws(() => reopened.projectDb, closedProjectError);
  await assert.rejects(reopened.save({ fileHandle: handle }), closedProjectError);

  project.close();
});

test('browser lifecycle rejects external file changes and unrelated SQLite databases', async () => {
  const project = await createInMemoryProject({ loadSqlJs, title: 'Conflict Test' });
  const handle = createMemoryFileHandle('conflict.novel');
  await project.save({ fileHandle: handle });
  project.projectDb.updateProjectMeta({ title: 'Local Edit' });
  handle.bytes = handle.bytes.slice();
  handle.bytes[100] ^= 1;
  handle.lastModified += 1;
  await assert.rejects(
    project.save(),
    (error) => error instanceof BrowserProjectFileError && error.code === 'PROJECT_FILE_CHANGED'
  );
  project.close();

  const SQL = await loadSqlJs();
  const unrelated = new SQL.Database();
  unrelated.run('CREATE TABLE unrelated (value TEXT)');
  const unrelatedHandle = createMemoryFileHandle('unrelated.novel');
  unrelatedHandle.bytes = unrelated.export();
  unrelated.close();
  await assert.rejects(
    loadProjectFile(unrelatedHandle, { loadSqlJs }),
    (error) => error instanceof BrowserProjectFileError && error.code === 'UNSUPPORTED_PROJECT_VERSION'
  );
});

test('cross-tab saves recheck file state inside a shared project lock', async () => {
  const handle = createMemoryFileHandle('shared.novel');
  const seed = await createInMemoryProject({ loadSqlJs, title: 'Shared' });
  await seed.save({ fileHandle: handle });
  seed.close();

  const first = await loadProjectFile(handle, { loadSqlJs });
  const second = await loadProjectFile(handle, { loadSqlJs });
  first.projectDb.updateProjectMeta({ title: 'First tab' });
  second.projectDb.updateProjectMeta({ title: 'Second tab' });
  const lockManager = createFakeLockManager();
  const results = await Promise.allSettled([
    first.save({ lockManager }),
    second.save({ lockManager })
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'PROJECT_FILE_CHANGED');
  first.close();
  second.close();
});

test('project byte validation rejects oversized and invalid files before SQL.js opens them', async () => {
  const validShape = new Uint8Array(100);
  validShape.set(sqliteHeader());
  assert.equal(validateProjectBytes(validShape).byteLength, 100);
  assert.throws(
    () => validateProjectBytes(new Uint8Array(100)),
    (error) => error instanceof BrowserProjectFileError && error.code === 'INVALID_PROJECT_HEADER'
  );
  assert.throws(
    () => validateProjectBytes(validShape, { maxBytes: 99 }),
    (error) => error instanceof BrowserProjectFileError && error.code === 'PROJECT_TOO_LARGE'
  );

  let bytesRead = false;
  const oversized = createMemoryFileHandle('large.novel');
  oversized.getFile = async () => ({
    name: oversized.name,
    size: MAX_PROJECT_BYTES + 1,
    async arrayBuffer() {
      bytesRead = true;
      return new ArrayBuffer(0);
    }
  });
  await assert.rejects(
    loadProjectFile(oversized, { loadSqlJs }),
    (error) => error instanceof BrowserProjectFileError && error.code === 'PROJECT_TOO_LARGE'
  );
  assert.equal(bytesRead, false, 'the adapter checks File.size before reading the file');
});

test('project and Markdown pickers use accept metadata and preserve picker cancellation', async () => {
  const projectHandle = createMemoryFileHandle('picked.novel');
  const markdownHandle = createMemoryFileHandle('volume1.md');
  const pickerCalls = [];
  const saveHandles = [projectHandle, markdownHandle];
  const fileSystem = {
    async showOpenFilePicker() {
      throw new Error('not used');
    },
    async showSaveFilePicker(options) {
      pickerCalls.push(options);
      return saveHandles.shift();
    }
  };

  assert.equal(supportsProjectFiles(fileSystem), true);
  const project = await createProjectFile({
    fileSystem,
    loadSqlJs,
    title: 'Picked Project',
    author: 'Browser Writer'
  });
  assert.equal(project.projectDb.getProjectMeta().author, 'Browser Writer');
  assert.equal(pickerCalls[0].suggestedName, 'Picked Project.novel');
  assert.deepEqual(pickerCalls[0].types[0].accept, { [PROJECT_MIME]: ['.novel'] });
  assert.deepEqual([...projectHandle.bytes.subarray(0, 16)], [...sqliteHeader()]);

  const volume = project.projectDb.createVolume({ number: 1, title: 'Exported Volume' });
  const chapter = project.projectDb.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Chapter' });
  const scene = project.projectDb.createScene({ chapterId: chapter.id, heading: 'Scene 1' });
  project.projectDb.setParagraphs(scene.id, ['Exported Markdown body.']);
  await exportVolumeMarkdown(project, volume.id, { fileSystem });
  assert.deepEqual(pickerCalls[1].types[0].accept, { 'text/markdown': ['.md'] });
  assert.match(markdownHandle.text, /Exported Markdown body\./);
  project.close();

  const cancellation = new DOMException('Picker cancelled', 'AbortError');
  const cancellingFileSystem = {
    async showOpenFilePicker() {
      throw cancellation;
    },
    async showSaveFilePicker() {
      throw cancellation;
    }
  };
  await assert.rejects(
    openProjectFile({ fileSystem: cancellingFileSystem, loadSqlJs }),
    (error) => error === cancellation
  );
  await assert.rejects(
    openProjectFile({ fileSystem: {} }),
    (error) => error.code === 'PROJECT_FILE_API_UNAVAILABLE' && /Chromium File System Access APIs/.test(error.message)
  );
});

test('legacy markdown datasource imports into a saveable project without modifying the source', async () => {
  const actOne = novelMarkdown('Legacy One', 'Aria enters the old hall.');
  const currentTwo = novelMarkdown('Current Two', 'The current second volume.');
  const duplicateActTwo = novelMarkdown('Old Two', 'This duplicate must be ignored.');
  const rootNovel = novelMarkdown('Root Novel', 'This fallback must be ignored.');
  const ariaEntry = [
    '---',
    'type: character',
    'name: Aria',
    'color: blue',
    'aliases:',
    '  - The Singer',
    'tags:',
    '  - lead',
    'alwaysIncludeInContext: true',
    'doNotTrack: false',
    'noAutoInclude: true',
    'fields: {"role":"hero"}',
    '---',
    'Imported codex body.',
    ''
  ].join('\n');
  const source = createMemoryDirectory('legacy', {
    volumes: createMemoryDirectory('volumes', {
      'volume2.md': createTextFile('volume2.md', currentTwo)
    }),
    acts: createMemoryDirectory('acts', {
      'act1.md': createTextFile('act1.md', actOne),
      'act2.md': createTextFile('act2.md', duplicateActTwo)
    }),
    'novel.md': createTextFile('novel.md', rootNovel),
    codex: createMemoryDirectory('codex', {
      characters: createMemoryDirectory('characters', {
        aria: createMemoryDirectory('aria', {
          'entry.md': createTextFile('entry.md', ariaEntry)
        })
      }),
      locations: createMemoryDirectory('locations'),
      lore: createMemoryDirectory('lore')
    })
  });
  const progress = [];
  const result = await importMarkdownDatasource(source, {
    loadSqlJs,
    onProgress(item) {
      progress.push(`${item.stage}:${item.label}`);
    }
  });

  assert.equal(result.volumeCount, 2);
  assert.equal(result.codexCount, 1);
  assert.ok(result.mentionCount >= 1);
  assert.deepEqual(result.project.projectDb.listVolumes().map((volume) => volume.id), ['volume1', 'volume2']);
  assert.equal(result.project.projectDb.getNovel('volume1').title, 'Legacy One');
  assert.equal(result.project.projectDb.getNovel('volume2').title, 'Current Two');
  assert.doesNotMatch(result.project.projectDb.exportToMarkdown('volume2'), /Old Two/);
  assert.doesNotMatch(result.project.projectDb.exportToMarkdown('volume1'), /Root Novel/);
  const importedAria = result.project.projectDb.getCodexEntry('characters', 'aria');
  const importedChapterId = result.project.projectDb.getNovel('volume1').chapters[0].id;
  const importedSceneId = result.project.projectDb.getNovel('volume1').chapters[0].scenes[0].id;
  assert.deepEqual(importedAria.fields, { role: 'hero' });
  assert.equal(importedAria.color, 'blue');
  assert.deepEqual(importedAria.aliases, ['The Singer']);
  assert.deepEqual(importedAria.tags, ['lead']);
  assert.equal(importedAria.alwaysIncludeInContext, true);
  assert.equal(importedAria.noAutoInclude, true);
  assert.equal(result.project.fileHandle, null);
  assert.equal(result.project.fileName, 'Legacy One.novel');
  assert.deepEqual(progress, [
    'volumes:act1.md',
    'volumes:volume2.md',
    'codex:Aria',
    'mentions:Volume 1',
    'mentions:Volume 2'
  ]);
  assert.equal(await source.children.acts.children['act1.md'].readText(), actOne);
  assert.equal(await source.children.codex.children.characters.children.aria.children['entry.md'].readText(), ariaEntry);

  const output = createMemoryFileHandle('converted.novel');
  const fileSystem = {
    async showOpenFilePicker() {
      throw new Error('not used');
    },
    async showSaveFilePicker(options) {
      assert.equal(options.suggestedName, 'Legacy One.novel');
      return output;
    }
  };
  await result.project.save({ fileSystem });
  const reopened = await loadProjectFile(output, { loadSqlJs });
  assert.equal(reopened.projectDb.getProjectMeta().title, 'Legacy One');
  assert.equal(reopened.projectDb.getNovel('volume1').chapters[0].id, importedChapterId);
  assert.equal(reopened.projectDb.getNovel('volume1').chapters[0].scenes[0].id, importedSceneId);
  assert.equal(reopened.projectDb.getCodexEntry('characters', 'aria').internalId, importedAria.internalId);
  assert.equal(reopened.projectDb.getCodexEntry('characters', 'aria').body, 'Imported codex body.');
  reopened.close();
  result.project.close();
});

test('legacy markdown import rejects an empty datasource', async () => {
  await assert.rejects(
    importMarkdownDatasource(createMemoryDirectory('empty'), { loadSqlJs }),
    (error) => error instanceof BrowserProjectFileError && error.code === 'MARKDOWN_SOURCE_EMPTY'
  );
});

test('legacy markdown import supports root novel fallback and read-only compiled codex recovery', async () => {
  const compiledCodex = [
    '# Compiled Codex',
    '',
    '## Characters',
    '',
    '### Aria',
    '',
    '- Type: character',
    '- Source: characters/aria/entry.md',
    '- Aliases: The Singer',
    '- Tags: lead',
    '',
    '#### Codex Mentioned',
    '',
    '- **Lore:** Old Law',
    '',
    '#### Chapters Mentioned',
    '',
    '- **Chapter 1:** Opening',
    '',
    'Recovered source body.',
    ''
  ].join('\n');
  const source = createMemoryDirectory('compiled-only', {
    'novel.md': createTextFile('novel.md', novelMarkdown('Root Import', 'The Singer arrives.')),
    'codex.md': createTextFile('codex.md', compiledCodex)
  });
  const result = await importMarkdownDatasource(source, { loadSqlJs });
  assert.equal(result.volumeCount, 1);
  assert.equal(result.codexCount, 1);
  assert.equal(result.project.projectDb.getNovel('volume1').title, 'Root Import');
  const aria = result.project.projectDb.getCodexEntry('characters', 'aria');
  assert.deepEqual(aria.aliases, ['The Singer']);
  assert.equal(aria.body, 'Recovered source body.');
  assert.doesNotMatch(aria.body, /Codex Mentioned|Chapters Mentioned|Old Law/);
  assert.equal(await source.children['codex.md'].readText(), compiledCodex);
  result.project.close();
});

test('legacy markdown import rejects duplicate normalized volume numbers', async () => {
  const source = createMemoryDirectory('duplicates', {
    volumes: createMemoryDirectory('volumes', {
      'volume1.md': createTextFile('volume1.md', novelMarkdown('One', 'First.')),
      'volume01.md': createTextFile('volume01.md', novelMarkdown('Leading Zero', 'Duplicate.'))
    })
  });
  await assert.rejects(
    importMarkdownDatasource(source, { loadSqlJs }),
    (error) => error instanceof BrowserProjectFileError && error.code === 'MARKDOWN_DUPLICATE_VOLUME'
  );
});

test('recent project handles use a distinct IndexedDB key and project capability check', async (t) => {
  const previousWindow = globalThis.window;
  const previousIndexedDb = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDb();
  globalThis.window = {
    showDirectoryPicker() {},
    showOpenFilePicker() {},
    showSaveFilePicker() {}
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousIndexedDb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDb;
  });

  const datasourceHandle = { kind: 'directory', name: 'manuscript' };
  const projectHandle = { kind: 'file', name: 'project.novel' };
  await saveRecentDatasourceHandle(datasourceHandle);
  await saveRecentProjectHandle(projectHandle);
  assert.equal(await loadRecentDatasourceHandle(), datasourceHandle);
  assert.equal(await loadRecentProjectHandle(), projectHandle);

  await clearRecentProjectHandle();
  assert.equal(await loadRecentProjectHandle(), null);
  assert.equal(await loadRecentDatasourceHandle(), datasourceHandle);

  await saveRecentProjectHandle(projectHandle);
  delete globalThis.window.showSaveFilePicker;
  assert.equal(supportsLocalFiles(), true);
  assert.equal(await loadRecentProjectHandle(), null, 'folder support alone must not enable recent project loading');
  assert.equal(await loadRecentDatasourceHandle(), datasourceHandle);
});

function createMemoryFileHandle(name, options = {}) {
  return {
    kind: 'file',
    name,
    bytes: new Uint8Array(),
    text: '',
    lastModified: 1,
    events: [],
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
    async getFile() {
      const snapshot = this.bytes.slice();
      return {
        name: this.name,
        size: snapshot.byteLength,
        lastModified: this.lastModified,
        async arrayBuffer() {
          return snapshot.buffer;
        }
      };
    },
    async createWritable() {
      const handle = this;
      this.events.push('createWritable');
      return {
        write: async (content) => {
          this.events.push('write');
          if (typeof content === 'string') {
            this.text = content;
            this.bytes = new TextEncoder().encode(content);
          } else {
            this.bytes = new Uint8Array(content).slice();
            this.text = '';
          }
        },
        close: async () => {
          this.events.push('close');
          await options.closeGate;
          handle.lastModified += 1;
        }
      };
    }
  };
}

function createTextFile(name, content) {
  return {
    kind: 'file',
    name,
    async getFile() {
      return {
        async text() {
          return content;
        }
      };
    },
    async readText() {
      return content;
    }
  };
}

function createMemoryDirectory(name, children = {}) {
  return {
    kind: 'directory',
    name,
    children,
    async getDirectoryHandle(childName) {
      const child = children[childName];
      if (child?.kind === 'directory') return child;
      throw notFoundError(childName);
    },
    async getFileHandle(childName) {
      const child = children[childName];
      if (child?.kind === 'file') return child;
      throw notFoundError(childName);
    },
    async *entries() {
      for (const entry of Object.entries(children)) yield entry;
    }
  };
}

function notFoundError(name) {
  const error = new Error(`${name} was not found.`);
  error.name = 'NotFoundError';
  return error;
}

function createFakeIndexedDb() {
  const stores = new Map();
  let initialized = false;
  const database = {
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(name) {
      const values = stores.get(name);
      const transaction = {
        error: null,
        objectStore() {
          return {
            get(key) {
              const request = { result: undefined, error: null };
              queueMicrotask(() => {
                request.result = values.get(key);
                request.onsuccess?.();
              });
              return request;
            },
            put(value, key) {
              values.set(key, value);
              queueMicrotask(() => transaction.oncomplete?.());
            },
            delete(key) {
              values.delete(key);
              queueMicrotask(() => transaction.oncomplete?.());
            }
          };
        }
      };
      return transaction;
    }
  };

  return {
    open() {
      const request = { result: database, error: null };
      queueMicrotask(() => {
        if (!initialized) {
          initialized = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function createFakeLockManager() {
  let queue = Promise.resolve();
  return {
    request(_name, _options, operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }
  };
}

function sqliteHeader() {
  return Uint8Array.from([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0]);
}

function closedProjectError(error) {
  return error instanceof BrowserProjectFileError && error.code === 'PROJECT_CLOSED';
}

function novelMarkdown(title, body) {
  return [`## ${title}`, '', '### Chapter 1: Opening', '', '#### Scene 1', '', body, ''].join('\n');
}
