# Novel Reader Editor

A browser-based editor for managing a novel manuscript and its codex in one local `.novel` SQLite project file. The app can be deployed publicly while manuscript data stays on each user's computer.

## What It Does

- Edits novel volume files as structured chapters and scenes.
- Edits codex entries for characters, locations, and lore.
- Detects codex mentions inside novel chapters.
- Shows mentioned codex entries in the chapter view.
- Searches manuscript scenes and codex entries.
- Exports volumes to Markdown when needed.
- Saves recovery drafts locally before writing the complete project file.

## Local Project Workflow

The app uses the browser File System Access API.

- User opens the public website.
- User chooses `Open project` or `Create project`.
- Browser asks for permission to access one local `.novel` file.
- The SQLite project is loaded through SQL.js and written directly back to that file.
- No manuscript or codex data is uploaded to the app host.

Supported browsers:

- Chrome
- Edge
- Brave

Firefox and Safari are blocked because they do not support the required writable local file workflow.

## Novel

Novel content is organized by volume, chapter, scene, and paragraph inside the project database. Markdown import/export uses the same heading structure as earlier versions.

Supported structure:

```md
## Novel Title

### Chapter 1: Chapter Title

#### Scene 1

Scene text...
```

Novel features:

- Switch between volumes.
- Add new volumes.
- Add, edit, and delete chapters.
- Add, edit, collapse, and delete scenes.
- Save changes locally first.
- Save all project data to one `.novel` file.
- Export the active volume to Markdown.
- Automatically generate `Codex Mentioned` sections for detected entries.

## Codex

Codex content is organized by category inside the project database.

Codex categories:

- `characters`: people and character-like entities.
- `locations`: places, regions, buildings, and realms.
- `lore`: history, magic, culture, concepts, and world rules.

Codex features:

- Add, edit, and delete entries.
- Edit aliases, tags, summaries, and body text.
- Search and filter by tags or aliases.
- Highlight mentions in novel text.
- Show hover cards for matched codex terms.
- Persist aliases, tags, flags, fields, bodies, and mention occurrences in the project.

## Markdown Migration

In the browser, choose `Import Markdown`, select the legacy datasource folder, review the imported project, then choose `Save project` to create the converted `.novel` file. The source folder is read-only and remains unchanged.

The repo-local server uses `datasource/project.novel` by default. Convert an existing markdown datasource without modifying its source files:

```sh
npm run migrate:novel
```

Custom paths and replacement are supported:

```sh
npm run migrate:novel -- --source path/to/datasource --output path/to/project.novel --force
```

Set `NOVEL_STORAGE_MODE=markdown` when running the server to use the legacy repo-backed markdown endpoints instead of `project.novel`.

## Development

Node.js 22 or newer is required for the native server SQLite adapter.

Install dependencies:

```sh
npm install
```

Run the app locally:

```sh
npm run dev
```

Build the frontend:

```sh
npm run build
```

Run the test suite:

```sh
npm test
```

Run the production server after building:

```sh
npm run preview
```

## Notes

- The server runs on `127.0.0.1:3001` by default during local development.
- Public deployment can serve the built frontend as a static site.
- Browser local storage is used for unsaved, project-scoped recovery drafts.
- Markdown is an import/export compatibility format, not the primary project source.
- `codex.md` remains generated output in legacy markdown mode.
