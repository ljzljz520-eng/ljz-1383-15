import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripMetadata, hasMetadataTrace, detectFormat } from '../exif.mjs';

// ---- 构造带 EXIF/GPS 的最小合法容器（无需像素可解码，段/chunk 结构合法即可） ----
function jpegWithExif() {
  const exifPayload = Buffer.concat([
    Buffer.from('Exif\x00\x00', 'ascii'),
    Buffer.from('GPS\x00'.padEnd(512, 'x')), // 伪造 GPS IFD 数据
  ]);
  const exifSeg = Buffer.alloc(2 + exifPayload.length);
  exifSeg.writeUInt16BE(exifPayload.length + 2, 0);
  exifPayload.copy(exifSeg, 2);

  const dqtPayload = Buffer.from([0x00, ...Buffer.alloc(67, 1)]);
  const dqtSeg = Buffer.alloc(4);
  dqtSeg.writeUInt16BE(dqtPayload.length + 2, 2);
  dqtSeg[0] = 0xff; dqtSeg[1] = 0xdb;

  const sofPayload = Buffer.alloc(11, 2);
  const sofSeg = Buffer.alloc(4);
  sofSeg.writeUInt16BE(sofPayload.length + 2, 2);
  sofSeg[0] = 0xff; sofSeg[1] = 0xc0;

  const sosPayload = Buffer.from([0x01, 0x11, 0x00, 0x02, 0x11, 0x00]);
  const sosHead = Buffer.alloc(4);
  sosHead.writeUInt16BE(sosPayload.length + 2, 2);
  sosHead[0] = 0xff; sosHead[1] = 0xda;
  const entropy = Buffer.from([0x00, 0x12, 0x34, 0xff, 0x00, 0x56]); // 含 0xff00 转义

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.concat([Buffer.from([0xff, 0xe1]), exifSeg]),
    Buffer.concat([dqtSeg, dqtPayload]),
    Buffer.concat([sofSeg, sofPayload]),
    Buffer.concat([sosHead, sosPayload]),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function pngWithExif() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC 占位（剥离时重算）
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('eXIf', Buffer.from('Exif\x00\x00GPSlatitude_secret', 'ascii')),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function webpWithExif() {
  const vp8x = Buffer.from('VP8X', 'ascii');
  const vp8xLen = Buffer.alloc(4); vp8xLen.writeUInt32LE(10, 0);
  const vp8xBody = Buffer.alloc(10);
  const exifData = Buffer.from('Exif\x00\x00GPS=116.3805,39.9122SECRET', 'ascii');
  const exifHead = Buffer.concat([Buffer.from('EXIF', 'ascii'), (() => {
    const b = Buffer.alloc(4); b.writeUInt32LE(exifData.length, 0); return b;
  })()]);
  const bitstream = Buffer.concat([Buffer.from('VP8 ', 'ascii'), (() => {
    const b = Buffer.alloc(4); b.writeUInt32LE(4, 0); return b;
  })(), Buffer.from([0x30, 0x01, 0x00, 0x9d])]);
  const body = Buffer.concat([vp8x, vp8xLen, vp8xBody, bitstream, exifHead, exifData]);
  const riff = Buffer.from('RIFF', 'ascii');
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length + 4, 0);
  return Buffer.concat([riff, size, Buffer.from('WEBP', 'ascii'), body]);
}

test('EXIF 剥离：JPEG 删除 APP1/EXIF-GPS，保留解码必需段', () => {
  const src = jpegWithExif();
  assert.equal(hasMetadataTrace(src), true);
  const { format, buffer } = stripMetadata(src);
  assert.equal(format, 'jpg');
  assert.equal(hasMetadataTrace(buffer), false);
  assert.ok(!buffer.toString('latin1').includes('GPS'));
  assert.ok(buffer.includes(Buffer.from([0xff, 0xdb]))); // DQT 保留
  assert.ok(buffer.includes(Buffer.from([0xff, 0xda]))); // SOS 保留
  assert.ok(buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  assert.ok(buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
});

test('EXIF 剥离：PNG 删除 eXIf chunk，IHDR/IDAT/IEND 完整', () => {
  const { buffer } = stripMetadata(pngWithExif());
  assert.equal(hasMetadataTrace(buffer), false);
  assert.ok(buffer.includes(Buffer.from('IHDR')));
  assert.ok(buffer.includes(Buffer.from('IDAT')));
  assert.ok(buffer.slice(-12).includes(Buffer.from('IEND')));
});

test('EXIF 剥离：WebP 删除 EXIF chunk，VP8 流保留，尺寸头重算', () => {
  const { buffer } = stripMetadata(webpWithExif());
  assert.equal(hasMetadataTrace(buffer), false);
  assert.ok(!buffer.toString('latin1').includes('SECRET'));
  assert.ok(buffer.includes(Buffer.from('VP8 ')));
  assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8);
});

test('幂等/旧派生图重处理：清洗结果再次处理不复活元数据', () => {
  const once = stripMetadata(jpegWithExif()).buffer;
  const twice = stripMetadata(once).buffer;
  assert.equal(hasMetadataTrace(twice), false);
  assert.ok(once.equals(twice), '对干净图重复清洗应稳定');
});

test('拒绝非图片/RAW 输入', () => {
  assert.throws(() => stripMetadata(Buffer.from('not an image')), /不支持/);
});

// ---- 端到端：上传 -> 公开媒体只出清洗图；旧派生图被注入后重处理修复 ----
test('上传链路：私有区保留原图，媒体区干净；媒体接口对脏图返回 409', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const t = await startTestServer();
  try {
    const src = jpegWithExif();
    const b64 = src.toString('base64');
    const up = await t.admin('/api/admin/photos', {
      method: 'POST',
      body: { eventId: 'evt_2024_b1', dataBase64: b64, filename: 'gps.jpg' },
    });
    assert.equal(up.status, 200);
    assert.equal(up.data.metadataStripped, true);
    const photoId = up.data.photo.id;

    // 私有原图存在且带 EXIF（仅管理文件系统，不经 HTTP 暴露）
    const orig = await readFile(`${process.env.PRIVATE_PHOTOS}/${photoId}.orig`);
    assert.equal(hasMetadataTrace(orig), true);

    // /data/private 无法通过静态路径访问
    const blocked = await t.pub(`/data/private/photos/${photoId}.orig`);
    assert.equal(blocked.status, 403);

    // 媒体区干净，正常可取
    const mediaRes = await fetch(`${t.base}/media/${photoId}.jpg`);
    assert.equal(mediaRes.status, 200);
    const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
    assert.equal(hasMetadataTrace(mediaBuf), false);

    // 验收：模拟“旧派生图仍带元数据”（历史脏文件/手工污染）
    const mediaPath = `${process.env.MEDIA_DIR}/${photoId}.jpg`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(mediaPath, src); // 直接把带 EXIF 的图塞回媒体区
    const dirtyRes = await fetch(`${t.base}/media/${photoId}.jpg`);
    assert.equal(dirtyRes.status, 409, '带元数据的派生图不得对外');

    // 管理端从私有原图重处理后恢复
    const re = await t.admin('/api/admin/photos/reprocess', { method: 'POST' });
    assert.equal(re.status, 200);
    const fixed = re.data.results.find((r) => r.id === photoId);
    assert.equal(fixed.metadataStripped, true);

    const audit = await t.admin('/api/admin/photos/audit');
    assert.deepEqual(audit.data.filesWithMetadata, []);
    const okRes = await fetch(`${t.base}/media/${photoId}.jpg`);
    assert.equal(okRes.status, 200);
  } finally {
    await t.stop();
  }
});
