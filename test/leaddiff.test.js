'use strict';

const { test } = require('node:test');
const assert = require('assert');
const D = require('../src/leaddiff');

// 构造发布快照：internalRuns 为 [[[x,y],[x,y]], ...]（也可含中间 T 接点）
function snapshot(W, H, internalRuns) {
  return {
    name: '测试窗',
    width: W,
    height: H,
    leadList: {
      internal: internalRuns.map((pts, i) => ({
        no: i + 1,
        points: pts,
        length: Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]),
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

const diff = (a, b, W = 100, H = 100) =>
  D.diffPublications({ version: 1, snapshot: snapshot(W, H, a) }, { version: 2, snapshot: snapshot(W, H, b) });

test('完全相同（同版比较）：全部沿用，无取消/新增', () => {
  const runs = [[[0, 10], [100, 10]], [[50, 10], [50, 90]]];
  const r = diff(runs, runs);
  assert.ok(r.ok);
  const c = r.comparison;
  // 总计数含内部公共边 + 四根外框（2 + 4 = 6 沿用）
  assert.deepStrictEqual(c.counts, { kept: 6, removed: 0, added: 0 });
  assert.deepStrictEqual(c.internal.counts, { kept: 2, removed: 0, added: 0 });
  assert.strictEqual(c.internal.totals.kept, 180);
  assert.strictEqual(c.internal.totals.removed, 0);
  assert.strictEqual(c.internal.totals.added, 0);
  // 外框全部沿用
  for (const side of D.FRAME_SIDES) {
    assert.strictEqual(c.frame[side].counts.kept, 1);
    assert.strictEqual(c.frame[side].counts.removed, 0);
    assert.strictEqual(c.frame[side].counts.added, 0);
  }
});

test('反向记录不产生虚假差异', () => {
  const r = diff([[[10, 20], [90, 20]]], [[[90, 20], [10, 20]]]);
  assert.deepStrictEqual(r.comparison.internal.counts, { kept: 1, removed: 0, added: 0 });
  // 输出方向确定性（参数轴升序：水平线 y=20 沿 +x）
  const kept = r.comparison.internal.kept[0];
  assert.deepStrictEqual(kept.from, [10, 20]);
  assert.deepStrictEqual(kept.to, [90, 20]);
  assert.strictEqual(kept.length, 80);
});

test('清单顺序变化不产生虚假差异', () => {
  const a = [[[0, 10], [100, 10]], [[0, 20], [100, 20]], [[0, 30], [100, 30]]];
  const b = [a[2], a[0], a[1]]; // 重排，编号不同
  const r = diff(a.map((p) => p.map((q) => q.slice())), b.map((p) => p.map((q) => q.slice())));
  assert.deepStrictEqual(r.comparison.internal.counts, { kept: 3, removed: 0, added: 0 });
  assert.strictEqual(r.comparison.internal.totals.kept, 300);
});

test('T 接处分段变化（一侧整边、另一侧两段）不产生虚假差异', () => {
  const one = [[[50, 0], [50, 100]]];
  const two = [[[50, 0], [50, 40]], [[50, 40], [50, 100]]];
  // 正向、反向混合
  const twoRev = [[[50, 100], [50, 40]], [[50, 40], [50, 0]]];
  for (const b of [two, twoRev]) {
    const r1 = diff(one, b);
    assert.deepStrictEqual(r1.comparison.internal.counts, { kept: 1, removed: 0, added: 0 });
    const r2 = diff(b, one);
    assert.deepStrictEqual(r2.comparison.internal.counts, { kept: 1, removed: 0, added: 0 });
  }
});

test('部分重叠：在重叠边界拆分沿用/取消/新增', () => {
  // v1: y=10, x 20..80；v2: y=10, x 50..100（反向记录）
  const r = diff([[[20, 10], [80, 10]]], [[[100, 10], [50, 10]]]);
  const c = r.comparison.internal;
  assert.strictEqual(c.kept.length, 1);
  assert.deepStrictEqual([c.kept[0].from, c.kept[0].to], [[50, 10], [80, 10]]);
  assert.strictEqual(c.kept[0].length, 30);
  assert.strictEqual(c.removed.length, 1);
  assert.deepStrictEqual([c.removed[0].from, c.removed[0].to], [[20, 10], [50, 10]]);
  assert.strictEqual(c.removed[0].length, 30);
  assert.strictEqual(c.added.length, 1);
  assert.deepStrictEqual([c.added[0].from, c.added[0].to], [[80, 10], [100, 10]]);
  assert.strictEqual(c.added[0].length, 20);
  assert.deepStrictEqual(c.totals, { kept: 30, removed: 30, added: 20 });
});

test('分段缩短（两段合并后再比）：取消两端、沿用中段', () => {
  const a = [[[30, 0], [30, 40]], [[30, 40], [30, 100]]]; // 合并为 0..100
  const b = [[[30, 20], [30, 90]]];
  const c = diff(a, b).comparison.internal;
  assert.deepStrictEqual(c.totals, { kept: 70, removed: 30, added: 0 });
  assert.strictEqual(c.removed.length, 2);
  assert.deepStrictEqual([c.removed[0].from, c.removed[0].to], [[30, 0], [30, 20]]);
  assert.deepStrictEqual([c.removed[1].from, c.removed[1].to], [[30, 90], [30, 100]]);
});

test('不同直线（平移/改向）各自成段：整条取消 + 整条新增', () => {
  const c = diff([[[0, 50], [40, 50]]], [[[0, 60], [40, 60]]]).comparison.internal;
  assert.deepStrictEqual(c.counts, { kept: 0, removed: 1, added: 1 });
  assert.strictEqual(c.totals.removed, 40);
  assert.strictEqual(c.totals.added, 40);
});

test('斜向线段：长度与拆分正确（勾股 3-4-5）', () => {
  // (0,0)→(30,40) 长 50；较晚版只保留 (15,20)→(30,40) 长 25
  const c = diff([[[0, 0], [30, 40]]], [[[15, 20], [30, 40]]]).comparison.internal;
  assert.strictEqual(c.kept[0].length, 25);
  assert.strictEqual(c.removed[0].length, 25);
  assert.strictEqual(c.totals.kept, 25);
  assert.strictEqual(c.totals.removed, 25);
});

test('同一直线上两段不连续：不能合并掉中间空隙', () => {
  // 较早版 x=40: y 0..30 与 60..100（中间 30..60 无铅条）
  // 较晚版 x=40: y 0..100 整段（中间新增 30..60）
  const a = [[[40, 0], [40, 30]], [[40, 60], [40, 100]]];
  const b = [[[40, 0], [40, 100]]];
  const c = diff(a, b).comparison.internal;
  assert.strictEqual(c.kept.length, 2);
  assert.strictEqual(c.added.length, 1);
  assert.deepStrictEqual([c.added[0].from, c.added[0].to], [[40, 30], [40, 60]]);
  assert.strictEqual(c.added[0].length, 30);
  assert.deepStrictEqual(c.totals, { kept: 70, removed: 0, added: 30 });
});

test('合计先求和再四舍五入到 0.01 mm（各段舍入之和 ≠ 总和）', () => {
  // 方向 (1,1)：单位 sqrt(2)≈1.41421；每段原始 2*sqrt(2)≈2.82843 → 单段显示 2.83
  const a = [[[0, 0], [2, 2]], [[10, 10], [12, 12]]];
  const c = diff(a, []).comparison.internal;
  assert.strictEqual(c.removed.length, 2);
  for (const f of c.removed) assert.strictEqual(f.length, 2.83);
  // 两段各自舍入值之和 = 5.66；2.82843+2.82843=5.65685… → 先求和再舍入 = 5.66（一致）
  // 改用奇数段：3*2.82843=8.48528 → 8.49；而 2.83*3=8.49 恰好仍一致——
  // 取 (1,1) 投影 1 单位：3 段 sqrt(2)≈1.41421 → 单段 1.41，和 4.23；
  // 3*1.41421=4.24264 → 合计 4.24，与“先舍入后求和”明显不同。
});

test('合计先求和再四舍五入（1.41×3 的例子，总和 4.24 而非 4.23）', () => {
  const a = [[[0, 0], [1, 1]], [[10, 10], [11, 11]], [[20, 20], [21, 21]]];
  const c = diff(a, []).comparison.internal;
  assert.strictEqual(c.removed.length, 3);
  for (const f of c.removed) assert.strictEqual(f.length, 1.41);
  assert.strictEqual(c.totals.removed, 4.24, '先求和再四舍五入，而非 1.41×3=4.23');
  // 总长（含四框）：内部取消 4.24，外框沿用 400
  assert.strictEqual(diff(a, []).comparison.totals.removed, 4.24);
});

test('不同窗框（非同图纸）明确报错', () => {
  const r = D.diffPublications(
    { version: 1, snapshot: snapshot(100, 100, []) },
    { version: 2, snapshot: snapshot(100, 90, []) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不属于同一图纸/);
});

test('外框：同图纸四框始终沿用；命名/顺序打乱也不影响', () => {
  const s1 = snapshot(120, 80, []);
  const s2 = snapshot(120, 80, []);
  s2.leadList.frameBars = [...s1.leadList.frameBars].reverse(); // 顺序打乱
  const c = D.diffPublications({ version: 1, snapshot: s1 }, { version: 2, snapshot: s2 }).comparison;
  assert.strictEqual(c.frameTotals.kept, 400);
  assert.strictEqual(c.frameTotals.removed, 0);
  assert.strictEqual(c.frameTotals.added, 0);
  assert.strictEqual(c.frame['上框'].kept[0].length, 120);
  assert.strictEqual(c.frame['左框'].kept[0].length, 80);
});

test('脏快照：缺内部/外框/非法端点均报错', () => {
  const good = snapshot(50, 50, [[[0, 10], [50, 10]]]);
  let bad = JSON.parse(JSON.stringify(good));
  bad.leadList.frameBars.length = 3;
  assert.strictEqual(D.diffPublications({ version: 1, snapshot: good }, { version: 2, snapshot: bad }).ok, false);
  bad = JSON.parse(JSON.stringify(good));
  bad.leadList.internal[0].points[0] = [0.5, 10]; // 超过 0.01？实际 0.5 合法两位内……用更细
  assert.strictEqual(D.diffPublications({ version: 1, snapshot: good }, { version: 2, snapshot: bad }).ok, true);
  bad.leadList.internal[0].points[0] = [0.001, 10];
  assert.strictEqual(D.diffPublications({ version: 1, snapshot: good }, { version: 2, snapshot: bad }).ok, false);
});
