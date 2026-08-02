import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileCodex, createCodexEntry, deleteCodexEntry, listCodexEntries, readCodexEntry, writeCodexEntry } from './codex.js';
import { countWords, flattenCodexEntries, parseNovel, serializeNovel } from './markdown.js';
import { MAX_PROJECT_BYTES, PROJECT_MIME, ProjectFileError, ProjectServer } from './projectServer.js';
import { containsTerm } from '../src/storage/mentionIndexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultDatasourceDir = path.join(rootDir, 'datasource');
const defaultDistDir = path.join(rootDir, 'dist');
const storageModes = new Set(['project', 'markdown']);

export class ApiError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createApp(options = {}) {
  const datasourceDir = path.resolve(options.datasourceDir ?? defaultDatasourceDir);
  const storageMode = options.storageMode ?? process.env.NOVEL_STORAGE_MODE ?? 'project';
  if (!storageModes.has(storageMode)) throw new Error('NOVEL_STORAGE_MODE must be "project" or "markdown".');

  const paths = createDatasourcePaths(datasourceDir);
  const distDir = path.resolve(options.distDir ?? defaultDistDir);
  const logger = options.logger ?? console;
  const projectServer = storageMode === 'project'
    ? new ProjectServer({
        projectPath: options.projectPath ?? path.join(datasourceDir, 'project.novel'),
        busyTimeoutMs: options.busyTimeoutMs,
        maxImportBytes: options.maxImportBytes
      })
    : null;
  const app = express();
  app.disable('x-powered-by');
  app.locals.storageMode = storageMode;
  app.locals.projectServer = projectServer;
  app.locals.getProjectDb = () => requireProjectServer(projectServer).getProjectDb();
  app.locals.close = async () => projectServer?.close();

  app.post(
    '/api/project/import',
    express.raw({ type: [PROJECT_MIME, 'application/octet-stream'], limit: options.maxImportBytes ?? MAX_PROJECT_BYTES }),
    async (request, response) => {
      const server = requireProjectServer(projectServer);
      if (!request.is(PROJECT_MIME) && !request.is('application/octet-stream')) {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Use ${PROJECT_MIME} or application/octet-stream.`);
      }
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, 'EMPTY_PROJECT_FILE', 'A project file is required.');
      const project = await server.importSnapshot(request.body, { replace: request.query.replace === 'true' });
      response.json({ project });
    }
  );

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/project', async (_request, response) => {
    const project = await requireProjectServer(projectServer).getProjectDb().getProjectMeta();
    response.json({ project });
  });

  app.put('/api/project', async (request, response) => {
    const patch = request.body?.project ?? request.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ApiError(400, 'INVALID_PROJECT_PAYLOAD', 'Invalid project payload.');
    }
    const project = await requireProjectServer(projectServer).getProjectDb().updateProjectMeta(patch);
    response.json({ project });
  });

  app.get('/api/project/export', async (_request, response) => {
    const bytes = await requireProjectServer(projectServer).exportSnapshot();
    response.set({
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="project.novel"',
      'Content-Type': PROJECT_MIME
    });
    response.send(bytes);
  });

  app.post('/api/mentions/rebuild', async (request, response) => {
    const volumeId = request.body?.volumeId == null ? undefined : validateVolumeId(request.body.volumeId);
    const count = await requireProjectServer(projectServer).getProjectDb().rebuildMentionIndex(volumeId);
    response.json({ count, volumeId: volumeId ?? null });
  });

  app.get('/api/search', async (request, response) => {
    const query = String(request.query.q ?? '').trim();
    if (query.length > 500) throw new ApiError(400, 'INVALID_SEARCH_QUERY', 'Search queries are limited to 500 characters.');
    const db = requireProjectServer(projectServer).getProjectDb();
    response.json({ query, scenes: await db.searchScenes(query), codex: await db.searchCodex(query) });
  });

  app.get('/api/volumes', async (_request, response) => {
    response.json({ volumes: await listVolumes({ storageMode, projectServer, paths }) });
  });

  app.post('/api/volumes', async (request, response) => {
    const result = await createVolume({ storageMode, projectServer, paths }, request.body?.title);
    response.status(201).json(result);
  });

  app.get('/api/volumes/:volumeId/markdown', async (request, response) => {
    const db = requireProjectServer(projectServer).getProjectDb();
    const volumeId = validateVolumeId(request.params.volumeId);
    requireProjectVolume(db, volumeId);
    response.type('text/markdown').send(await db.exportToMarkdown(volumeId));
  });

  app.put(
    '/api/volumes/:volumeId/markdown',
    express.text({ type: 'text/markdown', limit: '25mb' }),
    async (request, response) => {
      if (!request.is('text/markdown') || typeof request.body !== 'string') {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use text/markdown for Markdown volume imports.');
      }
      const db = requireProjectServer(projectServer).getProjectDb();
      const volumeId = validateVolumeId(request.params.volumeId);
      requireProjectVolume(db, volumeId);
      await db.importFromMarkdown(volumeId, request.body);
      response.type('text/markdown').send(await db.exportToMarkdown(volumeId));
    }
  );

  app.get('/api/volumes/:volumeId', async (request, response) => {
    const volumeId = validateVolumeId(request.params.volumeId);
    response.json(await getVolume({ storageMode, projectServer, paths }, volumeId));
  });

  app.put('/api/volumes/:volumeId', async (request, response) => {
    const volumeId = validateVolumeId(request.params.volumeId);
    response.json(await saveVolume({ storageMode, projectServer, paths }, volumeId, request.body?.novel));
  });

  app.get('/api/acts', async (_request, response) => {
    const volumes = await listVolumes({ storageMode, projectServer, paths });
    response.json({ acts: volumes, volumes });
  });

  app.post('/api/acts', async (request, response) => {
    const result = await createVolume({ storageMode, projectServer, paths }, request.body?.title);
    response.status(201).json({ ...result, act: result.volume, acts: result.volumes });
  });

  app.get('/api/acts/:actId', async (request, response) => {
    const volumeId = validateVolumeId(convertActIdToVolumeId(request.params.actId));
    const result = await getVolume({ storageMode, projectServer, paths }, volumeId);
    response.json({ ...result, act: result.volume });
  });

  app.put('/api/acts/:actId', async (request, response) => {
    const volumeId = validateVolumeId(convertActIdToVolumeId(request.params.actId));
    const result = await saveVolume({ storageMode, projectServer, paths }, volumeId, request.body?.novel);
    response.json({ ...result, act: result.volume });
  });

  app.get('/api/novel', async (_request, response) => {
    const result = await getVolume({ storageMode, projectServer, paths }, 'volume1');
    response.json({ ...result, act: result.volume });
  });

  app.put('/api/novel', async (request, response) => {
    const result = await saveVolume({ storageMode, projectServer, paths }, 'volume1', request.body?.novel);
    response.json({ ...result, act: result.volume });
  });

  app.get('/api/codex', async (_request, response) => {
    response.json({ codex: await listCodex({ storageMode, projectServer, paths }) });
  });

  app.post('/api/codex/compile', async (_request, response) => {
    response.json(await compileCurrentCodex({ storageMode, projectServer, paths }));
  });

  app.get('/api/codex/:category/:id', async (request, response) => {
    if (storageMode === 'project') {
      const entry = requireProjectServer(projectServer).getProjectDb().getCodexEntry(request.params.category, request.params.id);
      if (!entry) throw new ApiError(404, 'CODEX_NOT_FOUND', 'Codex entry not found.');
      response.json({ entry });
      return;
    }

    try {
      response.json({ entry: await readCodexEntry(paths.codexDir, request.params.category, request.params.id) });
    } catch (error) {
      if (error.code === 'ENOENT') throw new ApiError(404, 'CODEX_NOT_FOUND', 'Codex entry not found.', { cause: error });
      throw error;
    }
  });

  app.post('/api/codex/:category', async (request, response) => {
    if (storageMode === 'project') {
      const db = requireProjectServer(projectServer).getProjectDb();
      const entry = await db.createCodexEntry({ category: request.params.category, name: request.body?.name });
      response.status(201).json({ entry, codex: db.listCodex() });
      return;
    }

    const entry = await createCodexEntry(paths.codexDir, request.params.category, request.body?.name);
    response.status(201).json({ entry, codex: await listCodexEntries(paths.codexDir) });
  });

  app.put('/api/codex/:category/:id', async (request, response) => {
    const entry = request.body?.entry;
    if (!entry || typeof entry !== 'object') throw new ApiError(400, 'INVALID_CODEX_PAYLOAD', 'Invalid codex entry payload.');

    if (storageMode === 'project') {
      const db = requireProjectServer(projectServer).getProjectDb();
      if (!db.getCodexEntry(request.params.category, request.params.id)) {
        throw new ApiError(404, 'CODEX_NOT_FOUND', 'Codex entry not found.');
      }
      const savedEntry = await db.updateCodexEntry(request.params.category, request.params.id, entry);
      response.json({ entry: savedEntry, codex: db.listCodex() });
      return;
    }

    const savedEntry = await writeCodexEntry(paths.codexDir, { ...entry, category: request.params.category, id: request.params.id });
    response.json({ entry: savedEntry, codex: await listCodexEntries(paths.codexDir) });
  });

  app.delete('/api/codex/:category/:id', async (request, response) => {
    if (storageMode === 'project') {
      const db = requireProjectServer(projectServer).getProjectDb();
      const entry = db.getCodexEntry(request.params.category, request.params.id);
      if (entry) await db.deleteCodexEntry(request.params.category, request.params.id);
      response.json({ codex: db.listCodex() });
      return;
    }

    await deleteCodexEntry(paths.codexDir, request.params.category, request.params.id);
    response.json({ codex: await listCodexEntries(paths.codexDir) });
  });

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API route not found.', code: 'API_NOT_FOUND' });
  });

  app.use('/api', (error, _request, response, _next) => {
    const readable = toApiError(error);
    logger.error?.(`[server] ${error?.stack ?? String(error)}`);
    response.status(readable.status).json({ error: readable.message, code: readable.code });
  });

  if (options.serveStatic !== false && existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((_request, response) => response.sendFile(path.join(distDir, 'index.html')));
  }

  return app;
}

export function startServer(options = {}) {
  const app = createApp(options);
  const port = Number(options.port ?? process.env.PORT ?? 3001);
  const host = options.host ?? '127.0.0.1';
  const listener = app.listen(port, host, () => {
    console.log(`Novel editor server running at http://${host}:${listener.address().port}`);
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await app.locals.close();
  };
  const terminate = () => close().catch((error) => console.error(error)).finally(() => process.exit());
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  return { app, listener, close };
}

async function listVolumes(context) {
  if (context.storageMode === 'project') {
    return context.projectServer.getProjectDb().listVolumes().map(publicProjectVolume);
  }
  return listMarkdownVolumes(context.paths);
}

async function createVolume(context, rawTitle) {
  const title = String(rawTitle ?? '').trim() || 'Untitled Novel';
  const volumes = await listVolumes(context);
  const nextNumber = Math.max(0, ...volumes.map((volume) => volume.number)) + 1;

  if (context.storageMode === 'project') {
    const db = context.projectServer.getProjectDb();
    const volume = db.createVolume({ number: nextNumber, title });
    try {
      db.putNovel(volume.id, starterNovel(volume.label, title));
    } catch (error) {
      db.deleteVolume(volume.id);
      throw error;
    }
    return { volume: publicProjectVolume(volume), volumes: db.listVolumes().map(publicProjectVolume), novel: db.getNovel(volume.id) };
  }

  const volume = markdownVolumeMeta(context.paths, nextNumber);
  const markdown = createVolumeMarkdown({ volumeLabel: volume.label, title });
  await mkdir(context.paths.volumesDir, { recursive: true });
  await writeFile(volume.path, markdown, { encoding: 'utf8', flag: 'wx' });
  return { volume: publicMarkdownVolume(volume), volumes: await listMarkdownVolumes(context.paths), novel: withStats(parseNovel(markdown)) };
}

async function getVolume(context, volumeId) {
  if (context.storageMode === 'project') {
    const db = context.projectServer.getProjectDb();
    const volume = requireProjectVolume(db, volumeId);
    return { volume: publicProjectVolume(volume), novel: db.getNovel(volumeId) };
  }

  const volume = markdownVolumeMeta(context.paths, Number(volumeId.slice('volume'.length)));
  try {
    const markdown = await readVolumeMarkdown(context.paths, volume);
    return { volume: publicMarkdownVolume(volume), novel: withStats(parseNovel(markdown)) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new ApiError(404, 'VOLUME_NOT_FOUND', 'Volume not found.', { cause: error });
    throw error;
  }
}

async function saveVolume(context, volumeId, novel) {
  if (!novel || !Array.isArray(novel.chapters)) throw new ApiError(400, 'INVALID_NOVEL_PAYLOAD', 'Invalid novel payload.');

  if (context.storageMode === 'project') {
    const db = context.projectServer.getProjectDb();
    const volume = requireProjectVolume(db, volumeId);
    await db.putNovel(volumeId, novel);
    return { volume: publicProjectVolume(volume), novel: db.getNovel(volumeId) };
  }

  const volume = markdownVolumeMeta(context.paths, Number(volumeId.slice('volume'.length)));
  const codex = await listCodexEntries(context.paths.codexDir);
  const markdown = serializeNovel(novel, { codexEntries: flattenCodexEntries(codex) });
  await mkdir(context.paths.volumesDir, { recursive: true });
  await writeFile(volume.path, markdown, 'utf8');
  return { volume: publicMarkdownVolume(volume), novel: withStats(parseNovel(markdown)) };
}

async function listCodex(context) {
  return context.storageMode === 'project'
    ? context.projectServer.getProjectDb().listCodex()
    : listCodexEntries(context.paths.codexDir);
}

async function compileCurrentCodex(context) {
  if (context.storageMode === 'markdown') {
    const result = await compileCodex(context.paths.codexDir, context.paths.datasourceDir);
    await writeFile(path.join(context.paths.datasourceDir, 'codex.md'), result.markdown, 'utf8');
    return { count: result.count, path: 'datasource/codex.md' };
  }

  const db = context.projectServer.getProjectDb();
  const codex = db.listCodex();
  const entries = Object.values(codex).flat();
  const chapters = db.listVolumes().flatMap((volume) => db.getNovel(volume.id).chapters);
  const sections = ['# Codex', '', 'Generated from the active project file.', ''];
  for (const category of ['characters', 'locations', 'lore']) {
    sections.push(`## ${titleCase(category)}`, '');
    for (const entry of codex[category]) {
      sections.push(
        `### ${entry.name}`,
        '',
        `**Type:** ${entry.type}`,
        `**Source:** \`${entry.path}\``,
        `**Aliases:** ${formatList(entry.aliases)}`,
        `**Tags:** ${formatList(entry.tags)}`,
        `**Context:** alwaysIncludeInContext=${entry.alwaysIncludeInContext}, doNotTrack=${entry.doNotTrack}, noAutoInclude=${entry.noAutoInclude}`,
        ''
      );

      const mentionedEntries = entries
        .filter((candidate) => candidate.internalId !== entry.internalId)
        .filter((candidate) => [candidate.name, ...(candidate.aliases ?? [])].some((term) => containsTerm(entry.body, term)))
        .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
      if (mentionedEntries.length) {
        sections.push('#### Codex Mentioned', '');
        for (const type of ['character', 'location', 'lore']) {
          const grouped = mentionedEntries.filter((candidate) => candidate.type === type);
          if (grouped.length) sections.push(`- **${titleCase(type)}:** ${grouped.map((candidate) => candidate.name).join(', ')}`);
        }
        sections.push('');
      }

      const terms = [entry.name, ...(entry.aliases ?? [])].filter(Boolean);
      const mentionedChapters = chapters.filter((chapter) => {
        const text = chapter.scenes.flatMap((scene) => scene.paragraphs).join('\n\n');
        return terms.some((term) => containsTerm(text, term));
      });
      if (mentionedChapters.length) {
        sections.push('#### Chapters Mentioned', '');
        for (const chapter of mentionedChapters) {
          sections.push(`- **Chapter ${chapter.chapterNumber}:** ${chapter.title}`);
        }
        sections.push('');
      }

      sections.push(entry.body.trim() || '_No body content._', '');
    }
  }
  const markdown = `${sections.join('\n').trim()}\n`;
  await mkdir(context.paths.datasourceDir, { recursive: true });
  await writeFile(path.join(context.paths.datasourceDir, 'codex.md'), markdown, 'utf8');
  return {
    count: entries.length,
    path: 'datasource/codex.md',
    markdown,
    written: true
  };
}

function createDatasourcePaths(datasourceDir) {
  return {
    datasourceDir,
    novelPath: path.join(datasourceDir, 'novel.md'),
    actsDir: path.join(datasourceDir, 'acts'),
    volumesDir: path.join(datasourceDir, 'volumes'),
    codexDir: path.join(datasourceDir, 'codex')
  };
}

async function listMarkdownVolumes(paths) {
  const volumeFiles = existsSync(paths.volumesDir) ? await readdir(paths.volumesDir, { withFileTypes: true }) : [];
  const legacyActFiles = existsSync(paths.actsDir) ? await readdir(paths.actsDir, { withFileTypes: true }) : [];
  const seen = new Set();
  const volumes = volumeFiles
    .filter((item) => item.isFile())
    .map((item) => item.name.match(/^volume(\d+)\.md$/))
    .filter(Boolean)
    .map((match) => {
      const number = Number(match[1]);
      seen.add(number);
      return markdownVolumeMeta(paths, number);
    });
  const legacyVolumes = legacyActFiles
    .filter((item) => item.isFile())
    .map((item) => item.name.match(/^act(\d+)\.md$/))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => !seen.has(number))
    .map((number) => legacyActMeta(paths, number));

  if (!volumes.length && !legacyVolumes.length && existsSync(paths.novelPath)) {
    return [publicMarkdownVolume(markdownVolumeMeta(paths, 1))];
  }
  return [...volumes, ...legacyVolumes].sort((left, right) => left.number - right.number).map(publicMarkdownVolume);
}

async function readVolumeMarkdown(paths, volume) {
  if (existsSync(volume.path)) return readFile(volume.path, 'utf8');
  const legacyPath = path.join(paths.actsDir, `act${volume.number}.md`);
  if (existsSync(legacyPath)) return readFile(legacyPath, 'utf8');
  if (volume.id === 'volume1' && existsSync(paths.novelPath)) return readFile(paths.novelPath, 'utf8');
  return readFile(volume.path, 'utf8');
}

function markdownVolumeMeta(paths, number) {
  return {
    id: `volume${number}`,
    number,
    label: `Volume ${number}`,
    filename: `volume${number}.md`,
    path: path.join(paths.volumesDir, `volume${number}.md`)
  };
}

function legacyActMeta(paths, number) {
  return { ...markdownVolumeMeta(paths, number), filename: `act${number}.md`, path: path.join(paths.actsDir, `act${number}.md`), legacy: true };
}

function publicMarkdownVolume(volume) {
  return {
    id: volume.id,
    number: volume.number,
    label: volume.label,
    filename: volume.filename,
    path: volume.legacy ? `datasource/acts/${volume.filename}` : `datasource/volumes/${volume.filename}`
  };
}

function publicProjectVolume(volume) {
  return {
    id: volume.id,
    number: volume.number,
    label: volume.label,
    filename: volume.filename,
    path: `datasource/${volume.path}`
  };
}

function validateVolumeId(volumeId) {
  const match = String(volumeId ?? '').match(/^volume(\d+)$/);
  if (!match || Number(match[1]) < 1) throw new ApiError(400, 'INVALID_VOLUME_ID', 'Invalid volume id.');
  return `volume${Number(match[1])}`;
}

function requireProjectVolume(db, volumeId) {
  const volume = db.getVolume(volumeId);
  if (!volume) throw new ApiError(404, 'VOLUME_NOT_FOUND', 'Volume not found.');
  return volume;
}

function requireProjectServer(projectServer) {
  if (!projectServer) throw new ApiError(409, 'PROJECT_MODE_DISABLED', 'Project storage mode is not enabled.');
  return projectServer;
}

function convertActIdToVolumeId(id) {
  const match = String(id ?? '').match(/^act(\d+)$/);
  return match ? `volume${match[1]}` : id;
}

function starterNovel(volumeLabel, title) {
  return {
    header: [`## ${title}`, ''],
    title,
    chapters: [{ chapterNumber: 1, title: `${volumeLabel} Opening`, scenes: [{ heading: 'Scene 1', paragraphs: ['Start writing here...'] }] }]
  };
}

function createVolumeMarkdown({ volumeLabel, title }) {
  return [`## ${title}`, '', `### Chapter 1: ${volumeLabel} Opening`, '', '#### Scene 1', '', 'Start writing here...', ''].join('\n');
}

function withStats(novel) {
  const chapters = novel.chapters.map((chapter) => {
    const wordCount = chapter.scenes.reduce((chapterTotal, scene) => {
      return chapterTotal + scene.paragraphs.reduce((sceneTotal, paragraph) => sceneTotal + countWords(paragraph), 0);
    }, 0);
    return { ...chapter, wordCount };
  });
  return { ...novel, chapters, wordCount: chapters.reduce((total, chapter) => total + chapter.wordCount, 0) };
}

function toApiError(error) {
  if (error instanceof ApiError || error instanceof ProjectFileError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error?.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request payload is too large.' };
  }
  if (error instanceof SyntaxError && error.status === 400) {
    return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' };
  }
  if (error?.code === 'ENOENT') {
    return { status: 404, code: 'LOCAL_DATA_NOT_FOUND', message: 'Required local data was not found.' };
  }
  if (error?.code?.startsWith?.('SQLITE_CONSTRAINT')) {
    return { status: 409, code: 'PROJECT_CONFLICT', message: 'The requested project record conflicts with existing data.' };
  }
  if (/Invalid codex (category|entry id)|positive integer|must contain every|IDs must be unique/i.test(error?.message ?? '')) {
    return { status: 400, code: 'INVALID_REQUEST', message: 'The request contains an invalid identifier or ordering.' };
  }
  if (/was not found|Codex entry was not found/i.test(error?.message ?? '')) {
    return { status: 404, code: 'RECORD_NOT_FOUND', message: 'The requested project record was not found.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'The local editor server hit an unexpected error.' };
}

function formatList(values) {
  return values?.length ? values.join(', ') : 'None';
}

function titleCase(value) {
  return String(value).replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) startServer();
