function endpointFor(baseUrl) {
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}/api/ai/chat`;
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value?.message ?? value ?? 'Unknown LLM error');
}

async function responseError(response) {
  try {
    const body = await response.json();
    return body?.error?.message ?? body?.message ?? `LLM request failed with status ${response.status}`;
  } catch {
    return `LLM request failed with status ${response.status}`;
  }
}

function parseSseEvent(block, onEvent) {
  let type = 'message';
  const data = [];

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }

  const payload = data.join('\n');
  if (!payload) return;
  if (payload === '[DONE]') {
    onEvent?.({ type: 'done', stopReason: 'end_turn' });
    return;
  }

  try {
    const value = JSON.parse(payload);
    if (type === 'text_delta' && typeof value?.text === 'string') onEvent?.({ type, text: value.text });
    if (type === 'tool_use' && typeof value?.name === 'string') onEvent?.({ type, name: value.name, arguments: value.arguments });
    if (type === 'done') onEvent?.({ type, stopReason: value?.stopReason ?? 'end_turn' });
    if (type === 'error') onEvent?.({ type, message: errorMessage(value?.message) });
  } catch {
    onEvent?.({ type: 'error', message: 'Invalid SSE event payload.' });
  }
}

export function createLLMClient({ baseUrl = '' } = {}) {
  return {
    async request({ messages, tools, signal, onEvent }) {
      const response = await fetch(endpointFor(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages, tools }),
        signal
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.body) throw new Error('LLM response did not include a stream.');

      const decoder = new TextDecoder();
      let buffer = '';
      const consume = (chunk) => {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let separator;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          parseSseEvent(buffer.slice(0, separator), onEvent);
          buffer = buffer.slice(separator + 2);
        }
      };

      if (Symbol.asyncIterator in response.body) {
        for await (const chunk of response.body) consume(chunk);
      } else {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            consume(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) parseSseEvent(buffer, onEvent);
    }
  };
}

export async function completeJSON({ system, user, temperature, maxTokens, llmClient, signal }) {
  const chunks = [];
  let streamError;
  await llmClient.request({
    messages: [
      { role: 'system', content: String(system ?? '') },
      { role: 'user', content: String(user ?? '') }
    ],
    signal,
    onEvent(event) {
      if (event?.type === 'text_delta') chunks.push(String(event.text ?? ''));
      if (event?.type === 'error') streamError = errorMessage(event.message);
    },
    temperature,
    maxTokens
  });
  if (streamError) throw new Error(`LLM completion failed: ${streamError}`);
  return chunks.join('');
}
