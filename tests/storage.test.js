import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import initSqlJs from 'sql.js';

import { parseCodexEntry, parseNovel } from '../src/storage/markdownBridge.js';
import { ProjectDb } from '../src/storage/projectDb.js';

let sqlJsPromise;

const engines = [
  {
    name: 'better-sqlite3',
    async open() {
      return new BetterSqlite3(':memory:');
    },
    async openFromBytes(bytes) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-storage-round-trip-'));
      const filePath = path.join(directory, 'project.novel');
      await writeFile(filePath, bytes);
      return {
        raw: new BetterSqlite3(filePath),
        cleanup: () => rm(directory, { recursive: true, force: true })
      };
    }
  },
  {
    name: 'sql.js',
    async open() {
      sqlJsPromise ??= initSqlJs();
      const SQL = await sqlJsPromise;
      return new SQL.Database();
    },
    async openFromBytes(bytes) {
      sqlJsPromise ??= initSqlJs();
      const SQL = await sqlJsPromise;
      return { raw: new SQL.Database(bytes), cleanup: async () => {} };
    }
  }
];

for (const engine of engines) {
  test(`${engine.name}: schema, CRUD, stable IDs, ordering, and cascades`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      const originalMeta = db.getProjectMeta();
      assert.match(originalMeta.projectUuid, /^[0-9a-f-]{36}$/i);
      assert.equal(db.updateProjectMeta({ title: 'The Project', author: 'A. Writer' }).author, 'A. Writer');
      assert.equal(db.getProjectMeta().projectUuid, originalMeta.projectUuid);
      assert.equal(Number(db.adapter.get('PRAGMA foreign_keys').foreign_keys), 1);
      assert.equal(Number(db.adapter.get('PRAGMA user_version').user_version), 1);

      const volume = db.createVolume({ number: 1, title: 'Book One' });
      assert.deepEqual(
        { id: volume.id, label: volume.label, filename: volume.filename, path: volume.path },
        { id: 'volume1', label: 'Volume 1', filename: 'volume1.md', path: 'volumes/volume1.md' }
      );
      const firstChapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'First' });
      const secondChapter = db.createChapter({ volumeId: volume.id, chapterNumber: 2, title: 'Second' });
      assert.deepEqual(db.reorderChapters(volume.id, [secondChapter.id, firstChapter.id]).map((item) => item.id), [secondChapter.id, firstChapter.id]);

      const firstScene = db.createScene({ chapterId: firstChapter.id, heading: 'Scene One' });
      const secondScene = db.createScene({ chapterId: firstChapter.id, heading: 'Scene Two' });
      assert.deepEqual(db.reorderScenes(firstChapter.id, [secondScene.id, firstScene.id]).map((item) => item.id), [secondScene.id, firstScene.id]);
      db.setParagraphs(firstScene.id, ['One two three.', 'Four five.']);
      assert.equal(db.listScenes(firstChapter.id).find((item) => item.id === firstScene.id).wordCount, 5);

      const before = db.getNovel(volume.id);
      assert.equal(before.wordCount, 5);
      const stableChapterId = before.chapters.find((item) => item.title === 'First').id;
      const stableSceneId = before.chapters.find((item) => item.title === 'First').scenes.find((item) => item.heading === 'Scene One').id;
      db.putNovel(volume.id, before);
      const after = db.getNovel(volume.id);
      assert.equal(after.chapters.find((item) => item.title === 'First').id, stableChapterId);
      assert.equal(after.chapters.find((item) => item.title === 'First').scenes.find((item) => item.heading === 'Scene One').id, stableSceneId);

      db.createCodexEntry({ category: 'characters', id: 'hero', name: 'One', body: '' });
      assert.ok(db.getMentionsForScene(firstScene.id).length > 0);
      db.deleteChapter(firstChapter.id);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM scenes WHERE chapter_id = ?', [firstChapter.id]).count), 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM scene_paragraphs').count), 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions').count), 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM scene_search_documents').count), 0);

      db.deleteVolume(volume.id);
      assert.equal(db.listVolumes().length, 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM chapters').count), 0);
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: category-safe codex IDs and exact occurrence mentions`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      const volume = db.createVolume({ number: 1, title: 'Mentions' });
      const chapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Boundaries' });
      const scene = db.createScene({ chapterId: chapter.id, heading: 'Scene 1' });

      const characterHero = db.createCodexEntry({
        category: 'characters',
        id: 'shared',
        name: 'Hero',
        aliases: ['Champion', 'Champion', 'The Hero'],
        tags: ['lead', 'lead', 'person'],
        fields: { role: 'lead' },
        body: 'A central figure.'
      });
      const locationHero = db.createCodexEntry({ category: 'locations', id: 'shared', name: 'Hero Hall' });
      assert.notEqual(characterHero.internalId, locationHero.internalId);
      assert.equal(db.getCodexEntry('characters', 'shared').internalId, characterHero.internalId);
      assert.equal(db.getCodexEntry(locationHero.internalId).category, 'locations');
      assert.throws(() => db.getCodexEntry('shared'), /ambiguous/i);
      assert.deepEqual(db.getCodexEntry('characters', 'shared').aliases, ['Champion', 'The Hero']);
      assert.deepEqual(db.getCodexEntry('characters', 'shared').tags, ['lead', 'person']);
      assert.deepEqual(db.getCodexEntry('characters', 'shared').fields, { role: 'lead' });

      const ann = db.createCodexEntry({ category: 'characters', id: 'ann', name: 'Ann' });
      const newYork = db.createCodexEntry({ category: 'locations', id: 'new-york', name: 'New York' });
      db.createCodexEntry({ category: 'locations', id: 'york', name: 'York' });
      db.createCodexEntry({ category: 'characters', id: 'oneil', name: "O'Neil" });
      db.createCodexEntry({ category: 'characters', id: 'jean-luc', name: 'Jean-Luc' });
      db.createCodexEntry({ category: 'characters', id: 'elodie', name: 'Élodie' });

      db.setParagraphs(scene.id, ["😀Ann met ANN and JoAnn. Ann_ Ann- O'Neil O'Neill Jean-Luc Jean-Lucian Élodie xÉlodie. New York; York."]);
      const mentions = db.getMentionsForScene(scene.id);
      assert.equal(mentions.find((item) => item.entryInternalId === ann.internalId).startOffset, 2);
      assert.equal(mentions.filter((item) => item.term === 'Ann').length, 1);
      assert.equal(mentions.filter((item) => item.term === "O'Neil").length, 1);
      assert.equal(mentions.filter((item) => item.term === 'Jean-Luc').length, 1);
      assert.equal(mentions.filter((item) => item.term === 'Élodie').length, 1);
      assert.equal(mentions.filter((item) => item.entryInternalId === newYork.internalId).length, 1);
      assert.equal(mentions.filter((item) => item.term === 'York').length, 1, 'shorter overlap is suppressed but standalone match remains');
      assert.ok(mentions.every((item) => item.endOffset - item.startOffset === item.term.length));
      assert.ok(mentions.every((item) => item.context.length <= item.term.length + 120));
      assert.equal(db.getMentionsForScene(scene.id, { coarse: true }).find((item) => item.entryInternalId === ann.internalId).occurrenceCount, 1);

      db.updateCodexEntry(ann.internalId, { name: 'Beth' });
      assert.equal(db.getMentionsForScene(scene.id).some((item) => item.entryInternalId === ann.internalId), false);
      db.updateCodexEntry('characters', 'ann', { aliases: ['Ann'] });
      assert.equal(db.getMentionsForScene(scene.id).some((item) => item.entryInternalId === ann.internalId), true);

      db.deleteCodexEntry(newYork.internalId);
      assert.equal(db.getMentionsForScene(scene.id).filter((item) => item.term === 'York').length, 2, 'deleting a longer term reindexes newly exposed shorter matches');
      db.deleteCodexEntry('characters', 'ann');
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions WHERE entry_internal_id = ?', [ann.internalId]).count), 0);
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: markdown bridge preserves semantics and stable imported structure`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      const volume = db.createVolume({ number: 1, title: 'Initial' });
      db.createCodexEntry({ category: 'characters', id: 'aria', name: 'Aria', aliases: ['The Singer'] });
      const markdown = [
        '## CRLF Novel',
        '<!-- preserved raw header -->',
        '',
        '### Chapter 7: Arrival',
        '',
        '#### Codex Mentioned',
        '',
        '- **Character:** Stale Name',
        '',
        '#### Scene at Dawn',
        '',
        'Aria arrives.',
        'The paragraph continues.',
        '',
        '#### Scene 2',
        '',
        'No one is here.',
        ''
      ].join('\r\n');

      db.importFromMarkdown(volume.id, markdown);
      const firstRead = db.getNovel(volume.id);
      assert.equal(firstRead.title, 'CRLF Novel');
      assert.deepEqual(firstRead.header, ['## CRLF Novel', '<!-- preserved raw header -->', '']);
      assert.equal(firstRead.chapters[0].chapterNumber, 7);
      assert.deepEqual(firstRead.chapters[0].scenes[0].paragraphs, ['Aria arrives.\nThe paragraph continues.']);
      const chapterId = firstRead.chapters[0].id;
      const sceneIds = firstRead.chapters[0].scenes.map((scene) => scene.id);

      const exported = db.exportToMarkdown(volume.id);
      assert.match(exported, /#### Codex Mentioned\n\n- \*\*Character:\*\* Aria/);
      assert.doesNotMatch(exported, /Stale Name/);
      assert.match(exported, /<!-- preserved raw header -->/);
      assert.ok(exported.endsWith('\n'));
      assert.equal(parseNovel(exported).chapters.length, 1);

      db.importFromMarkdown(volume.id, exported.replaceAll('\n', '\r\n'));
      const secondRead = db.getNovel(volume.id);
      assert.equal(secondRead.chapters[0].id, chapterId);
      assert.deepEqual(secondRead.chapters[0].scenes.map((scene) => scene.id), sceneIds);

      const entry = db.createCodexEntry({
        category: 'lore',
        id: 'old-law',
        name: 'Old Law',
        aliases: ['First Rule'],
        tags: ['history'],
        fields: { era: 'first', rank: 2 },
        alwaysIncludeInContext: true,
        body: 'A compact body.'
      });
      const entryMarkdown = db.exportCodexEntryToMarkdown(entry.internalId);
      const parsedEntry = parseCodexEntry(entryMarkdown.replaceAll('\n', '\r\n'));
      assert.deepEqual(parsedEntry.meta.fields, { era: 'first', rank: 2 });
      assert.deepEqual(parsedEntry.meta.aliases, ['First Rule']);
      assert.equal(parsedEntry.meta.alwaysIncludeInContext, true);
      assert.equal(parsedEntry.body, 'A compact body.');
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: canonical search content stays synchronized with fallback-compatible search`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      const volume = db.createVolume({ number: 1, title: 'Search' });
      const chapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Search Chapter' });
      const scene = db.createScene({ chapterId: chapter.id, heading: 'Quiet room' });
      db.setParagraphs(scene.id, ['A sapphire lantern glows.']);
      const sceneResult = db.searchScenes('sapphire')[0];
      assert.equal(sceneResult.sceneId, scene.id);
      assert.equal(sceneResult.volumeId, volume.id);
      assert.equal(sceneResult.chapterId, chapter.id);
      assert.equal(sceneResult.chapterNumber, 1);
      db.setParagraphs(scene.id, ['An amber lantern glows.']);
      assert.equal(db.searchScenes('sapphire').length, 0);
      assert.equal(db.searchScenes('amber')[0].chapterTitle, 'Search Chapter');
      db.ftsAvailable = false;
      assert.equal(db.searchScenes('amber')[0].sceneId, scene.id, 'canonical LIKE fallback remains usable');

      const entry = db.createCodexEntry({
        category: 'lore',
        id: 'lamp',
        name: 'Lantern Rite',
        aliases: ['Blue Flame'],
        body: 'A winter observance.'
      });
      assert.equal(db.searchCodex('Blue Flame')[0].entryInternalId, entry.internalId);
      assert.equal(db.searchCodex('winter')[0].entryId, 'lamp');
      db.updateCodexEntry(entry.internalId, { aliases: ['Gold Flame'], body: 'A summer observance.' });
      assert.equal(db.searchCodex('Blue Flame').length, 0);
      assert.equal(db.searchCodex('Gold Flame')[0].entryInternalId, entry.internalId);
      assert.equal(db.searchCodex('winter').length, 0);
      assert.equal(db.searchCodex('summer')[0].entryId, 'lamp');
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM scene_search_documents').count), 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_search_documents').count), 0);
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: compact indexes retain derived mention context and canonical search results`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      const volume = db.createVolume({ number: 1, title: 'Compact Indexes' });
      const chapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Dense References' });
      const scenes = ['First', 'Second', 'Third'].map((heading) => db.createScene({ chapterId: chapter.id, heading }));
      const aria = db.createCodexEntry({
        category: 'characters', id: 'aria', name: 'Aria', aliases: ['The Singer'], body: 'Aria carries a sapphire lantern.'
      });
      const rite = db.createCodexEntry({ category: 'lore', id: 'rite', name: 'Lantern Rite', body: 'A sapphire observance.' });
      const paragraph = `${'Before '.repeat(12)}Aria follows the Lantern Rite through sapphire light.${' After'.repeat(12)}`;
      for (const scene of scenes) db.setParagraphs(scene.id, [paragraph, 'The Singer remembers Aria.']);

      const mentions = db.getMentionsForScene(scenes[0].id);
      const ariaMention = mentions.find((item) => item.entryInternalId === aria.internalId && item.term === 'Aria');
      const expectedContext = paragraph.slice(Math.max(0, ariaMention.startOffset - 60), Math.min(paragraph.length, ariaMention.endOffset + 60));
      assert.equal(ariaMention.context, expectedContext);
      assert.equal(ariaMention.contextText, expectedContext);
      assert.match(ariaMention.context, /Aria/);
       assert.equal(Number(db.adapter.get('SELECT COALESCE(SUM(length(context_text)), 0) AS total FROM codex_mentions').total), 0);
       db.adapter.run("UPDATE codex_mentions SET context_text = 'stale persisted context'");
       assert.equal(db.getMentionsForScene(scenes[0].id).find((item) => item.id === ariaMention.id).context, expectedContext);
       const currentParagraph = `Current ${'prefix '.repeat(12)}Aria follows the Lantern Rite through sapphire light.${' suffix'.repeat(12)}`;
       db.setParagraphs(scenes[0].id, [currentParagraph, 'The Singer remembers Aria.']);
       db.rebuildMentionIndex(volume.id);
       const currentAriaMention = db.getMentionsForScene(scenes[0].id).find((item) => item.entryInternalId === aria.internalId && item.term === 'Aria');
       const currentExpectedContext = currentParagraph.slice(
         Math.max(0, currentAriaMention.startOffset - 60),
         Math.min(currentParagraph.length, currentAriaMention.endOffset + 60)
       );
       assert.equal(currentAriaMention.context, currentExpectedContext);
       assert.notEqual(currentAriaMention.context, 'stale persisted context');
       assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM scene_search_documents').count), 0);
       assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_search_documents').count), 0);
       assert.equal(Number(db.adapter.get('SELECT COALESCE(SUM(length(context_text)), 0) AS total FROM codex_mentions').total), 0);

      db.ftsAvailable = false;
      const sceneResult = db.searchScenes('Lantern Rite')[0];
      const codexResult = db.searchCodex('sapphire').find((item) => item.entryInternalId === rite.internalId);
      assert.equal(sceneResult.sceneId, scenes[0].id);
      assert.match(sceneResult.snippet, /Lantern Rite/);
      assert.equal(codexResult.entryInternalId, rite.internalId);
      assert.match(codexResult.snippet, /sapphire/);
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: compacted export round-trips canonical project data`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    let reopened;
    let cleanup = async () => {};
    try {
      const volume = db.createVolume({ number: 1, title: 'Round Trip' });
      const chapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Opening' });
      const scene = db.createScene({ chapterId: chapter.id, heading: 'Arrival' });
      const aria = db.createCodexEntry({ category: 'characters', id: 'aria', name: 'Aria', aliases: ['The Singer'], body: 'A traveler.' });
      db.setParagraphs(scene.id, ['Aria arrives as The Singer.', 'Aria stays.']);
      const original = {
        novel: db.getNovel(volume.id),
        codex: db.listCodex(),
        mentions: db.getMentionsForScene(scene.id),
        scenes: db.searchScenes('Aria'),
        codexSearch: db.searchCodex('Singer'),
        markdown: db.exportToMarkdown(volume.id)
      };
      db.adapter.compact();
      const bytes = raw.export?.() ?? raw.serialize();
      const opened = await engine.openFromBytes(bytes);
      cleanup = opened.cleanup;
      reopened = new ProjectDb(opened.raw);
      assert.deepEqual(reopened.getNovel(volume.id), original.novel);
      assert.deepEqual(reopened.listCodex(), original.codex);
      assert.deepEqual(reopened.getMentionsForScene(scene.id), original.mentions);
      assert.deepEqual(reopened.searchScenes('Aria'), original.scenes);
      assert.deepEqual(reopened.searchCodex('Singer'), original.codexSearch);
      assert.equal(reopened.exportToMarkdown(volume.id), original.markdown);
      assert.equal(reopened.getCodexEntry(aria.internalId).name, 'Aria');
    } finally {
      reopened?.close();
      await cleanup();
      db.close();
    }
  });

  test(`${engine.name}: opening a v1 project purges redundant stored search and mention context`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    let reopened;
    let cleanup = async () => {};
    try {
      const volume = db.createVolume({ number: 1, title: 'Existing Project' });
      const chapter = db.createChapter({ volumeId: volume.id, chapterNumber: 1, title: 'Existing Chapter' });
      const scene = db.createScene({ chapterId: chapter.id, heading: 'Existing Scene' });
      const paragraph = 'Aria consults the old map.';
      db.setParagraphs(scene.id, [paragraph]);
      const aria = db.createCodexEntry({ category: 'characters', id: 'aria', name: 'Aria', body: 'Keeper of the old map.' });
      const expectedNovel = db.getNovel(volume.id);
      const expectedCodex = db.listCodex();
      const expectedMentions = db.getMentionsForScene(scene.id);

      db.adapter.run('INSERT INTO scene_search_documents (scene_id, content) VALUES (?, ?)', [scene.id, 'obsolete scene search content']);
      db.adapter.run('INSERT INTO codex_search_documents (entry_internal_id, content) VALUES (?, ?)', [aria.internalId, 'obsolete codex search content']);
      db.adapter.run("UPDATE codex_mentions SET context_text = 'stale persisted context'");
      const bytes = raw.export?.() ?? raw.serialize();
      db.close();

      const opened = await engine.openFromBytes(bytes);
      cleanup = opened.cleanup;
      reopened = new ProjectDb(opened.raw);
      assert.equal(Number(reopened.adapter.get('SELECT COUNT(*) AS count FROM scene_search_documents').count), 0);
      assert.equal(Number(reopened.adapter.get('SELECT COUNT(*) AS count FROM codex_search_documents').count), 0);
      assert.equal(Number(reopened.adapter.get("SELECT COUNT(*) AS count FROM codex_mentions WHERE context_text <> ''").count), 0);
      assert.deepEqual(reopened.getNovel(volume.id), expectedNovel);
      assert.deepEqual(reopened.listCodex(), expectedCodex);
      assert.deepEqual(reopened.getMentionsForScene(scene.id), expectedMentions);
      const mention = reopened.getMentionsForScene(scene.id)[0];
      const expectedContext = paragraph.slice(Math.max(0, mention.startOffset - 60), Math.min(paragraph.length, mention.endOffset + 60));
      assert.equal(mention.context, expectedContext);
      assert.equal(reopened.searchScenes('Aria')[0].sceneId, scene.id);
      assert.equal(reopened.searchCodex('old map')[0].entryInternalId, aria.internalId);
      reopened.ftsAvailable = false;
      assert.equal(reopened.searchScenes('Aria')[0].sceneId, scene.id);
      assert.equal(reopened.searchCodex('old map')[0].entryInternalId, aria.internalId);
    } finally {
      reopened?.close();
      await cleanup();
      if (!reopened) db.close();
    }
  });

  test(`${engine.name}: bulk import defers mention work and rebuilds once per volume`, async () => {
    const raw = await engine.open();
    const db = new ProjectDb(raw);
    try {
      let automaticRebuilds = 0;
      const rebuildAllScenes = db._reindexAllScenes.bind(db);
      db._reindexAllScenes = () => {
        automaticRebuilds += 1;
        return rebuildAllScenes();
      };

      const terms = Array.from({ length: 30 }, (_, index) => `Entity${index}`);
      for (const [index, name] of terms.entries()) {
        db.createCodexEntry(
          { category: 'characters', id: `entity-${index}`, name },
          { reindexMentions: false }
        );
      }
      const volume = db.createVolume({ number: 1, title: 'Bulk Import' });
      db.putNovel(
        volume.id,
        {
          header: ['## Bulk Import', ''],
          title: 'Bulk Import',
          chapters: [{
            chapterNumber: 1,
            title: 'All Entities',
            scenes: [
              { heading: 'Scene 1', paragraphs: [terms.join(' ')] },
              { heading: 'Scene 2', paragraphs: [terms.join(' ')] }
            ]
          }]
        },
        { reindexMentions: false }
      );

      assert.equal(automaticRebuilds, 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions').count), 0);
      assert.equal(db.rebuildMentionIndex(volume.id), 60);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions').count), 60);

      db.importCodexEntryFromMarkdown(
        'characters',
        'entity-0',
        ['---', 'type: character', 'name: EntityZero', 'aliases: []', 'tags: []', '---', 'Updated.', ''].join('\n'),
        { reindexMentions: false }
      );
      assert.equal(automaticRebuilds, 0);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions').count), 60);
      assert.equal(db.rebuildMentionIndex(volume.id), 58);
      assert.equal(Number(db.adapter.get('SELECT COUNT(*) AS count FROM codex_mentions').count), 58);
    } finally {
      db.close();
    }
  });

  test(`${engine.name}: newer schema versions are rejected`, async () => {
    const raw = await engine.open();
    try {
      raw.exec?.('PRAGMA user_version = 2');
      if (!raw.exec) raw.run('PRAGMA user_version = 2');
      assert.throws(() => new ProjectDb(raw), /newer than supported/);
    } finally {
      raw.close();
    }
  });
}
