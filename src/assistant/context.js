function hasSelection(selection) {
  return Boolean(selection?.sceneId || selection?.chapterId || selection?.excerpt);
}

function hasManualRefs(manualRefs) {
  if (Array.isArray(manualRefs)) return manualRefs.length > 0;
  return Boolean(
    manualRefs &&
    (manualRefs.chapters?.length || manualRefs.chapterIds?.length || manualRefs.codexEntries?.length || manualRefs.codexIds?.length || manualRefs.selections?.length)
  );
}

export function detectIntent({ selection, manualRefs } = {}) {
  if (manualRefs?.selections?.length) return 'selection';
  if (hasSelection(selection)) return 'selection';
  if (hasManualRefs(manualRefs)) return 'manual';
  return 'continuation';
}

function chapterKey(chapter) {
  return String(chapter?.id ?? chapter?.chapterId ?? '');
}

function entryKeys(entry) {
  return [entry?.id, entry?.internalId, entry?.entryId, entry?.entryInternalId]
    .filter((value) => value != null)
    .map(String);
}

function uniqueBy(items, keys) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keys(item).find((candidate) => candidate && !seen.has(candidate));
    if (!key) return false;
    for (const candidate of keys(item)) seen.add(candidate);
    return true;
  });
}

function readProjectChapters(db) {
  const chapters = [];
  for (const volume of db.listVolumes()) {
    const novel = db.getNovel(volume.id);
    for (const chapter of novel.chapters ?? []) chapters.push({ ...chapter, volumeId: volume.id });
  }
  return chapters;
}

function flattenCodex(db) {
  return Object.values(db.listCodex()).flat();
}

function flagFor(entry, codexFlags) {
  for (const key of entryKeys(entry)) {
    if (codexFlags?.[key]) return codexFlags[key];
  }
  return entry;
}

function shouldInclude(entry, codexFlags, manuallySelected = false) {
  const flags = flagFor(entry, codexFlags);
  if (flags?.doNotTrack) return false;
  return manuallySelected || !flags?.noAutoInclude;
}

function manualValues(manualRefs, names) {
  if (!manualRefs) return [];
  if (Array.isArray(manualRefs)) return manualRefs.filter((item) => names.includes(item?.type));
  return names.flatMap((name) => manualRefs[name] ?? []);
}

function idsFromRefs(refs) {
  return new Set(refs.map((ref) => String(typeof ref === 'object' ? ref.id ?? ref.chapterId ?? ref.entryId ?? ref.internalId : ref)));
}

function mentionedEntries(db, chapters, entries) {
  if (typeof db.getMentionsForScene !== 'function') return [];
  const byId = new Map(entries.flatMap((entry) => entryKeys(entry).map((key) => [key, entry])));
  const mentioned = [];
  try {
    for (const chapter of chapters) {
      for (const scene of chapter.scenes ?? []) {
        for (const mention of db.getMentionsForScene(scene.id, { coarse: true }) ?? []) {
          const entry = entryKeys(mention).map((key) => byId.get(key)).find(Boolean);
          if (entry) mentioned.push(entry);
        }
      }
    }
  } catch {
    return [];
  }
  return uniqueBy(mentioned, entryKeys);
}

export function assembleContext({ db, selection, manualRefs, codexFlags = {} } = {}) {
  const chapters = readProjectChapters(db);
  const entries = flattenCodex(db);
  const intent = detectIntent({ selection, manualRefs });
  const chapterById = new Map(chapters.map((chapter) => [chapterKey(chapter), chapter]));
  const entryById = new Map(entries.flatMap((entry) => entryKeys(entry).map((key) => [key, entry])));

  let anchors;
  let selected = null;
  let manualEntryIds = new Set();
  let selections = [];

  if (intent === 'selection') {
    const pinnedSelections = Array.isArray(manualRefs?.selections) ? manualRefs.selections : [];
    const selectionRefs = pinnedSelections.length ? pinnedSelections : [selection];
    const chapterIds = idsFromRefs(manualValues(manualRefs, ['chapters', 'chapterIds', 'chapter']));
    manualEntryIds = idsFromRefs(manualValues(manualRefs, ['codexEntries', 'codexIds', 'codex']));
    const seenAnchors = new Set();
    anchors = [];
    selections = selectionRefs.filter(Boolean).map((selectionRef) => {
      const anchor = chapterById.get(String(selectionRef.chapterId)) ?? chapters.find((chapter) =>
        (chapter.scenes ?? []).some((scene) => scene.id === selectionRef.sceneId)
      );
      if (anchor && !seenAnchors.has(chapterKey(anchor))) {
        seenAnchors.add(chapterKey(anchor));
        anchors.push(anchor);
      }
      for (const id of selectionRef.codexIds ?? []) manualEntryIds.add(String(id));
      return { ...selectionRef, chapterId: anchor?.id ?? selectionRef.chapterId };
    });
    for (const chapter of chapters) {
      if (chapterIds.has(chapterKey(chapter)) && !seenAnchors.has(chapterKey(chapter))) {
        seenAnchors.add(chapterKey(chapter));
        anchors.push(chapter);
      }
    }
    selected = selections[0] ?? null;
  } else if (intent === 'manual') {
    const chapterRefs = manualValues(manualRefs, ['chapters', 'chapterIds', 'chapter']);
    const codexRefs = manualValues(manualRefs, ['codexEntries', 'codexIds', 'codex']);
    const chapterIds = idsFromRefs(chapterRefs);
    manualEntryIds = idsFromRefs(codexRefs);
    anchors = chapters.filter((chapter) => chapterIds.has(chapterKey(chapter)));
  } else {
    anchors = chapters.length ? [chapters.at(-1)] : [];
  }

  const manualEntries = [...manualEntryIds].map((id) => entryById.get(id)).filter(Boolean);
  const automaticEntries = mentionedEntries(db, anchors, entries)
    .filter((entry) => shouldInclude(entry, codexFlags));
  const alwaysIncluded = entries.filter((entry) => flagFor(entry, codexFlags)?.alwaysIncludeInContext && shouldInclude(entry, codexFlags));
  const codexEntries = uniqueBy(
    [...manualEntries.filter((entry) => shouldInclude(entry, codexFlags, true)), ...alwaysIncluded, ...automaticEntries],
    entryKeys
  );
  const chain = automaticEntries.filter((entry) => !anchors.some((anchor) => entryKeys(entry).includes(chapterKey(anchor))));

  return {
    anchorChapter: intent === 'manual' || anchors.length > 1 ? anchors : anchors[0] ?? null,
    selection: selected,
    selections,
    codexEntries,
    chain
  };
}
