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
const codexDir = path.join(datasourceDir, 'codex');
const distDir = path.join(rootDir, 'dist');
const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json({ limit: '25mb' }));

app.get('/api/acts', async (_request, response) => {
  response.json({ acts: await listActs() });
});

app.post('/api/acts', async (request, response) => {
  const acts = await listActs();
  const nextNumber = Math.max(0, ...acts.map((act) => act.number)) + 1;
  const act = actMeta(nextNumber);
  const title = String(request.body?.title ?? '').trim() || 'Untitled Novel';
  const markdown = createActMarkdown({ actLabel: act.label, title });

  await mkdir(actsDir, { recursive: true });
  await writeFile(act.path, markdown, { encoding: 'utf8', flag: 'wx' });

  response.status(201).json({ act: publicAct(act), acts: await listActs(), novel: withStats(parseNovel(markdown)) });
});

app.get('/api/acts/:actId', async (request, response) => {
  const act = getActFromId(request.params.actId);
  if (!act) {
    response.status(400).json({ error: 'Invalid act id.' });
    return;
  }

  try {
    const markdown = await readActMarkdown(act);
    response.json({ act: publicAct(act), novel: withStats(parseNovel(markdown)) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.status(404).json({ error: 'Act not found.' });
      return;
    }
    throw error;
  }
});

app.put('/api/acts/:actId', async (request, response) => {
  const act = getActFromId(request.params.actId);
  if (!act) {
    response.status(400).json({ error: 'Invalid act id.' });
    return;
  }

  const novel = request.body?.novel;
  if (!novel || !Array.isArray(novel.chapters)) {
    response.status(400).json({ error: 'Invalid novel payload.' });
    return;
  }

  response.json(await saveActNovel(act, novel));
});

app.get('/api/novel', async (_request, response) => {
  const act = getActFromId('act1');
  const markdown = await readActMarkdown(act);
  response.json({ act: publicAct(act), novel: withStats(parseNovel(markdown)) });
});

app.put('/api/novel', async (request, response) => {
  const novel = request.body?.novel;
  if (!novel || !Array.isArray(novel.chapters)) {
    response.status(400).json({ error: 'Invalid novel payload.' });
    return;
  }

  response.json(await saveActNovel(getActFromId('act1'), novel));
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

async function listActs() {
  const actFiles = existsSync(actsDir) ? await readdir(actsDir, { withFileTypes: true }) : [];
  const acts = actFiles
    .filter((item) => item.isFile())
    .map((item) => item.name.match(/^act(\d+)\.md$/))
    .filter(Boolean)
    .map((match) => actMeta(Number(match[1])))
    .sort((a, b) => a.number - b.number);

  if (!acts.length && existsSync(novelPath)) {
    return [publicAct(actMeta(1))];
  }

  return acts.map(publicAct);
}

async function readActMarkdown(act) {
  if (existsSync(act.path)) return readFile(act.path, 'utf8');
  if (act.id === 'act1' && existsSync(novelPath)) return readFile(novelPath, 'utf8');
  return readFile(act.path, 'utf8');
}

async function saveActNovel(act, novel) {
  const codex = await listCodexEntries(codexDir);
  const markdown = serializeNovel(novel, { codexEntries: flattenCodexEntries(codex) });
  await mkdir(actsDir, { recursive: true });
  await writeFile(act.path, markdown, 'utf8');
  return { act: publicAct(act), novel: withStats(parseNovel(markdown)) };
}

function getActFromId(actId) {
  const match = String(actId ?? '').match(/^act(\d+)$/);
  if (!match) return null;
  return actMeta(Number(match[1]));
}

function actMeta(number) {
  return {
    id: `act${number}`,
    number,
    label: `Act ${number}`,
    filename: `act${number}.md`,
    path: path.join(actsDir, `act${number}.md`)
  };
}

function publicAct(act) {
  return {
    id: act.id,
    number: act.number,
    label: act.label,
    filename: act.filename,
    path: `datasource/acts/${act.filename}`
  };
}

function createActMarkdown({ actLabel, title }) {
  return [`## ${title}`, '', `### Chapter 1: ${actLabel} Opening`, '', '#### Scene 1', '', 'Start writing here...', ''].join('\n');
}

async function writeCompiledCodex() {
  const result = await compileCodex(codexDir);
  await writeFile(path.join(datasourceDir, 'codex.md'), result.markdown, 'utf8');
  return { count: result.count, path: 'datasource/codex.md' };
}
