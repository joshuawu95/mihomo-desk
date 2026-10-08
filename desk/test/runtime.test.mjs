import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(action) {
  let last;
  for (let i = 0; i < 160; i++) {
    try { const result = await action(); if (result) return result; }
    catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last || new Error('Timed out waiting for the core');
}

test('real core: auth, subscription retention, rollback, mode/node control and lifecycle', { timeout: 120000 }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-desk-test-'));
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [mixed, controller, web] = ports;
  const executable = process.env.MIHOMO_DESK_CORE || path.join(root, 'release/MihomoDesk-0.1.0-win-x64/core/mihomo.exe');
  await fs.access(executable);
  let raw = 'proxies: []\nproxy-groups:\n  - name: TestPolicy\n    type: select\n    proxies: [DIRECT, REJECT]\nrules: ["MATCH,TestPolicy"]\n';
  const upstream = http.createServer((request, response) => {
    if (request.url === '/subscription') { response.end(raw); }
    else if (request.url === '/delay') { setTimeout(() => { response.writeHead(204); response.end(); }, 25); }
    else { response.end('real-direct-response'); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const args = [path.join(root, 'server.mjs'), '--data-dir', data, '--core', executable,
    '--mixed-port', String(mixed), '--controller-port', String(controller), '--web-port', String(web)];
  const child = spawn(process.execPath, args, { windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  let token;
  const origin = 'http://127.0.0.1:' + web;
  async function api(route, body, headers = {}) {
    const response = await fetch(origin + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  try {
    const ready = await until(() => output.includes('\n') && JSON.parse(output.split('\n')[0]));
    token = ready.token;
    await until(async () => (await api('status')).running);
    assert.equal((await fetch(origin + '/api/state')).status, 401);
    assert.equal((await fetch(origin + '/api/state', { headers: { Authorization: 'Bearer ' + token, Origin: 'https://evil.example' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: web, path: '/api/state',
        headers: { Authorization: 'Bearer ' + token, Host: 'evil.example' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      }).on('error', reject);
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(origin + '/api/core/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(origin + '/api/invoke', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    const duplicate = spawn(process.execPath, args, { windowsHide: true });
    let duplicateErrors = '';
    duplicate.stderr.on('data', data => { duplicateErrors += data; });
    assert.notEqual((await once(duplicate, 'exit'))[0], 0);
    assert.match(duplicateErrors, /already running/);
    assert.equal((await api('status')).running, true);

    const { profile } = await api('profile/create', { name: 'Integration', url: `http://127.0.0.1:${upstreamPort}/subscription` });
    const id = profile.id;
    const rules = { mode: 'append', items: [
      { type: 'DOMAIN-SUFFIX', value: 'personal.example', target: 'REJECT', enabled: true },
      { type: 'DOMAIN', value: 'disabled.example', target: 'REJECT', enabled: false },
    ] };
    await api('global/save', { yaml: 'hosts: {global.example: 192.0.2.1}\ncustom: global' });
    await api('profile/save', { id, override: 'custom: personal', rules });
    assert.equal((await api('config/validate', { id })).status, 'valid');
    await api('config/apply', { id });
    let runtime = parseConfig(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8'));
    assert.equal(runtime.custom, 'personal');
    assert.deepEqual(runtime.rules, ['DOMAIN-SUFFIX,personal.example,REJECT', 'MATCH,TestPolicy']);

    raw = raw.replace('rules: ["MATCH,TestPolicy"]', 'rules: ["DOMAIN,new.example,DIRECT", "MATCH,TestPolicy"]');
    await api('profile/update', { id });
    const saved = (await api('state')).profiles[0];
    assert.equal(saved.override, 'custom: personal');
    assert.deepEqual(saved.rules, rules);
    runtime = parseConfig(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8'));
    assert.deepEqual(runtime.rules, ['DOMAIN,new.example,DIRECT', 'DOMAIN-SUFFIX,personal.example,REJECT', 'MATCH,TestPolicy']);
    const validRuntime = await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8');
    await api('profile/save', { id, override: 'proxies: [{name: broken, type: unsupported}]' });
    await assert.rejects(api('config/apply', { id }), /validation failed/);
    assert.equal(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8'), validRuntime);
    assert.equal((await api('status')).running, true);
    await api('profile/save', { id, override: 'custom: personal' });
    const beforeBadUpdate = (await api('state')).profiles[0].raw;
    raw = 'proxies: [{name: broken, type: unsupported}]';
    await assert.rejects(api('profile/update', { id }), /validation failed/);
    assert.equal((await api('state')).profiles[0].raw, beforeBadUpdate);
    assert.equal(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8'), validRuntime);

    await api('mode', { mode: 'global' });
    assert.equal((await api('status')).mode, 'global');
    await api('mode', { mode: 'rule' });
    await api('proxy/select', { group: 'TestPolicy', name: 'REJECT' });
    assert.equal((await api('proxies')).proxies.TestPolicy.now, 'REJECT');
    await assert.rejects(api('proxy/select', { group: 'TestPolicy', name: 'missing' }), /Invalid selector/);

    async function traffic() {
      return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: mixed,
          path: `http://127.0.0.1:${upstreamPort}/traffic`, headers: { Host: '127.0.0.1:' + upstreamPort } }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; });
          response.on('end', () => resolve({ code: response.statusCode, text }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Proxy timeout')));
      });
    }
    const rejected = await traffic().catch(() => ({ code: 502 }));
    assert.notEqual(rejected.code, 200);
    await api('proxy/select', { group: 'TestPolicy', name: 'DIRECT' });
    assert.deepEqual(await traffic(), { code: 200, text: 'real-direct-response' });
    const coreToken = parseConfig(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8')).secret;
    const delay = await fetch(`http://127.0.0.1:${controller}/proxies/DIRECT/delay?timeout=2000&url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/delay`)}`,
      { headers: { Authorization: 'Bearer ' + coreToken } });
    const delayResult = await delay.json();
    assert.equal(delay.status, 200, JSON.stringify(delayResult));
    assert.equal(typeof delayResult.delay, 'number');

    await api('mode', { mode: 'direct' });
    await api('core/restart', {});
    assert.equal((await api('status')).mode, 'direct');
    assert.equal((await api('proxies')).proxies.TestPolicy.now, 'DIRECT');
    await api('core/stop', {});
    assert.equal((await api('status')).running, false);
    await api('core/start', {});
    assert.equal((await api('status')).running, true);
    await api('profile/delete', { id });
    assert.equal((await api('state')).activeId, null);
    assert.equal((await api('status')).running, true);
    const exited = once(child, 'exit');
    await api('quit', {});
    assert.equal((await exited)[0], 0, errors);
    assert.equal(await fs.stat(path.join(data, 'instance.lock')).catch(() => null), null);
    await assert.rejects(fetch(`http://127.0.0.1:${controller}/version`));
  } finally {
    if (child.exitCode === null) {
      try { await api('quit', {}); await once(child, 'exit'); }
      catch { child.kill(); }
    }
    await new Promise(resolve => upstream.close(resolve));
    assert.ok(data.startsWith(path.join(os.tmpdir(), 'mihomo-desk-test-')));
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('an occupied controller is reported without disturbing its listener', { timeout: 30000 }, async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-desk-test-'));
  const occupied = http.createServer((request, response) => response.end('existing-listener'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const controller = occupied.address().port;
  const mixed = await freePort();
  const executable = process.env.MIHOMO_DESK_CORE || path.join(root, 'release/MihomoDesk-0.1.0-win-x64/core/mihomo.exe');
  const child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--data-dir', data,
    '--core', executable, '--mixed-port', String(mixed), '--controller-port', String(controller)], { windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  let ready;
  try {
    ready = await until(() => output.includes('\n') && JSON.parse(output.split('\n')[0]));
    const response = await until(async () => {
      const result = await fetch(ready.origin + '/api/status', { headers: { Authorization: 'Bearer ' + ready.token } });
      const status = await result.json();
      return status.lastError ? status : null;
    });
    assert.equal(response.running, false);
    assert.match(response.lastError, /EADDRINUSE/);
    assert.equal(await (await fetch(`http://127.0.0.1:${controller}/`)).text(), 'existing-listener');
    const exit = once(child, 'exit');
    await fetch(ready.origin + '/api/quit', { method: 'POST',
      headers: { Authorization: 'Bearer ' + ready.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await exit)[0], 0);
    assert.equal(occupied.listening, true);
  } finally {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await new Promise(resolve => occupied.close(resolve));
    assert.ok(data.startsWith(path.join(os.tmpdir(), 'mihomo-desk-test-')));
    await fs.rm(data, { recursive: true, force: true });
  }
});
