'use strict';

// 草稿片号规则：同一图纸内片号递增且永不复用（两条写入路径：手工新增 / 整批复用确认）。
// 覆盖：
//   1) 删除当前最大片号、删光全部草稿后再手工添加，片号仍高于此前已分配片号；
//   2) 服务重启后高水位仍在（持久化，不靠现存 MAX(piece_no) 推算）；
//   3) 已发布快照可查到的最大片号是最低起点，无法追溯的历史删除不回补；
//   4) 整批导入按选片顺序连续编号，不同图纸独立计数；
//   5) 手工添加被几何拒绝、整批确认失败（draft_changed）均不消耗片号；
//   6) 手工添加与整批确认并发（独立连接/线程）不撞号；
//   7) 旧库（无 piece_sequences 表）重启迁移后，按现存草稿+快照最大片号补建高水位。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39273';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `piecenos-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Worker } = require('node:worker_threads');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const DB_SRC = path.join(__dirname, '..', 'src', 'db.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let srcDesignId, srcPubId;   // 源图纸（100×100，v1 覆盖整窗，4 片各 50×50）

// 铺满 100×100 的四个 50×50 片
const TILES = [
  ['#ff0000', [[0, 0], [50, 0], [50, 50], [0, 50]]],           // #1 左下红
  ['#00ff00', [[50, 0], [100, 0], [100, 50], [50, 50]]],        // #2 右下绿
  ['#0000ff', [[0, 50], [50, 50], [50, 100], [0, 100]]],        // #3 左上蓝
  ['#ffff00', [[50, 50], [100, 50], [100, 100], [50, 100]]],    // #4 右上黄
];

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function newDesign(name, w = 100, h = 100) {
  const r = await api('POST', '/api/designs', { name, width: w, height: h });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.design.id;
}

async function add(designId, color, polygon) {
  const r = await api('POST', `/api/designs/${designId}/pieces`, { color, polygon });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data.piece.pieceNo;
}

async function draftPieceIds(designId) {
  const r = await api('GET', `/api/designs/${designId}`);
  assert.strictEqual(r.status, 200);
  return new Map(r.data.draft.pieces.map((p) => [p.pieceNo, p.id]));
}

async function del(designId, pieceId) {
  const r = await api('DELETE', `/api/designs/${designId}/pieces/${pieceId}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
}

async function preview(designId, body) {
  return api('POST', `/api/designs/${designId}/imports/preview`, body);
}

async function confirm(designId, importId) {
  return api('POST', `/api/designs/${designId}/imports/${importId}/confirm`);
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  srcDesignId = await newDesign('源图纸');
  for (const [color, poly] of TILES) {
    await add(srcDesignId, color, poly);
  }
  const p = await api('POST', `/api/designs/${srcDesignId}/publish`);
  assert.strictEqual(p.status, 201, JSON.stringify(p.data));
  srcPubId = p.data.publication.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 手工新增：删除不复用 ----------

test('删除当前最大片号后手工添加：新片号严格高于此前已分配片号', async () => {
  // 逐片断言 1..4
  const d2 = await newDesign('删除最大片号');
  for (let i = 0; i < TILES.length; i++) {
    assert.strictEqual(await add(d2, TILES[i][0], TILES[i][1]), i + 1);
  }
  // 发布（快照含 #1..#4）
  const pub = await api('POST', `/api/designs/${d2}/publish`);
  assert.strictEqual(pub.status, 201);

  // 删除当前最大片号 #4，再手工添加（新片放在右上角内侧 40×40，合法不重叠）
  const ids = await draftPieceIds(d2);
  await del(d2, ids.get(4));
  const noAfterDeleteMax = await add(d2, '#123456',
    [[50, 50], [90, 50], [90, 90], [50, 90]]);
  assert.strictEqual(noAfterDeleteMax, 5, '删掉 #4 后新片必须是 #5，#4 永不复用');

  // 删光全部草稿后再添加：仍从高水位继续
  for (const pid of (await draftPieceIds(d2)).values()) await del(d2, pid);
  const noAfterDeleteAll = await add(d2, '#654321',
    [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.strictEqual(noAfterDeleteAll, 6, '删光草稿后新片必须是 #6');
});

test('不同图纸片号独立计数', async () => {
  const other = await newDesign('另一张图纸');
  assert.strictEqual(await add(other, '#abcdef',
    [[0, 0], [10, 0], [10, 10], [0, 10]]), 1);
});

test('删除全部草稿并重启服务后，片号高水位仍持久化，旧片号不复现', async () => {
  const id = await newDesign('重启持久化');
  assert.strictEqual(await add(id, '#111111', [[0, 0], [10, 0], [10, 10], [0, 10]]), 1);
  assert.strictEqual(await add(id, '#222222', [[20, 0], [30, 0], [30, 10], [20, 10]]), 2);
  const ids = await draftPieceIds(id);
  await del(id, ids.get(2));

  // 模拟服务重启：关闭连接后以同一数据库文件重新初始化
  db.getDb().close();
  db.init(process.env.DB_PATH);

  assert.strictEqual(await add(id, '#333333', [[40, 0], [50, 0], [50, 10], [40, 10]]), 3);
});

// ---------- 已发布快照是最低起点 ----------

test('草稿删光后以已发布快照可查最大片号为最低起点', async () => {
  const id = await newDesign('快照起点');
  for (let i = 0; i < TILES.length; i++) {
    assert.strictEqual(await add(id, TILES[i][0], TILES[i][1]), i + 1);
  }
  // v1 快照含完整覆盖的 #1..#4（删除只能发生在发布之后）
  const pub = await api('POST', `/api/designs/${id}/publish`);
  assert.strictEqual(pub.status, 201);
  assert.strictEqual(pub.data.publication.snapshot.pieces.length, 4);

  // 删光草稿（#1..#4）后再添加：必须高于快照最大片号 4
  for (const pid of (await draftPieceIds(id)).values()) await del(id, pid);
  assert.strictEqual(await add(id, '#444444', [[0, 0], [5, 0], [5, 5], [0, 5]]), 5);
});

// ---------- 整批导入：选片顺序连续编号、图纸独立、失败不消耗 ----------

test('整批导入按选片顺序连续赋予目标图纸新片号；不同图纸独立计数', async () => {
  const t1 = await newDesign('导入目标1');
  // 选片顺序 [4,1]：确认后目标新号按此顺序为 #1、#2
  let pv = await preview(t1, { publicationId: srcPubId, pieceNos: [4, 1], rotation: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  let cf = await confirm(t1, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.deepStrictEqual(cf.data.addedPieces.map((p) => p.pieceNo), [1, 2]);
  assert.deepStrictEqual(cf.data.addedPieces.map((p) => p.sourcePieceNo), [4, 1]);

  // 再导入一片：续 #3
  pv = await preview(t1, { publicationId: srcPubId, pieceNos: [2], rotation: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  cf = await confirm(t1, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.deepStrictEqual(cf.data.addedPieces.map((p) => p.pieceNo), [3]);

  // 另一张图纸：从 #1 重新起算
  const t2 = await newDesign('导入目标2');
  pv = await preview(t2, { publicationId: srcPubId, pieceNos: [1], rotation: 0 });
  assert.strictEqual(pv.status, 201);
  cf = await confirm(t2, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.strictEqual(cf.data.addedPieces[0].pieceNo, 1);
});

test('预览几何失败不落记录、不消耗片号', async () => {
  const id = await newDesign('预览失败不耗号');
  const bad = await preview(id, { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 80 });
  assert.strictEqual(bad.status, 422);
  const pv = await preview(id, { publicationId: srcPubId, pieceNos: [1], rotation: 0 });
  assert.strictEqual(pv.status, 201);
  const cf = await confirm(id, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.strictEqual(cf.data.addedPieces[0].pieceNo, 1);
});

test('整批确认失败（draft_changed）不消耗片号；手工添加与后续确认连续不撞号', async () => {
  const id = await newDesign('确认失败不耗号');
  // 先导入 #1、#2 占下半 → 目标 #1、#2
  let pv = await preview(id, { publicationId: srcPubId, pieceNos: [1, 2], rotation: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  let cf = await confirm(id, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));

  // 预览 #3、#4（本应补上半），随后改色造成草稿变化
  pv = await preview(id, { publicationId: srcPubId, pieceNos: [3, 4], rotation: 0 });
  assert.strictEqual(pv.status, 201);
  const ids = await draftPieceIds(id);
  const edit = await api('PUT', `/api/designs/${id}/pieces/${ids.get(1)}`, {
    color: '#123456', polygon: TILES[0][1],
  });
  assert.strictEqual(edit.status, 200);

  cf = await confirm(id, pv.data.preview.id);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'draft_changed');

  // 失败确认不得消耗片号：手工添加落在 #4 区域内侧的小片应得 #3
  const no = await add(id, '#777777', [[60, 60], [70, 60], [70, 70], [60, 70]]);
  assert.strictEqual(no, 3, '失败的整批确认不能预占 #3、#4');

  // 重新预览仅 #3（左上，小片在右上不冲突）确认 → 续 #4
  pv = await preview(id, { publicationId: srcPubId, pieceNos: [3], rotation: 0 });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  cf = await confirm(id, pv.data.preview.id);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  assert.strictEqual(cf.data.addedPieces[0].pieceNo, 4);
});

test('手工添加被几何拒绝（422）不消耗片号', async () => {
  const id = await newDesign('几何拒绝不耗号');
  // 自交多边形（蝴蝶形）→ 422
  const r1 = await api('POST', `/api/designs/${id}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [10, 10], [0, 10], [10, 0]],
  });
  assert.strictEqual(r1.status, 422);
  // 越界 → 422
  const r2 = await api('POST', `/api/designs/${id}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
  });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.data.piece.pieceNo, 1);
});

// ---------- 并发：手工添加 vs 整批确认 ----------

test('手工添加与整批确认并发：片号不撞号、无空洞，正好覆盖连续区间', async () => {
  const tmp = path.join(__dirname, '..', 'data', `piecenos-conc-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix, { force: true }); } catch { /* ignore */ }
  }

  // 切到临时库：源图纸 200 片并发布；目标图纸空；一张待确认预览含 200 片
  db.getDb().close();
  db.init(tmp);
  const N = 200;
  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const src = db.createDesign({ name: '并发源', width: 100000, height: 100000 });
  for (let i = 1; i <= N; i++) db.addPiece(src.id, { color: '#010101', polygon: unit });
  const snapRows = db.listPieces(src.id);
  const pub = db.publishVersion(src.id, {
    name: '并发源', width: 100000, height: 100000,
    pieces: snapRows.map((p) => ({ pieceNo: p.pieceNo, color: p.color, polygon: p.polygon })),
  });
  const tgt = db.createDesign({ name: '并发目标', width: 100000, height: 100000 });
  const imp = db.createPieceImport({
    targetDesignId: tgt.id, publicationId: pub.id, sourceDesignId: src.id, sourceVersion: 1,
    rotation: 0, dx: 0, dy: 0,
    pieceNos: Array.from({ length: N }, (_, i) => i + 1),
    items: Array.from({ length: N }, (_, i) => ({
      index: i + 1, sourcePieceNo: i + 1, color: '#020202', polygon: unit,
    })),
    draftFingerprint: 'fp',
  });

  function runWorker(workerCode) {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerCode, { eval: true });
      w.on('message', (m) => resolve(m));
      w.on('error', reject);
    });
  }

  const workerAdd = `
    const { parentPort } = require('node:worker_threads');
    const db = require(${JSON.stringify(DB_SRC)});
    db.init(${JSON.stringify(tmp)});
    for (let i = 0; i < ${N}; i++) {
      db.addPiece(${tgt.id}, { color: '#030303', polygon: ${JSON.stringify(unit)} });
    }
    parentPort.postMessage('added');
  `;
  const workerConfirm = `
    const { parentPort } = require('node:worker_threads');
    const db = require(${JSON.stringify(DB_SRC)});
    db.init(${JSON.stringify(tmp)});
    const r = db.confirmPieceImport(${imp.id}, {
      checkFingerprint: () => true,
      checkGeometry: () => ({ ok: true }),
    });
    if (r.code !== 'ok') throw new Error('confirm failed: ' + r.code);
    parentPort.postMessage(r.code);
  `;

  const [a, c] = await Promise.all([runWorker(workerAdd), runWorker(workerConfirm)]);
  assert.strictEqual(a, 'added');
  assert.strictEqual(c, 'ok');

  const finalPieces = db.listPieces(tgt.id);
  assert.strictEqual(finalPieces.length, N * 2, '手工 200 + 整批 200 = 400 片全部写入');
  const nos = finalPieces.map((p) => p.pieceNo).sort((x, y) => x - y);
  assert.deepStrictEqual(nos, Array.from({ length: N * 2 }, (_, i) => i + 1),
    '片号必须恰好为 1..400：无撞号、无空洞');

  // 恢复主测试库并确认 HTTP 服务仍正常
  db.getDb().close();
  db.init(process.env.DB_PATH);
  const alive = await api('GET', '/api/designs');
  assert.strictEqual(alive.status, 200);

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 旧库迁移：无 piece_sequences 表时按现存草稿+快照补建 ----------

test('旧库升级：按现存草稿与已发布快照的最大片号补建高水位（重启后成立）', async () => {
  const tmp = path.join(__dirname, '..', 'data', `piecenos-mig-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix, { force: true }); } catch { /* ignore */ }
  }

  db.getDb().close();
  db.init(tmp);
  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // 图纸 A：发到 #7 后删掉草稿 #6、#7 → 现存草稿最大 5，快照最大 7 → 起点应为 8
  const a = db.createDesign({ name: '甲', width: 100, height: 100 });
  for (let i = 1; i <= 7; i++) db.addPiece(a.id, { color: '#0a0a0a', polygon: unit });
  db.publishVersion(a.id, {
    name: '甲', width: 100, height: 100,
    pieces: db.listPieces(a.id).map((p) => ({ pieceNo: p.pieceNo, color: p.color, polygon: p.polygon })),
  });
  for (const p of db.listPieces(a.id).filter((x) => x.pieceNo >= 6)) db.deletePiece(a.id, p.id);

  // 图纸 B：曾发 #1..#3，草稿删光 → 现存草稿最大 0，快照最大 3 → 起点应为 4
  const b = db.createDesign({ name: '乙', width: 100, height: 100 });
  for (let i = 1; i <= 3; i++) db.addPiece(b.id, { color: '#0b0b0b', polygon: unit });
  db.publishVersion(b.id, {
    name: '乙', width: 100, height: 100,
    pieces: db.listPieces(b.id).map((p) => ({ pieceNo: p.pieceNo, color: p.color, polygon: p.polygon })),
  });
  for (const p of db.listPieces(b.id)) db.deletePiece(b.id, p.id);

  // 图纸 C：新建空图纸，从未分片 → 起点 1
  const c = db.createDesign({ name: '丙', width: 100, height: 100 });

  // 模拟旧库：直接移除片号高水位表，再以同一文件重新初始化（触发迁移补建）
  db.getDb().close();
  db.init(tmp);
  db.getDb().exec('DROP TABLE piece_sequences');
  db.getDb().close();
  db.init(tmp);

  assert.strictEqual(db.addPiece(a.id, { color: '#1a1a1a', polygon: unit }).pieceNo, 8);
  assert.strictEqual(db.addPiece(b.id, { color: '#1b1b1b', polygon: unit }).pieceNo, 4);
  assert.strictEqual(db.addPiece(c.id, { color: '#1c1c1c', polygon: unit }).pieceNo, 1);

  // 再重启一次：高水位已持久化，继续递增
  db.getDb().close();
  db.init(tmp);
  assert.strictEqual(db.addPiece(a.id, { color: '#2a2a2a', polygon: unit }).pieceNo, 9);

  db.getDb().close();
  db.init(process.env.DB_PATH);
  const alive = await api('GET', '/api/designs');
  assert.strictEqual(alive.status, 200);

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix, { force: true }); } catch { /* ignore */ }
  }
});
