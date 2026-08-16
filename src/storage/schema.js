import { createSqliteAdapter } from './sqliteAdapters.js';

export const SCHEMA_VERSION = 1;
export const CODEX_CATEGORIES = Object.freeze(['characters', 'locations', 'lore']);
export const TYPE_BY_CATEGORY = Object.freeze({
  characters: 'character',
  locations: 'location',
  lore: 'lore'
});

export const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  project_uuid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE CHECK (number > 0),
  title TEXT NOT NULL DEFAULT '',
  raw_header TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  heading TEXT NOT NULL DEFAULT 'Scene 1',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS scene_paragraphs (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (scene_id, sort_order)
);

CREATE TABLE IF NOT EXISTS codex_categories (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS codex_entries (
  internal_id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES codex_categories(id),
  legacy_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  body TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '{}',
  always_include_in_context INTEGER NOT NULL DEFAULT 0 CHECK (always_include_in_context IN (0, 1)),
  do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1)),
  no_auto_include INTEGER NOT NULL DEFAULT 0 CHECK (no_auto_include IN (0, 1)),
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (category_id, legacy_id)
);

CREATE TABLE IF NOT EXISTS codex_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_internal_id TEXT NOT NULL REFERENCES codex_entries(internal_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (entry_internal_id, alias),
  UNIQUE (entry_internal_id, sort_order)
);

CREATE TABLE IF NOT EXISTS codex_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_internal_id TEXT NOT NULL REFERENCES codex_entries(internal_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (entry_internal_id, tag),
  UNIQUE (entry_internal_id, sort_order)
);

CREATE TABLE IF NOT EXISTS codex_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_internal_id TEXT NOT NULL REFERENCES codex_entries(internal_id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES scene_paragraphs(id) ON DELETE CASCADE,
  paragraph_index INTEGER NOT NULL,
  term TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  context_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (entry_internal_id, paragraph_id, term, start_offset, end_offset)
);

CREATE TABLE IF NOT EXISTS scene_search_documents (
  scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS codex_search_documents (
  entry_internal_id TEXT PRIMARY KEY REFERENCES codex_entries(internal_id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_volumes_order ON volumes(sort_order, number);
CREATE INDEX IF NOT EXISTS idx_chapters_volume_order ON chapters(volume_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_scenes_chapter_order ON scenes(chapter_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_paragraphs_scene_order ON scene_paragraphs(scene_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_codex_entries_category_name ON codex_entries(category_id, name);
CREATE INDEX IF NOT EXISTS idx_codex_aliases_entry_order ON codex_aliases(entry_internal_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_codex_tags_entry_order ON codex_tags(entry_internal_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_mentions_scene_entry ON codex_mentions(scene_id, entry_internal_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entry_scene ON codex_mentions(entry_internal_id, scene_id);
CREATE INDEX IF NOT EXISTS idx_mentions_paragraph_offset ON codex_mentions(paragraph_id, start_offset);
`;

export const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts USING fts5(
  scene_id UNINDEXED,
  content
);
CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts USING fts5(
  entry_internal_id UNINDEXED,
  name,
  aliases,
  body
);
`;

const requiredColumns = {
  project: ['singleton_id', 'project_uuid', 'schema_version'],
  volumes: ['id', 'number', 'raw_header', 'sort_order'],
  chapters: ['id', 'volume_id', 'chapter_number', 'sort_order'],
  scenes: ['id', 'chapter_id', 'heading', 'sort_order'],
  scene_paragraphs: ['id', 'scene_id', 'sort_order', 'content'],
  codex_entries: ['internal_id', 'category_id', 'legacy_id', 'fields_json', 'word_count'],
  codex_mentions: ['entry_internal_id', 'scene_id', 'paragraph_id', 'paragraph_index', 'term', 'start_offset', 'end_offset'],
  scene_search_documents: ['scene_id', 'content'],
  codex_search_documents: ['entry_internal_id', 'content']
};

export function createUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    const seed = Date.now() + Math.random() * 0x100000000;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor((Math.random() * 256 + seed / 2 ** (index % 8)) % 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readUserVersion(adapter) {
  return Number(adapter.get('PRAGMA user_version')?.user_version ?? 0);
}

function validateSchema(adapter) {
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(adapter.all(`PRAGMA table_info(${table})`).map((column) => column.name));
    if (!actual.size) throw new Error(`Invalid project database: missing table ${table}.`);
    for (const column of columns) {
      if (!actual.has(column)) throw new Error(`Invalid project database: ${table}.${column} is missing.`);
    }
  }

  const projectRows = adapter.all('SELECT project_uuid, schema_version FROM project');
  if (projectRows.length !== 1 || Number(projectRows[0].schema_version) !== SCHEMA_VERSION) {
    throw new Error('Invalid project database: expected one version 1 project row.');
  }

  const categories = adapter.all('SELECT id FROM codex_categories ORDER BY id').map((row) => row.id);
  if (categories.join(',') !== [...CODEX_CATEGORIES].sort().join(',')) {
    throw new Error('Invalid project database: codex categories do not match the standard categories.');
  }
}

function initializeFts(adapter) {
  try {
    adapter.transaction(() => {
      adapter.exec(FTS_SCHEMA_SQL);
      adapter.run('DELETE FROM scenes_fts');
      adapter.run(`
        INSERT INTO scenes_fts (scene_id, content)
        SELECT s.id,
          s.heading || COALESCE((
            SELECT char(10) || char(10) || group_concat(content, char(10) || char(10))
            FROM (
              SELECT content FROM scene_paragraphs WHERE scene_id = s.id ORDER BY sort_order
            )
          ), '')
        FROM scenes s
      `);
      adapter.run('DELETE FROM codex_fts');
      adapter.run(`
        INSERT INTO codex_fts (entry_internal_id, name, aliases, body)
        SELECT e.internal_id, e.name,
          COALESCE((SELECT group_concat(a.alias, ' ') FROM codex_aliases a WHERE a.entry_internal_id = e.internal_id ORDER BY a.sort_order), ''),
          e.body
        FROM codex_entries e
      `);
    });
    return true;
  } catch {
    return false;
  }
}

export function initializeSchema(database) {
  const adapter = createSqliteAdapter(database);
  adapter.exec('PRAGMA foreign_keys = ON');
  const currentVersion = readUserVersion(adapter);
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`Project schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`);
  }

  if (currentVersion === 0) {
    adapter.transaction(() => {
      adapter.exec(BASE_SCHEMA_SQL);
      for (const category of CODEX_CATEGORIES) {
        adapter.run('INSERT OR IGNORE INTO codex_categories (id) VALUES (?)', [category]);
      }
      adapter.run(
        `INSERT OR IGNORE INTO project (singleton_id, project_uuid, schema_version) VALUES (1, ?, ?)`,
        [createUuid(), SCHEMA_VERSION]
      );
      validateSchema(adapter);
      adapter.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  validateSchema(adapter);
  try {
    adapter.transaction(() => {
      adapter.run('DELETE FROM scene_search_documents');
      adapter.run('DELETE FROM codex_search_documents');
      adapter.run("UPDATE codex_mentions SET context_text = ''");
    });
  } catch {}
  return { adapter, ftsAvailable: initializeFts(adapter), schemaVersion: SCHEMA_VERSION };
}
