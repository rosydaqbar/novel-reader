import { createSqliteAdapter } from './sqliteAdapters.js';
import { CODEX_CATEGORIES, TYPE_BY_CATEGORY, createUuid, initializeSchema } from './schema.js';
import { indexMentionsForScenes, rebuildMentionIndex as rebuildStoredMentions } from './mentionIndexer.js';
import {
  countWords,
  flattenCodexEntries,
  parseCodexEntry,
  parseNovel,
  serializeCodexEntry,
  serializeNovel,
  withNovelStats
} from './markdownBridge.js';

function now() {
  return new Date().toISOString();
}

function booleanInteger(value) {
  return value ? 1 : 0;
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

function parseFields(value) {
  try {
    const fields = JSON.parse(value || '{}');
    return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  } catch {
    return {};
  }
}

function normalizeFields(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function decodeHeader(rawHeader) {
  try {
    const header = JSON.parse(rawHeader);
    if (Array.isArray(header)) return header.map((line) => String(line));
  } catch {}
  return rawHeader ? String(rawHeader).split('\n') : [];
}

function volumeMeta(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    label: `Volume ${row.number}`,
    filename: `volume${row.number}.md`,
    path: `volumes/volume${row.number}.md`,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'new-entry';
}

function assertCategory(category) {
  if (!CODEX_CATEGORIES.includes(category)) throw new Error('Invalid codex category.');
}

function assertSafeLegacyId(id) {
  if (!id || String(id).includes('..') || String(id).includes('/') || String(id).includes('\\')) {
    throw new Error('Invalid codex entry id.');
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(Number(value)) || Number(value) < 1) throw new Error(`${label} must be a positive integer.`);
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function ftsQuery(value) {
  return String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ');
}

function likeQuery(value) {
  return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function makeSnippet(content, query, radius = 60) {
  const source = String(content ?? '');
  const index = source.toLocaleLowerCase().indexOf(String(query).toLocaleLowerCase());
  if (index < 0) return source.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + String(query).length + radius);
  return `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`;
}

function sceneSearchResult(row, snippet = row.snippet) {
  return {
    volumeId: row.volume_id,
    volumeNumber: Number(row.volume_number),
    chapterId: row.chapter_id,
    chapterNumber: Number(row.chapter_number),
    chapterTitle: row.chapter_title,
    sceneId: row.scene_id,
    heading: row.heading,
    snippet
  };
}

export class ProjectDb {
  constructor(database) {
    const initialized = initializeSchema(createSqliteAdapter(database));
    this.adapter = initialized.adapter;
    this.ftsAvailable = initialized.ftsAvailable;
  }

  close() {
    this.adapter.close();
  }

  getProjectMeta() {
    const row = this.adapter.get('SELECT * FROM project WHERE singleton_id = 1');
    return {
      id: row.project_uuid,
      projectUuid: row.project_uuid,
      title: row.title,
      author: row.author,
      description: row.description,
      schemaVersion: Number(row.schema_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  updateProjectMeta(patch = {}) {
    const current = this.getProjectMeta();
    this.adapter.run(
      `UPDATE project SET title = ?, author = ?, description = ?, updated_at = ? WHERE singleton_id = 1`,
      [
        patch.title == null ? current.title : String(patch.title),
        patch.author == null ? current.author : String(patch.author),
        patch.description == null ? current.description : String(patch.description),
        now()
      ]
    );
    return this.getProjectMeta();
  }

  listVolumes() {
    return this.adapter.all('SELECT * FROM volumes ORDER BY sort_order, number').map(volumeMeta);
  }

  createVolume({ number, title = '' } = {}) {
    const nextNumber = number == null
      ? Number(this.adapter.get('SELECT COALESCE(MAX(number), 0) + 1 AS number FROM volumes').number)
      : Number(number);
    assertPositiveInteger(nextNumber, 'Volume number');
    const id = `volume${nextNumber}`;
    const sortOrder = Number(this.adapter.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM volumes').value);
    const timestamp = now();
    this.adapter.run(
      `INSERT INTO volumes (id, number, title, raw_header, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, nextNumber, String(title), JSON.stringify([`## ${title || 'Untitled Novel'}`, '']), sortOrder, timestamp, timestamp]
    );
    return this.getVolume(id);
  }

  deleteVolume(id) {
    this._requireVolume(id);
    return this.adapter.transaction(() => {
      const sceneIds = this.adapter.all(
        `SELECT s.id FROM scenes s JOIN chapters c ON c.id = s.chapter_id WHERE c.volume_id = ?`,
        [id]
      ).map((row) => row.id);
      this._removeScenesFromFts(sceneIds);
      return this.adapter.run('DELETE FROM volumes WHERE id = ?', [id]).changes > 0;
    });
  }

  getVolume(id) {
    return volumeMeta(this.adapter.get('SELECT * FROM volumes WHERE id = ?', [id]));
  }

  listChapters(volumeId) {
    this._requireVolume(volumeId);
    const chapters = this.adapter.all('SELECT * FROM chapters WHERE volume_id = ? ORDER BY sort_order', [volumeId]);
    const wordCounts = new Map();
    for (const row of this.adapter.all(
      `SELECT s.chapter_id, p.content FROM scenes s
       JOIN scene_paragraphs p ON p.scene_id = s.id
       JOIN chapters c ON c.id = s.chapter_id
       WHERE c.volume_id = ?`,
      [volumeId]
    )) {
      wordCounts.set(row.chapter_id, (wordCounts.get(row.chapter_id) ?? 0) + countWords(row.content));
    }
    return chapters.map((row) => this._chapterDto(row, wordCounts.get(row.id) ?? 0));
  }

  createChapter({ volumeId, chapterNumber, title = '', id } = {}) {
    this._requireVolume(volumeId);
    const nextNumber = chapterNumber == null
      ? Number(this.adapter.get('SELECT COALESCE(MAX(chapter_number), 0) + 1 AS value FROM chapters WHERE volume_id = ?', [volumeId]).value)
      : Number(chapterNumber);
    assertPositiveInteger(nextNumber, 'Chapter number');
    const chapterId = id || `chapter-${createUuid()}`;
    const sortOrder = Number(this.adapter.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM chapters WHERE volume_id = ?', [volumeId]).value);
    const timestamp = now();
    this.adapter.run(
      `INSERT INTO chapters (id, volume_id, chapter_number, title, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chapterId, volumeId, nextNumber, String(title), sortOrder, timestamp, timestamp]
    );
    return this.listChapters(volumeId).find((chapter) => chapter.id === chapterId);
  }

  updateChapter(id, patch = {}) {
    const row = this._requireChapter(id);
    const chapterNumber = patch.chapterNumber == null ? Number(row.chapter_number) : Number(patch.chapterNumber);
    assertPositiveInteger(chapterNumber, 'Chapter number');
    this.adapter.run(
      'UPDATE chapters SET chapter_number = ?, title = ?, updated_at = ? WHERE id = ?',
      [chapterNumber, patch.title == null ? row.title : String(patch.title), now(), id]
    );
    return this.listChapters(row.volume_id).find((chapter) => chapter.id === id);
  }

  deleteChapter(id) {
    const chapter = this._requireChapter(id);
    return this.adapter.transaction(() => {
      const sceneIds = this.adapter.all('SELECT id FROM scenes WHERE chapter_id = ?', [id]).map((row) => row.id);
      this._removeScenesFromFts(sceneIds);
      this.adapter.run('DELETE FROM chapters WHERE id = ?', [id]);
      return true;
    });
  }

  reorderChapters(volumeId, orderedIds) {
    this._requireVolume(volumeId);
    const existing = this.adapter.all('SELECT id FROM chapters WHERE volume_id = ? ORDER BY sort_order', [volumeId]).map((row) => row.id);
    const ordered = [...orderedIds];
    if (new Set(ordered).size !== ordered.length || !sameSet(existing, ordered)) {
      throw new Error('Chapter order must contain every chapter in the volume exactly once.');
    }
    this.adapter.transaction(() => {
      ordered.forEach((id, index) => this.adapter.run('UPDATE chapters SET sort_order = ?, updated_at = ? WHERE id = ?', [index, now(), id]));
    });
    return this.listChapters(volumeId);
  }

  listScenes(chapterId) {
    this._requireChapter(chapterId);
    const rows = this.adapter.all('SELECT * FROM scenes WHERE chapter_id = ? ORDER BY sort_order', [chapterId]);
    const counts = new Map();
    for (const paragraph of this.adapter.all(
      `SELECT p.scene_id, p.content FROM scene_paragraphs p
       JOIN scenes s ON s.id = p.scene_id WHERE s.chapter_id = ?`,
      [chapterId]
    )) {
      counts.set(paragraph.scene_id, (counts.get(paragraph.scene_id) ?? 0) + countWords(paragraph.content));
    }
    return rows.map((row) => this._sceneDto(row, counts.get(row.id) ?? 0));
  }

  createScene({ chapterId, heading = 'Scene 1', id } = {}) {
    this._requireChapter(chapterId);
    const sceneId = id || `scene-${createUuid()}`;
    const sortOrder = Number(this.adapter.get('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM scenes WHERE chapter_id = ?', [chapterId]).value);
    const timestamp = now();
    return this.adapter.transaction(() => {
      this.adapter.run(
        `INSERT INTO scenes (id, chapter_id, heading, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sceneId, chapterId, String(heading || 'Scene 1'), sortOrder, timestamp, timestamp]
      );
      this._syncSceneSearch(sceneId);
      return this.listScenes(chapterId).find((scene) => scene.id === sceneId);
    });
  }

  updateScene(id, patch = {}) {
    const scene = this._requireScene(id);
    return this.adapter.transaction(() => {
      this.adapter.run(
        'UPDATE scenes SET heading = ?, updated_at = ? WHERE id = ?',
        [patch.heading == null ? scene.heading : String(patch.heading || 'Scene 1'), now(), id]
      );
      this._syncSceneSearch(id);
      return this.listScenes(scene.chapter_id).find((candidate) => candidate.id === id);
    });
  }

  deleteScene(id) {
    this._requireScene(id);
    return this.adapter.transaction(() => {
      this._removeScenesFromFts([id]);
      this.adapter.run('DELETE FROM scenes WHERE id = ?', [id]);
      return true;
    });
  }

  reorderScenes(chapterId, orderedIds) {
    this._requireChapter(chapterId);
    const existing = this.adapter.all('SELECT id FROM scenes WHERE chapter_id = ? ORDER BY sort_order', [chapterId]).map((row) => row.id);
    const ordered = [...orderedIds];
    if (new Set(ordered).size !== ordered.length || !sameSet(existing, ordered)) {
      throw new Error('Scene order must contain every scene in the chapter exactly once.');
    }
    this.adapter.transaction(() => {
      ordered.forEach((id, index) => this.adapter.run('UPDATE scenes SET sort_order = ?, updated_at = ? WHERE id = ?', [index, now(), id]));
    });
    return this.listScenes(chapterId);
  }

  setParagraphs(sceneId, paragraphs) {
    this._requireScene(sceneId);
    return this.adapter.transaction(() => {
      this._setParagraphRows(sceneId, paragraphs);
      this.adapter.run('UPDATE scenes SET updated_at = ? WHERE id = ?', [now(), sceneId]);
      this._syncSceneSearch(sceneId);
      indexMentionsForScenes(this.adapter, [sceneId]);
      return this.getParagraphs(sceneId);
    });
  }

  getParagraphs(sceneId) {
    this._requireScene(sceneId);
    return this.adapter.all('SELECT content FROM scene_paragraphs WHERE scene_id = ? ORDER BY sort_order', [sceneId]).map((row) => row.content);
  }

  getNovel(volumeId) {
    const volume = this._requireVolume(volumeId);
    const chapters = this.adapter.all('SELECT * FROM chapters WHERE volume_id = ? ORDER BY sort_order', [volumeId]).map((chapter) => ({
      id: chapter.id,
      chapterNumber: Number(chapter.chapter_number),
      title: chapter.title,
      scenes: this.adapter.all('SELECT * FROM scenes WHERE chapter_id = ? ORDER BY sort_order', [chapter.id]).map((scene) => ({
        id: scene.id,
        heading: scene.heading,
        paragraphs: this.adapter.all('SELECT content FROM scene_paragraphs WHERE scene_id = ? ORDER BY sort_order', [scene.id]).map((row) => row.content)
      }))
    }));
    return withNovelStats({ header: decodeHeader(volume.raw_header), title: volume.title, chapters });
  }

  putNovel(volumeId, novel, options = {}) {
    const volume = this._requireVolume(volumeId);
    return this.adapter.transaction(() => {
      const timestamp = now();
      this.adapter.run(
        'UPDATE volumes SET title = ?, raw_header = ?, updated_at = ? WHERE id = ?',
        [String(novel.title ?? volume.title), JSON.stringify((novel.header ?? []).map(String)), timestamp, volumeId]
      );

      const existingChapters = this.adapter.all('SELECT * FROM chapters WHERE volume_id = ? ORDER BY sort_order', [volumeId]);
      const existingById = new Map(existingChapters.map((row) => [row.id, row]));
      const keptChapterIds = new Set();
      const inputChapterIds = (novel.chapters ?? []).map((chapter) => chapter.id).filter(Boolean);
      if (new Set(inputChapterIds).size !== inputChapterIds.length) throw new Error('Chapter IDs must be unique.');

      for (let chapterIndex = 0; chapterIndex < (novel.chapters ?? []).length; chapterIndex += 1) {
        const input = novel.chapters[chapterIndex];
        let chapter = input.id ? existingById.get(input.id) : null;
        if (!chapter && !input.id) chapter = existingChapters[chapterIndex];
        let chapterId = chapter && !keptChapterIds.has(chapter.id) ? chapter.id : input.id;
        if (!chapterId) chapterId = `chapter-${createUuid()}`;
        if (!chapter || chapter.id !== chapterId) this._assertUnusedId('chapters', chapterId);
        keptChapterIds.add(chapterId);
        const chapterNumber = Number(input.chapterNumber ?? chapterIndex + 1);
        assertPositiveInteger(chapterNumber, 'Chapter number');

        if (chapter?.id === chapterId) {
          this.adapter.run(
            'UPDATE chapters SET chapter_number = ?, title = ?, sort_order = ?, updated_at = ? WHERE id = ?',
            [chapterNumber, String(input.title ?? ''), chapterIndex, timestamp, chapterId]
          );
        } else {
          this.adapter.run(
            `INSERT INTO chapters (id, volume_id, chapter_number, title, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [chapterId, volumeId, chapterNumber, String(input.title ?? ''), chapterIndex, timestamp, timestamp]
          );
        }
        this._putChapterScenes(chapterId, input.scenes ?? [], timestamp);
      }

      const removedChapters = existingChapters.filter((row) => !keptChapterIds.has(row.id));
      for (const chapter of removedChapters) {
        const sceneIds = this.adapter.all('SELECT id FROM scenes WHERE chapter_id = ?', [chapter.id]).map((row) => row.id);
        this._removeScenesFromFts(sceneIds);
        this.adapter.run('DELETE FROM chapters WHERE id = ?', [chapter.id]);
      }

      if (options.reindexMentions !== false) {
        const sceneIds = this.adapter.all(
          `SELECT s.id FROM scenes s JOIN chapters c ON c.id = s.chapter_id WHERE c.volume_id = ?`,
          [volumeId]
        ).map((row) => row.id);
        indexMentionsForScenes(this.adapter, sceneIds);
      }
    });
  }

  listCodex(category) {
    if (category != null) assertCategory(category);
    const groups = { characters: [], locations: [], lore: [] };
    const rows = category == null
      ? this.adapter.all('SELECT * FROM codex_entries ORDER BY category_id, name, legacy_id')
      : this.adapter.all('SELECT * FROM codex_entries WHERE category_id = ? ORDER BY name, legacy_id', [category]);
    const aliases = this._orderedValues('codex_aliases', 'alias');
    const tags = this._orderedValues('codex_tags', 'tag');
    for (const row of rows) groups[row.category_id].push(this._codexDto(row, aliases.get(row.internal_id), tags.get(row.internal_id)));
    return groups;
  }

  getCodexEntry(categoryOrId, id) {
    const internalId = this._resolveCodexInternalId(categoryOrId, id, false);
    if (!internalId) return null;
    const row = this.adapter.get('SELECT * FROM codex_entries WHERE internal_id = ?', [internalId]);
    return this._codexDto(row, this._valuesForEntry('codex_aliases', 'alias', internalId), this._valuesForEntry('codex_tags', 'tag', internalId));
  }

  createCodexEntry(input = {}, options = {}) {
    assertCategory(input.category);
    const legacyId = input.id || `${slugify(input.name || 'new-entry')}-${createUuid().replaceAll('-', '').slice(0, 12)}`;
    assertSafeLegacyId(legacyId);
    const internalId = input.internalId || `codex-${createUuid()}`;
    const timestamp = now();
    const body = String(input.body ?? 'New codex entry.');
    return this.adapter.transaction(() => {
      this.adapter.run(
        `INSERT INTO codex_entries
          (internal_id, category_id, legacy_id, type, name, color, body, fields_json,
           always_include_in_context, do_not_track, no_auto_include, word_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          internalId,
          input.category,
          legacyId,
          input.type || TYPE_BY_CATEGORY[input.category],
          String(input.name || 'New Entry'),
          input.color ?? null,
          body,
          JSON.stringify(normalizeFields(input.fields)),
          booleanInteger(input.alwaysIncludeInContext),
          booleanInteger(input.doNotTrack),
          booleanInteger(input.noAutoInclude),
          countWords(body),
          timestamp,
          timestamp
        ]
      );
      this._replaceOrderedValues('codex_aliases', 'alias', internalId, input.aliases);
      this._replaceOrderedValues('codex_tags', 'tag', internalId, input.tags);
      this._syncCodexSearch(internalId);
      if (options.reindexMentions !== false) this._reindexAllScenes();
      return this.getCodexEntry(internalId);
    });
  }

  updateCodexEntry(categoryOrId, idOrPatch, possiblePatch, options = {}) {
    const hasCategory = possiblePatch !== undefined;
    const internalId = hasCategory
      ? this._resolveCodexInternalId(categoryOrId, idOrPatch, true)
      : this._resolveCodexInternalId(categoryOrId, undefined, true);
    const patch = hasCategory ? possiblePatch : idOrPatch;
    const current = this.getCodexEntry(internalId);
    const aliases = patch.aliases == null ? current.aliases : uniqueOrdered(patch.aliases);
    const tags = patch.tags == null ? current.tags : uniqueOrdered(patch.tags);
    const body = patch.body == null ? current.body : String(patch.body);

    return this.adapter.transaction(() => {
      this.adapter.run(
        `UPDATE codex_entries SET type = ?, name = ?, color = ?, body = ?, fields_json = ?,
          always_include_in_context = ?, do_not_track = ?, no_auto_include = ?, word_count = ?, updated_at = ?
         WHERE internal_id = ?`,
        [
          patch.type == null ? current.type : String(patch.type),
          patch.name == null ? current.name : String(patch.name),
          patch.color === undefined ? current.color : patch.color,
          body,
          JSON.stringify(patch.fields == null ? current.fields : normalizeFields(patch.fields)),
          booleanInteger(patch.alwaysIncludeInContext == null ? current.alwaysIncludeInContext : patch.alwaysIncludeInContext),
          booleanInteger(patch.doNotTrack == null ? current.doNotTrack : patch.doNotTrack),
          booleanInteger(patch.noAutoInclude == null ? current.noAutoInclude : patch.noAutoInclude),
          countWords(body),
          now(),
          internalId
        ]
      );
      this._replaceOrderedValues('codex_aliases', 'alias', internalId, aliases);
      this._replaceOrderedValues('codex_tags', 'tag', internalId, tags);
      this._syncCodexSearch(internalId);
      if (options.reindexMentions !== false && (patch.name !== undefined || patch.aliases !== undefined)) this._reindexAllScenes();
      return this.getCodexEntry(internalId);
    });
  }

  deleteCodexEntry(categoryOrId, id) {
    const internalId = this._resolveCodexInternalId(categoryOrId, id, true);
    return this.adapter.transaction(() => {
      this._removeCodexFromFts(internalId);
      this.adapter.run('DELETE FROM codex_entries WHERE internal_id = ?', [internalId]);
      this._reindexAllScenes();
      return true;
    });
  }

  rebuildMentionIndex(volumeId) {
    if (volumeId != null) this._requireVolume(volumeId);
    return rebuildStoredMentions(this.adapter, volumeId ?? null);
  }

  getMentionsForScene(sceneId, options = {}) {
    this._requireScene(sceneId);
    const rows = this.adapter.all(
      `SELECT m.*, e.legacy_id, e.category_id, e.name, e.type, p.content AS paragraph_content
       FROM codex_mentions m
       JOIN codex_entries e ON e.internal_id = m.entry_internal_id
       JOIN scene_paragraphs p ON p.id = m.paragraph_id
       WHERE m.scene_id = ?
       ORDER BY m.paragraph_index, m.start_offset, (m.end_offset - m.start_offset) DESC, e.name`,
      [sceneId]
    );
    if (options.coarse) {
      const grouped = new Map();
      for (const row of rows) {
        const item = grouped.get(row.entry_internal_id) ?? {
          entryId: row.legacy_id,
          entryInternalId: row.entry_internal_id,
          category: row.category_id,
          name: row.name,
          type: row.type,
          occurrenceCount: 0
        };
        item.occurrenceCount += 1;
        grouped.set(row.entry_internal_id, item);
      }
      return [...grouped.values()];
    }
    return rows.map((row) => {
      const contextText = String(row.paragraph_content ?? '').slice(
        Math.max(0, Number(row.start_offset) - 60),
        Math.min(String(row.paragraph_content ?? '').length, Number(row.end_offset) + 60)
      );
      return {
      id: Number(row.id),
      entryId: row.legacy_id,
      entryInternalId: row.entry_internal_id,
      category: row.category_id,
      name: row.name,
      type: row.type,
      sceneId: row.scene_id,
      paragraphId: row.paragraph_id,
      paragraphIndex: Number(row.paragraph_index),
      term: row.term,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
        context: contextText,
        contextText
      };
    });
  }

  searchScenes(query) {
    const normalized = String(query ?? '').trim();
    if (!normalized) return [];
    if (this.ftsAvailable) {
      try {
        return this.adapter.all(
          `SELECT s.id AS scene_id, s.chapter_id, c.volume_id, c.chapter_number,
             v.number AS volume_number, c.title AS chapter_title, s.heading,
              snippet(scenes_fts, 1, '', '', '...', 20) AS snippet
           FROM scenes_fts
           JOIN scenes s ON s.id = scenes_fts.scene_id
           JOIN chapters c ON c.id = s.chapter_id
           JOIN volumes v ON v.id = c.volume_id
           WHERE scenes_fts MATCH ?
           ORDER BY rank, c.sort_order, s.sort_order`,
          [ftsQuery(normalized)]
        ).map(sceneSearchResult);
      } catch {
        this.ftsAvailable = false;
      }
    }
    return this.adapter.all(
      `WITH scene_documents AS (
         SELECT s.id AS scene_id,
           s.heading || COALESCE((
             SELECT char(10) || char(10) || group_concat(content, char(10) || char(10))
             FROM (
               SELECT content FROM scene_paragraphs WHERE scene_id = s.id ORDER BY sort_order
             )
           ), '') AS content
         FROM scenes s
       )
       SELECT s.id AS scene_id, s.chapter_id, c.volume_id, c.chapter_number,
          v.number AS volume_number, c.title AS chapter_title, s.heading, d.content
        FROM scene_documents d
        JOIN scenes s ON s.id = d.scene_id
       JOIN chapters c ON c.id = s.chapter_id
       JOIN volumes v ON v.id = c.volume_id
       WHERE d.content LIKE ? ESCAPE '\\'
       ORDER BY c.sort_order, s.sort_order`,
      [likeQuery(normalized)]
    ).map((row) => sceneSearchResult(row, makeSnippet(row.content, normalized)));
  }

  searchCodex(query) {
    const normalized = String(query ?? '').trim();
    if (!normalized) return [];
    if (this.ftsAvailable) {
      try {
        return this.adapter.all(
          `SELECT e.internal_id, e.legacy_id, e.category_id, e.name,
             snippet(codex_fts, -1, '', '', '...', 20) AS snippet
           FROM codex_fts JOIN codex_entries e ON e.internal_id = codex_fts.entry_internal_id
           WHERE codex_fts MATCH ? ORDER BY rank, e.name`,
          [ftsQuery(normalized)]
        ).map((row) => ({
          entryId: row.legacy_id,
          entryInternalId: row.internal_id,
          category: row.category_id,
          name: row.name,
          snippet: row.snippet
        }));
      } catch {
        this.ftsAvailable = false;
      }
    }
    return this.adapter.all(
       `WITH codex_documents AS (
          SELECT e.internal_id,
            e.name || CASE WHEN EXISTS (
              SELECT 1 FROM codex_aliases WHERE entry_internal_id = e.internal_id
            ) THEN char(10) || (
              SELECT group_concat(alias, char(10))
              FROM (
                SELECT alias FROM codex_aliases WHERE entry_internal_id = e.internal_id ORDER BY sort_order
              )
            ) ELSE '' END || char(10) || e.body AS content
         FROM codex_entries e
       )
       SELECT e.internal_id, e.legacy_id, e.category_id, e.name, d.content
       FROM codex_documents d JOIN codex_entries e ON e.internal_id = d.internal_id
       WHERE d.content LIKE ? ESCAPE '\\' ORDER BY e.name`,
      [likeQuery(normalized)]
    ).map((row) => ({
      entryId: row.legacy_id,
      entryInternalId: row.internal_id,
      category: row.category_id,
      name: row.name,
      snippet: makeSnippet(row.content, normalized)
    }));
  }

  importFromMarkdown(volumeId, markdown, options = {}) {
    this.putNovel(volumeId, parseNovel(markdown, { createIds: false }), options);
  }

  exportToMarkdown(volumeId) {
    return serializeNovel(this.getNovel(volumeId), { codexEntries: flattenCodexEntries(this.listCodex()) });
  }

  importCodexEntryFromMarkdown(category, id, markdown, options = {}) {
    const parsed = parseCodexEntry(markdown);
    const current = this.getCodexEntry(category, id);
    const entry = {
      type: parsed.meta.type || TYPE_BY_CATEGORY[category],
      name: parsed.meta.name || id,
      color: parsed.meta.color ?? null,
      aliases: parsed.meta.aliases ?? [],
      tags: parsed.meta.tags ?? [],
      alwaysIncludeInContext: Boolean(parsed.meta.alwaysIncludeInContext),
      doNotTrack: Boolean(parsed.meta.doNotTrack),
      noAutoInclude: Boolean(parsed.meta.noAutoInclude),
      fields: parsed.meta.fields ?? {},
      body: parsed.body
    };
    return current
      ? this.updateCodexEntry(category, id, entry, options)
      : this.createCodexEntry({ ...entry, category, id }, options);
  }

  exportCodexEntryToMarkdown(categoryOrId, id) {
    const entry = this.getCodexEntry(categoryOrId, id);
    if (!entry) throw new Error('Codex entry was not found.');
    return serializeCodexEntry(entry);
  }

  _requireVolume(id) {
    const row = this.adapter.get('SELECT * FROM volumes WHERE id = ?', [id]);
    if (!row) throw new Error(`Volume ${id} was not found.`);
    return row;
  }

  _requireChapter(id) {
    const row = this.adapter.get('SELECT * FROM chapters WHERE id = ?', [id]);
    if (!row) throw new Error(`Chapter ${id} was not found.`);
    return row;
  }

  _requireScene(id) {
    const row = this.adapter.get('SELECT * FROM scenes WHERE id = ?', [id]);
    if (!row) throw new Error(`Scene ${id} was not found.`);
    return row;
  }

  _chapterDto(row, wordCount) {
    return {
      id: row.id,
      volumeId: row.volume_id,
      chapterNumber: Number(row.chapter_number),
      title: row.title,
      sortOrder: Number(row.sort_order),
      wordCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _sceneDto(row, wordCount) {
    return {
      id: row.id,
      chapterId: row.chapter_id,
      heading: row.heading,
      sortOrder: Number(row.sort_order),
      wordCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _codexDto(row, aliases = [], tags = []) {
    return {
      id: row.legacy_id,
      internalId: row.internal_id,
      category: row.category_id,
      path: `${row.category_id}/${row.legacy_id}/entry.md`,
      type: row.type,
      name: row.name,
      color: row.color,
      aliases,
      tags,
      alwaysIncludeInContext: Boolean(row.always_include_in_context),
      doNotTrack: Boolean(row.do_not_track),
      noAutoInclude: Boolean(row.no_auto_include),
      fields: parseFields(row.fields_json),
      body: row.body,
      wordCount: Number(row.word_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _setParagraphRows(sceneId, paragraphs) {
    const values = (paragraphs ?? []).map((paragraph) => String(paragraph?.content ?? paragraph ?? ''));
    const existing = this.adapter.all('SELECT id FROM scene_paragraphs WHERE scene_id = ? ORDER BY sort_order', [sceneId]);
    const timestamp = now();
    values.forEach((content, index) => {
      const paragraph = existing[index];
      if (paragraph) {
        this.adapter.run(
          'UPDATE scene_paragraphs SET content = ?, sort_order = ?, updated_at = ? WHERE id = ?',
          [content, index, timestamp, paragraph.id]
        );
      } else {
        this.adapter.run(
          `INSERT INTO scene_paragraphs (id, scene_id, sort_order, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`paragraph-${createUuid()}`, sceneId, index, content, timestamp, timestamp]
        );
      }
    });
    for (const paragraph of existing.slice(values.length)) {
      this.adapter.run('DELETE FROM scene_paragraphs WHERE id = ?', [paragraph.id]);
    }
  }

  _putChapterScenes(chapterId, scenes, timestamp) {
    const existingScenes = this.adapter.all('SELECT * FROM scenes WHERE chapter_id = ? ORDER BY sort_order', [chapterId]);
    const existingById = new Map(existingScenes.map((row) => [row.id, row]));
    const keptIds = new Set();
    const inputSceneIds = scenes.map((scene) => scene.id).filter(Boolean);
    if (new Set(inputSceneIds).size !== inputSceneIds.length) throw new Error('Scene IDs must be unique within a chapter.');
    for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
      const input = scenes[sceneIndex];
      let scene = input.id ? existingById.get(input.id) : null;
      if (!scene && !input.id) scene = existingScenes[sceneIndex];
      let sceneId = scene && !keptIds.has(scene.id) ? scene.id : input.id;
      if (!sceneId) sceneId = `scene-${createUuid()}`;
      if (!scene || scene.id !== sceneId) this._assertUnusedId('scenes', sceneId);
      keptIds.add(sceneId);
      if (scene?.id === sceneId) {
        this.adapter.run(
          'UPDATE scenes SET heading = ?, sort_order = ?, updated_at = ? WHERE id = ?',
          [String(input.heading || 'Scene 1'), sceneIndex, timestamp, sceneId]
        );
      } else {
        this.adapter.run(
          `INSERT INTO scenes (id, chapter_id, heading, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [sceneId, chapterId, String(input.heading || 'Scene 1'), sceneIndex, timestamp, timestamp]
        );
      }
      this._setParagraphRows(sceneId, input.paragraphs ?? []);
      this._syncSceneSearch(sceneId);
    }
    for (const scene of existingScenes) {
      if (keptIds.has(scene.id)) continue;
      this._removeScenesFromFts([scene.id]);
      this.adapter.run('DELETE FROM scenes WHERE id = ?', [scene.id]);
    }
  }

  _assertUnusedId(table, id) {
    if (this.adapter.get(`SELECT id FROM ${table} WHERE id = ?`, [id])) {
      throw new Error(`${table === 'chapters' ? 'Chapter' : 'Scene'} id ${id} already belongs to another record.`);
    }
  }

  _orderedValues(table, column) {
    const result = new Map();
    for (const row of this.adapter.all(`SELECT entry_internal_id, ${column} AS value FROM ${table} ORDER BY entry_internal_id, sort_order`)) {
      const values = result.get(row.entry_internal_id) ?? [];
      values.push(row.value);
      result.set(row.entry_internal_id, values);
    }
    return result;
  }

  _valuesForEntry(table, column, internalId) {
    return this.adapter.all(
      `SELECT ${column} AS value FROM ${table} WHERE entry_internal_id = ? ORDER BY sort_order`,
      [internalId]
    ).map((row) => row.value);
  }

  _replaceOrderedValues(table, column, internalId, values) {
    this.adapter.run(`DELETE FROM ${table} WHERE entry_internal_id = ?`, [internalId]);
    uniqueOrdered(values).forEach((value, index) => {
      this.adapter.run(
        `INSERT INTO ${table} (entry_internal_id, ${column}, sort_order) VALUES (?, ?, ?)`,
        [internalId, value, index]
      );
    });
  }

  _resolveCodexInternalId(categoryOrId, legacyId, required) {
    let row;
    if (legacyId !== undefined) {
      assertCategory(categoryOrId);
      assertSafeLegacyId(legacyId);
      row = this.adapter.get(
        'SELECT internal_id FROM codex_entries WHERE category_id = ? AND legacy_id = ?',
        [categoryOrId, legacyId]
      );
    } else {
      const id = String(categoryOrId ?? '');
      row = this.adapter.get('SELECT internal_id FROM codex_entries WHERE internal_id = ?', [id]);
      if (!row) {
        const matches = this.adapter.all('SELECT internal_id FROM codex_entries WHERE legacy_id = ?', [id]);
        if (matches.length > 1) throw new Error(`Codex id ${id} is ambiguous; provide its category.`);
        row = matches[0] ?? null;
      }
    }
    if (!row && required) throw new Error('Codex entry was not found.');
    return row?.internal_id ?? null;
  }

  _syncSceneSearch(sceneId) {
    const scene = this.adapter.get('SELECT heading FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    const paragraphs = this.adapter.all('SELECT content FROM scene_paragraphs WHERE scene_id = ? ORDER BY sort_order', [sceneId]);
    const content = [scene.heading, ...paragraphs.map((row) => row.content)].join('\n\n');
    if (!this.ftsAvailable) return;
    try {
      this.adapter.run('DELETE FROM scenes_fts WHERE scene_id = ?', [sceneId]);
      this.adapter.run('INSERT INTO scenes_fts (scene_id, content) VALUES (?, ?)', [sceneId, content]);
    } catch {
      this.ftsAvailable = false;
    }
  }

  _syncCodexSearch(internalId) {
    const entry = this.adapter.get('SELECT name, body FROM codex_entries WHERE internal_id = ?', [internalId]);
    if (!entry) return;
    const aliases = this._valuesForEntry('codex_aliases', 'alias', internalId);
    if (!this.ftsAvailable) return;
    try {
      this.adapter.run('DELETE FROM codex_fts WHERE entry_internal_id = ?', [internalId]);
      this.adapter.run(
        'INSERT INTO codex_fts (entry_internal_id, name, aliases, body) VALUES (?, ?, ?, ?)',
        [internalId, entry.name, aliases.join(' '), entry.body]
      );
    } catch {
      this.ftsAvailable = false;
    }
  }

  _removeScenesFromFts(sceneIds) {
    if (!this.ftsAvailable) return;
    try {
      for (const sceneId of sceneIds) this.adapter.run('DELETE FROM scenes_fts WHERE scene_id = ?', [sceneId]);
    } catch {
      this.ftsAvailable = false;
    }
  }

  _removeCodexFromFts(internalId) {
    if (!this.ftsAvailable) return;
    try {
      this.adapter.run('DELETE FROM codex_fts WHERE entry_internal_id = ?', [internalId]);
    } catch {
      this.ftsAvailable = false;
    }
  }

  _reindexAllScenes() {
    indexMentionsForScenes(this.adapter, this.adapter.all('SELECT id FROM scenes').map((row) => row.id));
  }
}

export default ProjectDb;
