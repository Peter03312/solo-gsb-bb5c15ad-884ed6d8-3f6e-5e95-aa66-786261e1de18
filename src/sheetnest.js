'use strict';

// 彩色玻璃原片裁片排样核心（纯计算，不访问数据库、无副作用）。
//
// 输入全部为整数毫米：原片宽/高（1–2000）、片间最小间距 gap（0–50）、件数 copies（正整数）。
// 每片只可平移或旋转 90° 的整数倍（0/90/180/270），不得镜像。
// 排样约束（逐片精确校验）：
//   1) 整数毫米平移，轮廓完全在原片矩形内（可贴边，不要求留边）；
//   2) 同板两片轮廓不得面积重叠；
//   3) 同板两片轮廓之间的最短距离不得小于 gap（gap=0 时允许边界接触：共边/T接/顶点接）。
// 装箱：各色独立，逐片首次适应（first-fit，先尝试既有原片再开新片），
//   片位采用左下角策略（最低 y，同 y 最左 x，再按旋转角 0/90/180/270）。
// 相同输入布局完全一致（确定性）；不保证全局最少用板。
// 距离判定全部基于整数坐标的精确整数运算（BigInt 平方距离），不用浮点。

const SHEET_MIN = 1;
const SHEET_MAX = 2000;
const GAP_MIN = 0;
const GAP_MAX = 50;
const COPIES_MAX = 10000;
const MAX_SHEETS = 60;

// ---------- 参数解析 ----------

function intInRange(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: `${name}必须是整数` };
  }
  if (value < min || value > max) {
    return { ok: false, error: `${name}必须是 ${min}–${max} 之间的整数` };
  }
  return { ok: true, n: value };
}

// body: { width, height, stock, color }
// 返回 { ok:true, params } 或 { ok:false, error }
function parseSheetBody(body) {
  const b = body || {};
  const color = normalizeColor(b.color);
  if (!color) return { ok: false, error: '颜色必须是 #RRGGBB 形式' };
  const w = intInRange(Number(b.width), '原片宽', SHEET_MIN, SHEET_MAX);
  if (!w.ok) return w;
  const h = intInRange(Number(b.height), '原片高', SHEET_MIN, SHEET_MAX);
  if (!h.ok) return h;
  const stock = intInRange(Number(b.stock), '库存张数', 0, 1e9);
  if (!stock.ok) return stock;
  return { ok: true, params: { color, width: w.n, height: h.n, stock: stock.n } };
}

// 排产参数：{ publicationId 在 HTTP 层解析；copies, gap }
function parseNestingParams(body) {
  const b = body || {};
  const copies = intInRange(Number(b.copies), '制作件数', 1, COPIES_MAX);
  if (!copies.ok) return copies;
  const gap = intInRange(Number(b.gap), '片间最小间距', GAP_MIN, GAP_MAX);
  if (!gap.ok) return gap;
  return { ok: true, params: { copies: copies.n, gap: gap.n } };
}

function normalizeColor(color) {
  if (typeof color !== 'string') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

// ---------- 整数几何 ----------

function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// 绕原点旋转 90° 的整数倍，随后平移使包围盒左下角归 (0,0)（不改变形状，仅规范化）。
// rotation: 0/1/2/3（分别对应 0°/90°/180°/270°，逆时针，y 轴向上）。
function rotateNormalized(poly, rotation) {
  const r = ((Math.floor(rotation) % 4) + 4) % 4;
  const mapped = poly.map(([x, y]) => {
    if (r === 0) return [x, y];
    if (r === 1) return [-y, x];
    if (r === 2) return [-x, -y];
    return [y, -x];
  });
  const b = polygonBounds(mapped);
  return {
    rotation: r,
    poly: mapped.map(([x, y]) => [x - b.minX, y - b.minY]),
    w: b.w,
    h: b.h,
  };
}

const translatePoly = (poly, tx, ty) => poly.map(([x, y]) => [x + tx, y + ty]);

function bboxesOverlapWithGap(a, b, gap) {
  // 包围盒在 x/y 方向都需要至少 gap 的净距才“可能”满足轮廓间距；
  // 仅当两个扩张包围盒（各扩 gap/2，用整数避免分数 → 单边扩 gap）重叠时才需细查。
  return !(a.maxX + gap <= b.minX || b.maxX + gap <= a.minX ||
           a.maxY + gap <= b.minY || b.maxY + gap <= a.minY);
}

// 点 P 到线段 AB 的距离²是否严格小于 gap²（整数坐标 → BigInt 精确比较，无需开方）。
// 垂足参数 t=(w·v)/|v|²：t<=0 取端点 A，t>=1 取端点 B，中间用距离²=|w|²-(w·v)²/|v|²，
// 与 gap² 比较时交叉相乘：num < gap²·|v|²。
function pointSegDist2LessThanGap(px, py, ax, ay, bx, by, gap) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = BigInt(vx * vx + vy * vy);
  const g2 = BigInt(gap * gap);
  if (len2 === 0n) {
    const d2 = BigInt(wx * wx + wy * wy);
    return d2 < g2;
  }
  const wv = BigInt(wx * vx + wy * vy);
  if (wv < 0n) return BigInt(wx * wx + wy * wy) < g2;
  if (wv > len2) {
    const ddx = BigInt(px - bx), ddy = BigInt(py - by);
    return ddx * ddx + ddy * ddy < g2;
  }
  // 0 <= wv <= len2：垂足落在线段内部（含端点）；距离² = |w|² - (w·v)²/|v|²
  const wlen2 = BigInt(wx * wx + wy * wy);
  const num = wlen2 * len2 - wv * wv; // 距离² = num / len2
  return num < g2 * len2;
}

// 判断两片简单多边形的轮廓最短距离是否 >= gap（整数毫米，精确）。
// 前置：两片已被判定为“内部不重叠”（边不交叉、无顶点穿入、无共线重叠）。
// gap=0 时只要不重叠即合法（距离允许为 0：边界接触）。
function contoursSeparated(polyA, polyB, gap) {
  if (gap === 0) return true;
  const n = polyA.length, m = polyB.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = polyA[i];
    const [bx, by] = polyA[(i + 1) % n];
    for (let j = 0; j < m; j++) {
      const [cx, cy] = polyB[j];
      const [dx, dy] = polyB[(j + 1) % m];
      // 快速排除：两边包围盒在某轴上已相差 >= gap，则该边对距离必然 >= gap
      if (Math.max(ax, bx) + gap <= Math.min(cx, dx) ||
          Math.max(cx, dx) + gap <= Math.min(ax, bx) ||
          Math.max(ay, by) + gap <= Math.min(cy, dy) ||
          Math.max(cy, dy) + gap <= Math.min(ay, by)) {
        continue;
      }
      // 两线段最短距离在某个端点对另一边的垂足（或端点）处取得
      if (pointSegDist2LessThanGap(cx, cy, ax, ay, bx, by, gap) ||
          pointSegDist2LessThanGap(dx, dy, ax, ay, bx, by, gap) ||
          pointSegDist2LessThanGap(ax, ay, cx, cy, dx, dy, gap) ||
          pointSegDist2LessThanGap(bx, by, cx, cy, dx, dy, gap)) {
        return false;
      }
    }
  }
  return true;
}

// 点在多边形内/边界：2=边界上, 1=内部, 0=外部（整数叉积/射线，精确）
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const d1 = yi - py, d2 = yj - py;
    if (((d1 > 0) !== (d2 > 0)) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    const cr = (xj - xi) * (py - yi) - (yj - yi) * (px - xi);
    if (cr === 0 &&
      Math.min(xi, xj) <= px && px <= Math.max(xi, xj) &&
      Math.min(yi, yj) <= py && py <= Math.max(yi, yj)) return 2;
  }
  return inside ? 1 : 0;
}

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// 两线段关系：'cross' 规范相交 / 'collinear' 共线重叠 / 'touch' 端点相触 / 'none'
function segmentKind(a, b, c, d) {
  const c1 = cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const c2 = cross(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const c3 = cross(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const c4 = cross(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  if (((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) &&
      ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0))) return 'cross';
  const onSeg = (p, q, s) =>
    cross(q[0] - p[0], q[1] - p[1], s[0] - p[0], s[1] - p[1]) === 0 &&
    Math.min(p[0], q[0]) <= s[0] && s[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= s[1] && s[1] <= Math.max(p[1], q[1]);
  if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0) {
    const lo = Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]));
    const hi = Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]));
    const loY = Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]));
    const hiY = Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
    if (hi < lo || hiY < loY) return 'none';
    if (hi === lo && hiY === loY) return 'touch';
    return 'collinear';
  }
  if (onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b)) return 'touch';
  return 'none';
}

// 判断放置片 cand（绝对坐标）与同板既有片 others 是否冲突。
// 冲突 = 面积重叠（边交叉/共线重叠/顶点穿入/包含）或轮廓净距 < gap。
// 返回 { ok:true } 或 { ok:false, reason }。
function placementValid(cand, others, gap, sheetW, sheetH) {
  const cb = polygonBounds(cand);
  if (cb.minX < 0 || cb.minY < 0 || cb.maxX > sheetW || cb.maxY > sheetH) {
    return { ok: false, reason: 'out_of_sheet' };
  }
  for (const other of others) {
    const ob = polygonBounds(other);
    // 包围盒净距已 >= gap 时，轮廓距离必然 >= gap，且不可能重叠
    if (!bboxesOverlapWithGap(cb, ob, gap)) continue;

    // 1) 顶点穿入对方严格内部 / 对方顶点穿入（含包含关系）
    for (const v of cand) if (pointInPoly(v[0], v[1], other) === 1) return { ok: false, reason: 'overlap' };
    for (const v of other) if (pointInPoly(v[0], v[1], cand) === 1) return { ok: false, reason: 'overlap' };

    // 2) 边对关系
    for (let i = 0; i < cand.length; i++) {
      const a = cand[i], b = cand[(i + 1) % cand.length];
      for (let j = 0; j < other.length; j++) {
        const kind = segmentKind(a, b, other[j], other[(j + 1) % other.length]);
        if (kind === 'cross' || kind === 'collinear') return { ok: false, reason: 'overlap' };
        // touch（端点接）合法，净距在下面统一量
      }
    }

    // 3) 轮廓最短净距 >= gap（touch/相离都在此精确判定）
    if (!contoursSeparated(cand, other, gap)) return { ok: false, reason: 'too_close' };
  }
  return { ok: true };
}

// ---------- 左下角首次适应装箱（矩形包围盒 + 精确轮廓复核） ----------

// 在一块已放若干矩形 rects（{x,y,w,h}）的板上，为尺寸 rw×rh 的包围盒寻找
// 最低、同高最左的可行位置。候选 y = 0 与各已放矩形顶边 + gap。
// 返回 {x,y} 或 null。
function bottomLeftPosition(rects, rw, rh, sheetW, sheetH, gap) {
  const ys = [0];
  for (const r of rects) ys.push(r.y + r.h + gap);
  const candidates = [...new Set(ys)].filter((y) => y + rh <= sheetH).sort((a, b) => a - b);

  let best = null;
  for (const y of candidates) {
    // y 带内与候选矩形竖向重叠（含 gap 净距要求）的已放矩形形成 x 阻挡区间
    const blocked = [];
    for (const r of rects) {
      if (y < r.y + r.h + gap && r.y < y + rh + gap) {
        blocked.push([Math.max(0, r.x - gap), r.x + r.w + gap]);
      }
    }
    blocked.sort((u, v) => u[0] - v[0] || u[1] - v[1]);
    // 合并相交区间，顺序扫描自由段
    let cursor = 0;
    for (const [lo, hi] of blocked) {
      if (lo > cursor) {
        const x = cursor;
        if (x + rw <= sheetW) { best = { x, y }; break; }
      }
      if (hi > cursor) cursor = hi;
    }
    if (!best && cursor + rw <= sheetW) best = { x: cursor, y };
    if (best) break;
  }
  return best;
}

// 从发布快照取出按颜色分组的片原型。
// pieces: [{ pieceNo, color, polygon }]（整数毫米简单多边形）
// 返回 { ok:true, groups: Map(color -> [{pieceNo,color,polygon,bounds}]) }
function groupSnapshotPieces(snapshot) {
  const pieces = snapshot && Array.isArray(snapshot.pieces) ? snapshot.pieces : null;
  if (!pieces) return { ok: false, error: '发布快照缺少拼片数据' };
  const groups = new Map();
  for (const p of pieces) {
    const color = normalizeColor(p.color);
    if (!color) return { ok: false, error: `拼片 #${p.pieceNo} 颜色非法` };
    if (!Array.isArray(p.polygon) || p.polygon.length < 3) {
      return { ok:false, error: `拼片 #${p.pieceNo} 轮廓不完整` };
    }
    const poly = p.polygon.map((q) => [Number(q[0]), Number(q[1])]);
    if (poly.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y))) {
      return { ok: false, error: `拼片 #${p.pieceNo} 顶点不是整数毫米` };
    }
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push({
      pieceNo: Number(p.pieceNo),
      color,
      polygon: poly,
      bounds: polygonBounds(poly),
    });
  }
  return { ok: true, groups };
}

// 主入口：按快照颜色排样。
//   snapshot         发布快照（取 width/height/pieces）
//   sheetByColor     Map(color -> { width, height }) 该色原片规格（库存由调用方另行汇总）
//   copies           制作件数（正整数）
//   gap              片间最小间距（0–50 整数毫米）
// 返回：
//   { ok:true, layout }  layout.colors: [{color, sheetWidth, sheetHeight, sheets:[...], requiredSheets, ...}]
//                        layout.totalSheets（<=MAX_SHEETS）
//   或 { ok:false, code,status,error, ... }
//     missing_color {color} / piece_too_large {pieceNo,copy,color,pieceWidth,pieceHeight,sheetWidth,sheetHeight}
//     too_many_sheets {totalSheets,maxSheets,color}
function nestBySnapshot(snapshot, sheetByColor, copies, gap) {
  const gr = groupSnapshotPieces(snapshot);
  if (!gr.ok) return { ok: false, code: 'bad_snapshot', status: 500, error: gr.error };
  const groups = gr.groups;

  // 缺色：整单拒绝
  for (const color of groups.keys()) {
    if (!sheetByColor || !sheetByColor.has(color)) {
      return { ok: false, code: 'missing_color', status: 422, error: `缺少颜色 ${color} 的原片规格登记`, color };
    }
  }

  // 颜色按色值字典序处理，保证确定性
  const colors = [...groups.keys()].sort();
  const layoutColors = [];
  let totalSheets = 0;

  for (const color of colors) {
    const spec = sheetByColor.get(color);
    const { width: SW, height: SH } = spec;
    const proto = groups.get(color);

    // 件次展开：每件内按片号升序；展开顺序（件次,片号）
    const items = [];
    for (let copy = 1; copy <= copies; copy++) {
      for (const p of proto) {
        items.push({ pieceNo: p.pieceNo, copy, polygon: p.polygon, bounds: p.bounds });
      }
    }
    // 装箱顺序：包围盒面积降序 → 高降序 → 宽降序 → 片号 → 件次（全部确定）
    items.sort((a, b) =>
      (b.bounds.w * b.bounds.h) - (a.bounds.w * a.bounds.h) ||
      b.bounds.h - a.bounds.h ||
      b.bounds.w - a.bounds.w ||
      a.pieceNo - b.pieceNo ||
      a.copy - b.copy);

    // 单片（任一旋转）连原片都放不下 → 整单拒绝
    for (const it of items) {
      const fits = [0, 1, 2, 3].some((r) => {
        const t = rotateNormalized(it.polygon, r);
        return t.w <= SW && t.h <= SH;
      });
      if (!fits) {
        return {
          ok: false, code: 'piece_too_large', status: 422,
          error: `拼片 #${it.pieceNo}（第 ${it.copy} 件，颜色 ${color}）无论怎样旋转都无法放入 ${SW}×${SH} mm 原片`,
          color, pieceNo: it.pieceNo, copy: it.copy,
          pieceWidth: it.bounds.w, pieceHeight: it.bounds.h,
          sheetWidth: SW, sheetHeight: SH,
        };
      }
    }

    // 四个旋转的规范化形状
    const shapesFor = (it) => [0, 1, 2, 3].map((r) => rotateNormalized(it.polygon, r));

    // boards: [{ rects:[{x,y,w,h,item}], placed:[{..., polygon(绝对)}] }]
    const boards = [];

    const openNewBoard = () => {
      const b = { rects: [], placed: [] };
      boards.push(b);
      return boards.length;
    };

    for (const it of items) {
      const shapes = shapesFor(it);
      let placed = false;

      // 首次适应：按板号从早到晚尝试
      for (let bi = 0; bi < boards.length && !placed; bi++) {
        const board = boards[bi];
        // 各旋转找最佳左下角点；全局取 y 最小、x 最小、旋转角最小
        let choice = null;
        for (const shp of shapes) {
          if (shp.w > SW || shp.h > SH) continue;
          const pos = bottomLeftPosition(board.rects, shp.w, shp.h, SW, SH, gap);
          if (!pos) continue;
          if (!choice ||
              pos.y < choice.pos.y ||
              (pos.y === choice.pos.y && pos.x < choice.pos.x) ||
              (pos.y === choice.pos.y && pos.x === choice.pos.x && shp.rotation < choice.shape.rotation)) {
            choice = { shape: shp, pos };
          }
        }
        if (!choice) continue;
        const absPoly = translatePoly(choice.shape.poly, choice.pos.x, choice.pos.y);
        const check = placementValid(absPoly, board.placed.map((q) => q.polygon), gap, SW, SH);
        if (!check.ok) continue; // 理论上包围盒间距已保证；防御性整板跳过
        board.rects.push({ x: choice.pos.x, y: choice.pos.y, w: choice.shape.w, h: choice.shape.h });
        board.placed.push({
          pieceNo: it.pieceNo,
          copy: it.copy,
          color,
          rotation: choice.shape.rotation * 90,
          x: choice.pos.x,
          y: choice.pos.y,
          width: choice.shape.w,
          height: choice.shape.h,
          polygon: absPoly,
        });
        placed = true;
      }

      if (!placed) {
        // 开新板：空板上取可放入的最小旋转角（通常 0），置于 (0,0)
        const total = totalSheets + boards.length + 1;
        if (total > MAX_SHEETS) {
          return {
            ok: false, code: 'too_many_sheets', status: 422,
            error: `裁片用板总数达到 ${total} 张，超过上限 ${MAX_SHEETS} 张，请增大原片或减小件数`,
            color, totalSheets: total, maxSheets: MAX_SHEETS,
          };
        }
        const board = boards[openNewBoard() - 1];
        const shp = shapes.find((s) => s.w <= SW && s.h <= SH);
        const absPoly = shp.poly; // 已规范化到 (0,0)
        board.rects.push({ x: 0, y: 0, w: shp.w, h: shp.h });
        board.placed.push({
          pieceNo: it.pieceNo, copy: it.copy, color,
          rotation: shp.rotation * 90, x: 0, y: 0,
          width: shp.w, height: shp.h, polygon: absPoly,
        });
      }
    }

    totalSheets += boards.length;
    if (totalSheets > MAX_SHEETS) {
      return {
        ok: false, code: 'too_many_sheets', status: 422,
        error: `裁片用板总数达到 ${totalSheets} 张，超过上限 ${MAX_SHEETS} 张，请增大原片或减小件数`,
        color, totalSheets, maxSheets: MAX_SHEETS,
      };
    }

    layoutColors.push({
      color,
      sheetWidth: SW,
      sheetHeight: SH,
      requiredSheets: boards.length,
      sheets: boards.map((b, i) => ({
        index: i + 1,
        width: SW,
        height: SH,
        placements: b.placed.map((q) => ({
          pieceNo: q.pieceNo,
          copy: q.copy,
          color: q.color,
          rotation: q.rotation,
          x: q.x,
          y: q.y,
          width: q.width,
          height: q.height,
          polygon: q.polygon,
        })),
      })),
    });
  }

  return {
    ok: true,
    layout: {
      copies,
      gap,
      totalSheets,
      maxSheets: MAX_SHEETS,
      colors: layoutColors,
    },
  };
}

module.exports = {
  SHEET_MIN, SHEET_MAX, GAP_MIN, GAP_MAX, COPIES_MAX, MAX_SHEETS,
  parseSheetBody, parseNestingParams, normalizeColor,
  polygonBounds, rotateNormalized, translatePoly,
  pointInPoly, segmentKind, contoursSeparated, placementValid,
  bottomLeftPosition, groupSnapshotPieces, nestBySnapshot,
};
