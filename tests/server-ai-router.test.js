import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAIRouter } from '../server/aiRouter.js';

test('AI router configures providers and streams OpenAI-compatible responses', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-ai-router-'));
  const settingsFile = path.join(directory, 'ai-settings.json');
  const homeDirectory = path.join(directory, 'home');
  await mkdir(homeDirectory, { recursive: true });
  const originalHomedir = os.homedir;
  os.homedir = () => homeDirectory;
  t.after(async () => {
    os.homedir = originalHomedir;
    await rm(directory, { recursive: true, force: true });
  });

  const requests = [];
  const context = await startRouter(t, settingsFile, async (url, init) => {
    requests.push({ url, init });
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]);
  });

  let response = await context.fetch('/api/ai/status');
  assert.deepEqual(await response.json(), { configured: false, provider: null, model: 'gpt-5.6-terra', authed: false });

  response = await context.fetch('/api/ai/signin', jsonPost({ provider: 'agentrouter', apiKey: 'router-secret' }));
  assert.deepEqual(await response.json(), { ok: true });
  response = await context.fetch('/api/ai/status');
  assert.deepEqual(await response.json(), { configured: true, provider: 'agentrouter', model: 'gpt-5.6-terra', authed: true });

  response = await context.fetch('/api/ai/chat', jsonPost({ messages: [{ role: 'user', content: 'Write.' }] }));
  const events = parseEvents(await response.text());
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'Hello' },
    { type: 'text_delta', text: ' world' },
    { type: 'done', stopReason: 'end_turn' }
  ]);
  assert.equal(requests[0].url, 'https://agentrouter.org/v1/chat/completions');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer router-secret');

});

test('AI router uses saved ChatGPT tokens, buffers tool call arguments, and passes upstream errors through SSE', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-ai-router-'));
  const settingsFile = path.join(directory, 'ai-settings.json');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  let shouldFail = false;
  const context = await startRouter(t, settingsFile, async (url) => {
    if (url.endsWith('/usercode')) return jsonResponse({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 });
    if (shouldFail) return new Response(JSON.stringify({ error: { message: 'upstream denied' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    return sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_scenes","arguments":"{\\\"query\\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"moon\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    ]);
  });
  await writeFile(settingsFile, JSON.stringify({ provider: 'chatgpt' }));
  assert.equal((await (await context.fetch('/api/ai/status')).json()).authed, false);

  const signin = await context.fetch('/api/ai/signin', jsonPost({ provider: 'chatgpt' }));
  const pending = await signin.json();
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal(typeof pending.flowId, 'string');
  assert.equal(pending.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(pending.note, undefined);

  await writeFile(settingsFile, JSON.stringify({ provider: 'chatgpt', auth: { chatgpt: { tokens: { access_token: 'saved-token' } } } }));

  let response = await context.fetch('/api/ai/chat', jsonPost({ messages: [] }));
  assert.deepEqual(parseEvents(await response.text()), [
    { type: 'tool_use', name: 'search_scenes', arguments: '{"query":"moon"}' },
    { type: 'done', stopReason: 'tool_use' }
  ]);

  shouldFail = true;
  response = await context.fetch('/api/ai/chat', jsonPost({ messages: [] }));
  assert.deepEqual(parseEvents(await response.text()), [{ type: 'error', message: 'upstream denied' }]);
});

test('AI router completes ChatGPT device authentication and uses its access token', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-ai-router-'));
  const settingsFile = path.join(directory, 'ai-settings.json');
  let approved = false;
  const requests = [];
  const context = await startRouter(t, settingsFile, async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/usercode')) return jsonResponse({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 });
    if (url.endsWith('/deviceauth/token')) return approved
      ? jsonResponse({ authorization_code: 'authorization-code', code_verifier: 'verifier', code_challenge: 'challenge' })
      : jsonResponse({}, 403);
    if (url.endsWith('/oauth/token')) return jsonResponse({ id_token: jwt({ account_id: 'account-1' }), access_token: 'chatgpt-access', refresh_token: 'refresh-1' });
    if (url === 'https://chatgpt.com/backend-api/codex/chat/completions') return sseResponse(['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n']);
    throw new Error(`Unexpected request: ${url}`);
  }, { intervalMs: 5 });

  const signin = await context.fetch('/api/ai/signin', jsonPost({ provider: 'chatgpt' }));
  const pending = await signin.json();
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(pending.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(pending).includes('codex_login_required'), false);
  assert.deepEqual(await (await context.fetch(`/api/ai/signin/${pending.flowId}`)).json(), { ok: true, pending: true });

  approved = true;
  await waitFor(async () => (await (await context.fetch(`/api/ai/signin/${pending.flowId}`)).json()).authed === true);
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual(settings.auth.chatgpt.tokens, {
    id_token: jwt({ account_id: 'account-1' }),
    access_token: 'chatgpt-access',
    refresh_token: 'refresh-1',
    account_id: 'account-1'
  });
  assert.equal((await (await context.fetch('/api/ai/status')).json()).authed, true);

  const response = await context.fetch('/api/ai/chat', jsonPost({ messages: [] }));
  assert.deepEqual(parseEvents(await response.text()), [{ type: 'text_delta', text: 'Done' }, { type: 'done', stopReason: 'end_turn' }]);
  const chatRequest = requests.find((request) => request.url === 'https://chatgpt.com/backend-api/codex/chat/completions');
  assert.equal(chatRequest.init.headers.Authorization, 'Bearer chatgpt-access');
  assert.equal(chatRequest.init.headers['ChatGPT-Account-Id'], 'account-1');
});

test('AI router refreshes ChatGPT tokens after one unauthorized response', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-ai-router-'));
  const settingsFile = path.join(directory, 'ai-settings.json');
  await writeFile(settingsFile, JSON.stringify({ provider: 'chatgpt', auth: { chatgpt: { tokens: { access_token: 'old-access', refresh_token: 'refresh-1' } } } }));
  const requests = [];
  const context = await startRouter(t, settingsFile, async (url, init) => {
    requests.push({ url, init });
    if (url === 'https://chatgpt.com/backend-api/codex/chat/completions' && init.headers.Authorization === 'Bearer old-access') return jsonResponse({ error: { message: 'expired' } }, 401);
    if (url.endsWith('/oauth/token')) return jsonResponse({ access_token: 'new-access', refresh_token: 'refresh-2' });
    if (url === 'https://chatgpt.com/backend-api/codex/chat/completions') return sseResponse(['data: {"choices":[{"delta":{"content":"Fresh"},"finish_reason":"stop"}]}\n\n']);
    throw new Error(`Unexpected request: ${url}`);
  });

  const response = await context.fetch('/api/ai/chat', jsonPost({ messages: [] }));
  assert.deepEqual(parseEvents(await response.text()), [{ type: 'text_delta', text: 'Fresh' }, { type: 'done', stopReason: 'end_turn' }]);
  assert.deepEqual(requests.filter((request) => request.url === 'https://chatgpt.com/backend-api/codex/chat/completions').map((request) => request.init.headers.Authorization), ['Bearer old-access', 'Bearer new-access']);
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(settings.auth.chatgpt.tokens.access_token, 'new-access');
  assert.equal(settings.auth.chatgpt.tokens.refresh_token, 'refresh-2');
});

test('AI router expires unapproved ChatGPT device flows', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-ai-router-'));
  const settingsFile = path.join(directory, 'ai-settings.json');
  const context = await startRouter(t, settingsFile, async (url) => {
    if (url.endsWith('/usercode')) return jsonResponse({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 1 });
    if (url.endsWith('/deviceauth/token')) return jsonResponse({}, 403);
    throw new Error(`Unexpected request: ${url}`);
  }, { intervalMs: 1, maxWaitMs: 15 });

  const { flowId } = await (await context.fetch('/api/ai/signin', jsonPost({ provider: 'chatgpt' }))).json();
  await waitFor(async () => (await (await context.fetch(`/api/ai/signin/${flowId}`)).json()).error === 'expired');
  const status = await (await context.fetch(`/api/ai/signin/${flowId}`)).json();
  assert.deepEqual(status, { ok: false, error: 'expired', message: 'Device authorization expired' });
});

async function startRouter(t, settingsFile, fetchFn, flowOpts) {
  const app = express();
  app.use(express.json());
  app.use(createAIRouter({ settingsFile, fetchFn, flowOpts }));
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  t.after(async () => {
    listener.closeAllConnections?.();
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  });
  return { fetch: (route, init) => fetch(`http://127.0.0.1:${port}${route}`, init) };
}

function jsonPost(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function waitFor(predicate, timeout = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

function parseEvents(body) {
  return body.trim().split('\n\n').filter(Boolean).map((event) => JSON.parse(event.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
}
