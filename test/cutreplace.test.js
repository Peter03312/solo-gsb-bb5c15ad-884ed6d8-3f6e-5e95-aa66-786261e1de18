'use strict';

// 端到端：已确认裁片订单换单（换到同一图纸另一已发布版本）。
// 预览只读不占库存；确认在同一事务内旧单退出预留+新单确认；任一色不足整体回滚；
// 相同参数重试幂等返回原新单，不同参数冲突；旧单标记已替换不可再取消/修改/删除；
// 无效版本/已取消旧单/排样失败明确拒绝；并发不超卖、不重复预留；发布快照均可查。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39141';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `cutreplace-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubV1, pubV2, pubV3, otherPub;
let redId, greenId, blueId, tealId;

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
    try { await api('GET', '/api/glass-sheets'); break; } catch { await sleep(50); }
  }

  // 主图纸 60×60：
  // v1 红：左下半 30×30 + 右上半 30×30；绿：左上 30×30 + 右下 30×30
  const d = await api('POST', '/api/designs', { name: '换单窗', width: 60, height: 60 });
  designId = d.data.design.id;
  for (const pc of [
    ['#ff0000', [[0, 0], [30, 0], [30, 30], [0, 30]]],
    ['#ff0000', [[30, 30], [60, 30], [60, 60], [30, 60]]],
    ['#00ff00', [[30, 0], [60, 0], [60, 30], [30, 30]]],
    ['#00ff00', [[0, 30], [30, 30], [30, 60], [0, 60]]],
  ]) {
    await api('POST', `/api/designs/${designId}/pieces`, { color: pc[0], polygon: pc[1] });
  }
  pubV1 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;

  // v2：右上 30×30 红改为蓝；其余不变（红 3 片、绿 2 片、蓝 1 片/件）
  await api('PUT', `/api/designs/${designId}/pieces/2`, {
    color: '#0000ff', polygon: [[30, 30], [60, 30], [60, 60], [30, 60]],
  });
  pubV2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
  assert.strictEqual(pubV2.version, 2);

  // v3：右下绿 30×30 改为青色（红2、绿1、蓝1、青1/件）
  await api('PUT', `/api/designs/${designId}/pieces/4`, {
    color: '#00aaaa', polygon: [[0, 30], [30, 30], [30, 60], [0, 60]],
  });
  pubV3 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
  assert.strictEqual(pubV3.version, 3);

  // 另一张图纸（用于跨图纸拒绝）
  const d2 = await api('POST', '/api/designs', { name: '别窗', width: 10, height: 10 });
  await api('POST', `/api/designs/${d2.data.design.id}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
  });
  otherPub = (await api('POST', `/api/designs/${d2.data.design.id}/publish`)).data.publication;

  // 原片：红 60×60（1件4片，gap0 一板），绿 60×60，蓝 60×60，青 60×60
  redId = (await api('POST', '/api/glass-sheets', { color: '#ff0000', width: 60, height: 60, stock: 5 })).data.sheet.id;
  greenId = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 60, height: 60, stock: 5 })).data.sheet.id;
  blueId = (await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 60, height: 60, stock: 5 })).data.sheet.id;
  tealId = (await api('POST', '/api/glass-sheets', { color: '#00aaaa', width: 60, height: 60, stock: 5 })).data.sheet.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

function row(preview, color) {
  return preview.colors.find((c) => c.color === color);
}

async function confirmedOrder(publicationId, copies, gap, name) {
  const o = await api('POST', '/api/cut-orders', { name, publicationId, copies, gap });
  assert.strictEqual(o.status, 201);
  const c = await api('POST', `/api/cut-orders/${o.data.order.id}/confirm`);
  assert.strictEqual(c.status, 200, `确认订单成功: ${JSON.stringify(c.data)}`);
  return c.data.order;
}

async function setStock(id, stock) {
  const r = await api('PATCH', `/api/glass-sheets/${id}`, { stock });
  assert.strictEqual(r.status, 200, `调库存 ${id}=${stock}: ${JSON.stringify(r.data)}`);
}

test('换单预览：按颜色列旧/新用板、净增减、计入旧单预留释放后的可用量与缺口；只读不占库存', async () => {
  await setStock(redId, 5); await setStock(greenId, 5); await setStock(blueId, 5); await setStock(tealId, 5);
  const o = await confirmedOrder(pubV1.id, 1, 0, '待换旧单');
  assert.strictEqual(o.totalSheets, 2); // v1 红1板 绿1板

  const before = (await api('GET', '/api/glass-sheets')).data.sheets
    .map((s) => ({ c: s.color, stock: s.stock, reserved: s.reserved }));

  const pv = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`,
    { targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.data));
  const p = pv.data.preview;
  assert.strictEqual(p.old.orderId, o.id);
  assert.strictEqual(p.target.version, 2);
  assert.strictEqual(p.oldTotalSheets, 2);
  assert.strictEqual(p.totalSheets, 3); // 红1 绿1 蓝1
  assert.strictEqual(p.netSheets, 1);

  const r = row(p, '#ff0000');
  assert.strictEqual(r.oldSheets, 1);
  assert.strictEqual(r.requiredSheets, 1);
  assert.strictEqual(r.netChange, 0);
  const g = row(p, '#00ff00');
  assert.strictEqual(g.oldSheets, 1);
  assert.strictEqual(g.requiredSheets, 1);
  assert.strictEqual(g.netChange, 0);
  const b = row(p, '#0000ff');
  assert.strictEqual(b.oldSheets, 0, '旧单无蓝色');
  assert.strictEqual(b.requiredSheets, 1);
  assert.strictEqual(b.netChange, 1);
  assert.strictEqual(b.availableAfter, 5, '蓝无任何预留，可用=库存');
  assert.strictEqual(b.shortage, 0);
  assert.strictEqual(p.totalShortage, 0);
  assert.strictEqual(p.feasible, true);
  // 新排样几何/上限口径沿用：返回逐张排样
  assert.ok(p.layout.colors.find((c) => c.color === '#0000ff').sheets[0].placements[0].pieceNo);

  // 蓝库存清零 → 缺口 1；红计入旧单释放：reserved 含旧单 1，availableAfter 仍为 5
  await setStock(blueId, 0);
  const pv2 = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`,
    { targetPublicationId: 2, copies: 1, gap: 0 });
  const b2 = row(pv2.data.preview, '#0000ff');
  assert.strictEqual(b2.availableAfter, 0);
  assert.strictEqual(b2.shortage, 1);
  assert.strictEqual(pv2.data.preview.feasible, false);
  const r2 = row(pv2.data.preview, '#ff0000');
  assert.strictEqual(r2.availableAfter, 5, '旧单红色预留计入释放，不占自己的可用量');
  await setStock(blueId, 5);

  // 预览不占库存、不改订单状态
  const after = (await api('GET', '/api/glass-sheets')).data.sheets
    .map((s) => ({ c: s.color, stock: s.stock, reserved: s.reserved }));
  assert.deepStrictEqual(after, before);
  const still = (await api('GET', `/api/cut-orders/${o.id}`)).data.order;
  assert.strictEqual(still.status, 'confirmed');
  assert.strictEqual(still.version, 1);
  assert.strictEqual(still.replacedBy, null);
});

test('无效目标明确拒绝：目标版本不存在/跨图纸/同版本/参数非法/草稿与已取消旧单', async () => {
  const o = (await api('GET', '/api/cut-orders')).data.orders
    .find((x) => x.name === '待换旧单' && x.status === 'confirmed');
  // 版本不存在
  let r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetVersion: 99 });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'target_not_found');
  // targetPublicationId 不存在
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetPublicationId: 9999 });
  assert.strictEqual(r.status, 404);
  // 跨图纸
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetPublicationId: otherPub.id });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'different_design');
  // 同版本
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetVersion: 1 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'same_version');
  // 缺少目标
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { copies: 2 });
  assert.strictEqual(r.status, 400);
  // 参数非法
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetVersion: 2, copies: 0 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', `/api/cut-orders/${o.id}/replacement/preview`, { targetVersion: 2, gap: 51 });
  assert.strictEqual(r.status, 400);
  // 订单不存在
  r = await api('POST', '/api/cut-orders/999999/replacement/preview', { targetVersion: 2 });
  assert.strictEqual(r.status, 404);

  // 草稿订单不能换单
  const draft = (await api('POST', '/api/cut-orders', { publicationId: pubV1.id, copies: 1, gap: 0 })).data.order;
  r = await api('POST', `/api/cut-orders/${draft.id}/replacement/preview`, { targetVersion: 2 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'order_not_confirmed');

  // 已取消订单不能换单
  const canceled = await confirmedOrder(pubV1.id, 1, 0, '取消单');
  assert.strictEqual((await api('POST', `/api/cut-orders/${canceled.id}/cancel`)).status, 200);
  r = await api('POST', `/api/cut-orders/${canceled.id}/replacement/preview`, { targetVersion: 2 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'order_canceled');
});

test('排样失败明确拒绝：新颜色未登记原片（missing_color），不产生新单/不改预留', async () => {
  const o = await confirmedOrder(pubV2.id, 1, 0, '换去缺色');
  // 再发布一个引入未登记颜色 #666666 的 v4（草稿改动不影响既有快照）
  await api('PUT', `/api/designs/${designId}/pieces/4`, {
    color: '#666666', polygon: [[0, 30], [30, 30], [30, 60], [0, 60]],
  });
  const pubV4 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
  assert.strictEqual(pubV4.version, 4);

  const beforeCount = (await api('GET', '/api/cut-orders')).data.orders.length;
  const reservedBefore = (await api('GET', '/api/glass-sheets')).data.sheets
    .map((s) => ({ c: s.color, r: s.reserved }));
  const r = await api('POST', `/api/cut-orders/${o.id}/replacement`, { targetVersion: 4, copies: 1, gap: 0 });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.code, 'missing_color');
  assert.strictEqual(r.data.color, '#666666');
  // 订单数不增、旧单仍 confirmed、预留不变
  assert.strictEqual((await api('GET', '/api/cut-orders')).data.orders.length, beforeCount);
  assert.deepStrictEqual(
    (await api('GET', '/api/glass-sheets')).data.sheets.map((s) => ({ c: s.color, r: s.reserved })),
    reservedBefore);
  const old = (await api('GET', `/api/cut-orders/${o.id}`)).data.order;
  assert.strictEqual(old.status, 'confirmed');
  assert.strictEqual(old.version, 2);
  // 清理：取消并删除该旧单，释放蓝/红/绿预留供后续测试
  assert.strictEqual((await api('POST', `/api/cut-orders/${o.id}/cancel`)).status, 200);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${o.id}`)).status, 200);
});

test('任一颜色不足：确认整体失败，旧单/库存/订单记录全部原状并返回各色缺口', async () => {
  // 此时仅剩“待换旧单”（v1：红1绿1）为 confirmed。
  // 换 v2、3 件、gap=5：60×60 板每板只放 1 片（30+5+30>60）→ v2 每件红1绿2蓝1，
  // 即红 3 板、绿 6 板、蓝 3 板。红库存压到 2（≥其已预留1，允许下调）：旧单释放后可用仅2，缺1；
  // 蓝库存 0（无蓝预留）：缺3；绿库存 10 保证不缺。
  await setStock(redId, 2);
  await setStock(greenId, 10);
  await setStock(blueId, 0);
  await setStock(tealId, 5);

  const o = (await api('GET', '/api/cut-orders')).data.orders
    .find((x) => x.name === '待换旧单' && x.status === 'confirmed');
  assert.ok(o, '待换旧单仍在');

  const redSheetBefore = (await api('GET', `/api/glass-sheets/${redId}`)).data.sheet;
  assert.strictEqual(redSheetBefore.reserved, 1);
  const beforeCount = (await api('GET', '/api/cut-orders')).data.orders.length;

  const r = await api('POST', `/api/cut-orders/${o.id}/replacement`,
    { targetVersion: 2, copies: 3, gap: 5 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'shortage');
  const byColor = Object.fromEntries(r.data.shortages.map((s) => [s.color, s]));
  assert.strictEqual(byColor['#0000ff'].required, 3);
  assert.strictEqual(byColor['#0000ff'].available, 0);
  assert.strictEqual(byColor['#0000ff'].shortage, 3);
  assert.strictEqual(byColor['#0000ff'].oldReserved, 0);
  assert.strictEqual(byColor['#ff0000'].required, 3);
  assert.strictEqual(byColor['#ff0000'].available, 2);
  assert.strictEqual(byColor['#ff0000'].shortage, 1);
  assert.strictEqual(byColor['#ff0000'].oldReserved, 1);
  assert.ok(!byColor['#00ff00'], '绿色库存充足不出现在缺口中');

  // 旧单保持 confirmed / v1；库存预留不变；订单数不增
  const old = (await api('GET', `/api/cut-orders/${o.id}`)).data.order;
  assert.strictEqual(old.status, 'confirmed');
  assert.strictEqual(old.publicationId, pubV1.id);
  assert.strictEqual(old.replacedBy, null);
  const redSheetAfter = (await api('GET', `/api/glass-sheets/${redId}`)).data.sheet;
  assert.strictEqual(redSheetAfter.reserved, 1, '失败换单不改动任何预留');
  assert.strictEqual((await api('GET', '/api/cut-orders')).data.orders.length, beforeCount);

  await setStock(redId, 5);
  await setStock(greenId, 5);
  await setStock(blueId, 5);
});

test('成功换单：同事务旧单退出预留、新单即确认；两单快照与排样可查；旧单不可再取消/修改/删除', async () => {
  await setStock(redId, 5); await setStock(greenId, 5); await setStock(blueId, 5); await setStock(tealId, 5);
  const o = (await api('GET', '/api/cut-orders')).data.orders
    .find((x) => x.name === '待换旧单' && x.status === 'confirmed');
  const r = await api('POST', `/api/cut-orders/${o.id}/replacement`,
    { name: '换单后新单', targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.idempotent, false);
  const nw = r.data.order;
  assert.strictEqual(nw.status, 'confirmed');
  assert.strictEqual(nw.version, 2);
  assert.strictEqual(nw.publicationId, pubV2.id);
  assert.strictEqual(nw.totalSheets, 3);
  assert.strictEqual(nw.name, '换单后新单');
  assert.deepStrictEqual(nw.replaces && {
    oldOrderId: nw.replaces.oldOrderId,
    targetPublicationId: nw.replaces.targetPublicationId,
    copies: nw.replaces.copies,
    gap: nw.replaces.gap,
  }, { oldOrderId: o.id, targetPublicationId: pubV2.id, copies: 1, gap: 0 });

  const oldNow = r.data.oldOrder;
  assert.strictEqual(oldNow.status, 'replaced');
  assert.strictEqual(oldNow.version, 1);
  assert.ok(oldNow.replacedAt);
  assert.strictEqual(oldNow.replacedBy.newOrderId, nw.id);

  // 库存口径：旧单不再占预留（红/绿各释放1），新单占用红1绿1蓝1
  const redS = (await api('GET', `/api/glass-sheets/${redId}`)).data.sheet;
  const greenS = (await api('GET', `/api/glass-sheets/${greenId}`)).data.sheet;
  const blueS = (await api('GET', `/api/glass-sheets/${blueId}`)).data.sheet;
  assert.strictEqual(redS.reserved, 1);
  assert.strictEqual(greenS.reserved, 1);
  assert.strictEqual(blueS.reserved, 1);
  // 两个发布快照与两单排样均可查
  const snap2 = await api('GET', `/api/designs/${designId}/publications/2`);
  assert.strictEqual(snap2.data.publication.id, pubV2.id);
  const newDetail = (await api('GET', `/api/cut-orders/${nw.id}`)).data.order;
  assert.strictEqual(newDetail.layout.colors.map((c) => c.color).sort().join(','), '#0000ff,#00ff00,#ff0000');
  const oldDetail = (await api('GET', `/api/cut-orders/${o.id}`)).data.order;
  assert.strictEqual(oldDetail.layout.colors.map((c) => c.color).sort().join(','), '#00ff00,#ff0000');

  // 旧单不能再取消 / 修改 / 删除
  assert.strictEqual((await api('POST', `/api/cut-orders/${o.id}/cancel`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/cut-orders/${o.id}`, { copies: 2 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${o.id}`)).status, 409);
  assert.strictEqual((await api('POST', `/api/cut-orders/${o.id}/confirm`)).status, 409);
  // 旧单仍保留分色明细
  assert.strictEqual(oldDetail.items.length, 2);
});

test('相同参数重试返回原新单（幂等，不重复预留）；不同参数冲突', async () => {
  const orders = (await api('GET', '/api/cut-orders')).data.orders;
  const oldId = orders.find((x) => x.status === 'replaced' && x.name === '待换旧单').id;
  const newId = orders.find((x) => x.name === '换单后新单').id;

  const reservedBefore = (await api('GET', '/api/glass-sheets')).data.sheets
    .map((s) => ({ c: s.color, r: s.reserved }));

  // 相同参数（copies/gap 省略 → 旧单原值；这里旧单 1/0）重试
  const again = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2 });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.idempotent, true);
  assert.strictEqual(again.data.order.id, newId);
  assert.strictEqual(again.data.oldOrder.status, 'replaced');

  // 显式相同参数
  const again2 = await api('POST', `/api/cut-orders/${oldId}/replacement`,
    { targetPublicationId: pubV2.id, copies: 1, gap: 0 });
  assert.strictEqual(again2.status, 200);
  assert.strictEqual(again2.data.order.id, newId);

  const reservedAfter = (await api('GET', '/api/glass-sheets')).data.sheets
    .map((s) => ({ c: s.color, r: s.reserved }));
  assert.deepStrictEqual(reservedAfter, reservedBefore, '幂等重试不重复预留');

  // 不同参数（件数 2）→ 冲突
  const diff = await api('POST', `/api/cut-orders/${oldId}/replacement`,
    { targetVersion: 2, copies: 2, gap: 0 });
  assert.strictEqual(diff.status, 409);
  assert.strictEqual(diff.data.code, 'param_conflict');
  assert.strictEqual(diff.data.current.copies, 1);
  assert.strictEqual(diff.data.requested.copies, 2);
  assert.strictEqual(diff.data.newOrder.id, newId);
  // 不同目标版本 → 冲突
  const diffV = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 3 });
  assert.strictEqual(diffV.status, 409);
  assert.strictEqual(diffV.data.code, 'param_conflict');

  // 新单可以正常取消（它是独立已确认订单），且不会影响旧单状态
  const cancelNew = await api('POST', `/api/cut-orders/${newId}/cancel`);
  assert.strictEqual(cancelNew.status, 200);
  const oldStill = (await api('GET', `/api/cut-orders/${oldId}`)).data.order;
  assert.strictEqual(oldStill.status, 'replaced');
  assert.strictEqual(oldStill.replacedBy.newOrderId, newId);
  // 幂等重试仍返回该新单（即使新单后来被取消）
  const again3 = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2 });
  assert.strictEqual(again3.data.order.id, newId);
});

test('并发：对两张旧单同时换单到同一紧缺颜色，不超卖、不留半单', async () => {
  await setStock(redId, 5); await setStock(greenId, 5); await setStock(blueId, 1); await setStock(tealId, 5);
  // 两张 v1 已确认单（各红1绿1）
  const a = await confirmedOrder(pubV1.id, 1, 0, '并发旧单A');
  const b = await confirmedOrder(pubV1.id, 1, 0, '并发旧单B');
  // 都换到 v2：新单各需蓝1；蓝库存仅1 → 恰一个成功
  const [ra, rb] = await Promise.all([
    api('POST', `/api/cut-orders/${a.id}/replacement`, { targetVersion: 2 }),
    api('POST', `/api/cut-orders/${b.id}/replacement`, { targetVersion: 2 }),
  ]);
  const okOne = [ra, rb].filter((x) => x.status === 201);
  const failOne = [ra, rb].filter((x) => x.status !== 201);
  assert.strictEqual(okOne.length, 1, `恰一成功：${ra.status}/${rb.status}`);
  assert.strictEqual(failOne.length, 1);
  assert.strictEqual(failOne[0].data.code, 'shortage');
  assert.strictEqual(failOne[0].data.shortages[0].color, '#0000ff');

  // 蓝预留恰为1，不超卖；失败旧单仍 confirmed
  const blueS = (await api('GET', `/api/glass-sheets/${blueId}`)).data.sheet;
  assert.strictEqual(blueS.reserved, 1);
  const failedOldId = failOne[0].data.oldOrder ? null : null; // 失败响应不带旧单也无妨，直接查
  const failedOrder = (await Promise.all([a.id, b.id].map((id) => api('GET', `/api/cut-orders/${id}`))))
    .map((x) => x.data.order).find((o) => o.status === 'confirmed');
  assert.ok(failedOrder, '失败旧单保持 confirmed');
  const successOrder = (await api('GET', `/api/cut-orders/${okOne[0].data.order.id}`)).data.order;
  assert.strictEqual(successOrder.status, 'confirmed');
  assert.strictEqual(successOrder.version, 2);
  // 同一旧单并发重复提交相同参数也不会产生两张新单
  const [c1, c2] = await Promise.all([
    api('POST', `/api/cut-orders/${successOrder.replaces.oldOrderId}/replacement`, { targetVersion: 2 }),
    api('POST', `/api/cut-orders/${successOrder.replaces.oldOrderId}/replacement`, { targetVersion: 2 }),
  ]);
  assert.strictEqual(c1.data.order.id, successOrder.id);
  assert.strictEqual(c2.data.order.id, successOrder.id);
  assert.ok(c1.data.idempotent && c2.data.idempotent);
});

test('换单链：v1→v2→v3 接续；每次旧单退出预留，最终只预留 v3 各色', async () => {
  await setStock(redId, 5); await setStock(greenId, 5); await setStock(blueId, 5); await setStock(tealId, 5);
  // 清掉前序测试残留的 confirmed 订单（取消后删除，避免干扰预留口径）
  for (const x of (await api('GET', '/api/cut-orders')).data.orders) {
    if (x.status === 'confirmed') {
      await api('POST', `/api/cut-orders/${x.id}/cancel`);
      await api('DELETE', `/api/cut-orders/${x.id}`);
    }
  }

  const o1 = await confirmedOrder(pubV1.id, 1, 0, '链单v1');
  const r12 = await api('POST', `/api/cut-orders/${o1.id}/replacement`, { targetVersion: 2 });
  assert.strictEqual(r12.status, 201);
  const o2 = r12.data.order;
  assert.strictEqual(o2.version, 2);
  const r23 = await api('POST', `/api/cut-orders/${o2.id}/replacement`, { targetVersion: 3 });
  assert.strictEqual(r23.status, 201, JSON.stringify(r23.data));
  const o3 = r23.data.order;
  assert.strictEqual(o3.version, 3);
  assert.strictEqual(o3.totalSheets, 4); // 红绿蓝青各1
  assert.strictEqual(o3.replaces.oldOrderId, o2.id);

  // o1/o2 都 replaced，只有 o3 占预留
  for (const id of [o1.id, o2.id]) {
    const x = (await api('GET', `/api/cut-orders/${id}`)).data.order;
    assert.strictEqual(x.status, 'replaced');
  }
  const sheets = (await api('GET', '/api/glass-sheets')).data.sheets;
  for (const color of ['#ff0000', '#00ff00', '#0000ff', '#00aaaa']) {
    assert.strictEqual(sheets.find((s) => s.color === color).reserved, 1, `${color} 仅 v3 预留1`);
  }
  // 链头不能被重新换单（旧单已替换）
  const again = await api('POST', `/api/cut-orders/${o1.id}/replacement`, { targetVersion: 3 });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.data.code, 'param_conflict', 'o1 记录指向 v2，换 v3 属不同参数冲突');
});
