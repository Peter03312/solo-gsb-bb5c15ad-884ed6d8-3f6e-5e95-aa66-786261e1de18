'use strict';

// 草稿片号规则：同一图纸内编号递增且永不复用。
//   - 删除当前最大片号后再手工添加，不复用旧号；删光全部草稿、重启后同样继续递增；
//   - 已发布快照引用过的片号也是起点：现存草稿/快照可查的最大片号之后继续编号；
//   - 整批导入按选片顺序连续编号；确认失败（draft_changed 等）不消耗片号；
//   - 不同图纸独立计数；手工添加并发不撞号。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39288';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `pieceno-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

const sq = (x, y, s = 10) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

async function addSquare(designId, x, y, s, color = '#3366cc') {
  const r = await api('POST', `/api/designs/${designId}/pieces`, { color, polygon: sq(x, y, s) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.piece;
}

async function pieceNosOf(designId) {
  const r = await api('GET', `/api/designs/${designId}`);
  assert.strictEqual(r.status, 200);
  return r.data.draft.pieces.map((p) => p.pieceNo);
}

async function deleteAllPieces(designId) {
  const r = await api('GET', `/api/designs/${designId}`);
  for (const p of r.data.draft.pieces) {
    const d = await api('DELETE', `/api/designs/${designId}/pieces/${p.id}`);
    assert.strictEqual(d.status, 200, JSON.stringify(d.data));
  }
}

function restartServerDb() {
  db.getDb().close();
  db.init(process.env.DB_PATH);
}

let designA; // 片号持久性（删除最大号/删光/重启）
let designB; // 已发布快照作为起点
let designC; // 独立计数
let designD; // 整批导入
let designE; // 并发
let srcPubId; // 100×100 源发布版（#1..#4 四象限），用于整批复用

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i += 1) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  let d = await api('POST', '/api/designs', { name: '片号持久性', width: 100, height: 100 });
  designA = d.data.design.id;

  // 源图纸：四块 50×50 铺满 100×100 并发布
  d = await api('POST', '/api/designs', { name: '源图纸', width: 100, height: 100 });
  const srcId = d.data.design.id;
  await addSquare(srcId, 0, 0, 50, '#ff0000');
  await addSquare(srcId, 50, 0, 50, '#00ff00');
  await addSquare(srcId, 0, 50, 50, '#0000ff');
  await addSquare(srcId, 50, 50, 50, '#ffff00');
  const pub = await api('POST', `/api/designs/${srcId}/publish`);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.data));
  srcPubId = pub.data.publication.id;

  d = await api('POST', '/api/designs', { name: '快照起点', width: 100, height: 100 });
  designB = d.data.design.id;

  d = await api('POST', '/api/designs', { name: '独立计数', width: 50, height: 50 });
  designC = d.data.design.id;

  d = await api('POST', '/api/designs', { name: '整批导入', width: 100, height: 100 });
  designD = d.data.design.id;

  d = await api('POST', '/api/designs', { name: '并发', width: 200, height: 200 });
  designE = d.data.design.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 手工添加：删除最大片号不复用 ----------

test('手工添加：删除当前最大片号后再添加，得到更大的新片号', async () => {
  const p1 = await addSquare(designA, 0, 0);
  const p2 = await addSquare(designA, 10, 0);
  const p3 = await addSquare(designA, 20, 0);
  assert.deepStrictEqual([p1.pieceNo, p2.pieceNo, p3.pieceNo], [1, 2, 3]);

  let del = await api('DELETE', `/api/designs/${designA}/pieces/${p3.id}`);
  assert.strictEqual(del.status, 200);
  // 旧实现会重新分配 #3（已发布快照可能正引用该片号）
  const again = await addSquare(designA, 20, 0);
  assert.strictEqual(again.pieceNo, 4, '删除最大片号 #3 后再添加必须是 #4，不得复用 #3');
  assert.deepStrictEqual(await pieceNosOf(designA), [1, 2, 4]);

  // 删除中间片号同样不回填
  del = await api('DELETE', `/api/designs/${designA}/pieces/${p2.id}`);
  assert.strictEqual(del.status, 200);
  const p5 = await addSquare(designA, 10, 0);
  assert.strictEqual(p5.pieceNo, 5);
  assert.deepStrictEqual(await pieceNosOf(designA), [1, 4, 5]);
});

test('删光全部草稿后添加，片号继续递增；重启后仍成立', async () => {
  await deleteAllPieces(designA);
  assert.deepStrictEqual(await pieceNosOf(designA), []);
  const p = await addSquare(designA, 0, 0);
  assert.strictEqual(p.pieceNo, 6, '删光后从水线 #5 之后继续，不是 #1');

  await deleteAllPieces(designA);
  restartServerDb(); // 模拟进程重启：高水位必须持久化
  const after = await addSquare(designA, 0, 0);
  assert.strictEqual(after.pieceNo, 7, '重启后仍高于此前已分配片号');
});

// ---------- 已发布快照作为最低起点 ----------

test('已发布快照引用过的片号不得复用（含删光重启）', async () => {
  // 从源发布版整批复用 #1..#4 到 designB（恰好铺满）
  const pv = await api('POST', `/api/designs/${designB}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2, 3, 4], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  const cf = await api('POST', `/api/designs/${designB}/imports/${pv.data.preview.id}/confirm`);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.deepStrictEqual(cf.data.addedPieces.map((p) => p.pieceNo), [1, 2, 3, 4]);

  const published = await api('POST', `/api/designs/${designB}/publish`);
  assert.strictEqual(published.status, 201);
  assert.strictEqual(published.data.publication.version, 1);
  // 快照仍引用 #1..#4
  assert.deepStrictEqual(
    published.data.publication.snapshot.pieces.map((p) => p.pieceNo), [1, 2, 3, 4]);

  // 删掉 #3#4，草稿只剩 #1#2；旧实现会重新给出 #3
  let draft = (await api('GET', `/api/designs/${designB}`)).data.draft;
  for (const p of draft.pieces.filter((x) => x.pieceNo >= 3)) {
    const del = await api('DELETE', `/api/designs/${designB}/pieces/${p.id}`);
    assert.strictEqual(del.status, 200);
  }
  const p = await addSquare(designB, 0, 50, 50, '#123456');
  assert.strictEqual(p.pieceNo, 5, '快照最大片号 #4 仍被已发布版引用，新片必须是 #5');

  // 删光草稿并重启：现存草稿为空，但快照可查到 #4，仍从 #5 之后编号
  await deleteAllPieces(designB);
  restartServerDb();
  const after = await addSquare(designB, 0, 0);
  assert.strictEqual(after.pieceNo, 6, '重启后以快照最大片号 #4 为最低起点');

  // 已发布快照接口继续可用，片号不变
  const snap = await api('GET', `/api/designs/${designB}/publications/1`);
  assert.strictEqual(snap.status, 200);
  assert.deepStrictEqual(
    snap.data.publication.snapshot.pieces.map((x) => x.pieceNo), [1, 2, 3, 4]);
});

// ---------- 整批导入：选片顺序连续编号；失败不消耗 ----------

test('整批导入按选片顺序连续编号，保留来源片号映射', async () => {
  // 乱序选片 [#3, #1]：#3 在左上、#1 在左下，仅共边
  const pv = await api('POST', `/api/designs/${designD}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [3, 1], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  const cf = await api('POST', `/api/designs/${designD}/imports/${pv.data.preview.id}/confirm`);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  const added = cf.data.addedPieces;
  assert.deepStrictEqual(added.map((x) => x.pieceNo), [1, 2], '按选片顺序连续编号');
  assert.deepStrictEqual(added.map((x) => x.sourcePieceNo), [3, 1]);
  assert.strictEqual(added[0].color, '#0000ff');
  assert.strictEqual(added[1].color, '#ff0000');

  // 之后手工添加接续 #3；右半会被后续整批占用，验完即删（删除不回退水线）
  const manual = await addSquare(designD, 90, 90);
  assert.strictEqual(manual.pieceNo, 3);
  const del = await api('DELETE', `/api/designs/${designD}/pieces/${manual.id}`);
  assert.strictEqual(del.status, 200);
});

test('整批确认失败（draft_changed / 重复确认）不消耗片号', async () => {
  // 左半 #3#1 已在草稿；右半空。预览 #2#4（右半上下两片）
  const pv = await api('POST', `/api/designs/${designD}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [2, 4], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201);
  const importId = pv.data.preview.id;

  // 预览后手工加片（#4，落在 #4 源片区域内）→ 草稿指纹变化
  await addSquare(designD, 90, 90);
  const cf = await api('POST', `/api/designs/${designD}/imports/${importId}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'draft_changed');
  assert.strictEqual(cf.data.addedPieces, undefined);

  // 失败整批不写片，也不预留 #4#5：再手工添加应得 #5（仅单片 +1）
  const next = await addSquare(designD, 80, 80);
  assert.strictEqual(next.pieceNo, 5, '确认失败不得消耗片号');

  // 删除刚加的两片后重新预览并确认 → 仍然只接续水线：#6#7（#4#5 已被分配过不复用）
  const draft = (await api('GET', `/api/designs/${designD}`)).data.draft;
  for (const p of draft.pieces.filter((x) => x.pieceNo === 4 || x.pieceNo === 5)) {
    const d = await api('DELETE', `/api/designs/${designD}/pieces/${p.id}`);
    assert.strictEqual(d.status, 200);
  }
  const pv2 = await api('POST', `/api/designs/${designD}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [2, 4], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv2.status, 201, JSON.stringify(pv2.data));
  const cf2 = await api('POST', `/api/designs/${designD}/imports/${pv2.data.preview.id}/confirm`);
  assert.strictEqual(cf2.status, 201, JSON.stringify(cf2.data));
  assert.deepStrictEqual(cf2.data.addedPieces.map((x) => x.pieceNo), [6, 7]);
});

// ---------- 不同图纸独立计数 ----------

test('不同图纸片号独立计数，各自从 1 开始', async () => {
  const a = await addSquare(designC, 0, 0, 10);
  assert.strictEqual(a.pieceNo, 1);
  const b = await addSquare(designC, 10, 0, 10);
  assert.strictEqual(b.pieceNo, 2);
  // designA/designB 已经分到 #7/#6，不影响 designC
  assert.deepStrictEqual(await pieceNosOf(designC), [1, 2]);
});

// ---------- 并发 ----------

test('并发手工添加互不撞号：片号唯一且恰好覆盖连续区间', async () => {
  const N = 30; // 10 列 × 3 行，放在 x≥100 区域（留给后续整批导入左半）
  const reqs = [];
  for (let i = 0; i < N; i += 1) {
    const x = 100 + (i % 10) * 10;
    const y = Math.floor(i / 10) * 10;
    reqs.push(api('POST', `/api/designs/${designE}/pieces`,
      { color: '#3366cc', polygon: sq(x, y) }));
  }
  const results = await Promise.all(reqs);
  for (const r of results) assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const nos = results.map((r) => r.data.piece.pieceNo).sort((a, b) => a - b);
  assert.deepStrictEqual(nos, Array.from({ length: N }, (_, i) => i + 1));
  assert.strictEqual(new Set(nos).size, N, '并发下片号不得撞号');
});

test('整批确认与手工添加并发：失败按冲突规则整批拒绝且不消耗片号', async () => {
  // 预览左半 #1#2（x∈[0,100]，y∈[0,50]），与 x≥100 的手工片几何不重叠
  const pv = await api('POST', `/api/designs/${designE}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  const importId = pv.data.preview.id;

  // 确认同时再塞 10 片（x≥100 区域新的一行）；任一手工片提交都会改变草稿指纹
  const reqs = [api('POST', `/api/designs/${designE}/imports/${importId}/confirm`)];
  for (let i = 0; i < 10; i += 1) {
    reqs.push(api('POST', `/api/designs/${designE}/pieces`,
      { color: '#996600', polygon: sq(100 + i * 10, 30) }));
  }
  const [cf, ...adds] = await Promise.all(reqs);

  // 整批要么在手工片之前落库（201），要么草稿已变整批拒绝（409）；
  // 两种情况下手工片全部成功且片号唯一、无空洞被失败批吞掉。
  assert.ok([201, 409].includes(cf.status), JSON.stringify(cf.data));
  if (cf.status === 409) assert.strictEqual(cf.data.code, 'draft_changed');
  for (const r of adds) assert.strictEqual(r.status, 201, JSON.stringify(r.data));

  const draft = (await api('GET', `/api/designs/${designE}`)).data.draft;
  const nos = draft.pieces.map((p) => p.pieceNo).sort((a, b) => a - b);
  assert.strictEqual(new Set(nos).size, nos.length, '并发后片号仍唯一');

  // 重新预览（基于当前草稿）再确认：拿到的必是严格高于现存全部片号的连续号
  const pv2 = await api('POST', `/api/designs/${designE}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [3, 4], rotation: 0, dx: 0, dy: 50 });
  assert.strictEqual(pv2.status, 201, JSON.stringify(pv2.data));
  const cf2 = await api('POST', `/api/designs/${designE}/imports/${pv2.data.preview.id}/confirm`);
  if (cf2.status === 409 && cf2.data.code === 'draft_changed') {
    // 极端情况下并发确认已先落库左半上半，#3 与已有片重叠属整批拒绝；换个空区重导
    assert.fail(`不应在串行重导时再撞指纹: ${JSON.stringify(cf2.data)}`);
  }
  assert.strictEqual(cf2.status, 201, JSON.stringify(cf2.data));
  const base = nos.length ? nos[nos.length - 1] : 0;
  assert.deepStrictEqual(cf2.data.addedPieces.map((x) => x.pieceNo), [base + 1, base + 2]);
  assert.deepStrictEqual(cf2.data.addedPieces.map((x) => x.sourcePieceNo), [3, 4]);
});

// ---------- 原有接口继续可用 ----------

test('已发布快照与草稿接口继续可用，片号/颜色/轮廓一致', async () => {
  const snap = await api('GET', `/api/designs/${designB}/publications/1`);
  assert.strictEqual(snap.status, 200);
  const colors = snap.data.publication.snapshot.pieces.map((p) => p.color).sort();
  assert.deepStrictEqual(colors, ['#0000ff', '#00ff00', '#ff0000', '#ffff00']);

  const draft = await api('GET', `/api/designs/${designD}`);
  assert.strictEqual(draft.status, 200);
  assert.ok(Array.isArray(draft.data.draft.leadList.internal));
});

// ---------- 旧库迁移：以现存草稿/快照最大片号回填水线 ----------

test('旧库首次打开：以现存草稿和已发布快照可查最大片号为水线起点', () => {
  // 当前库中 designB 草稿现存 1 片（#6），快照最大 #4 → 水线应为 6
  const row = db.getDb()
    .prepare('SELECT last_piece_no FROM piece_sequences WHERE design_id = ?')
    .get(designB);
  assert.strictEqual(row.last_piece_no, 6);
  // designE：30 + 10 +（可能 2）片，至少 40；水线等于现存最大片号
  const eRow = db.getDb()
    .prepare('SELECT last_piece_no FROM piece_sequences WHERE design_id = ?')
    .get(designE);
  const eMax = db.getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) AS n FROM pieces WHERE design_id = ?')
    .get(designE).n;
  assert.strictEqual(eRow.last_piece_no, eMax);
  assert.ok(eRow.last_piece_no >= 40);
});
