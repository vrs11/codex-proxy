import { ProxyError, responseFailure } from './errors.js';
import { parseSSE, terminalEvent, ResponseAssembler, writeSSE } from './sse.js';

export function chatUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}),
  };
}

function finishReason(response) {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    throw new ProxyError(`Upstream generation is incomplete: ${reason ?? 'unknown reason'}.`, 502, 'incomplete_upstream_response');
  }
  return response.output.some(item => item.type === 'function_call') ? 'tool_calls' : 'stop';
}

export function responseToChat(response) {
  if (response.status === 'failed' || response.error) throw responseFailure(response);
  if (typeof response.id !== 'string' || typeof response.model !== 'string' || typeof response.created_at !== 'number'
    || !Array.isArray(response.output) || !['completed', 'incomplete'].includes(response.status)) throw new ProxyError('Upstream did not return a valid final response.', 502, 'invalid_upstream_response');
  let content = '';
  let refusal = '';
  const toolCalls = [];
  const annotations = [];
  for (const item of response.output) {
    if (item.type === 'reasoning') continue; // Chat Completions has no reasoning-item field.
    if (item.type === 'function_call') {
      if (![item.call_id, item.name, item.arguments].every(value => typeof value === 'string')) throw new ProxyError('Upstream returned an invalid function call.', 502, 'invalid_upstream_response');
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          if (typeof part.text !== 'string') throw new ProxyError('Upstream returned invalid output text.', 502, 'invalid_upstream_response');
          const offset = content.length;
          content += part.text;
          for (const annotation of part.annotations ?? []) {
            if (annotation.type !== 'url_citation') throw new ProxyError('Upstream annotation has no Chat Completions equivalent. Use /v1/responses.', 502, 'unsupported_upstream_output');
            const { type, ...citation } = annotation;
            annotations.push({ type, url_citation: { ...citation, start_index: citation.start_index + offset, end_index: citation.end_index + offset } });
          }
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
        else throw new ProxyError('Upstream content has no Chat Completions equivalent. Use /v1/responses.', 502, 'unsupported_upstream_output');
      }
    } else throw new ProxyError(`Upstream output ${item.type} has no Chat Completions equivalent. Use /v1/responses.`, 502, 'unsupported_upstream_output');
  }
  const message = { role: 'assistant', content: content || (toolCalls.length || refusal ? null : ''), refusal: refusal || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (annotations.length) message.annotations = annotations;
  return {
    id: response.id, object: 'chat.completion', created: response.created_at, model: response.model,
    choices: [{ index: 0, message, finish_reason: finishReason(response), logprobs: null }],
    ...(response.usage ? { usage: chatUsage(response.usage) } : {}),
    ...(response.service_tier ? { service_tier: response.service_tier } : {}),
  };
}

export async function streamChat(upstream, downstream, { includeUsage = false, maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  let identity;
  let roleSent = false;
  let text = '';
  let refusal = '';
  const calls = new Map();
  let outputBytes = 0;
  const assembler = new ResponseAssembler();

  const chunk = async (delta, finish = null, usage) => {
    if (!identity) throw new ProxyError('Upstream emitted a delta before response.created.', 502, 'invalid_upstream_stream');
    await writeSSE(downstream, {
      ...identity, object: 'chat.completion.chunk',
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...(includeUsage ? { usage: usage ?? null } : {}),
    });
  };
  const ensureRole = async () => {
    if (!roleSent) { await chunk({ role: 'assistant', content: '' }); roleSent = true; }
  };

  for await (const event of parseSSE(upstream)) {
    if (typeof event.delta === 'string') outputBytes += Buffer.byteLength(event.delta);
    if (outputBytes > maxOutputBytes) throw new ProxyError('Adapted output exceeds the size limit.', 502, 'upstream_output_too_large');
    if (event.response && !identity) {
      if (typeof event.response.id !== 'string' || typeof event.response.model !== 'string' || typeof event.response.created_at !== 'number') {
        // Failed events need their original error details, not an identity error.
        terminalEvent(event);
        throw new ProxyError('Upstream response is missing stream identity fields.', 502, 'invalid_upstream_stream');
      }
      identity = { id: event.response.id, created: event.response.created_at, model: event.response.model };
    }
    const terminal = assembler.accept(event);
    if (terminal) {
      const final = responseToChat(terminal);
      await ensureRole();
      const message = final.choices[0].message;
      const finalText = message.content ?? '';
      const finalRefusal = message.refusal ?? '';
      if (!finalText.startsWith(text) || !finalRefusal.startsWith(refusal)) throw new ProxyError('Upstream final output differs from its streamed deltas.', 502, 'invalid_upstream_stream');
      if (finalText.length > text.length) await chunk({ content: finalText.slice(text.length) });
      if (finalRefusal.length > refusal.length) await chunk({ refusal: finalRefusal.slice(refusal.length) });
      const finalCalls = message.tool_calls ?? [];
      const emittedIds = [...calls.values()].map(call => call.id);
      if (emittedIds.some(id => !finalCalls.some(call => call.id === id))) throw new ProxyError('A streamed tool call is missing from the final response.', 502, 'invalid_upstream_stream');
      for (const call of finalCalls) {
        let emitted = [...calls.values()].find(value => value.id === call.id);
        if (!emitted) {
          emitted = { id: call.id, name: call.function.name, index: calls.size, arguments: '' };
          calls.set(call.id, emitted);
          await chunk({ tool_calls: [{ index: emitted.index, ...call, function: { name: call.function.name, arguments: '' } }] });
        }
        if (call.function.name !== emitted.name || !call.function.arguments.startsWith(emitted.arguments)) throw new ProxyError('Upstream final tool call differs from its deltas.', 502, 'invalid_upstream_stream');
        if (call.function.arguments.length > emitted.arguments.length) await chunk({ tool_calls: [{ index: emitted.index, function: { arguments: call.function.arguments.slice(emitted.arguments.length) } }] });
      }
      if (message.annotations) await chunk({ annotations: message.annotations });
      await chunk({}, final.choices[0].finish_reason);
      if (includeUsage && final.usage) await chunk({}, null, final.usage);
      await writeSSE(downstream, '[DONE]');
      downstream.end();
      return;
    }
    if (event.type === 'response.created') await ensureRole();
    else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta !== 'string') throw new ProxyError('Upstream emitted an invalid text delta.', 502, 'invalid_upstream_stream');
      await ensureRole();
      if (event.type === 'response.output_text.delta') { text += event.delta; await chunk({ content: event.delta }); }
      else { refusal += event.delta; await chunk({ refusal: event.delta }); }
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const item = event.item;
      if (![item.id, item.call_id, item.name].every(value => typeof value === 'string')
        || (item.arguments != null && typeof item.arguments !== 'string')) throw new ProxyError('Upstream emitted an invalid tool call.', 502, 'invalid_upstream_stream');
      if (calls.has(item.id)) throw new ProxyError('Duplicate upstream tool call.', 502, 'invalid_upstream_stream');
      const call = { id: item.call_id, name: item.name, index: calls.size, arguments: item.arguments ?? '' };
      calls.set(item.id, call);
      await ensureRole();
      await chunk({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const call = calls.get(event.item_id);
      if (!call || typeof event.delta !== 'string') throw new ProxyError('Tool arguments arrived without their tool call.', 502, 'invalid_upstream_stream');
      call.arguments += event.delta;
      await chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta } }] });
    }
  }
  throw new ProxyError('Upstream stream ended before a terminal response.', 502, 'incomplete_upstream_stream');
}
