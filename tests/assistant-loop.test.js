import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgent } from '../src/assistant/agentLoop.js';

function createTools(execute = (name) => JSON.stringify({ name, loaded: true })) {
  return {
    definitions: [{ name: 'load_chapter', description: 'Load a chapter.', parameters: { type: 'object', properties: {}, required: [] } }],
    execute(name, args) {
      return name === 'finalize' ? JSON.stringify({ __final: args.prose }) : execute(name, args);
    }
  };
}

function scriptedClient(steps) {
  let index = 0;
  return {
    async request({ onEvent, signal }) {
      for (const event of steps[index++] ?? []) {
        if (signal?.aborted) return;
        onEvent(event.type, event);
      }
    }
  };
}

test('agent loop resumes through tool observations and finalizes staged prose', async () => {
  const events = [];
  const result = await runAgent({
    prompt: 'Continue the scene.',
    context: { anchorChapter: { id: 'chapter-1' }, selection: null, codexEntries: [], chain: [] },
    systemPrompt: 'Use the tools.',
    tools: createTools((name, args) => JSON.stringify({ name, args, text: 'fixture' })),
    llmClient: scriptedClient([
      [{ type: 'text_delta', text: 'I will check. ' }, { type: 'tool_use', id: 'one', name: 'load_chapter', arguments: '{"chapterId":"chapter-1"}' }],
      [{ type: 'tool_use', id: 'two', name: 'load_codex_entry', arguments: '{"entryId":"aria"}' }],
      [{ type: 'tool_use', id: 'three', name: 'finalize', arguments: '{"prose":"Aria entered the rain."}' }, { type: 'done', stopReason: 'end_turn' }]
    ]),
    onEvent: (type) => events.push(type)
  });

  assert.equal(result.finalProse, 'Aria entered the rain.');
  assert.equal(result.stopReason, 'finalize');
  assert.equal(result.iterations, 3);
  assert.equal(result.transcript.filter((message) => message.role === 'assistant').length, 3);
  assert.equal(result.transcript.filter((message) => message.role === 'tool').length, 3);
  assert.deepEqual(events.filter((type) => type === 'iteration' || type === 'tool_started' || type === 'tool_completed'), [
    'iteration', 'tool_started', 'tool_completed', 'iteration', 'tool_started', 'tool_completed', 'iteration', 'tool_started', 'tool_completed'
  ]);
  assert.equal(events.at(-1), 'done');
});

test('agent loop enforces the iteration cap and detects repeated calls', async () => {
  const alwaysTool = { async request({ onEvent }) { onEvent('tool_use', { name: 'search_scenes', arguments: '{"query":"new"}' }); } };
  const capped = await runAgent({ prompt: 'x', context: {}, systemPrompt: '', tools: createTools(), llmClient: alwaysTool });
  assert.equal(capped.stopReason, 'loop_detected');

  const changingTool = { let: 0, async request({ onEvent }) { onEvent('tool_use', { name: 'search_scenes', arguments: JSON.stringify({ query: String(this.let++) }) }); } };
  const maxed = await runAgent({ prompt: 'x', context: {}, systemPrompt: '', tools: createTools(), llmClient: changingTool });
  assert.equal(maxed.stopReason, 'max_iterations');
  assert.equal(maxed.iterations, 12);
});

test('agent loop preserves tool errors and handles an aborted signal', async () => {
  const errorThenFinal = await runAgent({
    prompt: 'x', context: {}, systemPrompt: '', tools: createTools(() => JSON.stringify({ error: 'missing chapter' })),
    llmClient: scriptedClient([
      [{ type: 'tool_use', name: 'load_chapter', arguments: '{"chapterId":"missing"}' }],
      [{ type: 'tool_use', name: 'finalize', arguments: '{"prose":"Recovered."}' }]
    ])
  });
  assert.equal(errorThenFinal.finalProse, 'Recovered.');
  assert.match(errorThenFinal.transcript.find((message) => message.role === 'tool').content, /missing chapter/);

  const controller = new AbortController();
  const aborted = await runAgent({
    prompt: 'x', context: {}, systemPrompt: '', tools: createTools(), signal: controller.signal,
    llmClient: { async request() { controller.abort(); } }
  });
  assert.equal(aborted.stopReason, 'aborted');
});
