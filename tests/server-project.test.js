import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import { createApp } from '../server/index.js';
import { parseCodexEntry, serializeCodexEntry } from '../server/codex.js';
import { migrateMarkdownProject, PROJECT_MIME, ProjectServer } from '../server/projectServer.js';
import { parseMigrationArgs } from '../tools/migrate-to-novel.js';

const silentLogger = { error() {} };

test('legacy codex serialization preserves object fields', () => {
  const markdown = serializeCodexEntry({
    category: 'characters',
    type: 'character',
    name: 'Aria',
    fields: { role: 'hero', rank: 2 },
    aliases: [],
    tags: [],
    body: 'Body.'
  });
  assert.deepEqual(parseCodexEntry(markdown).meta.fields, { role: 'hero', rank: 2 });
});

test('ProjectServer persists lifecycle state and produces reopenable snapshot bytes', async (t) => {
  const directory = await temporaryDirectory(t);
  const projectPath = path.join(directory, 'lifecycle.novel');
  let server = new ProjectServer({ projectPath, busyTimeoutMs: 2345 });
  const db = server.getProjectDb();
  db.updateProjectMeta({ title: 'Lifecycle', author: 'Writer' });
  const volume = db.createVolume({ number: 1, title: 'Book One' });
  db.importFromMarkdown(volume.id, novelMarkdown('Book One', 'A persistent sentence.'));

  assert.equal(Number(db.adapter.get('PRAGMA foreign_keys').foreign_keys), 1);
  assert.equal(Number(db.adapter.get('PRAGMA trusted_schema').trusted_schema), 0);
  assert.equal(Number(db.adapter.get('PRAGMA busy_timeout').timeout), 2345);

  const snapshot = server.exportSnapshot();
  assert.ok(snapshot.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary')));
  server.close();

  server = new ProjectServer({ projectPath });
  assert.equal(server.getProjectDb().getProjectMeta().title, 'Lifecycle');
  assert.equal(server.getProjectDb().getNovel('volume1').chapters[0].scenes[0].paragraphs[0], 'A persistent sentence.');
  server.close();

  const snapshotPath = path.join(directory, 'snapshot.novel');
  await writeFile(snapshotPath, snapshot);
  server = new ProjectServer({ projectPath: snapshotPath });
  assert.equal(server.getProjectDb().getProjectMeta().author, 'Writer');
  assert.equal(server.getProjectDb().listVolumes().length, 1);
  server.close();
});

test('project app supports metadata, volume/codex compatibility, Markdown, search, rebuild, and export', async (t) => {
  const context = await startTemporaryApp(t);

  let response = await context.fetch('/api/project');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project.schemaVersion, 1);

  response = await context.fetch('/api/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: { title: 'API Project', author: 'API Writer' } })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project.author, 'API Writer');

  response = await context.fetch('/api/volumes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Volume Via API' })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.volume.id, 'volume1');
  assert.equal(created.novel.chapters.length, 1);
  assert.equal(created.volumes.length, 1);

  response = await context.fetch('/api/codex/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Aria' })
  });
  assert.equal(response.status, 201);
  const codexId = (await response.json()).entry.id;

  response = await context.fetch(`/api/codex/characters/${codexId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entry: {
        name: 'Aria',
        aliases: ['The Singer'],
        tags: ['lead'],
        fields: { role: 'hero' },
        alwaysIncludeInContext: true,
        body: 'A sapphire-eyed traveler who follows the Lantern Rite.'
      }
    })
  });
  assert.equal(response.status, 200);
  const savedEntry = (await response.json()).entry;
  assert.deepEqual(savedEntry.fields, { role: 'hero' });
  assert.deepEqual(savedEntry.aliases, ['The Singer']);

  response = await context.fetch('/api/codex/lore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Lantern Rite' })
  });
  assert.equal(response.status, 201);

  const novel = {
    header: ['## Volume Via API', '<!-- retained -->', ''],
    title: 'Volume Via API',
    chapters: [{
      chapterNumber: 1,
      title: 'Arrival',
      scenes: [{ heading: 'Scene 1', paragraphs: ['Aria carries a sapphire lantern.'] }]
    }]
  };
  response = await context.fetch('/api/volumes/volume1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novel })
  });
  assert.equal(response.status, 200);
  const savedNovel = await response.json();
  assert.equal(savedNovel.novel.wordCount, 5);
  assert.equal(savedNovel.volume.path, 'datasource/volumes/volume1.md');

  response = await context.fetch('/api/codex/characters/' + codexId);
  assert.equal(response.status, 200);
  assert.match((await response.json()).entry.body, /Lantern Rite/);

  response = await context.fetch('/api/search?q=sapphire');
  const search = await response.json();
  assert.equal(search.scenes.length, 1);
  assert.equal(search.codex.length, 1);

  response = await context.fetch('/api/mentions/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volumeId: 'volume1' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 1);

  response = await context.fetch('/api/volumes/volume1/markdown');
  assert.match(response.headers.get('content-type'), /^text\/markdown/);
  const exportedMarkdown = await response.text();
  assert.match(exportedMarkdown, /<!-- retained -->/);
  assert.match(exportedMarkdown, /#### Codex Mentioned/);

  const replacementMarkdown = novelMarkdown('Markdown Replacement', 'The Singer returns at dusk.');
  response = await context.fetch('/api/volumes/volume1/markdown', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: replacementMarkdown
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /The Singer returns at dusk\./);

  response = await context.fetch('/api/acts');
  const acts = await response.json();
  assert.deepEqual(acts.acts, acts.volumes);

  response = await context.fetch('/api/codex/compile', { method: 'POST' });
  const compiled = await response.json();
  assert.equal(compiled.count, 2);
  assert.equal(compiled.path, 'datasource/codex.md');
  assert.match(compiled.markdown, /### Aria/);
  assert.match(compiled.markdown, /#### Codex Mentioned/);
  assert.match(compiled.markdown, /#### Chapters Mentioned/);
  assert.equal(compiled.written, true);
  assert.equal(await readFile(path.join(context.directory, 'codex.md'), 'utf8'), compiled.markdown);

  response = await context.fetch('/api/project/export');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), PROJECT_MIME);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="project\.novel"/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary')));

  response = await context.fetch('/api/not-a-route');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type').startsWith('application/json'), true);
  assert.equal((await response.json()).code, 'API_NOT_FOUND');
});

test('binary import replaces only when allowed and invalid imports leave the active project intact', async (t) => {
  const directory = await temporaryDirectory(t);
  const incomingPath = path.join(directory, 'incoming.novel');
  const incoming = new ProjectServer({ projectPath: incomingPath });
  incoming.getProjectDb().updateProjectMeta({ title: 'Incoming Project' });
  incoming.getProjectDb().createVolume({ number: 3, title: 'Third' });
  const incomingBytes = incoming.exportSnapshot();
  incoming.close();

  const context = await startTemporaryApp(t);
  let response = await context.fetch('/api/project', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Current Project' })
  });
  assert.equal(response.status, 200);

  response = await context.fetch('/api/project/import', {
    method: 'POST',
    headers: { 'Content-Type': PROJECT_MIME },
    body: incomingBytes
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PROJECT_EXISTS');

  response = await context.fetch('/api/project/import?replace=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: incomingBytes
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project.title, 'Incoming Project');

  response = await context.fetch('/api/volumes');
  assert.deepEqual((await response.json()).volumes.map((volume) => volume.id), ['volume3']);

  const unsupportedVersion = Buffer.from(incomingBytes);
  unsupportedVersion.writeUInt32BE(2, 60);
  response = await context.fetch('/api/project/import?replace=true', {
    method: 'POST',
    headers: { 'Content-Type': PROJECT_MIME },
    body: unsupportedVersion
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'UNSUPPORTED_PROJECT_VERSION');

  response = await context.fetch('/api/project');
  assert.equal((await response.json()).project.title, 'Incoming Project');
  response = await context.fetch('/api/volumes');
  assert.deepEqual((await response.json()).volumes.map((volume) => volume.id), ['volume3']);

  response = await context.fetch('/api/project/import?replace=true', {
    method: 'POST',
    headers: { 'Content-Type': PROJECT_MIME },
    body: Buffer.from('not a sqlite file')
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_PROJECT_HEADER');
});

test('ProjectServer serializes binary replacement attempts', async (t) => {
  const directory = await temporaryDirectory(t);
  const target = new ProjectServer({ projectPath: path.join(directory, 'target.novel') });
  const incoming = new ProjectServer({ projectPath: path.join(directory, 'incoming.novel') });
  incoming.getProjectDb().updateProjectMeta({ title: 'Incoming' });
  const bytes = incoming.exportSnapshot();
  incoming.close();

  const first = target.importSnapshot(bytes, { replace: true });
  await assert.rejects(
    target.importSnapshot(bytes, { replace: true }),
    (error) => error.code === 'PROJECT_IMPORT_IN_PROGRESS'
  );
  await first;
  assert.equal(target.getProjectDb().getProjectMeta().title, 'Incoming');
  target.close();
});

test('explicit Markdown mode retains filesystem-backed compatibility without creating a project file', async (t) => {
  const context = await startTemporaryApp(t, { storageMode: 'markdown' });
  let response = await context.fetch('/api/volumes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Markdown Only' })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.volume.id, 'volume1');
  assert.match(await readFile(path.join(context.directory, 'volumes', 'volume1.md'), 'utf8'), /Markdown Only/);

  response = await context.fetch('/api/codex/lore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Old Law' })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).codex.lore.length, 1);

  response = await context.fetch('/api/project');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PROJECT_MODE_DISABLED');
  await assert.rejects(readFile(path.join(context.directory, 'project.novel')), (error) => error.code === 'ENOENT');
});

test('migration applies volume precedence, preserves codex data, leaves Markdown untouched, and refuses overwrite', async (t) => {
  const sourceDir = await temporaryDirectory(t);
  const outputPath = path.join(sourceDir, 'converted.novel');
  await mkdir(path.join(sourceDir, 'volumes'), { recursive: true });
  await mkdir(path.join(sourceDir, 'acts'), { recursive: true });
  await mkdir(path.join(sourceDir, 'codex', 'characters', 'aria'), { recursive: true });

  const volumeTwo = ['## Current Volume Two', '<!-- volume header -->', '', '### Chapter 2: Current', '', '#### Scene 1', '', 'Current volume wins.', ''].join('\n');
  const actOne = novelMarkdown('Legacy Act One', 'Aria appears in the legacy act.');
  const duplicateActTwo = novelMarkdown('Duplicate Act Two', 'This must not be migrated.');
  const rootNovel = novelMarkdown('Root Fallback', 'This root file must be ignored.');
  const codexMarkdown = [
    '---',
    'type: character',
    'name: Aria',
    'color: blue',
    'aliases:',
    '  - The Singer',
    'tags:',
    '  - lead',
    'alwaysIncludeInContext: true',
    'doNotTrack: true',
    'noAutoInclude: false',
    'fields: {"role":"hero","rank":2}',
    '---',
    'Preserved codex body.',
    ''
  ].join('\n');

  await writeFile(path.join(sourceDir, 'volumes', 'volume2.md'), volumeTwo);
  await writeFile(path.join(sourceDir, 'acts', 'act1.md'), actOne);
  await writeFile(path.join(sourceDir, 'acts', 'act2.md'), duplicateActTwo);
  await writeFile(path.join(sourceDir, 'novel.md'), rootNovel);
  await writeFile(path.join(sourceDir, 'codex', 'characters', 'aria', 'entry.md'), codexMarkdown);

  const result = await migrateMarkdownProject({ sourceDir, outputPath });
  assert.equal(result.volumeCount, 2);
  assert.equal(result.codexCount, 1);
  assert.ok(result.mentionCount >= 1);
  assert.equal(await readFile(path.join(sourceDir, 'acts', 'act1.md'), 'utf8'), actOne);
  assert.equal(await readFile(path.join(sourceDir, 'volumes', 'volume2.md'), 'utf8'), volumeTwo);

  const migrated = new ProjectServer({ projectPath: outputPath });
  const db = migrated.getProjectDb();
  assert.deepEqual(db.listVolumes().map((volume) => volume.id), ['volume1', 'volume2']);
  assert.equal(db.getNovel('volume1').title, 'Legacy Act One');
  assert.equal(db.getNovel('volume2').title, 'Current Volume Two');
  assert.match(db.getNovel('volume2').header.join('\n'), /volume header/);
  assert.doesNotMatch(db.exportToMarkdown('volume2'), /Duplicate Act Two/);
  assert.doesNotMatch(db.exportToMarkdown('volume1'), /Root Fallback/);
  const aria = db.getCodexEntry('characters', 'aria');
  assert.equal(aria.color, 'blue');
  assert.deepEqual(aria.aliases, ['The Singer']);
  assert.deepEqual(aria.tags, ['lead']);
  assert.deepEqual(aria.fields, { role: 'hero', rank: 2 });
  assert.equal(aria.alwaysIncludeInContext, true);
  assert.equal(aria.doNotTrack, true);
  assert.equal(aria.body, 'Preserved codex body.');
  assert.equal(db.searchScenes('legacy act').length, 1);
  assert.equal(db.searchCodex('Preserved').length, 1);
  migrated.close();

  const before = await readFile(outputPath);
  await assert.rejects(
    migrateMarkdownProject({ sourceDir, outputPath }),
    (error) => error.code === 'PROJECT_EXISTS'
  );
  assert.deepEqual(await readFile(outputPath), before);

  const rootOnlySource = path.join(sourceDir, 'root-only');
  const rootOnlyOutput = path.join(rootOnlySource, 'root.novel');
  await mkdir(rootOnlySource, { recursive: true });
  await writeFile(path.join(rootOnlySource, 'novel.md'), novelMarkdown('Only Root', 'Fallback content.'));
  await migrateMarkdownProject({ sourceDir: rootOnlySource, outputPath: rootOnlyOutput });
  const rootOnly = new ProjectServer({ projectPath: rootOnlyOutput });
  assert.equal(rootOnly.getProjectDb().getNovel('volume1').title, 'Only Root');
  rootOnly.close();

  const parsed = parseMigrationArgs(['--source', sourceDir, '--output', outputPath, '--force']);
  assert.equal(parsed.sourceDir, sourceDir);
  assert.equal(parsed.outputPath, outputPath);
  assert.equal(parsed.force, true);

  const emptySource = path.join(sourceDir, 'empty');
  await mkdir(emptySource, { recursive: true });
  await assert.rejects(
    migrateMarkdownProject({ sourceDir: emptySource, outputPath: path.join(emptySource, 'empty.novel') }),
    (error) => error.code === 'MIGRATION_SOURCE_EMPTY'
  );

  const duplicateSource = path.join(sourceDir, 'duplicates');
  await mkdir(path.join(duplicateSource, 'volumes'), { recursive: true });
  await writeFile(path.join(duplicateSource, 'volumes', 'volume1.md'), novelMarkdown('One', 'One.'));
  await writeFile(path.join(duplicateSource, 'volumes', 'volume01.md'), novelMarkdown('Leading Zero', 'Duplicate.'));
  await assert.rejects(
    migrateMarkdownProject({ sourceDir: duplicateSource, outputPath: path.join(duplicateSource, 'duplicate.novel') }),
    (error) => error.code === 'MIGRATION_DUPLICATE_VOLUME'
  );
});

async function startTemporaryApp(t, options = {}) {
  const ownsDirectory = !options.directory;
  const directory = options.directory ?? await mkdtemp(path.join(os.tmpdir(), 'novel-app-test-'));
  await mkdir(directory, { recursive: true });
  const app = createApp({
    datasourceDir: directory,
    projectPath: path.join(directory, 'project.novel'),
    storageMode: options.storageMode,
    serveStatic: false,
    logger: silentLogger
  });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  t.after(async () => {
    listener.closeAllConnections?.();
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    await app.locals.close();
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    directory,
    fetch(route, init) {
      return fetch(`http://127.0.0.1:${address.port}${route}`, init);
    }
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function novelMarkdown(title, body) {
  return [`## ${title}`, '<!-- preserved -->', '', '### Chapter 1: Opening', '', '#### Scene 1', '', body, ''].join('\n');
}
