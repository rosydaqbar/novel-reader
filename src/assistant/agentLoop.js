function projectContext(context) {
  return `Project context:\n${JSON.stringify({
    anchorChapter: context?.anchorChapter ?? null,
    selection: context?.selection ?? null,
    selections: context?.selections ?? [],
    codexEntries: context?.codexEntries ?? [],
    chain: context?.chain ?? []
  })}`;
}

function parseObservation(result) {
  if (typeof result !== 'string') return result;
  try {
    return JSON.parse(result);
  } catch {
    return { error: 'Tool returned an invalid observation.' };
  }
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value?.message ?? value ?? 'Unknown error');
}

export async function runAgent({
  prompt,
  context,
  systemPrompt,
  tools,
  llmClient,
  maxIterations = 12,
  signal,
  onEvent
}) {
  const transcript = [];
  const messages = [
    { role: 'system', content: systemPrompt ?? '' },
    { role: 'user', content: projectContext(context) },
    { role: 'user', content: String(prompt ?? '') }
  ];
  transcript.push(...messages.map(({ role, content }) => ({ role, content })));
  const emit = (type, payload) => onEvent?.(type, payload);
  const updateTranscript = () => emit('transcript_updated', [...transcript]);
  updateTranscript();

  let finalProse;
  let stopReason;
  let iterations = 0;
  let previousCall;
  let failureMessage;

  const finish = () => {
    const result = { finalProse, transcript, iterations, stopReason };
    emit('done', result);
    return result;
  };

  while (!stopReason && iterations < maxIterations) {
    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    iterations += 1;
    emit('iteration', { n: iterations });
    const assistantText = [];
    const toolUses = [];
    let requestDone;

    const receive = (event, payload) => {
      const type = typeof event === 'string' ? event : event?.type;
      const data = typeof event === 'string' ? payload : event;
      if (type === 'text_delta') {
        const text = String(data?.text ?? data?.delta ?? payload?.text ?? payload?.delta ?? '');
        assistantText.push(text);
        emit('thought', text);
        emit('text_delta', text);
      } else if (type === 'tool_use') {
        toolUses.push({
          id: data?.id ?? payload?.id ?? `tool-${iterations}-${toolUses.length + 1}`,
          name: data?.name ?? payload?.name,
          arguments: data?.arguments ?? data?.input ?? payload?.arguments ?? payload?.input ?? '{}'
        });
      } else if (type === 'done') {
        requestDone = data?.stopReason ?? data?.stop_reason ?? payload?.stopReason ?? payload?.stop_reason ?? 'end_turn';
      } else if (type === 'error') {
        failureMessage = errorMessage(data?.message ?? payload?.message ?? data);
        emit('error', { message: failureMessage });
      }
    };

    try {
      await llmClient.request({ messages, tools: tools.definitions, onEvent: receive, signal });
    } catch (error) {
      failureMessage = errorMessage(error);
      emit('error', { message: failureMessage });
    }

    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (failureMessage) {
      stopReason = 'error';
      break;
    }

    const assistantMessage = {
      role: 'assistant',
      content: assistantText.join(''),
      tool_calls: toolUses.map((toolUse) => ({ id: toolUse.id, type: 'function', function: { name: toolUse.name, arguments: typeof toolUse.arguments === 'string' ? toolUse.arguments : JSON.stringify(toolUse.arguments ?? {}) } }))
    };
    messages.push(assistantMessage);
    transcript.push({ role: 'assistant', content: assistantMessage.content, tool_calls: assistantMessage.tool_calls });
    updateTranscript();

    if (!toolUses.length) {
      if (requestDone === 'end_turn' || requestDone) {
        finalProse = assistantMessage.content || undefined;
        stopReason = requestDone;
      } else {
        stopReason = 'error';
        failureMessage = 'LLM request ended without a completion event.';
        emit('error', { message: failureMessage });
      }
      continue;
    }

    for (const toolUse of toolUses) {
      let args;
      try {
        args = typeof toolUse.arguments === 'string' ? JSON.parse(toolUse.arguments) : toolUse.arguments ?? {};
      } catch {
        args = null;
      }
      const key = `${toolUse.name}:${JSON.stringify(args ?? toolUse.arguments)}`;
      if (key === previousCall) {
        transcript.push({ role: 'system', content: 'Stopped: the same tool call was requested twice consecutively.' });
        messages.push({ role: 'system', content: 'Stopped: the same tool call was requested twice consecutively.' });
        updateTranscript();
        stopReason = 'loop_detected';
        break;
      }
      previousCall = key;
      emit('tool_started', { name: toolUse.name, args });
      const result = args === null
        ? JSON.stringify({ error: 'Tool arguments were not valid JSON.' })
        : tools.execute(toolUse.name, args);
      const observation = parseObservation(result);
      emit('tool_completed', { name: toolUse.name, result });
      const toolMessage = { role: 'tool', tool_call_id: toolUse.id, content: typeof result === 'string' ? result : JSON.stringify(result) };
      messages.push(toolMessage);
      transcript.push({ role: 'tool', content: toolMessage.content });
      updateTranscript();
      if (observation?.__final !== undefined) {
        finalProse = observation.__final;
        stopReason = 'finalize';
        break;
      }
    }
  }

  if (!stopReason) stopReason = 'max_iterations';
  return finish();
}
