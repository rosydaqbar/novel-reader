import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_MODEL = 'gpt-5.6-terra';
const PROVIDERS = new Set(['chatgpt', 'agentrouter', 'opencode', 'custom']);
const AGENTROUTER_URL = 'https://agentrouter.org';
const OPENAI_URL = 'https://api.openai.com';
const CHATGPT_ISSUER = 'https://auth.openai.com';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;
const CHATGPT_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
const CHATGPT_COMPLETIONS_URL = 'https://chatgpt.com/backend-api/codex/chat/completions';
const chatgptFlows = new Map();

export function createAIRouter({ settingsFile = path.join('datasource', 'ai-settings.json'), fetchFn = globalThis.fetch, flowOpts = {} } = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function.');
  const flowOptions = {
    intervalMs: Number.isFinite(flowOpts.intervalMs) ? Math.max(1, flowOpts.intervalMs) : null,
    maxWaitMs: Number.isFinite(flowOpts.maxWaitMs) ? Math.max(1, flowOpts.maxWaitMs) : 15 * 60 * 1000
  };

  const router = express.Router();

  router.get('/api/ai/status', async (_request, response, next) => {
    try {
      const settings = await readSettings(settingsFile);
      const auth = await resolveAuth(settings);
      response.json({
        configured: settings.provider !== null,
        provider: settings.provider,
        model: settings.model,
        authed: Boolean(auth?.apiKey)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/ai/signin', async (request, response, next) => {
    try {
      const provider = request.body?.provider;
      if (!PROVIDERS.has(provider)) {
        response.status(400).json({ ok: false, error: 'invalid_provider' });
        return;
      }

      if (provider === 'chatgpt') {
        const userCodeResponse = await fetchFn(`${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID })
        });
        if (!userCodeResponse.ok) throw new Error(await upstreamErrorMessage(userCodeResponse));
        const { device_auth_id: deviceAuthId, user_code: userCode, interval } = await userCodeResponse.json();
        if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') throw new Error('invalid_device_code_response');

        const flowId = randomUUID();
        const flow = {
          deviceAuthId,
          userCode,
          interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
          status: 'awaiting',
          settingsFile,
          fetchFn,
          flowOptions
        };
        chatgptFlows.set(flowId, flow);
        startChatgptFlow(flow);
        response.json({ ok: true, pending: true, flowId, verificationUrl: CHATGPT_VERIFICATION_URL, userCode });
        return;
      }

      const settings = await readSettings(settingsFile);
      const apiKey = typeof request.body?.apiKey === 'string' ? request.body.apiKey.trim() : '';
      const baseUrl = typeof request.body?.baseUrl === 'string' ? request.body.baseUrl.trim() : '';
      await writeSettings(settingsFile, {
        ...settings,
        provider,
        custom: {
          apiKey: apiKey || settings.custom.apiKey,
          baseUrl: baseUrl || settings.custom.baseUrl
        }
      });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/ai/signin/:flowId', (request, response) => {
    const flow = chatgptFlows.get(request.params.flowId);
    if (!flow) {
      response.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    if (flow.status === 'awaiting') {
      response.json({ ok: true, pending: true });
      return;
    }
    if (flow.status === 'authenticated') {
      response.json({ ok: true, authed: true });
      return;
    }
    response.json({ ok: false, error: flow.status, message: flow.error || flow.status });
  });

  router.post('/api/ai/chat', async (request, response) => {
    startSse(response);
    try {
      const settings = await readSettings(settingsFile);
      const auth = await resolveAuth(settings);
      if (!settings.provider || !auth?.apiKey) {
        sendEvent(response, 'error', { message: 'not_configured' });
        response.end();
        return;
      }

      const messages = Array.isArray(request.body?.messages) ? request.body.messages : null;
      if (!messages) {
        sendEvent(response, 'error', { message: 'invalid_messages' });
        response.end();
        return;
      }

      let upstream = await requestChatCompletion(fetchFn, settings, auth, request.body, messages);
      if (upstream.status === 401 && settings.provider === 'chatgpt' && auth.chatgpt && auth.refreshToken) {
        const refreshed = await refreshChatgptTokens(settingsFile, settings, auth, fetchFn);
        if (refreshed) upstream = await requestChatCompletion(fetchFn, settings, refreshed, request.body, messages);
      }

      if (!upstream.ok) {
        sendEvent(response, 'error', { message: await upstreamErrorMessage(upstream) });
        response.end();
        return;
      }
      await forwardStream(upstream.body, response);
    } catch (error) {
      sendEvent(response, 'error', { message: error?.message || 'upstream_request_failed' });
    }
    response.end();
  });

  return router;
}

async function readSettings(settingsFile) {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsFile, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return normalizeSettings();
    throw error;
  }
}

async function writeSettings(settingsFile, settings) {
  await mkdir(path.dirname(path.resolve(settingsFile)), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, 'utf8');
}

function normalizeSettings(settings = {}) {
  return {
    provider: PROVIDERS.has(settings.provider) ? settings.provider : null,
    model: typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : DEFAULT_MODEL,
    custom: {
      apiKey: typeof settings.custom?.apiKey === 'string' ? settings.custom.apiKey : '',
      baseUrl: typeof settings.custom?.baseUrl === 'string' ? settings.custom.baseUrl.replace(/\/+$/, '') : ''
    },
    auth: settings.auth && typeof settings.auth === 'object' && !Array.isArray(settings.auth) ? settings.auth : {}
  };
}

async function resolveAuth(settings) {
  if (settings.provider === 'chatgpt') {
    const tokens = settings.auth?.chatgpt?.tokens;
    if (typeof tokens?.access_token === 'string' && tokens.access_token.trim()) {
      return chatgptAuth(tokens);
    }
    return null;
  }
  if (settings.provider === 'opencode') return (await readOpenCodeAuth()) ?? keyAuth(settings.custom.apiKey);
  return keyAuth(settings.custom.apiKey);
}

function keyAuth(apiKey) {
  return apiKey ? { apiKey } : null;
}

function chatgptAuth(tokens) {
  const accessToken = tokens.access_token.trim();
  return {
    apiKey: accessToken,
    chatgpt: true,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    accountId: typeof tokens.account_id === 'string' ? tokens.account_id : accountIdFromToken(tokens.id_token) || accountIdFromToken(accessToken)
  };
}

async function readOpenCodeAuth() {
  const auth = await readJson(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
  const provider = auth?.providers?.openai ?? auth?.openai;
  const apiKey = provider?.apiKey ?? provider?.api_key ?? provider?.token ?? provider?.key;
  return typeof apiKey === 'string' && apiKey.trim() ? { apiKey: apiKey.trim() } : null;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function providerBaseUrl(provider, settings) {
  if (provider === 'agentrouter') return AGENTROUTER_URL;
  if (provider === 'custom') return settings.custom.baseUrl || OPENAI_URL;
  return OPENAI_URL;
}

function startChatgptFlow(flow) {
  const pollDelay = flow.flowOptions.intervalMs ?? flow.interval * 1000;
  const expire = () => {
    if (flow.status === 'awaiting') {
      flow.status = 'expired';
      flow.error = 'Device authorization expired';
    }
    clearChatgptFlowTimers(flow);
  };
  flow.expireTimer = setTimeout(expire, flow.flowOptions.maxWaitMs);
  flow.expireTimer.unref?.();
  const poll = async () => {
    if (flow.status !== 'awaiting') return;
    try {
      const tokenResponse = await flow.fetchFn(`${CHATGPT_ISSUER}/api/accounts/deviceauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode })
      });
      if (tokenResponse.ok) {
        const deviceToken = await tokenResponse.json();
        await completeChatgptFlow(flow, deviceToken);
        return;
      }
      if (tokenResponse.status !== 403 && tokenResponse.status !== 404) {
        throw new Error(await upstreamErrorMessage(tokenResponse));
      }
    } catch (error) {
      flow.status = 'failed';
      flow.error = error?.message || 'device_authorization_failed';
      clearChatgptFlowTimers(flow);
      return;
    }
    if (flow.status === 'awaiting') {
      flow.pollTimer = setTimeout(poll, pollDelay);
      flow.pollTimer.unref?.();
    }
  };
  flow.pollTimer = setTimeout(poll, pollDelay);
  flow.pollTimer.unref?.();
}

async function completeChatgptFlow(flow, deviceToken) {
  const { authorization_code: authorizationCode, code_verifier: codeVerifier, code_challenge: codeChallenge } = deviceToken;
  if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string' || typeof codeChallenge !== 'string') throw new Error('invalid_device_token_response');
  const tokenResponse = await flow.fetchFn(`${CHATGPT_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: CHATGPT_REDIRECT_URI,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: codeVerifier
    }).toString()
  });
  if (!tokenResponse.ok) throw new Error(await upstreamErrorMessage(tokenResponse));
  const tokens = await tokenResponse.json();
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('invalid_oauth_token_response');
  if (flow.status !== 'awaiting') return;
  const savedTokens = withAccountId(tokens);
  const settings = await readSettings(flow.settingsFile);
  await writeSettings(flow.settingsFile, {
    ...settings,
    provider: 'chatgpt',
    auth: { ...settings.auth, chatgpt: { tokens: savedTokens, last_refresh: new Date().toISOString() } }
  });
  flow.status = 'authenticated';
  clearChatgptFlowTimers(flow);
}

function clearChatgptFlowTimers(flow) {
  if (flow.pollTimer) clearTimeout(flow.pollTimer);
  if (flow.expireTimer) clearTimeout(flow.expireTimer);
  flow.pollTimer = null;
  flow.expireTimer = null;
}

async function requestChatCompletion(fetchFn, settings, auth, body, messages) {
  const headers = {
    Accept: 'text/event-stream',
    Authorization: `Bearer ${auth.apiKey}`,
    'Content-Type': 'application/json'
  };
  if (auth.chatgpt && auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
  return fetchFn(auth.chatgpt ? CHATGPT_COMPLETIONS_URL : `${providerBaseUrl(settings.provider, settings)}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      messages,
      ...(body?.tools === undefined ? {} : { tools: body.tools }),
      stream: true
    })
  });
}

async function refreshChatgptTokens(settingsFile, settings, auth, fetchFn) {
  const response = await fetchFn(`${CHATGPT_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: CHATGPT_REDIRECT_URI
    }).toString()
  });
  if (!response.ok) return null;
  const tokens = await response.json();
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) return null;
  const previousTokens = settings.auth?.chatgpt?.tokens ?? {};
  const savedTokens = withAccountId({ ...previousTokens, ...tokens, refresh_token: tokens.refresh_token || auth.refreshToken });
  await writeSettings(settingsFile, {
    ...settings,
    auth: { ...settings.auth, chatgpt: { tokens: savedTokens, last_refresh: new Date().toISOString() } }
  });
  return chatgptAuth(savedTokens);
}

function withAccountId(tokens) {
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : accountIdFromToken(tokens.id_token) || accountIdFromToken(tokens.access_token);
  return { ...tokens, ...(accountId ? { account_id: accountId } : {}) };
}

function accountIdFromToken(token) {
  if (typeof token !== 'string') return '';
  const payload = token.split('.')[1];
  if (!payload) return '';
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed.account_id === 'string' ? parsed.account_id : '';
  } catch {
    return '';
  }
}

function startSse(response) {
  response.set({ 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream; charset=utf-8' });
  response.flushHeaders();
}

function sendEvent(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

async function forwardStream(body, response) {
  if (!body) throw new Error('upstream_stream_missing');
  const decoder = new TextDecoder();
  let buffer = '';
  const calls = new Map();
  let sentDone = false;
  let streamErrored = false;

  const flushCalls = () => {
    for (const call of calls.values()) {
      if (call.name) sendEvent(response, 'tool_use', { name: call.name, arguments: call.arguments });
    }
    calls.clear();
  };
  const handle = (data) => {
    if (data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload.error) {
      sendEvent(response, 'error', { message: payload.error.message || 'upstream_error' });
      streamErrored = true;
      return;
    }
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) sendEvent(response, 'text_delta', { text: delta.content });
      for (const part of delta.tool_calls ?? []) {
        const key = Number.isInteger(part.index) ? part.index : calls.size;
        const existing = calls.get(key);
        if (existing && ((part.id && part.id !== existing.id) || (part.function?.name && existing.name && part.function.name !== existing.name))) {
          if (existing.name) sendEvent(response, 'tool_use', { name: existing.name, arguments: existing.arguments });
          calls.delete(key);
        }
        const call = calls.get(key) ?? { id: part.id, name: '', arguments: '' };
        call.id ||= part.id;
        call.name ||= part.function?.name ?? '';
        call.arguments += part.function?.arguments ?? '';
        calls.set(key, call);
      }
      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') flushCalls();
        sendEvent(response, 'done', { stopReason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason });
        sentDone = true;
      }
    }
  };
  const consume = (chunk) => {
    buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) handle(data);
    }
  };
  for await (const chunk of body) consume(chunk);
  if (buffer.trim()) {
    const data = buffer.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) handle(data);
  }
  if (!streamErrored) {
    if (calls.size) flushCalls();
    if (!sentDone) sendEvent(response, 'done', { stopReason: 'end_turn' });
  }
}

async function upstreamErrorMessage(response) {
  try {
    const body = await response.json();
    return body?.error?.message || body?.message || `upstream_error_${response.status}`;
  } catch {
    return `upstream_error_${response.status}`;
  }
}
