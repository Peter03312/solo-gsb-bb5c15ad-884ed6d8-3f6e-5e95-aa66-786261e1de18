'use strict';

// 彩色玻璃原片裁片排样算法测试：
// 参数校验、旋转、越板、片间间距（精确整数距离）、确定性、缺色、上限、件次展开。

const test = require('node:test');
const assert = require('assert');
const nest = require('../src/sheetnest');

// 3x2 矩形片铺满 60x60 窗框（30x30 一片，4 片）：红两片对角、绿两片对角
function snapshot4() {
  return {
    width: 60, height: 60,
    pieces: [
      { pieceNo: 1, color: '#ff0000', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] },
      { pieceNo: 2, color: '#ff0000', polygon: [[30, 30], [60, 30], [60, 60], [30, 60]] },
      { pieceNo: 3, color: '#00ff00', polygon: [[30, 0], [60, 0], [60, 30], [30, 30]] },
      { pieceNo: 4, color: '#00ff00', polygon: [[0, 30], [30, 30], [30, 60], [0, 60]] },
    ],
  };
}
const specsBoth = (gw, gh, rw, rh) => new Map([
  ['#ff0000', { width: rw, height: rh }],
  ['#00ff00', { width: gw, height: gh }],
]);

test('参数解析：宽高 1–2000、gap 0–50、件数正整数、颜色 #rrggbb', () => {
  assert.ok(nest.parseSheetBody({ color: '#ABCDEF', width: 1, height: 2000, stock: 0 }).ok);
  assert.strictEqual(nest.parseSheetBody({ color: '#ABCDEF', width: 1, height: 2000, stock: 0 }).params.color, '#abcdef');
  assert.ok(!nest.parseSheetBody({ color: 'red', width: 1, height: 1, stock: 0 }).ok);
  assert.ok(!nest.parseSheetBody({ color: '#abcdef', width: 0, height: 1, stock: 0 }).ok);
  assert.ok(!nest.parseSheetBody({ color: '#abcdef', width: 2001, height: 1, stock: 0 }).ok);
  assert.ok(!nest.parseSheetBody({ color: '#abcdef', width: 1.5, height: 1, stock: 0 }).ok);
  assert.ok(!nest.parseSheetBody({ color: '#abcdef', width: 1, height: 1, stock: -1 }).ok);
  assert.ok(nest.parseNestingParams({ copies: 1, gap: 0 }).ok);
  assert.ok(nest.parseNestingParams({ copies: 10000, gap: 50 }).ok);
  assert.ok(!nest.parseNestingParams({ copies: 0, gap: 0 }).ok);
  assert.ok(!nest.parseNestingParams({ copies: 1, gap: 51 }).ok);
  assert.ok(!nest.parseNestingParams({ copies: 1.5, gap: 0 }).ok);
});

test('旋转 90/180/270：坐标为整数且包围盒归位左下角，不镜像（有向面积同号）', () => {
  const poly = [[0, 0], [10, 0], [10, 30], [0, 20]];
  const area = Math.abs(poly.reduce((s, [x, y], i, a) => {
    const q = a[(i + 1) % a.length]; return s + x * q[1] - q[0] * y;
  }, 0));
  for (const r of [0, 1, 2, 3]) {
    const t = nest.rotateNormalized(poly, r);
    assert.strictEqual(t.rotation, r);
    const b = nest.polygonBounds(t.poly);
    assert.strictEqual(b.minX, 0);
    assert.strictEqual(b.minY, 0);
    for (const [x, y] of t.poly) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.ok(x >= 0 && y >= 0 && x <= t.w && y <= t.h);
    }
    const ta = Math.abs(t.poly.reduce((s, [x, y], i, a) => {
      const q = a[(i + 1) % a.length]; return s + x * q[1] - q[0] * y;
    }, 0));
    assert.strictEqual(ta, area, '旋转不改变面积（镜像也不改面积，但下面用形状点集进一步核对）');
  }
  const r90 = nest.rotateNormalized(poly, 1);
  // 逆时针 90°：(x,y)→(-y,x)，原顶点依次 → (0,0)(0,10)(-30,10)(-20,0)，归位 +(30,0)
  assert.deepStrictEqual(r90.poly, [[30, 0], [30, 10], [0, 10], [10, 0]]);
});

test('排样：同色片贴边/共边允许（gap=0）；间距严格执行（gap>0）', () => {
  // 60x60 板：两片 30x30 同色，gap=0 同板
  let r = nest.nestBySnapshot(snapshot4(), specsBoth(60, 60, 60, 60), 1, 0);
  assert.ok(r.ok);
  const red = r.layout.colors.find((c) => c.color === '#ff0000');
  assert.strictEqual(red.requiredSheets, 1);
  assert.strictEqual(red.sheets[0].placements.length, 2);
  // 两片一个在 (0,0) 一个在 (30,30)（对角相邻，共边合法）
  // gap=1：30+1+30>60，任何两片都放不下同板
  r = nest.nestBySnapshot(snapshot4(), specsBoth(60, 60, 60, 60), 1, 1);
  assert.ok(r.ok);
  for (const c of r.layout.colors) assert.strictEqual(c.requiredSheets, 2, `颜色 ${c.color} 每片一板`);

  // 板 59x59：单片 30x30 放得进，但两片无论并排/上下/对角都需某方向 60 → 每片一板
  r = nest.nestBySnapshot(snapshot4(), specsBoth(59, 59, 60, 60), 1, 0);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.layout.colors.find((c) => c.color === '#00ff00').requiredSheets, 2);
});

test('排样：轮廓距离按实际多边形而非包围盒（斜边可贴近矩形角）', () => {
  // 板 30x30：片 A 左下直角三角 (0,0)(20,0)(0,20)；片 B 10x10 矩形放右上角。
  // 包围盒重叠（A 的 bbox 20x20、B 在 (20,20) 只点接触）；斜边 x+y=20 到 B 最近点 (20,20) 距离=0（点接触）。
  const snap = {
    width: 100, height: 100,
    pieces: [
      { pieceNo: 1, color: '#111111', polygon: [[0, 0], [20, 0], [0, 20]] },
      { pieceNo: 2, color: '#111111', polygon: [[80, 80], [90, 80], [90, 90], [80, 90]] },
    ],
  };
  const r = nest.nestBySnapshot(snap, new Map([['#111111', { width: 30, height: 30 }]]), 1, 0);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.layout.totalSheets, 1, '斜边与矩形角点接触允许同板');
  // gap=1 时点接触不允许 → 两片分板
  const r2 = nest.nestBySnapshot(snap, new Map([['#111111', { width: 30, height: 30 }]]), 1, 1);
  assert.ok(r2.ok);
  assert.strictEqual(r2.layout.totalSheets, 2);
});

test('整数精度：gap 判定无浮点误差（相距正好 gap 与 gap-1 各一）', () => {
  // 两条平行竖边：A 占 x[0,10]，B 左边缘 x=10+g，y 范围相同 → 边距 = g（两矩形不重叠）
  const mk = (g) => {
    const placed = [[[0, 0], [10, 0], [10, 20], [0, 20]]];
    const cand = [[10 + g, 0], [20 + g, 0], [20 + g, 20], [10 + g, 20]];
    return nest.placementValid(cand, placed, 5, 100, 100).ok;
  };
  assert.strictEqual(mk(5), true, '净距恰好 5 合法（>=gap）');
  assert.strictEqual(mk(4), false, '净距 4 < 5 非法');
  assert.strictEqual(mk(6), true);
  // 错开 y 后最近距离是斜线距离：(0,3) 直角三角，gap=5 时 5 合法、4 非法
  const mkDiag = (dx, dy) => {
    const placed = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
    const cand = [[10 + dx, 10 + dy], [20 + dx, 10 + dy], [20 + dx, 20 + dy], [10 + dx, 20 + dy]];
    return nest.placementValid(cand, placed, 5, 100, 100).ok;
  };
  assert.strictEqual(mkDiag(3, 4), true, '斜向最近距离 5 合法（精确，无浮点误判）');
  assert.strictEqual(mkDiag(3, 3), false, '斜向最近距离 √18 ≈ 4.24 < 5 非法');
});

test('越板：必须完全在板内，允许贴边', () => {
  const placed = [];
  assert.ok(nest.placementValid([[0, 0], [10, 0], [10, 10], [0, 10]], placed, 0, 10, 10).ok);
  assert.strictEqual(nest.placementValid([[0, 0], [11, 0], [11, 10], [0, 10]], placed, 0, 10, 10).reason, 'out_of_sheet');
  assert.strictEqual(nest.placementValid([[-1, 0], [10, 0], [10, 10], [-1, 10]], placed, 0, 10, 10).reason, 'out_of_sheet');
});

test('缺色 / 单片放不下：整单拒绝并给出颜色与片信息', () => {
  let r = nest.nestBySnapshot(snapshot4(), new Map([['#ff0000', { width: 60, height: 60 }]]), 1, 0);
  assert.strictEqual(r.code, 'missing_color');
  assert.strictEqual(r.color, '#00ff00');
  r = nest.nestBySnapshot(snapshot4(), specsBoth(29, 29, 60, 60), 1, 0);
  assert.strictEqual(r.code, 'piece_too_large');
  assert.strictEqual(r.color, '#00ff00');
  assert.strictEqual(r.pieceWidth, 30);
  assert.strictEqual(r.pieceHeight, 30);
  assert.deepStrictEqual(r.layout, undefined);
});

test('旋转可救：10x40 的片在 50x30 板上旋转 90° 放入', () => {
  const snap = { width: 100, height: 100, pieces: [
    { pieceNo: 1, color: '#222222', polygon: [[0, 0], [10, 0], [10, 40], [0, 40]] },
  ] };
  let r = nest.nestBySnapshot(snap, new Map([['#222222', { width: 50, height: 30 }]]), 1, 0);
  assert.ok(r.ok, r.error);
  const p = r.layout.colors[0].sheets[0].placements[0];
  assert.strictEqual(p.rotation, 90);
  // 板 30x30：旋转后 40 宽仍放不下
  r = nest.nestBySnapshot(snap, new Map([['#222222', { width: 30, height: 30 }]]), 1, 0);
  assert.strictEqual(r.code, 'piece_too_large');
});

test('件次展开：copies=N 时片号出现 N 次且件次 1..N；总裁片数随件数增长', () => {
  const r = nest.nestBySnapshot(snapshot4(), specsBoth(200, 200, 200, 200), 3, 0);
  assert.ok(r.ok);
  const all = r.layout.colors.flatMap((c) => c.sheets.flatMap((s) => s.placements));
  assert.strictEqual(all.length, 12);
  for (const no of [1, 2, 3, 4]) {
    const copies = all.filter((p) => p.pieceNo === no).map((p) => p.copy).sort((a, b) => a - b);
    assert.deepStrictEqual(copies, [1, 2, 3]);
  }
});

test('用板上限 60：超出整单拒绝（too_many_sheets），不返回部分方案', () => {
  // 1x1 片（红色），板 1x1 每板一片；件数 61 → 61 张 > 60
  const snap = { width: 1, height: 1, pieces: [
    { pieceNo: 1, color: '#ff0000', polygon: [[0, 0], [1, 0], [1, 1]] },
  ] };
  const r = nest.nestBySnapshot(snap, new Map([['#ff0000', { width: 1, height: 1 }]]), 61, 0);
  assert.strictEqual(r.code, 'too_many_sheets');
  assert.strictEqual(r.totalSheets, 61);
  assert.strictEqual(r.maxSheets, 60);
  assert.ok(!r.layout);
  // 恰好 60 允许
  const ok = nest.nestBySnapshot(snap, new Map([['#ff0000', { width: 1, height: 1 }]]), 60, 0);
  assert.ok(ok.ok);
  assert.strictEqual(ok.layout.totalSheets, 60);
});

test('确定性：相同版本与排样参数多次调用布局逐字节一致', () => {
  const args = [snapshot4(), specsBoth(60, 60, 100, 80), 7, 3];
  const a = JSON.stringify(nest.nestBySnapshot(...args).layout);
  const b = JSON.stringify(nest.nestBySnapshot(...args).layout);
  assert.strictEqual(a, b);
  // 改 gap 必产生不同方案
  const c = JSON.stringify(nest.nestBySnapshot(snapshot4(), specsBoth(60, 60, 100, 80), 7, 4).layout);
  assert.notStrictEqual(a, c);
});

test('放置结果自洽：每片轮廓为旋转+整数平移，坐标在板内，同板两两满足间距', () => {
  const r = nest.nestBySnapshot(snapshot4(), specsBoth(60, 60, 70, 50), 4, 3);
  assert.ok(r.ok, r.error);
  for (const c of r.layout.colors) {
    for (const sheet of c.sheets) {
      for (const p of sheet.placements) {
        assert.ok([0, 90, 180, 270].includes(p.rotation));
        assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
        const b = nest.polygonBounds(p.polygon);
        assert.ok(b.minX >= 0 && b.minY >= 0 && b.maxX <= sheet.width && b.maxY <= sheet.height);
        for (const q of sheet.placements) {
          if (q === p) continue;
          const v = nest.placementValid(p.polygon, [q.polygon], 3, sheet.width, sheet.height);
          assert.ok(v.ok, `同板片 #${p.pieceNo} 与 #${q.pieceNo} 冲突: ${v.reason}`);
        }
      }
    }
  }
});
