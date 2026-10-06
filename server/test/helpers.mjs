/**
 * 测试公共工具：启动指向临时数据目录的服务实例。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let portSeq = 4100;

export async function startTestServer() {
  const root = await mkdtemp(join(tmpdir(), 'vmap-test-'));
  const priv = join(root, 'private');
  const media = join(root, 'media');
  await mkdir(join(priv, 'photos'), { recursive: true });
  await mkdir(media, { recursive: true });

  process.env.VMAP_DB = join(priv, 'vmap.json');
  process.env.PRIVATE_PHOTOS = join(priv, 'photos');
  process.env.MEDIA_DIR = media;
  process.env.ADMIN_TOKEN = 'test-token';
  process.env.PORT = String(++portSeq);

  const mod = await import('../server.mjs');
  const { store, server, searchCache } = mod;
  const { seed } = await import('../storage.mjs');
  const { publishSnapshot } = await import('../snapshot.mjs');

  await store.init(seed);
  await new Promise((resolve) => server.listen(Number(process.env.PORT), resolve));
  publishSnapshot(store, '测试初始快照');

  const base = `http://localhost:${process.env.PORT}`;
  const http = async (path, { method = 'GET', body, token: t } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(t ? { 'x-admin-token': t } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') || ct.includes('geo') ? await res.json() : await res.text();
    return { status: res.status, data, headers: {
      get: (k) => res.headers.get(k),
      'x-cache': res.headers.get('x-cache'),
    } };
  };

  return {
    base,
    store,
    searchCache,
    db: store.data,
    admin: (path, opts = {}) => http(path, { ...opts, token: 'test-token' }),
    pub: http,
    stop: async () => {
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}
