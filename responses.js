import { invalid } from './errors.js';

export function validateResponseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object.', null, 'invalid_request');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalid('model must be a non-empty string.', 'model', 'invalid_request');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be a boolean.', 'stream', 'invalid_request');
  if (body.store !== undefined && typeof body.store !== 'boolean') throw invalid('store must be a boolean.', 'store', 'invalid_request');
  if (body.store === true) throw invalid('Stored responses are not supported by this proxy. Send full conversation input with store:false.', 'store');
  for (const key of ['previous_response_id', 'conversation']) {
    if (body[key] != null) throw invalid(`${key} requires stored conversations, which this proxy does not maintain. Send full input instead.`, key);
  }
  if (body.background === true) throw invalid('Background generation is not supported by this proxy.', 'background');
}

// Only repair explicit validation rejections, before any generation was accepted.
// The first attempt always retains the caller's bytes. A bounded retry loop in
// server.js applies each repair at most once; no generation settings are dropped.
export function repairValidation(body, status, errorBytes, contentEncoding) {
  if (![400, 422].includes(status) || contentEncoding) return null;
  let error;
  try { error = JSON.parse(errorBytes.toString('utf8')); } catch { return null; }
  const detail = error.error ?? error.detail ?? error;
  const message = (typeof detail === 'string' ? detail : detail?.message ?? '').toLowerCase();
  const param = typeof detail === 'object' ? detail?.param : undefined;
  const mentions = key => param === key || new RegExp(`\\b${key}\\b`).test(message);
  if (mentions('stream') && body.stream !== true
    && /must (?:be|equal) true|only (?:supports? )?streaming|non[- ]streaming.*(?:unsupported|not supported)|stream.*(?:required|true)/.test(message)) {
    return { ...body, stream: true };
  }
  if (mentions('store') && body.store === undefined && /false|required|disabled/.test(message)) return { ...body, store: false };
  if (mentions('instructions') && body.instructions === undefined && /required|missing|must be|field required/.test(message)) return { ...body, instructions: '' };
  if (mentions('input') && typeof body.input === 'string' && /array|list/.test(message)) {
    return { ...body, input: [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }] };
  }
  return null;
}
