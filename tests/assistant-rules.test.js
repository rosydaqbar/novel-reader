import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANTI_AI_SLOP_RULES,
  BANNED_WORDS,
  HUMANIZER_RULES,
  RULE_FILES,
  buildGuardPrompt,
  composeSystemPrompt
} from '../src/assistant/writingRules.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('composeSystemPrompt embeds bundled rules and agent-loop instructions', () => {
  const prompt = composeSystemPrompt({
    projectTitle: 'Moonlit Archive',
    characterNames: ['Aria'],
    codexNames: ['Glass Sea']
  });

  assert.match(prompt, /## Humanizer rules/);
  assert.ok(prompt.includes(HUMANIZER_RULES));
  assert.match(prompt, /## Anti-AI-slop rules/);
  assert.ok(prompt.includes(ANTI_AI_SLOP_RULES));
  assert.match(prompt, /## Banned words and phrases/);
  assert.ok(prompt.includes(BANNED_WORDS));
  assert.match(prompt, /Call tools before loading everything\. Observe tool results\./);
  assert.match(prompt, /If context is thin, follow the codex mention chain\./);
  assert.match(prompt, /Never fabricate codex entries or characters\./);
  assert.match(prompt, /End with finalize\./);
});

test('buildGuardPrompt contains the project-scoped rubric and JSON contract', () => {
  const prompt = buildGuardPrompt({
    projectTitle: 'Moonlit Archive',
    codexNames: ['Glass Sea'],
    chapterTitles: ['Arrival'],
    mode: 'continuation',
    prompt: 'Continue Aria\'s scene.'
  });

  assert.match(prompt, /outlines, half-formed thoughts, scene beats/i);
  assert.match(prompt, /genuinely unrelated subjects/i);
  assert.match(prompt, /\{"verdict":"in_topic"\|"out_of_topic","reason":"<short reason>"\}/);
});

test('RULE_FILES reference bundled rule files on disk', () => {
  for (const ruleFile of RULE_FILES) {
    assert.ok(fs.existsSync(path.join(rootDirectory, ruleFile)), `${ruleFile} should exist`);
  }
});
