import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const categories = ['characters', 'locations', 'lore'];
const typeByCategory = {
  characters: 'character',
  locations: 'location',
  lore: 'lore'
};

export async function listCodexEntries(codexDir) {
  const groups = await Promise.all(
    categories.map(async (category) => {
      const categoryDir = path.join(codexDir, category);
      const directories = await readDirectoryOrEmpty(categoryDir);
      const entries = await Promise.all(
        directories
          .filter((directory) => directory.isDirectory())
          .map(async (directory) => {
            const entryPath = path.join(categoryDir, directory.name, 'entry.md');
            const markdown = await readFile(entryPath, 'utf8');
            const entry = parseCodexEntry(markdown);

            return {
              id: directory.name,
              category,
              path: `${category}/${directory.name}/entry.md`,
              type: entry.meta.type || typeByCategory[category],
              name: entry.meta.name || directory.name,
              aliases: entry.meta.aliases ?? [],
              tags: entry.meta.tags ?? [],
              alwaysIncludeInContext: Boolean(entry.meta.alwaysIncludeInContext),
              doNotTrack: Boolean(entry.meta.doNotTrack),
              noAutoInclude: Boolean(entry.meta.noAutoInclude),
              body: entry.body,
              wordCount: countWords(entry.body)
            };
          })
      );

      return [category, entries.sort((a, b) => a.name.localeCompare(b.name))];
    })
  );

  return Object.fromEntries(groups);
}

export async function compileCodex(codexDir) {
  const codex = await listCodexEntries(codexDir);
  const sections = [
    '# Codex',
    '',
    'Generated from `datasource/codex`.',
    '',
    '> Disclaimer: The `Source` path shown on each entry is a local project reference used by this editor. It most likely will not exist or resolve in other systems that consume this compiled codex.',
    ''
  ];
  let count = 0;

  for (const category of categories) {
    const entries = codex[category] ?? [];
    sections.push(`## ${titleCase(category)}`, '');

    for (const entry of entries) {
      count += 1;
      sections.push(
        `### ${entry.name}`,
        '',
        `**Type:** ${entry.type}`,
        `**Source:** \`${entry.path}\``,
        `**Aliases:** ${formatList(entry.aliases)}`,
        `**Tags:** ${formatList(entry.tags)}`,
        `**Context:** alwaysIncludeInContext=${entry.alwaysIncludeInContext}, doNotTrack=${entry.doNotTrack}, noAutoInclude=${entry.noAutoInclude}`,
        '',
        entry.body.trim() || '_No body content._',
        ''
      );
    }
  }

  return {
    count,
    markdown: `${sections.join('\n').trim()}\n`
  };
}

export async function readCodexEntry(codexDir, category, id) {
  assertValidCategory(category);
  assertSafeId(id);
  const entryPath = path.join(codexDir, category, id, 'entry.md');
  const markdown = await readFile(entryPath, 'utf8');
  const entry = parseCodexEntry(markdown);

  return {
    id,
    category,
    path: `${category}/${id}/entry.md`,
    type: entry.meta.type || typeByCategory[category],
    name: entry.meta.name || id,
    color: entry.meta.color ?? null,
    aliases: entry.meta.aliases ?? [],
    tags: entry.meta.tags ?? [],
    alwaysIncludeInContext: Boolean(entry.meta.alwaysIncludeInContext),
    doNotTrack: Boolean(entry.meta.doNotTrack),
    noAutoInclude: Boolean(entry.meta.noAutoInclude),
    fields: entry.meta.fields ?? {},
    body: entry.body,
    wordCount: countWords(entry.body)
  };
}

export async function writeCodexEntry(codexDir, entry) {
  assertValidCategory(entry.category);
  assertSafeId(entry.id);
  const entryPath = path.join(codexDir, entry.category, entry.id, 'entry.md');
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, serializeCodexEntry(entry), 'utf8');
  return readCodexEntry(codexDir, entry.category, entry.id);
}

export async function createCodexEntry(codexDir, category, name) {
  assertValidCategory(category);
  const type = typeByCategory[category];
  const id = `${slugify(name || 'new-entry')}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

  await writeCodexEntry(codexDir, entry);
  return readCodexEntry(codexDir, category, id);
}

export async function deleteCodexEntry(codexDir, category, id) {
  assertValidCategory(category);
  assertSafeId(id);
  await rm(path.join(codexDir, category, id), { recursive: true, force: true });
}

async function readDirectoryOrEmpty(directoryPath) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function parseCodexEntry(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: normalized.trim() };

  return {
    meta: parseFrontmatter(match[1]),
    body: match[2].trim()
  };
}

export function serializeCodexEntry(entry) {
  const lines = [
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
  ];

  return lines.join('\n');
}

function parseFrontmatter(source) {
  const meta = {};
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
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
      continue;
    }

    if (value === '[]') {
      meta[key] = [];
    } else if (value === '{}') {
      meta[key] = {};
    } else {
      meta[key] = parseScalar(value);
    }
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
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-entry';
}

function assertValidCategory(category) {
  if (!categories.includes(category)) {
    throw new Error('Invalid codex category.');
  }
}

function assertSafeId(id) {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error('Invalid codex entry id.');
  }
}
