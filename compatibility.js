import { invalid } from './errors.js';

// These options have no supported equivalent on the Codex inference endpoint.
const ignored = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
  'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs',
  'metadata', 'user', 'safety_identifier', 'prompt_cache_retention', 'prompt_cache_options',
  'n', 'previous_response_id', 'conversation', 'background', 'modalities', 'audio', 'prediction',
];

export function responseFormat(format) {
  if (!format || typeof format !== 'object' || Array.isArray(format)) throw invalid('Invalid response_format.', 'response_format', 'invalid_request');
  if (['text', 'json_object'].includes(format.type)) return { type: format.type };
  if (format.type === 'json_schema' && format.json_schema?.schema && typeof format.json_schema.name === 'string') {
    const { name, description, schema, strict = false } = format.json_schema;
    return { type: 'json_schema', name, ...(description !== undefined ? { description } : {}), schema, strict };
  }
  throw invalid('Unsupported response_format.', 'response_format');
}

export function normalizeResponseRequest(body, { reasoningEffortOverride } = {}) {
  // Copy only on change so already-compatible native requests keep their bytes.
  let request = body;
  const set = (key, value) => {
    if (request === body) request = { ...body };
    request[key] = value;
  };
  const remove = key => {
    if (!Object.hasOwn(request, key)) return;
    if (request === body) request = { ...body };
    delete request[key];
  };
  for (const key of ignored) remove(key);
  if (request.store === true) set('store', false);
  if (request.store === null) remove('store');
  if (request.service_tier === 'auto' || request.service_tier === null) remove('service_tier');

  // Codex accepts developer instructions in input, but rejects the system role.
  // Keep each message in place so separate instruction blocks retain their order.
  const isSystemMessage = item => item?.role === 'system' && (item.type === undefined || item.type === 'message');
  if (Array.isArray(request.input) && request.input.some(isSystemMessage)) {
    set('input', request.input.map(item => isSystemMessage(item) ? { ...item, role: 'developer' } : item));
  }

  if (request.reasoning_effort != null && request.reasoning == null) set('reasoning', { effort: request.reasoning_effort });
  remove('reasoning_effort');
  if (reasoningEffortOverride != null && request.reasoning?.effort !== reasoningEffortOverride) {
    set('reasoning', { ...request.reasoning, effort: reasoningEffortOverride });
  }
  if (request.reasoning?.effort === 'minimal' && /^gpt-5\.6(?:-|$)/.test(request.model)) {
    set('reasoning', { ...request.reasoning, effort: 'low' });
  }
  if (request.verbosity != null && request.text?.verbosity === undefined) set('text', { ...request.text, verbosity: request.verbosity });
  remove('verbosity');
  if (request.response_format != null && request.text?.format === undefined) set('text', { ...request.text, format: responseFormat(request.response_format) });
  remove('response_format');
  return request;
}
