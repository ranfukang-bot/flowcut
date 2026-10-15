const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 5 * 1024 * 1024;

class WorkbenchLog {
  constructor(root, { now = () => new Date(), maxBytes = MAX_BYTES } = {}) {
    this.file = path.join(root, 'logs', 'workbench.log');
    this.now = now; this.maxBytes = maxBytes; this.pending = []; this.writer = null; this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.day = fs.existsSync(this.file) ? fs.statSync(this.file).mtime.toISOString().slice(0, 10) : this.today();
  }
  today() { return this.now().toISOString().slice(0, 10); }
  tail() {
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const size = fs.fstatSync(fd).size, start = Math.max(0, size - 256 * 1024);
        const data = Buffer.alloc(size - start); fs.readSync(fd, data, 0, data.length, start);
        const lines = data.toString('utf8').split('\n');
        if (start) lines.shift();
        return lines.filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-300);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
  }
  append(entry) {
    this.pending.push(JSON.stringify(entry) + '\n');
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 0);
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.writer) { await this.writer; if (this.pending.length) await this.flush(); return; }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0).join('');
    this.writer = (async () => {
      try {
        const size = await fs.promises.stat(this.file).then(s => s.size, () => 0);
        if (size && (size + Buffer.byteLength(batch) > this.maxBytes || this.day !== this.today())) {
          await fs.promises.rename(this.file, path.join(path.dirname(this.file), `workbench-${this.day}-${Date.now()}-${process.hrtime.bigint()}.log`));
        }
        this.day = this.today();
        await fs.promises.appendFile(this.file, batch);
        this.error = null;
      } catch (error) { this.error = error; /* diagnostics must never stop a task */ }
    })();
    await this.writer; this.writer = null;
    if (this.pending.length) await this.flush();
  }
}
module.exports = { WorkbenchLog, MAX_BYTES };
