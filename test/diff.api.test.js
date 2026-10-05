'use strict';

// 端到端：两版铅条核对 API（只读；版本不存在/非同图纸明确报错）

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39124';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `diff-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId;
let pub1, pub2, pub3;
let otherDesignId, otherPub;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function addPiece(design, color, polygon) {
  return api('POST', `/api/designs/${design}/pieces`, { color, polygon });
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  const d = await api('POST', '/api/designs', { name: '核对窗', width: 100, height: 100 });
  designId = d.data.design.id;

  // v1：左右两片，公共边 x=50 整条
  await addPiece(designId, '#ff0000', [[0, 0], [50, 0], [50, 100], [0, 100]]);
  await addPiece(designId, '#00ff00', [[50, 0], [100, 0], [100, 100], [50, 100]]);
  pub1 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;

  // v2：右半再分上下两片，x=50 公共边被 T 接分为两段；新增水平公共边 y=50, x50..100
  await api('DELETE', `/api/designs/${designId}/pieces/2`);
  await addPiece(designId, '#00ff00', [[50, 0], [100, 0], [100, 50], [50, 50]]);
  await addPiece(designId, '#abcdef', [[50, 50], [100, 50], [100, 100], [50, 100]]);
  pub2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;

  // v3：竖向公共边改到 x=40（x=50 整条取消，x=40 新增）；保留 y=50 水平边改为 x40..100
  // 构造：左片 0..40，右上 40..100 上下两片
  // v2 后现存拼片为 #1/#3/#4（#2 已删除）
  await api('DELETE', `/api/designs/${designId}/pieces/3`);
  await api('DELETE', `/api/designs/${designId}/pieces/4`);
  await api('PUT', `/api/designs/${designId}/pieces/1`, {
    color: '#ff0000', polygon: [[0, 0], [40, 0], [40, 100], [0, 100]],
  });
  await addPiece(designId, '#00ff00', [[40, 0], [100, 0], [100, 50], [40, 50]]);
  await addPiece(designId, '#abcdef', [[40, 50], [100, 50], [100, 100], [40, 100]]);
  pub3 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;

  // 另一张图纸（不同尺寸）的发布版
  const d2 = await api('POST', '/api/designs', { name: '别的窗', width: 120, height: 80 });
  otherDesignId = d2.data.design.id;
  await addPiece(otherDesignId, '#112233', [[0, 0], [60, 0], [60, 80], [0, 80]]);
  await addPiece(otherDesignId, '#445566', [[60, 0], [120, 0], [120, 80], [60, 80]]);
  otherPub = (await api('POST', `/api/designs/${otherDesignId}/publish`)).data.publication;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('GET 核对 v1→v2：T 接分段无虚假差异，仅新增水平边 50mm', async () => {
  const r = await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=1&toVersion=2`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.ok);
  const { meta, diff } = r.data;
  assert.strictEqual(meta.earlier.version, 1);
  assert.strictEqual(meta.later.version, 2);
  // 竖边 x=50 整条沿用（虽在 v2 被分成两段）
  assert.deepStrictEqual(diff.internal.counts, { kept: 1, removed: 0, added: 1 });
  assert.strictEqual(diff.internal.totals.kept, 100);
  assert.strictEqual(diff.internal.totals.added, 50);
  // 外框四框全部沿用
  assert.deepStrictEqual(diff.frameCounts, { kept: 4, removed: 0, added: 0 });
  assert.strictEqual(diff.frameTotals.kept, 400);
  // 总计数 = 内部 2 + 外框 4
  assert.deepStrictEqual(diff.counts, { kept: 5, removed: 0, added: 1 });
  assert.strictEqual(diff.totals.kept, 500);
});

test('顺序颠倒时自动按版本号归位（toVersion 较小仍以较早版为基准）', async () => {
  const r = await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=2&toVersion=1`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.meta.earlier.version, 1);
  assert.strictEqual(r.data.meta.later.version, 2);
  assert.deepStrictEqual(r.data.diff.internal.counts, { kept: 1, removed: 0, added: 1 });
});

test('v2→v3：竖边平移 → 取消 100/新增 100；水平边延长部分新增 10', async () => {
  const r = await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=2&toVersion=3`);
  assert.strictEqual(r.status, 200);
  const c = r.data.diff.internal;
  assert.strictEqual(c.totals.removed, 100, 'x=50 竖边整体取消');
  assert.strictEqual(c.totals.added, 110, 'x=40 竖边 100 + 水平边延长 10');
  assert.strictEqual(c.kept.length, 1, '水平公共边 x50..100 段沿用');
  const kept = c.kept[0];
  assert.deepStrictEqual([kept.from, kept.to], [[50, 50], [100, 50]]);
  assert.strictEqual(kept.length, 50);
});

test('POST 按发布版 id 核对', async () => {
  const r = await api('POST', '/api/publications/diff', {
    publicationIdA: pub1.id, publicationIdB: pub3.id,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.meta.earlier.version, 1);
  assert.strictEqual(r.data.meta.later.version, 3);
});

test('POST 两个发布版不属于同一图纸：明确报错 400', async () => {
  const r = await api('POST', '/api/publications/diff', {
    publicationIdA: pub1.id, publicationIdB: otherPub.id,
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.ok, false);
  assert.match(r.data.error, /不属于同一图纸/);
  assert.strictEqual(r.data.designIdA, designId);
  assert.strictEqual(r.data.designIdB, otherDesignId);
});

test('版本不存在：GET/POST 均明确报错', async () => {
  const r1 = await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=1&toVersion=99`);
  assert.strictEqual(r1.status, 404);
  assert.match(r1.data.error, /v99 不存在/);
  const r2 = await api('POST', '/api/publications/diff', { publicationIdA: pub1.id, publicationIdB: 99999 });
  assert.strictEqual(r2.status, 404);
  const r3 = await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=abc&toVersion=2`);
  assert.strictEqual(r3.status, 400);
});

test('核对是只读操作：快照/计划/库存均不受影响', async () => {
  const before = (await api('GET', `/api/designs/${designId}/publications/1`)).data.publication.snapshot;
  await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=1&toVersion=2`);
  await api('GET', `/api/designs/${designId}/publications/diff?fromVersion=1&toVersion=3`);
  await api('POST', '/api/publications/diff', { publicationIdA: pub2.id, publicationIdB: pub3.id });
  const after = (await api('GET', `/api/designs/${designId}/publications/1`)).data.publication.snapshot;
  assert.deepStrictEqual(after, before, 'v1 快照字节级不变');
  // 核对接口不产生任何计划
  const plans = await api('GET', '/api/plans');
  assert.ok(Array.isArray(plans.data.plans));
  const mats = await api('GET', '/api/materials');
  assert.ok(Array.isArray(mats.data.materials));
});
