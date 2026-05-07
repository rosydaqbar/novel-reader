# Novel Reader Editor

A browser-based editor for managing a novel manuscript and its codex. The app can be deployed publicly while manuscript data stays in a folder selected by each user on their own computer.

## What It Does

- Edits novel volume files as structured chapters and scenes.
- Edits codex entries for characters, locations, and lore.
- Detects codex mentions inside novel chapters.
- Shows mentioned codex entries in the chapter view.
- Compiles individual codex entries into one `codex.md` file.
- Saves drafts locally in the browser before writing back to the selected folder.

## Local Folder Workflow

The app uses the browser File System Access API.

- User opens the public website.
- User chooses `Open local datasource` or `Create new Novel`.
- Browser asks for permission to access a local folder.
- Markdown files are read and written directly in that folder.
- No manuscript or codex data is uploaded to the app host.

Supported browsers:

- Chrome
- Edge
- Brave

Firefox and Safari are blocked because they do not support the required writable local folder workflow.

## Novel

Novel content is organized by volume.

Expected selected folder structure:

```txt
volumes/
  volume1.md
  volume2.md
```

Each volume file contains chapters and scenes. The editor parses markdown headings into editable sections.

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
- Update the active volume file when ready.
- Automatically generate `Codex Mentioned` sections for detected entries.

## Codex

Codex content is organized by category.

Expected selected folder structure:

```txt
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
- Compile all entries into `codex.md` in the selected folder.

## Local Data

The local datasource folder contains private manuscript and codex data. It is intentionally ignored by Git.

Use your own local folder when running the editor. In public deployments, each user selects their own folder and maintains their own markdown files.

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

- The server runs on `127.0.0.1:3001` by default during local development.
- Public deployment can serve the built frontend as a static site.
- Browser local storage is used for unsaved drafts.
- `codex.md` is generated output, not the primary codex source.
