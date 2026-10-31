// Minimal ZIP writer/reader. The writer stores files uncompressed (PDFs are
// already compressed), so backups can be opened with any unzip tool. The
// reader also handles deflated entries, in case a backup was re-zipped.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const enc = new TextEncoder();

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.stamp = dosDateTime(new Date());
  }

  addText(name, text) {
    return this.addBytes(name, enc.encode(text));
  }

  async addBlob(name, blob) {
    // Read in chunks to compute the CRC without holding big files in memory twice.
    let crc = 0;
    const CHUNK = 8 * 1024 * 1024;
    for (let pos = 0; pos < blob.size; pos += CHUNK) {
      const chunk = new Uint8Array(await blob.slice(pos, pos + CHUNK).arrayBuffer());
      crc = crc32(chunk, crc);
    }
    this.#add(name, blob, blob.size, crc);
  }

  addBytes(name, bytes) {
    this.#add(name, bytes, bytes.length, crc32(bytes));
  }

  #add(name, data, size, crc) {
    const nameBytes = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);         // version needed
    local.setUint16(6, 0x0800, true);     // UTF-8 names
    local.setUint16(8, 0, true);          // stored
    local.setUint16(10, this.stamp.time, true);
    local.setUint16(12, this.stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, this.stamp.time, true);
    cd.setUint16(14, this.stamp.date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, this.offset, true);
    this.central.push(cd.buffer, nameBytes);

    this.offset += 30 + nameBytes.length + size;
    if (this.offset > 0xffffffff) throw new Error('Backup is larger than 4 GB, which this format cannot hold.');
  }

  finish() {
    const cdSize = this.central.reduce((n, p) => n + p.byteLength, 0);
    const count = this.central.length / 2;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, count, true);
    end.setUint16(10, count, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}

export class ZipReader {
  static async open(blob) {
    const r = new ZipReader();
    r.src = blob;
    r.entries = new Map();
    const tailLen = Math.min(blob.size, 22 + 65535);
    const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file.');
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP file.');
      const method = cd.getUint16(p + 10, true);
      const compSize = cd.getUint32(p + 20, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      const localOffset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      r.entries.set(name, { name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return r;
  }

  has(name) {
    return this.entries.has(name);
  }

  // Returns the entry's contents as a Blob (a slice of the source when stored).
  async read(name, type = '') {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Missing ${name} in backup.`);
    const head = new DataView(await this.src.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
    if (head.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged ZIP file.');
    const start = e.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = this.src.slice(start, start + e.compSize, type);
    if (e.method === 0) return raw;
    if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
      const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Blob([await new Response(stream).arrayBuffer()], { type });
    }
    throw new Error(`Unsupported compression in ${name}.`);
  }

  async text(name) {
    return (await this.read(name)).text();
  }
}
