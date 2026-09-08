import { ProxyError } from './errors.js';
import { ResponseAssembler } from './sse.js';

// Keep the original frame bytes, including comments and unknown events. Only a
// terminal event missing previously completed output items needs reserialization.
async function* frames(stream) {
  let buffer = Buffer.alloc(0);
  let cursor = 0;
  let lineStart = 0;
  const extract = function* (eof) {
    while (cursor < buffer.length) {
      const byte = buffer[cursor];
      if (byte !== 10 && byte !== 13) { cursor++; continue; }
      if (byte === 13 && cursor + 1 === buffer.length && !eof) break;
      const end = cursor + (byte === 13 && buffer[cursor + 1] === 10 ? 2 : 1);
      if (cursor === lineStart) {
        if (end > 16 * 1024 * 1024) throw new ProxyError('Upstream SSE frame exceeds the size limit.', 502, 'upstream_event_too_large');
        yield buffer.subarray(0, end);
        buffer = buffer.subarray(end);
        cursor = 0;
        lineStart = 0;
      } else { cursor = end; lineStart = end; }
    }
  };
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    yield* extract(false);
    if (buffer.length > 16 * 1024 * 1024) throw new ProxyError('Upstream SSE frame exceeds the size limit.', 502, 'upstream_event_too_large');
  }
  yield* extract(true);
  if (buffer.length) yield buffer;
}

export async function* normalizeResponsesStream(stream) {
  const assembler = new ResponseAssembler();
  for await (const raw of frames(stream)) {
    const text = raw.toString('utf8');
    const lines = text.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    let event;
    try { event = JSON.parse(data); } catch { yield raw; continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { yield raw; continue; }
    event.type ??= lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    if (!['response.output_item.added', 'response.output_item.done', 'response.completed', 'response.incomplete'].includes(event.type)) {
      yield raw;
      continue;
    }
    const response = assembler.accept(event);
    if (!response || response === event.response) { yield raw; continue; }
    const replacement = JSON.stringify({ ...event, response });
    let replaced = false;
    const updated = text.replace(/(^|(?<=[\r\n]))data:[^\r\n]*(\r\n|\r|\n|$)/g, (line, start, ending) => {
      if (replaced) return '';
      replaced = true;
      return `data: ${replacement}${ending}`;
    });
    yield Buffer.from(updated);
  }
}
