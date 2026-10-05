'use strict';

// 1:1 分张打印核心测试：参数校验、行列分页、重叠坐标一致、页数上限、SVG 物理尺寸与内容。

const { test } = require('node:test');
const assert = require('assert');
const ps = require('../src/printsheet');

const snap = (w, h, pieces) => ({
  name: '测试窗', width: w, height: h,
  pieces: pieces || [
    { pieceNo: 1, color: '#ff0000', area: w * h, polygon: [[0, 0], [w, 0], [w, h], [0, h]] },
  ],
});

test('参数校验：纸张/重叠须为正，留白可零', () => {
  assert.ok(ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 0, overlap: 5 }).ok);
  for (const bad of [
    { paperWidth: 0, paperHeight: 297, margin: 10, overlap: 5 },
    { paperWidth: 210, paperHeight: -1, margin: 10, overlap: 5 },
    { paperWidth: 210.5, paperHeight: 297, margin: 10, overlap: 5 },
    { paperWidth: '210', paperHeight: 297, margin: 10, overlap: 5 },
    { paperWidth: 210, paperHeight: 297, margin: -1, overlap: 5 },
    { paperWidth: 210, paperHeight: 297, margin: 10, overlap: 0 },
    { paperWidth: 210, paperHeight: 297, margin: 10, overlap: -3 },
  ]) {
    const r = ps.parseParams(bad);
    assert.strictEqual(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('参数校验：可打印尺寸非正明确拒绝', () => {
  const r = ps.parseParams({ paperWidth: 20, paperHeight: 20, margin: 10, overlap: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'printable_not_positive');
  assert.strictEqual(r.printableWidth, 0);
});

test('参数校验：重叠不小于任一可打印边长明确拒绝', () => {
  let r = ps.parseParams({ paperWidth: 30, paperHeight: 100, margin: 5, overlap: 20 }); // 可打印 20×90
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'overlap_too_large');
  assert.strictEqual(r.printableWidth, 20);
  // 等于可打印边长同样拒绝
  r = ps.parseParams({ paperWidth: 30, paperHeight: 100, margin: 5, overlap: 90 });
  assert.strictEqual(r.code, 'overlap_too_large');
});

test('分页：小于一张内容只出 1 页', () => {
  const p = ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 10, overlap: 15 }).params;
  const L = ps.buildLayout(snap(100, 80), p).layout;
  assert.deepStrictEqual([L.cols, L.rows, L.totalPages], [1, 1, 1]);
  assert.deepStrictEqual(L.pages[0].coverage, { x0: 0, y0: 0, x1: 100, y1: 80, width: 100, height: 80 });
  assert.strictEqual(L.pages[0].seams.length, 0);
});

test('分页：步距=可打印-重叠，末页与前页重叠不少于重叠宽度', () => {
  // 内容 250 宽，可打印 190，重叠 15 → 步距 175；两页覆盖 [0,190] [175,250]
  const p = ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 10, overlap: 15 }).params;
  const L = ps.buildLayout(snap(250, 180), p).layout;
  assert.strictEqual(L.cols, 2);
  assert.strictEqual(L.pages[0].coverage.x1, 190);
  assert.strictEqual(L.pages[1].coverage.x0, 175);
  assert.strictEqual(L.pages[1].coverage.x1, 250);
  // 末页重叠 15 mm（恰好等于指定重叠）
  assert.strictEqual(L.pages[0].coverage.x1 - L.pages[1].coverage.x0, 15);
});

test('分页：二维行列编号自下而上、自左而右', () => {
  // 内容 500×500，可打印 200×200，重叠 40 → 步距 160；ceil((500-40)/160)=3
  const p = ps.parseParams({ paperWidth: 220, paperHeight: 220, margin: 10, overlap: 40 }).params;
  const L = ps.buildLayout(snap(500, 500), p).layout;
  assert.deepStrictEqual([L.cols, L.rows, L.totalPages], [3, 3, 9]);
  const byNo = Object.fromEntries(L.pages.map((pg) => [pg.page, pg]));
  assert.deepStrictEqual([byNo[1].col, byNo[1].row], [1, 1]);
  assert.deepStrictEqual([byNo[3].col, byNo[3].row], [3, 1]);
  assert.deepStrictEqual([byNo[4].col, byNo[4].row], [1, 2]);
  assert.deepStrictEqual([byNo[9].col, byNo[9].row], [3, 3]);
  // 每页四角邻页编号
  assert.strictEqual(byNo[5].seams.find((s) => s.edge === 'left').neighborPage, 4);
  assert.strictEqual(byNo[5].seams.find((s) => s.edge === 'right').neighborPage, 6);
  assert.strictEqual(byNo[5].seams.find((s) => s.edge === 'bottom').neighborPage, 2);
  assert.strictEqual(byNo[5].seams.find((s) => s.edge === 'top').neighborPage, 8);
});

test('重叠带：两页使用完全相同的图纸坐标（含末端夹紧）', () => {
  // 横向 3 列：[0,200][160,360][320,500]，最右重叠 360-320=40（末页可能更宽）
  const p = ps.parseParams({ paperWidth: 220, paperHeight: 220, margin: 10, overlap: 40 }).params;
  const L = ps.buildLayout(snap(500, 100), p).layout;
  const p1 = L.pages[0], p2 = L.pages[1], p3 = L.pages[2];
  const band12a = p1.seams.find((s) => s.edge === 'right').overlap;
  const band12b = p2.seams.find((s) => s.edge === 'left').overlap;
  assert.deepStrictEqual(band12a, band12b);
  assert.deepStrictEqual([band12a.x0, band12a.x1, band12a.width], [160, 200, 40]);
  const band23a = p2.seams.find((s) => s.edge === 'right').overlap;
  const band23b = p3.seams.find((s) => s.edge === 'left').overlap;
  assert.deepStrictEqual(band23a, band23b);
  assert.ok(band23a.width >= 40, '末页重叠不少于指定宽度');
  assert.strictEqual(band23a.x1, 360, '重叠带为两页覆盖交集（末页从 320 起）');
  // 十字标记图纸坐标两页一致
  const c1 = p1.seams.find((s) => s.edge === 'right').crosses;
  const c2 = p2.seams.find((s) => s.edge === 'left').crosses;
  assert.deepStrictEqual(c1, c2);
  for (const cr of c1) {
    assert.ok(cr.x >= band12a.x0 && cr.x <= band12a.x1);
    assert.ok(cr.y >= 0 && cr.y <= 100);
  }
});

test('页数超过 200：拒绝并返回行列数，不输出部分页面', () => {
  // 可打印 40×40，重叠 10，步距 30；ceil(990/30)=33 → 1089 页
  const p = ps.parseParams({ paperWidth: 42, paperHeight: 42, margin: 1, overlap: 10 }).params;
  const r = ps.buildLayout(snap(1000, 1000), p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too_many_pages');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.totalPages, 1089);
  assert.strictEqual(r.maxPages, 200);
});

test('页数边界 200/201：200 允许，超过 200 拒绝且不输出部分页面', () => {
  // 可打印 100×100、重叠 50、步距 50；2 列 × 100 行 = 200：
  // axisCount(150)=2；axisCount(5050)=100（r=99 原点 4950，覆盖到 5050）
  const p = ps.parseParams({ paperWidth: 120, paperHeight: 120, margin: 10, overlap: 50 }).params;
  assert.strictEqual(ps.axisCount(150, 100, 50), 2);
  assert.strictEqual(ps.axisCount(5050, 100, 50), 100);
  const ok = ps.buildLayout(snap(150, 5050), p);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.layout.totalPages, 200);
  // 再加 50mm → 101 行 → 202 页，整单拒绝
  const r = ps.buildLayout(snap(150, 5100), p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too_many_pages');
  assert.strictEqual(r.totalPages, 202);
});

test('SVG：物理尺寸为毫米、含视图盒/裁剪/标尺/编号/外框/拼接信息', () => {
  const s = snap(250, 180, [
    { pieceNo: 1, color: '#ff0000', area: 10000, polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] },
    { pieceNo: 7, color: '#00aa00', area: 35000, polygon: [[100, 0], [250, 0], [250, 180], [100, 180], [100, 100]] },
  ]);
  const p = ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 10, overlap: 15 }).params;
  const L = ps.buildLayout(s, p).layout;
  const pub = { id: 5, designId: 3, version: 2, publishedAt: 't', snapshot: s };
  const svg = ps.pageSvg(pub, p, L.pages[0]);
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /width="210mm" height="297mm"/);
  assert.match(svg, /viewBox="0 0 210 297"/);
  assert.match(svg, /<clipPath[^>]*>[\s\S]*<rect x="10" y="10" width="190" height="277"\/>/);
  assert.match(svg, /毫米校准标尺/);
  assert.match(svg, /#1/);
  assert.match(svg, /第 1\/2 页/);
  assert.match(svg, /与第 2 页拼接/);
  assert.match(svg, /x 0–190/);
  // 外框矩形（250×180 窗框）出现
  assert.match(svg, /<rect x="0" y="0" width="250" height="180"/);
  // 第二页覆盖 x 175–250
  const svg2 = ps.pageSvg(pub, p, L.pages[1]);
  assert.match(svg2, /x 175–250/);
  assert.match(svg2, /与第 1 页拼接/);
});

test('SVG：跨页轮廓被可打印区域裁剪（片顶点超出本页但不产生越界图形）', () => {
  const s = snap(250, 180);
  const p = ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 10, overlap: 15 }).params;
  const L = ps.buildLayout(s, p).layout;
  const pub = { id: 1, designId: 1, version: 1, snapshot: s };
  const svg1 = ps.pageSvg(pub, p, L.pages[0]);
  // 第 1 页可打印右边界纸张坐标 200；250×180 外框越出，但所有图纸内容都在
  // clip-path 组内
  assert.match(svg1, /<g clip-path="url\(#printable-clip\)">/);
});

test('SVG：留白为 0 时标尺仍在页面内且 XML 良构', () => {
  const s = snap(300, 200);
  const p = ps.parseParams({ paperWidth: 210, paperHeight: 297, margin: 0, overlap: 10 }).params;
  const L = ps.buildLayout(s, p).layout;
  const pub = { id: 1, designId: 1, version: 1, snapshot: s };
  const svg = ps.pageSvg(pub, p, L.pages[0]);
  assert.match(svg, /<clipPath[^>]*>[\s\S]*<rect x="0" y="0" width="210" height="297"\/>/);
  assert.match(svg, /毫米校准标尺|毫米标尺/);
  assert.ok(L.totalPages > 1);
});
