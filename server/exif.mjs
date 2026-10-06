/**
 * exif.mjs —— 上传照片的私有元数据剥离（零依赖）
 *
 * 要求：不只是前端移除；服务端必须清洗。且“旧的派生图”若被再次处理或历史上
 * 混入过元数据，重新派生时一律重新清洗（幂等）。公开媒体只可能来自 stripMetadata 的输出。
 *
 * 处理：
 *  - JPEG：仅保留 DHT/DQT/SOF0/SOS/RSTn/COM/DRI，删除 APP0..APP15（含 EXIF/GPS/XMP）；
 *  - PNG ：仅保留 IHDR/IDAT/PLTE/tRNS/gAMA/cHRM/sRGB/iCCP/sBIT，丢弃 eXIf/iTXt/...；
 *  - WebP：删除 EXIF / XMP / ICCP chunk。
 */

export function detectFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stripJpeg(input) {
  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) { i++; continue; }
    // 跳过填充 0xff
    while (i < input.length && input[i] === 0xff) i++;
    const marker = input[i++];
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); break; } // EOI
    if (marker === 0xda) { // SOS：段头后是熵编码数据（0xff00 转义，勿在内部找标记），保留到 EOI
      const len = input.readUInt16BE(i);
      const sosStart = i - 2;
      let p = i + len;
      while (p < input.length - 1) {
        if (input[p] !== 0xff) { p++; continue; }
        const next = input[p + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; } // 转义 / RSTn
        break; // EOI 或其他标记：熵流结束
      }
      const hasEoi = input[p] === 0xff && input[p + 1] === 0xd9;
      out.push(input.subarray(sosStart, hasEoi ? p + 2 : p));
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(Buffer.from([0xff, marker])); continue; } // RSTn
    if (marker === 0x01 || marker === 0xd8) continue;
    if (i + 2 > input.length) break;
    const segLen = input.readUInt16BE(i);
    const segStart = i - 2;
    const segEnd = i + segLen;
    // 仅保留与像素重建相关的段；APPn（EXIF=APP1、XMP=APP1、JFIF=APP0）全部丢弃
    const keep =
      marker === 0xdb || // DQT
      marker === 0xc0 || marker === 0xc2 || // SOF
      marker === 0xc4 || // DHT
      marker === 0xdd || // DRI
      marker === 0xfe;   // COM
    if (keep) out.push(input.subarray(segStart, segEnd));
    i = segEnd;
  }
  return Buffer.concat(out);
}

function stripPng(input) {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT']);
  const chunks = [input.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= input.length) {
    const len = input.readUInt32BE(i);
    const type = input.toString('ascii', i + 4, i + 8);
    const data = input.subarray(i + 8, i + 8 + len);
    const end = i + 12 + len; // 跳过 CRC
    if (keep.has(type)) {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(len, 0);
      head.write(type, 4, 'ascii');
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body), 0);
      chunks.push(head, data, crc);
    }
    i = end;
  }
  chunks.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  return Buffer.concat(chunks);
}

function stripWebp(input) {
  const drop = new Set(['EXIF', 'XMP ', 'ICCP']);
  const kept = [];
  let i = 12;
  while (i + 8 <= input.length) {
    const fourcc = input.toString('ascii', i, i + 4);
    const len = input.readUInt32LE(i + 4);
    const chunkBuf = input.subarray(i, i + 8 + len);
    if (!drop.has(fourcc)) kept.push(chunkBuf);
    i += 8 + len + (len % 2); // 偶数填充
  }
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  input.subarray(0, 12).copy(head);
  head.writeUInt32LE(body.length + 4, 4); // RIFF size
  return Buffer.concat([head, body]);
}

/**
 * 剥离元数据，返回 { format, buffer } 或抛出不支持格式错误。
 * 幂等：对已清洗的派生图再次执行仍然安全（验收：旧派生图重处理不复活元数据）。
 */
export function stripMetadata(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const format = detectFormat(buf);
  if (!format) throw new Error('不支持的图片格式（仅接受 JPEG/PNG/WebP，且不接受原始 RAW）');
  if (format === 'jpeg') return { format: 'jpg', buffer: stripJpeg(buf) };
  if (format === 'png') return { format: 'png', buffer: stripPng(buf) };
  return { format: 'webp', buffer: stripWebp(buf) };
}

/** 测试/审计用：缓冲区中是否还残留 EXIF/GPS 痕迹。 */
export function hasMetadataTrace(buf) {
  const format = detectFormat(buf);
  if (format === 'jpeg') {
    let i = 2;
    while (i < buf.length - 4) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xda) break;
      if (marker >= 0xe0 && marker <= 0xef) return true;
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
    return false;
  }
  if (format === 'png') return buf.includes(Buffer.from('eXIf')) || buf.includes(Buffer.from('iTXt'));
  if (format === 'webp') return buf.includes(Buffer.from('EXIF'));
  return false;
}
