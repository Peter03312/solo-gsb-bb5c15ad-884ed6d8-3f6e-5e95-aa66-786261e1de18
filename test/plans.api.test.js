'use strict';

// 端到端：起一个真实 HTTP 服务（临时 SQLite），走 fetch 验证
// 原材登记、预览不占库存、确认原子预留、重复确认/取消幂等、并发不超卖、快照绑定。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39123';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `plans-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/materials'); break; } catch { await sleep(50); }
  }
  const d = await api('POST', '/api/designs', { name: '测试窗', width: 100, height: 100 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  const p = await api('POST', `/api/designs/${designId}/publish`);
  pubId = p.data.publication.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('原材登记：非法输入被拒绝且不产生库存', async () => {
  let r = await api('POST', '/api/materials', { name: '料X', length: -1, stock: 1 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/materials', { name: '料X', length: 6000, stock: -1 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/materials', { name: '料X', length: 6000.009, stock: 1 });
  assert.strictEqual(r.status, 400);
  const list = await api('GET', '/api/materials');
  assert.ok(!list.data.materials.some((m) => m.name === '料X'));

  const ok = await api('POST', '/api/materials', { name: '6米料', length: 6000, stock: 2 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.material.stock, 2);
  assert.strictEqual(ok.data.material.available, 2);
  assert.strictEqual(ok.data.material.lengthH, undefined, '内部整数字段不外泄');
});

test('计划参数非法拒绝（件数非正、刀损为负）', async () => {
  const mats = await api('GET', '/api/materials');
  const mid = mats.data.materials[0].id;
  assert.strictEqual((await api('POST', '/api/plans/preview', { publicationId: pubId, materialId: mid, copies: 0, kerf: 1 })).status, 400);
  assert.strictEqual((await api('POST', '/api/plans/preview', { publicationId: pubId, materialId: mid, copies: 2, kerf: -0.01 })).status, 400);
  assert.strictEqual((await api('POST', '/api/plans', { publicationId: pubId, materialId: mid, copies: 'x', kerf: 1 })).status, 400);
});

test('预览不占库存；单段放不下拒绝', async () => {
  const mats = await api('GET', '/api/materials');
  const mid = mats.data.materials[0].id;
  const before = (await api('GET', `/api/materials/${mid}`)).data.material.available;
  const pv = await api('POST', '/api/plans/preview', { publicationId: pubId, materialId: mid, copies: 3, kerf: 0.5 });
  assert.ok(pv.data.ok);
  const after = (await api('GET', `/api/materials/${mid}`)).data.material.available;
  assert.strictEqual(before, after, '预览不改可用库存');
  assert.strictEqual(pv.data.preview.requiredBars, pv.data.preview.layout.requiredBars);
  // 切段只含内部公共边 1 根 + 四框 4 根，每件 5 段
  assert.strictEqual(pv.data.preview.layout.segmentCount, 15);

  const tiny = await api('POST', '/api/materials', { name: '超短料', length: 50, stock: 9 });
  const tid = tiny.data.material.id;
  const bad = await api('POST', '/api/plans/preview', { publicationId: pubId, materialId: tid, copies: 1, kerf: 0 });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.data.code, 'segment_too_long');
});

test('草稿不预留；确认预留；重复确认不重复；取消只释放一次；并发不超卖', async () => {
  // 专用于本测试的规格：1000mm，库存 10 根；每段含刀损 <=1000 且每件恰好用 1 根
  const m = await api('POST', '/api/materials', { name: '并发专用', length: 1000, stock: 10 });
  const mid = m.data.material.id;

  // 12 个各需 1 根的草稿
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/plans', { name: `并发${i}`, publicationId: pubId, materialId: mid, copies: 1, kerf: 0.6 });
    assert.strictEqual(r.data.plan.status, 'draft');
    ids.push(r.data.plan.id);
  }
  // 草稿阶段库存未预留
  let mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 0);
  assert.strictEqual(mat.available, 10);

  // 同时确认 12 个
  const results = await Promise.all(ids.map((id) => api('POST', `/api/plans/${id}/confirm`)));
  const okN = results.filter((r) => r.data.ok).length;
  const failN = results.filter((r) => !r.data.ok).length;
  assert.strictEqual(okN, 10, '恰好 10 个抢到库存');
  assert.strictEqual(failN, 2, '2 个因缺口被拒');
  assert.ok(results.every((r) => !r.data.ok || r.data.plan.status === 'confirmed'));
  assert.ok(results.every((r) => r.data.ok || r.data.code === 'shortage'));

  mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 10);
  assert.strictEqual(mat.available, 0);

  // 重复确认：不再增加预留
  const confirmedId = results.find((r) => r.data.ok).data.plan.id;
  const again = await api('POST', `/api/plans/${confirmedId}/confirm`);
  assert.strictEqual(again.status, 409);
  mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 10);

  // 取消一个 → 释放 1 根；重复取消不再变化
  const cancel1 = await api('POST', `/api/plans/${confirmedId}/cancel`);
  assert.ok(cancel1.data.ok);
  mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 9);
  assert.strictEqual(mat.available, 1);
  const cancel2 = await api('POST', `/api/plans/${confirmedId}/cancel`);
  assert.strictEqual(cancel2.status, 409);
  mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 9, '重复取消不重复释放');

  // 释放出的 1 根可被之前被拒的草稿确认（不会超卖）
  const allPlans = (await api('GET', '/api/plans')).data.plans;
  const draftLeft = allPlans.find((p) => p.status === 'draft' && p.material.id === mid);
  assert.ok(draftLeft, '存在一个仍为草稿的计划');
  const fill = await api('POST', `/api/plans/${draftLeft.id}/confirm`);
  assert.ok(fill.data.ok, '释放后缺口计划可确认');
  mat = (await api('GET', `/api/materials/${mid}`)).data.material;
  assert.strictEqual(mat.reserved, 10);
  assert.strictEqual(mat.available, 0);
});

test('已确认计划绑定发布快照：草稿改版/新版本不影响其用料', async () => {
  const m = await api('POST', '/api/materials', { name: '快照料', length: 6000, stock: 5 });
  const mid = m.data.material.id;
  const created = await api('POST', '/api/plans', { name: '快照计划', publicationId: pubId, materialId: mid, copies: 1, kerf: 0.5 });
  const pid = created.data.plan.id;
  const confirmed = await api('POST', `/api/plans/${pid}/confirm`);
  assert.ok(confirmed.data.ok);
  const beforeSegs = confirmed.data.plan.segmentCount;
  const beforeVersion = confirmed.data.plan.version;

  // 改草稿：删一片、加两片再发布 v2
  await api('DELETE', `/api/designs/${designId}/pieces/2`);
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 50], [50, 50]] });
  await api('POST', `/api/designs/${designId}/pieces`, { color: '#abcdef', polygon: [[50, 50], [100, 50], [100, 100], [50, 100]] });
  const v2 = await api('POST', `/api/designs/${designId}/publish`);
  assert.strictEqual(v2.data.publication.version, 2);

  const reloaded = (await api('GET', `/api/plans/${pid}`)).data.plan;
  assert.strictEqual(reloaded.version, beforeVersion, '仍绑定 v1');
  assert.strictEqual(reloaded.publicationId, pubId);
  assert.strictEqual(reloaded.segmentCount, beforeSegs, '切段方案不随后续发布变化');
  assert.strictEqual(reloaded.status, 'confirmed');

  // 已确认计划不可改不可删
  assert.strictEqual((await api('PUT', `/api/plans/${pid}`, { copies: 9 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/plans/${pid}`)).status, 409);
});

test('网页与计划/库存可查询', async () => {
  const root = await fetch(BASE + '/');
  assert.strictEqual(root.status, 200);
  const plans = await api('GET', '/api/plans');
  assert.ok(Array.isArray(plans.data.plans) && plans.data.plans.length > 0);
  const mats = await api('GET', '/api/materials');
  for (const m of mats.data.materials) {
    assert.strictEqual(m.stock - m.reserved, m.available, '可用=库存-预留');
  }
});
