# Novel Project Binary File — Implementation Plan

## 1. Overview

Create a single `.novel` SQLite database file as the authoritative source of truth for the novel project, containing all volumes, chapters, scenes, codex entries, aliases, tags, and pre-computed mention indexes. Markdown files become optional export artifacts.

## 2. Dependencies to Add

| Environment | Library | Purpose |
|-------------|---------|---------|
| Server (Node.js) | `better-sqlite3` | Native SQLite binding |
| Browser | `sql.js` | SQLite compiled to WASM |
| Shared | None | A normalized adapter wraps the different native and WASM APIs |

Schema migrations: none needed to start — define schema version 1 and handle upgrades via migration functions later if needed.

## 3. File Format

- **Extension:** `.novel`
- **Location (server):** `datasource/project.novel`
- **Location (browser):** User-chosen single file via `showSaveFilePicker` / `showOpenFilePicker`
- **MIME:** `application/novel-reader-project`

## 4. Database Schema

Implementation note: `src/storage/schema.js` is the authoritative schema. It extends this original sketch with category-safe codex identities, raw volume headers, codex fields, occurrence-level mention offsets, ordered aliases/tags, and materialized FTS documents with a non-FTS fallback.

```sql
-- Project metadata (singleton row)
CREATE TABLE project (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Volumes
CREATE TABLE volumes (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chapters
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scenes
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scene paragraphs (ordered text blocks)
CREATE TABLE scene_paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  content TEXT NOT NULL
);

-- Codex categories
CREATE TABLE codex_categories (
  id TEXT PRIMARY KEY
);
INSERT INTO codex_categories VALUES ('characters'), ('locations'), ('lore');

-- Codex entries
CREATE TABLE codex_entries (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES codex_categories(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  body TEXT NOT NULL DEFAULT '',
  always_include_in_context INTEGER NOT NULL DEFAULT 0,
  do_not_track INTEGER NOT NULL DEFAULT 0,
  no_auto_include INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Codex aliases
CREATE TABLE codex_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  alias TEXT NOT NULL
);

-- Codex tags
CREATE TABLE codex_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  tag TEXT NOT NULL
);

-- Pre-computed mention index (codex entry ↔ scene mapping)
CREATE TABLE codex_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  context_text TEXT,
  UNIQUE(entry_id, scene_id)
);

-- Full-text search virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts USING fts5(
  content,
  content='scene_paragraphs',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts USING fts5(
  name, aliases, body,
  content='codex_entries',
  content_rowid='rowid'
);

-- Performance indexes
CREATE INDEX idx_chapters_volume ON chapters(volume_id);
CREATE INDEX idx_scenes_chapter ON scenes(chapter_id);
CREATE INDEX idx_paragraphs_scene ON scene_paragraphs(scene_id);
CREATE INDEX idx_codex_entries_category ON codex_entries(category_id);
CREATE INDEX idx_codex_mentions_scene ON codex_mentions(scene_id);
CREATE INDEX idx_codex_mentions_entry ON codex_mentions(entry_id);
```

## 5. Architecture Layers

### Layer 1: Core Engine (shared logic)

New shared module `src/storage/projectDb.js`:

```
src/
  storage/
    projectDb.js          ← Abstract SQLite operations (shared logic)
    schema.js             ← DDL statements, migrations
    mentionIndexer.js     ← Pre-compute codex mentions
    markdownBridge.js     ← Import/export between .novel ↔ .md
```

```js
// projectDb.js API surface
class ProjectDb {
  constructor(db)  // wraps better-sqlite3 or sql.js instance

  // Project
  getProjectMeta()
  updateProjectMeta({ title, author, description })

  // Volumes
  listVolumes()
  createVolume({ number, title })
  deleteVolume(id)
  getVolume(id)

  // Chapters
  listChapters(volumeId)
  createChapter({ volumeId, chapterNumber, title })
  updateChapter(id, { title })
  deleteChapter(id)
  reorderChapters(volumeId, orderedIds)

  // Scenes
  listScenes(chapterId)
  createScene({ chapterId, heading })
  updateScene(id, { heading })
  deleteScene(id)
  reorderScenes(chapterId, orderedIds)

  // Paragraphs
  setParagraphs(sceneId, paragraphs[])
  getParagraphs(sceneId)

  // Novel (full document convenience)
  getNovel(volumeId)       → { header, title, chapters }
  putNovel(volumeId, novel) → void

  // Codex
  listCodex(category?)       → { characters, locations, lore }
  getCodexEntry(id)
  createCodexEntry({ category, name, type })
  updateCodexEntry(id, patch)
  deleteCodexEntry(id)

  // Mentions
  rebuildMentionIndex(volumeId?)
  getMentionsForScene(sceneId)

  // Search
  searchScenes(query)    → [{ sceneId, chapterTitle, heading, snippet }]
  searchCodex(query)     → [{ entryId, name, snippet }]

  // Import/Export
  importFromMarkdown(volumeId, mdString) → void
  exportToMarkdown(volumeId) → string
}
```

### Layer 2: Server Adapter

New file `server/projectServer.js`:

- Uses `better-sqlite3` to open `datasource/project.novel`
- Provides the same `ProjectDb` API backed by native SQLite
- New API endpoints:

```
GET    /api/project            → project meta
PUT    /api/project            → update meta
GET    /api/project/export     → download .novel file
POST   /api/project/import     → upload .novel file
POST   /api/mentions/rebuild   → trigger re-index
```

Existing markdown-based endpoints (`/api/volumes`, `/api/codex`) remain as compatibility wrappers that optionally read/write via the `.novel` file depending on a config flag.

### Layer 3: Browser Adapter

New file `src/browserDb.js`:

- Uses `sql.js` (WASM) to open a `.novel` file
- Integrates with File System Access API:
  - `openProjectFile()` → `showOpenFilePicker`
  - `saveProjectFile()` → `showSaveFilePicker`
- Provides the same `ProjectDb` API backed by WASM SQLite
- On save: writes the entire `.novel` file bytes back to the file handle

### Layer 4: Integration in `src/main.jsx`

Add project file state and `projectDb` instance. Updated state machine:

```
Start → Check for recent project handle (IndexedDB)
         ├── Yes → verify permission → open .novel → load project
         └── No  → show "Open Project" or "New Project" prompt

Project loaded → populate volumes, novel, codex from projectDb
Editing → update projectDb in-memory
Save → write bytes to disk file handle (atomic write)
```

Drafts in localStorage are no longer needed — the `.novel` file IS the draft, with SQLite transactions for crash safety.

## 6. Mention Indexer Algorithm

```
rebuildMentionIndex(volumeId):
  1. Collect all entries + aliases from codex_entries / codex_aliases
  2. Sort entries by name length descending (longer matches first)
  3. For each scene in volumeId:
     Join all paragraphs into single text
     For each entry (sorted long-first):
       Check for word-boundary match of name or any alias
       If match found:
         Extract 60-char surrounding context
         INSERT INTO codex_mentions (entry_id, scene_id, context_text)
  4. DELETE old mentions for affected scenes first (transactional)
```

Mirrors the existing `getMentionedCodexEntries` logic from `localDatasource.js` and `markdown.js`, but stores results persistently.

## 7. Migration Path

```js
function migrateToProjectFile() {
  // Read all volumes from markdown files
  // Read all codex entries from entry.md files
  // Build the mention index
  // Write to .novel file
}
```

After migration, the `.novel` file is primary. Markdown files can be regenerated at any time via `exportToMarkdown`.

## 8. File Size Estimate

- Volume of 50k words → ~280KB
- 5 volumes → ~1.4MB
- 100 codex entries at ~500 words each → ~500KB
- Indexes + mention table → ~200KB
- **Total: ~2–3 MB per project**

SQLite handles files of this size with sub-millisecond reads.

---

## To-Do List

### Phase 1: Core Engine
- [x] 1. Create `src/storage/schema.js` — DDL strings + migration function
- [x] 2. Create `src/storage/projectDb.js` — abstract SQLite wrapper with all CRUD operations
- [x] 3. Create `src/storage/mentionIndexer.js` — pre-compute codex mentions
- [x] 4. Create `src/storage/markdownBridge.js` — bidirectional conversion (`.novel` ↔ markdown)
- [x] 5. Write unit tests for core engine (load schema, CRUD volumes/chapters/scenes/paragraphs)

### Phase 2: Server Integration
- [x] 6. Install `better-sqlite3` in `package.json`
- [x] 7. Create `server/projectServer.js` — native SQLite adapter
- [x] 8. Modify `server/index.js` — add `.novel` API endpoints
- [x] 9. Add markdown export/import to existing volume endpoints (dual-source mode)
- [x] 10. Test: run server, verify read/write cycles produce correct `.novel` files

### Phase 3: Browser Integration
- [x] 11. Install `sql.js` in `package.json`
- [x] 12. Create `src/browserDb.js` — browser adapter with File System Access API
- [x] 13. Modify `src/localDatasource.js` — add `.novel` handle storage alongside markdown compatibility
- [x] 14. Modify `src/main.jsx` — add project file state, integrate `browserDb`
- [x] 15. Update UI: add "Open Project", "Save Project", "Export to Markdown" buttons

### Phase 4: Mention Index & Search
- [x] 16. Integrate mention indexer into browser save flow
- [x] 17. Integrate mention indexer into server save flow
- [x] 18. Persist occurrence-level indexed lookups; retain runtime matching only for unsaved inline editor decorations
- [x] 19. Add full-text search UI (search bar across scenes + codex)

### Phase 5: Polish & Migration
- [x] 20. Add migration tool: scan existing `datasource/` and generate initial `.novel`
- [x] 21. Add standalone CLI script: `node tools/migrate-to-novel.js`
- [x] 22. Update AGENTS.md with new architecture notes
- [ ] 23. Test the UI manually in Chromium (browser adapter and server workflows are covered by automated tests)
- [x] 24. Verify `npm run build` succeeds
