import { once } from 'node:events';
import OpenAI from 'openai';
import { AuthManager } from '../auth.js';
import { loadConfig } from '../config.js';
import { acquireLease } from '../credentials.js';
import { createProxyServer } from '../server.js';

// Explicit live check: uses the saved account and makes four small generations.
// Stop an existing proxy first; this script owns and restarts its own server.
async function main() {
  const config = loadConfig();
  const release = await acquireLease(config.home);
  let server;
  const start = async () => {
    const auth = new AuthManager(config);
    if (!await auth.load()) throw new Error('Run npm run login before the live smoke check.');
    await auth.headers();
    server = createProxyServer(config, auth);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return new OpenAI({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local', maxRetries: 0 });
  };
  try {
    const client = await start();
    const models = await client.models.list();
    const model = process.env.CODEX_PROXY_TEST_MODEL || models.data[0]?.id;
    if (!model) throw new Error('The account returned no models.');
    console.log(`Model catalog: OK. Testing ${model}.`);
    const input = 'Reply with the single word OK.';
    const response = await client.responses.create({ model, input, store: false });
    if (!response.output_text) throw new Error('Regular Responses returned no text.');
    console.log('Regular Responses: OK');
    let responseText = '';
    for await (const event of await client.responses.create({ model, input, store: false, stream: true })) {
      if (event.type === 'response.output_text.delta') responseText += event.delta;
      if (event.type === 'response.failed') throw new Error(event.response?.error?.message || 'Streaming Responses failed.');
    }
    if (!responseText) throw new Error('Streaming Responses returned no text.');
    console.log('Streaming Responses: OK');
    const messages = [{ role: 'user', content: input }];
    const chat = await client.chat.completions.create({ model, messages });
    if (!chat.choices[0]?.message.content) throw new Error('Regular Chat Completions returned no text.');
    console.log('Regular Chat Completions: OK');
    let chatText = '';
    for await (const chunk of await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true } })) {
      chatText += chunk.choices[0]?.delta.content ?? '';
    }
    if (!chatText) throw new Error('Streaming Chat Completions returned no text.');
    console.log('Streaming Chat Completions: OK');
    await server.shutdown();
    server = undefined;
    const restarted = await start();
    await restarted.models.list();
    console.log('Restart with saved credentials: OK');
  } finally {
    if (server) await server.shutdown();
    await release();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
