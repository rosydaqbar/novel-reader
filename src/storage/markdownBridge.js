import { createUuid, TYPE_BY_CATEGORY } from './schema.js';
import { containsTerm } from './mentionIndexer.js';

const chapterHeadingPattern = /^### Chapter\s+(\d+):\s*(.*)$/;
const sceneHeadingPattern = /^####\s+(Scene\s+.*)$/;
const codexMentionedHeadingPattern = /^####\s+Codex Mentioned$/;

export function parseNovel(markdown, options = {}) {
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const document = { header: [], title: '', chapters: [] };
  const createIds = options.createIds !== false;
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
    currentScene = { heading, paragraphs: [] };
    if (createIds) currentScene.id = `scene-${createUuid()}`;
    currentChapter.scenes.push(currentScene);
  };

  for (const line of lines) {
    const chapterMatch = line.match(chapterHeadingPattern);
    if (chapterMatch) {
      flushParagraph();
      skippingCodexMentioned = false;
      currentChapter = {
        chapterNumber: Number(chapterMatch[1]),
        title: chapterMatch[2].trim(),
        scenes: []
      };
      if (createIds) currentChapter.id = `chapter-${createUuid()}`;
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

    if (codexMentionedHeadingPattern.test(line)) {
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

export function serializeNovel(document, options = {}) {
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

export function parseCodexEntry(markdown) {
  const normalized = String(markdown ?? '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: normalized.trim() };
  return { meta: parseFrontmatter(match[1]), body: match[2].trim() };
}

export function serializeCodexEntry(entry) {
  return [
    '---',
    `type: ${entry.type || TYPE_BY_CATEGORY[entry.category]}`,
    `name: ${entry.name || 'Untitled'}`,
    `color: ${entry.color ?? 'null'}`,
    ...serializeArray('aliases', entry.aliases),
    ...serializeArray('tags', entry.tags),
    `alwaysIncludeInContext: ${Boolean(entry.alwaysIncludeInContext)}`,
    `doNotTrack: ${Boolean(entry.doNotTrack)}`,
    `noAutoInclude: ${Boolean(entry.noAutoInclude)}`,
    `fields: ${JSON.stringify(normalizeFields(entry.fields))}`,
    '---',
    String(entry.body ?? '').trim(),
    ''
  ].join('\n');
}

export function countWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}\u2019'-]+/gu) ?? []).length;
}

export function withNovelStats(novel) {
  const chapters = (novel.chapters ?? []).map((chapter) => {
    const scenes = (chapter.scenes ?? []).map((scene) => ({
      ...scene,
      wordCount: (scene.paragraphs ?? []).reduce((total, paragraph) => total + countWords(paragraph), 0)
    }));
    return { ...chapter, scenes, wordCount: scenes.reduce((total, scene) => total + scene.wordCount, 0) };
  });
  return { ...novel, chapters, wordCount: chapters.reduce((total, chapter) => total + chapter.wordCount, 0) };
}

export function flattenCodexEntries(codex) {
  return Object.values(codex ?? {}).flatMap((entries) => entries ?? []);
}

function serializeCodexMentioned(chapter, codexEntries) {
  const text = (chapter.scenes ?? []).flatMap((scene) => scene.paragraphs ?? []).join('\n\n');
  const mentioned = new Map();
  for (const entry of codexEntries) {
    const terms = [entry.name, ...(entry.aliases ?? [])].map((term) => String(term ?? '').trim()).filter(Boolean);
    if (terms.some((term) => containsTerm(text, term))) mentioned.set(`${entry.category}:${entry.id}`, entry);
  }
  const entries = [...mentioned.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  if (!entries.length) return [];

  const lines = ['#### Codex Mentioned', ''];
  for (const type of ['character', 'location', 'lore']) {
    const grouped = entries.filter((entry) => entry.type === type);
    if (grouped.length) lines.push(`- **${titleCase(type)}:** ${grouped.map((entry) => entry.name).join(', ')}`);
  }
  lines.push('');
  return lines;
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
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return value.replace(/^['"]|['"]$/g, '');
}

function serializeArray(key, values) {
  const list = uniqueOrdered(values);
  return list.length ? [`${key}:`, ...list.map((value) => `  - ${value}`)] : [`${key}: []`];
}

function uniqueOrdered(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeFields(fields) {
  return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
}

function trimTrailingBlankLines(lines) {
  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
}

function titleCase(value) {
  return String(value).replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
