const chapterHeadingPattern = /^### Chapter\s+(\d+):\s*(.*)$/;
const sceneHeadingPattern = /^####\s+(Scene\s+.*)$/;
const codexMentionedHeadingPattern = /^####\s+Codex Mentioned$/;

export function parseNovel(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const document = {
    header: [],
    title: '',
    chapters: []
  };

  let currentChapter = null;
  let currentScene = null;
  let paragraphLines = [];
  let skippingCodexMentioned = false;

  const flushParagraph = () => {
    if (!currentScene || paragraphLines.length === 0) return;
    const text = paragraphLines.join('\n').trim();
    if (text) currentScene.paragraphs.push(text);
    paragraphLines = [];
  };

  const startScene = (heading) => {
    flushParagraph();
    currentScene = {
      id: createId('scene'),
      heading,
      paragraphs: []
    };
    currentChapter.scenes.push(currentScene);
  };

  for (const line of lines) {
    const chapterMatch = line.match(chapterHeadingPattern);
    if (chapterMatch) {
      flushParagraph();
      skippingCodexMentioned = false;
      currentChapter = {
        id: createId('chapter'),
        chapterNumber: Number(chapterMatch[1]),
        title: chapterMatch[2].trim(),
        scenes: []
      };
      document.chapters.push(currentChapter);
      currentScene = null;
      continue;
    }

    if (!currentChapter) {
      document.header.push(line);
      const titleMatch = line.match(/^##\s+(.+)$/);
      if (titleMatch) document.title = titleMatch[1].trim();
      continue;
    }

    const sceneMatch = line.match(sceneHeadingPattern);
    if (sceneMatch) {
      skippingCodexMentioned = false;
      startScene(sceneMatch[1].trim());
      continue;
    }

    if (line.match(codexMentionedHeadingPattern)) {
      flushParagraph();
      skippingCodexMentioned = true;
      continue;
    }

    if (skippingCodexMentioned) {
      continue;
    }

    if (!currentScene && line.trim()) {
      startScene('Scene 1');
    }

    if (!currentScene) continue;

    if (!line.trim()) {
      flushParagraph();
    } else {
      paragraphLines.push(line);
    }
  }

  flushParagraph();
  return document;
}

export function serializeNovel(document, options = {}) {
  const output = [...(document.header ?? [])];
  const codexEntries = options.codexEntries ?? [];

  for (const chapter of document.chapters ?? []) {
    trimTrailingBlankLines(output);
    output.push('', `### Chapter ${chapter.chapterNumber}: ${chapter.title}`.trimEnd(), '');
    output.push(...serializeCodexMentioned(chapter, codexEntries));

    for (const scene of chapter.scenes ?? []) {
      output.push(`#### ${scene.heading || 'Scene 1'}`, '');

      for (const paragraph of scene.paragraphs ?? []) {
        const text = String(paragraph ?? '').trim();
        if (!text) continue;
        output.push(text, '');
      }
    }
  }

  trimTrailingBlankLines(output);
  output.push('');
  return output.join('\n');
}

export function flattenCodexEntries(codex) {
  return Object.values(codex ?? {}).flatMap((entries) => entries ?? []);
}

export function countWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}\u2019'-]+/gu) ?? []).length;
}

function trimTrailingBlankLines(lines) {
  while (lines.length && !String(lines[lines.length - 1]).trim()) {
    lines.pop();
  }
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function serializeCodexMentioned(chapter, codexEntries) {
  const mentioned = getMentionedCodexEntries(chapter, codexEntries);
  if (!mentioned.length) return [];

  const groups = {
    character: mentioned.filter((entry) => entry.type === 'character'),
    location: mentioned.filter((entry) => entry.type === 'location'),
    lore: mentioned.filter((entry) => entry.type === 'lore')
  };

  const lines = ['#### Codex Mentioned', ''];
  for (const [type, entries] of Object.entries(groups)) {
    if (!entries.length) continue;
    lines.push(`- **${titleCase(type)}:** ${entries.map((entry) => entry.name).join(', ')}`);
  }
  lines.push('');
  return lines;
}

function getMentionedCodexEntries(chapter, codexEntries) {
  const text = (chapter.scenes ?? []).flatMap((scene) => scene.paragraphs ?? []).join('\n\n');
  const mentioned = new Map();

  for (const entry of codexEntries) {
    const terms = [entry.name, ...(entry.aliases ?? [])].map((term) => String(term ?? '').trim()).filter(Boolean);
    if (terms.some((term) => containsTerm(text, term))) {
      mentioned.set(`${entry.category}:${entry.id}`, entry);
    }
  }

  return [...mentioned.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function containsTerm(text, term) {
  let from = text.indexOf(term);
  while (from !== -1) {
    const to = from + term.length;
    if (hasMentionBoundary(text, from, to)) return true;
    from = text.indexOf(term, from + 1);
  }
  return false;
}

function hasMentionBoundary(text, from, to) {
  const before = text[from - 1];
  const after = text[to];
  const startsWord = isWordLike(text[from]);
  const endsWord = isWordLike(text[to - 1]);
  return !(startsWord && isWordLike(before)) && !(endsWord && isWordLike(after));
}

function isWordLike(value) {
  return Boolean(value && /[\p{L}\p{N}_'-]/u.test(value));
}

function titleCase(value) {
  return String(value).replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}
