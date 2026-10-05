'use strict';

// 端到端：库存盘点（同一张盘点单盘点铅条原材 + 玻璃原片）
// 预览固化基准但不改库存；确认在同一事务重核所有规格的库存与预留，
// 任一项基准不符或实盘数低于当前预留则整单不生效；全部通过一次更新库存；
// 已确认单重复提交返回同一记录；独立计划/裁片订单/整套单继续按盘点后库存计算；
// 原有库存调整入口继续可用。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39241';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `stocktake-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId;
let MID, RID, GID;

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
    try { await api('GET', '/api/stocktakes'); break; } catch { await sleep(50); }
  }
  // 铅条：300mm 定尺（每段含刀损放不下 3 根），库存 10 根
  const m = await api('POST', '/api/materials', { name: '300料', length: 300, stock: 10 });
  MID = m.data.material.id;
  const r = await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 5 });
  RID = r.data.sheet.id;
  const g = await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 5 });
  GID = g.data.sheet.id;

  const d = await api('POST', '/api/designs', { name: '盘点测试窗', width: 100, height: 100 });
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

test('预览入参校验：空项/非法类型/负实盘/小数/同单重复规格一律拒绝', async () => {
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', { items: [] })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {})).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'wood', specId: MID, counted: 1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: -1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 1.5 }],
  })).status, 400);
  const dup = await api('POST', '/api/stocktakes/preview', {
    items: [
      { type: 'lead', specId: MID, counted: 1 },
      { type: 'lead', specId: MID, counted: 2 },
    ],
  });
  assert.strictEqual(dup.status, 400);
  assert.strictEqual(dup.data.code, 'duplicate_spec');
  // 铅条与玻璃即使数字 id 相同也不算重复
  const cross = await api('POST', '/api/stocktakes/preview', {
    items: [
      { type: 'lead', specId: MID, counted: 1 },
      { type: 'glass', specId: MID, counted: 1 },
    ],
  });
  assert.strictEqual(cross.status, 201);
  globalThis.TMP_ID = cross.data.stocktake.id;
  // 不存在的规格 → 404
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: 99999, counted: 1 }],
  })).status, 404);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'glass', specId: 99999, counted: 1 }],
  })).status, 404);
});

test('预览：固化各项当时的系统库存/预留/差异/实盘后可用量，且不改库存', async () => {
  // 清掉上一测试的草稿
  await api('DELETE', `/api/stocktakes/${globalThis.TMP_ID}`);

  const r = await api('POST', '/api/stocktakes/preview', {
    name: '六月盘点',
    items: [
      { type: 'lead', specId: MID, counted: 7 },
      { type: 'glass', specId: RID, counted: 4 },
    ],
  });
  assert.strictEqual(r.status, 201);
  const s = r.data.stocktake;
  assert.strictEqual(s.status, 'draft');
  assert.strictEqual(s.name, '六月盘点');
  assert.strictEqual(s.itemCount, 2);
  assert.strictEqual(s.leadCount, 1);
  assert.strictEqual(s.glassCount, 1);
  assert.strictEqual(s.confirmedAt, null);
  const lead = s.items.find((i) => i.type === 'lead');
  assert.strictEqual(lead.stock, 10);
  assert.strictEqual(lead.reserved, 0);
  assert.strictEqual(lead.counted, 7);
  assert.strictEqual(lead.diff, -3);
  assert.strictEqual(lead.availableAfterCount, 7);
  assert.strictEqual(lead.length, 300);
  const red = s.items.find((i) => i.type === 'glass');
  assert.strictEqual(red.color, '#ff0000');
  assert.strictEqual(red.stock, 5);
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.counted, 4);
  assert.strictEqual(red.diff, -1);
  assert.strictEqual(red.availableAfterCount, 4);

  // 预览不改库存
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 10);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 5);

  // 列表与详情可查
  const list = await api('GET', '/api/stocktakes');
  assert.ok(list.data.stocktakes.some((x) => x.id === s.id && x.itemCount === 2));
  globalThis.ST1 = s.id;
});

test('确认时基准已不符：预览后改动库存 → 409 返回该项与原因，整单不生效', async () => {
  // 预览后通过原库存调整入口改了铅条库存
  const pa = await api('PATCH', `/api/materials/${MID}`, { stock: 9 });
  assert.strictEqual(pa.status, 200);
  const r = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'baseline_mismatch');
  const bad = r.data.items.find((i) => i.type === 'lead');
  assert.strictEqual(bad.reason, 'stock_changed');
  assert.strictEqual(bad.baselineStock, 10);
  assert.strictEqual(bad.currentStock, 9);
  assert.strictEqual(bad.countedStock, 7);
  // 红色项未出现在问题列表中
  assert.ok(!r.data.items.some((i) => i.type === 'glass'));
  // 整单未生效：库存未按实盘调整，单子仍为草稿
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 9);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 5);
  assert.strictEqual((await api('GET', `/api/stocktakes/${globalThis.ST1}`)).data.stocktake.status, 'draft');
});

test('PUT 草稿可重选项/改实盘并重新固化基准；确认成功后两类库存一次更新', async () => {
  // 库存恢复到 10，重新保存草稿（基准刷新）
  await api('PATCH', `/api/materials/${MID}`, { stock: 10 });
  const put = await api('PUT', `/api/stocktakes/${globalThis.ST1}`, {
    name: '六月盘点（修正）',
    items: [
      { type: 'lead', specId: MID, counted: 7 },
      { type: 'glass', specId: RID, counted: 4 },
    ],
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.data.stocktake.items[0].stock, 10, '基准已重新固化为 10');

  const r = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.idempotent, false);
  const s = r.data.stocktake;
  assert.strictEqual(s.status, 'confirmed');
  assert.ok(s.confirmedAt);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 7);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 4);
});

test('已确认盘点重复提交：返回同一记录，不再调整库存', async () => {
  const r1 = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.data.idempotent, true);
  assert.strictEqual(r1.data.stocktake.id, globalThis.ST1);
  // 再改库存后重复提交，仍返回原记录且不动库存
  await api('PATCH', `/api/materials/${MID}`, { stock: 8 });
  const r2 = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.idempotent, true);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 8);
  // 记录里保留原值与实盘值（不随后续库存变动回写）
  const s = (await api('GET', `/api/stocktakes/${globalThis.ST1}`)).data.stocktake;
  const lead = s.items.find((i) => i.type === 'lead');
  assert.strictEqual(lead.stock, 10);       // 盘点时的系统库存（原值）
  assert.strictEqual(lead.counted, 7);     // 实盘值
  assert.strictEqual(lead.diff, -3);
  assert.strictEqual(lead.availableAfterCount, 7);
  assert.strictEqual(lead.currentStock, 8); // 实时口径为当前库存
  assert.ok(s.confirmedAt);
});

test('已确认盘点不可修改/删除；未知盘点单返回 404；草稿可删除', async () => {
  assert.strictEqual((await api('PUT', `/api/stocktakes/${globalThis.ST1}`, {
    items: [{ type: 'lead', specId: MID, counted: 1 }],
  })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/stocktakes/${globalThis.ST1}`)).status, 409);
  assert.strictEqual((await api('GET', '/api/stocktakes/99999')).status, 404);
  assert.strictEqual((await api('POST', '/api/stocktakes/99999/confirm')).status, 404);
  const d0 = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 8 }],
  });
  assert.strictEqual((await api('DELETE', `/api/stocktakes/${d0.data.stocktake.id}`)).status, 200);
  assert.strictEqual((await api('GET', `/api/stocktakes/${d0.data.stocktake.id}`)).status, 404);
  // 库存恢复 8（后续用）
  await api('PATCH', `/api/materials/${MID}`, { stock: 8 });
});

test('预览后已确认预留发生变化：确认返回 reserved_changed，整单不生效', async () => {
  // 先建并确认一个独立铅条计划（copies=2）
  const pv = await api('POST', '/api/plans/preview', {
    publicationId: pubId, materialId: MID, copies: 2, kerf: 0.5,
  });
  const R = pv.data.preview.requiredBars;
  assert.ok(R >= 1);
  globalThis.R = R;
  const plan = await api('POST', '/api/plans', {
    name: '盘点联调计划P', publicationId: pubId, materialId: MID, copies: 2, kerf: 0.5,
  });
  globalThis.PID = plan.data.plan.id;
  assert.strictEqual((await api('POST', `/api/plans/${globalThis.PID}/confirm`)).status, 200);

  // 盘点预览时预留为 R
  const st = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 8 }],
  });
  const item = st.data.stocktake.items[0];
  assert.strictEqual(item.stock, 8);
  assert.strictEqual(item.reserved, R);

  // 随后计划取消 → 预留变为 0
  assert.strictEqual((await api('POST', `/api/plans/${globalThis.PID}/cancel`)).status, 200);
  const r = await api('POST', `/api/stocktakes/${st.data.stocktake.id}/confirm`);
  assert.strictEqual(r.status, 409);
  const bad = r.data.items[0];
  assert.strictEqual(bad.reason, 'reserved_changed');
  assert.strictEqual(bad.baselineReserved, R);
  assert.strictEqual(bad.currentReserved, 0);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 8);
  globalThis.ST_RESERVED = st.data.stocktake.id;
});

test('实盘数低于当前已确认预留：below_reserved，整单不生效（含铅条+玻璃混合单）', async () => {
  // 重新建并确认计划 P2（已取消的计划不能再确认，须新建；预留恢复 R）
  const plan = await api('POST', '/api/plans', {
    name: '盘点联调计划P2', publicationId: pubId, materialId: MID, copies: 2, kerf: 0.5,
  });
  globalThis.PID2 = plan.data.plan.id;
  assert.strictEqual((await api('POST', `/api/plans/${globalThis.PID2}/confirm`)).status, 200);
  // 再确认一个独立裁片订单（红/绿各预留）
  const cpv = await api('POST', '/api/cut-orders/preview', {
    publicationId: pubId, copies: 1, gap: 0,
  });
  const redNeed = cpv.data.preview.colors.find((c) => c.color === '#ff0000').requiredSheets;
  const greenNeed = cpv.data.preview.colors.find((c) => c.color === '#00ff00').requiredSheets;
  globalThis.redNeed = redNeed;
  globalThis.greenNeed = greenNeed;
  const co = await api('POST', '/api/cut-orders', {
    name: '盘点联调订单O', publicationId: pubId, copies: 1, gap: 0,
  });
  globalThis.OID = co.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${globalThis.OID}/confirm`)).status, 200);

  // 混合盘点单：铅条实盘 R-1（< 预留 R）；红色实盘 100（合法）——整单仍应失败且红色不动
  const st = await api('POST', '/api/stocktakes/preview', {
    items: [
      { type: 'lead', specId: MID, counted: globalThis.R - 1 },
      { type: 'glass', specId: RID, counted: 100 },
    ],
  });
  const r = await api('POST', `/api/stocktakes/${st.data.stocktake.id}/confirm`);
  assert.strictEqual(r.status, 409);
  const bad = r.data.items.find((i) => i.type === 'lead');
  assert.strictEqual(bad.reason, 'below_reserved');
  assert.strictEqual(bad.currentReserved, globalThis.R);
  assert.ok(!r.data.items.some((i) => i.type === 'glass'), '合法项不返回原因');
  // 两类库存都没有被改（红色实盘 100 未生效）
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 8);
  assert.strictEqual((await api('GET', `/api/glass-sheets/${RID}`)).data.sheet.stock, 4);
});

test('盘点后库存口径：独立计划/订单/整套单的确认与取消按盘点后的可用量计算', async () => {
  // 当前：铅条库存 8、已预留 R（计划P）；红 4 预留 redNeed、绿 5 预留 greenNeed。
  const matNow = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(matNow.available, 8 - globalThis.R);

  // 再确认一个同样需 R 根的计划 → 按盘点后库存应缺口失败
  const q = await api('POST', '/api/plans', {
    name: '盘点联调计划Q', publicationId: pubId, materialId: MID, copies: 2, kerf: 0.5,
  });
  const qc = await api('POST', `/api/plans/${q.data.plan.id}/confirm`);
  if (8 - globalThis.R >= globalThis.R) {
    assert.strictEqual(qc.status, 200, '若盘点后可用仍够则允许确认（以实际口径为准）');
    assert.strictEqual((await api('POST', `/api/plans/${q.data.plan.id}/cancel`)).status, 200);
  } else {
    assert.strictEqual(qc.status, 409);
    assert.strictEqual(qc.data.code, 'shortage');
  }

  // 取消 P2 释放预留后，Q 可以确认；再取消 Q
  assert.strictEqual((await api('POST', `/api/plans/${globalThis.PID2}/cancel`)).status, 200);
  assert.strictEqual((await api('POST', `/api/plans/${q.data.plan.id}/confirm`)).status, 200);
  assert.strictEqual((await api('POST', `/api/plans/${q.data.plan.id}/cancel`)).status, 200);

  // 做一张混合盘点单把库存定为：铅条 8、红 4、绿 4（绿实盘 4 ≥ 预留 greenNeed）
  const st = await api('POST', '/api/stocktakes/preview', {
    items: [
      { type: 'lead', specId: MID, counted: 8 },
      { type: 'glass', specId: RID, counted: 4 },
      { type: 'glass', specId: GID, counted: 4 },
    ],
  });
  const cr = await api('POST', `/api/stocktakes/${st.data.stocktake.id}/confirm`);
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.data));
  assert.strictEqual((await api('GET', `/api/glass-sheets/${GID}`)).data.sheet.stock, 4);

  // 整套单确认（铅条 3 根 + 红/绿各 1 张，盘点后均充足）→ 再取消，预留各释放一次
  const combo = await api('POST', '/api/combo-orders', {
    name: '盘点后整套', publicationId: pubId, materialId: MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'stock-combo-1',
  });
  assert.strictEqual(combo.status, 201, JSON.stringify(combo.data));
  const comboId = combo.data.combo.id;
  const leadAfter = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(leadAfter.stock, 8);
  assert.strictEqual(leadAfter.reserved, 3);
  assert.strictEqual(leadAfter.available, 5);
  const cancel = await api('POST', `/api/combo-orders/${comboId}/cancel`);
  assert.strictEqual(cancel.status, 200);
  const leadBack = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(leadBack.reserved, 0);
  assert.strictEqual(leadBack.available, 8);
  // 独立裁片订单 O 仍处于已确认：绿色预留 1 仍在（后续才取消）
  const greenBack = (await api('GET', `/api/glass-sheets/${GID}`)).data.sheet;
  assert.strictEqual(greenBack.reserved, globalThis.greenNeed);
  assert.strictEqual(greenBack.available, 4 - globalThis.greenNeed);

  // 裁片订单 O 仍为已确认（盘点时 counted ≥ 预留），可正常取消
  const o = (await api('GET', `/api/cut-orders/${globalThis.OID}`)).data.order;
  assert.strictEqual(o.status, 'confirmed');
  assert.strictEqual((await api('POST', `/api/cut-orders/${globalThis.OID}/cancel`)).status, 200);
});

test('并发确认两张重叠盘点单：仅先生效的一张成功，另一张基准不符整单不调整', async () => {
  const a = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 6 }],
  });
  const b = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID, counted: 5 }],
  });
  const [ra, rb] = await Promise.all([
    api('POST', `/api/stocktakes/${a.data.stocktake.id}/confirm`),
    api('POST', `/api/stocktakes/${b.data.stocktake.id}/confirm`),
  ]);
  const ok = [ra, rb].filter((x) => x.status === 200);
  const bad = [ra, rb].filter((x) => x.status === 409);
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].data.code, 'baseline_mismatch');
  assert.strictEqual(bad[0].data.items[0].reason, 'stock_changed');
  const finalStock = (await api('GET', `/api/materials/${MID}`)).data.material.stock;
  assert.ok(finalStock === 6 || finalStock === 5);
  assert.strictEqual(finalStock, ok[0].data.stocktake.items[0].counted);
});

test('原有库存调整入口在盘点后继续可用', async () => {
  const cur = (await api('GET', `/api/materials/${MID}`)).data.material.stock;
  const pa = await api('PATCH', `/api/materials/${MID}`, { stock: cur + 2 });
  assert.strictEqual(pa.status, 200);
  const pg = await api('PATCH', `/api/glass-sheets/${RID}`, { stock: 9 });
  assert.strictEqual(pg.status, 200);
  // 盘点记录仍可查阅（网页/API）
  const s = await api('GET', `/api/stocktakes/${globalThis.ST1}`);
  assert.strictEqual(s.status, 200);
  const root = await fetch(BASE + '/');
  const html = await root.text();
  assert.ok(html.includes('库存盘点'));
});
