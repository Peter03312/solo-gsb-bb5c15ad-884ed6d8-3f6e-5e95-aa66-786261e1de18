'use strict';

// 端到端：真实 HTTP 服务（临时 SQLite）验证
// 彩色原片登记/调库存、预览不落库、缺色/单片放不下/超上限整单拒绝、
// 确认原子预留（多色一缺全败）、并发不超卖、取消只释放一次、快照绑定、只读。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39137';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `cutorders-test-${process.pid}.db`);

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
    try { await api('GET', '/api/glass-sheets'); break; } catch { await sleep(50); }
  }
  const d = await api('POST', '/api/designs', { name: '裁片测试窗', width: 60, height: 60 });
  designId = d.data.design.id;
  // 红两片（左下半 + 右上半，对角），绿两片（左上/右下）
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[30, 30], [60, 30], [60, 60], [30, 60]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[30, 0], [60, 0], [60, 30], [30, 30]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[0, 30], [30, 30], [30, 60], [0, 60]],
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

test('原片登记：颜色归一、范围校验、同色唯一、只可改库存', async () => {
  let r = await api('POST', '/api/glass-sheets', { color: '#AABBCC', width: 0, height: 10, stock: 1 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/glass-sheets', { color: '#AABBCC', width: 2001, height: 10, stock: 1 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/glass-sheets', { color: 'nope', width: 10, height: 10, stock: 1 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', '/api/glass-sheets', { color: '#ff0000', width: 60, height: 60, stock: -1 });
  assert.strictEqual(r.status, 400);

  const red = await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 100, height: 100, stock: 5 });
  assert.strictEqual(red.status, 201);
  assert.strictEqual(red.data.sheet.color, '#ff0000');
  const dup = await api('POST', '/api/glass-sheets', { color: '#ff0000', width: 90, height: 90, stock: 5 });
  assert.strictEqual(dup.status, 409);
  const green = await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 60, height: 60, stock: 5 });
  assert.ok(green.data.ok);

  // 宽高/颜色不可改
  assert.strictEqual((await api('PATCH', `/api/glass-sheets/${red.data.sheet.id}`, { width: 80 })).status, 400);
  assert.strictEqual((await api('PATCH', `/api/glass-sheets/${red.data.sheet.id}`, { color: '#123456' })).status, 400);
  const up = await api('PATCH', `/api/glass-sheets/${red.data.sheet.id}`, { stock: 8 });
  assert.strictEqual(up.data.sheet.stock, 8);
});

test('预览不落库；含逐张原片片号/件次/旋转/坐标/轮廓与各色用板/缺口', async () => {
  const before = (await api('GET', '/api/glass-sheets')).data.sheets.map((s) => ({ c: s.color, r: s.reserved }));
  const pv = await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 2, gap: 5 });
  assert.strictEqual(pv.status, 200);
  const p = pv.data.preview;
  assert.strictEqual(p.copies, 2);
  assert.strictEqual(p.gap, 5);
  // 红板 100x100：4 片 30x30（每色两件）按 2x2 放 1 张；绿板 60x60：30+5+30 放不下，逐片 4 张
  const red = p.colors.find((c) => c.color === '#ff0000');
  const green = p.colors.find((c) => c.color === '#00ff00');
  assert.strictEqual(red.requiredSheets, 1);
  assert.strictEqual(green.requiredSheets, 4);
  assert.strictEqual(p.totalSheets, 5);
  assert.strictEqual(green.shortage, 0, '绿库存5需4 无缺口');
  // 每张原片放置项字段齐全
  const s0 = green.sheetId ? p.layout.colors.find((c) => c.color === '#00ff00').sheets[0] : null;
  assert.ok(s0);
  const pl = s0.placements[0];
  for (const k of ['pieceNo', 'copy', 'rotation', 'x', 'y', 'polygon']) assert.ok(k in pl, `字段 ${k}`);
  assert.ok([0, 90, 180, 270].includes(pl.rotation));
  assert.ok(Number.isInteger(pl.x) && Number.isInteger(pl.y));
  assert.ok(Array.isArray(pl.polygon) && pl.polygon.length >= 3);
  // 预览不占库存
  const after = (await api('GET', '/api/glass-sheets')).data.sheets.map((s) => ({ c: s.color, r: s.reserved }));
  assert.deepStrictEqual(before, after);
  // 缺口计算：把绿库存调到 3 → 缺 1
  await api('PATCH', `/api/glass-sheets/${green.sheetId || (await api('GET', '/api/glass-sheets')).data.sheets.find((s) => s.color === '#00ff00').id}`, { stock: 3 });
  const pv2 = await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 2, gap: 5 });
  const g2 = pv2.data.preview.colors.find((c) => c.color === '#00ff00');
  assert.strictEqual(g2.shortage, 1);
  assert.strictEqual(pv2.data.preview.feasible, false);
  const all = await api('GET', '/api/glass-sheets');
  const gid = all.data.sheets.find((s) => s.color === '#00ff00').id;
  await api('PATCH', `/api/glass-sheets/${gid}`, { stock: 5 });
});

test('整单拒绝：缺色 / 单片放不下 / 参数非法 / 超 60 张，均不产生订单或预留', async () => {
  // 缺蓝：另建一个含蓝色片的发布版
  const d2 = await api('POST', '/api/designs', { name: '蓝窗', width: 10, height: 10 });
  await api('POST', `/api/designs/${d2.data.design.id}/pieces`, {
    color: '#0000ff', polygon: [[0, 0], [10, 0], [10, 10]],
  });
  await api('POST', `/api/designs/${d2.data.design.id}/pieces`, {
    color: '#0000ff', polygon: [[0, 0], [10, 10], [0, 10]],
  });
  const pub2 = (await api('POST', `/api/designs/${d2.data.design.id}/publish`)).data.publication;
  const miss = await api('POST', '/api/cut-orders/preview', { publicationId: pub2.id, copies: 1, gap: 0 });
  assert.strictEqual(miss.status, 422);
  assert.strictEqual(miss.data.code, 'missing_color');
  assert.strictEqual(miss.data.color, '#0000ff');

  // 单片放不下：绿片 30x30 与 30x60（旋转也不过 29）——登记 29x29 不行，绿已有 60x60，
  // 改用蓝色 10x10 板放该片可以；构造放不下：蓝板 9x9
  await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 9, height: 9, stock: 3 });
  const big = await api('POST', '/api/cut-orders/preview', { publicationId: pub2.id, copies: 1, gap: 0 });
  assert.strictEqual(big.status, 422);
  assert.strictEqual(big.data.code, 'piece_too_large');
  assert.strictEqual(big.data.pieceWidth, 10);

  // 参数非法
  assert.strictEqual((await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 0, gap: 0 })).status, 400);
  assert.strictEqual((await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 1, gap: -1 })).status, 400);
  assert.strictEqual((await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 1, gap: 51 })).status, 400);
  assert.strictEqual((await api('POST', '/api/cut-orders/preview', { publicationId: 9999, copies: 1, gap: 0 })).status, 404);

  // 超上限：极小原片 1x1 放 1x1 片每板 1 张：copies=61 → too_many_sheets
  const d3 = await api('POST', '/api/designs', { name: '点窗', width: 1, height: 1 });
  await api('POST', `/api/designs/${d3.data.design.id}/pieces`, { color: '#ab0000', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  const pub3 = (await api('POST', `/api/designs/${d3.data.design.id}/publish`)).data.publication;
  await api('POST', '/api/glass-sheets', { color: '#ab0000', width: 1, height: 1, stock: 100 });
  const over = await api('POST', '/api/cut-orders/preview', { publicationId: pub3.id, copies: 61, gap: 0 });
  assert.strictEqual(over.status, 422);
  assert.strictEqual(over.data.code, 'too_many_sheets');
  assert.strictEqual(over.data.totalSheets, 61);

  // 订单数没有增加、库存预留为 0
  const orders = await api('GET', '/api/cut-orders');
  assert.strictEqual(orders.data.orders.length, 0);
  const sheets = await api('GET', '/api/glass-sheets');
  assert.ok(sheets.data.sheets.every((s) => s.reserved === 0));
});

test('草稿不预留；确认多色原子预留；任一色不足整单失败且不留部分', async () => {
  // 绿库存调到 3：订单需绿4红1 → 整单失败
  const sheets0 = await api('GET', '/api/glass-sheets');
  const gid = sheets0.data.sheets.find((s) => s.color === '#00ff00').id;
  const rid = sheets0.data.sheets.find((s) => s.color === '#ff0000').id;
  await api('PATCH', `/api/glass-sheets/${gid}`, { stock: 3 });

  const created = await api('POST', '/api/cut-orders', { name: '原子单', publicationId: pubId, copies: 2, gap: 5 });
  const oid = created.data.order.id;
  assert.strictEqual(created.data.order.status, 'draft');
  let s = (await api('GET', `/api/glass-sheets/${rid}`)).data.sheet;
  assert.strictEqual(s.reserved, 0, '草稿不预留');

  const cf = await api('POST', `/api/cut-orders/${oid}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'shortage');
  assert.deepStrictEqual(cf.data.shortages.map((x) => x.color), ['#00ff00']);
  assert.strictEqual(cf.data.shortages[0].shortage, 1);
  s = (await api('GET', `/api/glass-sheets/${rid}`)).data.sheet;
  assert.strictEqual(s.reserved, 0, '失败单未部分预留红色');
  assert.strictEqual((await api('GET', `/api/cut-orders/${oid}`)).data.order.status, 'draft');

  // 补足库存再确认 → 成功
  await api('PATCH', `/api/glass-sheets/${gid}`, { stock: 5 });
  const ok = await api('POST', `/api/cut-orders/${oid}/confirm`);
  assert.ok(ok.data.ok);
  s = (await api('GET', `/api/glass-sheets/${gid}`)).data.sheet;
  assert.strictEqual(s.reserved, 4);
  assert.strictEqual(s.available, 1);
  // 库存不得下调到低于预留
  const low = await api('PATCH', `/api/glass-sheets/${gid}`, { stock: 3 });
  assert.strictEqual(low.status, 409);
  assert.strictEqual(low.data.reserved, 4);
  // 重复确认 409 不重复预留
  assert.strictEqual((await api('POST', `/api/cut-orders/${oid}/confirm`)).status, 409);
  s = (await api('GET', `/api/glass-sheets/${gid}`)).data.sheet;
  assert.strictEqual(s.reserved, 4);
});

test('取消只释放一次；已确认不可删/改；释放后缺口单可确认', async () => {
  const orders = (await api('GET', '/api/cut-orders')).data.orders;
  const oid = orders[0].id;
  const gid = (await api('GET', '/api/glass-sheets')).data.sheets.find((s) => s.color === '#00ff00').id;

  assert.strictEqual((await api('DELETE', `/api/cut-orders/${oid}`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/cut-orders/${oid}`, { copies: 9 })).status, 409);

  const ca = await api('POST', `/api/cut-orders/${oid}/cancel`);
  assert.ok(ca.data.ok);
  let s = (await api('GET', `/api/glass-sheets/${gid}`)).data.sheet;
  assert.strictEqual(s.reserved, 0);
  assert.strictEqual((await api('POST', `/api/cut-orders/${oid}/cancel`)).status, 409);
  s = (await api('GET', `/api/glass-sheets/${gid}`)).data.sheet;
  assert.strictEqual(s.reserved, 0, '重复取消不重复释放');

  // 已取消订单可删除
  assert.ok((await api('DELETE', `/api/cut-orders/${oid}`)).data.ok);
});

test('并发确认不超卖：绿库存恰够 2 单时 3 个并发只有 2 个成功', async () => {
  const sheets = await api('GET', '/api/glass-sheets');
  const gid = sheets.data.sheets.find((s) => s.color === '#00ff00').id;
  const rid = sheets.data.sheets.find((s) => s.color === '#ff0000').id;
  // gap=0 copies=1：绿 60x60 一板即可放下全部 4 片 → 每单需绿 1、红 1
  await api('PATCH', `/api/glass-sheets/${gid}`, { stock: 2 });
  await api('PATCH', `/api/glass-sheets/${rid}`, { stock: 100 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const o = await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 1, gap: 0 });
    ids.push(o.data.order.id);
  }
  const results = await Promise.all(ids.map((id) => api('POST', `/api/cut-orders/${id}/confirm`)));
  const okN = results.filter((r) => r.data.ok).length;
  assert.strictEqual(okN, 2);
  assert.ok(results.every((r) => r.data.ok || r.data.code === 'shortage'));
  const s = (await api('GET', `/api/glass-sheets/${gid}`)).data.sheet;
  assert.strictEqual(s.reserved, 2);
  assert.strictEqual(s.available, 0);
});

test('快照绑定：草稿改版再发布不影响已确认订单的布局', async () => {
  const o = await api('POST', '/api/cut-orders', { name: '快照绑定单', publicationId: pubId, copies: 1, gap: 0 });
  const oid = o.data.order.id;
  await api('POST', `/api/cut-orders/${oid}/confirm`);
  const before = (await api('GET', `/api/cut-orders/${oid}`)).data.order;
  const beforeTotal = before.totalSheets;

  // 改草稿（删一片补两片，新增蓝色）并发布 v2
  await api('DELETE', `/api/designs/${designId}/pieces/4`);
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#0000aa', polygon: [[0, 30], [15, 30], [15, 60], [0, 60]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#0000bb', polygon: [[15, 30], [30, 30], [30, 60], [15, 60]],
  });
  const v2 = await api('POST', `/api/designs/${designId}/publish`);
  assert.strictEqual(v2.data.publication.version, 2);

  const after = (await api('GET', `/api/cut-orders/${oid}`)).data.order;
  assert.strictEqual(after.publicationId, pubId);
  assert.strictEqual(after.version, 1);
  assert.strictEqual(after.totalSheets, beforeTotal);
  const colors = after.layout.colors.map((c) => c.color).sort();
  assert.deepStrictEqual(colors, ['#00ff00', '#ff0000']);
});

test('确定性：相同版本/件数/间距两次预览布局一致', async () => {
  const a = await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 3, gap: 4 });
  const b = await api('POST', '/api/cut-orders/preview', { publicationId: pubId, copies: 3, gap: 4 });
  assert.strictEqual(JSON.stringify(a.data.preview.layout), JSON.stringify(b.data.preview.layout));
});

test('网页可打开；GET 接口齐全', async () => {
  const root = await fetch(BASE + '/');
  assert.strictEqual(root.status, 200);
  const html = await root.text();
  assert.ok(html.includes('玻璃裁片') || html.includes('裁片'));
  const sheets = await api('GET', '/api/glass-sheets');
  assert.ok(Array.isArray(sheets.data.sheets));
  const orders = await api('GET', '/api/cut-orders');
  assert.ok(Array.isArray(orders.data.orders));
});
