import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file, content) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, content, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read saved state: ' + error.message);
      this.state = { version: 1, profiles: [], activeId: null, globalOverride: '', mode: 'rule' };
    }
    if (this.state.version !== 1) throw new Error('Unsupported saved state version');
  }
  async save(state) {
    await atomicWrite(this.file, JSON.stringify(state, null, 2));
    this.state = state;
  }
  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
}
