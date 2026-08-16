function flattenCodex(groups) {
  if (!groups || typeof groups !== 'object') return [];
  return Object.values(groups).flatMap((entries) => Array.isArray(entries) ? entries : []);
}

function matchesEntry(text, entry) {
  const source = String(text ?? '');
  for (const rawTerm of [entry?.name, ...(entry?.aliases ?? [])]) {
    const term = String(rawTerm ?? '').trim();
    if (!term) continue;
    let from = source.indexOf(term);
    while (from !== -1) {
      const to = from + term.length;
      const wordLike = (value) => Boolean(value && /[\p{L}\p{N}_'-]/u.test(value));
      if (!(wordLike(source[from]) && wordLike(source[from - 1])) && !(wordLike(source[to - 1]) && wordLike(source[to]))) return true;
      from = source.indexOf(term, from + 1);
    }
  }
  return false;
}

function getAllChapters(db) {
  if (typeof db?.listVolumes !== 'function' || typeof db?.listChapters !== 'function') return [];
  const chapters = [];
  for (const volume of db.listVolumes() ?? []) {
    for (const chapter of db.listChapters(volume.id) ?? []) chapters.push({ ...chapter, volume });
  }
  return chapters;
}

function getChapter(db, chapterId) {
  for (const chapter of getAllChapters(db)) {
    if (chapter.id !== chapterId) continue;
    if (typeof db.getNovel !== 'function') return null;
    return db.getNovel(chapter.volumeId)?.chapters?.find((candidate) => candidate.id === chapterId) ?? null;
  }
  return null;
}

function getCodexEntry(db, entryId) {
  if (typeof db?.getCodexEntry !== 'function') return null;
  return db.getCodexEntry(entryId);
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required };
}

const stringProperty = { type: 'string', minLength: 1 };

function validateArguments(value, definition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Tool arguments must be an object.';
  for (const name of definition.parameters.required ?? []) {
    if (!(name in value)) return `Missing required argument: ${name}.`;
  }
  for (const [name, property] of Object.entries(definition.parameters.properties ?? {})) {
    if (value[name] === undefined) continue;
    if (property.type === 'string' && typeof value[name] !== 'string') return `Argument ${name} must be a string.`;
    if (property.minLength && value[name].trim().length < property.minLength) return `Argument ${name} must not be empty.`;
  }
  return null;
}

export function createToolRegistry({ db, draftBuffer }) {
  const definitions = [
    { name: 'load_latest_chapter', description: 'Load the full text and scenes for the latest chapter.', parameters: schema() },
    { name: 'load_chapter', description: 'Load the full text and scenes for a chapter.', parameters: schema({ chapterId: stringProperty }, ['chapterId']) },
    { name: 'load_codex_entry', description: 'Load a codex entry including its body, aliases, and tags.', parameters: schema({ entryId: stringProperty }, ['entryId']) },
    { name: 'get_mentioned_codex', description: 'Load codex entries mentioned by a codex entry.', parameters: schema({ entryId: stringProperty }, ['entryId']) },
    { name: 'get_chapters_mentioned', description: 'Load chapters that mention a codex entry.', parameters: schema({ entryId: stringProperty }, ['entryId']) },
    { name: 'search_scenes', description: 'Search scenes for relevant story context.', parameters: schema({ query: stringProperty }, ['query']) },
    { name: 'search_codex', description: 'Search codex entries for relevant context.', parameters: schema({ query: stringProperty }, ['query']) },
    { name: 'draft_scene', description: 'Stage prose for a scene without changing the editor or project database.', parameters: schema({ sceneId: stringProperty, prose: stringProperty }, ['sceneId', 'prose']) },
    { name: 'finalize', description: 'Finish the task and return the final prose.', parameters: schema({ prose: stringProperty }, ['prose']) }
  ];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  const actions = {
    load_latest_chapter() {
      const chapters = getAllChapters(db);
      return chapters.length ? getChapter(db, chapters.at(-1).id) : null;
    },
    load_chapter({ chapterId }) {
      return getChapter(db, chapterId);
    },
    load_codex_entry({ entryId }) {
      return getCodexEntry(db, entryId);
    },
    get_mentioned_codex({ entryId }) {
      const entry = getCodexEntry(db, entryId);
      if (!entry || typeof db?.listCodex !== 'function') return [];
      return flattenCodex(db.listCodex()).filter((candidate) => candidate.internalId !== entry.internalId && matchesEntry(entry.body, candidate));
    },
    get_chapters_mentioned({ entryId }) {
      const entry = getCodexEntry(db, entryId);
      if (!entry || typeof db?.getMentionsForScene !== 'function') return [];
      const mentioned = [];
      for (const chapter of getAllChapters(db)) {
        if (typeof db.listScenes !== 'function') break;
        const hasMention = (db.listScenes(chapter.id) ?? []).some((scene) => (
          db.getMentionsForScene(scene.id, { coarse: true }).some((mention) => mention.entryInternalId === entry.internalId)
        ));
        if (hasMention) mentioned.push(getChapter(db, chapter.id) ?? chapter);
      }
      return mentioned;
    },
    search_scenes({ query }) {
      return typeof db?.searchScenes === 'function' ? db.searchScenes(query) : [];
    },
    search_codex({ query }) {
      return typeof db?.searchCodex === 'function' ? db.searchCodex(query) : [];
    },
    draft_scene({ sceneId, prose }) {
      if (draftBuffer && typeof draftBuffer === 'object') {
        draftBuffer.sceneId = sceneId;
        draftBuffer.prose = prose;
      }
      return { sceneId, drafted: true };
    },
    finalize({ prose }) {
      return { __final: prose };
    }
  };

  return {
    definitions,
    execute(name, args) {
      const definition = byName.get(name);
      if (!definition) return JSON.stringify({ error: `Unknown tool: ${name}.` });
      const normalizedArgs = args === undefined ? {} : args;
      const validationError = validateArguments(normalizedArgs, definition);
      if (validationError) return JSON.stringify({ error: validationError });
      try {
        return JSON.stringify(actions[name](normalizedArgs));
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
