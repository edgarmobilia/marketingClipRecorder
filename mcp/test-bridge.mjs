// Smoke test: spawns server.js over stdio, connects a fake editor over the
// WebSocket bridge, and checks tool calls round-trip. Run: node test-bridge.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const PORT = 47899;
const url = `ws://127.0.0.1:${PORT}/editor`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  env: { ...process.env, MCR_BRIDGE_PORT: String(PORT) },
  stderr: 'pipe',
});
const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map(t => t.name).sort();
console.log('tools:', tools.join(', '));
assert.ok(tools.includes('get_frame') && tools.includes('add_text'));

// No editor yet → helpful error
let r = await client.callTool({ name: 'get_project', arguments: {} });
assert.equal(r.isError, true);
console.log('no editor →', r.content[0].text.slice(0, 50) + '…');

const open = (origin) => new Promise((resolve) => {
  const ws = new WebSocket(url, { origin });
  ws.on('open', () => resolve({ ok: true, ws }));
  ws.on('error', () => resolve({ ok: false }));
});

// A web page must not be able to pose as the editor
assert.equal((await open('http://evil.example')).ok, false);
console.log('web origin rejected ✓');

const { ok, ws } = await open('chrome-extension://abcdefghijklmnop');
assert.ok(ok);
ws.on('message', (data) => {
  const { id, method, params } = JSON.parse(data);
  const result = method === 'get_frame'
    ? { time_sec: params.time_sec, mime: 'image/jpeg', image: Buffer.from('fake').toString('base64') }
    : method === 'add_text' ? { id: 't1', ...params }
    : method === 'get_project' ? { recording: { duration_sec: 12 }, events: [], texts: [] }
    : null;
  ws.send(JSON.stringify(result ? { id, result } : { id, error: { message: `nope: ${method}` } }));
});
await new Promise(r => setTimeout(r, 100));

r = await client.callTool({ name: 'get_project', arguments: {} });
assert.equal(JSON.parse(r.content[0].text).recording.duration_sec, 12);
console.log('get_project ✓');

r = await client.callTool({ name: 'get_frame', arguments: { time_sec: 3.5 } });
assert.equal(r.content[0].type, 'image');
console.log('get_frame returns image ✓');

r = await client.callTool({ name: 'add_text', arguments: { text: 'Hola', start_sec: 1, end_sec: 3, style: 'callout' } });
assert.equal(JSON.parse(r.content[0].text).style, 'callout');
console.log('add_text ✓');

r = await client.callTool({ name: 'undo', arguments: {} });
assert.equal(r.isError, true);
console.log('editor error propagates ✓');

r = await client.callTool({ name: 'add_text', arguments: { text: 'x', start_sec: 1, end_sec: 2, style: 'bogus' } });
assert.equal(r.isError, true);
console.log('schema validation ✓');

ws.close();
await client.close();
console.log('ALL OK');
