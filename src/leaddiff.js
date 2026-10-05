'use strict';

// 两版发布快照的铅条下料核对（只读）。
//
// 比较口径是纯几何的：把两版的内部公共边（以及每一根外框）放到同一根
// “无向直线”上，用沿直线的参数区间表示其空间覆盖：
//   - 两版区间重叠的部分        => 沿用（kept）
//   - 仅较早版覆盖的部分        => 取消（removed）
//   - 仅较晚版覆盖的部分        => 新增（added）
// 比较前先做两件归一，因此以下记录差异不会产生虚假差异：
//   1) 直线与方向归一（无向）：端点反向记录、清单顺序不同都得到同一分组；
//   2) 同版区间先按几何合并：T 接处一侧整边、另一侧数段等“分段变化”
//      只要空间覆盖相同就完全抵消，部分重叠则在重叠边界处拆成原子段。
//
// 快照端点均为整数毫米坐标（内部合并段端点是顶点；外框为窗框角），统一放大
// 100 倍后，直线分组（Ax+By=C 整除归一）与区间运算全部是精确整数运算；
// 段长为欧氏长度（水平/竖直为精确值，斜向含根号），各类合计先求和再
// 四舍五入到 0.01 mm。

const { round2 } = require('./geometry');

const H = 100; // 1 mm = 100（0.01 mm 的整数倍）
const FRAME_SIDES = ['上框', '下框', '左框', '右框'];

// ---------- 基础 ----------

function gcdAbs(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function toHundredths(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: `${what}必须是数字（毫米）` };
  }
  const h = v * H;
  if (Math.abs(h - Math.round(h)) > 1e-6) {
    return { error: `${what}坐标精度不得超过 0.01 mm` };
  }
  return { n: Math.round(h) };
}

function toHPoint(p, what) {
  if (!Array.isArray(p) || p.length !== 2) return { error: `${what}端点必须是 [x, y]` };
  const x = toHundredths(p[0], `${what} x`);
  if (x.error) return x;
  const y = toHundredths(p[1], `${what} y`);
  if (y.error) return y;
  return { p: [x.n, y.n] };
}

const hToMm = (n) => round2(n / H);

// 无向直线归一：过整数点 p1,p2 => Ax+By=C，其中 (A,B)=(dy,-dx)。
// 约去 gcd 并固定 (A,B) 首个非零分量为正后，同一条直线（含反向记录）
// 在任意版本都得到同一个 key。
function canonicalLine(x1, y1, x2, y2) {
  let A = y2 - y1;
  let B = x1 - x2;
  let C = A * x1 + B * y1;
  const g = gcdAbs(gcdAbs(A, B), C) || 1;
  A /= g; B /= g; C /= g;
  if (A < 0 || (A === 0 && B < 0)) { A = -A; B = -B; C = -C; }
  return { A, B, C, key: `${A},${B},${C}` };
}

// 直线上确定性的参数轴方向：(A,B) 顺时针转 90° 得 (B,-A)，再固定首个
// 非零分量为正。因 gcd(A,B)=1，它本身就是本原整数向量。两版同 key 必同向，
// 因此端点顺序、反向记录不影响结果。
function axisDir(line) {
  let vx = line.B;
  let vy = -line.A;
  if (vx < 0 || (vx === 0 && vy < 0)) { vx = -vx; vy = -vy; }
  return { vx, vy };
}

// 直线排序键：按轴方向在半圆 [0,π) 的倾角，再按截距 C。
function lineAngle(line, axis) {
  let a = Math.atan2(axis.vy, axis.vx);
  if (a < 0) a += Math.PI;
  return a;
}

// ---------- 快照取段 ----------

// 返回 { segments: [{a:[hx,hy], b:[hx,hy], no?}] } 或 { error }
function extractInternal(snapshot) {
  const ll = snapshot && snapshot.leadList;
  if (!ll) return { error: '发布快照缺少铅条清单（leadList）' };
  if (!Array.isArray(ll.internal)) return { error: '发布快照铅条清单缺少 internal（内部公共边）' };
  const segments = [];
  for (const r of ll.internal) {
    const label = `内部公共边 #${r?.no ?? '?'}`;
    if (!Array.isArray(r.points) || r.points.length < 2) {
      return { error: `${label} 缺少 points 端点序列` };
    }
    const a = toHPoint(r.points[0], `${label} 起点`);
    if (a.error) return a;
    const b = toHPoint(r.points[r.points.length - 1], `${label} 终点`);
    if (b.error) return b;
    if (a.p[0] === b.p[0] && a.p[1] === b.p[1]) return { error: `${label} 长度为 0` };
    // 起终点必须真的落在由其定义的直线上（整数坐标下恒成立，防御脏快照）
    segments.push({ a: a.p, b: b.p });
  }
  return { segments };
}

// 返回 { segments: [{a,b,side}] }（按 上/下/左/右 顺序）或 { error }
function extractFrame(snapshot) {
  const ll = snapshot && snapshot.leadList;
  if (!ll) return { error: '发布快照缺少铅条清单（leadList）' };
  if (!Array.isArray(ll.frameBars) || ll.frameBars.length !== 4) {
    return { error: '发布快照铅条清单应含四根外框（frameBars）' };
  }
  const wR = toHundredths(Number(snapshot.width), '窗框宽');
  if (wR.error) return wR;
  const hR = toHundredths(Number(snapshot.height), '窗框高');
  if (hR.error) return hR;
  const wH = wR.n;
  const hH = hR.n;
  if (wH <= 0 || hH <= 0) return { error: '发布快照窗框宽高非法' };

  const bySide = new Map();
  for (const bar of ll.frameBars) {
    const ar = toHPoint(bar?.from, '外框起点');
    if (ar.error) return ar;
    const br = toHPoint(bar?.to, '外框终点');
    if (br.error) return br;
    const a = ar.p;
    const b = br.p;
    let side = null;
    if (a[1] === b[1]) {
      if (a[1] === 0 && Math.min(a[0], b[0]) === 0 && Math.max(a[0], b[0]) === wH) side = '上框';
      else if (a[1] === hH && Math.min(a[0], b[0]) === 0 && Math.max(a[0], b[0]) === wH) side = '下框';
    } else if (a[0] === b[0]) {
      if (a[0] === 0 && Math.min(a[1], b[1]) === 0 && Math.max(a[1], b[1]) === hH) side = '左框';
      else if (a[0] === wH && Math.min(a[1], b[1]) === 0 && Math.max(a[1], b[1]) === hH) side = '右框';
    }
    if (!side) {
      return { error: `外框段位置非法：(${a.map(hToMm).join(',')})→(${b.map(hToMm).join(',')})，应为窗框四边之一` };
    }
    if (bySide.has(side)) return { error: `外框“${side}”出现不止一次` };
    bySide.set(side, { a, b, side });
  }
  for (const side of FRAME_SIDES) {
    if (!bySide.has(side)) return { error: `外框缺少“${side}”` };
  }
  return { segments: FRAME_SIDES.map((side) => bySide.get(side)), wH, hH };
}

// ---------- 直线分组与区间核对 ----------

// 段集合按无向直线分组；每组记录该直线上的参数区间与端点坐标映射。
function groupByLine(segments) {
  const groups = new Map();
  for (const s of segments) {
    const line = canonicalLine(s.a[0], s.a[1], s.b[0], s.b[1]);
    let g = groups.get(line.key);
    if (!g) {
      const axis = axisDir(line);
      g = { line, axis, segs: [], pointByS: new Map() };
      groups.set(line.key, g);
    }
    const t = (p) => p[0] * g.axis.vx + p[1] * g.axis.vy;
    const t1 = t(s.a);
    const t2 = t(s.b);
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (hi <= lo) continue; // 防御零长
    g.segs.push({ lo, hi });
    // 同参数同点（整数精确）；区间端点来自原段端点
    if (!g.pointByS.has(t1)) g.pointByS.set(t1, s.a);
    if (!g.pointByS.has(t2)) g.pointByS.set(t2, s.b);
  }
  return groups;
}

// 同版同线区间合并：相接（T 接分段）或重叠（同侧重叠不会在合法快照出现）
// 的区间并为一段；不同区间之间的空隙保留。
function mergeIntervals(segs) {
  const sorted = segs.slice().sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.lo <= last.hi) last.hi = Math.max(last.hi, iv.hi);
    else out.push({ lo: iv.lo, hi: iv.hi });
  }
  return out;
}

// 两组已合并区间的对称差：以双方所有端点切成原子区间，按覆盖归类。
function diffIntervals(A, B) {
  const bounds = new Set();
  for (const iv of A) { bounds.add(iv.lo); bounds.add(iv.hi); }
  for (const iv of B) { bounds.add(iv.lo); bounds.add(iv.hi); }
  const xs = [...bounds].sort((u, v) => u - v);
  const covers = (ivs, lo, hi) => ivs.some((iv) => iv.lo <= lo && hi <= iv.hi);
  const kept = [];
  const removed = [];
  const added = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const lo = xs[i];
    const hi = xs[i + 1];
    if (hi <= lo) continue;
    const inA = covers(A, lo, hi);
    const inB = covers(B, lo, hi);
    if (inA && inB) kept.push({ lo, hi });
    else if (inA) removed.push({ lo, hi });
    else if (inB) added.push({ lo, hi });
  }
  return { kept, removed, added };
}

function emptyBucket() {
  return { kept: [], removed: [], added: [] };
}

// 把一个直线分组对（较早/较晚，缺省为空）核对为带坐标的结果段。
function diffLinePair(ga, gb, extra = {}) {
  const g0 = ga || gb;
  const ivA = ga ? mergeIntervals(ga.segs) : [];
  const ivB = gb ? mergeIntervals(gb.segs) : [];
  const parts = diffIntervals(ivA, ivB);
  const pointByS = new Map();
  for (const g of [ga, gb]) {
    if (g) for (const [s, p] of g.pointByS) pointByS.set(s, p);
  }
  const out = emptyBucket();
  for (const kind of ['kept', 'removed', 'added']) {
    // 区间已按端点升序切分，天然沿参数轴从低到高
    out[kind] = parts[kind].map((iv) => {
      const pLo = pointByS.get(iv.lo);
      const pHi = pointByS.get(iv.hi);
      if (!pLo || !pHi) {
        // 理论不可达：原子区间端点必来自某版输入段端点
        throw new Error('核对内部错误：差异段端点无法还原');
      }
      // 长度 = Δt / (100·|v|)：t 是本原整数轴上的投影，|v| 为轴向量长度
      const lenMm = (iv.hi - iv.lo) / (H * Math.hypot(g0.axis.vx, g0.axis.vy));
      return {
        from: [hToMm(pLo[0]), hToMm(pLo[1])],
        to: [hToMm(pHi[0]), hToMm(pHi[1])],
        length: round2(lenMm),
        _raw: lenMm,
        ...extra,
      };
    });
  }
  return { parts: out, line: g0.line, axis: g0.axis };
}

// 汇总桶：先求和（用未四舍五入的原始长度），再四舍五入到 0.01 mm
function summarize(bucket) {
  const totals = {};
  const counts = {};
  for (const kind of ['kept', 'removed', 'added']) {
    const raw = bucket[kind].reduce((s, f) => s + f._raw, 0);
    totals[kind] = round2(raw);
    counts[kind] = bucket[kind].length;
  }
  return { totals, counts };
}

const stripRaw = (f) => ({ from: f.from, to: f.to, length: f.length, ...(f.side ? { side: f.side } : {}) });

// ---------- 顶层 ----------

// 比较两个发布快照。earlier/later 为发布对象（含 version 与 snapshot）。
// 返回 { ok:true, comparison } 或 { ok:false, error }。
function diffPublications(earlier, later) {
  const sA = earlier && earlier.snapshot;
  const sB = later && later.snapshot;
  if (!sA || !sB) return { ok: false, error: '发布版缺少快照内容' };

  const wA = Number(sA.width);
  const hA = Number(sA.height);
  const wB = Number(sB.width);
  const hB = Number(sB.height);
  if (!Number.isInteger(wA) || !Number.isInteger(hA) ||
      !Number.isInteger(wB) || !Number.isInteger(hB)) {
    return { ok: false, error: '发布快照缺少合法的整数窗框宽高' };
  }
  if (wA !== wB || hA !== hB) {
    return { ok: false, error: '两版窗框尺寸不同，不属于同一图纸，不能核对铅条' };
  }

  const intA = extractInternal(sA);
  if (intA.error) return { ok: false, error: intA.error };
  const intB = extractInternal(sB);
  if (intB.error) return { ok: false, error: intB.error };

  const frA = extractFrame(sA);
  if (frA.error) return { ok: false, error: frA.error };
  const frB = extractFrame(sB);
  if (frB.error) return { ok: false, error: frB.error };

  // ---- 内部公共边：所有直线分组合并后比较 ----
  const gA = groupByLine(intA.segments);
  const gB = groupByLine(intB.segments);
  const lineKeys = new Set([...gA.keys(), ...gB.keys()]);
  const orderedKeys = [...lineKeys].sort((k1, k2) => {
    const ga = gA.get(k1) || gB.get(k1);
    const gb = gA.get(k2) || gB.get(k2);
    const aa = lineAngle(ga.line, ga.axis);
    const ab = lineAngle(gb.line, gb.axis);
    if (aa !== ab) return aa - ab;
    if (ga.line.A !== gb.line.A) return ga.line.A - gb.line.A;
    if (ga.line.B !== gb.line.B) return ga.line.B - gb.line.B;
    return ga.line.C - gb.line.C;
  });

  const internal = emptyBucket();
  for (const key of orderedKeys) {
    const { parts } = diffLinePair(gA.get(key), gB.get(key));
    for (const kind of ['kept', 'removed', 'added']) {
      internal[kind].push(...parts[kind]);
    }
  }
  const intSum = summarize(internal);

  // ---- 四根外框：每侧一条直线，分别核对（顺序/反向同样归一） ----
  const frame = {};
  const frameAgg = emptyBucket();
  for (const side of FRAME_SIDES) {
    const segsA = frA.segments.filter((s) => s.side === side);
    const segsB = frB.segments.filter((s) => s.side === side);
    const gFA = groupByLine(segsA);
    const gFB = groupByLine(segsB);
    // 每侧每版恰一条；同图纸同尺寸 ⇒ 直线 key 相同
    const key = [...gFA.keys(), ...gFB.keys()][0];
    const { parts } = diffLinePair(gFA.get(key), gFB.get(key), { side });
    const bucket = emptyBucket();
    for (const kind of ['kept', 'removed', 'added']) {
      bucket[kind] = parts[kind];
      frameAgg[kind].push(...parts[kind]);
    }
    const sum = summarize(bucket);
    frame[side] = {
      kept: bucket.kept.map(stripRaw),
      removed: bucket.removed.map(stripRaw),
      added: bucket.added.map(stripRaw),
      counts: sum.counts,
      totals: sum.totals,
    };
  }
  const frameSum = summarize(frameAgg);
  const totalRaw = emptyBucket();
  for (const kind of ['kept', 'removed', 'added']) {
    totalRaw[kind] = [...internal[kind], ...frameAgg[kind]];
  }
  const grand = summarize(totalRaw);

  return {
    ok: true,
    comparison: {
      width: wA,
      height: hA,
      internal: {
        kept: internal.kept.map(stripRaw),
        removed: internal.removed.map(stripRaw),
        added: internal.added.map(stripRaw),
        counts: intSum.counts,
        totals: intSum.totals,
      },
      frame,
      frameOrder: FRAME_SIDES.slice(),
      frameTotals: frameSum.totals,
      frameCounts: frameSum.counts,
      totals: grand.totals,
      counts: grand.counts,
    },
  };
}

module.exports = {
  diffPublications,
  FRAME_SIDES,
  // 导出供测试
  canonicalLine, axisDir, groupByLine, mergeIntervals, diffIntervals,
};
