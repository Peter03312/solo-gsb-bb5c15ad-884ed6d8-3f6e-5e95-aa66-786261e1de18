'use strict';

// 端到端：库存台账（按规格追溯铅条原材 / 玻璃原片的实物库存与净预留）
// 旧库首次启用按当前实物库存与净预留建立基线（不倒推旧业务）；新登记规格从登记余额起账；
// 登记/调库、独立或整套单的确认与取消、裁片换单、盘点确认、领料确认均与台账写入同一事务；
// 预览、失败回滚与幂等重试不留下重复流水；逐笔流水可顺序核对至当前余额；
// 查询支持材料类型 + 规格 + 时间范围，无记录返回空结果，非法筛选明确报错。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39261';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `ledger-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');

// —— 模拟“已有数据库首次启用台账”：先以旧库形态做业务（台账表随后删除），
//    服务启动时的迁移再按当前库存与净预留建立基线 ——
db.init(process.env.DB_PATH);
const seedDesign = db.createDesign({ name: '旧窗', width: 100, height: 100 });
db.addPiece(seedDesign.id, { color: '#ff0000', polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] });
const seedPub = db.publishVersion(seedDesign.id, {
  name: '旧窗', width: 100, height: 100, pieces: [], leadList: {}, frameArea: 10000,
});
const SEED_MID = db.createMaterial({ name: '旧料6m', lengthH: 600000, stock: 10 }).id;
const seedPlan = db.createPlan({
  name: '旧计划', publicationId: seedPub.id, designId: seedDesign.id, version: 1,
  materialId: SEED_MID, materialName: '旧料6m', materialLengthH: 600000,
  copies: 1, kerfH: 50, requiredBars: 3, segmentCount: 1, layout: {},
});
db.confirmPlan(seedPlan.id); // 旧业务：已确认计划预留 3 根（启用后不倒推，只进基线）
const SEED_GID = db.createGlassSheet({ color: '#ff0000', width: 600, height: 400, stock: 5 }).id;
db.getDb().exec('DROP TABLE stock_ledger'); // 模拟台账功能上线前的旧库
db.getDb().close();

const app = require('../src/server'); // 启动重新 init → 建表 + 基线

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PUB, PUB2;
let MID2, RID, GID, BID;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function ledgerOf(type, specId, extra = '') {
  const r = await api('GET', `/api/ledger?type=${type}&specId=${specId}${extra}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.ok, true);
  return r.data.ledger;
}

// 顺序核对：首笔（基线/登记）为起点，逐笔 上笔余额 + 本笔增减 = 本笔余额，末笔 = 当前结存
async function assertReconcile(type, specId) {
  const L = await ledgerOf(type, specId);
  assert.ok(L.entries.length > 0, `规格 ${type}#${specId} 应至少有基线/登记流水`);
  const first = L.entries[0];
  assert.ok(['baseline', 'register'].includes(first.eventType), '首笔应为基线或登记');
  let bs = first.balanceStock - first.deltaStock;
  let br = first.balanceReserved - first.deltaReserved;
  for (const e of L.entries) {
    bs += e.deltaStock;
    br += e.deltaReserved;
    assert.strictEqual(e.balanceStock, bs, `流水 #${e.id} 笔后实物应顺序核对`);
    assert.strictEqual(e.balanceReserved, br, `流水 #${e.id} 笔后净预留应顺序核对`);
  }
  const cur = type === 'lead'
    ? (await api('GET', `/api/materials/${specId}`)).data.material
    : (await api('GET', `/api/glass-sheets/${specId}`)).data.sheet;
  assert.strictEqual(bs, cur.stock, '台账末笔实物余额应等于当前库存');
  assert.strictEqual(br, cur.reserved, '台账末笔净预留余额应等于当前净预留');
  assert.strictEqual(L.current.stock, cur.stock);
  assert.strictEqual(L.current.reserved, cur.reserved);
  return L;
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', `/api/ledger?type=lead&specId=${SEED_MID}`); break; } catch { await sleep(50); }
  }
  // HTTP 建图：100×100 左红右绿 → 发布 v1；右半改蓝 → 发布 v2
  const d = await api('POST', '/api/designs', { name: '台账测试窗', width: 100, height: 100 });
  const designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
  const pieces = (await api('GET', `/api/designs/${designId}`)).data.draft.pieces;
  const green = pieces.find((p) => p.color === '#00ff00');
  await api('PUT', `/api/designs/${designId}/pieces/${green.id}`, {
    color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
  // 新规格（红色沿用种子规格 SEED_GID：600×400、库存 5）
  MID2 = (await api('POST', '/api/materials', { name: '300料', length: 300, stock: 20 })).data.material.id;
  GID = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 10 })).data.sheet.id;
  BID = (await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 10 })).data.sheet.id;
  RID = SEED_GID;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('旧库首次启用：按当前实物库存与净预留建立基线，不倒推旧业务', async () => {
  const L = await ledgerOf('lead', SEED_MID);
  assert.strictEqual(L.materialTypeText, '铅条原材');
  assert.strictEqual(L.unit, '根');
  assert.strictEqual(L.entries.length, 1, '旧计划确认等历史业务不应倒推为流水');
  const b = L.entries[0];
  assert.strictEqual(b.eventType, 'baseline');
  assert.strictEqual(b.eventText, '启用台账基线');
  assert.strictEqual(b.deltaStock, 0);
  assert.strictEqual(b.deltaReserved, 0);
  assert.strictEqual(b.balanceStock, 10, '基线实物 = 启用时当前库存');
  assert.strictEqual(b.balanceReserved, 3, '基线净预留 = 启用时当前净预留（旧计划 3 根）');
  assert.strictEqual(b.sourceType, 'system');
  assert.strictEqual(L.current.stock, 10);
  assert.strictEqual(L.current.reserved, 3);

  const G = await ledgerOf('glass', SEED_GID);
  assert.strictEqual(G.materialTypeText, '玻璃原片');
  assert.strictEqual(G.unit, '张');
  assert.strictEqual(G.entries.length, 1);
  assert.strictEqual(G.entries[0].eventType, 'baseline');
  assert.strictEqual(G.entries[0].balanceStock, 5);
  assert.strictEqual(G.entries[0].balanceReserved, 0);
});

test('非法筛选明确报错：类型/规格/时间格式/区间颠倒', async () => {
  assert.strictEqual((await api('GET', '/api/ledger')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=wood&specId=1')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=lead')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=lead&specId=abc')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=lead&specId=-2')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=lead&specId=1.5')).status, 400);
  assert.strictEqual((await api('GET', '/api/ledger?type=lead&specId=999999')).status, 404);
  assert.strictEqual((await api('GET', '/api/ledger?type=glass&specId=999999')).status, 404);
  const bad1 = await api('GET', `/api/ledger?type=lead&specId=${SEED_MID}&from=2026-13-01`);
  assert.strictEqual(bad1.status, 400);
  assert.strictEqual(bad1.data.ok, false);
  assert.strictEqual((await api('GET', `/api/ledger?type=lead&specId=${SEED_MID}&to=not-a-date`)).status, 400);
  assert.strictEqual((await api('GET', `/api/ledger?type=lead&specId=${SEED_MID}&from=2026-01-02&to=2026-01-01`)).status, 400);
  assert.strictEqual((await api('GET', `/api/ledger?type=lead&specId=${SEED_MID}&from=2026-01-01 25:00`)).status, 400);
});

test('无记录时返回空结果（不报错）', async () => {
  const L = await ledgerOf('lead', SEED_MID, '&from=2099-01-01');
  assert.strictEqual(L.count, 0);
  assert.deepStrictEqual(L.entries, []);
  const L2 = await ledgerOf('glass', SEED_GID, '&to=2000-01-01');
  assert.strictEqual(L2.count, 0);
  assert.deepStrictEqual(L2.entries, []);
});

test('新登记规格从登记余额起记账；手工调库记增减，仅改名不写流水', async () => {
  const L = await ledgerOf('lead', MID2);
  assert.strictEqual(L.entries.length, 1);
  const reg = L.entries[0];
  assert.strictEqual(reg.eventType, 'register');
  assert.strictEqual(reg.deltaStock, 20);
  assert.strictEqual(reg.deltaReserved, 0);
  assert.strictEqual(reg.balanceStock, 20);
  assert.strictEqual(reg.balanceReserved, 0);

  await api('PATCH', `/api/materials/${MID2}`, { stock: 25 });
  const renamed = await api('PATCH', `/api/materials/${MID2}`, { name: '300料改' });
  assert.strictEqual(renamed.status, 200);
  const L2 = await ledgerOf('lead', MID2);
  assert.strictEqual(L2.entries.length, 2, '仅改名不应产生台账流水');
  const adj = L2.entries[1];
  assert.strictEqual(adj.eventType, 'adjust');
  assert.strictEqual(adj.deltaStock, 5);
  assert.strictEqual(adj.deltaReserved, 0);
  assert.strictEqual(adj.balanceStock, 25);

  // 玻璃登记同样起账
  const G = await ledgerOf('glass', GID);
  assert.strictEqual(G.entries.length, 1);
  assert.strictEqual(G.entries[0].eventType, 'register');
  assert.strictEqual(G.entries[0].deltaStock, 10);
  await assertReconcile('lead', MID2);
  await assertReconcile('glass', GID);
});

test('独立计划确认/取消写台账；确认失败回滚、重复确认均不留流水', async () => {
  // 库存不足：确认失败 → 无新流水
  const big = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID2, copies: 100, kerf: 0.5 });
  const bigId = big.data.plan.id;
  const n0 = (await ledgerOf('lead', MID2)).entries.length;
  assert.strictEqual((await api('POST', `/api/plans/${bigId}/confirm`)).status, 409);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, n0, '确认失败回滚不应写台账');

  // 正常确认
  const plan = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID2, copies: 1, kerf: 0.5 });
  const planId = plan.data.plan.id;
  const need = plan.data.plan.requiredBars;
  assert.ok(need > 0);
  assert.strictEqual((await api('POST', `/api/plans/${planId}/confirm`)).status, 200);
  let L = await ledgerOf('lead', MID2);
  let last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'plan_confirm');
  assert.strictEqual(last.deltaStock, 0);
  assert.strictEqual(last.deltaReserved, need);
  assert.strictEqual(last.sourceType, 'lead_plan');
  assert.strictEqual(last.sourceId, planId);
  assert.ok(last.sourceLabel.includes(`#${planId}`));

  // 重复确认（409）不产生新流水
  assert.strictEqual((await api('POST', `/api/plans/${planId}/confirm`)).status, 409);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, L.entries.length);

  // 取消：释放预留
  assert.strictEqual((await api('POST', `/api/plans/${planId}/cancel`)).status, 200);
  L = await ledgerOf('lead', MID2);
  last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'plan_cancel');
  assert.strictEqual(last.deltaReserved, -need);
  await assertReconcile('lead', MID2);
});

test('裁片订单确认/取消按色写台账', async () => {
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/confirm`)).status, 200);
  for (const gid of [RID, GID]) {
    const L = await ledgerOf('glass', gid);
    const last = L.entries[L.entries.length - 1];
    assert.strictEqual(last.eventType, 'order_confirm');
    assert.strictEqual(last.sourceType, 'cut_order');
    assert.strictEqual(last.sourceId, orderId);
    assert.strictEqual(last.deltaStock, 0);
    assert.ok(last.deltaReserved > 0);
  }
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/cancel`)).status, 200);
  for (const gid of [RID, GID]) {
    const L = await ledgerOf('glass', gid);
    const last = L.entries[L.entries.length - 1];
    assert.strictEqual(last.eventType, 'order_cancel');
    assert.ok(last.deltaReserved < 0);
  }
  await assertReconcile('glass', RID);
  await assertReconcile('glass', GID);
});

test('裁片换单：旧单退出与新单接替同事务按序记账；幂等重试不重复流水', async () => {
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  await api('POST', `/api/cut-orders/${orderId}/confirm`);
  const r = await api('POST', `/api/cut-orders/${orderId}/replacement`, { targetPublicationId: PUB2 });
  assert.strictEqual(r.status, 201);
  const newId = r.data.order.id;

  // 红色：旧单退出（−1）后新单接替（+1），两笔按序可核对
  const LR = await ledgerOf('glass', RID);
  const outR = LR.entries[LR.entries.length - 2];
  const inR = LR.entries[LR.entries.length - 1];
  assert.strictEqual(outR.eventType, 'replace_out');
  assert.strictEqual(outR.sourceId, orderId);
  assert.strictEqual(outR.deltaReserved, -1);
  assert.strictEqual(inR.eventType, 'replace_in');
  assert.strictEqual(inR.sourceId, newId);
  assert.strictEqual(inR.deltaReserved, 1);
  assert.strictEqual(inR.balanceReserved, outR.balanceReserved + 1);

  // 绿色：仅旧单退出；蓝色：仅新单接替
  const LG = await ledgerOf('glass', GID);
  assert.strictEqual(LG.entries[LG.entries.length - 1].eventType, 'replace_out');
  const LB = await ledgerOf('glass', BID);
  const inB = LB.entries[LB.entries.length - 1];
  assert.strictEqual(inB.eventType, 'replace_in');
  assert.strictEqual(inB.sourceId, newId);

  // 相同参数重试：幂等返回原新单，不产生新流水
  const nR = LR.entries.length;
  const retry = await api('POST', `/api/cut-orders/${orderId}/replacement`, { targetPublicationId: PUB2 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual((await ledgerOf('glass', RID)).entries.length, nR);
  await assertReconcile('glass', RID);
  await assertReconcile('glass', GID);
  await assertReconcile('glass', BID);
});

test('整套单确认/取消同事务记账；同 requestId 重试不重复流水', async () => {
  const body = { publicationId: PUB, materialId: MID2, copies: 1, kerf: 0.5, gap: 0, requestId: 'COMBO-LEDGER-1' };
  const c = await api('POST', '/api/combo-orders', body);
  assert.strictEqual(c.status, 201);
  const comboId = c.data.combo.id;
  const needBars = c.data.combo.requiredBars;

  let L = await ledgerOf('lead', MID2);
  let last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'combo_confirm');
  assert.strictEqual(last.deltaReserved, needBars);
  assert.strictEqual(last.sourceType, 'combo');
  assert.strictEqual(last.sourceId, comboId);
  for (const gid of [RID, GID]) {
    const G = await ledgerOf('glass', gid);
    const gLast = G.entries[G.entries.length - 1];
    assert.strictEqual(gLast.eventType, 'combo_confirm');
    assert.strictEqual(gLast.sourceType, 'combo');
    assert.strictEqual(gLast.sourceId, comboId);
    assert.ok(gLast.deltaReserved > 0);
  }

  // 同 requestId 重试：幂等返回原单，两类规格均无新流水
  const nLead = L.entries.length;
  const nGlass = (await ledgerOf('glass', RID)).entries.length;
  const retry = await api('POST', '/api/combo-orders', body);
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, nLead);
  assert.strictEqual((await ledgerOf('glass', RID)).entries.length, nGlass);

  // 取消：两类预留各释放一次
  assert.strictEqual((await api('POST', `/api/combo-orders/${comboId}/cancel`)).status, 200);
  L = await ledgerOf('lead', MID2);
  last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'combo_cancel');
  assert.strictEqual(last.deltaReserved, -needBars);
  for (const gid of [RID, GID]) {
    const G = await ledgerOf('glass', gid);
    assert.strictEqual(G.entries[G.entries.length - 1].eventType, 'combo_cancel');
  }
  await assertReconcile('lead', MID2);
  await assertReconcile('glass', RID);
  await assertReconcile('glass', GID);
});

test('盘点确认写台账；基准不符整单回滚不留流水；重复确认幂等', async () => {
  // 预览后库存变动 → 确认 409（baseline_mismatch），整单不生效、不写台账
  const cur = (await api('GET', `/api/materials/${MID2}`)).data.material;
  const st = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID2, counted: cur.stock }],
  });
  const stId = st.data.stocktake.id;
  await api('PATCH', `/api/materials/${MID2}`, { stock: cur.stock + 2 }); // 调库（会写 adjust 流水）
  const fail = await api('POST', `/api/stocktakes/${stId}/confirm`);
  assert.strictEqual(fail.status, 409);
  assert.strictEqual(fail.data.code, 'baseline_mismatch');
  const L1 = await ledgerOf('lead', MID2);
  assert.strictEqual(L1.entries[L1.entries.length - 1].eventType, 'adjust', '盘点确认失败不应写台账');

  // 重新预览并确认：按实盘调整并写台账
  const cur2 = (await api('GET', `/api/materials/${MID2}`)).data.material;
  const st2 = await api('POST', '/api/stocktakes/preview', {
    items: [{ type: 'lead', specId: MID2, counted: cur2.stock - 1 }],
  });
  const st2Id = st2.data.stocktake.id;
  assert.strictEqual((await api('POST', `/api/stocktakes/${st2Id}/confirm`)).status, 200);
  const L2 = await ledgerOf('lead', MID2);
  const last = L2.entries[L2.entries.length - 1];
  assert.strictEqual(last.eventType, 'stocktake');
  assert.strictEqual(last.deltaStock, -1);
  assert.strictEqual(last.deltaReserved, 0);
  assert.strictEqual(last.sourceType, 'stocktake');
  assert.strictEqual(last.sourceId, st2Id);

  // 重复确认幂等：不再调整库存、不写流水
  const again = await api('POST', `/api/stocktakes/${st2Id}/confirm`);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.idempotent, true);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, L2.entries.length);
  await assertReconcile('lead', MID2);
});

test('领料确认同事务写台账；超量失败与同号重试均不留重复流水', async () => {
  const plan = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID2, copies: 1, kerf: 0.5 });
  const planId = plan.data.plan.id;
  const need = plan.data.plan.requiredBars;
  await api('POST', `/api/plans/${planId}/confirm`);

  // 超剩余预留领料 → 409，整次不生效、不写台账
  const n0 = (await ledgerOf('lead', MID2)).entries.length;
  const bad = await api('POST', `/api/plans/${planId}/issues`, { issueNo: 'LG-BAD-1', leadBars: need + 1 });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, n0);

  // 正常领料 1 根：实物与净预留同步核减
  const ok = await api('POST', `/api/plans/${planId}/issues`, { issueNo: 'LG-1', leadBars: 1 });
  assert.strictEqual(ok.status, 201);
  const L = await ledgerOf('lead', MID2);
  const last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'issue');
  assert.strictEqual(last.deltaStock, -1);
  assert.strictEqual(last.deltaReserved, -1);
  assert.strictEqual(last.sourceType, 'issue');
  assert.ok(last.sourceLabel.includes('LG-1'));

  // 同号同内容重试：幂等返回原记录，不写流水
  const retry = await api('POST', `/api/plans/${planId}/issues`, { issueNo: 'LG-1', leadBars: 1 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual((await ledgerOf('lead', MID2)).entries.length, L.entries.length);
  await assertReconcile('lead', MID2);
});

test('裁片订单领料按色写台账', async () => {
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  await api('POST', `/api/cut-orders/${orderId}/confirm`);
  const ok = await api('POST', `/api/cut-orders/${orderId}/issues`, {
    issueNo: 'LG-G1', sheets: [{ color: '#ff0000', count: 1 }],
  });
  assert.strictEqual(ok.status, 201);
  const L = await ledgerOf('glass', RID);
  const last = L.entries[L.entries.length - 1];
  assert.strictEqual(last.eventType, 'issue');
  assert.strictEqual(last.deltaStock, -1);
  assert.strictEqual(last.deltaReserved, -1);
  // 绿色本次未领：最后一笔仍应是订单确认
  const G = await ledgerOf('glass', GID);
  assert.strictEqual(G.entries[G.entries.length - 1].eventType, 'order_confirm');
  await assertReconcile('glass', RID);
  await assertReconcile('glass', GID);
});

test('时间范围过滤：边界包含、区间外排除、日期级整天', async () => {
  const all = await ledgerOf('lead', MID2);
  assert.ok(all.entries.length >= 3);
  const first = all.entries[0];
  const last = all.entries[all.entries.length - 1];

  const fromLast = await ledgerOf('lead', MID2, `&from=${encodeURIComponent(last.occurredAt)}`);
  assert.ok(fromLast.entries.length >= 1);
  assert.ok(fromLast.entries.every((e) => e.occurredAt >= last.occurredAt));

  const toFirst = await ledgerOf('lead', MID2, `&to=${encodeURIComponent(first.occurredAt)}`);
  assert.ok(toFirst.entries.length >= 1);
  assert.ok(toFirst.entries.every((e) => e.occurredAt <= first.occurredAt));

  // 日期级 from/to 覆盖当天全部流水
  const today = last.occurredAt.slice(0, 10);
  const dayAll = await ledgerOf('lead', MID2, `&from=${today}&to=${today}`);
  assert.strictEqual(dayAll.count, all.count);
  // 响应回显归一化后的边界
  assert.strictEqual(dayAll.from, `${today} 00:00:00`);
  assert.strictEqual(dayAll.to, `${today} 23:59:59`);
});

test('全部规格台账顺序核对至当前余额', async () => {
  for (const id of [SEED_MID, MID2]) await assertReconcile('lead', id);
  for (const id of [RID, GID, BID]) await assertReconcile('glass', id);
});
