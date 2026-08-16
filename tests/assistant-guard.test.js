import assert from 'node:assert/strict';
import test from 'node:test';

import { checkHeuristic, runGuard } from '../src/assistant/guard.js';
import { completeJSON } from '../src/assistant/llmClient.js';

const projectFacts = {
  title: 'Moonlit Harbor',
  characterNames: ['Aria'],
  codexNames: ['Silver Lantern'],
  codexAliases: ['The Singer'],
  chapterTitles: ['Arrival at Dawn']
};

test('guard heuristic passes project title, names, aliases, and chapter titles', () => {
  for (const prompt of ['Continue Moonlit Harbor.', 'What would Aria say?', 'Use The Singer here.', 'Revise Arrival at Dawn.']) {
    assert.equal(checkHeuristic({ prompt, projectFacts }).result, 'in_topic');
  }
});

test('guard heuristic halts clearly unrelated prompts', () => {
  const result = checkHeuristic({ prompt: 'Write a JavaScript API for a recipe app.', projectFacts });
  assert.equal(result.result, 'out_of_topic');
  assert.match(result.reason, /unrelated/i);
});

test('ambiguous prompts route to the LLM rubric', async () => {
  let request;
  const result = await runGuard({
    prompt: 'Could this opening beat work?',
    mode: 'manual',
    projectFacts,
    llmClient: { async request(options) { request = options; options.onEvent({ type: 'text_delta', text: '{"verdict":"in_topic","reason":"Writing advice."}' }); } }
  });
  assert.equal(result.verdict, 'in_topic');
  assert.match(request.messages[0].content, /Moonlit Harbor/);
  assert.equal(request.messages[0].content.includes('Could this opening beat work?'), true);
});

test('guard maps rubric in-topic and out-of-topic verdicts', async () => {
  for (const [verdict, reason] of [['in_topic', 'Story planning.'], ['out_of_topic', 'Unrelated homework.']]) {
    const result = await runGuard({
      prompt: 'Could this opening beat work?', mode: 'manual', projectFacts,
      llmClient: { async request({ onEvent }) { onEvent({ type: 'text_delta', text: JSON.stringify({ verdict, reason }) }); } }
    });
    assert.deepEqual(result, { verdict, reason, skipped: false });
  }
});

test('guard fails open when its LLM request fails', async () => {
  const result = await runGuard({
    prompt: 'Could this opening beat work?', mode: 'manual', projectFacts,
    llmClient: { async request() { throw new Error('not configured'); } }
  });
  assert.deepEqual(result, { verdict: 'in_topic', skipped: true, reason: 'Guard unavailable, skipped' });
});

test('completeJSON collects streamed text deltas and rejects error events', async () => {
  const llmClient = {
    async request({ onEvent }) {
      onEvent({ type: 'text_delta', text: '{"verdict":' });
      onEvent({ type: 'text_delta', text: '"in_topic"}' });
    }
  };
  assert.equal(await completeJSON({ system: 'system', user: 'user', llmClient }), '{"verdict":"in_topic"}');
  await assert.rejects(
    completeJSON({ system: 'system', user: 'user', llmClient: { async request({ onEvent }) { onEvent({ type: 'error', message: 'not configured' }); } } }),
    /LLM completion failed: not configured/
  );
});
