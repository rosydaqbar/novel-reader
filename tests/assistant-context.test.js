import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleContext, detectIntent } from '../src/assistant/context.js';

const chapters = [
  { id: 'chapter-1', title: 'Arrival', scenes: [{ id: 'scene-1', heading: 'Dock' }] },
  { id: 'chapter-2', title: 'Departure', scenes: [{ id: 'scene-2', heading: 'Gate' }] }
];
const entries = [
  { id: 'aria', internalId: 'codex-aria', name: 'Aria' },
  { id: 'tower', internalId: 'codex-tower', name: 'Tower' },
  { id: 'secret', internalId: 'codex-secret', name: 'Secret' },
  { id: 'manual-only', internalId: 'codex-manual', name: 'Manual' }
];

function createDb({ mentions = true } = {}) {
  const db = {
    listVolumes: () => [{ id: 'volume-1' }],
    getNovel: () => ({ chapters }),
    listCodex: () => ({ characters: entries, locations: [], lore: [] })
  };
  if (mentions) {
    db.getMentionsForScene = (sceneId) => sceneId === 'scene-2'
      ? [{ entryId: 'aria' }, { entryInternalId: 'codex-tower' }]
      : [{ entryId: 'tower' }];
  }
  return db;
}

test('detectIntent prioritizes selection, then manual references', () => {
  assert.equal(detectIntent({ selection: { sceneId: 'scene-1' }, manualRefs: { codexIds: ['aria'] } }), 'selection');
  assert.equal(detectIntent({ manualRefs: { codexIds: ['aria'] } }), 'manual');
  assert.equal(detectIntent({ prompt: 'Continue the scene.' }), 'continuation');
});

test('detectIntent treats pinned selections as selection context', () => {
  assert.equal(detectIntent({ manualRefs: { selections: [{ sceneId: 'scene-1', excerpt: 'The boat arrived.' }] } }), 'selection');
});

test('assembleContext uses the latest chapter as the continuation anchor', () => {
  const context = assembleContext({ db: createDb() });
  assert.equal(context.anchorChapter.id, 'chapter-2');
  assert.equal(context.selection, null);
  assert.deepEqual(context.chain.map((entry) => entry.id), ['aria', 'tower']);
});

test('assembleContext returns the full selected chapter and excerpt', () => {
  const context = assembleContext({
    db: createDb(),
    selection: { sceneId: 'scene-1', excerpt: 'The boat arrived.' }
  });
  assert.equal(context.anchorChapter.id, 'chapter-1');
  assert.deepEqual(context.anchorChapter.scenes, chapters[0].scenes);
  assert.deepEqual(context.selection, { sceneId: 'scene-1', chapterId: 'chapter-1', excerpt: 'The boat arrived.' });
});

test('assembleContext merges pinned selections with manual chapters and codex entries', () => {
  const context = assembleContext({
    db: createDb(),
    manualRefs: {
      selections: [
        { sceneId: 'scene-1', chapterId: 'chapter-1', excerpt: 'Aria approached the Tower.', from: 4, to: 30, codexIds: ['aria', 'tower'] }
      ],
      chapters: ['chapter-2'],
      codexEntries: ['manual-only']
    }
  });
  assert.deepEqual(context.selection, { sceneId: 'scene-1', chapterId: 'chapter-1', excerpt: 'Aria approached the Tower.', from: 4, to: 30, codexIds: ['aria', 'tower'] });
  assert.deepEqual(context.selections.map((selection) => selection.excerpt), ['Aria approached the Tower.']);
  assert.deepEqual(context.anchorChapter.map((chapter) => chapter.id), ['chapter-1', 'chapter-2']);
  assert.ok(context.codexEntries.some((entry) => entry.id === 'aria'));
  assert.ok(context.codexEntries.some((entry) => entry.id === 'tower'));
  assert.ok(context.codexEntries.some((entry) => entry.id === 'manual-only'));
});

test('assembleContext merges manually referenced chapters and codex entries', () => {
  const context = assembleContext({
    db: createDb(),
    manualRefs: { chapterIds: ['chapter-1', 'chapter-2'], codexIds: ['manual-only'] }
  });
  assert.deepEqual(context.anchorChapter.map((chapter) => chapter.id), ['chapter-1', 'chapter-2']);
  assert.ok(context.codexEntries.some((entry) => entry.id === 'manual-only'));
});

test('assembleContext applies codex flags while allowing manual no-auto-include entries', () => {
  const context = assembleContext({
    db: createDb(),
    manualRefs: { codexIds: ['manual-only', 'secret'] },
    codexFlags: {
      aria: { alwaysIncludeInContext: true },
      tower: { noAutoInclude: true },
      secret: { doNotTrack: true },
      'manual-only': { noAutoInclude: true }
    }
  });
  assert.deepEqual(context.codexEntries.map((entry) => entry.id).sort(), ['aria', 'manual-only']);
});

test('assembleContext leaves the chain empty when mention lookups are unavailable', () => {
  const context = assembleContext({ db: createDb({ mentions: false }) });
  assert.deepEqual(context.chain, []);
});
