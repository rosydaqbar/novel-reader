import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCodex, createCodexEntry, deleteCodexEntry, listCodexEntries, readCodexEntry, writeCodexEntry } from './codex.js';
import { countWords, flattenCodexEntries, parseNovel, serializeNovel } from './markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const datasourceDir = path.join(rootDir, 'datasource');
const novelPath = path.join(datasourceDir, 'novel.md');
const actsDir = path.join(datasourceDir, 'acts');
const volumesDir = path.join(datasourceDir, 'volumes');
const codexDir = path.join(datasourceDir, 'codex');
const distDir = path.join(rootDir, 'dist');
const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: '25mb' }));

app.get('/api/volumes', async (_request, response) => {
  response.json({ volumes: await listVolumes() });
});

app.post('/api/volumes', async (request, response) => {
  const volumes = await listVolumes();
  const nextNumber = Math.max(0, ...volumes.map((volume) => volume.number)) + 1;
  const volume = volumeMeta(nextNumber);
  const title = String(request.body?.title ?? '').trim() || 'Untitled Novel';
  const markdown = createVolumeMarkdown({ volumeLabel: volume.label, title });

  await mkdir(volumesDir, { recursive: true });
  await writeFile(volume.path, markdown, { encoding: 'utf8', flag: 'wx' });

  response.status(201).json({ volume: publicVolume(volume), volumes: await listVolumes(), novel: withStats(parseNovel(markdown)) });
});

app.get('/api/volumes/:volumeId', async (request, response) => {
  const volume = getVolumeFromId(request.params.volumeId);
  if (!volume) {
    response.status(400).json({ error: 'Invalid volume id.' });
    return;
  }

  try {
    const markdown = await readVolumeMarkdown(volume);
    response.json({ volume: publicVolume(volume), novel: withStats(parseNovel(markdown)) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Volume not found.' });
      return;
    }
    throw error;
  }
});

app.put('/api/volumes/:volumeId', async (request, response) => {
  const volume = getVolumeFromId(request.params.volumeId);
  if (!volume) {
    response.status(400).json({ error: 'Invalid volume id.' });
    return;
  }

  const novel = request.body?.novel;
  if (!novel || !Array.isArray(novel.chapters)) {
    response.status(400).json({ error: 'Invalid novel payload.' });
    return;
  }

  response.json(await saveVolumeNovel(volume, novel));
});

app.get('/api/acts', async (_request, response) => {
  const volumes = await listVolumes();
  response.json({ acts: volumes, volumes });
});

app.post('/api/acts', async (request, response) => {
  const volumes = await listVolumes();
  const nextNumber = Math.max(0, ...volumes.map((volume) => volume.number)) + 1;
  const volume = volumeMeta(nextNumber);
  const title = String(request.body?.title ?? '').trim() || 'Untitled Novel';
  const markdown = createVolumeMarkdown({ volumeLabel: volume.label, title });

  await mkdir(volumesDir, { recursive: true });
  await writeFile(volume.path, markdown, { encoding: 'utf8', flag: 'wx' });

  const nextVolumes = await listVolumes();
  response.status(201).json({ act: publicVolume(volume), volume: publicVolume(volume), acts: nextVolumes, volumes: nextVolumes, novel: withStats(parseNovel(markdown)) });
});

app.get('/api/acts/:actId', async (request, response) => {
  request.params.volumeId = convertActIdToVolumeId(request.params.actId);
  const volume = getVolumeFromId(request.params.volumeId);
  if (!volume) {
    response.status(400).json({ error: 'Invalid volume id.' });
    return;
  }

  try {
    const markdown = await readVolumeMarkdown(volume);
    response.json({ act: publicVolume(volume), volume: publicVolume(volume), novel: withStats(parseNovel(markdown)) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Volume not found.' });
      return;
    }
    throw error;
  }
});

app.put('/api/acts/:actId', async (request, response) => {
  const volume = getVolumeFromId(convertActIdToVolumeId(request.params.actId));
  if (!volume) {
    response.status(400).json({ error: 'Invalid volume id.' });
    return;
  }

  const novel = request.body?.novel;
  if (!novel || !Array.isArray(novel.chapters)) {
    response.status(400).json({ error: 'Invalid novel payload.' });
    return;
  }

  const result = await saveVolumeNovel(volume, novel);
  response.json({ ...result, act: result.volume });
});

app.get('/api/novel', async (_request, response) => {
  const volume = getVolumeFromId('volume1');
  const markdown = await readVolumeMarkdown(volume);
  response.json({ volume: publicVolume(volume), act: publicVolume(volume), novel: withStats(parseNovel(markdown)) });
});

app.put('/api/novel', async (request, response) => {
  const novel = request.body?.novel;
  if (!novel || !Array.isArray(novel.chapters)) {
    response.status(400).json({ error: 'Invalid novel payload.' });
    return;
  }

  const result = await saveVolumeNovel(getVolumeFromId('volume1'), novel);
  response.json({ ...result, act: result.volume });
});

app.get('/api/codex', async (_request, response) => {
  response.json({ codex: await listCodexEntries(codexDir) });
});

app.post('/api/codex/compile', async (_request, response) => {
  response.json(await writeCompiledCodex());
});

app.get('/api/codex/:category/:id', async (request, response) => {
  try {
    response.json({ entry: await readCodexEntry(codexDir, request.params.category, request.params.id) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Codex entry not found.' });
      return;
    }
    throw error;
  }
});

app.post('/api/codex/:category', async (request, response) => {
  if (request.params.category === 'compile') {
    response.json(await writeCompiledCodex());
    return;
  }

  try {
    const entry = await createCodexEntry(codexDir, request.params.category, request.body?.name);
    response.status(201).json({ entry, codex: await listCodexEntries(codexDir) });
  } catch (error) {
    if (error.message === 'Invalid codex category.') {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

app.put('/api/codex/:category/:id', async (request, response) => {
  const entry = request.body?.entry;
  if (!entry) {
    response.status(400).json({ error: 'Invalid codex entry payload.' });
    return;
  }

  const savedEntry = await writeCodexEntry(codexDir, {
    ...entry,
    category: request.params.category,
    id: request.params.id
  });
  response.json({ entry: savedEntry, codex: await listCodexEntries(codexDir) });
});

app.delete('/api/codex/:category/:id', async (request, response) => {
  await deleteCodexEntry(codexDir, request.params.category, request.params.id);
  response.json({ codex: await listCodexEntries(codexDir) });
});

app.use('/api', (error, _request, response, _next) => {
  const readable = toReadableError(error);
  console.error(`[server] ${readable.log}`);
  response.status(readable.status).json({ error: readable.message, detail: readable.detail });
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(port, '127.0.0.1', () => {
  console.log(`Novel editor server running at http://127.0.0.1:${port}`);
});

function withStats(novel) {
  const chapters = novel.chapters.map((chapter) => {
    const wordCount = chapter.scenes.reduce((chapterTotal, scene) => {
      return chapterTotal + scene.paragraphs.reduce((sceneTotal, paragraph) => sceneTotal + countWords(paragraph), 0);
    }, 0);

    return { ...chapter, wordCount };
  });

  return {
    ...novel,
    chapters,
    wordCount: chapters.reduce((total, chapter) => total + chapter.wordCount, 0)
  };
}

function toReadableError(error) {
  if (error?.code === 'ENOENT') {
    return {
      status: 404,
      message: 'Required local data folder or file was not found.',
      detail: 'Create a new novel or codex entry from the app to generate the missing datasource files.',
      log: `Missing local data path: ${error.path ?? 'unknown path'}`
    };
  }

  return {
    status: 500,
    message: 'The local editor server hit an unexpected error.',
    detail: error?.message ?? 'Unknown error',
    log: error?.stack ?? String(error)
  };
}

async function listVolumes() {
  const volumeFiles = existsSync(volumesDir) ? await readdir(volumesDir, { withFileTypes: true }) : [];
  const legacyActFiles = existsSync(actsDir) ? await readdir(actsDir, { withFileTypes: true }) : [];
  const seen = new Set();
  const volumes = volumeFiles
    .filter((item) => item.isFile())
    .map((item) => item.name.match(/^volume(\d+)\.md$/))
    .filter(Boolean)
    .map((match) => {
      const number = Number(match[1]);
      seen.add(number);
      return volumeMeta(number);
    });

  const legacyVolumes = legacyActFiles
    .filter((item) => item.isFile())
    .map((item) => item.name.match(/^act(\d+)\.md$/))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => !seen.has(number))
    .map(legacyActMeta);

  if (!volumes.length && !legacyVolumes.length && existsSync(novelPath)) {
    return [publicVolume(volumeMeta(1))];
  }

  return [...volumes, ...legacyVolumes].sort((a, b) => a.number - b.number).map(publicVolume);
}

async function readVolumeMarkdown(volume) {
  if (existsSync(volume.path)) return readFile(volume.path, 'utf8');
  const legacyPath = path.join(actsDir, `act${volume.number}.md`);
  if (existsSync(legacyPath)) return readFile(legacyPath, 'utf8');
  if (volume.id === 'volume1' && existsSync(novelPath)) return readFile(novelPath, 'utf8');
  return readFile(volume.path, 'utf8');
}

async function saveVolumeNovel(volume, novel) {
  const codex = await listCodexEntries(codexDir);
  const markdown = serializeNovel(novel, { codexEntries: flattenCodexEntries(codex) });
  await mkdir(volumesDir, { recursive: true });
  await writeFile(volume.path, markdown, 'utf8');
  return { volume: publicVolume(volume), novel: withStats(parseNovel(markdown)) };
}

function getVolumeFromId(volumeId) {
  const match = String(volumeId ?? '').match(/^volume(\d+)$/);
  if (!match) return null;
  return volumeMeta(Number(match[1]));
}

function volumeMeta(number) {
  return {
    id: `volume${number}`,
    number,
    label: `Volume ${number}`,
    filename: `volume${number}.md`,
    path: path.join(volumesDir, `volume${number}.md`)
  };
}

function legacyActMeta(number) {
  return {
    ...volumeMeta(number),
    filename: `act${number}.md`,
    path: path.join(actsDir, `act${number}.md`),
    legacy: true
  };
}

function publicVolume(volume) {
  return {
    id: volume.id,
    number: volume.number,
    label: volume.label,
    filename: volume.filename,
    path: volume.legacy ? `datasource/acts/${volume.filename}` : `datasource/volumes/${volume.filename}`
  };
}

function convertActIdToVolumeId(id) {
  const match = String(id ?? '').match(/^act(\d+)$/);
  return match ? `volume${match[1]}` : id;
}

function createVolumeMarkdown({ volumeLabel, title }) {
  return [`## ${title}`, '', `### Chapter 1: ${volumeLabel} Opening`, '', '#### Scene 1', '', 'Start writing here...', ''].join('\n');
}

async function writeCompiledCodex() {
  const result = await compileCodex(codexDir);
  await writeFile(path.join(datasourceDir, 'codex.md'), result.markdown, 'utf8');
  return { count: result.count, path: 'datasource/codex.md' };
}
