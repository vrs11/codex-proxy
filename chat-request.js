import { invalid } from './errors.js';
import { normalizeResponseRequest, responseFormat } from './compatibility.js';

export function usesLegacyFunctions(body) {
  return body.tools == null && (body.functions != null || body.function_call != null
    || (Array.isArray(body.messages) && body.messages.some(message => message?.function_call != null || message?.role === 'function')));
}

function contentParts(content, role, path) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  if (!Array.isArray(content)) throw invalid('Message content must be text or an array of content parts.', path, 'invalid_request');
  return content.map((part, index) => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    }
    if (part?.type === 'image_url' && role === 'user' && typeof part.image_url?.url === 'string') {
      return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    }
    if (part?.type === 'refusal' && role === 'assistant' && typeof part.refusal === 'string') {
      return { type: 'refusal', refusal: part.refusal };
    }
    throw invalid('Unsupported message content part.', `${path}[${index}]`);
  });
}

function messagesToInput(messages) {
  if (!Array.isArray(messages) || !messages.length) throw invalid('messages must be a non-empty array.', 'messages', 'invalid_request');
  const callIds = new Set(messages.flatMap(message => Array.isArray(message?.tool_calls) ? message.tool_calls.map(call => call?.id) : []));
  const legacyCalls = new Map();
  return messages.flatMap((message, index) => {
    const path = `messages[${index}]`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalid('Invalid message.', path, 'invalid_request');
    const { role } = message;
    if (role === 'function') {
      if (typeof message.name !== 'string' || typeof message.content !== 'string') throw invalid('Function results require a name and string content.', path, 'invalid_request');
      const callId = legacyCalls.get(message.name)?.shift();
      if (!callId) throw invalid('Function result has no matching assistant function_call.', path, 'invalid_request');
      return [{ type: 'function_call_output', call_id: callId, output: message.content }];
    }
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') throw invalid('Tool results require a tool_call_id and string content.', path, 'invalid_request');
      if (message.tool_calls != null || message.refusal != null) throw invalid('Tool results cannot include tool_calls or refusal.', path);
      return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw invalid('Unsupported message role.', `${path}.role`);
    if (message.tool_call_id !== undefined || (role !== 'assistant' && (message.tool_calls != null || message.function_call != null || message.refusal != null))) throw invalid('Tool calls and refusals require the assistant role.', path);
    const parts = contentParts(message.content, role, `${path}.content`);
    if (message.refusal != null) {
      if (typeof message.refusal !== 'string') throw invalid('refusal must be a string.', `${path}.refusal`, 'invalid_request');
      parts.push({ type: 'refusal', refusal: message.refusal });
    }
    const items = parts.length ? [{ type: 'message', role, content: parts }] : [];
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw invalid('tool_calls must be an array.', `${path}.tool_calls`, 'invalid_request');
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const callPath = `${path}.tool_calls[${callIndex}]`;
        if (call?.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw invalid('Unsupported or invalid tool call.', callPath);
        items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else if (message.function_call != null) {
      const call = message.function_call;
      if (typeof call.name !== 'string' || typeof call.arguments !== 'string') throw invalid('Invalid legacy function_call.', `${path}.function_call`, 'invalid_request');
      let callId = `call_legacy_${index}`;
      while (callIds.has(callId)) callId += '_';
      callIds.add(callId);
      const pending = legacyCalls.get(call.name) ?? [];
      pending.push(callId);
      legacyCalls.set(call.name, pending);
      items.push({ type: 'function_call', call_id: callId, name: call.name, arguments: call.arguments });
    }
    if (!items.length) throw invalid('Message must contain content or tool calls.', path, 'invalid_request');
    return items;
  });
}

export function chatToResponses(body) {
  if (body.stream === true && body.stream_options != null) {
    if (typeof body.stream_options !== 'object' || Array.isArray(body.stream_options)) throw invalid('stream_options must be an object.', 'stream_options', 'invalid_request');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') throw invalid('include_usage must be a boolean.', 'stream_options.include_usage', 'invalid_request');
  }
  const request = {
    model: body.model, input: messagesToInput(body.messages),
    instructions: '', store: false, stream: true,
  };
  for (const key of ['parallel_tool_calls', 'service_tier', 'prompt_cache_key', 'reasoning', 'text']) {
    if (body[key] != null) request[key] = body[key];
  }
  if (body.reasoning_effort != null) request.reasoning = { ...request.reasoning, effort: body.reasoning_effort };
  if (body.verbosity != null) request.text = { ...request.text, verbosity: body.verbosity };
  let tools = body.tools;
  if (tools == null && body.functions != null) {
    if (!Array.isArray(body.functions)) throw invalid('functions must be an array.', 'functions', 'invalid_request');
    tools = body.functions.map(fn => ({ type: 'function', function: fn }));
  }
  if (tools != null) {
    if (!Array.isArray(tools)) throw invalid('tools must be an array.', 'tools', 'invalid_request');
    request.tools = tools.map((tool, index) => {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') throw invalid('Only function tools are supported in Chat Completions.', `tools[${index}]`);
      // Chat Completions defaults to non-strict function schemas.
      const { name, description, parameters, strict = false } = tool.function;
      return { type: 'function', name, ...(description !== undefined ? { description } : {}), ...(parameters !== undefined ? { parameters } : {}), strict: strict ?? false };
    });
  }
  let choice = body.tool_choice;
  if (choice == null && body.function_call != null) {
    choice = typeof body.function_call === 'string' ? body.function_call : { type: 'function', function: body.function_call };
  }
  if (choice != null) {
    if (typeof choice === 'string' && ['none', 'auto', 'required'].includes(choice)) request.tool_choice = choice;
    else if (choice?.type === 'function' && typeof (choice.function?.name ?? choice.name) === 'string') {
      request.tool_choice = { type: 'function', name: choice.function?.name ?? choice.name };
    } else throw invalid('Unsupported tool_choice.', 'tool_choice');
  }
  if (body.response_format != null) request.text = { ...request.text, format: responseFormat(body.response_format) };
  if (usesLegacyFunctions(body)) request.parallel_tool_calls = false;
  return normalizeResponseRequest(request);
}
