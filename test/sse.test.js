import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { collectResponse, parseSSE } from '../sse.js';
import { finalResponse } from './helpers.js';

test('SSE parser handles split UTF-8, BOM, multiline data, comments, CR, LF and CRLF', async () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const encoded = Buffer.from(`\uFEFF: comment${newline}id: ignored${newline}event: custom${newline}data: {${newline}data: "text": "🌍"}${newline}${newline}`);
    const stream = Readable.from([...encoded].map(byte => Buffer.from([byte])));
    const parsed = [];
    for await (const event of parseSSE(stream)) parsed.push(event);
    assert.deepEqual(parsed, [{ type: 'custom', text: '🌍' }]);
  }
});

test('SSE parser rejects malformed, incomplete and oversized output', async () => {
  await assert.rejects(collectResponse(Readable.from(['data: {broken}\n\n'])), { code: 'invalid_upstream_stream' });
  await assert.rejects(collectResponse(Readable.from(['data: [DONE]\n\n'])), { code: 'incomplete_upstream_stream' });
  const final = JSON.stringify({ type: 'response.completed', response: finalResponse() });
  await assert.rejects(collectResponse(Readable.from([`data: ${final}`])), { code: 'incomplete_upstream_stream' });
  await assert.rejects(async () => {
    for await (const event of parseSSE(Readable.from(['data: ' + 'x'.repeat(100)]), 50)) void event;
  }, { code: 'upstream_event_too_large' });
  await assert.rejects(collectResponse(Readable.from([Buffer.from([0xe2, 0x82])])));
});

test('collecting a response retains all terminal fields and rejects failed generations', async () => {
  const response = finalResponse({ custom: [1, { nested: true }] });
  const result = await collectResponse(Readable.from([`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`]));
  assert.deepEqual(result, response);
  await assert.rejects(collectResponse(Readable.from(['data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"Out of quota"}}}\n\n'])), { status: 429, code: 'insufficient_quota' });
});
