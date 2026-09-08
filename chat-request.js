import { invalid } from './errors.js';

function onlyKeys(value, keys, path) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(`No supported Responses mapping for ${path}${key}.`, `${path}${key}`);
  }
}

function contentParts(content, role, path) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  if (!Array.isArray(content)) throw invalid('Message content must be text or an array of content parts.', path, 'invalid_request');
  return content.map((part, index) => {
    const prefix = `${path}[${index}].`;
    if (part?.type === 'text' && typeof part.text === 'string') {
      onlyKeys(part, ['type', 'text'], prefix);
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    }
    if (part?.type === 'image_url' && role === 'user' && typeof part.image_url?.url === 'string') {
      onlyKeys(part, ['type', 'image_url'], prefix);
      onlyKeys(part.image_url, ['url', 'detail'], `${prefix}image_url.`);
      return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    }
    if (part?.type === 'refusal' && role === 'assistant' && typeof part.refusal === 'string') {
      onlyKeys(part, ['type', 'refusal'], prefix);
      return { type: 'refusal', refusal: part.refusal };
    }
    throw invalid('Unsupported message content part.', `${path}[${index}]`);
  });
}

function messagesToInput(messages) {
  if (!Array.isArray(messages) || !messages.length) throw invalid('messages must be a non-empty array.', 'messages', 'invalid_request');
  return messages.flatMap((message, index) => {
    const path = `messages[${index}]`;
    if (!message || typeof message !== 'object') throw invalid('Invalid message.', path, 'invalid_request');
    onlyKeys(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal'], `${path}.`);
    const { role } = message;
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') throw invalid('Tool results require a tool_call_id and string content.', path, 'invalid_request');
      if (message.tool_calls != null || message.refusal != null) throw invalid('Tool results cannot include tool_calls or refusal.', path);
      return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw invalid('Unsupported message role.', `${path}.role`);
    if (message.tool_call_id !== undefined || (role !== 'assistant' && (message.tool_calls != null || message.refusal != null))) throw invalid('Tool calls and refusals require the assistant role.', path);
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
        onlyKeys(call, ['id', 'type', 'function'], `${callPath}.`);
        onlyKeys(call.function, ['name', 'arguments'], `${callPath}.function.`);
        items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    if (!items.length) throw invalid('Message must contain content or tool calls.', path, 'invalid_request');
    return items;
  });
}

export function chatToResponses(body) {
  const supported = ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls',
    'response_format', 'reasoning_effort', 'verbosity', 'max_completion_tokens', 'max_tokens', 'temperature', 'top_p',
    'store', 'metadata', 'service_tier', 'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention', 'n'];
  onlyKeys(body, supported, '');
  if (body.n !== undefined && body.n !== 1) throw invalid('Only n:1 is supported.', 'n');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw invalid('Provide only one token limit.', 'max_tokens', 'invalid_request');
  if (body.stream_options != null) {
    if (body.stream !== true || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options)) throw invalid('stream_options requires stream:true and an object.', 'stream_options', 'invalid_request');
    onlyKeys(body.stream_options, ['include_usage'], 'stream_options.');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') throw invalid('include_usage must be a boolean.', 'stream_options.include_usage', 'invalid_request');
  }
  const request = {
    model: body.model, input: messagesToInput(body.messages),
    instructions: '', store: false, stream: true,
  };
  for (const key of ['parallel_tool_calls', 'temperature', 'top_p', 'metadata', 'service_tier', 'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention']) {
    if (body[key] !== undefined) request[key] = body[key];
  }
  if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) request.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  if (body.reasoning_effort !== undefined) request.reasoning = { effort: body.reasoning_effort };
  if (body.verbosity !== undefined) request.text = { verbosity: body.verbosity };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw invalid('tools must be an array.', 'tools', 'invalid_request');
    request.tools = body.tools.map((tool, index) => {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string') throw invalid('Only function tools are supported in Chat Completions.', `tools[${index}]`);
      onlyKeys(tool, ['type', 'function'], `tools[${index}].`);
      onlyKeys(tool.function, ['name', 'description', 'parameters', 'strict'], `tools[${index}].function.`);
      // Chat Completions defaults to non-strict function schemas.
      return { type: 'function', ...tool.function, strict: tool.function.strict ?? false };
    });
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string' && ['none', 'auto', 'required'].includes(body.tool_choice)) request.tool_choice = body.tool_choice;
    else if (body.tool_choice?.type === 'function' && typeof body.tool_choice.function?.name === 'string') {
      onlyKeys(body.tool_choice, ['type', 'function'], 'tool_choice.');
      onlyKeys(body.tool_choice.function, ['name'], 'tool_choice.function.');
      request.tool_choice = { type: 'function', name: body.tool_choice.function.name };
    } else throw invalid('Unsupported tool_choice.', 'tool_choice');
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (!format || typeof format !== 'object') throw invalid('Invalid response_format.', 'response_format', 'invalid_request');
    onlyKeys(format, ['type', 'json_schema'], 'response_format.');
    let mapped;
    if (['text', 'json_object'].includes(format.type) && format.json_schema === undefined) mapped = { type: format.type };
    else if (format.type === 'json_schema' && format.json_schema?.schema && typeof format.json_schema.name === 'string') {
      onlyKeys(format.json_schema, ['name', 'description', 'schema', 'strict'], 'response_format.json_schema.');
      mapped = { type: 'json_schema', ...format.json_schema, strict: format.json_schema.strict ?? false };
    } else throw invalid('Unsupported response_format.', 'response_format');
    request.text = { ...request.text, format: mapped };
  }
  return request;
}
