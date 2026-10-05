'use strict';

// 端到端：整套用料单（铅条 + 玻璃 一次备齐）
// 预览只读不占库存；确认同一事务原子预留两类库存，任一不足全部保持原状；
// 幂等不重复预留；取消两类各释放一次；关联单不能从原入口单独取消/修改/换单/删除；
// 原有独立计划、订单接口继续可用。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39231';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `combo-test-${process.pid}.db`);

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
    try { await api('GET', '/api/combo-orders'); break; } catch { await sleep(50); }
  }
  const d = await api('POST', '/api/designs', { name: '整套测试窗', width: 100, height: 100 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  const p = await api('POST', `/api/designs/${designId}/publish`);
  pubId = p.data.publication.id;

  // 铅条：6000mm，库存 4 根
  const m = await api('POST', '/api/materials', { name: '6m料', length: 6000, stock: 4 });
  globalThis.MID = m.data.material.id;
  // 玻璃：红 600×400 库存 3；绿 600×400 库存 1
  const r = await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 3 });
  globalThis.RID = r.data.sheet.id;
  const g = await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 1 });
  globalThis.GID = g.data.sheet.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('预览：列出铅条根数、各色张数/可用/缺口，且不占库存', async () => {
  const before = await api('GET', '/api/materials');
  const pv = await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(pv.status, 200);
  const p = pv.data.preview;
  assert.ok(p.feasible);
  assert.strictEqual(p.lead.requiredBars, 1);
  assert.strictEqual(p.lead.availableBars, 4);
  assert.strictEqual(p.glass.totalSheets, 2);
  const red = p.glass.colors.find((c) => c.color === '#ff0000');
  const green = p.glass.colors.find((c) => c.color === '#00ff00');
  assert.strictEqual(red.requiredSheets, 1);
  assert.strictEqual(red.available, 3);
  assert.strictEqual(green.requiredSheets, 1);
  assert.strictEqual(green.available, 1);
  const after = await api('GET', '/api/materials');
  assert.deepStrictEqual(before.data.materials, after.data.materials, '预览不改铅条库存');
  const sheets = (await api('GET', '/api/glass-sheets')).data.sheets;
  assert.ok(sheets.every((s) => s.reserved === 0), '预览不预留玻璃');
});

test('参数非法 / 发布版或原材不存在：拒绝且不占库存', async () => {
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: globalThis.MID, copies: 0, kerf: 0.5, gap: 0,
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: -1, gap: 0,
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: 0, gap: 51,
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', {
    publicationId: 99999, materialId: globalThis.MID, copies: 1, kerf: 0, gap: 0,
  })).status, 404);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: 99999, copies: 1, kerf: 0, gap: 0,
  })).status, 404);
});

test('确认缺 requestId 被拒绝（防止误重复提交造成双重预留）', async () => {
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(r.status, 400);
});

test('确认成功：同事务预留两类库存，并生成关联生产计划与裁片订单（同快照同件数）', async () => {
  const r = await api('POST', '/api/combo-orders', {
    name: '整套一', publicationId: pubId, materialId: globalThis.MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'combo-1',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const c = r.data.combo;
  assert.strictEqual(c.status, 'confirmed');
  assert.strictEqual(r.data.idempotent, false);
  assert.strictEqual(c.publicationId, pubId);
  assert.strictEqual(c.copies, 1);
  assert.strictEqual(c.leadPlan.status, 'confirmed');
  assert.strictEqual(c.cutOrder.status, 'confirmed');
  assert.strictEqual(c.leadPlan.publicationId, pubId);
  assert.strictEqual(c.cutOrder.publicationId, pubId);
  assert.strictEqual(c.leadPlan.comboId, c.id);
  assert.strictEqual(c.cutOrder.comboId, c.id);
  globalThis.COMBO1 = c.id;
  globalThis.PLAN1 = c.leadPlanId;
  globalThis.ORDER1 = c.cutOrderId;

  const mat = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat.reserved, 1);
  assert.strictEqual(mat.available, 3);
  const green = (await api('GET', `/api/glass-sheets/${globalThis.GID}`)).data.sheet;
  const red = (await api('GET', `/api/glass-sheets/${globalThis.RID}`)).data.sheet;
  assert.strictEqual(green.reserved, 1);
  assert.strictEqual(green.available, 0);
  assert.strictEqual(red.reserved, 1);
  assert.strictEqual(red.available, 2);
});

test('重复确认（相同 requestId）幂等返回原单，不重复预留', async () => {
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'combo-1',
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.idempotent, true);
  assert.strictEqual(r.data.combo.id, globalThis.COMBO1);
  const mat = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat.reserved, 1);
  const green = (await api('GET', `/api/glass-sheets/${globalThis.GID}`)).data.sheet;
  assert.strictEqual(green.reserved, 1);
  const combos = (await api('GET', '/api/combo-orders')).data.combos;
  assert.ok(!combos.some((c) => c.requestKey === 'combo-1' && c.id !== globalThis.COMBO1));
});

test('相同 requestId + 不同参数 → 409 冲突，不产生新单、不重复预留', async () => {
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 2, kerf: 0.5, gap: 0, requestId: 'combo-1',
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'request_conflict');
  const mat = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat.reserved, 1);
});

test('关联生产计划不能从原入口取消/修改/删除；关联订单不能取消/修改/换单/删除', async () => {
  const planId = globalThis.PLAN1, orderId = globalThis.ORDER1;
  assert.strictEqual((await api('POST', `/api/plans/${planId}/cancel`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/plans/${planId}`, { copies: 2 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/plans/${planId}`)).status, 409);
  assert.strictEqual((await api('POST', `/api/plans/${planId}/confirm`)).status, 409);

  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/cancel`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/cut-orders/${orderId}`, { copies: 2 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${orderId}`)).status, 409);
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/confirm`)).status, 409);
  // 换单预览与确认均被锁
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/replacement/preview`, {
    targetVersion: 1,
  })).status, 409);
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/replacement`, {
    targetVersion: 1,
  })).status, 409);

  // 但仍可通过原入口只读查阅
  const plan = await api('GET', `/api/plans/${planId}`);
  assert.strictEqual(plan.status, 200);
  assert.strictEqual(plan.data.plan.comboId, globalThis.COMBO1);
  const order = await api('GET', `/api/cut-orders/${orderId}`);
  assert.strictEqual(order.status, 200);
  assert.strictEqual(order.data.order.comboId, globalThis.COMBO1);
});

test('玻璃不足：整套确认失败，铅条与玻璃、任何记录全部保持原状', async () => {
  // 红色 600×400 每张可排 2 件：copies=2 需红 1（可用 2，够）；
  // 绿色排样需 2 张（两竖条 50×100 无法在 400 高内同向并列且间距不满足时开第二张，
  // 以实际排样结果为准），而绿可用为 0（已被整套一预留 1/库存 1）。
  const pv = await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId: globalThis.MID, copies: 2, kerf: 0.5, gap: 10,
  });
  const greenColor = pv.data.preview.glass.colors.find((c) => c.color === '#00ff00');
  assert.ok(greenColor.requiredSheets >= 1, '绿色至少需 1 张');
  assert.ok(greenColor.shortage > 0, '绿色有缺口（可用为 0）');

  const before = await api('GET', `/api/materials/${globalThis.MID}`);
  const beforeG = await api('GET', `/api/glass-sheets/${globalThis.GID}`);
  const planCount = (await api('GET', '/api/plans')).data.plans.length;
  const orderCount = (await api('GET', '/api/cut-orders')).data.orders.length;

  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 2, kerf: 0.5, gap: 10, requestId: 'combo-glass-short',
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'shortage');
  const g = r.data.shortages.find((s) => s.color === '#00ff00');
  assert.ok(g && g.shortage >= 1, JSON.stringify(r.data.shortages));
  assert.strictEqual(r.data.lead.shortage, 0, '铅条本身不缺');

  const after = await api('GET', `/api/materials/${globalThis.MID}`);
  const afterG = await api('GET', `/api/glass-sheets/${globalThis.GID}`);
  assert.strictEqual(after.data.material.reserved, before.data.material.reserved);
  assert.strictEqual(afterG.data.sheet.reserved, beforeG.data.sheet.reserved);
  assert.strictEqual((await api('GET', '/api/plans')).data.plans.length, planCount, '未新增计划');
  assert.strictEqual((await api('GET', '/api/cut-orders')).data.orders.length, orderCount, '未新增订单');
  assert.strictEqual((await api('GET', '/api/combo-orders')).data.combos.length, 1, '未新增整套单');
});

test('铅条不足：整套确认失败，玻璃也不留部分预留', async () => {
  // 登记 0 库存的铅条规格：玻璃充足但铅条缺口 1
  const m = await api('POST', '/api/materials', { name: '空料', length: 6000, stock: 0 });
  const emptyMid = m.data.material.id;
  const beforeR = (await api('GET', `/api/glass-sheets/${globalThis.RID}`)).data.sheet.reserved;
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: emptyMid,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'combo-lead-short',
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'shortage');
  assert.strictEqual(r.data.lead.shortage, 1);
  const afterR = (await api('GET', `/api/glass-sheets/${globalThis.RID}`)).data.sheet;
  assert.strictEqual(afterR.reserved, beforeR, '玻璃未被部分预留');
});

test('取消整套单：两类预留各释放一次；重复取消不重复变更', async () => {
  const r = await api('POST', `/api/combo-orders/${globalThis.COMBO1}/cancel`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.combo.status, 'canceled');
  assert.strictEqual(r.data.combo.leadPlan.status, 'canceled');
  assert.strictEqual(r.data.combo.cutOrder.status, 'canceled');

  const mat = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat.reserved, 0);
  assert.strictEqual(mat.available, 4);
  const green = (await api('GET', `/api/glass-sheets/${globalThis.GID}`)).data.sheet;
  assert.strictEqual(green.reserved, 0);
  assert.strictEqual(green.available, 1);
  const red = (await api('GET', `/api/glass-sheets/${globalThis.RID}`)).data.sheet;
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.available, 3);

  const again = await api('POST', `/api/combo-orders/${globalThis.COMBO1}/cancel`);
  assert.strictEqual(again.status, 409);
  const mat2 = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat2.reserved, 0, '重复取消不重复释放铅条');
  const green2 = (await api('GET', `/api/glass-sheets/${globalThis.GID}`)).data.sheet;
  assert.strictEqual(green2.reserved, 0, '重复取消不重复释放玻璃');

  // 取消后的关联单仍不能从原入口删除（保留关联记录供查阅）
  assert.strictEqual((await api('DELETE', `/api/plans/${globalThis.PLAN1}`)).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${globalThis.ORDER1}`)).status, 409);
});

test('并发确认不超卖两类库存', async () => {
  // 铅条可用 4 根；红可用 3、绿可用 1。
  // 5 个并发整套单各需 铅条 1 根 + 红 1 + 绿 1：绿只有 1 张 → 恰 1 个成功。
  const reqs = [];
  for (let i = 0; i < 5; i++) {
    reqs.push(api('POST', '/api/combo-orders', {
      name: `并发${i}`, publicationId: pubId, materialId: globalThis.MID,
      copies: 1, kerf: 0.5, gap: 0, requestId: `combo-conc-${i}`,
    }));
  }
  const results = await Promise.all(reqs);
  const okN = results.filter((r) => r.status === 201).length;
  assert.strictEqual(okN, 1, `仅 1 个整套单抢到绿色原片，实际 ${okN}`);
  assert.ok(results.every((r) => r.status === 201 || r.data.code === 'shortage'));
  const green = (await api('GET', `/api/glass-sheets/${globalThis.GID}`)).data.sheet;
  assert.strictEqual(green.reserved, 1, '绿色绝不超卖');
  const mat = (await api('GET', `/api/materials/${globalThis.MID}`)).data.material;
  assert.strictEqual(mat.reserved, 1, '铅条也只预留成功单的 1 根（失败单不留铅条）');

  const confirmed = results.find((r) => r.status === 201);
  globalThis.COMBO_CONC = confirmed.data.combo.id;
});

test('快照绑定：确认后改稿再发布，整套单用料不变', async () => {
  const cid = globalThis.COMBO_CONC;
  const before = (await api('GET', `/api/combo-orders/${cid}`)).data.combo;
  await api('DELETE', `/api/designs/${designId}/pieces/2`);
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  const v2 = await api('POST', `/api/designs/${designId}/publish`);
  assert.strictEqual(v2.data.publication.version, 2);
  const after = (await api('GET', `/api/combo-orders/${cid}`)).data.combo;
  assert.strictEqual(after.version, 1);
  assert.strictEqual(after.publicationId, before.publicationId);
  assert.strictEqual(after.leadPlan.layout.segmentCount, before.leadPlan.layout.segmentCount);
  assert.strictEqual(after.cutOrder.totalSheets, before.cutOrder.totalSheets);
});

test('原有独立计划与独立订单接口继续可用（含确认/取消）', async () => {
  // v2 快照只有红+蓝：先登记蓝原片
  await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 2 });
  const pubs = await api('GET', `/api/designs/${designId}/publications`);
  const v2id = pubs.data.publications.find((p) => p.version === 2).id;

  // 独立铅条计划：建草稿→确认→取消
  const plan = await api('POST', '/api/plans', {
    name: '独立计划', publicationId: v2id, materialId: globalThis.MID, copies: 1, kerf: 0.5,
  });
  assert.strictEqual(plan.status, 201);
  assert.strictEqual(plan.data.plan.comboId, null);
  const pid = plan.data.plan.id;
  assert.ok((await api('POST', `/api/plans/${pid}/confirm`)).data.ok);
  assert.ok((await api('POST', `/api/plans/${pid}/cancel`)).data.ok);

  // 独立裁片订单：建草稿→确认→取消
  const order = await api('POST', '/api/cut-orders', {
    name: '独立订单', publicationId: v2id, copies: 1, gap: 0,
  });
  assert.strictEqual(order.status, 201);
  assert.strictEqual(order.data.order.comboId, null);
  const oid = order.data.order.id;
  assert.ok((await api('POST', `/api/cut-orders/${oid}/confirm`)).data.ok);
  assert.ok((await api('POST', `/api/cut-orders/${oid}/cancel`)).data.ok);
});

test('整套单详情与网页可查', async () => {
  const list = await api('GET', '/api/combo-orders');
  assert.ok(Array.isArray(list.data.combos) && list.data.combos.length >= 2);
  const one = await api('GET', `/api/combo-orders/${globalThis.COMBO_CONC}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.combo.leadPlanId, one.data.combo.leadPlan.id);
  assert.strictEqual(one.data.combo.cutOrderId, one.data.combo.cutOrder.id);
  const root = await fetch(BASE + '/');
  assert.strictEqual(root.status, 200);
  const html = await root.text();
  assert.ok(html.includes('整套备料'));
});
