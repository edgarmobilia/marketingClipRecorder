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
const openProxy = (origin) => new Promise((resolve) => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/proxy`, origin ? { origin } : {});
  w.on('open', () => { w.close(); resolve(true); });
  w.on('error', () => resolve(false));
});
assert.equal(await openProxy('http://evil.example'), false);
console.log('web origin rejected (editor + proxy paths) ✓');

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

r = await client.callTool({ name: 'get_status', arguments: {} });
let st = JSON.parse(r.content[0].text);
assert.equal(st.role, 'owner');
assert.equal(st.editor_connected, true);
console.log('get_status owner ✓');

// --- Two Claude sessions: the second server relays through the first ---

const startServer = async (port) => {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: transport._serverParams.args,
    env: { ...process.env, MCR_BRIDGE_PORT: String(port) },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'test2', version: '1.0.0' });
  await c.connect(t);
  return c;
};

const client2 = await startServer(PORT);
r = await client2.callTool({ name: 'get_status', arguments: {} });
st = JSON.parse(r.content[0].text);
assert.equal(st.role, 'proxy');
assert.equal(st.editor_connected, true);
console.log('second session → proxy ✓');

r = await client2.callTool({ name: 'get_project', arguments: {} });
assert.equal(JSON.parse(r.content[0].text).recording.duration_sec, 12);
r = await client2.callTool({ name: 'undo', arguments: {} });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /nope: undo/);
console.log('proxy relays calls and errors ✓');

// Owner exits → the proxy takes the port over and the editor reconnects to it
ws.close();
await client.close();
await new Promise(r => setTimeout(r, 1500));
r = await client2.callTool({ name: 'get_status', arguments: {} });
st = JSON.parse(r.content[0].text);
assert.equal(st.role, 'owner');
console.log('failover: proxy became owner ✓');
const again = await open('chrome-extension://abcdefghijklmnop');
assert.ok(again.ok);
again.ws.on('message', (data) => {
  const { id } = JSON.parse(data);
  again.ws.send(JSON.stringify({ id, result: { recording: { duration_sec: 7 } } }));
});
await new Promise(r => setTimeout(r, 100));
r = await client2.callTool({ name: 'get_project', arguments: {} });
assert.equal(JSON.parse(r.content[0].text).recording.duration_sec, 7);
console.log('editor reconnects to new owner ✓');
again.ws.close();
await client2.close();

// --- Port held by something that is not a clip-editor server ---

const { createServer } = await import('node:http');
const BUSY = PORT + 1;
const squatter = createServer((_, res) => res.end('hi'));
await new Promise(r => squatter.listen(BUSY, '127.0.0.1', r));
const client3 = await startServer(BUSY);
r = await client3.callTool({ name: 'get_project', arguments: {} });
assert.equal(r.isError, true);
assert.match(r.content[0].text, new RegExp(`port ${BUSY} is held by`));
r = await client3.callTool({ name: 'get_status', arguments: {} });
assert.equal(JSON.parse(r.content[0].text).role, 'blocked');
console.log('busy port → explicit error ✓');
await client3.close();
squatter.close();

console.log('ALL OK');
