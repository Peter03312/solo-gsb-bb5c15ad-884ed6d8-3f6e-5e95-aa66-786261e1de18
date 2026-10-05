'use strict';

// 几何核心：全部拓扑判定基于整数坐标的精确整数运算；交点以精确分数表示。
// 坐标一律为整数毫米。

// ---------- 基础 ----------

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// 有理数点：整数点也统一以分数表示（分母为 1），key 是规范化后的唯一标识。
function rat(v, d = 1) {
  if (d < 0) { v = -v; d = -d; }
  const g = gcdAbs(v, d) || 1;
  return { n: v / g, d: d / g };
}
function gcdAbs(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}
const ratEq = (a, b) => a.n === b.n && a.d === b.d;
const ratToFloat = (r) => r.n / r.d;

function rpoint(xn, xd, yn, yd) {
  const x = rat(xn, xd), y = rat(yn, yd);
  return { x, y, key: `${x.n}/${x.d},${y.n}/${y.d}`, fx: x.n / x.d, fy: y.n / y.d };
}
const intPoint = (x, y) => rpoint(x, 1, y, 1);
const sameRPoint = (p, q) => p.key === q.key;

// 浮点点（平面图分析阶段使用），key 沿用精确 key
const asFloat = (p) => ({ x: p.fx, y: p.fy, key: p.key });

// ---------- 点与多边形（整数） ----------

// 射线法。返回 2=在边界上, 1=内部, 0=外部
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const d1 = yi - py, d2 = yj - py;
    if (((d1 > 0) !== (d2 > 0)) &&
      (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
    // 边界判定：叉积为 0 且坐标在线段包围盒内
    if (cross(xj - xi, yj - yi, px - xi, py - yi) === 0 &&
      Math.min(xi, xj) <= px && px <= Math.max(xi, xj) &&
      Math.min(yi, yj) <= py && py <= Math.max(yi, yj)) {
      return 2;
    }
  }
  return inside ? 1 : 0;
}

function signedArea2x(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return s;
}

// 面积（整数多边形 → 0.01 毫米精度的有限小数，实际为整数或半整数）
function polygonArea(poly) {
  return Math.abs(signedArea2x(poly)) / 2;
}

function ensureCCW(poly) {
  return signedArea2x(poly) > 0 ? poly : poly.slice().reverse();
}

// ---------- 线段关系（整数端点，精确） ----------

// 返回 { kind: 'none' | 'proper' | 'touch' | 'collinear' }
// proper/touch 带 point（有理数点）；collinear 带 overlap:[[a,b],[c,d]] 整数区间端点
function segmentRelation(a, b, c, d) {
  const c1 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const c2 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const c3 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const c4 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);

  if ((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) {
    if ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0)) {
      // 规范相交：P = a + (c3/(c3-c4)) * (b-a)
      const den = c3 - c4;
      const xn = a[0] * den + c3 * (b[0] - a[0]);
      const yn = a[1] * den + c3 * (b[1] - a[1]);
      return { kind: 'proper', point: rpoint(xn, den, yn, den) };
    }
  }
  const onSeg = (p, q, s) =>
    cross(q[0] - p[0], q[1] - p[1], s[0] - p[0], s[1] - p[1]) === 0 &&
    Math.min(p[0], q[0]) <= s[0] && s[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= s[1] && s[1] <= Math.max(p[1], q[1]);

  if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0) {
    // 共线
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = (p) => (Math.abs(dx) >= Math.abs(dy)
      ? (p[0] - a[0]) * Math.sign(dx || dy)
      : (p[1] - a[1]) * Math.sign(dx || dy));
    const pts = [a, b, c, d].map((p) => ({ p, t: t(p) }));
    pts.sort((u, v) => u.t - v.t);
    const lo = Math.max(t(a), t(c));
    const hi = Math.min(t(b), t(d));
    if (hi < lo) return { kind: 'none' };
    // 区间端点必须来自某个输入端点（整数坐标）
    const all = [a, b, c, d];
    const findPt = (tv) => all.find((p) => t(p) === tv);
    const pLo = findPt(lo), pHi = findPt(hi);
    if (lo === hi) return { kind: 'touch', point: rpoint(pLo[0], 1, pLo[1], 1) };
    return { kind: 'collinear', overlap: [pLo, pHi] };
  }

  // 端点相触
  if (onSeg(a, b, c)) return { kind: 'touch', point: rpoint(c[0], 1, c[1], 1) };
  if (onSeg(a, b, d)) return { kind: 'touch', point: rpoint(d[0], 1, d[1], 1) };
  if (onSeg(c, d, a)) return { kind: 'touch', point: rpoint(a[0], 1, a[1], 1) };
  if (onSeg(c, d, b)) return { kind: 'touch', point: rpoint(b[0], 1, b[1], 1) };
  return { kind: 'none' };
}

// ---------- 多边形自交 / 合法性 ----------

// 校验顶点：整数、有限、≥3 点、无重复点、无零边、相邻不共线、不自交
function validatePolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3) {
    return { ok: false, reason: '多边形至少需要 3 个顶点' };
  }
  for (const [x, y] of poly) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { ok: false, reason: '顶点坐标必须是整数毫米', at: [x, y] };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: '顶点坐标不合法', at: [x, y] };
    }
  }
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) {
      return { ok: false, reason: '存在零长度边或重复顶点', at: a.slice() };
    }
    if (i + 1 < n) {
      const c = poly[(i + 2) % n];
      if (cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]) === 0) {
        return { ok: false, reason: '相邻边共线（请合并为一条整边）', at: b.slice() };
      }
    }
  }
  // 完全重复顶点（非相邻）
  const seen = new Map();
  for (const p of poly) {
    const k = p.join(',');
    if (seen.has(k)) return { ok: false, reason: '存在重复顶点', at: p.slice() };
    seen.set(k, true);
  }
  // 边对检查（首尾相邻的一对仅允许在公共端点相触）
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const c = poly[j], d = poly[(j + 1) % n];
      const adjacent = (j === i + 1) || (i === 0 && j === n - 1);
      const rel = segmentRelation(a, b, c, d);
      if (rel.kind === 'proper') {
        return {
          ok: false, reason: '多边形自交（边在内部交叉）',
          at: [rel.point.fx, rel.point.fy], exact: rel.point,
        };
      }
      if (rel.kind === 'collinear') {
        return { ok: false, reason: '多边形自交（边与边重叠）', at: rel.overlap[0].slice(), exact: intPoint(rel.overlap[0][0], rel.overlap[0][1]) };
      }
      if (rel.kind === 'touch') {
        const sharedEnd = adjacent &&
          ((b[0] === c[0] && b[1] === c[1]) || (a[0] === d[0] && a[1] === d[1]));
        if (!sharedEnd) {
          return {
            ok: false, reason: '多边形自交（边在非端点处相触）',
            at: [rel.point.fx, rel.point.fy], exact: rel.point,
          };
        }
      }
    }
  }
  if (signedArea2x(poly) === 0) return { ok: false, reason: '多边形面积为 0' };
  return { ok: true };
}

// ---------- 片与片之间的面积重叠检查 ----------

// 边界中点向两侧微小偏移。所有边端点为整数，中点为整数或半整数，
// 与任何其他整数坐标直线的距离最小也远大于 1e-7，不会误判。
const EPS = 1e-7;

// 顶点处取一个严格位于多边形内部的邻近点（沿相邻两边内移后向内部偏移）。
// 由于坐标为整数，EPS=1e-7 的采样点不可能落在任何其他整数直线上。
function interiorPointNearVertex(poly, idx) {
  const n = poly.length;
  const p = poly[idx];
  const prev = poly[(idx - 1 + n) % n];
  const next = poly[(idx + 1) % n];
  const u = norm([prev[0] - p[0], prev[1] - p[1]]); // 指向 prev 的单位向量
  const v = norm([next[0] - p[0], next[1] - p[1]]); // 指向 next
  // (u+v)/2 沿角平分线方向；凸角时朝内、凹角时朝外，用点在多边形内测试定向
  let s = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  if (Math.hypot(s[0], s[1]) < 1e-12) s = [u[1], -u[0]];
  const q1 = { x: p[0] + s[0] * EPS, y: p[1] + s[1] * EPS };
  const q2 = { x: p[0] - s[0] * EPS, y: p[1] - s[1] * EPS };
  const in1 = pointInPolygon(q1.x, q1.y, poly) === 1;
  const in2 = pointInPolygon(q2.x, q2.y, poly) === 1;
  if (in1 && !in2) return q1;
  if (in2 && !in1) return q2;
  // 理论上不会到达；保险起见退化用边中点偏移
  return q1;
}
const norm = ([x, y]) => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};

// 检查候选片 cand（数组 of [x,y]）与已有片 pieces（{polygon}）是否面积重叠/越界。
// frame: {width, height} 或 null。
// 返回 { ok:true } 或 { ok:false, reason, at:[x,y], pieceId? }
function checkAgainstPieces(cand, pieces, frame) {
  const ccw = ensureCCW(cand);

  // 1) 越界
  if (frame) {
    for (const [x, y] of ccw) {
      if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
        return { ok: false, reason: '顶点越出窗框', at: [x, y] };
      }
    }
    // 边与框边规范相交也算越界（端点在框内时，直线不会穿出框外，
    // 除非整边在框内——故只需查顶点；保留此注释说明完整性）
  }

  for (const pc of pieces) {
    const other = ensureCCW(pc.polygon);

    // 2) 顶点落在对方内部（严格内部，含 T 接端点穿入）
    for (const v of ccw) {
      if (pointInPolygon(v[0], v[1], other) === 1) {
        return { ok: false, reason: '与现有拼片面积重叠（顶点穿入）', at: v.slice(), pieceId: pc.id };
      }
    }
    for (const v of other) {
      if (pointInPolygon(v[0], v[1], ccw) === 1) {
        return { ok: false, reason: '与现有拼片面积重叠（顶点穿入）', at: v.slice(), pieceId: pc.id };
      }
    }

    // 3) 边对检查
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[i], b = ccw[(i + 1) % ccw.length];
      for (let j = 0; j < other.length; j++) {
        const c = other[j], d = other[(j + 1) % other.length];
        const rel = segmentRelation(a, b, c, d);
        if (rel.kind === 'proper') {
          return {
            ok: false, reason: '与现有拼片面积重叠（边交叉）',
            at: [rel.point.fx, rel.point.fy], pieceId: pc.id, exact: rel.point,
          };
        }
        if (rel.kind === 'collinear') {
          // 中点两侧偏移点，分别要求落在另一片内才是合法共享
          const [lo, hi] = rel.overlap;
          const mx = (lo[0] + hi[0]) / 2, my = (lo[1] + hi[1]) / 2;
          const ddx = hi[0] - lo[0], ddy = hi[1] - lo[1];
          const len = Math.hypot(ddx, ddy) || 1;
          const nx = -ddy / len, ny = ddx / len;
          const s1 = pointInPolygon(mx + nx * EPS, my + ny * EPS, other);
          const s2 = pointInPolygon(mx - nx * EPS, my - ny * EPS, other);
          const t1 = pointInPolygon(mx + nx * EPS, my + ny * EPS, ccw);
          const t2 = pointInPolygon(mx - nx * EPS, my - ny * EPS, ccw);
          // 合法：两侧分别在两片内
          if (!((s1 === 1 && t2 === 1) || (s2 === 1 && t1 === 1))) {
            return {
              ok: false, reason: '与现有拼片面积重叠（共边同侧重叠）',
              at: [lo[0], lo[1]], pieceId: pc.id,
            };
          }
        }
        // touch（端点相触）本身合法，真正的“顶点扇区重叠”在第 4 步处理
      }
    }

    // 4) 顶点-顶点接触：两片在公共顶点处内角扇区若面积相交则拒绝
    const byKey = new Map(other.map((p, idx) => [`${p[0]},${p[1]}`, idx]));
    for (let i = 0; i < ccw.length; i++) {
      const p = ccw[i];
      const j = byKey.get(`${p[0]},${p[1]}`);
      if (j === undefined) continue;
      // 两片在公共顶点的内角若有面积相交，则一片内角附近的点必落在另一片内部
      const qa = interiorPointNearVertex(ccw, i);
      const qb = interiorPointNearVertex(other, j);
      if (pointInPolygon(qa.x, qa.y, other) === 1 ||
        pointInPolygon(qb.x, qb.y, ccw) === 1) {
        return {
          ok: false, reason: '与现有拼片面积重叠（顶点处内角相交）',
          at: p.slice(), pieceId: pc.id,
        };
      }
    }
  }
  return { ok: true };
}

// ---------- 平面图分析：缺口检测 + 铅条 ----------

// frame = {width,height}，pieces = [{id, polygon}]
// 返回 { covered, gaps:[{outer,holes,polygon(=outer),area}], overlapping:[...],
//          internalEdges, leadRuns:[{points,length,rawLength}], frameLead, pieces }
// 缺口可为含洞区域（如中间有孤岛片）：outer 为外环，holes 为洞环（CW 采样），
// area 为净面积（外环-洞）。
function analyzePlan(frame, pieces) {
  const W = frame.width, H = frame.height;
  const framePts = [[0, 0], [W, 0], [W, H], [0, H]];

  // 收集所有线段（片边 + 框边）
  const segs = [];
  for (const pc of pieces) {
    const poly = ensureCCW(pc.polygon);
    for (let i = 0; i < poly.length; i++) {
      segs.push({ a: poly[i], b: poly[(i + 1) % poly.length], piece: pc.id });
    }
  }
  for (let i = 0; i < 4; i++) {
    segs.push({ a: framePts[i], b: framePts[(i + 1) % 4], piece: null, frame: true });
  }

  // 收集所有分割节点：端点 + 任意两边的规范交点（合法草稿中交点只能是 T 接点；
  // 为稳健起见仍计算规范交点）
  const nodeMap = new Map();
  const addNode = (rp) => {
    if (!nodeMap.has(rp.key)) nodeMap.set(rp.key, asFloat(rp));
    return rp.key;
  };
  for (const s of segs) {
    s.ak = addNode(intPoint(s.a[0], s.a[1]));
    s.bk = addNode(intPoint(s.b[0], s.b[1]));
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const rel = segmentRelation(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (rel.kind === 'proper') addNode(rel.point);
      if (rel.kind === 'collinear') {
        addNode(intPoint(rel.overlap[0][0], rel.overlap[0][1]));
        addNode(intPoint(rel.overlap[1][0], rel.overlap[1][1]));
      }
      if (rel.kind === 'touch') addNode(rel.point);
    }
  }

  // 点在整数线段内部（浮点比较，分割点与线段严格共线）
  const pointOnSegInner = (p, a, b) => {
    if (Math.abs(cross(b[0] - a[0], b[1] - a[1], p.x - a[0], p.y - a[1])) > 1e-7) return false;
    const dot = (p.x - a[0]) * (b[0] - a[0]) + (p.y - a[1]) * (b[1] - a[1]);
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    return dot > 1e-9 && dot < len2 - 1e-9;
  };

  // 每条线段用其内部分割点切成原子段
  const atomic = new Map(); // key -> {p1key,p2key, pieces:Set, frame, mid:[x,y]}
  const addAtomic = (k1, k2, seg) => {
    if (k1 === k2) return;
    const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    let e = atomic.get(key);
    if (!e) {
      const p1 = nodeMap.get(k1), p2 = nodeMap.get(k2);
      e = {
        key, k1, k2,
        p1, p2,
        pieces: new Set(), frame: false,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        seg: [],
      };
      atomic.set(key, e);
    }
    if (seg.piece != null) e.pieces.add(seg.piece);
    if (seg.frame) e.frame = true;
    e.seg.push(seg);
  };

  for (const s of segs) {
    const inner = [];
    for (const np of nodeMap.values()) {
      if (pointOnSegInner(np, s.a, s.b)) inner.push(np);
    }
    const dir = s.b[0] !== s.a[0]
      ? (s.b[0] > s.a[0] ? [1, 0] : [-1, 0])
      : (s.b[1] > s.a[1] ? [0, 1] : [0, -1]);
    inner.sort((p, q) =>
      (p.x - s.a[0]) * dir[0] + (p.y - s.a[1]) * dir[1] -
      ((q.x - s.a[0]) * dir[0] + (q.y - s.a[1]) * dir[1]));
    let prevKey = s.ak;
    for (const np of inner) { addAtomic(prevKey, np.key, s); prevKey = np.key; }
    addAtomic(prevKey, s.bk, s);
  }

  // 半边：每个原子段产生两条有向半边，按起点角度排序
  const halfEdges = [];
  const outgoing = new Map(); // nodeKey -> [halfEdge index]
  const addHalf = (from, to, edge) => {
    const idx = halfEdges.length;
    halfEdges.push({ from, to, edge, next: -1, visited: false });
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(idx);
    return idx;
  };
  for (const e of atomic.values()) {
    addHalf(e.k1, e.k2, e);
    addHalf(e.k2, e.k1, e);
  }
  for (const [, list] of outgoing) {
    list.sort((i, j) => {
      const hi = halfEdges[i], hj = halfEdges[j];
      const pi = nodeMap.get(hi.from), qi = nodeMap.get(hi.to);
      const pj = nodeMap.get(hj.from), qj = nodeMap.get(hj.to);
      return Math.atan2(qi.y - pi.y, qi.x - pi.x) -
        Math.atan2(qj.y - pj.y, qj.x - pj.x);
    });
  }
  // next：到达 v 后，取到达边反向在 v 出边排序中的前一个（最顺时针）
  const reverseHalf = new Map();
  for (let i = 0; i < halfEdges.length; i += 2) {
    reverseHalf.set(i, i + 1);
    reverseHalf.set(i + 1, i);
  }
  for (let i = 0; i < halfEdges.length; i++) {
    const h = halfEdges[i];
    const arr = reverseHalf.get(i); // v 点上指向回边的半边
    const list = outgoing.get(h.to);
    const pos = list.indexOf(arr);
    h.next = list[(pos - 1 + list.length) % list.length];
  }

  // 遍历所有面环
  const cycles = [];
  for (let i = 0; i < halfEdges.length; i++) {
    if (halfEdges[i].visited) continue;
    const loop = [];
    let cur = i;
    while (!halfEdges[cur].visited) {
      halfEdges[cur].visited = true;
      loop.push(cur);
      cur = halfEdges[cur].next;
    }
    let area2 = 0;
    for (const hi of loop) {
      const h = halfEdges[hi];
      const p = nodeMap.get(h.from), q = nodeMap.get(h.to);
      area2 += p.x * q.y - q.x * p.y;
    }
    cycles.push({ loop, area: area2 / 2 });
  }

  // 面分类。正面积环(CCW)=有界面外环；负面积环(CW)=洞或框外无界面。
  // 对任一有向环，其覆盖侧恒为该半边的左侧；按环朝向采样其内侧点。
  const gapRegions = [];   // {outer, holes:[...], area（外环面积+洞负面积）}
  const holeLoops = [];    // 属于缺口的洞环（采样点不属于任何片）
  const overlapping = [];

  const sampleCycle = (cyc) => {
    const h0 = halfEdges[cyc.loop[0]];
    const e = h0.edge;
    const fromA = h0.from === e.k1;
    const ax = fromA ? e.p1.x : e.p2.x;
    const ay = fromA ? e.p1.y : e.p2.y;
    const bx = fromA ? e.p2.x : e.p1.x;
    const by = fromA ? e.p2.y : e.p1.y;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    return { x: (ax + bx) / 2 + (-dy / len) * EPS, y: (ay + by) / 2 + (dx / len) * EPS };
  };
  const piecesContaining = (pt) => {
    const ids = [];
    for (const pc of pieces) {
      if (pointInPolygon(pt.x, pt.y, ensureCCW(pc.polygon)) === 1) ids.push(pc.id);
    }
    return ids;
  };
  const loopPolygon = (cyc) => cyc.loop.map((hi) => {
    const h = halfEdges[hi];
    const p = nodeMap.get(h.from);
    return [p.x, p.y];
  });

  for (const cyc of cycles) {
    if (Math.abs(cyc.area) <= 1e-9) continue;
    const polygon = loopPolygon(cyc);
    const pt = sampleCycle(cyc);
    const inside = piecesContaining(pt);
    if (cyc.area > 0) {
      if (inside.length === 0) gapRegions.push({ outer: polygon, holes: [], area: cyc.area });
      else if (inside.length > 1) overlapping.push({ polygon, pieceIds: inside, area: cyc.area });
    } else if (inside.length === 0) {
      // CW 环且覆盖侧无片：洞（有界）或框外无界面。以该环自己的采样点判断：
      // 在窗框矩形之外的是外外域，否则是缺口内的洞。
      const inFrameRect = pt.x > -EPS && pt.y > -EPS && pt.x < W + EPS && pt.y < H + EPS;
      if (inFrameRect) holeLoops.push({ polygon, area: cyc.area });
    }
  }

  // 洞环归入包含它的缺口外环（洞顶点严格位于外环内部；1e-7 偏移不影响）
  for (const hole of holeLoops) {
    for (const g of gapRegions) {
      if (pointInPolygon(hole.polygon[0][0], hole.polygon[0][1], g.outer) === 1) {
        g.holes.push(hole.polygon);
        g.area += hole.area; // hole.area < 0
        break;
      }
    }
  }

  const gaps = gapRegions.map((g) => {
    const outer = g.outer.map(([x, y]) => [round2(x), round2(y)]);
    const holes = g.holes.map((ring) => ring.map(([x, y]) => [round2(x), round2(y)]));
    return {
      outer,
      holes,
      // 兼容字段：polygon=外环（Canvas 多环填充另用 holes）
      polygon: outer,
      area: round2(Math.abs(g.area)),
    };
  });

  // 原子段两侧面归属（左右采样），用于区分公共边/缺口边
  for (const e of atomic.values()) {
    const sides = [];
    for (const [p, q] of [[e.p1, e.p2], [e.p2, e.p1]]) {
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.hypot(dx, dy);
      const sx = (p.x + q.x) / 2 + (-dy / len) * EPS;
      const sy = (p.y + q.y) / 2 + (dx / len) * EPS;
      const ids = [];
      for (const pc of pieces) {
        if (pointInPolygon(sx, sy, ensureCCW(pc.polygon)) === 1) ids.push(pc.id);
      }
      sides.push(ids);
    }
    e.sides = sides;
  }

  // 铅条：内部公共原子段（两侧各恰好一个片且不同），共线段天然只存一份
  const internalEdges = [...atomic.values()].filter(
    (e) => !e.frame && e.sides[0].length === 1 && e.sides[1].length === 1 &&
      e.sides[0][0] !== e.sides[1][0]);

  // 合并为极大共线连续段（T 接点处：直线方向继续则不断开）
  const leadRuns = chainRuns(internalEdges);

  // 外框铅条
  const frameTotal = 2 * (W + H);

  const covered = gaps.length === 0 && overlapping.length === 0;
  const pieceAreas = pieces.map((pc) => ({ id: pc.id, area: polygonArea(pc.polygon) }));

  return {
    covered,
    gaps,
    overlapping: overlapping.map((o) => ({
      polygon: o.polygon.map(([x, y]) => [round2(x), round2(y)]),
      pieceIds: o.pieceIds, area: round2(Math.abs(o.area)),
    })),
    internalEdges: internalEdges.length,
    leadRuns,
    frameLead: { width: W, height: H, total: frameTotal },
    pieces: pieceAreas,
    totalPieceArea: round2(pieceAreas.reduce((s, p) => s + p.area, 0)),
  };
}

// 共线连续段合并：沿同一无向直线方向，在 T 接点（度 2 且方向相反）处继续；
// 十字交叉或拐角处断开。
function chainRuns(edges) {
  // 方向桶：无向直线归一到半圆 [0,π)
  const dirKey = (dx, dy) => {
    let a = Math.atan2(dy, dx);
    if (a < 0) a += Math.PI;
    if (a > Math.PI - 1e-9) a = 0;
    return Math.round(a * 1e9) + '';
  };
  // nodeKey -> dirBucket -> [edge...]（从该节点出发、位于该直线方向上的边）
  const nodes = new Map();
  const addIncident = (nodeKey, otherKey, dk, edge) => {
    if (!nodes.has(nodeKey)) nodes.set(nodeKey, new Map());
    const m = nodes.get(nodeKey);
    if (!m.has(dk)) m.set(dk, []);
    m.get(dk).push(edge);
  };
  for (const e of edges) {
    const dk = dirKey(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    addIncident(e.k1, e.k2, dk, e);
    addIncident(e.k2, e.k1, dk, e);
  }
  const used = new Set();
  const runs = [];
  for (const e0 of edges) {
    if (used.has(e0.key)) continue;
    used.add(e0.key);
    const dk = dirKey(e0.p2.x - e0.p1.x, e0.p2.y - e0.p1.y);
    const pts = [{ x: e0.p1.x, y: e0.p1.y }, { x: e0.p2.x, y: e0.p2.y }];

    // 从末端沿直线延伸：该节点在此方向桶内恰有一条未用边时继续
    let endKey = e0.k2;
    while (true) {
      const bucket = nodes.get(endKey)?.get(dk) || [];
      const free = bucket.filter((e) => !used.has(e.key) &&
        (e.k1 === endKey || e.k2 === endKey));
      if (free.length !== 1) break;
      const ne = free[0];
      used.add(ne.key);
      const np = ne.k1 === endKey ? ne.p2 : ne.p1;
      const nk = ne.k1 === endKey ? ne.k2 : ne.k1;
      pts.push({ x: np.x, y: np.y });
      endKey = nk;
    }
    // 从起点反向延伸
    const before = [];
    let startKey = e0.k1;
    while (true) {
      const bucket = nodes.get(startKey)?.get(dk) || [];
      const free = bucket.filter((e) => !used.has(e.key));
      if (free.length !== 1) break;
      const ne = free[0];
      used.add(ne.key);
      const np = ne.k1 === startKey ? ne.p2 : ne.p1;
      const nk = ne.k1 === startKey ? ne.k2 : ne.k1;
      before.push({ x: np.x, y: np.y });
      startKey = nk;
    }
    const runPts = before.reverse().concat(pts);
    let len = 0;
    for (let i = 1; i < runPts.length; i++) {
      len += Math.hypot(runPts[i].x - runPts[i - 1].x, runPts[i].y - runPts[i - 1].y);
    }
    runs.push({
      points: runPts.map((p) => [round2(p.x), round2(p.y)]),
      length: round2(len),
      rawLength: len,
    });
  }
  runs.sort((a, b) => b.rawLength - a.rawLength);
  const total = runs.reduce((s, r) => s + r.rawLength, 0);
  return { runs, count: runs.length, total: round2(total) };
}

const round2 = (v) => {
  const r = Math.round((v + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

module.exports = {
  pointInPolygon, polygonArea,
  segmentRelation, validatePolygon, checkAgainstPieces,
  analyzePlan, round2,
};
