'use strict';

// 跨图纸拼片复用（从已发布快照选片 → 绕源图纸原点旋转 0/90/180/270 + 整数毫米平移 → 写入目标草稿）。
//
// 本模块为纯几何/参数逻辑，不访问数据库：
//   - 旋转与平移保持整数毫米坐标，且保持多边形简单性与面积；
//   - 每片变换后必须仍是合法简单多边形、完全落在目标窗框内；
//   - 批内各片之间、以及与目标草稿已有拼片之间不得有面积重叠（合法共边/T 接允许）；
//   - 预览只做计算；确认时由 db 层在同一写事务内重放指纹核对与本模块的几何校验后整批写入。

const geo = require('./geometry');

const ROTATIONS = [0, 90, 180, 270];
const TRANSLATE_MIN = -1000000;
const TRANSLATE_MAX = 1000000;
const MAX_ITEMS = 500;

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

// body: { publicationId? / sourceDesignId?+sourceVersion?, pieceNos:[...], rotation, dx, dy }
// 返回 { ok:true, params:{ publicationId, sourceDesignId, sourceVersion, pieceNos, rotation, dx, dy } }
function parseImportBody(body) {
  const b = body || {};

  let publicationId = null;
  let sourceDesignId = null;
  let sourceVersion = null;
  if (b.publicationId !== undefined && b.publicationId !== null) {
    const v = Number(b.publicationId);
    if (!Number.isInteger(v) || v <= 0) return { ok: false, error: 'publicationId 必须是发布版的正整数 id' };
    publicationId = v;
  } else {
    const d = Number(b.sourceDesignId);
    const v = Number(b.sourceVersion);
    if (!Number.isInteger(d) || d <= 0) {
      return { ok: false, error: '来源图纸须传 publicationId，或 sourceDesignId + sourceVersion' };
    }
    if (!Number.isInteger(v) || v <= 0) {
      return { ok: false, error: 'sourceVersion 必须是正整数版本号' };
    }
    sourceDesignId = d;
    sourceVersion = v;
  }

  if (!Array.isArray(b.pieceNos)) return { ok: false, error: 'pieceNos 必须是拼片编号数组' };
  if (b.pieceNos.length === 0) return { ok: false, error: '请至少选择一片拼片' };
  if (b.pieceNos.length > MAX_ITEMS) return { ok: false, error: `单次最多导入 ${MAX_ITEMS} 片` };
  const pieceNos = [];
  const seen = new Set();
  for (const raw of b.pieceNos) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: '拼片编号必须是正整数（按来源发布版的片号）' };
    }
    if (seen.has(n)) return { ok: false, error: `拼片编号 #${n} 重复，一次导入中每片只能选一次` };
    seen.add(n);
    pieceNos.push(n);
  }

  const rotation = Number(b.rotation === undefined ? 0 : b.rotation);
  if (!Number.isInteger(rotation) || !ROTATIONS.includes(rotation)) {
    return { ok: false, error: 'rotation 必须是 0/90/180/270 之一（绕源图纸坐标原点逆时针）' };
  }
  const dxR = intInRange(Number(b.dx === undefined ? 0 : b.dx), 'x 平移 dx', TRANSLATE_MIN, TRANSLATE_MAX);
  if (!dxR.ok) return dxR;
  const dyR = intInRange(Number(b.dy === undefined ? 0 : b.dy), 'y 平移 dy', TRANSLATE_MIN, TRANSLATE_MAX);
  if (!dyR.ok) return dyR;

  return {
    ok: true,
    params: { publicationId, sourceDesignId, sourceVersion, pieceNos, rotation, dx: dxR.n, dy: dyR.n },
  };
}

// ---------- 变换 ----------

// 绕源图纸坐标原点 (0,0) 逆时针旋转（y 轴向上），再做整数毫米平移。
// 与玻璃裁片排样的 90° 旋转方向一致，不做镜像。
function transformPoint(x, y, rotation, dx, dy) {
  let rx = x, ry = y;
  if (rotation === 90) { rx = -y; ry = x; }
  else if (rotation === 180) { rx = -x; ry = -y; }
  else if (rotation === 270) { rx = y; ry = -x; }
  return [rx + dx, ry + dy];
}

function transformPolygon(poly, rotation, dx, dy) {
  return poly.map(([x, y]) => transformPoint(x, y, rotation, dx, dy));
}

function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// 从发布快照取片：返回 { ok:true, items } 或 { ok:false, missing:[pieceNo,...] }
function buildItems(snapshot, pieceNos, rotation, dx, dy) {
  const byNo = new Map();
  for (const p of (snapshot && Array.isArray(snapshot.pieces) ? snapshot.pieces : [])) {
    byNo.set(Number(p.pieceNo), p);
  }
  const missing = [];
  const items = [];
  pieceNos.forEach((no, i) => {
    const src = byNo.get(no);
    if (!src) { missing.push(no); return; }
    const sourcePolygon = (src.polygon || []).map((q) => [Number(q[0]), Number(q[1])]);
    const polygon = transformPolygon(sourcePolygon, rotation, dx, dy);
    items.push({
      index: i + 1,
      sourcePieceNo: no,
      color: src.color,
      rotation,
      dx,
      dy,
      sourcePolygon,
      polygon,
      bounds: polygonBounds(polygon),
      area: geo.round2(geo.polygonArea(polygon)),
    });
  });
  if (missing.length) return { ok: false, missing };
  return { ok: true, items };
}

// ---------- 草稿指纹（预览后编辑检测） ----------

// 对草稿全部拼片的身份（片号/颜色/顶点）做确定性摘要；任一片增删改都会改变指纹。
function draftFingerprint(pieces) {
  return pieces
    .map((p) => `${p.pieceNo}:${p.color}:${p.polygon.map((q) => `${q[0]},${q[1]}`).join(';')}`)
    .sort()
    .join('|');
}

// ---------- 批量几何校验 ----------

// frame = {width,height}；existing = [{id,pieceNo,polygon}]（目标草稿已有片）；
// items = buildItems 的产物（含变换后 polygon）。
// 逐片校验：自身合法 → 完全在窗框内 → 与已有片及本批已接受片无面积重叠。
// 返回 { ok:true, accepted:[items] } 或
//       { ok:false, problems:[{index,sourcePieceNo,reason,at,withKind,withPieceNo}] }
function validateBatch(frame, existing, items) {
  const problems = [];
  // 已有片用真实正数 id，本批片用负数临时 id，冲突时可回溯到来源片号
  const idMap = new Map();
  const placed = existing.map((p) => {
    idMap.set(p.id, { kind: 'existing', pieceNo: p.pieceNo });
    return { id: p.id, polygon: p.polygon };
  });
  let tempId = 0;

  for (const it of items) {
    // 1) 自身合法性（刚体变换理论上保持；仍严格复核）
    const self = geo.validatePolygon(it.polygon);
    if (!self.ok) {
      problems.push({
        index: it.index, sourcePieceNo: it.sourcePieceNo,
        reason: 'invalid_polygon', reasonText: self.reason, at: self.at || null,
      });
      continue;
    }
    // 2) 完全落在目标窗框 [0,W]×[0,H] 内（矩形为凸集，顶点在内则整边在内）
    let outside = null;
    for (const v of it.polygon) {
      if (v[0] < 0 || v[1] < 0 || v[0] > frame.width || v[1] > frame.height) {
        outside = v.slice();
        break;
      }
    }
    if (outside) {
      problems.push({
        index: it.index, sourcePieceNo: it.sourcePieceNo,
        reason: 'out_of_frame', reasonText: '转换后的拼片超出目标窗框', at: outside,
        frame: { width: frame.width, height: frame.height },
      });
      continue;
    }
    // 3) 与已有片及本批先前片的面积重叠（共边/T 接/顶点相接合法）
    const rel = geo.checkAgainstPieces(it.polygon, placed, null);
    if (!rel.ok) {
      const ref = rel.pieceId != null ? idMap.get(rel.pieceId) : null;
      problems.push({
        index: it.index, sourcePieceNo: it.sourcePieceNo,
        reason: 'overlap', reasonText: rel.reason,
        at: rel.at ? rel.at.slice() : null,
        withKind: ref ? ref.kind : null,
        withPieceNo: ref ? ref.pieceNo : null,
      });
      continue;
    }
    const id = --tempId;
    idMap.set(id, { kind: 'import', pieceNo: it.sourcePieceNo });
    placed.push({ id, polygon: it.polygon });
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, accepted: items };
}

// ---------- 预览汇总 ----------

function coverageOf(frame, pieces) {
  const analysis = geo.analyzePlan(frame, pieces.map((p) => ({ id: p.id, polygon: p.polygon })));
  return {
    covered: analysis.covered,
    gaps: analysis.gaps,
    overlapping: analysis.overlapping,
    totalPieceArea: analysis.totalPieceArea,
    frameArea: frame.width * frame.height,
  };
}

// 组装完整预览（不落库）：
//   targetDesign = {id,width_mm,height_mm}；existingPieces = db.listPieces(...)
//   pub = 来源发布版；params = parseImportBody 结果
function buildPreview(targetDesign, existingPieces, pub, params) {
  const built = buildItems(pub.snapshot, params.pieceNos, params.rotation, params.dx, params.dy);
  if (!built.ok) return { ok: false, code: 'source_piece_not_found', status: 404, missing: built.missing };

  const frame = { width: targetDesign.width_mm, height: targetDesign.height_mm };
  const existing = existingPieces.map((p) => ({ id: p.id, pieceNo: p.pieceNo, color: p.color, polygon: p.polygon }));
  const v = validateBatch(frame, existing, built.items);
  if (!v.ok) return { ok: false, code: 'geometry_conflict', status: 422, problems: v.problems };

  const before = coverageOf(frame, existing);
  let tempId = 0;
  const allPieces = existing.map((p) => ({ id: p.id, polygon: p.polygon }));
  for (const it of built.items) allPieces.push({ id: --tempId, polygon: it.polygon });
  const after = coverageOf(frame, allPieces);

  return {
    ok: true,
    previewData: {
      target: { designId: targetDesign.id, width: frame.width, height: frame.height },
      source: {
        publicationId: pub.id,
        designId: pub.designId,
        designName: pub.snapshot.name,
        version: pub.version,
      },
      selection: params.pieceNos.slice(),
      rotation: params.rotation,
      dx: params.dx,
      dy: params.dy,
      items: built.items,
      draftToken: draftFingerprint(existingPieces),
      targetDraft: { pieceCount: existing.length, coverage: before },
      simulated: { pieceCount: existing.length + built.items.length, coverage: after },
    },
  };
}

module.exports = {
  ROTATIONS, TRANSLATE_MIN, TRANSLATE_MAX, MAX_ITEMS,
  parseImportBody, transformPoint, transformPolygon, polygonBounds,
  buildItems, draftFingerprint, validateBatch, buildPreview, coverageOf,
};
