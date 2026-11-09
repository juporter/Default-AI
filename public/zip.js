// Minimal .zip reader (stored and deflate entries, including ZIP64), using
// the platform's DecompressionStream for inflating. Works in browsers and Node.
// Used for chat-export .zip files and Word .docx files.

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This .zip file can't be read (no central directory).");

  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
      const zip64 = Number(view.getBigUint64(locator + 8, true));
      if (view.getUint32(zip64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(zip64 + 32, true));
        offset = Number(view.getBigUint64(zip64 + 48, true));
      }
    }
  }

  const entries = [];
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("This .zip file can't be read (damaged directory).");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    let localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));

    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(view.getBigUint64(q, true))), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = Number(view.getBigUint64(q, true))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, localOffset, encrypted: Boolean(flags & 1) });
    p = extraEnd + commentLength;
  }
  return entries;
}

export async function readZipEntry(bytes, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} is password-protected.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== 0x04034b50) throw new Error("This .zip file can't be read (damaged entry).");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`${entry.name} uses a compression method this app can't read.`);
}
