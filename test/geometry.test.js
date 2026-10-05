'use strict';
const { test } = require('node:test');
const assert = require('assert');
const G = require('../src/geometry');

const FRAME = { width: 100, height: 100 };

test('多边形合法性与自交', () => {
  assert.ok(G.validatePolygon([[0, 0], [10, 0], [10, 10], [0, 10]]).ok, '合法矩形');
  assert.ok(!G.validatePolygon([[0, 0], [10, 10], [0, 10], [10, 0]]).ok, '自交蝴蝶结');
  assert.ok(!G.validatePolygon([[0, 0], [10, 0], [10, 5], [10, 10], [0, 10]]).ok, '相邻共线');
  assert.ok(!G.validatePolygon([[0, 0], [10, 0], [10, 0], [0, 10]]).ok, '重复点/零边');
  assert.ok(G.validatePolygon([[0, 0], [0, 10], [10, 10], [10, 0]]).ok, 'CW 也合法');
});

test('面积与点包含', () => {
  assert.strictEqual(G.polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
  assert.strictEqual(G.polygonArea([[0, 0], [10, 0], [10, 10]]), 50);
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(G.pointInPolygon(5, 5, sq), 1);
  assert.strictEqual(G.pointInPolygon(15, 5, sq), 0);
  assert.strictEqual(G.pointInPolygon(10, 5, sq), 2);
});

test('线段关系分类', () => {
  assert.strictEqual(G.segmentRelation([0, 0], [10, 10], [0, 10], [10, 0]).kind, 'proper');
  assert.strictEqual(G.segmentRelation([0, 0], [10, 0], [5, 0], [15, 0]).kind, 'collinear');
  assert.strictEqual(G.segmentRelation([0, 0], [10, 0], [10, 0], [10, 10]).kind, 'touch');
  assert.strictEqual(G.segmentRelation([0, 0], [10, 0], [20, 0], [30, 0]).kind, 'none');
});

test('片间：合法相邻与 T 接分段', () => {
  const left = [[0, 0], [50, 0], [50, 100], [0, 100]];
  const right = [[50, 0], [100, 0], [100, 100], [50, 100]];
  assert.ok(G.checkAgainstPieces(left, [{ id: 2, polygon: right }], FRAME).ok, '相邻整边合法');
  // 一侧整边、另一侧两段
  const rt1 = [[50, 0], [100, 0], [100, 60], [50, 40]];
  const rt2 = [[50, 40], [100, 60], [100, 100], [50, 100]];
  assert.ok(G.checkAgainstPieces(rt1, [{ id: 1, polygon: left }, { id: 3, polygon: rt2 }], FRAME).ok);
  assert.ok(G.checkAgainstPieces(rt2, [{ id: 1, polygon: left }, { id: 2, polygon: rt1 }], FRAME).ok);
  // 仅顶点接触合法
  assert.ok(G.checkAgainstPieces([[0, 0], [50, 0], [50, 50]],
    [{ id: 2, polygon: [[50, 50], [100, 50], [100, 100], [50, 100]] }], FRAME).ok);
});

test('片间：重叠与越界拒绝并定位', () => {
  const bad = G.checkAgainstPieces([[0, 0], [51, 0], [51, 100], [0, 100]],
    [{ id: 2, polygon: [[50, 0], [100, 0], [100, 100], [50, 100]] }], FRAME);
  assert.ok(!bad.ok && bad.at, '重叠拒绝并带位置');
  const sameSide = G.checkAgainstPieces([[0, 0], [100, 0], [100, 10], [0, 10]],
    [{ id: 2, polygon: [[0, 5], [100, 5], [100, 15], [0, 15]] }], FRAME);
  assert.ok(!sameSide.ok, '共线同侧重叠拒绝');
  const t = G.checkAgainstPieces([[0, 0], [60, 0], [60, 60], [0, 60]],
    [{ id: 2, polygon: [[50, 50], [70, 50], [70, 70], [50, 70]] }], FRAME);
  assert.ok(!t.ok, '顶点穿入拒绝');
  const out = G.checkAgainstPieces([[0, 0], [101, 0], [101, 10], [0, 10]], [], FRAME);
  assert.ok(!out.ok && out.at[0] === 101, '越界拒绝');
});

test('凹多边形：共享凹顶点合法拼接，扎入拒绝', () => {
  const L = [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]];
  const fill = [[50, 50], [100, 50], [100, 100], [50, 100]];
  assert.ok(G.checkAgainstPieces(fill, [{ id: 1, polygon: L }], FRAME).ok, '凹角处拼接合法');
  const tiny = [[50, 50], [60, 50], [60, 60], [50, 60]];
  assert.ok(G.checkAgainstPieces(tiny, [{ id: 1, polygon: L }], FRAME).ok, '凹角外角小方块仅顶点接触');
  const poked = G.checkAgainstPieces([[40, 60], [60, 60], [50, 80]],
    [{ id: 1, polygon: L }], FRAME);
  assert.ok(!poked.ok, '三角形扎入凹角拒绝');
});

test('全覆盖分析与铅条合并（分段公共边只计一次）', () => {
  const left = [[0, 0], [50, 0], [50, 100], [0, 100]];
  const right = [[50, 0], [100, 0], [100, 100], [50, 100]];
  const full = G.analyzePlan(FRAME, [{ id: 1, polygon: left }, { id: 2, polygon: right }]);
  assert.ok(full.covered);
  assert.strictEqual(full.leadRuns.count, 1);
  assert.strictEqual(full.leadRuns.runs[0].length, 100);
  assert.strictEqual(full.leadRuns.total, 100);
  assert.strictEqual(full.frameLead.total, 400);

  // T 接：公共铅条一条 100；另有斜边
  const rt1 = [[50, 0], [100, 0], [100, 60], [50, 40]];
  const rt2 = [[50, 40], [100, 60], [100, 100], [50, 100]];
  const tp = G.analyzePlan(FRAME, [
    { id: 1, polygon: left }, { id: 2, polygon: rt1 }, { id: 3, polygon: rt2 }]);
  assert.ok(tp.covered);
  assert.ok(tp.leadRuns.runs.find((r) => r.length === 100), '分段公共边合并为一条 100mm');
  assert.strictEqual(tp.leadRuns.count, 2, '另含斜边公共边');
  assert.ok(Math.abs(tp.leadRuns.total - G.round2(100 + Math.hypot(50, 20))) <= 0.01);

  // 对角线 100√2 四舍五入到 141.42
  const d = G.analyzePlan(FRAME, [
    { id: 1, polygon: [[0, 0], [100, 0], [100, 100]] },
    { id: 2, polygon: [[0, 0], [100, 100], [0, 100]] }]);
  assert.ok(d.covered);
  assert.strictEqual(d.leadRuns.runs[0].length, 141.42);
});

test('缺口检测与面积', () => {
  // L 缺口
  const gapPlan = G.analyzePlan(FRAME, [
    { id: 1, polygon: [[0, 0], [100, 0], [100, 50], [0, 50]] },
    { id: 2, polygon: [[0, 50], [50, 50], [50, 100], [0, 100]] }]);
  assert.ok(!gapPlan.covered && gapPlan.gaps.length === 1);
  assert.strictEqual(gapPlan.gaps[0].area, 2500);
  // 角片 → 缺口 7500
  const corner = G.analyzePlan(FRAME, [{ id: 1, polygon: [[0, 0], [50, 0], [50, 50], [0, 50]] }]);
  assert.ok(!corner.covered && corner.gaps[0].area === 7500);
  // 空框
  const empty = G.analyzePlan(FRAME, []);
  assert.ok(!empty.covered && empty.gaps[0].area === 10000);
  // 凹多边形 + 邻片全覆盖
  const L = [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]];
  const fill = [[50, 50], [100, 50], [100, 100], [50, 100]];
  const cv = G.analyzePlan(FRAME, [{ id: 1, polygon: L }, { id: 2, polygon: fill }]);
  assert.ok(cv.covered);
});

test('含洞缺口：孤岛片产生外环+洞环，净面积正确', () => {
  const island = G.analyzePlan(FRAME, [{ id: 1, polygon: [[30, 30], [70, 30], [70, 70], [30, 70]] }]);
  assert.ok(!island.covered);
  assert.strictEqual(island.gaps.length, 1);
  assert.strictEqual(island.gaps[0].area, 8400, '10000-1600');
  assert.strictEqual(island.gaps[0].holes.length, 1, '岛片边界形成洞环');
  // 两个孤岛：同一缺口外环比两个洞
  const two = G.analyzePlan(FRAME, [
    { id: 1, polygon: [[10, 10], [30, 10], [30, 30], [10, 30]] },
    { id: 2, polygon: [[70, 70], [90, 70], [90, 90], [70, 90]] }]);
  assert.strictEqual(two.gaps.length, 1);
  assert.strictEqual(two.gaps[0].holes.length, 2);
  assert.strictEqual(two.gaps[0].area, 9200);
  // 全覆盖时无缺口无洞
  const full = G.analyzePlan(FRAME, [{ id: 1, polygon: [[0, 0], [100, 0], [100, 100], [0, 100]] }]);
  assert.ok(full.covered && full.gaps.length === 0);
});

test('四舍五入到 0.01', () => {
  assert.strictEqual(G.round2(1.005), 1.01);
  assert.strictEqual(G.round2(141.421356), 141.42);
});
