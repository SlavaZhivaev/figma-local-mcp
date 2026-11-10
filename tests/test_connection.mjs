import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('plugin/src/connection.js', root), 'utf8');
const context = vm.createContext({URL, AbortController, setTimeout, clearTimeout, console});
vm.runInContext(source, context);
const Connection = context.FigmaBridgeConnection;
const normalize = context.FigmaBridgeEndpoint;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = value => ({ok: true, json: async () => value});
function active(options = {}) {
  const client = new Connection({session: 'test-session', execute() {}, fetch: async () => response(null), ...options});
  const run = {address: 'http://localhost:38471', key: 'test', stopped: false,
               controllers: new Set(), saved: false, failures: 0, retry: 1};
  client.run = run;
  return {client, run};
}
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}

await test('Only configured loopback ports are accepted', async () => {
  assert.equal(normalize('127.0.0.1:38472'), 'http://localhost:38472');
  for (const url of ['https://localhost:38471', 'http://example.com:38471',
    'http://localhost:1', 'http://localhost:38471/path', 'http://u:p@localhost:38471']) {
    assert.throws(() => normalize(url));
  }
});
await test('One result delivery shared by callback and polling loop', async () => {
  let complete, count = 0;
  const {client, run} = active({fetch: async () => {
    count++;
    return new Promise(resolve => {complete = () => resolve(response({accepted: true}));});
  }});
  client.dispatch(run, {id: 'job', action: 'figma_read', args: {}});
  client.acceptResult({id: 'job', result: {}});
  const first = client.flush(run), second = client.flush(run);
  assert.equal(first, second);
  assert.equal(count, 1);
  complete(); await first;
  assert.equal(client.pending, null);
  client.stop();
});
await test('Result retries use the original endpoint and key', async () => {
  const requests = [];
  const {client, run} = active({fetch: async (url, options) => {
    requests.push({url, authorization: options.headers.Authorization});
    return response({accepted: true});
  }});
  client.dispatch(run, {id: 'job', action: 'figma_read', args: {}});
  assert.throws(() => client.relocate(run, 'http://localhost:38472'));
  run.address = 'http://localhost:38472'; run.key = 'different';
  client.acceptResult({id: 'job', result: 1}); await client.flush(run);
  assert.equal(requests[0].url, 'http://localhost:38471/result');
  assert.equal(requests[0].authorization, 'Bearer test');
  client.stop();
});
await test('Network failure preserves the pending result', async () => {
  const {client, run} = active({fetch: async () => {throw Error('offline');}});
  client.dispatch(run, {id: 'job', action: 'figma_read', args: {}});
  client.acceptResult({id: 'job', result: 1});
  await assert.rejects(client.flush(run), /offline/);
  assert.equal(client.pending.id, 'job');
  assert.equal(client.pending.result.result, 1);
  client.stop();
});
await test('Pending command prevents discovery of a different server', async () => {
  let discoveries = 0, pauses = 0;
  const {client, run} = active({fetch: async () => {throw Error('offline');},
    sleep: async () => {if (++pauses >= 3) client.stop();}});
  client.discover = async () => {discoveries++; return null;};
  client.dispatch(run, {id: 'job', action: 'figma_apply', args: {}});
  await client.loop(run);
  assert.equal(discoveries, 0);
});
await test('Duplicate job executes only once', async () => {
  let executions = 0;
  const {client, run} = active({execute: () => {executions++;}});
  const job = {id: 'job', action: 'figma_apply', args: {}};
  client.dispatch(run, job); client.dispatch(run, job);
  await tick();
  assert.equal(executions, 1);
  assert.throws(() => client.dispatch(run, {...job, id: 'other'}));
  client.stop();
});
await test('Late callback of an earlier connection is ignored', async () => {
  const {client, run} = active();
  client.dispatch(run, {id: 'old', action: 'figma_apply', args: {}});
  const newer = {...run, controllers: new Set()};
  client.run = newer;
  assert.equal(client.acceptResult({id: 'old', result: 1}, run), false);
  assert.equal(client.pending.result, null);
  client.stop();
});
await test('Repeated start aborts the earlier poll before opening another', async () => {
  let activeRequests = 0, maximum = 0;
  const client = new Connection({session: 'test', execute() {}, fetch: (url, options) => {
    if (url.endsWith('/bye')) return Promise.resolve(response({ok: true}));
    activeRequests++; maximum = Math.max(maximum, activeRequests);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      activeRequests--; reject(Error('aborted'));
    }, {once: true}));
  }});
  const first = client.start('127.0.0.1:38471', 'a');
  const second = client.start('127.0.0.1:38472', 'a');
  client.stop(); await Promise.all([first, second]);
  assert.equal(maximum, 1); assert.equal(activeRequests, 0);
});
await test('Rejected acknowledgement stops instead of replaying a command', async () => {
  const {client, run} = active({fetch: async () => response({accepted: false})});
  client.dispatch(run, {id: 'job', action: 'figma_apply', args: {}});
  client.acceptResult({id: 'job', result: 1});
  await assert.rejects(client.flush(run), /не подтвердил/);
  assert.ok(client.pending.fatal);
  client.stop();
});
await test('Completed job replay resends acknowledgement without execution', async () => {
  let executions = 0;
  const {client, run} = active({execute: () => {executions++;}, fetch: async () => response({accepted: true})});
  const job = {id: 'job', action: 'figma_apply', args: {}};
  client.dispatch(run, job); await tick();
  client.acceptResult({id: 'job', result: 1}); await client.flush(run);
  client.dispatch(run, job); await client.flush(run); await tick();
  assert.equal(executions, 1);
  client.stop();
});
// Parse the shipped bundles as well as the isolated controller.
new vm.Script(fs.readFileSync(new URL('plugin/code.js', root), 'utf8'));
const html = fs.readFileSync(new URL('plugin/ui.html', root), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new vm.Script(script);
console.log('Connection tests: ' + passed + '; both Figma bundles parse.');
export const results = {passed, bundlesParsed: 2};
