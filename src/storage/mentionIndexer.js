export function isWordLike(value) {
  return Boolean(value && /[\p{L}\p{N}_'-]/u.test(value));
}

export function hasMentionBoundary(text, from, to) {
  const startsWord = isWordLike(text[from]);
  const endsWord = isWordLike(text[to - 1]);
  return !(startsWord && isWordLike(text[from - 1])) && !(endsWord && isWordLike(text[to]));
}

export function containsTerm(text, term) {
  const source = String(text ?? '');
  const needle = String(term ?? '');
  if (!needle) return false;
  let from = source.indexOf(needle);
  while (from !== -1) {
    const to = from + needle.length;
    if (hasMentionBoundary(source, from, to)) return true;
    from = source.indexOf(needle, from + 1);
  }
  return false;
}

function overlapsAccepted(accepted, from, to) {
  return accepted.some((match) => from < match.to && to > match.from);
}

export function findMentionOccurrences(text, entries, contextRadius = 60) {
  const source = String(text ?? '');
  const entriesByTerm = new Map();

  for (const entry of entries ?? []) {
    const seen = new Set();
    for (const rawTerm of [entry.name, ...(entry.aliases ?? [])]) {
      const term = String(rawTerm ?? '').trim();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      const termEntries = entriesByTerm.get(term) ?? [];
      if (!termEntries.some((candidate) => candidate.internalId === entry.internalId)) termEntries.push(entry);
      entriesByTerm.set(term, termEntries);
    }
  }

  const terms = [...entriesByTerm.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const accepted = [];
  const occurrences = [];

  for (const term of terms) {
    let from = source.indexOf(term);
    while (from !== -1) {
      const to = from + term.length;
      if (hasMentionBoundary(source, from, to) && !overlapsAccepted(accepted, from, to)) {
        accepted.push({ from, to });
        const contextText = source.slice(Math.max(0, from - contextRadius), Math.min(source.length, to + contextRadius));
        for (const entry of entriesByTerm.get(term)) {
          occurrences.push({
            entryInternalId: entry.internalId,
            term,
            startOffset: from,
            endOffset: to,
            contextText
          });
        }
      }
      from = source.indexOf(term, from + 1);
    }
  }

  return occurrences.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset || a.entryInternalId.localeCompare(b.entryInternalId));
}

function readMentionTerms(adapter) {
  const entries = adapter.all('SELECT internal_id, name FROM codex_entries ORDER BY internal_id').map((row) => ({
    internalId: row.internal_id,
    name: row.name,
    aliases: []
  }));
  const byId = new Map(entries.map((entry) => [entry.internalId, entry]));
  for (const row of adapter.all('SELECT entry_internal_id, alias FROM codex_aliases ORDER BY entry_internal_id, sort_order')) {
    byId.get(row.entry_internal_id)?.aliases.push(row.alias);
  }
  return entries;
}

export function indexMentionsForScenes(adapter, sceneIds) {
  const uniqueSceneIds = [...new Set(sceneIds ?? [])];
  if (!uniqueSceneIds.length) return 0;
  const entries = readMentionTerms(adapter);
  let inserted = 0;

  for (const sceneId of uniqueSceneIds) {
    adapter.run('DELETE FROM codex_mentions WHERE scene_id = ?', [sceneId]);
    const paragraphs = adapter.all(
      'SELECT id, sort_order, content FROM scene_paragraphs WHERE scene_id = ? ORDER BY sort_order',
      [sceneId]
    );
    for (const paragraph of paragraphs) {
      for (const occurrence of findMentionOccurrences(paragraph.content, entries)) {
        adapter.run(
          `INSERT INTO codex_mentions
            (entry_internal_id, scene_id, paragraph_id, paragraph_index, term, start_offset, end_offset)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            occurrence.entryInternalId,
            sceneId,
            paragraph.id,
            paragraph.sort_order,
            occurrence.term,
            occurrence.startOffset,
            occurrence.endOffset
          ]
        );
        inserted += 1;
      }
    }
  }
  return inserted;
}

export function rebuildMentionIndex(database, volumeId = null) {
  const adapter = database.adapter ?? database;
  return adapter.transaction(() => {
    const rows = volumeId
      ? adapter.all(
          `SELECT s.id FROM scenes s
           JOIN chapters c ON c.id = s.chapter_id
           WHERE c.volume_id = ?`,
          [volumeId]
        )
      : adapter.all('SELECT id FROM scenes');
    return indexMentionsForScenes(adapter, rows.map((row) => row.id));
  });
}
