# Novel Reader Editor

A local web editor for managing a novel manuscript and its codex. The app runs on your machine, reads markdown files from `datasource/`, and provides a browser UI for editing chapters, scenes, and worldbuilding entries.

## What It Does

- Edits novel act files as structured chapters and scenes.
- Edits codex entries for characters, locations, and lore.
- Detects codex mentions inside novel chapters.
- Shows mentioned codex entries in the chapter view.
- Compiles individual codex entries into one `codex.md` file.
- Saves drafts locally in the browser before writing back to disk.

## Novel

Novel content is organized by act.

Expected local structure:

```txt
datasource/
  acts/
    act1.md
    act2.md
```

Each act file contains chapters and scenes. The editor parses markdown headings into editable sections.

Supported structure:

```md
## Novel Title

### Chapter 1: Chapter Title

#### Scene 1

Scene text...
```

Novel features:

- Switch between acts.
- Add new acts.
- Add, edit, and delete chapters.
- Add, edit, collapse, and delete scenes.
- Save changes locally first.
- Update the active act file when ready.
- Automatically generate `Codex Mentioned` sections for detected entries.

## Codex

Codex content is organized by category.

Expected local structure:

```txt
datasource/
  codex/
    characters/
    locations/
    lore/
```

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
- Compile all entries into `datasource/codex.md`.

## Local Data

The `datasource/` folder contains private manuscript and codex data. It is intentionally ignored by Git.

Use your own local files under `datasource/` when running the editor.

## Development

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

Run the production server after building:

```sh
npm run preview
```

## Notes

- The server runs on `127.0.0.1:3001` by default.
- The Vite client runs separately during development.
- Browser local storage is used for unsaved drafts.
- `datasource/codex.md` is generated output, not the primary codex source.
