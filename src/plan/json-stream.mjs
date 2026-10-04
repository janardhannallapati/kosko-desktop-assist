// Writes one JSON object to a file a piece at a time, so a 5,532-note plan (or a 100× one) never has to sit in
// memory as a single string. Arrays are streamed element by element from any iterable.
import { chmodSync, closeSync, openSync, writeSync } from 'node:fs';

// fs.writeSync may write fewer bytes than asked (a full disk, a quota) without throwing; loop until all are written.
function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error('could not write the plan file (is the disk full?)');
    off += n;
  }
}

export class JsonObjectWriter {
  constructor(path, { mode = 0o600 } = {}) {
    this.fd = openSync(path, 'w', mode);
    chmodSync(path, mode); // the mode argument applies only when the file is created
    this.first = true;
    writeAll(this.fd, '{');
  }

  #key(name) {
    writeAll(this.fd, `${this.first ? '\n' : ',\n'}${JSON.stringify(name)}: `);
    this.first = false;
  }

  value(name, v) {
    this.#key(name);
    writeAll(this.fd, JSON.stringify(v));
  }

  /** Streams an iterable as a JSON array; returns how many elements were written. */
  array(name, iterable) {
    this.#key(name);
    writeAll(this.fd, '[');
    let n = 0;
    for (const item of iterable) writeAll(this.fd, `${n++ ? ',' : ''}\n  ${JSON.stringify(item)}`);
    writeAll(this.fd, n ? '\n]' : ']');
    return n;
  }

  close() {
    if (this.fd == null) return;
    try { writeAll(this.fd, '\n}\n'); } finally { closeSync(this.fd); this.fd = null; }
  }

  /** Closes without finishing the document (the caller deletes the file). */
  abort() {
    if (this.fd == null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}
