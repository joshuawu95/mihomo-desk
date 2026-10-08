import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store, atomicWrite } from './store.mjs';
import { Core } from './core.mjs';
import { compose, dumpConfig, parseConfig, mergeYaml, policyNames, ruleTypes } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function option(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const directory = path.resolve(option('data-dir', path.join(process.env.LOCALAPPDATA || os.homedir(), 'MihomoDesk')));
const mixedPort = Number(option('mixed-port', 17890));
const controllerPort = Number(option('controller-port', 19090));
for (const port of [mixedPort, controllerPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
}
if (mixedPort === controllerPort) throw new Error('Proxy and controller ports must differ');
const store = new Store(directory);
await store.init();
const lockFile = path.join(directory, 'instance.lock');
async function acquireLock() {
  try { return await fs.open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(await fs.readFile(lockFile, 'utf8')); }
    catch { throw new Error('Instance lock is unreadable. Check running processes before removing it.'); }
    try { process.kill(old.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      await fs.rm(lockFile);
      return fs.open(lockFile, 'wx', 0o600);
    }
    throw new Error('Mihomo Desk is already running for this data directory');
  }
}
const lock = await acquireLock();
await lock.writeFile(JSON.stringify({ pid: process.pid }));
const token = randomBytes(32).toString('hex');
const coreSecret = randomBytes(32).toString('hex');
const core = new Core({
  executable: path.resolve(option('core', path.join(here, 'core', 'mihomo.exe'))),
  directory, controllerPort, secret: coreSecret,
});
const controls = { mixedPort, controllerPort, secret: coreSecret };
let appliedProfile = null;
let closing = false;
let server;
let origin;
const trayExecutable = path.join(here, 'MihomoDesk.exe');

async function systemProxy(enabled) {
  if (enabled && !core.running) throw new Error('Start Mihomo before enabling the system proxy');
  const child = spawn(trayExecutable, [enabled ? '--proxy-on' : '--proxy-off',
    '--data-dir', directory, '--mixed-port', String(mixedPort)], { windowsHide: true });
  let error = '';
  child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(error || 'System proxy operation failed');
}

async function proxyEnabled() {
  try { await fs.access(path.join(directory, 'proxy-backup.json')); return true; }
  catch { return false; }
}

function getProfile(id, state = store.state) {
  const profile = state.profiles.find(p => p.id === id);
  if (!profile) throw new Error('Subscription not found');
  return profile;
}

async function fetchSubscription(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Subscription URL must use HTTP or HTTPS without embedded credentials');
  }
  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'clash-verge/v2.5.8 MihomoDesk/0.1.0', Accept: 'application/yaml,text/yaml,text/plain' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Subscription download failed: HTTP ' + response.status);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Subscription exceeds 4 MiB');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  parseConfig(raw);
  return raw;
}

async function apply(state, id) {
  const profile = id ? getProfile(id, state) : null;
  const config = compose(state, profile, controls);
  const next = { ...state, activeId: id || null };
  await core.install(dumpConfig(config), () => store.save(next));
  appliedProfile = profile ? structuredClone(profile) : null;
  return { status: 'applied', message: 'Validated and applied to the runtime' };
}

async function restoreSelections() {
  for (const [group, name] of Object.entries(appliedProfile?.selectedNodes || {})) {
    try { await core.request('/proxies/' + encodeURIComponent(group), 'PUT', { name }); }
    catch (error) { core.log('Saved selection was not restored: ' + error.message); }
  }
}

async function start() {
  if (core.running) return;
  if (!(await fs.stat(core.runtime).catch(() => null))) await apply(store.state, store.state.activeId);
  await core.start(mixedPort);
  await restoreSelections();
}

async function status() {
  let version = null, mode = store.state.mode;
  if (core.running) {
    try {
      [version, mode] = await Promise.all([
        core.request('/version').then(v => v.version),
        core.request('/configs').then(c => c.mode),
      ]);
    } catch (error) { core.lastError = error.message; }
  }
  return { running: core.running, version, mode, mixedPort, controllerPort,
    dataDirectory: directory, activeId: store.state.activeId, appliedName: appliedProfile?.name || null,
    systemProxy: await proxyEnabled(), lastError: core.lastError, logs: core.logs };
}

async function dispatch(route, body) {
  const state = structuredClone(store.state);
  if (route === '/api/profile/create') {
    const raw = body.url ? await fetchSubscription(body.url) : body.raw;
    parseConfig(raw);
    const profile = { id: randomUUID(), name: String(body.name || 'Subscription').slice(0, 100),
      url: body.url || '', raw, override: '', rules: { mode: 'prepend', items: [] },
      updatedAt: new Date().toISOString(), selectedNodes: {} };
    state.profiles.push(profile);
    await store.save(state);
    return { status: 'saved', profile };
  }
  if (route === '/api/profile/save') {
    const profile = getProfile(body.id, state);
    if (body.name !== undefined) profile.name = String(body.name).slice(0, 100);
    if (body.url !== undefined) {
      if (body.url) {
        const url = new URL(body.url);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid URL');
      }
      profile.url = body.url;
    }
    if (body.raw !== undefined) { parseConfig(body.raw); profile.raw = body.raw; }
    if (body.override !== undefined) { parseConfig(body.override); profile.override = body.override; }
    if (body.rules !== undefined) {
      if (!body.rules || !Array.isArray(body.rules.items) || body.rules.items.length > 2000) throw new Error('Invalid rules');
      profile.rules = body.rules;
    }
    await store.save(state);
    return { status: 'saved', message: 'Draft saved; validate and apply separately' };
  }
  if (route === '/api/profile/update') {
    const profile = getProfile(body.id, state);
    if (!profile.url) throw new Error('This profile has no subscription URL');
    profile.raw = await fetchSubscription(profile.url);
    profile.updatedAt = new Date().toISOString();
    if (state.activeId === profile.id) {
      await apply(state, profile.id);
      if (core.running) await restoreSelections();
      return { status: 'applied', message: 'Subscription updated and applied; personal overrides retained' };
    }
    await store.save(state);
    return { status: 'saved', message: 'Subscription updated; personal overrides retained' };
  }
  if (route === '/api/profile/delete') {
    getProfile(body.id, state);
    state.profiles = state.profiles.filter(p => p.id !== body.id);
    if (body.id === state.activeId) { await apply(state, null); }
    else await store.save(state);
    return { status: 'saved' };
  }
  if (route === '/api/global/save') {
    parseConfig(body.yaml);
    state.globalOverride = body.yaml;
    await store.save(state);
    return { status: 'saved', message: 'Global draft saved; runtime unchanged until Apply' };
  }
  if (route === '/api/config/policies') {
    const profile = getProfile(body.id, state);
    const config = mergeYaml(mergeYaml(parseConfig(profile.raw), parseConfig(state.globalOverride)), parseConfig(profile.override));
    return { policies: policyNames(config) };
  }
  if (route === '/api/config/validate' || route === '/api/config/preview') {
    const config = compose(state, body.id ? getProfile(body.id, state) : null, controls);
    if (route.endsWith('preview')) return { yaml: dumpConfig(config, true), policies: policyNames(config) };
    const output = await core.validate(dumpConfig(config));
    return { status: 'valid', message: 'Mihomo accepted this configuration', output };
  }
  if (route === '/api/config/apply') {
    const result = await apply(state, body.id || null);
    if (core.running) await restoreSelections();
    return result;
  }
  if (route === '/api/core/start') { await start(); return { status: 'started' }; }
  if (route === '/api/core/stop' || route === '/api/core/restart') {
    if (await proxyEnabled()) await systemProxy(false);
    await core.stop();
    if (route.endsWith('restart')) await start();
    return { status: route.endsWith('restart') ? 'started' : 'stopped' };
  }
  if (route === '/api/mode') {
    if (!['rule', 'global', 'direct'].includes(body.mode)) throw new Error('Invalid mode');
    const previous = state.mode;
    const previousYaml = await fs.readFile(core.runtime, 'utf8');
    const runtime = parseConfig(previousYaml);
    runtime.mode = body.mode;
    await core.request('/configs', 'PATCH', { mode: body.mode });
    state.mode = body.mode;
    try {
      await atomicWrite(core.runtime, dumpConfig(runtime));
      await store.save(state);
    } catch (error) {
      await atomicWrite(core.runtime, previousYaml);
      await core.request('/configs', 'PATCH', { mode: previous });
      throw error;
    }
    return { status: 'applied' };
  }
  if (route === '/api/proxy/select') {
    if (typeof body.group !== 'string' || typeof body.name !== 'string') throw new Error('Invalid selection');
    const proxies = (await core.request('/proxies')).proxies;
    const group = proxies[body.group];
    if (!group || group.type !== 'Selector' || !group.all.includes(body.name)) throw new Error('Invalid selector or node');
    await core.request('/proxies/' + encodeURIComponent(body.group), 'PUT', { name: body.name });
    if (state.activeId) {
      const profile = getProfile(state.activeId, state);
      profile.selectedNodes[body.group] = body.name;
      try { await store.save(state); }
      catch (error) { await core.request('/proxies/' + encodeURIComponent(body.group), 'PUT', { name: group.now }); throw error; }
      if (appliedProfile) appliedProfile.selectedNodes = structuredClone(profile.selectedNodes);
    }
    return { status: 'applied' };
  }
  if (route === '/api/proxy/delay') {
    if (typeof body.name !== 'string') throw new Error('Node name required');
    return core.request('/proxies/' + encodeURIComponent(body.name) + '/delay?timeout=5000&url=' +
      encodeURIComponent('https://www.gstatic.com/generate_204'));
  }
  if (route === '/api/system-proxy') {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean');
    await systemProxy(body.enabled);
    return { status: 'applied' };
  }
  throw Object.assign(new Error('Unknown operation'), { status: 404 });
}

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function authorized(request) {
  const provided = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function bodyOf(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('JSON content type required'), { status: 415 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
  return body;
}

server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: 'Foreign host or origin rejected' });
    }
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request)) return json(response, 401, { error: 'Authentication required. Open the page from the tray.' });
      if (closing) return json(response, 503, { error: 'Shutting down' });
      if (request.method === 'GET') {
        if (url.pathname === '/api/state') return json(response, 200, { ...store.state, ruleTypes });
        if (url.pathname === '/api/status') return json(response, 200, await status());
        if (url.pathname === '/api/proxies') return json(response, 200, await core.request('/proxies'));
        return json(response, 404, { error: 'Unknown read operation' });
      }
      if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
      const body = await bodyOf(request);
      if (url.pathname === '/api/quit') {
        json(response, 200, { status: 'quitting' });
        void shutdown();
        return;
      }
      const result = await store.serial(() => dispatch(url.pathname, body));
      return json(response, 200, result);
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed' });
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const entry = files[url.pathname];
    if (!entry) return json(response, 404, { error: 'Not found' });
    const content = await fs.readFile(path.join(here, 'web', entry[0]));
    response.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch (error) {
    core.log('Management: ' + error.message);
    json(response, error.status || 400, { error: error.message });
  }
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(option('web-port', 0)), '127.0.0.1', resolve);
});
origin = 'http://127.0.0.1:' + server.address().port;
const instanceFile = path.join(directory, 'instance.json');
await atomicWrite(instanceFile, JSON.stringify({ pid: process.pid, url: origin + '/#token=' + token, token }));
process.stdout.write(JSON.stringify({ event: 'ready', url: origin + '/#token=' + token, token, origin, directory }) + '\n');

async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await store.queue;
  let code = 0;
  try { if (await proxyEnabled()) await systemProxy(false); }
  catch (error) { core.log(error.message); code = 1; }
  await core.stop();
  await fs.rm(instanceFile, { force: true });
  await lock.close();
  await fs.rm(lockFile, { force: true });
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('uncaughtException', error => { core.log(error.stack); void shutdown(); });
process.on('unhandledRejection', error => { core.log(String(error)); void shutdown(); });

try {
  if (await proxyEnabled()) await systemProxy(false);
  await store.serial(async () => {
    let restored = false;
    try {
      const old = parseConfig(await fs.readFile(core.runtime, 'utf8'));
      Object.assign(old, { 'external-controller': '127.0.0.1:' + controllerPort,
        secret: coreSecret, 'mixed-port': mixedPort, mode: store.state.mode });
      await core.install(dumpConfig(old), async () => {});
      restored = true;
      appliedProfile = store.state.activeId ? structuredClone(getProfile(store.state.activeId)) : null;
    } catch (error) {
      if (error.code !== 'ENOENT') core.log('Saved runtime was not restored: ' + error.message);
    }
    if (!restored) await apply(store.state, store.state.activeId);
    await start();
  });
} catch (error) {
  core.lastError = error.message;
  core.log(error.message);
}

setInterval(async () => {
  if (!closing && !core.running && await proxyEnabled()) {
    try { await store.serial(() => systemProxy(false)); }
    catch (error) { core.log(error.message); }
  }
}, 3000).unref();
