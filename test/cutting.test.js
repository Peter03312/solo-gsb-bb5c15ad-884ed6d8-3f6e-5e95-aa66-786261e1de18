'use strict';

const { test } = require('node:test');
const assert = require('assert');
const C = require('../src/cutting');

// 构造一个发布快照：内部公共边 internalRuns（长度 mm，两点），窗框 W×H
function snapshot(W, H, internalRuns) {
  return {
    width: W, height: H,
    leadList: {
      internal: internalRuns.map((r, i) => ({
        no: i + 1,
        points: r.points || [[0, 0], [r.length, 0]],
        length: r.length,
      })),
      internalCount: internalRuns.length,
      frameBars: [
        { name: '上框', from: [0, 0], to: [W, 0], length: W },
        { name: '下框', from: [0, H], to: [W, H], length: W },
        { name: '左框', from: [0, 0], to: [0, H], length: H },
        { name: '右框', from: [W, 0], to: [W, H], length: H },
      ],
    },
  };
}

test('parseLen2：正数/非负/精度/负数', () => {
  assert.deepStrictEqual(C.parseLen2(6000, { positive: true }), { ok: true, h: 600000 });
  assert.deepStrictEqual(C.parseLen2(0.01, { positive: true }), { ok: true, h: 1 });
  assert.ok(!C.parseLen2(0, { positive: true }).ok);
  assert.ok(!C.parseLen2(-0.01, { positive: true }).ok);
  assert.deepStrictEqual(C.parseLen2(0, { positive: false }), { ok: true, h: 0 });
  assert.ok(!C.parseLen2(-1, { positive: false }).ok);
  assert.ok(!C.parseLen2(0.001, { positive: true }).ok, '超过 0.01 精度拒绝');
  assert.ok(!C.parseLen2('abc', {}).ok);
  assert.ok(!C.parseLen2(NaN, {}).ok);
});

test('件数必须正整数、库存非负整数', () => {
  assert.ok(!C.parsePositiveInt(0).ok);
  assert.ok(!C.parsePositiveInt(-1).ok);
  assert.ok(!C.parsePositiveInt(1.5).ok);
  assert.deepStrictEqual(C.parsePositiveInt(3), { ok: true, n: 3 });
  assert.ok(!C.parseNonNegInt(-1).ok);
  assert.deepStrictEqual(C.parseNonNegInt(0), { ok: true, n: 0 });
});

test('只取内部公共边与四根外框，按清单顺序', () => {
  const snap = snapshot(100, 80, [{ length: 60 }]);
  const r = C.segmentsFromSnapshot(snap);
  assert.ok(r.ok);
  assert.strictEqual(r.segments.length, 5);
  assert.strictEqual(r.segments[0].name, '内部公共边 #1');
  assert.strictEqual(r.segments[0].lengthH, 6000);
  assert.deepStrictEqual(r.segments.slice(1).map((s) => s.name), ['上框', '下框', '左框', '右框']);
  assert.deepStrictEqual(r.segments.slice(1).map((s) => s.lengthH), [10000, 10000, 8000, 8000]);
});

test('逐件展开且每段独立（件数 = 段数倍数）', () => {
  const snap = snapshot(100, 100, []);
  const r = C.segmentsFromSnapshot(snap);
  const plan = C.planCuts({ segments: r.segments, copies: 3, stockLenH: 999999, kerfH: 0 });
  assert.ok(plan.ok);
  assert.strictEqual(plan.segmentCount, 12); // 4 段 × 3 件
  const pieces = [...new Set(plan.cuts.map((c) => c.piece))].sort((a, b) => a - b);
  assert.deepStrictEqual(pieces, [1, 2, 3]);
});

test('FFD：长度降序、同长按清单顺序，放入首根可容纳原材', () => {
  // 两根内部边 300、100 + 四框 200×2、150×2；料 400，刀损 0
  const snap = snapshot(200, 150, [{ length: 300 }, { length: 100 }]);
  const r = C.segmentsFromSnapshot(snap);
  const plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 40000, kerfH: 0 });
  assert.ok(plan.ok);
  // 切段顺序：300,200(上),200(下),150(左),150(右),100
  const order = plan.cuts.map((c) => c.lengthH);
  assert.deepStrictEqual(order, [30000, 20000, 20000, 15000, 15000, 10000]);
  // 300→棒1；200→棒1(300+200>400? 500>400)→棒2；200→棒2(=400)；
  // 150→棒1(450>400)→棒3；150→棒1→棒3(300)；100→棒1(=400)
  assert.strictEqual(plan.requiredBars, 3);
  const barLens = plan.bars.map((b) => b.cuts.map((c) => c.lengthH / 100));
  assert.deepStrictEqual(barLens, [[300, 100], [200, 200], [150, 150]]);
  assert.deepStrictEqual(plan.bars.map((b) => b.remainderH / 100), [0, 0, 100]);
});

test('每段占用成品长度加一刀损耗；边界恰好等于定尺可放', () => {
  const snap = snapshot(100, 100, []); // 4×100
  const r = C.segmentsFromSnapshot(snap);
  // 料 201：100+1=101；每根可放 2 段（202>201 不行）→ 每根 1 段，需 4 根
  let plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 20100, kerfH: 100 });
  assert.ok(plan.ok);
  assert.strictEqual(plan.requiredBars, 4);
  assert.ok(plan.bars.every((b) => b.cuts.length === 1));
  // 边界：料 202，2×(100+1)=202 恰好可放 → 2 根
  plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 20200, kerfH: 100 });
  assert.strictEqual(plan.requiredBars, 2);
  assert.ok(plan.bars.every((b) => b.cuts.length === 2));
  // 刀损合计 = 段数 × kerf
  assert.strictEqual(plan.totalKerfH, 4 * 100);
});

test('单段连同刀损放不下 → 拒绝且不产出方案', () => {
  const snap = snapshot(100, 100, []);
  const r = C.segmentsFromSnapshot(snap);
  const plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 15000, kerfH: 6000 });
  assert.ok(!plan.ok);
  assert.strictEqual(plan.code, 'segment_too_long');
  assert.strictEqual(plan.segment.lengthH, 10000);
});

test('0.01mm 精度整数运算：250.02>250.01 不放第二根', () => {
  const snap = snapshot(100, 100, []);
  const r = C.segmentsFromSnapshot(snap);
  // 段100 + 刀损25.01 = 125.01；两根 250.02 > 250.01 → 每根仅 1 段 → 4 根
  const plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 25001, kerfH: 2501 });
  assert.ok(plan.ok);
  assert.strictEqual(plan.requiredBars, 4);
  assert.ok(plan.bars.every((b) => b.cuts.length === 1));
  assert.strictEqual(plan.bars[0].remainderH, 25001 - 12501);
});

test('同长切段保持清单顺序（内部边在四框之前）', () => {
  const snap = snapshot(100, 100, [{ length: 100 }]); // 全部 5 段都 100
  const r = C.segmentsFromSnapshot(snap);
  const plan = C.planCuts({ segments: r.segments, copies: 1, stockLenH: 999999, kerfH: 0 });
  assert.deepStrictEqual(
    plan.cuts.map((c) => `${c.source === 'frame' ? 'F' : 'I'}${c.sourceNo}`),
    ['I1', 'F1', 'F2', 'F3', 'F4'],
  );
});
