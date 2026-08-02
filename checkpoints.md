# Checkpoints

## 2026-07-27 — Codex mention features (chapter detail sidebar, morph panel, paragraph anchors)

Base commit: `da00a4a` "Update novel reader" (session feature work: Chapters Mentioned chips, chapter detail sidebar with highlighted paragraphs, "Go to surrounding" paragraph navigation, connected morph animation, compiled `#### Chapters Mentioned` / `#### Codex Mentioned` in `codex.md`).

Final commit: `379aa0e` — pushed to `origin/main`.

```
commit 379aa0e3ac8fffda9448d994f5e390ddee11e477
Author: Rosyd Aqbar <idaqbar@gmail.com>
Date:   Mon Jul 27 23:46:01 2026 +0700

    Exclude self-reference from codex mentions
```

```diff
diff --git a/src/main.jsx b/src/main.jsx
index b3ce4e3..f872f6a 100644
--- a/src/main.jsx
+++ b/src/main.jsx
@@ -1918,6 +1918,7 @@ function getCodexEntryMentionEntries(entry, mentionIndex) {
   const text = entry.body || '';
   for (const match of findMentionMatches(text, mentionIndex)) {
     for (const item of match.mention.matches) {
+      if (item.entry.category === entry.category && item.entry.id === entry.id) continue;
       byKey.set(`${item.entry.category}:${item.entry.id}`, item.entry);
     }
   }
```

State at this checkpoint:
- Codex entry view shows "Codex Mentioned" (excludes self) and "Chapters Mentioned" chips.
- Clicking a chapter chip opens a detail sidebar morphed from the section, capped at the codex editor's bottom edge, with per-paragraph highlights.
- Each excerpt is hoverable/clickable ("Go to surrounding" tooltip) and navigates to the exact scene paragraph in the novel view with a temporary highlight.
- `npm run build` passes.

## 2026-08-03 — Binary `.novel` project storage and markdown migration

Base commit: `379aa0e` "Exclude self-reference from codex mentions".

Implementation commit: `4000986` "Add binary novel project storage".

State at this checkpoint:
- Schema-v1 SQLite `.novel` files are the primary browser and server project format.
- Shared storage under `src/storage/` provides durable volume/chapter/scene IDs, codex CRUD, category-safe IDs, ordered aliases/tags, occurrence-level mention indexes, search, and Markdown import/export.
- The browser uses SQL.js with local `.novel` file pickers, project-scoped recovery drafts, recent-handle restoration, external-change detection, serialized saves, and cross-tab Web Locks.
- `Import Markdown` reads legacy `volumes/`, `acts/`, root `novel.md`, codex entry folders, and compiled `codex.md` recovery without changing the source folder.
- Browser and CLI migration defer mention indexing during bulk inserts, then rebuild once per volume to avoid quadratic WASM memory use.
- The Express server defaults to project mode, retains `NOVEL_STORAGE_MODE=markdown`, and supports validated staged binary import/export with rollback.
- `npm run migrate:novel` converts the repo-local Markdown datasource non-destructively.
- `npm test` passes 29 tests across `better-sqlite3`, SQL.js, browser file workflows, server APIs, migration, mention indexing, and search.
- `npm run build` passes and emits the SQL.js WASM asset; the existing large-chunk warning remains.
