'use strict';

// 端到端：玻璃原片瑕疵隔离 / 解除隔离
//  - 选一种或多种已登记颜色，提交正整数张数、非空原因与唯一操作号；
//  - 隔离只能划出“未预留（净）且未隔离”的实物，解除不得超过隔离余额；实物库存不随隔离变化；
//  - 新裁片订单/整套单可用量扣除隔离量；已确认单据仍可按原预留领料；
//  - 确认、换单、领料、手工调库、盘点均守住 实物库存 ≥ 净预留 + 隔离量；
//  - 同号同内容重试返回原记录，异内容 409；未知颜色/非法数量/任一颜色余额不足整次不生效；
//  - 每次操作原子写不可变隔离记录与台账（隔离变动 + 笔后余额），网页/HTTP 可查余额、实际可用量与历史。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39171';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `quarantine-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pub1, pub2;
let RED, GREEN, BLUE, LEAD;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function sheetOf(idOrColor) {
  const url = typeof idOrColor === 'number'
    ? `/api/glass-sheets/${idOrColor}`
    : `/api/glass-sheets?color=${idOrColor}`;
  if (typeof idOrColor === 'number') {
    const r = await api('GET', url);
    return r.data.sheet;
  }
  const r = await api('GET', '/api/glass-sheets');
  return r.data.sheets.find((s) => s.color === idOrColor);
}

// 顺序核对：台账逐笔 上笔余额 + 本笔增减 = 本笔余额（实物/净预留/隔离三轴），末笔 = 当前结存
async function assertReconcile(specId) {
  const L = (await api('GET', `/api/ledger?type=glass&specId=${specId}`)).data.ledger;
  assert.ok(L.entries.length > 0, `规格 #${specId} 应有台账流水`);
  const first = L.entries[0];
  assert.ok(['baseline', 'register'].includes(first.eventType));
  let bs = first.balanceStock - first.deltaStock;
  let br = first.balanceReserved - first.deltaReserved;
  let bq = first.balanceQuarantined - first.deltaQuarantined;
  for (const e of L.entries) {
    bs += e.deltaStock;
    br += e.deltaReserved;
    bq += e.deltaQuarantined;
    assert.strictEqual(e.balanceStock, bs, `#${e.id} 笔后实物`);
    assert.strictEqual(e.balanceReserved, br, `#${e.id} 笔后净预留`);
    assert.strictEqual(e.balanceQuarantined, bq, `#${e.id} 笔后隔离`);
    assert.ok(bs >= br + bq, `#${e.id} 实物不得低于净预留+隔离`);
  }
  const cur = (await api('GET', `/api/glass-sheets/${specId}`)).data.sheet;
  assert.strictEqual(bs, cur.stock);
  assert.strictEqual(br, cur.reserved);
  assert.strictEqual(bq, cur.quarantined);
  assert.strictEqual(cur.available, cur.stock - cur.reserved - cur.quarantined);
  return L;
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/glass-sheets'); break; } catch { await sleep(50); }
  }
  const d = await api('POST', '/api/designs', { name: '隔离测试窗', width: 60, height: 60 });
  designId = d.data.design.id;
  // 红两片（对角 30×30），绿两片（另两角）
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
  pub1 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;

  RED = (await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 100, height: 100, stock: 10 })).data.sheet.id;
  GREEN = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 60, height: 60, stock: 10 })).data.sheet.id;
  BLUE = (await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 60, height: 60, stock: 10 })).data.sheet.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 1) 入参校验：未知颜色 / 非法数量 / 空原因 / 缺操作号 / 重复颜色 / 非法动作 ----------

test('非法请求一律 400/404，整次不生效', async () => {
  let r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-1', action: 'hold', reason: '气泡',
    items: [{ color: '#123456', count: 1 }], // 未登记颜色
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'color_not_registered');

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-2', action: 'hold', reason: '气泡',
    items: [{ sheetId: 99999, count: 1 }],
  });
  assert.strictEqual(r.status, 404);

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-3', action: 'hold', reason: '气泡',
    items: [{ color: '#ff0000', count: 0 }], // 非正整数
  });
  assert.strictEqual(r.status, 400);

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-4', action: 'hold', reason: '气泡',
    items: [{ color: '#ff0000', count: 1.5 }],
  });
  assert.strictEqual(r.status, 400);

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-5', action: 'hold', reason: '   ', // 空原因
    items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(r.status, 400);

  r = await api('POST', '/api/glass-quarantines', {
    action: 'hold', reason: '气泡', // 缺操作号
    items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'invalid_op_no');

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-6', action: 'discard', reason: '气泡',
    items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(r.status, 400);

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-7', action: 'hold', reason: '气泡',
    items: [{ color: '#ff0000', count: 1 }, { color: '#FF0000', count: 2 }], // 同色重复
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'duplicate_color');

  r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-BAD-8', action: 'hold', reason: '气泡', items: [],
  });
  assert.strictEqual(r.status, 400);

  // 任何失败都不应改动隔离量
  const red = await sheetOf(RED);
  assert.strictEqual(red.quarantined, 0);
  assert.strictEqual(red.available, 10);
});

// ---------- 2) 多色隔离原子生效；实物库存不变；返回各色笔后余额 ----------

test('一次隔离多种颜色：实物库存不变，隔离余额与可用量正确', async () => {
  const r = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-1', action: 'hold', reason: '边角气泡、结石',
    items: [{ color: '#ff0000', count: 2 }, { sheetId: GREEN, count: 1 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.idempotent, false);
  const q = r.data.quarantine;
  assert.strictEqual(q.opNo, 'Q-HOLD-1');
  assert.strictEqual(q.action, 'hold');
  assert.strictEqual(q.items.length, 2);
  const qiRed = q.items.find((i) => i.color === '#ff0000');
  const qiGreen = q.items.find((i) => i.color === '#00ff00');
  assert.strictEqual(qiRed.count, 2);
  assert.strictEqual(qiRed.balanceQuarantined, 2);
  assert.strictEqual(qiGreen.balanceQuarantined, 1);

  const red = await sheetOf(RED);
  assert.strictEqual(red.stock, 10, '实物库存不因隔离变化');
  assert.strictEqual(red.quarantined, 2);
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.available, 8);
  const green = await sheetOf(GREEN);
  assert.strictEqual(green.stock, 10);
  assert.strictEqual(green.quarantined, 1);
  assert.strictEqual(green.available, 9);

  // 台账：隔离流水（实物/净预留不变，隔离 +n）
  const L = await assertReconcile(RED);
  const hold = L.entries.find((e) => e.eventType === 'quarantine_hold');
  assert.ok(hold);
  assert.strictEqual(hold.deltaStock, 0);
  assert.strictEqual(hold.deltaReserved, 0);
  assert.strictEqual(hold.deltaQuarantined, 2);
  assert.strictEqual(hold.balanceQuarantined, 2);
});

// ---------- 3) 同号幂等与冲突 ----------

test('同操作号：同内容重试返回原记录，异内容 409 且不重复变更', async () => {
  const same = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-1', action: 'hold', reason: '边角气泡、结石',
    items: [{ sheetId: GREEN, count: 1 }, { color: '#ff0000', count: 2 }], // 顺序不同仍同内容
  });
  assert.strictEqual(same.status, 200);
  assert.strictEqual(same.data.idempotent, true);
  assert.strictEqual(same.data.quarantine.id, 1);
  let s = await sheetOf(RED);
  assert.strictEqual(s.quarantined, 2, '重试不重复隔离');

  const ledgerEntryCount = async (sheetId) =>
    (await api('GET', `/api/ledger?type=glass&specId=${sheetId}`)).data.ledger.entries.length;
  const redLedgerBefore = await ledgerEntryCount(RED);
  const greenLedgerBefore = await ledgerEntryCount(GREEN);

  for (const body of [
    { action: 'hold', reason: '别的原因', items: [{ color: '#ff0000', count: 2 }, { sheetId: GREEN, count: 1 }] },
    { action: 'hold', reason: '边角气泡、结石', items: [{ color: '#ff0000', count: 1 }, { sheetId: GREEN, count: 1 }] },
    { action: 'release', reason: '边角气泡、结石', items: [{ color: '#ff0000', count: 2 }, { sheetId: GREEN, count: 1 }] },
    { action: 'hold', reason: '边角气泡、结石', items: [{ color: '#ff0000', count: 2 }, { color: '#0000ff', count: 1 }] },
  ]) {
    const conflict = await api('POST', '/api/glass-quarantines', { opNo: 'Q-HOLD-1', ...body });
    assert.strictEqual(conflict.status, 409, JSON.stringify(body));
    assert.strictEqual(conflict.data.code, 'op_no_conflict');
    assert.strictEqual(conflict.data.existing.id, 1);
    assert.strictEqual(conflict.data.existing.opNo, 'Q-HOLD-1');
    assert.strictEqual(conflict.data.existing.action, 'hold');
    assert.strictEqual(conflict.data.existing.reason, '边角气泡、结石');
    assert.deepStrictEqual(conflict.data.existing.colors, [
      { sheetId: RED, count: 2 },
      { sheetId: GREEN, count: 1 },
    ]);
    assert.deepStrictEqual(
      conflict.data.existing.items.map((i) => ({ sheetId: i.sheetId, color: i.color, count: i.count })),
      [
        { sheetId: RED, color: '#ff0000', count: 2 },
        { sheetId: GREEN, color: '#00ff00', count: 1 },
      ],
    );
    assert.strictEqual(await ledgerEntryCount(RED), redLedgerBefore, '冲突不追加红色台账');
    assert.strictEqual(await ledgerEntryCount(GREEN), greenLedgerBefore, '冲突不追加绿色台账');
  }
  s = await sheetOf(RED);
  assert.strictEqual(s.quarantined, 2, '冲突不改变隔离量');
  s = await sheetOf(GREEN);
  assert.strictEqual(s.quarantined, 1);
});

// ---------- 4) 解除隔离：不超余额；超余额整次失败；多色其一失败整单回滚 ----------

test('解除隔离不得超过隔离余额；任一颜色不足整次不生效', async () => {
  // 绿解除 1 → 余额 0
  const ok = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-1', action: 'release', reason: '复检合格',
    items: [{ color: '#00ff00', count: 1 }],
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual((await sheetOf(GREEN)).quarantined, 0);
  assert.strictEqual((await sheetOf(GREEN)).available, 10);

  // 再解除绿 1 → 超余额，409
  const over = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-2', action: 'release', reason: '复检合格',
    items: [{ color: '#00ff00', count: 1 }],
  });
  assert.strictEqual(over.status, 409);
  assert.strictEqual(over.data.code, 'shortage');
  assert.strictEqual(over.data.problems[0].reason, 'over_quarantined');

  // 多色操作：红余额 2 可解除 2，但蓝余额 0 不能隔离 1（蓝此时无预留，可隔离 10…改用超量）
  // 蓝当前 stock 10、净预留 0、隔离 0 → 试图隔离 11 与红解除 2 同单：整单回滚
  const mixed = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-MIX-1', action: 'hold', reason: '混合操作整单失败',
    items: [{ color: '#ff0000', count: 2 }, { color: '#0000ff', count: 11 }],
  });
  assert.strictEqual(mixed.status, 409);
  assert.strictEqual(mixed.data.code, 'shortage');
  const kinds = mixed.data.problems.map((p) => p.color);
  assert.ok(kinds.includes('#0000ff'));
  assert.strictEqual((await sheetOf(RED)).quarantined, 2, '整单回滚：红未变');
  assert.strictEqual((await sheetOf(BLUE)).quarantined, 0, '整单回滚：蓝未变');
});

// ---------- 5) 隔离与已确认预留：只能划出未预留实物；已确认单仍可按原预留领料 ----------

test('隔离只能划出未预留实物；已确认订单仍可按原预留领料；新单可用量扣隔离', async () => {
  // 当前：红 stock 10 / 净预留 0 / 隔离 2 / 可用 8 → 再隔离 8 到顶
  const maxHold = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-2', action: 'hold', reason: '整批待检',
    items: [{ color: '#ff0000', count: 8 }],
  });
  assert.strictEqual(maxHold.status, 201, JSON.stringify(maxHold.data));
  let red = await sheetOf(RED);
  assert.strictEqual(red.quarantined, 10);
  assert.strictEqual(red.available, 0);

  // 再多隔离 1：可隔离量 = 10 − 0 − 10 = 0 → 409 over_free
  const over = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-3', action: 'hold', reason: 'x', items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(over.status, 409);
  assert.strictEqual(over.data.problems[0].reason, 'over_free');
  assert.strictEqual(over.data.problems[0].available, 0);

  // 释放 2 张：可用 2（仍无预留）
  const rel = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-3', action: 'release', reason: '复检放行 2 张', items: [{ color: '#ff0000', count: 2 }],
  });
  assert.strictEqual(rel.status, 201);
  red = await sheetOf(RED);
  assert.strictEqual(red.quarantined, 8);
  assert.strictEqual(red.available, 2);

  // v1 ×1 件 gap0：红/绿各 1 张；确认成功（红可用 2、绿可用 10）
  const ord = await api('POST', '/api/cut-orders', { publicationId: pub1, copies: 1, gap: 0 });
  assert.strictEqual(ord.status, 201, JSON.stringify(ord.data));
  const orderId = ord.data.order.id;
  const cf = await api('POST', `/api/cut-orders/${orderId}/confirm`);
  assert.strictEqual(cf.status, 200, JSON.stringify(cf.data));
  red = await sheetOf(RED);
  assert.strictEqual(red.reserved, 1, '红净预留 1');
  assert.strictEqual(red.quarantined, 8);
  assert.strictEqual(red.available, 1);

  // 有预留时隔离：可隔离 = 10 − 1 − 8 = 1
  const holdOne = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-4', action: 'hold', reason: '再封存一张', items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(holdOne.status, 201);
  red = await sheetOf(RED);
  assert.strictEqual(red.quarantined, 9);
  assert.strictEqual(red.available, 0);

  // 试图隔离 1 张（可隔离 0）→ 整次失败
  const over2 = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-5', action: 'hold', reason: 'x', items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(over2.status, 409);

  // 新裁片订单需红 1：可用 0 → 确认 409（整单失败，绿也不留预留）
  const ord2 = await api('POST', '/api/cut-orders', { publicationId: pub1, copies: 1, gap: 0 });
  const cf2 = await api('POST', `/api/cut-orders/${ord2.data.order.id}/confirm`);
  assert.strictEqual(cf2.status, 409);
  assert.strictEqual(cf2.data.code, 'shortage');
  assert.ok(cf2.data.shortages.some((s) => s.color === '#ff0000' && s.shortage === 1));
  const greenStill = await sheetOf(GREEN);
  assert.strictEqual(greenStill.reserved, 1, '失败整单回滚：绿未新增预留');

  // 已确认订单仍可按原预留领料：实物 10 = 净预留 1 + 隔离 9，恰好可发
  const iss = await api('POST', `/api/cut-orders/${orderId}/issues`, {
    issueNo: 'IQ-1',
    sheets: [{ color: '#ff0000', count: 1 }, { color: '#00ff00', count: 1 }],
  });
  assert.strictEqual(iss.status, 201, JSON.stringify(iss.data));
  red = await sheetOf(RED);
  assert.strictEqual(red.stock, 9);
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.quarantined, 9);
  assert.strictEqual(red.available, 0);
  const green = await sheetOf(GREEN);
  assert.strictEqual(green.stock, 9);
  assert.strictEqual(green.reserved, 0);

  // 手工调库不得低于 净预留 + 隔离 = 9
  let patch = await api('PATCH', `/api/glass-sheets/${RED}`, { stock: 8 });
  assert.strictEqual(patch.status, 409);
  assert.strictEqual(patch.data.code, 'stock_below_reserved');
  assert.strictEqual(patch.data.floor, 9);
  patch = await api('PATCH', `/api/glass-sheets/${RED}`, { stock: 10 });
  assert.strictEqual(patch.status, 200);
  assert.strictEqual(patch.data.sheet.available, 1);

  await assertReconcile(RED);
  await assertReconcile(GREEN);
});

// ---------- 6) 盘点：固化隔离基准；预览后隔离变化整单拒绝；实盘不得低于 净预留+隔离 ----------

test('盘点重核隔离量基准，且实盘数不得低于净预留+隔离', async () => {
  // 绿当前 stock 9 / 净预留 0 / 隔离 0；先隔离 3
  const h = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-6', action: 'hold', reason: '盘点前封存', items: [{ color: '#00ff00', count: 3 }],
  });
  assert.strictEqual(h.status, 201);

  const pv = await api('POST', '/api/stocktakes/preview', {
    name: '隔离盘点',
    items: [{ type: 'glass', specId: GREEN, counted: 9 }],
  });
  assert.strictEqual(pv.status, 201);
  const stId = pv.data.stocktake.id;
  const item = pv.data.stocktake.items[0];
  assert.strictEqual(item.quarantined, 3);
  assert.strictEqual(item.availableAfterCount, 6); // 9 − 0 − 3

  // 预览后再隔离 1 → 确认时 quarantined_changed，整单不生效
  const h2 = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-7', action: 'hold', reason: '又封存一张', items: [{ color: '#00ff00', count: 1 }],
  });
  assert.strictEqual(h2.status, 201);
  let cf = await api('POST', `/api/stocktakes/${stId}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'baseline_mismatch');
  assert.strictEqual(cf.data.items[0].reason, 'quarantined_changed');
  assert.strictEqual(cf.data.items[0].currentQuarantined, 4);

  // 重新预览（固化隔离=4），实盘 9 可用 5 → 确认成功，库存仍 9
  const up = await api('PUT', `/api/stocktakes/${stId}`, {
    items: [{ type: 'glass', specId: GREEN, counted: 9 }],
  });
  assert.strictEqual(up.status, 200);
  cf = await api('POST', `/api/stocktakes/${stId}/confirm`);
  assert.strictEqual(cf.status, 200);
  let green = await sheetOf(GREEN);
  assert.strictEqual(green.stock, 9);
  assert.strictEqual(green.quarantined, 4);

  // 实盘低于 净预留 0 + 隔离 4 → below_reserved
  const pv2 = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'glass', specId: GREEN, counted: 3 }],
  });
  cf = await api('POST', `/api/stocktakes/${pv2.data.stocktake.id}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.items[0].reason, 'below_reserved');

  // 实盘 = 4 恰好等于隔离余额 → 确认成功；随后调回 10 供后续场景
  const pv3 = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'glass', specId: GREEN, counted: 4 }],
  });
  cf = await api('POST', `/api/stocktakes/${pv3.data.stocktake.id}/confirm`);
  assert.strictEqual(cf.status, 200);
  green = await sheetOf(GREEN);
  assert.strictEqual(green.stock, 4);
  assert.strictEqual(green.available, 0);
  const back = await api('PATCH', `/api/glass-sheets/${GREEN}`, { stock: 10 });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.data.sheet.available, 6); // 10 − 0 − 4

  await assertReconcile(GREEN);
});

// ---------- 7) 换单：新单可用量扣除隔离；不足整单失败，旧单保持 confirmed ----------

test('裁片换单按扣隔离后的可用量核验；成功后旧单退出、新单确认', async () => {
  // 当前：红 stock10/净预留0/隔离9/可用1；绿 stock10/隔离4/可用6；蓝 stock10/隔离0/可用10
  // v1 ×1 gap0 需红1绿1 → 可确认
  const ord = await api('POST', '/api/cut-orders', { name: '待换单', publicationId: pub1, copies: 1, gap: 0 });
  const oldId = ord.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/confirm`)).status, 200);

  // 改图：一片绿改蓝 → 发布 v2
  const draft = (await api('GET', `/api/designs/${designId}`)).data.draft;
  const greenPiece = draft.pieces.find((p) => p.color === '#00ff00');
  const bluePoly = greenPiece.polygon;
  const edit = await api('PUT', `/api/designs/${designId}/pieces/${greenPiece.id}`, {
    color: '#0000ff', polygon: bluePoly,
  });
  assert.ok(edit.data.ok, JSON.stringify(edit.data));
  pub2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;

  // 蓝整批隔离 10 → 新单需蓝 1 但可用 0：换单预览/确认都报缺口，旧单保持 confirmed
  const holdBlue = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-8', action: 'hold', reason: '蓝片整批待检', items: [{ color: '#0000ff', count: 10 }],
  });
  assert.strictEqual(holdBlue.status, 201);

  const pv = await api('POST', `/api/cut-orders/${oldId}/replacement/preview`, { targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(pv.status, 200);
  const blueRow = pv.data.preview.colors.find((c) => c.color === '#0000ff');
  assert.strictEqual(blueRow.quarantined, 10);
  assert.strictEqual(blueRow.shortage, 1);

  const fail = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(fail.status, 409);
  assert.strictEqual(fail.data.code, 'shortage');
  assert.strictEqual((await api('GET', `/api/cut-orders/${oldId}`)).data.order.status, 'confirmed');

  // 解除蓝 1 张 → 蓝可用 1；红仍需 1 张（v2 同样含红），先解除红 1 释放可用量
  const relBlue = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-8', action: 'release', reason: '放行一张蓝片', items: [{ color: '#0000ff', count: 1 }],
  });
  assert.strictEqual(relBlue.status, 201);
  const relRed = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-8R', action: 'release', reason: '放行一张红片用于换单', items: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(relRed.status, 201);

  const rep = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(rep.status, 201, JSON.stringify(rep.data));
  const newId = rep.data.order.id;
  assert.strictEqual(rep.data.order.status, 'confirmed');
  assert.strictEqual(rep.data.oldOrder.status, 'replaced');
  assert.strictEqual((await api('GET', `/api/cut-orders/${oldId}`)).data.order.status, 'replaced');

  // 同参数重试幂等；不同件数冲突
  const retry = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2, copies: 1, gap: 0 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual(retry.data.order.id, newId);
  const conflict = await api('POST', `/api/cut-orders/${oldId}/replacement`, { targetVersion: 2, copies: 2, gap: 0 });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.data.code, 'param_conflict');

  // 新单未领料可取消：取消后红、蓝净预留归零；隔离量不变
  const cancel = await api('POST', `/api/cut-orders/${newId}/cancel`);
  assert.strictEqual(cancel.status, 200);
  const blue = await sheetOf(BLUE);
  assert.strictEqual(blue.quarantined, 9);
  assert.strictEqual(blue.reserved, 0);
  assert.strictEqual(blue.available, 1);
  const red = await sheetOf(RED);
  assert.strictEqual(red.reserved, 0);
  assert.strictEqual(red.quarantined, 8); // 换单前为放行换单解除过 1 张
  assert.strictEqual(red.available, 2);

  await assertReconcile(BLUE);
  await assertReconcile(RED);
});

// ---------- 8) 整套单：确认时玻璃可用量扣除隔离；不足整体回滚 ----------

test('整套单确认核验铅条与各色玻璃（含隔离量），任一不足全部保持原状', async () => {
  LEAD = (await api('POST', '/api/materials', { name: '6m料', length: 6000, stock: 10 })).data.material.id;

  // v2 需红1蓝1；红可用1、蓝可用1 → 预览可行
  const pvOk = await api('POST', '/api/combo-orders/preview', {
    publicationId: pub2, materialId: LEAD, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(pvOk.status, 200);
  const blueColor = pvOk.data.preview.glass.colors.find((c) => c.color === '#0000ff');
  assert.strictEqual(blueColor.quarantined, 9);
  assert.strictEqual(blueColor.available, 1);
  assert.strictEqual(blueColor.shortage, 0);

  // 蓝再隔离 1（=10，可用 0）→ 确认整体 409（铅条也不留预留）
  const h = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-HOLD-9', action: 'hold', reason: '最后一张蓝片也封存', items: [{ color: '#0000ff', count: 1 }],
  });
  assert.strictEqual(h.status, 201);
  const fail = await api('POST', '/api/combo-orders', {
    requestId: 'CB-Q-1', publicationId: pub2, materialId: LEAD, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(fail.status, 409);
  assert.strictEqual(fail.data.code, 'shortage');
  assert.ok(fail.data.shortages.some((g) => g.color === '#0000ff' && g.shortage === 1));
  const leadAfterFail = await api('GET', `/api/materials/${LEAD}`);
  assert.strictEqual(leadAfterFail.data.material.reserved, 0, '回滚：铅条未预留');

  // 解除蓝 1 → 确认成功；同 requestId 重试幂等；异内容冲突
  const rel = await api('POST', '/api/glass-quarantines', {
    opNo: 'Q-REL-9', action: 'release', reason: '放行备料', items: [{ color: '#0000ff', count: 1 }],
  });
  assert.strictEqual(rel.status, 201);
  const ok = await api('POST', '/api/combo-orders', {
    requestId: 'CB-Q-1', name: '整套-隔离', publicationId: pub2, materialId: LEAD, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
  const comboId = ok.data.combo.id;

  const retry = await api('POST', '/api/combo-orders', {
    requestId: 'CB-Q-1', publicationId: pub2, materialId: LEAD, copies: 1, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);

  const conflict = await api('POST', '/api/combo-orders', {
    requestId: 'CB-Q-1', publicationId: pub2, materialId: LEAD, copies: 2, kerf: 0.5, gap: 0,
  });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.data.code, 'request_conflict');

  // 关联单预留已计入净预留；未领料可随整套单取消，隔离量不受影响
  const blueBefore = await sheetOf(BLUE);
  assert.strictEqual(blueBefore.reserved, 1);
  assert.strictEqual(blueBefore.available, 0);
  const cancel = await api('POST', `/api/combo-orders/${comboId}/cancel`);
  assert.strictEqual(cancel.status, 200);
  const blueAfter = await sheetOf(BLUE);
  assert.strictEqual(blueAfter.reserved, 0);
  assert.strictEqual(blueAfter.quarantined, 9);
  assert.strictEqual(blueAfter.available, 1);

  await assertReconcile(BLUE);
});

// ---------- 9) 历史与余额查询：列表/按颜色/按操作号/按 id；非法筛选报错 ----------

test('隔离历史与余额查询', async () => {
  const all = await api('GET', '/api/glass-quarantines');
  assert.strictEqual(all.status, 200);
  assert.ok(all.data.count >= 10);
  // 记录不可变：最早的 Q-HOLD-1 仍为原内容
  const first = await api('GET', '/api/glass-quarantines?opNo=Q-HOLD-1');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.data.quarantine.reason, '边角气泡、结石');
  assert.strictEqual(first.data.quarantine.items.length, 2);

  const byId = await api('GET', '/api/glass-quarantines/1');
  assert.strictEqual(byId.status, 200);
  assert.strictEqual(byId.data.quarantine.opNo, 'Q-HOLD-1');

  // 按颜色过滤：只含该色
  const greenOnly = await api('GET', `/api/glass-quarantines?sheetId=${GREEN}`);
  assert.strictEqual(greenOnly.status, 200);
  assert.ok(greenOnly.data.quarantines.length > 0);
  for (const q of greenOnly.data.quarantines) {
    assert.ok(q.items.some((i) => i.sheetId === GREEN));
  }
  const byColor = await api('GET', '/api/glass-quarantines?color=%230000ff');
  assert.strictEqual(byColor.status, 200);
  assert.ok(byColor.data.quarantines.length > 0);

  // 非法/不存在
  assert.strictEqual((await api('GET', '/api/glass-quarantines?opNo=NOPE')).status, 404);
  assert.strictEqual((await api('GET', '/api/glass-quarantines/99999')).status, 404);
  assert.strictEqual((await api('GET', '/api/glass-quarantines?sheetId=abc')).status, 400);
  assert.strictEqual((await api('GET', '/api/glass-quarantines?color=red')).status, 400);
  assert.strictEqual((await api('GET', '/api/glass-quarantines?color=%23123456')).status, 404);
});

// ---------- 10) 库存视图：实物/净预留字段含义保持，新增隔离与实际可用量 ----------

test('GET /api/glass-sheets 保持 stock/reserved 含义并新增 quarantined/available', async () => {
  const r = await api('GET', '/api/glass-sheets');
  assert.strictEqual(r.status, 200);
  for (const s of r.data.sheets) {
    assert.strictEqual(s.stock, s.stock); // 实物库存不随隔离变化（字段保留原含义）
    assert.ok(Number.isInteger(s.quarantined));
    assert.strictEqual(s.available, s.stock - s.reserved - s.quarantined);
    assert.ok(s.stock >= s.reserved + s.quarantined, '实物库存不低于净预留与隔离量之和');
  }
});
