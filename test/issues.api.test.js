'use strict';

// 端到端：领料（按已确认独立铅条计划 / 独立裁片订单 / 整套用料单分次领料）
// 确认在同一事务内扣减实物库存与对应预留，留下不可变领料记录；
// 数量非负整数且至少一项大于零、不得超过该单剩余预留，整套单允许只领一类；
// 同一领料号同内容重试返回原记录，不同内容冲突；任一项不合法整次不生效；
// 已领料单据不能取消，独立裁片订单不能换单；未领料单据仍按原规则操作；
// 盘点、手工库存调整及后续确认按结转后的库存与净预留计算。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39251';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `issue-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PUB, PUB2, PUB3;
let MID, RID, GID, BID, PID2;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// 建一张 100×100 两色拼片窗（左红右绿）并发布；再改成左红右蓝发布 v2
async function setupDesigns() {
  const d = await api('POST', '/api/designs', { name: '领料测试窗', width: 100, height: 100 });
  const designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;

  // v2：右半改为蓝色
  const pieces = (await api('GET', `/api/designs/${designId}`)).data.draft.pieces;
  const green = pieces.find((p) => p.color === '#00ff00');
  await api('PUT', `/api/designs/${designId}/pieces/${green.id}`, {
    color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;

  // v3：右半改为紫色（仅并发测试使用，此前无任何预留/领取）
  const pieces2 = (await api('GET', `/api/designs/${designId}`)).data.draft.pieces;
  const blue = pieces2.find((p) => p.color === '#0000ff');
  await api('PUT', `/api/designs/${designId}/pieces/${blue.id}`, {
    color: '#800080', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  PUB3 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication.id;
  return designId;
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/issues'); break; } catch { await sleep(50); }
  }
  MID = (await api('POST', '/api/materials', { name: '300领料料', length: 300, stock: 100 })).data.material.id;
  RID = (await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 20 })).data.sheet.id;
  GID = (await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 20 })).data.sheet.id;
  BID = (await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 20 })).data.sheet.id;
  PID2 = (await api('POST', '/api/glass-sheets', { color: '#800080', width: 600, height: 400, stock: 20 })).data.sheet.id;
  await setupDesigns();
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('入参校验：缺领料号/非法数量/全零/无来源/未知来源一律拒绝（不改库存）', async () => {
  // 先确认一张计划作为对象
  const plan = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  const planId = plan.data.plan.id;
  await api('POST', `/api/plans/${planId}/confirm`);
  globalThis.PLAN_A = planId;

  const before = await api('GET', `/api/materials/${MID}`);
  assert.strictEqual((await api('POST', '/api/issues', { planId, leadBars: 2 })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'bad1', planId, leadBars: -1 })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'bad2', planId, leadBars: 1.5 })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'bad3', planId, leadBars: 0 })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'bad4' })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'bad5', sourceType: 'wood', sourceId: 1 })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', {
    issueNo: 'bad6', planId, sheets: [{ color: '#zz0000', count: 1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/issues', {
    issueNo: 'bad7', planId, sheets: [{ color: '#123456', count: 1 }],
  })).status, 404); // 未登记颜色
  const after = await api('GET', `/api/materials/${MID}`);
  assert.strictEqual(after.data.material.stock, before.data.material.stock);
});

test('来源必须存在且已确认；关联单不能从独立入口领料', async () => {
  assert.strictEqual((await api('POST', '/api/issues', { issueNo: 'x1', planId: 99999, leadBars: 1 })).status, 404);
  // 草稿计划不能领
  const draft = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  assert.strictEqual((await api('POST', '/api/issues', {
    issueNo: 'x2', planId: draft.data.plan.id, leadBars: 1,
  })).status, 409);
  // 草稿/已取消订单不能领
  const dorder = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  assert.strictEqual((await api('POST', '/api/issues', {
    issueNo: 'x3', orderId: dorder.data.order.id, sheets: [{ sheetId: RID, count: 1 }],
  })).status, 409);
});

test('独立铅条计划分次领料：扣实物+净预留、不可变记录、本次/累计/余留正确', async () => {
  const planId = globalThis.PLAN_A;
  const need = (await api('GET', `/api/plans/${planId}`)).data.plan.requiredBars;
  globalThis.NEED_A = need;

  const r1 = await api('POST', `/api/plans/${planId}/issues`, { issueNo: 'PL-A-1', leadBars: 2 });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.idempotent, false);
  assert.strictEqual(r1.data.issue.lead.requiredBars, need);
  assert.strictEqual(r1.data.issue.lead.thisBars, 2);
  assert.strictEqual(r1.data.issue.lead.pickedBars, 2);
  assert.strictEqual(r1.data.issue.lead.remainingBars, need - 2);
  assert.strictEqual(r1.data.issue.lead.stockBars, 98);

  // 实物库存 98；净预留 need-2；可用 = 98-(need-2) = 100-need（与领料前一致）
  const m = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(m.stock, 98);
  assert.strictEqual(m.grossReserved, need);
  assert.strictEqual(m.picked, 2);
  assert.strictEqual(m.reserved, need - 2);
  assert.strictEqual(m.available, 100 - need);

  // 领完剩余
  const r2 = await api('POST', '/api/issues', { issueNo: 'PL-A-2', planId, leadBars: need - 2 });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.data.issue.lead.pickedBars, need);
  assert.strictEqual(r2.data.issue.lead.remainingBars, 0);
  assert.strictEqual(r2.data.issue.lead.stockBars, 100 - need);

  // 超领整次不生效
  const bad = await api('POST', '/api/issues', { issueNo: 'PL-A-3', planId, leadBars: 1 });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.data.code, 'invalid_issue');
  assert.strictEqual(bad.data.problems[0].reason, 'over_remaining');
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 100 - need);
});

test('同一领料号：相同内容重试返回原记录（幂等），不同内容报冲突', async () => {
  const planId = globalThis.PLAN_A;
  const retry = await api('POST', `/api/plans/${planId}/issues`, { issueNo: 'PL-A-1', leadBars: 2 });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.idempotent, true);
  assert.strictEqual(retry.data.issue.lead.thisBars, 2);
  assert.strictEqual(retry.data.issue.lead.pickedBars, globalThis.NEED_A);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 100 - globalThis.NEED_A);

  const conflict = await api('POST', '/api/issues', { issueNo: 'PL-A-1', planId, leadBars: 1 });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.data.code, 'issue_no_conflict');
  assert.strictEqual(conflict.data.existing.leadBars, 2);
  assert.strictEqual((await api('GET', `/api/materials/${MID}`)).data.material.stock, 100 - globalThis.NEED_A);
});

test('已领料铅条计划不能取消；未领料计划仍可取消', async () => {
  const a = await api('POST', `/api/plans/${globalThis.PLAN_A}/cancel`);
  assert.strictEqual(a.status, 409);
  assert.strictEqual(a.data.code, 'already_issued');

  const plan = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  const id = plan.data.plan.id;
  assert.strictEqual((await api('POST', `/api/plans/${id}/confirm`)).status, 200);
  // 未领料 → 可取消
  assert.strictEqual((await api('POST', `/api/plans/${id}/cancel`)).status, 200);
});

test('独立裁片订单分次领料（按色）：原子扣减、逐色余留、整单回滚', async () => {
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  globalThis.ORDER_A = orderId;
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/confirm`)).status, 200);

  // 只领红 1（绿不领，数量为 0 的项允许）
  const r = await api('POST', `/api/cut-orders/${orderId}/issues`, {
    issueNo: 'OR-A-1',
    sheets: [{ color: '#ff0000', count: 1 }, { color: '#00ff00', count: 0 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.issue.thisTime.leadBars, 0);
  assert.deepStrictEqual(r.data.issue.thisTime.glass, [{ sheetId: RID, color: '#ff0000', count: 1 }]);
  const red = r.data.issue.glass.colors.find((c) => c.color === '#ff0000');
  const green = r.data.issue.glass.colors.find((c) => c.color === '#00ff00');
  assert.strictEqual(red.pickedSheets, 1);
  assert.strictEqual(red.remainingSheets, 0);
  assert.strictEqual(red.stockSheets, 19);
  assert.strictEqual(green.pickedSheets, 0);
  assert.strictEqual(green.remainingSheets, 1);

  // 红超领整次失败；且同次绿领取 1 也必须整体回滚
  const bad = await api('POST', '/api/issues', {
    issueNo: 'OR-A-BAD', orderId,
    sheets: [{ sheetId: RID, count: 1 }, { sheetId: GID, count: 1 }],
  });
  assert.strictEqual(bad.status, 409);
  assert.ok(bad.data.problems.some((p) => p.kind === 'glass' && p.reason === 'over_remaining'));
  const g2 = (await api('GET', `/api/glass-sheets/${GID}`)).data.sheet;
  assert.strictEqual(g2.stock, 20, '合法的绿色 1 张也不得部分扣减');
  assert.strictEqual(g2.reserved, 1);

  // 领取不属于该单的颜色 → 整单拒绝
  const badColor = await api('POST', '/api/issues', {
    issueNo: 'OR-A-BLUE', orderId, sheets: [{ sheetId: BID, count: 1 }],
  });
  assert.strictEqual(badColor.status, 409);
  assert.ok(badColor.data.problems.some((p) => p.reason === 'sheet_not_in_order'));
  assert.strictEqual((await api('GET', `/api/glass-sheets/${BID}`)).data.sheet.stock, 20);

  // 领绿完成
  const ok = await api('POST', '/api/issues', { issueNo: 'OR-A-2', orderId, sheets: [{ sheetId: GID, count: 1 }] });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.issue.glass.totalPicked, 2);
  assert.strictEqual(ok.data.issue.glass.totalRemaining, 0);
});

test('已领料独立裁片订单不能取消、不能换单', async () => {
  const orderId = globalThis.ORDER_A;
  const cancel = await api('POST', `/api/cut-orders/${orderId}/cancel`);
  assert.strictEqual(cancel.status, 409);
  assert.strictEqual(cancel.data.code, 'already_issued');

  const preview = await api('POST', `/api/cut-orders/${orderId}/replacement/preview`, { targetVersion: 2 });
  assert.strictEqual(preview.status, 409);
  assert.strictEqual(preview.data.code, 'already_issued');
  const rep = await api('POST', `/api/cut-orders/${orderId}/replacement`, { targetVersion: 2 });
  assert.strictEqual(rep.status, 409);
  assert.strictEqual(rep.data.code, 'already_issued');
});

test('未领料的已确认裁片订单仍可换单（原规则不变）', async () => {
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const id = order.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${id}/confirm`)).status, 200);
  const rep = await api('POST', `/api/cut-orders/${id}/replacement`, { targetVersion: 2 });
  assert.strictEqual(rep.status, 201, JSON.stringify(rep.data));
  assert.strictEqual(rep.data.order.version, 2);
  // 换单前未领料，旧单可以变为 replaced（不能再领料）
  const oldIssue = await api('POST', '/api/issues', { issueNo: 'REP-OLD', orderId: id, sheets: [{ sheetId: RID, count: 1 }] });
  assert.strictEqual(oldIssue.status, 409);
});

test('整套单分次领料：可只领一类，铅条/玻璃各自余留独立；记录不可变', async () => {
  const created = await api('POST', '/api/combo-orders', {
    name: '领料整套', publicationId: PUB, materialId: MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'issue-combo-1',
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  const comboId = created.data.combo.id;
  const leadPlanId = created.data.combo.leadPlanId;
  const cutOrderId = created.data.combo.cutOrderId;
  globalThis.COMBO = comboId;
  globalThis.COMBO_PLAN = leadPlanId;
  globalThis.COMBO_ORDER = cutOrderId;
  const needBars = created.data.combo.requiredBars;
  const needSheets = created.data.combo.totalSheets;

  // 关联单不能从独立入口领料
  const viaPlan = await api('POST', '/api/issues', { issueNo: 'CB-P', planId: leadPlanId, leadBars: 1 });
  assert.strictEqual(viaPlan.status, 409);
  assert.strictEqual(viaPlan.data.code, 'issue_use_combo');
  const viaOrder = await api('POST', '/api/issues', {
    issueNo: 'CB-O', orderId: cutOrderId, sheets: [{ sheetId: RID, count: 1 }],
  });
  assert.strictEqual(viaOrder.status, 409);
  assert.strictEqual(viaOrder.data.code, 'issue_use_combo');

  // 只领铅条（整套单允许只领一类）
  const r1 = await api('POST', `/api/combo-orders/${comboId}/issues`, { issueNo: 'CB-1', leadBars: 1 });
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.issue.lead.thisBars, 1);
  assert.strictEqual(r1.data.issue.lead.remainingBars, needBars - 1);
  assert.strictEqual(r1.data.issue.glass.totalPicked, 0);
  assert.strictEqual(r1.data.issue.glass.totalRemaining, needSheets);

  // 只领玻璃红 1
  const r2 = await api('POST', `/api/combo-orders/${comboId}/issues`, {
    issueNo: 'CB-2', sheets: [{ sheetId: RID, count: 1 }],
  });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.data.issue.lead.thisBars, 0);
  assert.strictEqual(r2.data.issue.lead.pickedBars, 1);
  assert.strictEqual(r2.data.issue.glass.totalPicked, 1);

  // 超领铅条整次回滚（不影响玻璃）
  const bad = await api('POST', `/api/combo-orders/${comboId}/issues`, {
    issueNo: 'CB-3', leadBars: needBars, // 仅剩 needBars-1
  });
  assert.strictEqual(bad.status, 409);
  const view = await api('GET', `/api/combo-orders/${comboId}/issues`);
  assert.strictEqual(view.data.lead.pickedBars, 1);
  assert.strictEqual(view.data.glass.totalPicked, 1);

  // 一次同领两类（铅条 + 绿色 1）：产生多条同号记录，重试仍幂等
  const both = await api('POST', `/api/combo-orders/${comboId}/issues`, {
    issueNo: 'CB-BOTH', leadBars: 1, sheets: [{ sheetId: GID, count: 1 }],
  });
  assert.strictEqual(both.status, 201, JSON.stringify(both.data));
  assert.strictEqual(both.data.issue.lead.thisBars, 1);
  assert.deepStrictEqual(both.data.issue.thisTime.glass, [{ sheetId: GID, color: '#00ff00', count: 1 }]);
  const bothRetry = await api('POST', `/api/combo-orders/${comboId}/issues`, {
    issueNo: 'CB-BOTH', leadBars: 1, sheets: [{ sheetId: GID, count: 1 }],
  });
  assert.strictEqual(bothRetry.status, 200);
  assert.strictEqual(bothRetry.data.idempotent, true);
  // 同号只改其中一类数量 → 冲突
  const bothConflict = await api('POST', `/api/combo-orders/${comboId}/issues`, {
    issueNo: 'CB-BOTH', leadBars: 1, sheets: [{ sheetId: GID, count: 0 }],
  });
  assert.strictEqual(bothConflict.status, 409);
  assert.strictEqual(bothConflict.data.code, 'issue_no_conflict');
});

test('整套单已领料不能取消；未领料整套单仍可取消', async () => {
  const cancel = await api('POST', `/api/combo-orders/${globalThis.COMBO}/cancel`);
  assert.strictEqual(cancel.status, 409);
  assert.strictEqual(cancel.data.code, 'already_issued');

  const c2 = await api('POST', '/api/combo-orders', {
    name: '未领料整套', publicationId: PUB, materialId: MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'issue-combo-2',
  });
  assert.strictEqual((await api('POST', `/api/combo-orders/${c2.data.combo.id}/cancel`)).status, 200);
});

test('领料后新确认单据与手工调库按净预留计算；PATCH 不得低于净预留', async () => {
  const m0 = (await api('GET', `/api/materials/${MID}`)).data.material;
  // 整套铅条已领 2（CB-1、CB-BOTH），净预留 = needBars-2
  const comboView0 = await api('GET', `/api/combo-orders/${globalThis.COMBO}/issues`);
  const expectedNet = comboView0.data.lead.remainingBars;
  assert.ok(expectedNet >= 0);
  assert.strictEqual(m0.reserved, expectedNet, `净预留应与整套剩余一致 ${expectedNet}，实际 ${m0.reserved}`);
  assert.strictEqual(m0.available, m0.stock - m0.reserved);

  // 新确认一个计划，按净预留口径判定
  const plan = await api('POST', '/api/plans', { publicationId: PUB, materialId: MID, copies: 1, kerf: 0.5 });
  const req = plan.data.plan.requiredBars;
  const cf = await api('POST', `/api/plans/${plan.data.plan.id}/confirm`);
  if (m0.available >= req) {
    assert.strictEqual(cf.status, 200);
    globalThis.PLAN_B = plan.data.plan.id;
  } else {
    assert.strictEqual(cf.status, 409);
    assert.strictEqual(cf.data.code, 'shortage');
  }

  // PATCH 不得低于“当前净预留”（PLAN_B 若已确认则计入）
  const mAfterConfirm = (await api('GET', `/api/materials/${MID}`)).data.material;
  const low = await api('PATCH', `/api/materials/${MID}`, { stock: mAfterConfirm.reserved - 1 });
  assert.strictEqual(low.status, 409);
  assert.strictEqual(low.data.reserved, mAfterConfirm.reserved);

  // PLAN_B 未领料，取消后释放净预留，再把库存压到仅剩整套未领部分
  if (globalThis.PLAN_B) {
    assert.strictEqual((await api('POST', `/api/plans/${globalThis.PLAN_B}/cancel`)).status, 200);
  }
  const needBarsNow = (await api('GET', `/api/combo-orders/${globalThis.COMBO}/issues`)).data.lead.remainingBars;
  const mPre = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(mPre.reserved, needBarsNow);
  // 调成等于净预留可以（剩余实物全部还要留给未领部分）
  const eq = await api('PATCH', `/api/materials/${MID}`, { stock: needBarsNow });
  assert.strictEqual(eq.status, 200);
  assert.strictEqual(eq.data.material.available, 0);

  // 领走整套剩余铅条：实物恰好够净预留 → 成功
  const m1 = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(m1.stock, needBarsNow);
  const rr = await api('POST', `/api/combo-orders/${globalThis.COMBO}/issues`, {
    issueNo: 'CB-FIN', leadBars: needBarsNow,
  });
  assert.strictEqual(rr.status, 201, JSON.stringify(rr.data));
  const m2 = (await api('GET', `/api/materials/${MID}`)).data.material;
  assert.strictEqual(m2.stock, 0);
  assert.strictEqual(m2.reserved, 0);
});

test('领料后盘点按净预留校验：实盘低于净预留拒绝，通过后库存结转', async () => {
  // 新确认一张独立订单（红/绿各 1）：绿色净预留 +1（此前整套绿已在 CB-BOTH 领走）
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/confirm`)).status, 200);
  const g = (await api('GET', `/api/glass-sheets/${GID}`)).data.sheet;
  assert.strictEqual(g.reserved, 1, '该订单绿色净预留 1');
  // 实盘 0 < 净预留 1 → below_reserved
  const bad = await api('POST', '/api/stocktakes/preview', { items: [{ type: 'glass', specId: GID, counted: 0 }] });
  const cf1 = await api('POST', `/api/stocktakes/${bad.data.stocktake.id}/confirm`);
  assert.strictEqual(cf1.status, 409);
  assert.strictEqual(cf1.data.items[0].reason, 'below_reserved');

  // 实盘 = 净预留 1 → 通过；库存结转为 1
  const ok = await api('POST', '/api/stocktakes/preview', { items: [{ type: 'glass', specId: GID, counted: 1 }] });
  const cf2 = await api('POST', `/api/stocktakes/${ok.data.stocktake.id}/confirm`);
  assert.strictEqual(cf2.status, 200, JSON.stringify(cf2.data));
  const g2 = (await api('GET', `/api/glass-sheets/${GID}`)).data.sheet;
  assert.strictEqual(g2.stock, 1);
  assert.strictEqual(g2.reserved, 1);
  assert.strictEqual(g2.available, 0);
  // 领走该订单最后 1 张绿 → 库存 0、净预留 0
  const r = await api('POST', `/api/cut-orders/${orderId}/issues`, {
    issueNo: 'ST-GREEN-FIN', sheets: [{ sheetId: GID, count: 1 }],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const g3 = (await api('GET', `/api/glass-sheets/${GID}`)).data.sheet;
  assert.strictEqual(g3.stock, 0);
  assert.strictEqual(g3.reserved, 0);
});

test('领料历史：全局/按单据/按领料号查询，记录不可变', async () => {
  const all = await api('GET', '/api/issues');
  assert.strictEqual(all.status, 200);
  const nos = all.data.issues.map((i) => i.issueNo);
  for (const n of ['PL-A-1', 'PL-A-2', 'OR-A-1', 'OR-A-2', 'CB-1', 'CB-2']) {
    assert.ok(nos.includes(n), `历史缺少 ${n}`);
  }
  // source 过滤
  const combos = await api('GET', '/api/issues?source=combo');
  assert.ok(combos.data.issues.every((i) => i.sourceType === 'combo'));
  assert.ok(combos.data.issues.some((i) => i.issueNo === 'CB-1'));

  // 按单据
  const ph = await api('GET', `/api/plans/${globalThis.PLAN_A}/issues`);
  assert.strictEqual(ph.data.lead.pickedBars, globalThis.NEED_A);
  assert.ok(ph.data.issues.some((i) => i.issueNo === 'PL-A-1'));
  const oh = await api('GET', `/api/cut-orders/${globalThis.ORDER_A}/issues`);
  assert.strictEqual(oh.data.glass.totalPicked, 2);
  assert.ok(oh.data.issues.some((i) => i.issueNo === 'OR-A-2'));
  const ch = await api('GET', `/api/combo-orders/${globalThis.COMBO}/issues`);
  assert.ok(ch.data.issues.length >= 3);

  // 按领料号
  const one = await api('GET', '/api/issues/PL-A-1');
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.issue.issueNo, 'PL-A-1');
  assert.strictEqual((await api('GET', '/api/issues/NOPE')).status, 404);
});

test('并发对同一剩余余量领料：合计不超过剩余预留（写事务串行化）', async () => {
  // 用 v3 发布版建单（红+紫）；紫色此前从未被任何已确认订单预留/领取
  const purpBefore = (await api('GET', `/api/glass-sheets/${PID2}`)).data.sheet;
  assert.strictEqual(purpBefore.reserved, 0, '前置：紫色净预留应为 0');
  const order = await api('POST', '/api/cut-orders', { publicationId: PUB3, copies: 1, gap: 0 });
  const orderId = order.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${orderId}/confirm`)).status, 200);

  const results = await Promise.all([
    api('POST', '/api/issues', { issueNo: 'CC-1', orderId, sheets: [{ sheetId: PID2, count: 1 }] }),
    api('POST', '/api/issues', { issueNo: 'CC-2', orderId, sheets: [{ sheetId: PID2, count: 1 }] }),
    api('POST', '/api/issues', { issueNo: 'CC-3', orderId, sheets: [{ sheetId: PID2, count: 1 }] }),
  ]);
  const ok = results.filter((r) => r.status === 201);
  const bad = results.filter((r) => r.status === 409);
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(bad.length, 2);
  assert.ok(bad.every((r) => r.data.code === 'invalid_issue'));
  const stats = await api('GET', `/api/cut-orders/${orderId}/issues`);
  assert.strictEqual(stats.data.glass.colors.find((c) => c.color === '#800080').pickedSheets, 1);
  assert.strictEqual(stats.data.glass.colors.find((c) => c.color === '#800080').remainingSheets, 0);
});

test('网页与既有接口仍可用：首页含“领料”，原字段保持', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('领料'));
  const plans = await api('GET', '/api/plans');
  assert.ok(Array.isArray(plans.data.plans));
  const p = plans.data.plans.find((x) => x.id === globalThis.PLAN_A);
  assert.ok(p);
  assert.ok('requiredBars' in p && 'pickedBars' in p && 'remainingBars' in p);
  const mats = await api('GET', '/api/materials');
  const m = mats.data.materials.find((x) => x.id === MID);
  assert.ok('stock' in m && 'reserved' in m && 'available' in m);
  const sheets = await api('GET', '/api/glass-sheets');
  const s = sheets.data.sheets.find((x) => x.id === RID);
  assert.ok('stock' in s && 'reserved' in s && 'available' in s);
});
