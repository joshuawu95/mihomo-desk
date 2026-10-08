import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { atomicWrite } from './store.mjs';

export async function assertFree(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

export class Core {
  constructor({ executable, directory, controllerPort, secret }) {
    Object.assign(this, { executable, directory, controllerPort, secret });
    this.runtime = path.join(directory, 'runtime.yaml');
    this.logs = [];
    this.child = null;
    this.lastError = null;
  }
  log(text) {
    for (const line of String(text).split(/\r?\n/).filter(Boolean)) {
      this.logs.push(line.slice(0, 4000));
    }
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
  }
  get running() { return !!this.child && this.child.exitCode === null; }
  async request(route, method = 'GET', body) {
    if (!this.running) throw new Error('Mihomo is stopped');
    const response = await fetch(`http://127.0.0.1:${this.controllerPort}${route}`, {
      method, headers: { Authorization: 'Bearer ' + this.secret, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Mihomo ${response.status}: ${text.slice(0, 2000)}`);
    return text ? JSON.parse(text) : {};
  }
  async validate(yaml) {
    const candidate = path.join(this.directory, 'candidate.yaml');
    await atomicWrite(candidate, yaml);
    const child = spawn(this.executable, ['-t', '-d', this.directory, '-f', candidate], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-20000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      const [code] = await once(child, 'exit');
      if (code !== 0) throw new Error('Configuration validation failed:\n' + output);
      return output;
    } finally {
      clearTimeout(timer);
      await fs.rm(candidate, { force: true });
    }
  }
  async start(mixedPort) {
    if (this.running) return;
    await assertFree(this.controllerPort);
    await assertFree(mixedPort);
    const child = spawn(this.executable, ['-d', this.directory, '-f', this.runtime], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', data => this.log(data));
    child.stderr.on('data', data => this.log(data));
    child.on('error', error => { this.lastError = error.message; this.log(error.message); });
    child.on('exit', code => {
      if (this.child === child) this.child = null;
      if (code) { this.lastError = 'Mihomo exited with code ' + code; this.log(this.lastError); }
    });
    for (let i = 0; i < 100; i++) {
      if (!this.running) throw new Error(this.lastError || 'Mihomo exited during startup');
      try {
        await this.request('/version');
        this.lastError = null;
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await this.stop();
    throw new Error('Mihomo controller did not become ready');
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  async install(yaml, persist) {
    await this.validate(yaml);
    let previous;
    try { previous = await fs.readFile(this.runtime, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await atomicWrite(this.runtime, yaml);
    try {
      if (this.running) await this.request('/configs?force=true', 'PUT', { path: this.runtime });
      await persist();
    } catch (error) {
      if (previous !== undefined) {
        await atomicWrite(this.runtime, previous);
        if (this.running) {
          try { await this.request('/configs?force=true', 'PUT', { path: this.runtime }); }
          catch (rollback) {
            await this.stop();
            throw new Error(error.message + '\nRuntime rollback failed; core stopped: ' + rollback.message);
          }
        }
      } else await fs.rm(this.runtime, { force: true });
      throw error;
    }
  }
}
