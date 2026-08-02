# Agent Notes

## Read This First
At the start of every session, read this entire file before doing anything else.

## Interpret Before Editing
Before making any changes, interpret what the user means. Do not proceed until you understand. Get confirmation before editing.

## Commands
- Install deps with `npm install`.
- Run local development with `npm run dev`; this starts both `node server/index.js` on `127.0.0.1:3001` and Vite on `127.0.0.1:5173`.
- Build with `npm run build`.
- Run the Node test suite with `npm test`.
- Migrate the repo-local markdown datasource with `npm run migrate:novel`; pass CLI options after `--`, such as `-- --source path --output path/project.novel --force`.
- Run the built app/server with `npm run preview`; it is `node server/index.js`, not Vite preview.
- There are no configured lint or typecheck scripts; use `npm test` and `npm run build` as the verification steps.

## App Boundaries
- Browser entrypoint is `src/main.jsx`; it contains most UI state and uses TipTap/ProseMirror for editor behavior.
- The primary browser workflow opens one `.novel` SQLite file through `src/browserDb.js`, backed by `sql.js` and the File System Access API. Test this path in Chromium browsers only.
- Browser markdown migration selects a legacy datasource folder read-only, converts it to an in-memory project through `importMarkdownDatasource`, and requires a separate `Save project` click to create the `.novel` file.
- Shared storage logic lives in `src/storage/`: `projectDb.js` owns CRUD, `schema.js` owns schema v1, `mentionIndexer.js` owns persisted occurrence indexes, and `markdownBridge.js` owns import/export compatibility.
- `src/localDatasource.js` retains the legacy markdown-folder adapter and IndexedDB handle storage. Do not remove it while markdown migration and compatibility are supported.
- `server/index.js` exposes `/api/*` endpoints and serves `dist/` when present. Project mode is the default and uses `server/projectServer.js` with `datasource/project.novel`; set `NOVEL_STORAGE_MODE=markdown` for the legacy repo-backed workflow.
- Vite proxies `/api` to `http://127.0.0.1:3001`; do not change client API calls to a hardcoded host unless the dev/prod serving model changes.
- The browser opens local project files directly and does not upload them to the Express server. The Express project API is for the repo-local server workflow and for serving the built app.
- `src/main.jsx` is intentionally broad: app shell, novel editor, codex editor, markdown-to-TipTap conversion, local draft handling, and mention hover behavior are all in this file. Prefer small, targeted edits unless first extracting a clearly isolated helper.

## Data Formats
- The authoritative format is schema-v1 SQLite in a `.novel` file. Markdown under `volumes/volumeN.md`, legacy `acts/actN.md`, and root `novel.md` remains supported for explicit migration/backward compatibility.
- Novel parsing expects `### Chapter N: Title` and `#### Scene ...` headings. `#### Codex Mentioned` sections are generated/overwritten from codex matches, not primary user-authored content.
- Codex source entries are directories under `codex/characters`, `codex/locations`, and `codex/lore`, each with an `entry.md` frontmatter file.
- `codex.md` is generated compiled output from codex entries; do not treat it as the source of truth unless using the explicit recovery path in `src/localDatasource.js`.
- New project import/export behavior must use `src/storage/markdownBridge.js`. Legacy parse/serialize logic still exists in `server/markdown.js` and `src/localDatasource.js`; keep all three paths in sync when changing headings, word counts, generated `Codex Mentioned` output, or mention matching.
- `compileCodex` in both `src/localDatasource.js` and `server/codex.js` now generates `#### Codex Mentioned` per entry (other entries mentioned in the body). Keep this logic in sync too — `containsTerm` and `hasMentionBoundary` are exported from `server/markdown.js`.
- Codex frontmatter is parsed by a small custom parser, not a YAML library. It supports simple scalars, `[]`, `{}`, and indented array items; preserve that limited format unless deliberately adding a real parser.
- Codex mention detection is case-sensitive and uses word-like boundary checks. It matches entry names and aliases, sorts longer terms first in the UI, and avoids overlapping inline highlights.

## Design System
Before writing any UI code, read `src/styles.css` and `src/main.jsx` first. Reuse existing patterns. Do not create new UI styles or components.

## Browser State
- The selected project file handle is stored in IndexedDB under `novel-reader-editor` with key `recentProject`; the legacy folder handle remains under `recentDatasource`. Browser permission may need to be requested again before reuse.
- Unsaved novel and codex edits are stored in project-scoped `localStorage` draft keys before the complete SQL.js database is written to disk. When debugging stale content, check browser drafts before assuming the `.novel` file changed.
- UI state such as active menu, selected volume/chapter, and selected codex entry is also stored in `localStorage`.

## Privacy / Repo Hygiene
- Do not commit private local data or agent skills. `.gitignore` intentionally excludes `datasource/`, `.agents/`, `.opencode/skills/`, and `skills-lock.json`.
- If removing ignored local-only files from Git, use `git rm --cached` so the user's local copy is preserved.
