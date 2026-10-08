import { chromium } from '../.build/ui/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release/MihomoDesk-0.1.0-win-x64');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-desk-ui-'));
async function port() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
}
const args = ['--no-open', '--data-dir', data, '--mixed-port', String(await port()), '--controller-port', String(await port())];
let tray = spawn(path.join(release, 'MihomoDesk.exe'), args, { windowsHide: true });
let browser;
let instance;
async function api(route, body) {
  const response = await fetch(instance.url.split('/#')[0] + '/api/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + instance.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
try {
  for (let i = 0; i < 150; i++) {
    try { instance = JSON.parse(await fs.readFile(path.join(data, 'instance.json'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(instance, 'Tray server did not start');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(instance.url);
  await page.getByRole('heading', { name: '后台正在运行', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  await page.locator('nav button[data-tab=profiles]').click();
  await page.locator('#create-profile input[name=name]').fill('Browser test');
  await page.locator('#create-profile textarea').fill('proxies: []\nproxy-groups: [{name: BrowserPolicy, type: select, proxies: [DIRECT, REJECT]}]\nrules: ["MATCH,BrowserPolicy"]');
  await page.getByRole('button', { name: '添加订阅', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '订阅已添加' }).waitFor();
  await page.locator('nav button[data-tab=overrides]').click();
  await page.locator('#global-yaml').fill('hosts: {global.example: 192.0.2.1}\ncustom: global');
  await page.locator('#save-global').click();
  await page.getByRole('status').filter({ hasText: '全局覆写草稿已保存' }).waitFor();
  await page.locator('#profile-yaml').fill('custom: browser-personal');
  await page.locator('#save-override').click();
  await page.getByRole('status').filter({ hasText: '订阅覆写草稿已保存' }).waitFor();
  await page.locator('nav button[data-tab=rules]').click();
  await page.locator('#rule-mode').selectOption('append');
  await page.locator('#add-rule').click();
  await page.locator('#rule-rows input[aria-label="匹配值"]').fill('personal.example');
  await page.locator('#rule-rows input[aria-label="目标策略"]').fill('missing');
  await page.locator('#save-rules').click();
  await page.getByRole('status').filter({ hasText: '规则草稿已保存' }).waitFor();
  await page.locator('#rules [data-validate]').click();
  await page.getByRole('status').filter({ hasText: 'Unknown target policy' }).waitFor();
  await page.locator('#rule-rows input[aria-label="目标策略"]').fill('REJECT');
  await page.locator('#save-rules').click();
  await page.getByRole('status').filter({ hasText: '规则草稿已保存' }).waitFor();
  await page.locator('#rules [data-validate]').click();
  await page.getByRole('status').filter({ hasText: 'Mihomo 校验通过' }).waitFor();
  await page.locator('#rules [data-apply]').click();
  await page.getByRole('status').filter({ hasText: '校验通过，已应用' }).waitFor();
  const runtime = parseConfig(await fs.readFile(path.join(data, 'runtime.yaml'), 'utf8'));
  assert.equal(runtime.custom, 'browser-personal');
  assert.deepEqual(runtime.rules, ['DOMAIN-SUFFIX,personal.example,REJECT', 'MATCH,BrowserPolicy']);
  await page.screenshot({ path: path.join(root, '.build/rules.png'), fullPage: true });
  await page.locator('nav button[data-tab=nodes]').click();
  const group = page.locator('.node-card').filter({ has: page.getByRole('heading', { name: 'BrowserPolicy', exact: true }) });
  await group.locator('select').selectOption('REJECT');
  await group.getByRole('button', { name: '选择节点', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '节点已切换' }).waitFor();
  assert.equal((await api('proxies')).proxies.BrowserPolicy.now, 'REJECT');
  await group.locator('select').selectOption('DIRECT');
  await group.getByRole('button', { name: '选择节点', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '节点已切换' }).waitFor();
  await page.locator('nav button[data-tab=overview]').click();
  await page.locator('[data-mode=global]').click();
  await page.getByRole('status').filter({ hasText: '模式已在内核中生效' }).waitFor();
  assert.equal((await api('status')).mode, 'global');
  await page.screenshot({ path: path.join(root, '.build/overview.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
  assert.equal((await api('status')).running, true);
  const duplicate = spawn(path.join(release, 'MihomoDesk.exe'), args, { windowsHide: true });
  assert.equal((await once(duplicate, 'exit'))[0], 0);
  assert.equal((await api('status')).running, true);
  console.log('Edge UI, packaged tray, second-launch reuse, and browser-close persistence passed.');
  const exit = once(tray, 'exit');
  await api('quit', {});
  assert.equal((await exit)[0], 0);
  assert.equal(await fs.stat(path.join(data, 'instance.lock')).catch(() => null), null);
  const oldPid = instance.pid;
  tray = spawn(path.join(release, 'MihomoDesk.exe'), args, { windowsHide: true });
  for (let i = 0; i < 150; i++) {
    try {
      const next = JSON.parse(await fs.readFile(path.join(data, 'instance.json'), 'utf8'));
      if (next.pid !== oldPid) { instance = next; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.notEqual(instance.pid, oldPid);
  let restarted;
  for (let i = 0; i < 150; i++) {
    restarted = await api('status');
    if (restarted.running) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(restarted.running, true);
  assert.equal(restarted.mode, 'global');
  assert.equal((await api('state')).profiles[0].override, 'custom: browser-personal');
  const abruptExit = once(tray, 'exit');
  tray.kill();
  await abruptExit;
  await assert.rejects(fetch(`http://127.0.0.1:${restarted.controllerPort}/version`));
  await assert.rejects(fetch(instance.url.split('/#')[0] + '/api/status'));
  console.log('Restart persistence and Windows Job cleanup after forced tray termination passed.');
} finally {
  if (browser) await browser.close();
  if (tray.exitCode === null) {
    try { const exit = once(tray, 'exit'); await api('quit', {}); await exit; }
    catch { tray.kill(); }
  }
  assert.ok(data.startsWith(path.join(os.tmpdir(), 'mihomo-desk-ui-')));
  await fs.rm(data, { recursive: true, force: true });
}
