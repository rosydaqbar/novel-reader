const codexCategories = ['characters', 'locations', 'lore'];
const datasourceDbName = 'novel-reader-editor';
const datasourceStoreName = 'handles';
const datasourceHandleKey = 'recentDatasource';
const typeByCategory = {
  characters: 'character',
  locations: 'location',
  lore: 'lore'
};
const chapterHeadingPattern = /^### Chapter\s+(\d+):\s*(.*)$/;
const sceneHeadingPattern = /^####\s+(Scene\s+.*)$/;
const codexMentionedHeadingPattern = /^####\s+Codex Mentioned$/;

export function supportsLocalFiles() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function openDatasourceFolder() {
  if (!supportsLocalFiles()) throw new Error('This browser does not support local folder editing. Use Chrome, Edge, or Brave.');
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

export async function saveRecentDatasourceHandle(handle) {
  const database = await openHandleDatabase();
  await putStoreValue(database, datasourceHandleKey, handle);
}

export async function loadRecentDatasourceHandle() {
  if (!supportsLocalFiles()) return null;
  const database = await openHandleDatabase();
  return getStoreValue(database, datasourceHandleKey);
}

export async function verifyHandlePermission(handle, mode = 'readwrite') {
  const options = { mode };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  return (await handle.requestPermission(options)) === 'granted';
}

export async function hasHandlePermission(handle, mode = 'readwrite') {
  return (await handle.queryPermission({ mode })) === 'granted';
}

export async function createStarterNovel(rootHandle, title) {
  const volumesDir = await rootHandle.getDirectoryHandle('volumes', { create: true });
  await ensureCodexFolders(rootHandle);
  const volumeHandle = await volumesDir.getFileHandle('volume1.md', { create: true });
  await writeTextFile(volumeHandle, createVolumeMarkdown({ title, volumeLabel: 'Volume 1' }));
}

export async function ensureCodexFolders(rootHandle) {
  const codexDir = await rootHandle.getDirectoryHandle('codex', { create: true });
  await Promise.all(codexCategories.map((category) => codexDir.getDirectoryHandle(category, { create: true })));
}

export async function listVolumes(rootHandle) {
  const volumesDir = await getDirectoryOrNull(rootHandle, 'volumes');
  const legacyActsDir = await getDirectoryOrNull(rootHandle, 'acts');
  const rootNovelHandle = await getFileOrNull(rootHandle, 'novel.md');
  const volumes = [];
  const seen = new Set();

  if (volumesDir) for await (const [name, handle] of volumesDir.entries()) {
    if (handle.kind !== 'file') continue;
    const match = name.match(/^volume(\d+)\.md$/);
    if (!match) continue;
    const number = Number(match[1]);
    seen.add(number);
    volumes.push(volumeMeta(number));
  }

  if (legacyActsDir) for await (const [name, handle] of legacyActsDir.entries()) {
    if (handle.kind !== 'file') continue;
    const match = name.match(/^act(\d+)\.md$/);
    if (!match) continue;
    const number = Number(match[1]);
    if (!seen.has(number)) volumes.push(legacyActMeta(number));
  }

  if (!volumes.length && rootNovelHandle) volumes.push(rootNovelMeta());

  return volumes.sort((a, b) => a.number - b.number);
}

export async function createVolume(rootHandle, title) {
  const volumes = await listVolumes(rootHandle);
  const nextNumber = Math.max(0, ...volumes.map((volume) => volume.number)) + 1;
  const volume = volumeMeta(nextNumber);
  const volumesDir = await rootHandle.getDirectoryHandle('volumes', { create: true });
  const volumeHandle = await volumesDir.getFileHandle(volume.filename, { create: true });
  await writeTextFile(volumeHandle, createVolumeMarkdown({ title, volumeLabel: volume.label }));
  return volume;
}

export async function readVolume(rootHandle, volumeId) {
  const volume = getVolumeFromId(volumeId);
  const volumesDir = await getDirectoryOrNull(rootHandle, 'volumes');
  const volumeHandle = volumesDir ? await getFileOrNull(volumesDir, volume.filename) : null;
  if (volumeHandle) return { volume, novel: withStats(parseNovel(await readTextFile(volumeHandle))) };

  const legacyActsDir = await getDirectoryOrNull(rootHandle, 'acts');
  const legacyHandle = legacyActsDir ? await getFileOrNull(legacyActsDir, `act${volume.number}.md`) : null;
  if (legacyHandle) return { volume: legacyActMeta(volume.number), novel: withStats(parseNovel(await readTextFile(legacyHandle))) };

  const rootNovelHandle = volume.id === 'volume1' ? await getFileOrNull(rootHandle, 'novel.md') : null;
  if (rootNovelHandle) return { volume: rootNovelMeta(), novel: withStats(parseNovel(await readTextFile(rootNovelHandle))) };

  throw new Error(`${volume.filename} was not found.`);
}

export async function writeVolume(rootHandle, volumeId, novel, codexEntries) {
  const volume = getVolumeFromId(volumeId);
  const markdown = serializeNovel(novel, { codexEntries });

  const volumesDir = await getDirectoryOrNull(rootHandle, 'volumes');
  const existingVolumeHandle = volumesDir ? await getFileOrNull(volumesDir, volume.filename) : null;
  const rootNovelHandle = volume.id === 'volume1' && !existingVolumeHandle ? await getFileOrNull(rootHandle, 'novel.md') : null;
  if (rootNovelHandle) {
    await writeTextFile(rootNovelHandle, markdown);
    return { volume: rootNovelMeta(), novel: withStats(parseNovel(markdown)) };
  }

  const nextVolumesDir = volumesDir ?? await rootHandle.getDirectoryHandle('volumes', { create: true });
  const volumeHandle = await nextVolumesDir.getFileHandle(volume.filename, { create: true });
  await writeTextFile(volumeHandle, markdown);
  return { volume, novel: withStats(parseNovel(markdown)) };
}

export async function deleteVolume(rootHandle, volume) {
  const target = typeof volume === 'string' ? getVolumeFromId(volume) : volume;
  const directoryName = target.legacy ? 'acts' : 'volumes';
  const directoryHandle = await getDirectoryOrNull(rootHandle, directoryName);
  if (!directoryHandle) return;
  await directoryHandle.removeEntry(target.filename);
}

export async function migrateLegacyActsToVolumes(rootHandle) {
  const legacyActsDir = await getDirectoryOrNull(rootHandle, 'acts');
  if (!legacyActsDir) return { migrated: 0, skipped: 0 };

  const volumesDir = await rootHandle.getDirectoryHandle('volumes', { create: true });
  let migrated = 0;
  let skipped = 0;

  for await (const [name, handle] of legacyActsDir.entries()) {
    if (handle.kind !== 'file') continue;
    const match = name.match(/^act(\d+)\.md$/);
    if (!match) continue;

    const targetFilename = `volume${match[1]}.md`;
    if (await getFileOrNull(volumesDir, targetFilename)) {
      skipped += 1;
      continue;
    }

    const targetHandle = await volumesDir.getFileHandle(targetFilename, { create: true });
    await writeTextFile(targetHandle, await readTextFile(handle));
    migrated += 1;
  }

  return { migrated, skipped };
}

export async function listCodexEntries(rootHandle) {
  const codexDir = await getDirectoryOrNull(rootHandle, 'codex');
  const groups = await Promise.all(
    codexCategories.map(async (category) => {
      const categoryDir = codexDir ? await getDirectoryOrNull(codexDir, category) : null;
      if (!categoryDir) return [category, []];

      const entries = [];
      for await (const [id, handle] of categoryDir.entries()) {
        if (handle.kind !== 'directory') continue;
        const entryHandle = await getFileOrNull(handle, 'entry.md');
        if (!entryHandle) continue;
        const markdown = await readTextFile(entryHandle);
        const entry = parseCodexEntry(markdown);
        entries.push({
          id,
          category,
          path: `${category}/${id}/entry.md`,
          type: entry.meta.type || typeByCategory[category],
          name: entry.meta.name || id,
          aliases: entry.meta.aliases ?? [],
          tags: entry.meta.tags ?? [],
          alwaysIncludeInContext: Boolean(entry.meta.alwaysIncludeInContext),
          doNotTrack: Boolean(entry.meta.doNotTrack),
          noAutoInclude: Boolean(entry.meta.noAutoInclude),
          body: entry.body,
          wordCount: countWords(entry.body)
        });
      }
      return [category, entries.sort((a, b) => a.name.localeCompare(b.name))];
    })
  );
  return Object.fromEntries(groups);
}

export async function recoverCodexFromCompiledFile(rootHandle) {
  const codexHandle = await getFileOrNull(rootHandle, 'codex.md');
  if (!codexHandle) return { count: 0, skipped: 0, codex: await listCodexEntries(rootHandle) };

  const entries = parseCompiledCodex(await readTextFile(codexHandle));
  let count = 0;
  let skipped = 0;

  for (const entry of entries) {
    const codexDir = await rootHandle.getDirectoryHandle('codex', { create: true });
    const categoryDir = await codexDir.getDirectoryHandle(entry.category, { create: true });
    const existingDir = await getDirectoryOrNull(categoryDir, entry.id);
    const existingFile = existingDir ? await getFileOrNull(existingDir, 'entry.md') : null;
    if (existingFile) {
      skipped += 1;
      continue;
    }

    await writeCodexEntry(rootHandle, entry);
    count += 1;
  }

  return { count, skipped, codex: await listCodexEntries(rootHandle) };
}

export async function readCodexEntry(rootHandle, category, id) {
  assertValidCategory(category);
  assertSafeId(id);
  const codexDir = await rootHandle.getDirectoryHandle('codex');
  const categoryDir = await codexDir.getDirectoryHandle(category);
  const entryDir = await categoryDir.getDirectoryHandle(id);
  const entryHandle = await entryDir.getFileHandle('entry.md');
  const parsed = parseCodexEntry(await readTextFile(entryHandle));
  return {
    id,
    category,
    path: `${category}/${id}/entry.md`,
    type: parsed.meta.type || typeByCategory[category],
    name: parsed.meta.name || id,
    color: parsed.meta.color ?? null,
    aliases: parsed.meta.aliases ?? [],
    tags: parsed.meta.tags ?? [],
    alwaysIncludeInContext: Boolean(parsed.meta.alwaysIncludeInContext),
    doNotTrack: Boolean(parsed.meta.doNotTrack),
    noAutoInclude: Boolean(parsed.meta.noAutoInclude),
    fields: parsed.meta.fields ?? {},
    body: parsed.body,
    wordCount: countWords(parsed.body)
  };
}

export async function writeCodexEntry(rootHandle, entry) {
  assertValidCategory(entry.category);
  assertSafeId(entry.id);
  const codexDir = await rootHandle.getDirectoryHandle('codex', { create: true });
  const categoryDir = await codexDir.getDirectoryHandle(entry.category, { create: true });
  const entryDir = await categoryDir.getDirectoryHandle(entry.id, { create: true });
  const entryHandle = await entryDir.getFileHandle('entry.md', { create: true });
  await writeTextFile(entryHandle, serializeCodexEntry(entry));
  return readCodexEntry(rootHandle, entry.category, entry.id);
}

export async function createCodexEntry(rootHandle, category, name) {
  assertValidCategory(category);
  const type = typeByCategory[category];
  const id = `${slugify(name || 'new-entry')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const entry = {
    id,
    category,
    type,
    name: name || 'New Entry',
    color: null,
    aliases: [],
    tags: [],
    alwaysIncludeInContext: false,
    doNotTrack: false,
    noAutoInclude: false,
    fields: {},
    body: 'New codex entry.'
  };
  await writeCodexEntry(rootHandle, entry);
  return readCodexEntry(rootHandle, category, id);
}

export async function deleteCodexEntry(rootHandle, category, id) {
  assertValidCategory(category);
  assertSafeId(id);
  const codexDir = await rootHandle.getDirectoryHandle('codex');
  const categoryDir = await codexDir.getDirectoryHandle(category);
  await categoryDir.removeEntry(id, { recursive: true });
}

export async function compileCodex(rootHandle) {
  const codex = await listCodexEntries(rootHandle);
  const entries = Object.values(codex).flatMap((items) => items ?? []);
  const lines = [
    '# Compiled Codex',
    '',
    '> Generated from local browser-selected datasource files.',
    '',
    `Generated entries: ${entries.length}`,
    ''
  ];

  for (const category of codexCategories) {
    const categoryEntries = codex[category] ?? [];
    if (!categoryEntries.length) continue;
    lines.push(`## ${titleCase(category)}`, '');
    for (const entry of categoryEntries) {
      lines.push(`### ${entry.name}`, '', `- Type: ${entry.type}`, `- Source: ${entry.path}`, `- Aliases: ${formatList(entry.aliases)}`, `- Tags: ${formatList(entry.tags)}`, '', entry.body || 'No details yet.', '');
    }
  }

  const codexHandle = await rootHandle.getFileHandle('codex.md', { create: true });
  await writeTextFile(codexHandle, lines.join('\n').trimEnd() + '\n');
  return { count: entries.length, path: 'codex.md' };
}

export function flattenCodexEntries(codex) {
  return Object.values(codex ?? {}).flatMap((entries) => entries ?? []);
}

async function getDirectoryOrNull(parentHandle, name) {
  try {
    return await parentHandle.getDirectoryHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function getFileOrNull(parentHandle, name) {
  try {
    return await parentHandle.getFileHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function readTextFile(fileHandle) {
  return (await fileHandle.getFile()).text();
}

async function writeTextFile(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function openHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(datasourceDbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(datasourceStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getStoreValue(database, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(datasourceStoreName, 'readonly');
    const request = transaction.objectStore(datasourceStoreName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function putStoreValue(database, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(datasourceStoreName, 'readwrite');
    transaction.objectStore(datasourceStoreName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function volumeMeta(number) {
  return { id: `volume${number}`, number, label: `Volume ${number}`, filename: `volume${number}.md`, path: `volumes/volume${number}.md` };
}

function rootNovelMeta() {
  return { id: 'volume1', number: 1, label: 'Volume 1', filename: 'novel.md', path: 'novel.md', rootNovel: true };
}

function legacyActMeta(number) {
  return { id: `volume${number}`, number, label: `Volume ${number}`, filename: `act${number}.md`, path: `acts/act${number}.md`, legacy: true };
}

function getVolumeFromId(volumeId) {
  const normalized = convertActIdToVolumeId(volumeId);
  const match = String(normalized ?? '').match(/^volume(\d+)$/);
  if (!match) throw new Error('Invalid volume id.');
  return volumeMeta(Number(match[1]));
}

function convertActIdToVolumeId(id) {
  const match = String(id ?? '').match(/^act(\d+)$/);
  return match ? `volume${match[1]}` : id;
}

function createVolumeMarkdown({ volumeLabel, title }) {
  return [`## ${title || 'Untitled Novel'}`, '', `### Chapter 1: ${volumeLabel} Opening`, '', '#### Scene 1', '', 'Start writing here...', ''].join('\n');
}

function parseNovel(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const document = { header: [], title: '', chapters: [] };
  let currentChapter = null;
  let currentScene = null;
  let paragraphLines = [];
  let skippingCodexMentioned = false;

  const flushParagraph = () => {
    if (!currentScene || paragraphLines.length === 0) return;
    const text = paragraphLines.join('\n').trim();
    if (text) currentScene.paragraphs.push(text);
    paragraphLines = [];
  };

  const startScene = (heading) => {
    flushParagraph();
    currentScene = { id: createId('scene'), heading, paragraphs: [] };
    currentChapter.scenes.push(currentScene);
  };

  for (const line of lines) {
    const chapterMatch = line.match(chapterHeadingPattern);
    if (chapterMatch) {
      flushParagraph();
      skippingCodexMentioned = false;
      currentChapter = { id: createId('chapter'), chapterNumber: Number(chapterMatch[1]), title: chapterMatch[2].trim(), scenes: [] };
      document.chapters.push(currentChapter);
      currentScene = null;
      continue;
    }
    if (!currentChapter) {
      document.header.push(line);
      const titleMatch = line.match(/^##\s+(.+)$/);
      if (titleMatch) document.title = titleMatch[1].trim();
      continue;
    }
    const sceneMatch = line.match(sceneHeadingPattern);
    if (sceneMatch) {
      skippingCodexMentioned = false;
      startScene(sceneMatch[1].trim());
      continue;
    }
    if (line.match(codexMentionedHeadingPattern)) {
      flushParagraph();
      skippingCodexMentioned = true;
      continue;
    }
    if (skippingCodexMentioned) continue;
    if (!currentScene && line.trim()) startScene('Scene 1');
    if (!currentScene) continue;
    if (!line.trim()) flushParagraph();
    else paragraphLines.push(line);
  }

  flushParagraph();
  return document;
}

function serializeNovel(document, options = {}) {
  const output = [...(document.header ?? [])];
  const codexEntries = options.codexEntries ?? [];
  for (const chapter of document.chapters ?? []) {
    trimTrailingBlankLines(output);
    output.push('', `### Chapter ${chapter.chapterNumber}: ${chapter.title}`.trimEnd(), '');
    output.push(...serializeCodexMentioned(chapter, codexEntries));
    for (const scene of chapter.scenes ?? []) {
      output.push(`#### ${scene.heading || 'Scene 1'}`, '');
      for (const paragraph of scene.paragraphs ?? []) {
        const text = String(paragraph ?? '').trim();
        if (text) output.push(text, '');
      }
    }
  }
  trimTrailingBlankLines(output);
  output.push('');
  return output.join('\n');
}

function withStats(novel) {
  const chapters = novel.chapters.map((chapter) => {
    const wordCount = chapter.scenes.reduce((chapterTotal, scene) => chapterTotal + scene.paragraphs.reduce((sceneTotal, paragraph) => sceneTotal + countWords(paragraph), 0), 0);
    return { ...chapter, wordCount };
  });
  return { ...novel, chapters, wordCount: chapters.reduce((total, chapter) => total + chapter.wordCount, 0) };
}

function serializeCodexMentioned(chapter, codexEntries) {
  const mentioned = getMentionedCodexEntries(chapter, codexEntries);
  if (!mentioned.length) return [];
  const groups = {
    character: mentioned.filter((entry) => entry.type === 'character'),
    location: mentioned.filter((entry) => entry.type === 'location'),
    lore: mentioned.filter((entry) => entry.type === 'lore')
  };
  const lines = ['#### Codex Mentioned', ''];
  for (const [type, entries] of Object.entries(groups)) {
    if (entries.length) lines.push(`- **${titleCase(type)}:** ${entries.map((entry) => entry.name).join(', ')}`);
  }
  lines.push('');
  return lines;
}

function getMentionedCodexEntries(chapter, codexEntries) {
  const text = (chapter.scenes ?? []).flatMap((scene) => scene.paragraphs ?? []).join('\n\n');
  const mentioned = new Map();
  for (const entry of codexEntries) {
    const terms = [entry.name, ...(entry.aliases ?? [])].map((term) => String(term ?? '').trim()).filter(Boolean);
    if (terms.some((term) => containsTerm(text, term))) mentioned.set(`${entry.category}:${entry.id}`, entry);
  }
  return [...mentioned.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function containsTerm(text, term) {
  let from = text.indexOf(term);
  while (from !== -1) {
    const to = from + term.length;
    if (hasMentionBoundary(text, from, to)) return true;
    from = text.indexOf(term, from + 1);
  }
  return false;
}

function hasMentionBoundary(text, from, to) {
  const before = text[from - 1];
  const after = text[to];
  const startsWord = isWordLike(text[from]);
  const endsWord = isWordLike(text[to - 1]);
  return !(startsWord && isWordLike(before)) && !(endsWord && isWordLike(after));
}

function parseCodexEntry(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: normalized.trim() };
  return { meta: parseFrontmatter(match[1]), body: match[2].trim() };
}

function parseCompiledCodex(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let currentCategory = null;
  let currentEntry = null;

  const flushEntry = () => {
    if (!currentEntry) return;
    const source = parseSourcePath(currentEntry.meta.source);
    const category = source?.category ?? currentEntry.category;
    const type = currentEntry.meta.type || typeByCategory[category];
    const id = source?.id ?? slugify(currentEntry.name);

    if (codexCategories.includes(category) && id) {
      entries.push({
        id,
        category,
        type,
        name: currentEntry.name,
        color: null,
        aliases: currentEntry.meta.aliases ?? [],
        tags: currentEntry.meta.tags ?? [],
        alwaysIncludeInContext: Boolean(currentEntry.meta.alwaysIncludeInContext),
        doNotTrack: Boolean(currentEntry.meta.doNotTrack),
        noAutoInclude: Boolean(currentEntry.meta.noAutoInclude),
        fields: {},
        body: currentEntry.bodyLines.join('\n').trim() || 'No details yet.'
      });
    }

    currentEntry = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const categoryMatch = line.match(/^##\s+(.+)\s*$/);
    if (categoryMatch && !line.startsWith('###')) {
      flushEntry();
      currentCategory = normalizeCompiledCategory(categoryMatch[1]);
      continue;
    }

    const entryMatch = line.match(/^###\s+(.+)\s*$/);
    if (currentCategory && entryMatch && hasCompiledEntryMetadataAhead(lines, index + 1)) {
      flushEntry();
      currentEntry = {
        category: currentCategory,
        name: entryMatch[1].trim(),
        meta: {},
        metadataComplete: false,
        bodyLines: []
      };
      continue;
    }

    if (!currentEntry) continue;

    if (!currentEntry.metadataComplete) {
      const metadata = parseCompiledMetadataLine(line);
      if (metadata) {
        Object.assign(currentEntry.meta, metadata);
        continue;
      }
      if (!line.trim()) continue;
      currentEntry.metadataComplete = true;
    }

    currentEntry.bodyLines.push(line);
  }

  flushEntry();
  return entries;
}

function hasCompiledEntryMetadataAhead(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    return Boolean(parseCompiledMetadataLine(line));
  }
  return false;
}

function parseCompiledMetadataLine(line) {
  const bold = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
  const bullet = line.match(/^-\s*([^:]+):\s*(.*)$/);
  const match = bold ?? bullet;
  if (!match) return null;

  const key = match[1].trim().toLowerCase();
  const value = match[2].trim().replace(/^`|`$/g, '');

  if (key === 'type') return { type: value };
  if (key === 'source') return { source: value };
  if (key === 'aliases') return { aliases: parseCompiledList(value) };
  if (key === 'tags') return { tags: parseCompiledList(value) };
  if (key === 'context') return parseCompiledContext(value);
  return null;
}

function parseCompiledContext(value) {
  const context = {};
  const pattern = /([A-Za-z0-9_]+)=([^,\s]+)/g;
  let match = pattern.exec(value);
  while (match) {
    context[match[1]] = match[2] === 'true';
    match = pattern.exec(value);
  }
  return context;
}

function parseCompiledList(value) {
  if (!value || value === 'None') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseSourcePath(source) {
  const match = String(source ?? '').match(/(?:^|`)?(characters|locations|lore)\/([^/`]+)\/entry\.md/);
  return match ? { category: match[1], id: match[2] } : null;
}

function normalizeCompiledCategory(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.startsWith('character')) return 'characters';
  if (normalized.startsWith('location')) return 'locations';
  if (normalized.startsWith('lore')) return 'lore';
  return null;
}

function serializeCodexEntry(entry) {
  return [
    '---',
    `type: ${entry.type || typeByCategory[entry.category]}`,
    `name: ${entry.name || 'Untitled'}`,
    `color: ${entry.color ?? 'null'}`,
    ...serializeArray('aliases', entry.aliases),
    ...serializeArray('tags', entry.tags),
    `alwaysIncludeInContext: ${Boolean(entry.alwaysIncludeInContext)}`,
    `doNotTrack: ${Boolean(entry.doNotTrack)}`,
    `noAutoInclude: ${Boolean(entry.noAutoInclude)}`,
    'fields: {}',
    '---',
    String(entry.body ?? '').trim(),
    ''
  ].join('\n');
}

function parseFrontmatter(source) {
  const meta = {};
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const scalar = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;
    const key = scalar[1];
    const value = scalar[2];
    if (value === '') {
      const items = [];
      while (lines[index + 1]?.startsWith('  - ')) {
        index += 1;
        items.push(parseScalar(lines[index].slice(4)));
      }
      meta[key] = items;
    } else if (value === '[]') meta[key] = [];
    else if (value === '{}') meta[key] = {};
    else meta[key] = parseScalar(value);
  }
  return meta;
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value.replace(/^['"]|['"]$/g, '');
}

function serializeArray(key, values) {
  const list = (values ?? []).map((value) => String(value).trim()).filter(Boolean);
  if (!list.length) return [`${key}: []`];
  return [`${key}:`, ...list.map((value) => `  - ${value}`)];
}

function trimTrailingBlankLines(lines) {
  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function countWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}\u2019'-]+/gu) ?? []).length;
}

function formatList(values) {
  const list = (values ?? []).map((value) => String(value).trim()).filter(Boolean);
  return list.length ? list.join(', ') : 'None';
}

function titleCase(value) {
  return String(value).replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function slugify(value) {
  return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-entry';
}

function assertValidCategory(category) {
  if (!codexCategories.includes(category)) throw new Error('Invalid codex category.');
}

function assertSafeId(id) {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) throw new Error('Invalid codex entry id.');
}

function isWordLike(value) {
  return Boolean(value && /[\p{L}\p{N}_'-]/u.test(value));
}
