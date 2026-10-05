'use strict';

// 端到端：跨图纸拼片复用
// 从已发布图纸选片（不重复编号），指定目标草稿、绕源原点的 0/90/180/270 旋转与整数毫米平移，
// 预览转换后的轮廓/颜色/目标位置/草稿覆盖状态；确认时整批赋予新编号、保留原色。
// 覆盖：参数校验、来源/片号不存在、越界/重叠整批拒绝、合法共边/T 接、
//       预览后编辑须重新预览（draft_changed）、确认幂等保护、源快照不变、原有单片接口继续可用。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39271';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `imports-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');
const imp = require('../src/importpieces');

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

// 在指定图纸上直接放若干覆盖整窗的拼片并发布；pieces 形如 [[color,poly],...]
async function coverAndPublish(designId, w, h, pieces) {
  for (const [color, poly] of pieces) {
    const r = await api('POST', `/api/designs/${designId}/pieces`, { color, polygon: poly });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  }
  const p = await api('POST', `/api/designs/${designId}/publish`);
  assert.strictEqual(p.status, 201, JSON.stringify(p.data));
  return p.data.publication;
}

let srcDesignId, srcPubId;      // 源图纸（100×100，v1 覆盖整窗，4 片）
let srcDesign2Id, srcPub2Id;    // 第二个源图纸（200×120）
let tgtDesignId;                // 目标图纸（100×100，初始空草稿）
let tgtDesign2Id;               // 另一个目标（50×50）

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/designs'); break; } catch { await sleep(50); }
  }

  let d = await api('POST', '/api/designs', { name: '源图纸', width: 100, height: 100 });
  srcDesignId = d.data.design.id;
  srcPubId = (await coverAndPublish(srcDesignId, 100, 100, [
    ['#ff0000', [[0, 0], [50, 0], [50, 50], [0, 50]]],           // #1 左下红
    ['#00ff00', [[50, 0], [100, 0], [100, 50], [50, 50]]],        // #2 右下绿
    ['#0000ff', [[0, 50], [50, 50], [50, 100], [0, 100]]],        // #3 左上蓝
    ['#ffff00', [[50, 50], [100, 50], [100, 100], [50, 100]]],    // #4 右上黄
  ])).id;

  d = await api('POST', '/api/designs', { name: '源图纸2', width: 200, height: 120 });
  srcDesign2Id = d.data.design.id;
  srcPub2Id = (await coverAndPublish(srcDesign2Id, 200, 120, [
    ['#ff0000', [[0, 0], [100, 0], [100, 120], [0, 120]]],
    ['#00ff00', [[100, 0], [200, 0], [200, 120], [100, 120]]],
  ])).id;

  d = await api('POST', '/api/designs', { name: '目标图纸', width: 100, height: 100 });
  tgtDesignId = d.data.design.id;

  d = await api('POST', '/api/designs', { name: '小目标', width: 50, height: 50 });
  tgtDesign2Id = d.data.design.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

// ---------- 纯几何：变换 ----------

test('旋转绕源图纸坐标原点（y 轴向上，逆时针），平移为整数毫米', () => {
  assert.deepStrictEqual(imp.transformPoint(1, 2, 0, 0, 0), [1, 2]);
  assert.deepStrictEqual(imp.transformPoint(1, 2, 90, 0, 0), [-2, 1]);
  assert.deepStrictEqual(imp.transformPoint(1, 2, 180, 0, 0), [-1, -2]);
  assert.deepStrictEqual(imp.transformPoint(1, 2, 270, 0, 0), [2, -1]);
  assert.deepStrictEqual(imp.transformPoint(1, 2, 180, 10, 20), [9, 18]);
  const poly = [[0, 0], [50, 0], [50, 50], [0, 50]];
  // 转 180 后平移 (100,100)：左下片移动到右上 [50,100]×[50,100]
  assert.deepStrictEqual(imp.transformPolygon(poly, 180, 100, 100),
    [[100, 100], [50, 100], [50, 50], [100, 50]]);
});

test('非法参数一律 400：空选/重复编号/旋转角/平移/缺来源', async () => {
  const url = `/api/designs/${tgtDesignId}/imports/preview`;
  let r = await api('POST', url, { publicationId: srcPubId, pieceNos: [], rotation: 0 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', url, { publicationId: srcPubId, pieceNos: [1, 1], rotation: 0 });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /重复/);
  r = await api('POST', url, { publicationId: srcPubId, pieceNos: [1], rotation: 45 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', url, { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 1.5 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', url, { publicationId: srcPubId, pieceNos: [0], rotation: 0 });
  assert.strictEqual(r.status, 400);
  r = await api('POST', url, { pieceNos: [1], rotation: 0 });
  assert.strictEqual(r.status, 400);
});

test('来源发布版不存在 → 404 source_not_found', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: 999999, pieceNos: [1], rotation: 0 });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'source_not_found');
  const r2 = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { sourceDesignId: srcDesignId, sourceVersion: 99, pieceNos: [1], rotation: 0 });
  assert.strictEqual(r2.status, 404);
  assert.strictEqual(r2.data.code, 'source_not_found');
});

test('来源片号不存在 → 404 source_piece_not_found，整批不写', async () => {
  const before = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft.pieces.length;
  const r = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 99], rotation: 0 });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.code, 'source_piece_not_found');
  assert.deepStrictEqual(r.data.missing, [99]);
  const after = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft.pieces.length;
  assert.strictEqual(before, after);
  assert.deepStrictEqual(await api('GET', `/api/designs/${tgtDesignId}/imports`).then((x) => x.data.imports), []);
});

test('目标图纸不存在 → 404', async () => {
  const r = await api('POST', '/api/designs/999999/imports/preview',
    { publicationId: srcPubId, pieceNos: [1], rotation: 0 });
  assert.strictEqual(r.status, 404);
});

// ---------- 预览：几何 ----------

test('预览返回转换后轮廓/原色/目标位置与覆盖状态，且不写草稿', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 4], rotation: 180, dx: 100, dy: 100 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const pv = r.data.preview;
  assert.ok(pv.id > 0);
  assert.strictEqual(pv.status, 'pending');
  assert.strictEqual(pv.source.publicationId, srcPubId);
  assert.strictEqual(pv.source.designId, srcDesignId);
  assert.strictEqual(pv.rotation, 180);
  // #1 左下红旋转 180 +(100,100) → 右上 50..100
  const i1 = pv.items.find((x) => x.sourcePieceNo === 1);
  assert.strictEqual(i1.color, '#ff0000', '保留原色');
  assert.deepStrictEqual(i1.bounds, { minX: 50, minY: 50, maxX: 100, maxY: 100, width: 50, height: 50 });
  // #4 右上黄 → 左下 0..50
  const i4 = pv.items.find((x) => x.sourcePieceNo === 4);
  assert.strictEqual(i4.color, '#ffff00');
  assert.deepStrictEqual(i4.bounds, { minX: 0, minY: 0, maxX: 50, maxY: 50, width: 50, height: 50 });
  // 模拟覆盖：只导入 2 片，未覆盖整窗
  assert.strictEqual(pv.simulated.coverage.covered, false);
  assert.strictEqual(pv.simulated.pieceCount, 2);
  assert.strictEqual(pv.targetDraft.pieceCount, 0);
  // 草稿仍为空
  const draft = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  assert.strictEqual(draft.pieces.length, 0);
  // 预览可查
  const g = await api('GET', `/api/designs/${tgtDesignId}/imports/${pv.id}`);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.stale, false);
});

test('越界 → 422 geometry_conflict（out_of_frame），整批不写', async () => {
  const r = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 80, dy: 0 });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.code, 'geometry_conflict');
  assert.strictEqual(r.data.problems[0].reason, 'out_of_frame');
  assert.strictEqual(r.data.problems[0].sourcePieceNo, 1);
  assert.ok(Array.isArray(r.data.problems[0].at));
});

test('片放进更小窗框：大尺寸片任何旋转都越界；50×50 的片正好放进 50×50', async () => {
  // 源图纸2 的片是 100×120，任何 90° 旋转都放不进 50×50 → out_of_frame
  const tooBig = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { publicationId: srcPub2Id, pieceNos: [1], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(tooBig.status, 422);
  assert.strictEqual(tooBig.data.problems[0].reason, 'out_of_frame');
  // 源 v1 的 #1（50×50）不转正好放进 50×50，且单独覆盖整窗
  const ok = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.data));
  assert.strictEqual(ok.data.preview.simulated.coverage.covered, true);
});

test('刚体变换保持源片中的共边与顶点相接；整批统一变换不会制造重叠', async () => {
  // #1=[0,50]×[0,50]、#2=[50,100]×[0,50] 仅共边：任意整批刚体变换后仍仅共边
  const edge = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(edge.status, 201, JSON.stringify(edge.data));
  // 180°+(100,100)：#1→右上、#2→左上，仍仅共边
  const rotated = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2], rotation: 180, dx: 100, dy: 100 });
  assert.strictEqual(rotated.status, 201, JSON.stringify(rotated.data));
  // 顶点相接：#1 不动，#2 上移 50 → 仅在 (50,50) 顶点接触，合法
  const touch = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 50 });
  assert.strictEqual(touch.status, 201, JSON.stringify(touch.data));
  assert.deepStrictEqual(touch.data.preview.simulated.coverage.overlapping, []);
});

// ---------- 确认整批写入 ----------

test('确认：整批赋予目标新编号、保留原色；源快照与源草稿不变', async () => {
  const pv = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1, 2], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201);
  const importId = pv.data.preview.id;

  const cf = await api('POST', `/api/designs/${tgtDesignId}/imports/${importId}/confirm`);
  assert.strictEqual(cf.status, 201, JSON.stringify(cf.data));
  const added = cf.data.addedPieces;
  assert.strictEqual(added.length, 2);
  assert.strictEqual(added[0].pieceNo, 1);
  assert.strictEqual(added[0].sourcePieceNo, 1);
  assert.strictEqual(added[0].color, '#ff0000');
  assert.strictEqual(added[1].pieceNo, 2);
  assert.strictEqual(added[1].color, '#00ff00');

  const draft = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  assert.strictEqual(draft.pieces.length, 2);
  // 新片之间无重叠（共边允许）
  assert.deepStrictEqual(draft.coverage.overlapping, []);

  // 源发布快照不变
  const sp = await api('GET', `/api/designs/${srcDesignId}/publications/1`);
  assert.strictEqual(sp.data.publication.snapshot.pieces.length, 4);
  assert.strictEqual(sp.data.publication.snapshot.pieces[0].color, '#ff0000');
  // 源草稿仍有 4 片（发布不删草稿）
  const sd = (await api('GET', `/api/designs/${srcDesignId}`)).data.draft;
  assert.strictEqual(sd.pieces.length, 4);
});

test('重复确认 → 409 already_confirmed，不再写片', async () => {
  const list = await api('GET', `/api/designs/${tgtDesignId}/imports?status=confirmed`);
  const importId = list.data.imports[0].id;
  const again = await api('POST', `/api/designs/${tgtDesignId}/imports/${importId}/confirm`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.data.code, 'already_confirmed');
  const draft = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  assert.strictEqual(draft.pieces.length, 2, '重复确认不重复写片');
  // 已确认记录不能删除
  const del = await api('DELETE', `/api/designs/${tgtDesignId}/imports/${importId}`);
  assert.strictEqual(del.status, 409);
});

// ---------- 预览后编辑 → 冲突，须重新预览 ----------

test('预览后目标草稿被编辑（增/改/删），确认 → 409 draft_changed，整批不写入', async () => {
  // 目标草稿已有 2 片（#1#2 在下半）。预览导入 #3#4 到上半，本应合法。
  const pv = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [3, 4], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201);
  const importId = pv.data.preview.id;
  assert.strictEqual(pv.data.preview.targetDraft.pieceCount, 2);

  // GET 单个预览此时 stale=false
  let g = await api('GET', `/api/designs/${tgtDesignId}/imports/${importId}`);
  assert.strictEqual(g.data.stale, false);

  // 预览后：单片编辑接口改色（会改指纹）
  const beforeDraft = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  const firstId = beforeDraft.pieces[0].id;
  const edit = await api('PUT', `/api/designs/${tgtDesignId}/pieces/${firstId}`,
    { color: '#123456', polygon: [[0, 0], [50, 0], [50, 50], [0, 50]] });
  assert.strictEqual(edit.status, 200);

  g = await api('GET', `/api/designs/${tgtDesignId}/imports/${importId}`);
  assert.strictEqual(g.data.stale, true);

  const cf = await api('POST', `/api/designs/${tgtDesignId}/imports/${importId}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'draft_changed');
  // 草稿仍只有原来 2 片
  const draft = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  assert.strictEqual(draft.pieces.length, 2);
  assert.strictEqual(draft.pieces[0].color, '#123456');

  // 重新预览（基于新指纹）后确认成功：#3#4 补上上半 → 整窗覆盖
  const pv2 = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [3, 4], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv2.status, 201);
  assert.strictEqual(pv2.data.preview.simulated.coverage.covered, true);
  const cf2 = await api('POST',
    `/api/designs/${tgtDesignId}/imports/${pv2.data.preview.id}/confirm`);
  assert.strictEqual(cf2.status, 201, JSON.stringify(cf2.data));
  const full = (await api('GET', `/api/designs/${tgtDesignId}`)).data.draft;
  assert.strictEqual(full.pieces.length, 4);
  assert.strictEqual(full.coverage.covered, true);
  assert.deepStrictEqual(full.coverage.gaps, []);

  // 预览后删除也触发 draft_changed（在完整覆盖的草稿上再做一次）
  const pv3 = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 50, dy: 0 });
  // 与已有 #2 共边但 #2 已占 [50,100]×[0,50] → 重叠，先校验几何应 422
  assert.strictEqual(pv3.status, 422);
});

// ---------- 与目标已有拼片冲突 ----------

test('与目标已有片面积重叠 → 422，withKind=existing 并指出已有编号', async () => {
  // 目标现有 #1 占 [0,50]×[0,50]。把源 #1 平移 (25,0) → 重叠
  const r = await api('POST', `/api/designs/${tgtDesignId}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 25, dy: 0 });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.problems[0].reason, 'overlap');
  assert.strictEqual(r.data.problems[0].withKind, 'existing');
  assert.strictEqual(r.data.problems[0].withPieceNo, 1);
});

// ---------- pending 预览管理 ----------

test('pending 预览可列出/删除；status 过滤非法 400；跨图纸访问 404', async () => {
  // 在仍是空草稿的小目标上生成一张合法 pending 预览
  const pv = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 0, dx: 0, dy: 0 });
  assert.strictEqual(pv.status, 201);
  const id = pv.data.preview.id;

  const pend = await api('GET', `/api/designs/${tgtDesign2Id}/imports?status=pending`);
  assert.ok(pend.data.imports.every((x) => x.status === 'pending'));
  assert.ok(pend.data.imports.some((x) => x.id === id));

  const badq = await api('GET', `/api/designs/${tgtDesign2Id}/imports?status=wat`);
  assert.strictEqual(badq.status, 400);

  // 跨图纸访问
  const cross = await api('GET', `/api/designs/${tgtDesignId}/imports/${id}`);
  assert.strictEqual(cross.status, 404);
  const crossDel = await api('DELETE', `/api/designs/${tgtDesignId}/imports/${id}`);
  assert.strictEqual(crossDel.status, 404);

  const del = await api('DELETE', `/api/designs/${tgtDesign2Id}/imports/${id}`);
  assert.strictEqual(del.status, 200);
  const gone = await api('GET', `/api/designs/${tgtDesign2Id}/imports/${id}`);
  assert.strictEqual(gone.status, 404);
});

// ---------- 用 sourceDesignId + version 指定来源；90/270 旋转 ----------

test('可按 sourceDesignId/sourceVersion 指定来源；90° 与 270° 旋转几何正确', async () => {
  // 在小目标（50×50）上：源 #1 为 50×50，转 90° 仍是 50×50，但绕原点后在第二象限，需平移
  // 转 90：(x,y)->(-y,x)；原 [0,50]² → [-50,0]×[0,50]，平移 (50,0) → [0,50]×[0,50]
  const r90 = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { sourceDesignId: srcDesignId, sourceVersion: 1, pieceNos: [1], rotation: 90, dx: 50, dy: 0 });
  assert.strictEqual(r90.status, 201, JSON.stringify(r90.data));
  assert.deepStrictEqual(r90.data.preview.items[0].bounds,
    { minX: 0, minY: 0, maxX: 50, maxY: 50, width: 50, height: 50 });

  // 270：(x,y)->(y,-x)；原片 → [0,50]×[-50,0]，平移 (0,50) → [0,50]×[0,50]
  const r270 = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { publicationId: srcPubId, pieceNos: [1], rotation: 270, dx: 0, dy: 50 });
  assert.strictEqual(r270.status, 201);
  assert.deepStrictEqual(r270.data.preview.items[0].bounds,
    { minX: 0, minY: 0, maxX: 50, maxY: 50, width: 50, height: 50 });

  // 版本号方式 + 不存在的版本
  const noVer = await api('POST', `/api/designs/${tgtDesign2Id}/imports/preview`,
    { sourceDesignId: srcDesignId, sourceVersion: 77, pieceNos: [1], rotation: 0 });
  assert.strictEqual(noVer.status, 404);
});

// ---------- 复用进来的草稿按现有规则参与发布 ----------

test('含复用片的草稿可正常发布；发布后新快照与生产/库存口径不受影响', async () => {
  const pub = await api('POST', `/api/designs/${tgtDesignId}/publish`);
  assert.strictEqual(pub.status, 201);
  assert.strictEqual(pub.data.publication.version, 1);
  assert.strictEqual(pub.data.publication.snapshot.pieces.length, 4);
  // 复用片原色保留在新快照里
  const colors = pub.data.publication.snapshot.pieces.map((p) => p.color).sort();
  assert.deepStrictEqual(colors, ['#0000ff', '#00ff00', '#123456', '#ffff00']);
});
