import { once } from 'node:events';
import { ProxyError, responseFailure } from './errors.js';

export async function* parseSSE(stream, maxEventBytes = 16 * 1024 * 1024) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data = [];
  let name = '';
  let eventSize = 0;
  let skipLineFeed = false;
  for await (const chunk of stream) {
    let text = decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true });
    if (skipLineFeed && text.length) {
      if (text.startsWith('\n')) text = text.slice(1);
      skipLineFeed = false;
    }
    pending += text;
    let end;
    while ((end = pending.search(/[\r\n]/)) !== -1) {
      const line = pending.slice(0, end);
      if (pending[end] === '\r' && end === pending.length - 1) skipLineFeed = true;
      const width = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
      pending = pending.slice(end + width);
      if (line === '') {
        if (data.length) {
          const text = data.join('\n');
          if (text === '[DONE]') return;
          let value;
          try { value = JSON.parse(text); }
          catch { throw new ProxyError('Upstream sent malformed SSE JSON.', 502, 'invalid_upstream_stream'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProxyError('Upstream sent an invalid SSE event.', 502, 'invalid_upstream_stream');
          yield { ...value, type: value.type ?? name };
        }
        data = [];
        name = '';
        eventSize = 0;
      } else if (!line.startsWith(':')) {
        eventSize += Buffer.byteLength(line);
        if (eventSize > maxEventBytes) throw new ProxyError('Upstream SSE event exceeds the size limit.', 502, 'upstream_event_too_large');
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        if (field === 'event') name = value;
      }
    }
    if (Buffer.byteLength(pending) + eventSize > maxEventBytes) throw new ProxyError('Upstream SSE event exceeds the size limit.', 502, 'upstream_event_too_large');
  }
  decoder.decode(); // Reject an incomplete final UTF-8 sequence.
}

export function terminalEvent(event) {
  if (event.type === 'error') throw responseFailure(event.error ?? event);
  if (event.type === 'response.failed') throw responseFailure(event.response);
  if (!['response.completed', 'response.incomplete'].includes(event.type)) return null;
  const response = event.response;
  if (!response || typeof response.id !== 'string' || !Array.isArray(response.output)) {
    throw new ProxyError('Upstream terminal event is missing its response object.', 502, 'invalid_upstream_stream');
  }
  if (response.status === 'failed' || response.error) throw responseFailure(response);
  return response;
}

export class ResponseAssembler {
  constructor() {
    this.items = new Map();
    this.size = 0;
  }

  accept(event) {
    if (['response.output_item.added', 'response.output_item.done'].includes(event.type)) {
      if (!Number.isInteger(event.output_index) || event.output_index < 0 || !event.item?.type) {
        throw new ProxyError('Upstream output item has no valid index or type.', 502, 'invalid_upstream_stream');
      }
      const previous = this.items.get(event.output_index);
      if (previous?.item.id && event.item.id && previous.item.id !== event.item.id) throw new ProxyError('Upstream changed an output item identity.', 502, 'invalid_upstream_stream');
      const size = Buffer.byteLength(JSON.stringify(event.item));
      this.size += size - (previous?.size ?? 0);
      if (this.size > 64 * 1024 * 1024) throw new ProxyError('Accumulated output exceeds the size limit.', 502, 'upstream_output_too_large');
      this.items.set(event.output_index, { item: event.item, done: event.type.endsWith('.done'), size });
    }
    const response = terminalEvent(event);
    if (!response || response.output.length || !this.items.size) return response;
    // Codex can send complete items separately and leave terminal output empty.
    const ordered = [...this.items.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index, value], position) => index !== position || !value.done)) {
      throw new ProxyError('Upstream ended without completing all output items.', 502, 'incomplete_upstream_stream');
    }
    return { ...response, output: ordered.map(([, value]) => value.item) };
  }
}

export async function collectResponse(stream) {
  const assembler = new ResponseAssembler();
  for await (const event of parseSSE(stream)) {
    const response = assembler.accept(event);
    if (response) return response;
  }
  throw new ProxyError('Upstream stream ended before a terminal response.', 502, 'incomplete_upstream_stream');
}

export async function writeSSE(response, value) {
  if (response.destroyed) throw new ProxyError('Caller disconnected.', 499, 'client_disconnected');
  const frame = `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
  if (!response.write(frame)) {
    const closed = new AbortController();
    const onClose = () => closed.abort();
    response.once('close', onClose);
    try { await once(response, 'drain', { signal: closed.signal }); }
    finally { response.off('close', onClose); }
  }
}
