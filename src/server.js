'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geo = require('./geometry');
const cut = require('./cutting');
const leadDiff = require('./leaddiff');
const printSheet = require('./printsheet');
const sheetNest = require('./sheetnest');
const importPieces = require('./importpieces');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');

db.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 工具 ----------

function fail(res, code, error, extra = {}) {
  return res.status(code).json({ ok: false, error, ...extra });
}

function loadDesignOr404(req, res) {
  const design = db.getDesign(Number(req.params.designId));
  if (!design) {
    fail(res, 404, '图纸不存在');
    return null;
  }
  return design;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#8FAB1E'];

function parsePolygon(body) {
  const poly = body.polygon;
  if (!Array.isArray(poly)) return { error: 'polygon 必须是 [[x,y],...] 数组' };
  const pts = [];
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 ||
      !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return { error: '每个顶点必须是两个整数毫米坐标' };
    }
    pts.push([p[0], p[1]]);
  }
  return { polygon: pts };
}

// 汇总草稿：片、面积、覆盖状态、缺口、铅条清单
function draftSummary(design) {
  const rows = db.listPieces(design.id);
  const pieces = rows.map((r) => ({
    id: r.id,
    pieceNo: r.pieceNo,
    color: r.color,
    polygon: r.polygon,
    area: geo.round2(geo.polygonArea(r.polygon)),
  }));
  const analysis = geo.analyzePlan(
    { width: design.width_mm, height: design.height_mm },
    rows.map((r) => ({ id: r.id, polygon: r.polygon })),
  );
  return {
    id: design.id,
    name: design.name,
    width: design.width_mm,
    height: design.height_mm,
    createdAt: design.created_at,
    updatedAt: design.updated_at,
    pieces,
    coverage: {
      covered: analysis.covered,
      gaps: analysis.gaps,
      overlapping: analysis.overlapping,
      totalPieceArea: analysis.totalPieceArea,
      frameArea: design.width_mm * design.height_mm,
    },
    leadList: buildLeadList(analysis),
  };
}

// 铅条下料清单：内部公共边合并极大共线段；外框四根另列
function buildLeadList(analysis) {
  const { width, height, total } = analysis.frameLead;
  return {
    internal: analysis.leadRuns.runs.map((r, i) => ({
      no: i + 1,
      points: r.points,
      length: r.length,
    })),
    internalCount: analysis.leadRuns.count,
    internalTotal: analysis.leadRuns.total,
    frameBars: [
      { name: '上框', from: [0, 0], to: [width, 0], length: geo.round2(width) },
      { name: '下框', from: [0, height], to: [width, height], length: geo.round2(width) },
      { name: '左框', from: [0, 0], to: [0, height], length: geo.round2(height) },
      { name: '右框', from: [width, 0], to: [width, height], length: geo.round2(height) },
    ],
    frameTotal: geo.round2(total),
    grandTotal: geo.round2(analysis.leadRuns.total + total),
  };
}

// 对一次新增/编辑做全部几何校验；通过返回 null，否则返回 422 响应体
function validateEdit(design, candidatePolygon, ignorePieceId) {
  const frame = { width: design.width_mm, height: design.height_mm };

  const self = geo.validatePolygon(candidatePolygon);
  if (!self.ok) {
    return { error: self.reason, category: 'invalid', at: self.at || null };
  }
  const others = db.listPieces(design.id)
    .filter((r) => r.id !== ignorePieceId)
    .map((r) => ({ id: r.id, polygon: r.polygon }));
  // checkAgainstPieces 内部统一做越界（矩形窗框为凸集，顶点在内则边在内）与重叠校验
  const rel = geo.checkAgainstPieces(candidatePolygon, others, frame);
  if (!rel.ok) {
    return {
      error: rel.reason,
      category: 'overlap',
      at: rel.at ? rel.at.slice() : null,
      pieceId: rel.pieceId || null,
    };
  }
  return null;
}

// ---------- 图纸 ----------

app.get('/api/designs', (req, res) => {
  res.json({ ok: true, designs: db.listDesigns() });
});

app.post('/api/designs', (req, res) => {
  const { name } = req.body || {};
  const width = Number(req.body?.width);
  const height = Number(req.body?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail(res, 400, '窗框宽高必须是正整数毫米');
  }
  if (width > 100000 || height > 100000) {
    return fail(res, 400, '窗框尺寸过大（上限 100000 毫米）');
  }
  const design = db.createDesign({
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名图纸',
    width, height,
  });
  res.status(201).json({ ok: true, design });
});

app.get('/api/designs/:designId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, draft: draftSummary(design) });
});

// ---------- 草稿拼片 ----------

app.post('/api/designs/:designId/pieces', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  let color = (req.body.color || '').trim();
  if (!color) color = DEFAULT_COLORS[db.listPieces(design.id).length % DEFAULT_COLORS.length];
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, null);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const piece = db.addPiece(design.id, { color, polygon: parsed.polygon });
  res.status(201).json({ ok: true, piece: withArea(piece), draft: draftSummary(db.getDesign(design.id)) });
});

app.put('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pieceId = Number(req.params.pieceId);
  const existing = db.getPiece(design.id, pieceId);
  if (!existing) return fail(res, 404, '拼片不存在');

  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  const color = (req.body.color || '').trim();
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, pieceId);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const updated = db.updatePiece(design.id, pieceId, { color, polygon: parsed.polygon });
  res.json({ ok: true, piece: withArea(updated), draft: draftSummary(db.getDesign(design.id)) });
});

app.delete('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const removed = db.deletePiece(design.id, Number(req.params.pieceId));
  if (!removed) return fail(res, 404, '拼片不存在');
  res.json({ ok: true, draft: draftSummary(db.getDesign(design.id)) });
});

function withArea(piece) {
  return { ...piece, area: geo.round2(geo.polygonArea(piece.polygon)) };
}

// ---------- 发布 ----------

app.get('/api/designs/:designId/publications', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, publications: db.listPublications(design.id) });
});

app.post('/api/designs/:designId/publish', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const summary = draftSummary(design);
  if (summary.pieces.length === 0) {
    return fail(res, 422, '草稿为空，不能发布');
  }
  if (!summary.coverage.covered) {
    return res.status(422).json({
      ok: false,
      error: '草稿未完整覆盖窗框或存在重叠，不能发布',
      category: 'not_covered',
      gaps: summary.coverage.gaps,
      overlapping: summary.coverage.overlapping,
    });
  }
  const snapshot = {
    name: summary.name,
    width: summary.width,
    height: summary.height,
    pieces: summary.pieces,
    leadList: summary.leadList,
    frameArea: summary.coverage.frameArea,
  };
  const pub = db.publishVersion(design.id, snapshot);
  res.status(201).json({ ok: true, publication: pub });
});

// 核对两个发布版的铅条下料差异（只读，不改快照/计划/库存）。
// 结果以较早版为基准：kept 沿用 / removed 较早版取消 / added 较晚版新增。
// 若两版顺序颠倒，自动按版本号交换。
function buildPublicationDiff(pubA, pubB) {
  const [earlier, later] = pubA.version <= pubB.version ? [pubA, pubB] : [pubB, pubA];
  const r = leadDiff.diffPublications(earlier, later);
  if (!r.ok) return { error: r.error, status: 422 };
  return {
    meta: {
      designId: earlier.designId,
      designName: earlier.snapshot.name,
      earlier: { id: earlier.id, version: earlier.version, publishedAt: earlier.publishedAt },
      later: { id: later.id, version: later.version, publishedAt: later.publishedAt },
      width: later.snapshot.width,
      height: later.snapshot.height,
    },
    diff: r.comparison,
  };
}

// GET：同一图纸 + 两个版本号（最易在浏览器/curl 调用）
//   /api/designs/:designId/publications/diff?fromVersion=1&toVersion=2
app.get('/api/designs/:designId/publications/diff', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const fromVersion = Number(req.query.fromVersion);
  const toVersion = Number(req.query.toVersion);
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) ||
      fromVersion <= 0 || toVersion <= 0) {
    return fail(res, 400, 'fromVersion/toVersion 必须是正整数版本号');
  }
  const pubA = db.getPublicationByVersion(design.id, fromVersion);
  if (!pubA) return fail(res, 404, `发布版 v${fromVersion} 不存在`);
  const pubB = db.getPublicationByVersion(design.id, toVersion);
  if (!pubB) return fail(res, 404, `发布版 v${toVersion} 不存在`);
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

// POST：两个发布版 id（可跨图纸时明确报错）
//   { publicationIdA: 1, publicationIdB: 2 }
app.post('/api/publications/diff', (req, res) => {
  const body = req.body || {};
  const idA = Number(body.publicationIdA);
  const idB = Number(body.publicationIdB);
  if (!Number.isInteger(idA) || !Number.isInteger(idB) || idA <= 0 || idB <= 0) {
    return fail(res, 400, 'publicationIdA/publicationIdB 必须是发布版的正整数 id');
  }
  const pubA = db.getPublicationById(idA);
  if (!pubA) return fail(res, 404, `发布版 id=${idA} 不存在`);
  const pubB = db.getPublicationById(idB);
  if (!pubB) return fail(res, 404, `发布版 id=${idB} 不存在`);
  if (pubA.designId !== pubB.designId) {
    return fail(res, 400, '两个发布版不属于同一图纸，不能核对铅条', {
      designIdA: pubA.designId,
      designIdB: pubB.designId,
    });
  }
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

// ---------- 已发布图纸 1:1 分张打印（只读，不改草稿/发布版/计划/库存） ----------

// 由版本号加载发布版，不存在时按调用方要求返回 404
function loadVersionOrReject(res, designId, version) {
  const pub = db.getPublicationByVersion(designId, version);
  if (!pub) {
    fail(res, 404, `发布版 v${version} 不存在`);
    return null;
  }
  return pub;
}

// POST /api/designs/:designId/publications/:version/print/preview
//   body: { paperWidth, paperHeight, margin, overlap }（整数毫米）
//   返回行列总页数、每页覆盖的图纸坐标与拼接标记；非法输入整单拒绝，不输出部分页面。
app.post('/api/designs/:designId/publications/:version/print/preview', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) return fail(res, 400, '版本号必须是正整数');
  const pub = loadVersionOrReject(res, design.id, version);
  if (!pub) return;
  const pr = printSheet.parseParams(req.body || {});
  if (!pr.ok) {
    return res.status(pr.status).json({ ok: false, error: pr.error, code: pr.code });
  }
  const built = printSheet.buildLayout(pub.snapshot, pr.params);
  if (!built.ok) {
    return res.status(built.status).json({
      ok: false, error: built.error, code: built.code,
      cols: built.cols, rows: built.rows, totalPages: built.totalPages, maxPages: built.maxPages,
    });
  }
  res.json({
    ok: true,
    preview: {
      designId: design.id,
      designName: pub.snapshot.name,
      version,
      publicationId: pub.id,
      print: printSheet.serializePreview(design.id, version, built.layout),
    },
  });
});

// GET /api/designs/:designId/publications/:version/print/page
//   query: paperWidth,paperHeight,margin,overlap,page（与预览相同的整数毫米参数）
//   返回该页 SVG（image/svg+xml，物理尺寸 mm）。
app.get('/api/designs/:designId/publications/:version/print/page', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) return fail(res, 400, '版本号必须是正整数');
  const pub = loadVersionOrReject(res, design.id, version);
  if (!pub) return;
  const q = req.query || {};
  const pr = printSheet.parseParams({
    paperWidth: Number(q.paperWidth), paperHeight: Number(q.paperHeight),
    margin: Number(q.margin), overlap: Number(q.overlap),
  });
  if (!pr.ok) {
    return res.status(pr.status).json({ ok: false, error: pr.error, code: pr.code });
  }
  const built = printSheet.buildLayout(pub.snapshot, pr.params);
  if (!built.ok) {
    return res.status(built.status).json({
      ok: false, error: built.error, code: built.code,
      cols: built.cols, rows: built.rows, totalPages: built.totalPages, maxPages: built.maxPages,
    });
  }
  const pageNo = Number(q.page);
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > built.layout.totalPages) {
    return fail(res, 400, `页码必须是 1–${built.layout.totalPages} 之间的整数`);
  }
  const page = built.layout.pages.find((p) => p.page === pageNo);
  const svg = printSheet.pageSvg(pub, pr.params, page);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // 文件名仅用 ASCII（图纸名可能含中文/特殊字符）
  res.setHeader('Content-Disposition',
    `inline; filename="design-${design.id}-v${version}-page-${pageNo}of${built.layout.totalPages}.svg"`);
  res.send(svg);
});

app.get('/api/designs/:designId/publications/:version', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pub = db.getPublicationByVersion(design.id, Number(req.params.version));
  if (!pub) return fail(res, 404, '发布版不存在');
  res.json({ ok: true, publication: pub });
});

// ---------- 跨图纸拼片复用（已发布快照 → 目标图纸草稿，预览后确认整批写入） ----------

// 解析来源发布版：优先全局 publicationId；否则 sourceDesignId + 版本号（目标图纸外的版本号）。
// 返回 { pub } 或由调用方用 res 直接报错。
function resolveSourcePublication(res, p) {
  if (p.publicationId !== null) {
    const pub = db.getPublicationById(p.publicationId);
    if (!pub) {
      fail(res, 404, `来源发布版 id=${p.publicationId} 不存在`, { code: 'source_not_found' });
      return null;
    }
    return pub;
  }
  const sourceDesign = db.getDesign(p.sourceDesignId);
  if (!sourceDesign) {
    fail(res, 404, `来源图纸 #${p.sourceDesignId} 不存在`, { code: 'source_not_found' });
    return null;
  }
  const pub = db.getPublicationByVersion(p.sourceDesignId, p.sourceVersion);
  if (!pub) {
    fail(res, 404, `来源图纸 #${p.sourceDesignId} 的发布版 v${p.sourceVersion} 不存在`,
      { code: 'source_not_found' });
    return null;
  }
  return pub;
}

// 仅对 pending 预览返回行，否则给出对应错误
function loadPendingImportOrReject(res, id) {
  const rec = db.getPieceImportRow(id);
  if (!rec) { fail(res, 404, '复用预览不存在'); return null; }
  if (rec.status === 'confirmed') {
    res.status(409).json({
      ok: false, code: 'already_confirmed',
      error: '该复用预览已确认，不能重复确认；如需再次导入请重新预览',
      pieceImport: db.getPieceImport(id),
    });
    return null;
  }
  return rec;
}

// POST /api/designs/:designId/imports/preview
//   { publicationId } 或 { sourceDesignId, sourceVersion }
//   { pieceNos:[...不重复来源片号], rotation:0|90|180|270, dx,dy 整数毫米 }
// 预览落库（pending）但不写拼片；返回转换后轮廓/颜色/目标位置、目标草稿与模拟覆盖状态。
app.post('/api/designs/:designId/imports/preview', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const parsed = importPieces.parseImportBody(req.body || {});
  if (!parsed.ok) return fail(res, 400, parsed.error);
  const p = parsed.params;
  const pub = resolveSourcePublication(res, p);
  if (!pub) return;

  const existingPieces = db.listPieces(design.id);
  const built = importPieces.buildPreview(design, existingPieces, pub, p);
  if (!built.ok) {
    if (built.code === 'source_piece_not_found') {
      return res.status(404).json({
        ok: false,
        code: 'source_piece_not_found',
        error: `来源发布版（${pub.snapshot.name} v${pub.version}）中不存在拼片编号：${built.missing.map((n) => `#${n}`).join('、')}`,
        source: { publicationId: pub.id, designId: pub.designId, version: pub.version },
        missing: built.missing,
      });
    }
    // geometry_conflict
    return res.status(422).json({
      ok: false,
      code: 'geometry_conflict',
      error: '转换后存在几何冲突（越界或面积重叠），整批未写入；请调整旋转/平移或改选拼片后重新预览',
      problems: built.problems,
    });
  }

  const rec = db.createPieceImport({
    targetDesignId: design.id,
    publicationId: pub.id,
    sourceDesignId: pub.designId,
    sourceVersion: pub.version,
    rotation: p.rotation,
    dx: p.dx,
    dy: p.dy,
    pieceNos: p.pieceNos,
    items: built.previewData.items.map((it) => ({
      index: it.index,
      sourcePieceNo: it.sourcePieceNo,
      color: it.color,
      rotation: it.rotation,
      dx: it.dx,
      dy: it.dy,
      polygon: it.polygon,
      bounds: it.bounds,
      area: it.area,
    })),
    draftFingerprint: built.previewData.draftToken,
  });
  res.status(201).json({
    ok: true,
    preview: {
      id: rec.id,
      status: rec.status,
      ...built.previewData,
      draftToken: rec.draftFingerprint,
    },
  });
});

// GET /api/designs/:designId/imports —— 复用预览列表（pending 在前？默认全部，按 id 倒序）
app.get('/api/designs/:designId/imports', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const status = req.query.status;
  if (status !== undefined && status !== 'pending' && status !== 'confirmed') {
    return fail(res, 400, 'status 只能是 pending 或 confirmed');
  }
  const imports = db.listPieceImports({ targetDesignId: design.id, ...(status ? { status } : {}) });
  res.json({ ok: true, imports });
});

// GET /api/designs/:designId/imports/:importId —— 单个预览/确认结果（页面刷新后恢复）
app.get('/api/designs/:designId/imports/:importId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const importId = Number(req.params.importId);
  if (!Number.isInteger(importId) || importId <= 0) return fail(res, 400, '导入预览 id 必须是正整数');
  const rec = db.getPieceImport(importId);
  if (!rec || rec.targetDesignId !== design.id) return fail(res, 404, '复用预览不存在');
  const stale = rec.status === 'pending' &&
    rec.draftFingerprint !== importPieces.draftFingerprint(db.listPieces(design.id));
  res.json({ ok: true, pieceImport: rec, stale });
});

// POST /api/designs/:designId/imports/:importId/confirm —— 整批确认
//   同事务重核草稿指纹与几何；通过则整批赋予目标图纸新编号（保留原色）。
app.post('/api/designs/:designId/imports/:importId/confirm', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const importId = Number(req.params.importId);
  if (!Number.isInteger(importId) || importId <= 0) return fail(res, 400, '导入预览 id 必须是正整数');
  const rec = loadPendingImportOrReject(res, importId);
  if (!rec) return;
  if (rec.target_design_id !== design.id) return fail(res, 404, '复用预览不属于该图纸');

  const result = db.confirmPieceImport(importId, {
    checkFingerprint: (existingPieces, expected) =>
      importPieces.draftFingerprint(existingPieces) === expected,
    checkGeometry: (frame, existingPieces, items) =>
      importPieces.validateBatch(frame, existingPieces, items),
  });

  if (result.code === 'ok') {
    return res.status(201).json({
      ok: true,
      pieceImport: result.pieceImport,
      addedPieces: result.confirmedPieces,
      draft: draftSummary(db.getDesign(design.id)),
    });
  }
  if (result.code === 'already_confirmed') {
    return res.status(409).json({
      ok: false, code: 'already_confirmed',
      error: '该复用预览已确认，不能重复确认；如需再次导入请重新预览',
      pieceImport: result.pieceImport,
    });
  }
  if (result.code === 'draft_changed') {
    return res.status(409).json({
      ok: false, code: 'draft_changed',
      error: '目标草稿在预览后已被编辑（新增/修改/删除拼片），请重新预览后再确认；整批未写入',
    });
  }
  if (result.code === 'geometry_conflict') {
    return res.status(422).json({
      ok: false, code: 'geometry_conflict',
      error: '目标草稿当前状态下转换后拼片存在几何冲突，整批未写入；请重新预览',
      problems: result.problems,
    });
  }
  if (result.code === 'target_not_found') return fail(res, 404, '目标图纸不存在');
  return fail(res, 500, '确认失败');
});

// DELETE /api/designs/:designId/imports/:importId —— 仅可删除 pending 预览
app.delete('/api/designs/:designId/imports/:importId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const importId = Number(req.params.importId);
  if (!Number.isInteger(importId) || importId <= 0) return fail(res, 400, '导入预览 id 必须是正整数');
  const rec = db.getPieceImport(importId);
  if (!rec || rec.targetDesignId !== design.id) return fail(res, 404, '复用预览不存在');
  const r = db.deletePieceImport(importId);
  if (r.code === 'not_pending') {
    return fail(res, 409, '已确认的复用记录永久保留，不能删除');
  }
  res.json({ ok: true });
});

// ---------- 铅条原材库存 ----------

const MATERIAL_NAME_MAX = 80;

app.get('/api/materials', (req, res) => {
  res.json({ ok: true, materials: db.listMaterials() });
});

app.get('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  res.json({ ok: true, material });
});

app.post('/api/materials', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return fail(res, 400, '规格名称必填');
  if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
  const len = cut.parseLen2(Number(body.length), { name: '原材定尺', positive: true });
  if (!len.ok) return fail(res, 400, len.error);
  const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
  if (!stock.ok) return fail(res, 400, stock.error);
  if (db.getMaterialByName(name)) return fail(res, 409, '同名规格已存在');
  const material = db.createMaterial({ name, lengthH: len.h, stock: stock.n });
  res.status(201).json({ ok: true, material });
});

// 修改规格名/库存根数（定尺不可改）。库存不得小于已预留根数。
app.patch('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  const body = req.body || {};
  const fields = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail(res, 400, '规格名称必填');
    if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
    fields.name = name;
  }
  if (body.stock !== undefined) {
    const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
    if (!stock.ok) return fail(res, 400, stock.error);
    fields.stock = stock.n;
  }
  if (body.length !== undefined) {
    return fail(res, 400, '定尺属于规格身份不可修改；请新建规格');
  }
  if (!('name' in fields) && !('stock' in fields)) {
    return fail(res, 400, '没有可更新字段（name 或 stock）');
  }
  const r = db.updateMaterial(material.id, fields);
  if (r.code === 'name_taken') return fail(res, 409, '同名规格已存在');
  if (r.code === 'stock_below_reserved') {
    return fail(res, 409, `库存不得小于已确认计划预留根数（${r.reserved}）`, { reserved: r.reserved });
  }
  res.json({ ok: true, material: r.material });
});

// ---------- 铅条生产计划 ----------

const PLAN_NAME_MAX = 80;
const COPIES_MAX = 10000;

// 解析并校验排产参数；返回 { error }（HTTP 层据此拒绝，且绝不改库存）或 { pub, material, copies, kerfH }
function resolvePlanInputs(body) {
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };

  const materialId = Number(body.materialId);
  if (!Number.isInteger(materialId) || materialId <= 0) {
    return { error: 'materialId 必须是原材规格的正整数 id' };
  }
  const material = db.getMaterial(materialId);
  if (!material) return { error: '原材规格不存在', status: 404 };
  // 精确定尺（整数厘）取自数据库原始行，不走毫米浮点往返
  const materialRow = db.getMaterialRow(materialId);
  material.lengthH = materialRow.length_h;

  const copiesR = cut.parsePositiveInt(Number(body.copies), { name: '件数', max: COPIES_MAX });
  if (!copiesR.ok) return { error: copiesR.error };

  const kerfR = cut.parseLen2(Number(body.kerf), { name: '每刀损耗', positive: false });
  if (!kerfR.ok) return { error: kerfR.error };

  return { pub, material, copies: copiesR.n, kerfH: kerfR.h };
}

// 依据发布快照 + 参数生成切段方案（长度均换算为毫米输出，不访问/修改库存计数）
function buildPlanLayout({ pub, material, copies, kerfH }) {
  const segs = cut.segmentsFromSnapshot(pub.snapshot);
  if (!segs.ok) return { error: segs.error };
  const result = cut.planCuts({
    segments: segs.segments,
    copies,
    stockLenH: material.lengthH,
    kerfH,
  });
  if (!result.ok) {
    if (result.code === 'segment_too_long') {
      return {
        error: result.error,
        status: 422,
        code: result.code,
        segment: serializeSegmentBrief(result.segment, kerfH),
      };
    }
    return { error: result.error, status: 400, code: result.code };
  }
  return { layout: serializeLayout(result, material) };
}

function serializeSegmentBrief(seg, kerfH) {
  return {
    name: seg.name,
    source: seg.source,
    length: cut.hToMm(seg.lengthH),
    withKerf: cut.hToMm(seg.lengthH + kerfH),
  };
}

function serializeLayout(result, material) {
  const kerfH = result.segmentCount ? result.totalKerfH / result.segmentCount : 0;
  return {
    materialLength: cut.hToMm(material.lengthH),
    kerf: cut.hToMm(kerfH),
    segmentCount: result.segmentCount,
    requiredBars: result.requiredBars,
    totals: {
      segmentCount: result.segmentCount,
      finishedLength: cut.hToMm(result.totalFinishedH),
      kerfTotal: cut.hToMm(result.totalKerfH),
      remainderTotal: cut.hToMm(result.totalRemainderH),
    },
    bars: result.bars.map((b) => ({
      index: b.index,
      usedLength: cut.hToMm(b.usedH),
      remainder: cut.hToMm(b.remainderH),
      cuts: b.cuts.map((c) => ({
        piece: c.piece,
        source: c.source,
        sourceNo: c.sourceNo,
        name: c.name,
        length: cut.hToMm(c.lengthH),
        kerf: cut.hToMm(c.kerfH),
        from: c.from,
        to: c.to,
      })),
    })),
  };
}

// 预览（POST /api/plans/preview）：不落库、不预留
app.post('/api/plans/preview', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const material = db.getMaterial(inp.material.id); // 取最新 stock/reserved/available
  const shortage = Math.max(0, built.layout.requiredBars - material.available);
  res.json({
    ok: true,
    preview: {
      publicationId: inp.pub.id,
      designId: inp.pub.designId,
      version: inp.pub.version,
      copies: inp.copies,
      kerf: cut.hToMm(inp.kerfH),
      material: materialBrief(material),
      layout: built.layout,
      requiredBars: built.layout.requiredBars,
      availableBars: material.available,
      shortage,
      feasible: shortage === 0,
    },
  });
});

// 建草稿计划
app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : `v${inp.pub.version} ×${inp.copies}件 · ${inp.material.name}`;
  const plan = db.createPlan({
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  res.status(201).json({ ok: true, plan: serializePlan(plan) });
});

app.get('/api/plans', (req, res) => {
  res.json({ ok: true, plans: db.listPlans().map(serializePlan) });
});

app.get('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  res.json({ ok: true, plan: serializePlan(plan) });
});

// 修改草稿（重新选版本/件数/原材/刀损并重算切段）
app.put('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  if (plan.comboId) {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: plan.comboId,
      error: `该计划属于整套用料单 #${plan.comboId}，只能随整套单取消，不能单独修改`,
    });
  }
  if (plan.status !== 'draft') {
    return fail(res, 409, `仅草稿计划可修改（当前为 ${statusZh(plan.status)}）`);
  }
  const body = req.body || {};
  // 未传字段沿用旧值
  const merged = {
    publicationId: body.publicationId !== undefined ? Number(body.publicationId) : plan.publicationId,
    materialId: body.materialId !== undefined ? Number(body.materialId) : plan.materialId,
    copies: body.copies !== undefined ? Number(body.copies) : plan.copies,
    kerf: body.kerf !== undefined ? Number(body.kerf) : plan.kerf,
  };
  const inp = resolvePlanInputs(merged);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : plan.name;
  const r = db.updatePlanDraft(plan.id, {
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  if (r.code !== 'ok') return fail(res, 409, '计划状态已变化，请刷新后重试');
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 确认：原子预留库存；重复确认不会重复扣减
app.post('/api/plans/:planId/confirm', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.confirmPlan(plan.id);
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该计划属于整套用料单 #${r.comboId}，不能从计划入口单独确认或取消，请在整套单中操作`,
    });
  }
  if (r.code === 'already_confirmed') {
    return res.status(409).json({ ok: false, error: '计划已确认，无需重复确认（库存未重复预留）', plan: serializePlan(db.getPlan(plan.id)) });
  }
  if (r.code === 'plan_canceled') return fail(res, 409, '计划已取消，不能确认；请新建计划');
  if (r.code === 'material_missing') return fail(res, 409, '原材规格已不存在，无法确认');
  if (r.code === 'material_changed') {
    return fail(res, 409, '原材定尺自计划创建后已变化，请按新规格重建计划');
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      error: `可用原材不足：需用 ${r.required} 根，当前可用 ${r.available} 根，缺口 ${r.shortage} 根，不能确认`,
      code: 'shortage',
      requiredBars: r.required,
      availableBars: r.available,
      shortage: r.shortage,
    });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 取消：仅释放一次预留；重复取消不重复改库存
app.post('/api/plans/:planId/cancel', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.cancelPlan(plan.id);
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该计划属于整套用料单 #${r.comboId}，取消整套单时会一并释放铅条预留，不能单独取消`,
    });
  }
  if (r.code === 'draft_not_reserved') {
    return fail(res, 409, '草稿计划尚未预留库存，无需取消（可直接删除）');
  }
  if (r.code === 'already_issued') {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: `该计划已有领料记录（已领 ${r.picked} 根），已领料单据不能取消`,
      pickedBars: r.picked,
    });
  }
  if (r.code === 'already_canceled') {
    return res.status(409).json({ ok: false, error: '计划已取消，库存此前已释放，未重复变更', plan: serializePlan(db.getPlan(plan.id)) });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 删除草稿/已取消计划（已确认计划须先取消）
app.delete('/api/plans/:planId', (req, res) => {
  const r = db.deletePlan(Number(req.params.planId));
  if (r.code === 'not_found') return fail(res, 404, '生产计划不存在');
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该计划属于整套用料单 #${r.comboId}，不能单独删除（整套单取消后仍保留关联记录供查阅）`,
    });
  }
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认计划不能删除；请先取消以释放库存');
  }
  res.json({ ok: true });
});

function materialBrief(material) {
  return {
    id: material.id,
    name: material.name,
    length: material.length,
    stock: material.stock,
    reserved: material.reserved,
    grossReserved: material.grossReserved,
    picked: material.picked,
    remainingReserved: material.remainingReserved,
    available: material.available,
  };
}

function statusZh(status) {
  return status === 'draft' ? '草稿' : status === 'confirmed' ? '已确认' : '已取消';
}

// 计划输出：绑定的发布版本与排产方案为快照；同时附带当前库存视图供网页展示
function serializePlan(plan) {
  const material = db.getMaterial(plan.materialId);
  const shortage = Math.max(0, plan.requiredBars - (material ? material.available : 0));
  const issueStats = db.getPlanIssueStats(plan.id);
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    statusText: statusZh(plan.status),
    publicationId: plan.publicationId,
    designId: plan.designId,
    version: plan.version,
    copies: plan.copies,
    kerf: plan.kerf,
    requiredBars: plan.requiredBars,
    segmentCount: plan.segmentCount,
    layout: plan.layout,
    pickedBars: issueStats.pickedBars,
    remainingBars: issueStats.remainingBars,
    issueCount: new Set(db.listIssueRows({ planId: plan.id }).map((r) => r.issue_no)).size,
    material: material
      ? materialBrief(material)
      : { id: plan.materialId, name: plan.materialName, length: plan.materialLength, unavailable: true },
    availableBars: material ? material.available : 0,
    shortage: plan.status === 'draft' ? shortage : 0,
    feasible: plan.status !== 'draft' || shortage === 0,
    snapshotBound: true,
    comboId: plan.comboId,
    comboLocked: !!plan.comboId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    confirmedAt: plan.confirmedAt,
    canceledAt: plan.canceledAt,
  };
}

// ---------- 彩色玻璃原片库存（每种颜色一种规格） ----------

app.get('/api/glass-sheets', (req, res) => {
  res.json({ ok: true, sheets: db.listGlassSheets() });
});

app.get('/api/glass-sheets/:sheetId', (req, res) => {
  const sheet = db.getGlassSheet(Number(req.params.sheetId));
  if (!sheet) return fail(res, 404, '该颜色原片规格不存在');
  res.json({ ok: true, sheet });
});

app.post('/api/glass-sheets', (req, res) => {
  const pr = sheetNest.parseSheetBody(req.body || {});
  if (!pr.ok) return fail(res, 400, pr.error);
  const { color, width, height, stock } = pr.params;
  if (db.getGlassSheetByColorRow(color)) {
    return fail(res, 409, `颜色 ${color} 的原片规格已登记（一种颜色仅可登记一种规格）`);
  }
  const sheet = db.createGlassSheet({ color, width, height, stock });
  res.status(201).json({ ok: true, sheet });
});

// 仅允许调整库存张数；颜色/宽高属规格身份不可改。库存不得低于已预留。
app.patch('/api/glass-sheets/:sheetId', (req, res) => {
  const sheet = db.getGlassSheet(Number(req.params.sheetId));
  if (!sheet) return fail(res, 404, '该颜色原片规格不存在');
  const body = req.body || {};
  if (body.color !== undefined) return fail(res, 400, '颜色属于规格身份不可修改；请登记新颜色');
  if (body.width !== undefined || body.height !== undefined) {
    return fail(res, 400, '原片宽高属于规格身份不可修改；请登记新规格');
  }
  if (body.stock === undefined) return fail(res, 400, '没有可更新字段（仅支持 stock）');
  const stock = Number(body.stock);
  if (!Number.isInteger(stock) || stock < 0) {
    return fail(res, 400, '库存张数必须是不小于 0 的整数');
  }
  const r = db.updateGlassSheetStock(sheet.id, stock);
  if (r.code === 'stock_below_reserved') {
    const floor = r.floor;
    const detail = r.quarantined > 0
      ? `（净预留 ${r.reserved} + 瑕疵隔离 ${r.quarantined} = ${floor} 张）`
      : `（${r.reserved} 张）`;
    return res.status(409).json({
      ok: false, code: 'stock_below_reserved',
      error: `库存不得小于净预留与瑕疵隔离量之和${detail}`,
      reserved: r.reserved, quarantined: r.quarantined, floor,
    });
  }
  res.json({ ok: true, sheet: r.sheet });
});

// ---------- 裁片订单 ----------

const ORDER_NAME_MAX = 80;

// 解析 { publicationId, copies, gap }；返回 { error,status } 或 { pub, copies, gap }
function resolveNestInputs(body) {
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };
  const pr = sheetNest.parseNestingParams(body);
  if (!pr.ok) return { error: pr.error };
  return { pub, copies: pr.params.copies, gap: pr.params.gap };
}

// 取“颜色 -> 规格（宽/高/id）”，排样只用宽高；库存视图由 serialize 补
function sheetSpecMap() {
  const m = new Map();
  for (const s of db.listGlassSheets()) {
    m.set(s.color, { id: s.id, width: s.width, height: s.height, stock: s.stock });
  }
  return m;
}

// 生成排样方案；失败整体返回（不落库、不占库存）
function buildNestLayout(pub, copies, gap) {
  const specs = sheetSpecMap();
  const specByColor = new Map();
  for (const [color, s] of specs) specByColor.set(color, { width: s.width, height: s.height });
  const r = sheetNest.nestBySnapshot(pub.snapshot, specByColor, copies, gap);
  if (!r.ok) {
    return {
      error: r.error, status: r.status || 422, code: r.code,
      color: r.color, pieceNo: r.pieceNo, copy: r.copy,
      pieceWidth: r.pieceWidth, pieceHeight: r.pieceHeight,
      sheetWidth: r.sheetWidth, sheetHeight: r.sheetHeight,
      totalSheets: r.totalSheets, maxSheets: r.maxSheets,
    };
  }
  return { layout: r.layout, specs };
}

// 汇总各色用板数与库存缺口
function colorSummaries(layout, specs) {
  return layout.colors.map((c) => {
    const spec = specs.get(c.color);
    const stock = spec ? spec.stock : 0;
    const sheet = spec ? db.getGlassSheet(spec.id) : null;
    const reserved = sheet ? sheet.reserved : 0;
    const quarantined = sheet ? sheet.quarantined : 0;
    const available = sheet ? sheet.available : 0;
    return {
      color: c.color,
      sheetId: spec ? spec.id : null,
      sheetWidth: c.sheetWidth,
      sheetHeight: c.sheetHeight,
      requiredSheets: c.requiredSheets,
      stock,
      reserved,
      quarantined,
      available,
      shortage: Math.max(0, c.requiredSheets - available),
    };
  });
}

function nestPreviewPayload({ pub, copies, gap, layout, specs, includeItems = false }) {
  const colors = colorSummaries(layout, specs);
  const totalShortage = colors.reduce((s, c) => s + c.shortage, 0);
  const payload = {
    publicationId: pub.id,
    designId: pub.designId,
    version: pub.version,
    copies,
    gap,
    layout,
    totalSheets: layout.totalSheets,
    maxSheets: layout.maxSheets,
    colors,
    totalShortage,
    feasible: totalShortage === 0,
  };
  if (includeItems) {
    payload.items = colors.map((c) => ({
      sheetId: c.sheetId, color: c.color,
      width: c.sheetWidth, height: c.sheetHeight,
      requiredSheets: c.requiredSheets,
    }));
  }
  return payload;
}

function failNest(res, built) {
  return res.status(built.status || 422).json({
    ok: false,
    error: built.error,
    code: built.code,
    color: built.color,
    pieceNo: built.pieceNo,
    copy: built.copy,
    pieceWidth: built.pieceWidth,
    pieceHeight: built.pieceHeight,
    sheetWidth: built.sheetWidth,
    sheetHeight: built.sheetHeight,
    totalSheets: built.totalSheets,
    maxSheets: built.maxSheets,
  });
}

// 预览（不落库、不占库存）
app.post('/api/cut-orders/preview', (req, res) => {
  const inp = resolveNestInputs(req.body || {});
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  res.json({
    ok: true,
    preview: nestPreviewPayload({
      pub: inp.pub, copies: inp.copies, gap: inp.gap,
      layout: built.layout, specs: built.specs,
    }),
  });
});

function orderNameFrom(body, pub, copies) {
  return typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : `玻璃裁片 v${pub.version} ×${copies}件`;
}

// 建草稿订单
app.post('/api/cut-orders', (req, res) => {
  const body = req.body || {};
  const inp = resolveNestInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = nestPreviewPayload({
    pub: inp.pub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs, includeItems: true,
  });
  if (preview.items.some((it) => it.sheetId === null)) {
    // 理论上 missing_color 已在排样阶段拦截；双保险
    return fail(res, 422, '缺少对应颜色的原片规格');
  }
  const order = db.createCutOrder({
    name: orderNameFrom(body, inp.pub, inp.copies),
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items: preview.items,
  });
  res.status(201).json({ ok: true, order: serializeCutOrder(order) });
});

app.get('/api/cut-orders', (req, res) => {
  res.json({ ok: true, orders: db.listCutOrders().map(serializeCutOrder) });
});

app.get('/api/cut-orders/:orderId', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  res.json({ ok: true, order: serializeCutOrder(order) });
});

// 修改草稿（重选版本/件数/间距并重算排样）
app.put('/api/cut-orders/:orderId', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  if (order.comboId) {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: order.comboId,
      error: `该裁片订单属于整套用料单 #${order.comboId}，只能随整套单取消，不能单独修改`,
    });
  }
  if (order.status !== 'draft') {
    return fail(res, 409, `仅草稿订单可修改（当前为 ${cutStatusZh(order.status)}）`);
  }
  const body = req.body || {};
  const merged = {
    publicationId: body.publicationId !== undefined ? Number(body.publicationId) : order.publicationId,
    copies: body.copies !== undefined ? Number(body.copies) : order.copies,
    gap: body.gap !== undefined ? Number(body.gap) : order.gap,
  };
  const inp = resolveNestInputs(merged);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = nestPreviewPayload({
    pub: inp.pub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs, includeItems: true,
  });
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : order.name;
  const r = db.updateCutOrderDraft(order.id, {
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items: preview.items,
  });
  if (r.code !== 'ok') return fail(res, 409, '订单状态已变化，请刷新后重试');
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

// 确认：原子预留所有颜色所需原片；任一颜色不足整单失败（409）
app.post('/api/cut-orders/:orderId/confirm', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  const r = db.confirmCutOrder(order.id);
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该裁片订单属于整套用料单 #${r.comboId}，确认整套单时已一并预留玻璃，不能从裁片入口单独操作`,
    });
  }
  if (r.code === 'already_confirmed') {
    return res.status(409).json({
      ok: false, error: '订单已确认，无需重复确认（库存未重复预留）',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'order_canceled') return fail(res, 409, '订单已取消，不能确认；请新建订单');
  if (r.code === 'order_replaced') {
    return res.status(409).json({
      ok: false, code: 'order_replaced',
      error: '该订单已被换单替换，不能再确认、取消或修改',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，无法确认`);
  if (r.code === 'sheet_changed') {
    return fail(res, 409, `颜色 ${r.color} 的原片规格自订单创建后已变化，请按新规格重建订单`);
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      code: 'shortage',
      error: '部分颜色原片库存不足，整单未确认（未预留任何一张）',
      shortages: r.shortages,
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

// 取消：只释放一次；重复取消不重复改库存
app.post('/api/cut-orders/:orderId/cancel', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  const r = db.cancelCutOrder(order.id);
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该裁片订单属于整套用料单 #${r.comboId}，取消整套单时会一并释放玻璃预留，不能单独取消`,
    });
  }
  if (r.code === 'draft_not_reserved') {
    return fail(res, 409, '草稿订单尚未预留库存，无需取消（可直接删除）');
  }
  if (r.code === 'already_issued') {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: '该裁片订单已有领料记录，已领料单据不能取消',
    });
  }
  if (r.code === 'already_canceled') {
    return res.status(409).json({
      ok: false, error: '订单已取消，库存此前已释放，未重复变更',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'order_replaced') {
    return res.status(409).json({
      ok: false, code: 'order_replaced',
      error: '订单已被换单替换（预留已转给新单），不能再取消或修改',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

app.delete('/api/cut-orders/:orderId', (req, res) => {
  const r = db.deleteCutOrder(Number(req.params.orderId));
  if (r.code === 'not_found') return fail(res, 404, '裁片订单不存在');
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该裁片订单属于整套用料单 #${r.comboId}，不能单独删除（整套单取消后仍保留关联记录供查阅）`,
    });
  }
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认订单不能删除；请先取消以释放库存');
  }
  if (r.code === 'replaced_delete_blocked') {
    return res.status(409).json({ ok: false, code: 'order_replaced',
      error: '已替换的订单为历史记录，不能删除，仅可查阅' });
  }
  res.json({ ok: true });
});

// ---------- 裁片订单换单（已确认旧单 → 同图纸另一已发布版本） ----------

// 解析换单目标：可传 targetPublicationId（全局发布版 id）或 targetVersion（该图纸版本号）。
// copies/gap 省略时沿用旧单参数。目标必须存在、与旧单同图纸、且不同于旧单当前版本。
function resolveReplaceInputs(body, order) {
  const b = body || {};
  let targetId = NaN;
  if (b.targetPublicationId !== undefined) {
    targetId = Number(b.targetPublicationId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return { error: 'targetPublicationId 必须是已发布版本的正整数 id' };
    }
  } else if (b.targetVersion !== undefined) {
    const tv = Number(b.targetVersion);
    if (!Number.isInteger(tv) || tv <= 0) return { error: 'targetVersion 必须是正整数版本号' };
    const pubV = db.getPublicationByVersion(order.designId, tv);
    if (!pubV) return { error: `发布版 v${tv} 不存在`, status: 404, code: 'target_not_found' };
    targetId = pubV.id;
  } else {
    return { error: '必须提供 targetPublicationId（或 targetVersion）指定换到的发布版本' };
  }
  const target = db.getPublicationById(targetId);
  if (!target) return { error: '目标发布版不存在', status: 404, code: 'target_not_found' };
  if (target.designId !== order.designId) {
    return {
      error: '目标发布版与旧单不属于同一图纸，不能换单',
      status: 400, code: 'different_design',
      oldDesignId: order.designId, targetDesignId: target.designId,
    };
  }
  if (target.id === order.publicationId) {
    return { error: '目标版本与旧单当前版本相同，无需换单', status: 400, code: 'same_version' };
  }
  const copies = b.copies !== undefined ? Number(b.copies) : order.copies;
  const gap = b.gap !== undefined ? Number(b.gap) : order.gap;
  const pr = sheetNest.parseNestingParams({ copies, gap });
  if (!pr.ok) return { error: pr.error };
  return { target, copies: pr.params.copies, gap: pr.params.gap };
}

// 仅已确认订单可以换单；其余状态明确拒绝。
function rejectIfNotConfirmed(res, order) {
  if (order.status === 'confirmed') return false;
  if (order.status === 'replaced') {
    return res.status(409).json({
      ok: false, code: 'order_replaced',
      error: '该订单已被换单替换，不能再次换单、取消或修改；请在接替的新单上操作',
      order: serializeCutOrder(order),
    });
  }
  if (order.status === 'canceled') {
    return res.status(409).json({ ok: false, code: 'order_canceled', error: '旧单已取消，不能换单' });
  }
  return res.status(409).json({ ok: false, code: 'order_not_confirmed', error: '仅已确认订单可以换单；草稿请直接修改或删除后重建' });
}

// 按颜色合并旧单与新排样：旧用板/新用板/净增减/计入旧单释放后的可用量/缺口。
// 旧单自身的预留在此视为即将退出，不计入占用；预览只读、不实际释放。
function replacementColorRows(order, newLayout, specs) {
  const oldItems = db.listCutOrderItems(order.id);
  const oldByColor = new Map(oldItems.map((it) => [it.color, it.requiredSheets]));
  const allColors = new Set([
    ...oldByColor.keys(),
    ...newLayout.colors.map((c) => c.color),
  ]);
  return [...allColors].sort().map((color) => {
    const nc = newLayout.colors.find((c) => c.color === color);
    const oldSheets = oldByColor.get(color) || 0;
    const requiredSheets = nc ? nc.requiredSheets : 0;
    const spec = specs.get(color);
    const sheet = spec ? db.getGlassSheet(spec.id) : null;
    const reserved = sheet ? sheet.reserved : 0; // 当前全部已确认单预留（含旧单）
    const quarantined = sheet ? sheet.quarantined : 0; // 瑕疵隔离量（不因换单变化）
    const availableAfter = sheet ? sheet.stock - (reserved - oldSheets) - quarantined : 0;
    return {
      color,
      sheetId: spec ? spec.id : null,
      sheetWidth: nc ? nc.sheetWidth : (sheet ? sheet.width : null),
      sheetHeight: nc ? nc.sheetHeight : (sheet ? sheet.height : null),
      oldSheets,
      requiredSheets,
      netChange: requiredSheets - oldSheets,
      stock: sheet ? sheet.stock : 0,
      reserved,
      quarantined,
      availableAfter,
      shortage: Math.max(0, requiredSheets - availableAfter),
    };
  });
}

function replacementPayload(order, inp, built) {
  const { layout, specs } = built;
  const colors = replacementColorRows(order, layout, specs);
  const totalShortage = colors.reduce((s, c) => s + c.shortage, 0);
  const oldItems = db.listCutOrderItems(order.id);
  const oldTotal = oldItems.reduce((s, it) => s + it.requiredSheets, 0);
  return {
    oldOrderId: order.id,
    old: {
      orderId: order.id,
      name: order.name,
      publicationId: order.publicationId,
      version: order.version,
      copies: order.copies,
      gap: order.gap,
      totalSheets: oldTotal,
      colors: oldItems.map((it) => ({
        color: it.color, requiredSheets: it.requiredSheets,
        sheetWidth: it.sheetWidth, sheetHeight: it.sheetHeight,
      })),
    },
    target: {
      publicationId: inp.target.id,
      designId: inp.target.designId,
      version: inp.target.version,
    },
    copies: inp.copies,
    gap: inp.gap,
    layout,
    totalSheets: layout.totalSheets,
    maxSheets: layout.maxSheets,
    oldTotalSheets: oldTotal,
    netSheets: layout.totalSheets - oldTotal,
    colors,
    totalShortage,
    feasible: totalShortage === 0,
  };
}

// 换单预览：只读，不落库、不占库存（旧单预留也仍保留）。
app.post('/api/cut-orders/:orderId/replacement/preview', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  if (order.comboId) {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: order.comboId,
      error: `该裁片订单属于整套用料单 #${order.comboId}，不能单独换单；请取消整套单后重新备料`,
    });
  }
  if (rejectIfNotConfirmed(res, order)) return;
  if (db.orderHasIssues(order.id)) {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: '该裁片订单已有领料记录，已领料独立裁片订单不能换单',
      order: serializeCutOrder(order),
    });
  }
  const inp = resolveReplaceInputs(req.body || {}, order);
  if (inp.error) {
    return res.status(inp.status || 400).json({
      ok: false, error: inp.error,
      code: inp.code || (inp.status === 404 ? 'target_not_found' : undefined),
      oldDesignId: inp.oldDesignId, targetDesignId: inp.targetDesignId,
    });
  }
  const built = buildNestLayout(inp.target, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  res.json({ ok: true, preview: replacementPayload(order, inp, built) });
});

// 确认换单：同一事务内旧单退出预留并确认新单；任一颜色不足则全部保持原状。
// 同一旧单相同参数重试返回原新单（幂等）；不同参数返回冲突，均不重复预留。
app.post('/api/cut-orders/:orderId/replacement', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  const body = req.body || {};

  if (order.comboId) {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: order.comboId,
      error: `该裁片订单属于整套用料单 #${order.comboId}，不能换单；整套单的铅条与玻璃必须同生共废`,
    });
  }

  // 已有换单记录：按参数判定幂等/冲突（不重新排样、不写库、不重复预留）
  const record = db.getReplacementByOldOrder(order.id);
  if (record) {
    const inp0 = resolveReplaceInputs(body, order);
    if (inp0.error) {
      return res.status(inp0.status || 400).json({
        ok: false, error: inp0.error, code: inp0.code,
        oldDesignId: inp0.oldDesignId, targetDesignId: inp0.targetDesignId,
      });
    }
    const same = record.target_publication_id === inp0.target.id &&
      record.copies === inp0.copies && record.gap_mm === inp0.gap;
    if (!same) {
      const existingOrder = db.getCutOrder(record.new_order_id);
      return res.status(409).json({
        ok: false,
        code: 'param_conflict',
        error: '该订单已按其他版本/件数/间距完成换单；参数不同不能重复换单（未重复预留）',
        requested: { targetPublicationId: inp0.target.id, copies: inp0.copies, gap: inp0.gap },
        current: {
          targetPublicationId: record.target_publication_id,
          copies: record.copies,
          gap: record.gap_mm,
        },
        newOrder: existingOrder ? serializeCutOrder(existingOrder) : { id: record.new_order_id },
      });
    }
    const existingOrder = db.getCutOrder(record.new_order_id);
    return res.json({
      ok: true,
      idempotent: true,
      order: serializeCutOrder(existingOrder),
      oldOrder: serializeCutOrder(order),
    });
  }

  if (order.status !== 'confirmed') {
    if (order.status === 'canceled') return fail(res, 409, '旧单已取消，不能换单');
    if (order.status === 'replaced') {
      return res.status(409).json({ ok: false, code: 'order_replaced',
        error: '该订单已被换单替换，不能再次换单', order: serializeCutOrder(order) });
    }
    return fail(res, 409, '仅已确认订单可以换单；草稿请直接修改或删除后重建');
  }
  if (order.issueCount > 0 || db.orderHasIssues(order.id)) {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: `该裁片订单已有 ${order.issueCount} 次领料记录，已领料独立裁片订单不能换单`,
      order: serializeCutOrder(order),
    });
  }

  const inp = resolveReplaceInputs(body, order);
  if (inp.error) {
    return res.status(inp.status || 400).json({
      ok: false, error: inp.error,
      code: inp.code || (inp.status === 404 ? 'target_not_found' : undefined),
      oldDesignId: inp.oldDesignId, targetDesignId: inp.targetDesignId,
    });
  }
  const built = buildNestLayout(inp.target, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const payload = replacementPayload(order, inp, built);
  const items = payload.colors
    .filter((c) => c.requiredSheets > 0)
    .map((c) => ({
      sheetId: c.sheetId, color: c.color,
      width: c.sheetWidth, height: c.sheetHeight,
      requiredSheets: c.requiredSheets,
    }));
  if (items.some((it) => it.sheetId === null)) {
    return fail(res, 422, '新排样缺少对应颜色的原片规格'); // 双保险（排样阶段已拦截）
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : `换单 v${order.version}→v${inp.target.version} ×${inp.copies}件`;
  const r = db.replaceCutOrder(order.id, {
    name,
    targetPublicationId: inp.target.id,
    designId: inp.target.designId,
    version: inp.target.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items,
  });
  if (r.code === 'order_replaced') {
    // 并发：记录已由其他请求建立（理论上 HTTP 层已查到；事务内兜底）
    return res.status(409).json({
      ok: false, code: 'order_replaced',
      error: '该订单已被换单替换，不能再次换单',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'combo_locked') {
    return res.status(409).json({
      ok: false, code: 'combo_locked', comboId: r.comboId,
      error: `该裁片订单属于整套用料单 #${r.comboId}，不能换单`,
    });
  }
  if (r.code === 'order_canceled') return fail(res, 409, '旧单已取消，不能换单');
  if (r.code === 'order_not_confirmed') return fail(res, 409, '仅已确认订单可以换单');
  if (r.code === 'already_issued') {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: '该裁片订单已有领料记录，已领料独立裁片订单不能换单',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，无法换单`);
  if (r.code === 'sheet_changed') {
    return fail(res, 409, `颜色 ${r.color} 的原片规格已变化，请刷新后重试`);
  }
  if (r.code === 'param_conflict') {
    const existing = db.getCutOrder(r.newOrderId);
    return res.status(409).json({
      ok: false,
      code: 'param_conflict',
      error: '该订单已按其他版本/件数/间距完成换单；参数不同不能重复换单（未重复预留）',
      requested: { targetPublicationId: inp.target.id, copies: inp.copies, gap: inp.gap },
      current: r.current,
      newOrder: existing ? serializeCutOrder(existing) : { id: r.newOrderId },
    });
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      code: 'shortage',
      error: '计入旧单退出预留后仍有颜色库存不足，换单未执行（旧单、库存与订单记录均保持原状）',
      shortages: r.shortages,
      oldOrder: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  res.status(201).json({
    ok: true,
    idempotent: false,
    order: serializeCutOrder(r.order),
    oldOrder: serializeCutOrder(db.getCutOrder(order.id)),
  });
});

function cutStatusZh(status) {
  return status === 'draft' ? '草稿'
    : status === 'confirmed' ? '已确认'
    : status === 'replaced' ? '已替换'
    : '已取消';
}

// ---------- 整套用料单（铅条 + 玻璃 一次备齐、同一事务核验预留） ----------

const COMBO_NAME_MAX = 80;
const REQUEST_KEY_MAX = 80;
const REQUEST_KEY_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function comboStatusZh(status) {
  return status === 'confirmed' ? '已确认' : '已取消';
}

// 解析整套单参数：{ publicationId, copies, materialId, kerf, gap, requestId?, name? }
// 不落库、不占库存；返回 { error,status } 或完整入参。
function resolveComboInputs(body) {
  const b = body || {};
  const publicationId = Number(b.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };

  const materialId = Number(b.materialId);
  if (!Number.isInteger(materialId) || materialId <= 0) {
    return { error: 'materialId 必须是铅条原材规格的正整数 id' };
  }
  const material = db.getMaterial(materialId);
  if (!material) return { error: '铅条原材规格不存在', status: 404 };
  const materialRow = db.getMaterialRow(materialId);
  material.lengthH = materialRow.length_h;

  const copiesR = cut.parsePositiveInt(Number(b.copies), { name: '件数', max: COPIES_MAX });
  if (!copiesR.ok) return { error: copiesR.error };
  const kerfR = cut.parseLen2(Number(b.kerf), { name: '每刀损耗', positive: false });
  if (!kerfR.ok) return { error: kerfR.error };
  const gapR = sheetNest.parseNestingParams({ copies: copiesR.n, gap: Number(b.gap) });
  if (!gapR.ok) return { error: gapR.error };

  return {
    pub, material,
    copies: copiesR.n,
    kerfH: kerfR.h,
    gap: gapR.params.gap,
  };
}

// 同时生成铅条切段方案与玻璃排样方案（沿用现有规则）；任一失败整单拒绝（不落库）。
function buildComboLayout(inp) {
  const segs = cut.segmentsFromSnapshot(inp.pub.snapshot);
  if (!segs.ok) return { error: segs.error, status: 400 };
  const leadResult = cut.planCuts({
    segments: segs.segments,
    copies: inp.copies,
    stockLenH: inp.material.lengthH,
    kerfH: inp.kerfH,
  });
  if (!leadResult.ok) {
    if (leadResult.code === 'segment_too_long') {
      return {
        error: leadResult.error, status: 422, code: leadResult.code,
        segment: serializeSegmentBrief(leadResult.segment, inp.kerfH),
      };
    }
    return { error: leadResult.error, status: 400, code: leadResult.code };
  }
  const leadLayout = serializeLayout(leadResult, inp.material);

  const specs = sheetSpecMap();
  const specByColor = new Map();
  for (const [color, s] of specs) specByColor.set(color, { width: s.width, height: s.height });
  const nest = sheetNest.nestBySnapshot(inp.pub.snapshot, specByColor, inp.copies, inp.gap);
  if (!nest.ok) {
    return {
      error: nest.error, status: nest.status || 422, code: nest.code,
      color: nest.color, pieceNo: nest.pieceNo, copy: nest.copy,
      pieceWidth: nest.pieceWidth, pieceHeight: nest.pieceHeight,
      sheetWidth: nest.sheetWidth, sheetHeight: nest.sheetHeight,
      totalSheets: nest.totalSheets, maxSheets: nest.maxSheets,
    };
  }
  return { leadLayout, nestLayout: nest.layout, specs };
}

// 预览：铅条根数 + 各色原片张数/库存/可用/缺口；不落库、不占库存。
app.post('/api/combo-orders/preview', (req, res) => {
  const inp = resolveComboInputs(req.body || {});
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildComboLayout(inp);
  if (built.error) {
    return res.status(built.status || 422).json({
      ok: false, error: built.error, code: built.code,
      color: built.color, pieceNo: built.pieceNo, copy: built.copy,
      pieceWidth: built.pieceWidth, pieceHeight: built.pieceHeight,
      sheetWidth: built.sheetWidth, sheetHeight: built.sheetHeight,
      totalSheets: built.totalSheets, maxSheets: built.maxSheets,
      segment: built.segment,
    });
  }
  const material = db.getMaterial(inp.material.id);
  const lead = {
    material: materialBrief(material),
    requiredBars: built.leadLayout.requiredBars,
    stockBars: material.stock,
    reservedBars: material.reserved,
    availableBars: material.available,
    shortage: Math.max(0, built.leadLayout.requiredBars - material.available),
  };
  const glassColors = colorSummaries(built.nestLayout, built.specs);
  const glassShortage = glassColors.reduce((s, c) => s + c.shortage, 0);
  res.json({
    ok: true,
    preview: {
      publicationId: inp.pub.id,
      designId: inp.pub.designId,
      version: inp.pub.version,
      copies: inp.copies,
      kerf: cut.hToMm(inp.kerfH),
      gap: inp.gap,
      lead: { ...lead, layout: built.leadLayout },
      glass: {
        colors: glassColors,
        totalSheets: built.nestLayout.totalSheets,
        maxSheets: built.nestLayout.maxSheets,
        totalShortage: glassShortage,
        layout: built.nestLayout,
      },
      leadShortage: lead.shortage,
      totalShortage: lead.shortage + glassShortage,
      feasible: lead.shortage === 0 && glassShortage === 0,
    },
  });
});

// 整套单列表
app.get('/api/combo-orders', (req, res) => {
  res.json({ ok: true, combos: db.listComboOrders().map(serializeCombo) });
});

app.get('/api/combo-orders/:comboId', (req, res) => {
  const combo = db.getComboOrder(Number(req.params.comboId));
  if (!combo) return fail(res, 404, '整套用料单不存在');
  res.json({ ok: true, combo: serializeCombo(combo) });
});

// 确认整套单：同一事务核验并预留两类库存；任一不足全部保持原状。
// requestId 为客户端幂等键（同一 requestId 重试返回原单，不重复预留）。
app.post('/api/combo-orders', (req, res) => {
  const body = req.body || {};
  const requestKey = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!REQUEST_KEY_RE.test(requestKey)) {
    return fail(res, 400, 'requestId 必填：1–80 个字母/数字/._:-，作为本次确认的幂等键（重复提交请复用同一值）');
  }
  const inp = resolveComboInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildComboLayout(inp);
  if (built.error) {
    return res.status(built.status || 422).json({
      ok: false, error: built.error, code: built.code,
      color: built.color, pieceNo: built.pieceNo, copy: built.copy,
      pieceWidth: built.pieceWidth, pieceHeight: built.pieceHeight,
      sheetWidth: built.sheetWidth, sheetHeight: built.sheetHeight,
      totalSheets: built.totalSheets, maxSheets: built.maxSheets,
      segment: built.segment,
    });
  }
  const colors = colorSummaries(built.nestLayout, built.specs);
  const items = colors.map((c) => ({
    sheetId: c.sheetId, color: c.color,
    width: c.sheetWidth, height: c.sheetHeight,
    requiredSheets: c.requiredSheets,
  }));
  if (items.some((it) => it.sheetId === null)) {
    return fail(res, 422, '缺少对应颜色的原片规格'); // 双保险（missing_color 已在排样阶段拦截）
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, COMBO_NAME_MAX)
    : `整套备料 v${inp.pub.version} ×${inp.copies}件`;
  const r = db.createComboOrder({
    name,
    requestKey,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    copies: inp.copies,
    kerfH: inp.kerfH,
    gap: inp.gap,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    requiredBars: built.leadLayout.requiredBars,
    segmentCount: built.leadLayout.segmentCount,
    leadLayout: built.leadLayout,
    totalSheets: built.nestLayout.totalSheets,
    nestLayout: built.nestLayout,
    items,
    leadName: `整套·${name}·铅条计划`,
    orderName: `整套·${name}·裁片订单`,
  });
  if (r.code === 'idempotent') {
    return res.json({ ok: true, idempotent: true, combo: serializeCombo(r.combo) });
  }
  if (r.code === 'request_conflict') {
    return res.status(409).json({
      ok: false, code: 'request_conflict',
      error: '该 requestId 已用于参数不同的整套单确认；更换 requestId 后再提交',
      comboId: r.comboId, current: r.current,
    });
  }
  if (r.code === 'material_missing') return fail(res, 409, '铅条原材规格已不存在，无法确认');
  if (r.code === 'material_changed') {
    return fail(res, 409, '铅条原材定尺已变化，请刷新后重试');
  }
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，无法确认`);
  if (r.code === 'sheet_changed') {
    return fail(res, 409, `颜色 ${r.color} 的原片规格已变化，请刷新后重试`);
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false, code: 'shortage',
      error: '铅条或玻璃库存不足，整套单未确认（两类库存均保持原状，未预留任何一根/张）',
      lead: r.lead,
      shortages: r.glass,
    });
  }
  res.status(201).json({ ok: true, idempotent: false, combo: serializeCombo(r.combo) });
});

// 取消整套单：同一事务把关联生产计划与裁片订单置为 canceled，两类预留各释放一次。
app.post('/api/combo-orders/:comboId/cancel', (req, res) => {
  const combo = db.getComboOrder(Number(req.params.comboId));
  if (!combo) return fail(res, 404, '整套用料单不存在');
  const r = db.cancelComboOrder(combo.id);
  if (r.code === 'already_canceled') {
    return res.status(409).json({
      ok: false, error: '整套单已取消，铅条与玻璃预留此前已各释放一次，未重复变更库存',
      combo: serializeCombo(db.getComboOrder(combo.id)),
    });
  }
  if (r.code === 'already_issued') {
    return res.status(409).json({
      ok: false, code: 'already_issued',
      error: '该整套单已有领料记录，已领料单据不能取消',
      combo: serializeCombo(db.getComboOrder(combo.id)),
    });
  }
  res.json({ ok: true, combo: serializeCombo(r.combo) });
});

// 整套单输出：本体 + 绑定的发布快照/件数 + 关联生产计划与裁片订单（可查阅，不可独立操作）
function serializeCombo(combo) {
  const plan = db.getPlan(combo.leadPlanId);
  const order = db.getCutOrder(combo.cutOrderId);
  const leadStats = db.getPlanIssueStats(combo.leadPlanId);
  const glassStats = db.getOrderIssueStats(combo.cutOrderId);
  return {
    id: combo.id,
    name: combo.name,
    status: combo.status,
    statusText: comboStatusZh(combo.status),
    requestKey: combo.requestKey,
    publicationId: combo.publicationId,
    designId: combo.designId,
    version: combo.version,
    copies: combo.copies,
    kerf: combo.kerf,
    gap: combo.gap,
    requiredBars: combo.requiredBars,
    totalSheets: combo.totalSheets,
    leadPlanId: combo.leadPlanId,
    cutOrderId: combo.cutOrderId,
    pickedBars: leadStats ? leadStats.pickedBars : 0,
    remainingBars: leadStats ? leadStats.remainingBars : combo.requiredBars,
    pickedSheets: glassStats ? glassStats.totalPicked : 0,
    remainingSheets: glassStats ? glassStats.totalRemaining : combo.totalSheets,
    issueCount: new Set(db.listIssueRows({ comboId: combo.id }).map((r) => r.issue_no)).size,
    snapshotBound: true,
    leadPlan: plan ? serializePlan(plan) : null,
    cutOrder: order ? serializeCutOrder(order) : null,
    createdAt: combo.createdAt,
    updatedAt: combo.updatedAt,
    canceledAt: combo.canceledAt,
  };
}

// 订单输出：排样方案为建单时快照；库存视图取当前值（预览缺口仅对草稿有意义）
function serializeCutOrder(order) {
  const specs = sheetSpecMap();
  const colors = colorSummaries(order.layout, specs);
  // 该单分色的已领/余留预留（领料后不影响其他单据可用量）
  const stats = db.getOrderIssueStats(order.id);
  const pickedBySheet = new Map(stats.colors.map((c) => [c.sheetId, c]));
  for (const c of colors) {
    const st = pickedBySheet.get(c.sheetId);
    c.pickedSheets = st ? st.pickedSheets : 0;
    c.remainingSheets = st ? st.remainingSheets : c.requiredSheets;
  }
  const totalShortage = order.status === 'draft'
    ? colors.reduce((s, c) => s + c.shortage, 0)
    : 0;
  const totalPicked = stats.totalPicked;
  // 换单关系（若有）：replacedBy=旧单被哪张新单替换；replaces=新单接替了哪张旧单
  let replacedBy = null;
  let replaces = null;
  const rOld = db.getReplacementByNewOrder(order.id);
  if (rOld) {
    replaces = {
      oldOrderId: rOld.old_order_id,
      targetPublicationId: rOld.target_publication_id,
      copies: rOld.copies,
      gap: rOld.gap_mm,
      replacedAt: rOld.created_at,
    };
  }
  const rNew = db.getReplacementByOldOrder(order.id);
  if (rNew) {
    replacedBy = {
      newOrderId: rNew.new_order_id,
      targetPublicationId: rNew.target_publication_id,
      copies: rNew.copies,
      gap: rNew.gap_mm,
      replacedAt: rNew.created_at,
    };
  }
  return {
    id: order.id,
    name: order.name,
    status: order.status,
    statusText: cutStatusZh(order.status),
    publicationId: order.publicationId,
    designId: order.designId,
    version: order.version,
    copies: order.copies,
    gap: order.gap,
    totalSheets: order.totalSheets,
    maxSheets: order.layout.maxSheets || sheetNest.MAX_SHEETS,
    layout: order.layout,
    colors,
    items: db.listCutOrderItems(order.id),
    pickedSheets: totalPicked,
    remainingSheets: stats.totalRemaining,
    issueCount: new Set(db.listIssueRows({ orderId: order.id }).map((r) => r.issue_no)).size,
    totalShortage,
    feasible: order.status !== 'draft' || totalShortage === 0,
    snapshotBound: true,
    comboId: order.comboId,
    comboLocked: !!order.comboId,
    replacedBy,
    replaces,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    confirmedAt: order.confirmedAt,
    canceledAt: order.canceledAt,
    replacedAt: order.replacedAt,
  };
}

// ---------- 库存盘点（同一张盘点单盘点铅条原材 + 玻璃原片） ----------

const STOCKTAKE_NAME_MAX = 80;
const STOCKTAKE_ITEMS_MAX = 200;

function stocktakeStatusZh(status) {
  return status === 'draft' ? '草稿' : '已确认';
}

// 解析盘点项：[{type:'lead'|'glass', specId, counted}]
// 非空、type 合法、specId 正整数、实盘为非负整数、同类型规格不得重复。
function parseStocktakeItems(body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'items 必填：至少选择一个盘点规格（铅条原材或玻璃原片）' };
  }
  if (items.length > STOCKTAKE_ITEMS_MAX) {
    return { error: `一张盘点单最多 ${STOCKTAKE_ITEMS_MAX} 项` };
  }
  const parsed = [];
  const seen = new Set();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return { error: '每个盘点项必须是对象 {type, specId, counted}' };
    const type = raw.type === 'lead' ? 'lead' : raw.type === 'glass' ? 'glass' : null;
    if (!type) return { error: '盘点项 type 必须是 "lead"（铅条原材）或 "glass"（玻璃原片）' };
    const specId = Number(raw.specId);
    if (!Number.isInteger(specId) || specId <= 0) {
      return { error: '盘点项 specId 必须是规格的正整数 id' };
    }
    const countedR = cut.parseNonNegInt(Number(raw.counted), { name: '实盘总数' });
    if (!countedR.ok) return { error: countedR.error };
    const key = `${type}:${specId}`;
    if (seen.has(key)) {
      return {
        error: type === 'lead'
          ? `铅条原材规格 #${specId} 在同一张盘点单中重复出现`
          : `玻璃原片规格 #${specId} 在同一张盘点单中重复出现`,
        code: 'duplicate_spec',
      };
    }
    seen.add(key);
    parsed.push({ type, specId, counted: countedR.n });
  }
  return { items: parsed };
}

// 盘点项输出：
//   记录口径（永久）：预览基准 stock/reserved/quarantined、实盘 counted、差异 diff、
//   实盘后可用量 availableAfterCount（玻璃再扣除瑕疵隔离量）；
//   实时口径（current*）：确认前若库存/预留/隔离已漂移可直接看出；确认后反映盘点后的库存。
function serializeStocktakeItem(row) {
  const base = {
    itemId: row.id,
    type: row.type,
    specId: row.spec_id,
    counted: row.counted_stock,
    stock: row.baseline_stock,          // 预览时系统库存（记录原值）
    reserved: row.baseline_reserved,    // 预览时已确认净预留
    quarantined: row.baseline_quarantined || 0, // 预览时瑕疵隔离余额（铅条恒 0）
    diff: row.counted_stock - row.baseline_stock,
    availableAfterCount: row.counted_stock - row.baseline_reserved - (row.baseline_quarantined || 0),
  };
  if (row.type === 'lead') {
    const length = row.spec_length_h === null ? null : row.spec_length_h / 100;
    const live = db.getMaterial(row.spec_id);
    if (live) {
      return {
        ...base,
        name: live.name,
        label: live.name,
        length,
        currentStock: live.stock,
        currentReserved: live.reserved,
        currentAvailable: live.available,
      };
    }
    return {
      ...base,
      name: row.spec_name,
      label: row.spec_name,
      length,
      currentStock: null, currentReserved: null, currentAvailable: null,
      unavailable: true,
    };
  }
  const live = db.getGlassSheet(row.spec_id);
  if (live) {
    return {
      ...base,
      name: live.color,
      color: live.color,
      width: live.width,
      height: live.height,
      currentStock: live.stock,
      currentReserved: live.reserved,
      currentQuarantined: live.quarantined,
      currentAvailable: live.available,
    };
  }
  return {
    ...base,
    name: row.spec_name,
    color: row.spec_name,
    width: row.spec_width_mm,
    height: row.spec_height_mm,
    currentStock: null, currentReserved: null, currentQuarantined: null, currentAvailable: null,
    unavailable: true,
  };
}

function serializeStocktake(rowLike, itemRows) {
  const items = itemRows.map(serializeStocktakeItem);
  const leadItems = items.filter((i) => i.type === 'lead');
  const glassItems = items.filter((i) => i.type === 'glass');
  return {
    id: rowLike.id,
    name: rowLike.name,
    status: rowLike.status,
    statusText: stocktakeStatusZh(rowLike.status),
    itemCount: items.length,
    leadCount: leadItems.length,
    glassCount: glassItems.length,
    items,
    createdAt: rowLike.createdAt || rowLike.created_at,
    updatedAt: rowLike.updatedAt || rowLike.updated_at,
    confirmedAt: rowLike.confirmedAt || rowLike.confirmed_at || null,
  };
}

function loadStocktakeSerialized(id) {
  const row = db.getStocktakeRow(id);
  if (!row) return null;
  return serializeStocktake(row, db.listStocktakeItemRows(id));
}

// 预览：建草稿盘点单并固化各项当时的系统库存/预留/差异/实盘后可用量（不改库存）。
app.post('/api/stocktakes/preview', (req, res) => {
  const body = req.body || {};
  const pr = parseStocktakeItems(body);
  if (pr.error) return fail(res, 400, pr.error, pr.code ? { code: pr.code } : {});
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, STOCKTAKE_NAME_MAX)
    : `库存盘点（${pr.items.length} 项）`;
  const r = db.createStocktake({ name, items: pr.items });
  if (r.code === 'not_found') {
    return fail(res, 404, r.type === 'lead'
      ? `铅条原材规格 #${r.specId} 不存在`
      : `玻璃原片规格 #${r.specId} 不存在`);
  }
  res.status(201).json({ ok: true, stocktake: loadStocktakeSerialized(r.id) });
});

app.get('/api/stocktakes', (req, res) => {
  const list = db.listStocktakes().map((s) => {
    const itemRows = db.listStocktakeItemRows(s.id);
    return {
      ...s,
      statusText: stocktakeStatusZh(s.status),
      itemCount: itemRows.length,
      leadCount: itemRows.filter((i) => i.type === 'lead').length,
      glassCount: itemRows.filter((i) => i.type === 'glass').length,
    };
  });
  res.json({ ok: true, stocktakes: list });
});

app.get('/api/stocktakes/:id', (req, res) => {
  const s = loadStocktakeSerialized(Number(req.params.id));
  if (!s) return fail(res, 404, '盘点单不存在');
  res.json({ ok: true, stocktake: s });
});

// 修改草稿：重选规格/改实盘数并重新固化预览基准（已确认单不可改）。
app.put('/api/stocktakes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getStocktakeRow(id)) return fail(res, 404, '盘点单不存在');
  const body = req.body || {};
  const pr = parseStocktakeItems(body);
  if (pr.error) return fail(res, 400, pr.error, pr.code ? { code: pr.code } : {});
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, STOCKTAKE_NAME_MAX)
    : `库存盘点（${pr.items.length} 项）`;
  const r = db.updateStocktakeDraft(id, { name, items: pr.items });
  if (r.code === 'not_found') return fail(res, 404, '盘点单不存在');
  if (r.code === 'already_confirmed') {
    return res.status(409).json({
      ok: false, code: 'already_confirmed',
      error: '盘点单已确认，盘点记录不可修改（请新建盘点单）',
      stocktake: loadStocktakeSerialized(id),
    });
  }
  res.json({ ok: true, stocktake: loadStocktakeSerialized(id) });
});

// 确认盘点：同一事务重核所有选中规格的库存与预留；任一不符或实盘数低于当前预留，
// 返回该项及原因，整单不生效；全部通过才一次更新库存。已确认单重复提交返回同一记录。
app.post('/api/stocktakes/:id/confirm', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getStocktakeRow(id)) return fail(res, 404, '盘点单不存在');
  const r = db.confirmStocktake(id);
  if (r.code === 'not_found') return fail(res, 404, '盘点单不存在');
  if (r.code === 'idempotent') {
    return res.status(200).json({
      ok: true, idempotent: true,
      message: '该盘点单此前已确认，返回同一记录，未再次调整库存',
      stocktake: loadStocktakeSerialized(id),
    });
  }
  if (r.code === 'baseline_mismatch') {
    const reasonsZh = {
      spec_missing: '规格已不存在',
      spec_changed: '规格身份与预览基准不一致',
      stock_changed: '系统库存与预览基准不符',
      reserved_changed: '已确认预留与预览基准不符',
      quarantined_changed: '瑕疵隔离量与预览基准不符',
      below_reserved: '实盘数低于当前净预留与隔离量之和',
    };
    return res.status(409).json({
      ok: false,
      code: 'baseline_mismatch',
      error: '盘点确认失败：预览基准已变化或实盘数低于当前预留，整单未生效（库存未改动）',
      items: r.items.map((it) => ({
        ...it,
        typeName: it.type === 'lead' ? '铅条原材' : '玻璃原片',
        reasonText: reasonsZh[it.reason] || it.reason,
      })),
      stocktake: loadStocktakeSerialized(id),
    });
  }
  res.status(200).json({ ok: true, idempotent: false, stocktake: loadStocktakeSerialized(id) });
});

// 删除草稿盘点单（已确认为永久记录，不可删除）。
app.delete('/api/stocktakes/:id', (req, res) => {
  const r = db.deleteStocktake(Number(req.params.id));
  if (r.code === 'not_found') return fail(res, 404, '盘点单不存在');
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认盘点单为永久记录，不能删除（仅可查阅）');
  }
  res.json({ ok: true });
});

// ---------- 玻璃原片瑕疵隔离（隔离 / 解除隔离，不可变记录 + 台账） ----------

const QUARANTINE_OP_NO_RE = /^[A-Za-z0-9._:一-龥-]{1,80}$/;
const QUARANTINE_REASON_MAX = 200;

function quarantineActionZh(action) {
  return action === 'hold' ? '隔离' : '解除隔离';
}

// 解析隔离请求：
//   { opNo, action:'hold'|'release', reason, items:[{sheetId 或 color, count}] }
// 规则：opNo 必填且唯一（重试复用同值）；action 仅 hold/release；reason 非空（≤200 字）；
//   items 至少一项，颜色必须已登记且不得重复，count 为正整数。
// 返回 { error,status,code } 或 { params:{ opNo, action, reason, colors:Map } }。
function parseQuarantineBody(body) {
  const b = body || {};
  const opNo = typeof b.opNo === 'string' ? b.opNo.trim() : '';
  if (!QUARANTINE_OP_NO_RE.test(opNo)) {
    return { error: 'opNo（唯一操作号）必填：1–80 个字母/数字/汉字/._:-，网络重试请复用同一值', code: 'invalid_op_no' };
  }
  const action = b.action === 'hold' || b.action === 'release' ? b.action : null;
  if (!action) {
    return { error: 'action 必须是 "hold"（隔离）或 "release"（解除隔离）' };
  }
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return { error: '隔离/解除必须填写非空原因 reason' };
  if (reason.length > QUARANTINE_REASON_MAX) {
    return { error: `原因最长 ${QUARANTINE_REASON_MAX} 个字符` };
  }
  const rawItems = b.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: 'items 必填：至少选择一种已登记颜色，形如 [{sheetId 或 color, count}]' };
  }
  const colors = new Map();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      return { error: '每个颜色项必须是对象 {sheetId 或 color, count}' };
    }
    const count = Number(raw.count);
    if (!Number.isInteger(count) || count <= 0) {
      return { error: '各色张数必须是正整数（≥1）' };
    }
    let sheetId = null;
    if (raw.sheetId !== undefined) {
      sheetId = Number(raw.sheetId);
      if (!Number.isInteger(sheetId) || sheetId <= 0) {
        return { error: 'sheetId 必须是玻璃原片规格的正整数 id' };
      }
      if (!db.getGlassSheetRow(sheetId)) {
        return { error: `玻璃原片规格 #${sheetId} 不存在（未知颜色/规格，整次不生效）`, status: 404, code: 'sheet_not_found', sheetId };
      }
    } else if (typeof raw.color === 'string' && raw.color.trim()) {
      const color = raw.color.trim().toLowerCase();
      if (!COLOR_RE.test(color)) return { error: '颜色必须是 #RRGGBB 形式' };
      const row = db.getGlassSheetByColorRow(color);
      if (!row) {
        return { error: `颜色 ${color} 的原片规格未登记（未知颜色，整次不生效）`, status: 404, code: 'color_not_registered', color };
      }
      sheetId = row.id;
    } else {
      return { error: '每个颜色项必须提供 sheetId 或 color' };
    }
    if (colors.has(sheetId)) {
      return { error: `颜色规格 #${sheetId} 在同一次操作中重复出现（每种颜色只能出现一次）`, code: 'duplicate_color' };
    }
    colors.set(sheetId, count);
  }
  return { params: { opNo, action, reason, colors } };
}

function serializeQuarantineDetail(q) {
  return {
    id: q.id,
    opNo: q.opNo,
    action: q.action,
    actionText: quarantineActionZh(q.action),
    reason: q.reason,
    createdAt: q.createdAt,
    items: q.items.map((it) => {
      const sheet = db.getGlassSheet(it.sheetId);
      return {
        sheetId: it.sheetId,
        color: it.color,
        count: it.count,
        balanceQuarantined: it.balanceQuarantined,
        stock: sheet ? sheet.stock : null,
        reserved: sheet ? sheet.reserved : null,
        available: sheet ? sheet.available : null,
      };
    }),
  };
}

// POST /api/glass-quarantines —— 提交隔离/解除隔离（同事务原子写不可变记录、隔离量与台账）
app.post('/api/glass-quarantines', (req, res) => {
  const parsed = parseQuarantineBody(req.body);
  if (parsed.error) {
    return res.status(parsed.status || 400).json({
      ok: false, error: parsed.error,
      code: parsed.code || 'invalid_quarantine',
      color: parsed.color, sheetId: parsed.sheetId,
    });
  }
  const p = parsed.params;
  const r = db.createGlassQuarantine(p);
  if (r.code === 'idempotent') {
    const q = db.getQuarantineDetail(r.id);
    return res.status(200).json({
      ok: true, idempotent: true,
      message: `操作号 ${p.opNo} 已提交过且内容一致：返回原${quarantineActionZh(p.action)}记录，未重复变更隔离量`,
      quarantine: serializeQuarantineDetail(q),
    });
  }
  if (r.code === 'op_no_conflict') {
    const existingDetail = db.getQuarantineDetail(r.existing.id);
    return res.status(409).json({
      ok: false, code: 'op_no_conflict', opNo: p.opNo,
      error: `同一操作号 ${p.opNo} 已用于内容不同的操作；请核对后使用新的操作号（本次未生效）`,
      existing: {
        id: r.existing.id,
        opNo: p.opNo,
        action: r.existing.action,
        actionText: quarantineActionZh(r.existing.action),
        reason: r.existing.reason,
        createdAt: existingDetail ? existingDetail.createdAt : null,
        colors: r.existing.colors,
        items: existingDetail ? existingDetail.items.map((it) => ({
          sheetId: it.sheetId,
          color: it.color,
          count: it.count,
          balanceQuarantined: it.balanceQuarantined,
        })) : [],
      },
    });
  }
  if (r.code === 'sheet_missing') {
    return fail(res, 404, `玻璃原片规格 #${r.sheetId} 不存在（整次未生效）`);
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      code: 'shortage',
      error: p.action === 'hold'
        ? '部分颜色可隔离的未预留实物不足（隔离只能划出当前未预留且未隔离的实物），整次未生效'
        : '部分颜色解除数量超过隔离余额，整次未生效',
      problems: r.problems.map((pr) => ({
        ...pr,
        reasonText: pr.reason === 'over_free'
          ? `可隔离量仅 ${pr.available} 张（实物 ${pr.stock} − 净预留 ${pr.reserved} − 已隔离 ${pr.quarantined}），本次 ${pr.requested} 张`
          : `隔离余额仅 ${pr.quarantined} 张，本次解除 ${pr.requested} 张`,
      })),
    });
  }
  const q = db.getQuarantineDetail(r.id);
  res.status(201).json({ ok: true, idempotent: false, quarantine: serializeQuarantineDetail(q) });
});

// 隔离历史：?sheetId=N（或 ?color=#rrggbb）可只看某颜色；?opNo=... 按操作号精确查
app.get('/api/glass-quarantines', (req, res) => {
  const q = req.query || {};
  if (q.opNo) {
    const rec = db.getQuarantineByOpNo(String(q.opNo));
    if (!rec) return fail(res, 404, `操作号 ${q.opNo} 不存在`);
    return res.json({ ok: true, quarantine: serializeQuarantineDetail(db.getQuarantineDetail(rec.id)) });
  }
  let sheetId = null;
  if (q.sheetId !== undefined) {
    sheetId = Number(q.sheetId);
    if (!Number.isInteger(sheetId) || sheetId <= 0) return fail(res, 400, 'sheetId 必须是正整数');
    if (!db.getGlassSheetRow(sheetId)) return fail(res, 404, `玻璃原片规格 #${sheetId} 不存在`);
  } else if (q.color) {
    const color = String(q.color).trim().toLowerCase();
    if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');
    const row = db.getGlassSheetByColorRow(color);
    if (!row) return fail(res, 404, `颜色 ${color} 的原片规格未登记`);
    sheetId = row.id;
  }
  const list = db.listQuarantines({ sheetId }).map((h) => serializeQuarantineDetail(db.getQuarantineDetail(h.id)));
  res.json({ ok: true, count: list.length, quarantines: list });
});

app.get('/api/glass-quarantines/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '隔离记录 id 必须是正整数');
  const q = db.getQuarantineDetail(id);
  if (!q) return fail(res, 404, '隔离记录不存在');
  res.json({ ok: true, quarantine: serializeQuarantineDetail(q) });
});

// ---------- 领料（按已确认独立计划 / 独立裁片订单 / 整套单分次领料） ----------

const ISSUE_NO_MAX = 80;
const ISSUE_NO_RE = /^[A-Za-z0-9._:-一-龥]{1,80}$/;

// 解析领料请求：
//   { issueNo, sourceType:'lead_plan'|'cut_order'|'combo'（或 planId/orderId/comboId 显式指定）,
//     leadBars?, sheets? 或 glass?: [{sheetId|color, count}] }
// 数量均为非负整数且至少一项大于零；返回 { error,status,code } 或结构化入参。
function parseIssueBody(body) {
  const b = body || {};
  const issueNo = typeof b.issueNo === 'string' ? b.issueNo.trim() : '';
  if (!ISSUE_NO_RE.test(issueNo)) {
    return { error: 'issueNo（唯一领料号）必填：1–80 个字母/数字/汉字/._:-，重复提交请复用同一值', code: 'invalid_issue_no' };
  }

  let sourceType = b.sourceType === 'lead_plan' || b.sourceType === 'cut_order' || b.sourceType === 'combo'
    ? b.sourceType
    : null;
  if (!sourceType) {
    if (b.planId !== undefined) sourceType = 'lead_plan';
    else if (b.comboId !== undefined) sourceType = 'combo';
    else if (b.orderId !== undefined) sourceType = 'cut_order';
  }
  let planId = null;
  let orderId = null;
  let comboId = null;
  if (!sourceType) {
    return { error: '必须指定领料来源：sourceType 为 lead_plan / cut_order / combo（或提供 planId/orderId/comboId）' };
  }
  if (sourceType === 'lead_plan') planId = Number(b.planId ?? b.sourceId);
  if (sourceType === 'cut_order') orderId = Number(b.orderId ?? b.sourceId);
  if (sourceType === 'combo') comboId = Number(b.comboId ?? b.sourceId);
  if (sourceType === 'lead_plan' && (!Number.isInteger(planId) || planId <= 0)) {
    return { error: 'planId 必须是铅条生产计划的正整数 id' };
  }
  if (sourceType === 'cut_order' && (!Number.isInteger(orderId) || orderId <= 0)) {
    return { error: 'orderId 必须是裁片订单的正整数 id' };
  }
  if (sourceType === 'combo' && (!Number.isInteger(comboId) || comboId <= 0)) {
    return { error: 'comboId 必须是整套用料单的正整数 id' };
  }

  // 铅条根数
  let leadBars = 0;
  if (b.leadBars !== undefined) {
    const n = Number(b.leadBars);
    if (!Number.isInteger(n) || n < 0) return { error: '本次铅条根数 leadBars 必须是非负整数' };
    leadBars = n;
  }

  // 玻璃：接受 sheets 或 glass，元素为 {sheetId,count} 或 {color,count}
  const rawGlass = b.sheets !== undefined ? b.sheets : b.glass;
  const glass = [];
  if (rawGlass !== undefined) {
    if (!Array.isArray(rawGlass)) return { error: 'sheets 必须是 [{sheetId 或 color, count}] 数组' };
    for (const g of rawGlass) {
      if (!g || typeof g !== 'object') return { error: '每个玻璃领料项必须是对象 {sheetId 或 color, count}' };
      const count = Number(g.count);
      if (!Number.isInteger(count) || count < 0) return { error: '各色领取张数必须是非负整数' };
      let sheetId = null;
      let color = null;
      if (g.sheetId !== undefined) {
        sheetId = Number(g.sheetId);
        if (!Number.isInteger(sheetId) || sheetId <= 0) return { error: 'sheetId 必须是玻璃原片规格的正整数 id' };
      } else if (typeof g.color === 'string' && g.color.trim()) {
        color = g.color.trim().toLowerCase();
        if (!COLOR_RE.test(color)) return { error: '颜色必须是 #RRGGBB 形式' };
        const row = db.getGlassSheetByColorRow(color);
        if (!row) return { error: `颜色 ${color} 的原片规格不存在`, status: 404, code: 'sheet_not_found', color };
        sheetId = row.id;
      } else {
        return { error: '每个玻璃领料项必须提供 sheetId 或 color' };
      }
      if (count > 0) glass.push({ sheetId, count });
    }
  }

  // 同 sheetId 合并
  const merged = new Map();
  for (const g of glass) merged.set(g.sheetId, (merged.get(g.sheetId) || 0) + g.count);
  const glassItems = [...merged].map(([sheetId, count]) => ({ sheetId, count }));

  if (leadBars === 0 && glassItems.length === 0) {
    return { error: '本次铅条根数与各色原片张数均为 0：至少一项必须大于 0' };
  }
  return { params: { issueNo, sourceType, planId, orderId, comboId, leadBars, glass: glassItems } };
}

// 组装某次领料后的单据维度汇总（本次 / 累计 / 余留 + 当前实物库存）
function buildIssueResult(p, issueRows) {
  const bySheet = new Map();
  let thisLead = 0;
  for (const r of issueRows) {
    thisLead += r.lead_bars;
    if (r.sheet_id !== null) {
      bySheet.set(r.sheet_id, (bySheet.get(r.sheet_id) || 0) + r.sheets_count);
    }
  }
  // 组合单按行回填关联计划/订单（便捷入口入参只有 comboId）
  const planId = p.planId || issueRows.find((r) => r.plan_id !== null)?.plan_id || null;
  const orderId = p.orderId || issueRows.find((r) => r.order_id !== null)?.order_id || null;

  const result = {
    issueNo: p.issueNo,
    sourceType: p.sourceType,
    planId,
    orderId,
    comboId: p.comboId,
    issuedAt: issueRows[0] ? issueRows[0].created_at : null,
    thisTime: { leadBars: thisLead, glass: [] },
    lead: null,
    glass: { colors: [] },
  };

  // 铅条维度
  if (planId) {
    const stats = db.getPlanIssueStats(planId);
    const planRow = db.getPlanRow(planId);
    const mat = db.getMaterial(planRow.material_id);
    result.lead = {
      materialId: planRow.material_id,
      materialName: mat ? mat.name : planRow.material_name,
      requiredBars: stats.requiredBars,
      thisBars: thisLead,
      pickedBars: stats.pickedBars,
      remainingBars: stats.remainingBars,
      stockBars: mat ? mat.stock : null,
    };
  }

  // 玻璃维度
  if (orderId) {
    const stats = db.getOrderIssueStats(orderId);
    for (const c of stats.colors) {
      const thisCount = bySheet.get(c.sheetId) || 0;
      if (thisCount > 0) {
        result.thisTime.glass.push({
          sheetId: c.sheetId, color: c.color,
          count: thisCount,
        });
      }
      const sheet = db.getGlassSheet(c.sheetId);
      result.glass.colors.push({
        sheetId: c.sheetId,
        color: c.color,
        requiredSheets: c.requiredSheets,
        thisSheets: thisCount,
        pickedSheets: c.pickedSheets,
        remainingSheets: c.remainingSheets,
        stockSheets: sheet ? sheet.stock : null,
      });
    }
    result.glass.totalThis = result.thisTime.glass.reduce((s, g) => s + g.count, 0);
    result.glass.totalPicked = stats.totalPicked;
    result.glass.totalRemaining = stats.totalRemaining;
  }
  return result;
}

// 把同领料号的若干行按单据归属折叠为一条历史记录（整组行来自同一次领料）
function serializeIssueGroup(rows) {
  const first = rows[0];
  const leadBars = rows.reduce((s, r) => s + r.lead_bars, 0);
  const glassMap = new Map();
  for (const r of rows) {
    if (r.sheet_id !== null) {
      if (!glassMap.has(r.sheet_id)) glassMap.set(r.sheet_id, { sheetId: r.sheet_id, color: r.sheet_color, count: 0 });
      glassMap.get(r.sheet_id).count += r.sheets_count;
    }
  }
  return {
    issueNo: first.issue_no,
    sourceType: first.source_type,
    planId: first.plan_id,
    orderId: first.order_id,
    comboId: first.combo_id,
    leadBars,
    glass: [...glassMap.values()],
    totalGlass: [...glassMap.values()].reduce((s, g) => s + g.count, 0),
    issuedAt: first.created_at,
  };
}

function allIssueGroups() {
  const groups = new Map();
  for (const r of db.listAllIssueRows()) {
    if (!groups.has(r.issue_no)) groups.set(r.issue_no, []);
    groups.get(r.issue_no).push(r);
  }
  return [...groups.values()].map(serializeIssueGroup);
}

function issueGroupsFor({ planId, orderId, comboId }) {
  const groups = new Map();
  for (const r of db.listIssueRows({ planId, orderId, comboId })) {
    if (!groups.has(r.issue_no)) groups.set(r.issue_no, []);
    groups.get(r.issue_no).push(r);
  }
  return [...groups.values()].map(serializeIssueGroup);
}

// POST /api/issues —— 领料确认（同事务扣减实物库存与预留，记录不可变）
function handleIssueCreate(req, res) {
  const parsed = parseIssueBody(req.body || {});
  if (parsed.error) {
    return res.status(parsed.status || 400).json({
      ok: false, error: parsed.error,
      code: parsed.code || (parsed.status === 404 ? 'sheet_not_found' : 'invalid_issue'),
      color: parsed.color,
    });
  }
  const p = parsed.params;

  // 快速前置校验（事务内仍会重核）
  if (p.sourceType === 'lead_plan') {
    const plan = db.getPlan(p.planId);
    if (!plan) return fail(res, 404, '铅条生产计划不存在');
    if (plan.comboId) {
      return res.status(409).json({
        ok: false, code: 'issue_use_combo', comboId: plan.comboId,
        error: `该计划属于整套用料单 #${plan.comboId}，请到整套单入口领料（POST /api/combo-orders/${plan.comboId}/issues）`,
      });
    }
    if (plan.status !== 'confirmed') {
      return res.status(409).json({
        ok: false, code: 'source_not_confirmed', status: plan.status,
        error: `仅已确认的铅条计划可以领料（当前为 ${plan.statusText}）`,
      });
    }
  } else if (p.sourceType === 'cut_order') {
    const order = db.getCutOrder(p.orderId);
    if (!order) return fail(res, 404, '裁片订单不存在');
    if (order.comboId) {
      return res.status(409).json({
        ok: false, code: 'issue_use_combo', comboId: order.comboId,
        error: `该裁片订单属于整套用料单 #${order.comboId}，请到整套单入口领料（POST /api/combo-orders/${order.comboId}/issues）`,
      });
    }
    if (order.status !== 'confirmed') {
      return res.status(409).json({
        ok: false, code: 'source_not_confirmed', status: order.status,
        error: `仅已确认的裁片订单可以领料（当前为 ${order.statusText}）`,
      });
    }
  } else {
    const combo = db.getComboOrder(p.comboId);
    if (!combo) return fail(res, 404, '整套用料单不存在');
    if (combo.status !== 'confirmed') {
      return res.status(409).json({
        ok: false, code: 'source_not_confirmed', status: combo.status,
        error: `仅已确认的整套用料单可以领料（当前为 ${comboStatusZh(combo.status)}）`,
      });
    }
  }

  const r = db.createStockIssue({
    issueNo: p.issueNo,
    sourceType: p.sourceType,
    planId: p.planId,
    orderId: p.orderId,
    comboId: p.comboId,
    leadBars: p.leadBars,
    glass: p.glass,
  });

  if (r.code === 'idempotent') {
    const rows = db.getIssueRowsByNo(p.issueNo);
    const content = issueContentParamsFromRows(rows);
    return res.json({
      ok: true, idempotent: true,
      message: '该领料号已提交过且内容一致：返回原领料记录，未再次扣减库存',
      issue: buildIssueResult(content, rows),
    });
  }
  if (r.code === 'issue_no_conflict') {
    return res.status(409).json({
      ok: false, code: 'issue_no_conflict', issueNo: p.issueNo,
      error: '同一领料号已用于内容不同的领料；请核对后使用新的领料号（本次未生效）',
      existing: describeIssueContent(r.existing),
    });
  }
  if (r.code === 'not_found') return fail(res, 404, '领料来源单据不存在');
  if (r.code === 'issue_use_combo') {
    return res.status(409).json({
      ok: false, code: 'issue_use_combo', comboId: r.comboId,
      error: `该单属于整套用料单 #${r.comboId}，请到整套单入口领料`,
    });
  }
  if (r.code === 'source_not_confirmed') {
    return res.status(409).json({ ok: false, code: 'source_not_confirmed', status: r.status,
      error: '仅已确认的单据可以领料' });
  }
  if (r.code === 'combo_links_broken') return fail(res, 409, '整套单关联的计划/订单状态异常，不能领料');
  if (r.code === 'material_missing') return fail(res, 409, '铅条原材规格已不存在，不能领料');
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，不能领料`);
  if (r.code === 'invalid_issue') {
    return res.status(409).json({
      ok: false, code: 'invalid_issue',
      error: '领料数量不合法：超过该单剩余预留或实物库存不足，整次未生效（库存未扣减）',
      problems: r.problems,
    });
  }

  const rows = db.getIssueRowsByNo(p.issueNo);
  res.status(201).json({ ok: true, idempotent: false, issue: buildIssueResult(p, rows) });
}

// 从历史行反推 buildIssueResult 所需的“参数形态”
function issueContentParamsFromRows(rows) {
  const first = rows[0];
  const glass = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.sheet_id !== null && !seen.has(r.sheet_id)) {
      seen.add(r.sheet_id);
      glass.push({ sheetId: r.sheet_id });
    }
  }
  return {
    issueNo: first.issue_no,
    sourceType: first.source_type,
    planId: first.plan_id,
    orderId: first.order_id,
    comboId: first.combo_id,
  };
}

function describeIssueContent(c) {
  return {
    sourceType: c.sourceType,
    planId: c.planId,
    orderId: c.orderId,
    comboId: c.comboId,
    leadBars: c.leadBars,
    glass: [...c.glass.entries()].map(([sheetId, count]) => ({ sheetId, count })),
  };
}

app.post('/api/issues', handleIssueCreate);

// 按单据维度的便捷领料入口（等价于 POST /api/issues 并自动带来源类型与单据 id）
app.post('/api/plans/:planId/issues', (req, res) => {
  handleIssueCreate(
    { ...req, body: { ...(req.body || {}), sourceType: 'lead_plan', planId: Number(req.params.planId) } },
    res,
  );
});
app.post('/api/cut-orders/:orderId/issues', (req, res) => {
  handleIssueCreate(
    { ...req, body: { ...(req.body || {}), sourceType: 'cut_order', orderId: Number(req.params.orderId) } },
    res,
  );
});
app.post('/api/combo-orders/:comboId/issues', (req, res) => {
  handleIssueCreate(
    { ...req, body: { ...(req.body || {}), sourceType: 'combo', comboId: Number(req.params.comboId) } },
    res,
  );
});

// 领料历史（全部），可按 source 过滤：?source=lead_plan|cut_order|combo
app.get('/api/issues', (req, res) => {
  let groups = allIssueGroups();
  const source = req.query.source;
  if (source) {
    if (!['lead_plan', 'cut_order', 'combo'].includes(source)) {
      return fail(res, 400, 'source 必须是 lead_plan / cut_order / combo');
    }
    groups = groups.filter((g) => g.sourceType === source);
  }
  res.json({ ok: true, issues: groups });
});

app.get('/api/issues/:issueNo', (req, res) => {
  const issueNo = decodeURIComponent(req.params.issueNo);
  const rows = db.getIssueRowsByNo(issueNo);
  if (!rows.length) return fail(res, 404, '领料号不存在');
  const content = issueContentParamsFromRows(rows);
  res.json({ ok: true, issue: buildIssueResult(content, rows) });
});

// 计划维度：剩余预留 + 领料历史
app.get('/api/plans/:planId/issues', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const stats = db.getPlanIssueStats(plan.id);
  const mat = db.getMaterial(plan.materialId);
  res.json({
    ok: true,
    lead: {
      materialId: plan.materialId,
      materialName: mat ? mat.name : plan.materialName,
      requiredBars: stats.requiredBars,
      pickedBars: stats.pickedBars,
      remainingBars: stats.remainingBars,
      stockBars: mat ? mat.stock : null,
    },
    issues: issueGroupsFor({ planId: plan.id }),
  });
});

// 订单维度：分色剩余预留 + 领料历史
app.get('/api/cut-orders/:orderId/issues', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  const stats = db.getOrderIssueStats(order.id);
  const colors = stats.colors.map((c) => {
    const sheet = db.getGlassSheet(c.sheetId);
    return { ...c, stockSheets: sheet ? sheet.stock : null };
  });
  res.json({
    ok: true,
    glass: {
      totalRequired: stats.totalRequired,
      totalPicked: stats.totalPicked,
      totalRemaining: stats.totalRemaining,
      colors,
    },
    issues: issueGroupsFor({ orderId: order.id }),
  });
});

// 整套单维度：铅条（关联计划）+ 玻璃（关联订单）剩余预留与领料历史
app.get('/api/combo-orders/:comboId/issues', (req, res) => {
  const combo = db.getComboOrder(Number(req.params.comboId));
  if (!combo) return fail(res, 404, '整套用料单不存在');
  const plan = db.getPlan(combo.leadPlanId);
  const leadStats = db.getPlanIssueStats(combo.leadPlanId);
  const glassStats = db.getOrderIssueStats(combo.cutOrderId);
  const mat = plan ? db.getMaterial(plan.materialId) : null;
  res.json({
    ok: true,
    lead: {
      materialId: plan ? plan.materialId : null,
      materialName: mat ? mat.name : (plan ? plan.materialName : null),
      requiredBars: leadStats.requiredBars,
      pickedBars: leadStats.pickedBars,
      remainingBars: leadStats.remainingBars,
      stockBars: mat ? mat.stock : null,
    },
    glass: {
      totalRequired: glassStats.totalRequired,
      totalPicked: glassStats.totalPicked,
      totalRemaining: glassStats.totalRemaining,
      colors: glassStats.colors.map((c) => {
        const sheet = db.getGlassSheet(c.sheetId);
        return { ...c, stockSheets: sheet ? sheet.stock : null };
      }),
    },
    issues: issueGroupsFor({ comboId: combo.id }),
  });
});

// ---------- 库存台账（按规格追溯实物库存与净预留的逐笔去向） ----------

const LEDGER_EVENT_TEXT = {
  baseline: '启用台账基线',
  register: '登记规格',
  adjust: '手工调库',
  plan_confirm: '铅条计划确认',
  plan_cancel: '铅条计划取消',
  order_confirm: '裁片订单确认',
  order_cancel: '裁片订单取消',
  replace_out: '换单·旧单退出',
  replace_in: '换单·新单接替',
  combo_confirm: '整套单确认',
  combo_cancel: '整套单取消',
  stocktake: '盘点确认',
  issue: '领料出库',
  quarantine_hold: '玻璃瑕疵隔离',
  quarantine_release: '解除玻璃隔离',
};

// 解析时间边界：支持 YYYY-MM-DD / YYYY-MM-DD HH:MM / YYYY-MM-DD HH:MM:SS（空格或 T 分隔）。
// from 缺省时分秒按 00:00:00 起；to 缺省按 23:59:59 / 当分 :59 止（区间右闭）。非法返回 null。
function parseLedgerTime(raw, isEnd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(raw).trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  if (Number(Mo) < 1 || Number(Mo) > 12 || Number(D) < 1 || Number(D) > 31) return null;
  if (H !== undefined && (Number(H) > 23 || Number(Mi) > 59 || (S !== undefined && Number(S) > 59))) {
    return null;
  }
  const day = `${Y}-${Mo}-${D}`;
  if (H === undefined) return `${day} ${isEnd ? '23:59:59' : '00:00:00'}`;
  return `${day} ${H}:${Mi}:${S !== undefined ? S : (isEnd ? '59' : '00')}`;
}

// GET /api/ledger?type=lead|glass&specId=N&from=...&to=...
// 逐笔返回：发生时间、业务来源、实物库存与净预留的增减及笔后余额（按发生顺序升序）。
// 无记录返回空 entries；非法筛选明确报错（400/404）。
app.get('/api/ledger', (req, res) => {
  const q = req.query || {};
  const type = q.type;
  if (type !== 'lead' && type !== 'glass') {
    return fail(res, 400, '材料类型 type 必须是 lead（铅条原材）或 glass（玻璃原片）');
  }
  const specId = Number(q.specId);
  if (!Number.isInteger(specId) || specId <= 0) {
    return fail(res, 400, 'specId 必须是规格的正整数 id');
  }
  const spec = type === 'lead' ? db.getMaterial(specId) : db.getGlassSheet(specId);
  if (!spec) {
    return fail(res, 404, type === 'lead' ? `铅条原材规格 #${specId} 不存在` : `玻璃原片规格 #${specId} 不存在`);
  }
  let from = null;
  let to = null;
  if (q.from !== undefined && q.from !== '') {
    from = parseLedgerTime(q.from, false);
    if (!from) return fail(res, 400, 'from 时间格式非法：支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]');
  }
  if (q.to !== undefined && q.to !== '') {
    to = parseLedgerTime(q.to, true);
    if (!to) return fail(res, 400, 'to 时间格式非法：支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]');
  }
  if (from && to && from > to) {
    return fail(res, 400, `起始时间不能晚于结束时间（from=${from}，to=${to}）`);
  }
  const rows = db.listLedgerEntries({ materialType: type, specId, from, to });
  const entries = rows.map((r) => ({
    id: r.id,
    occurredAt: r.created_at,
    eventType: r.event_type,
    eventText: LEDGER_EVENT_TEXT[r.event_type] || r.event_type,
    sourceType: r.source_type,
    sourceId: r.source_id,
    sourceLabel: r.source_label,
    deltaStock: r.delta_stock,
    deltaReserved: r.delta_reserved,
    deltaQuarantined: r.delta_quarantined ?? 0,
    balanceStock: r.balance_stock,
    balanceReserved: r.balance_reserved,
    balanceQuarantined: r.balance_quarantined ?? 0,
  }));
  res.json({
    ok: true,
    ledger: {
      materialType: type,
      materialTypeText: type === 'lead' ? '铅条原材' : '玻璃原片',
      specId,
      specName: type === 'lead' ? spec.name : spec.color,
      specDetail: type === 'lead' ? `定尺 ${spec.length} mm` : `${spec.width}×${spec.height} mm`,
      unit: type === 'lead' ? '根' : '张',
      from,
      to,
      current: {
        stock: spec.stock,
        reserved: spec.reserved,
        quarantined: type === 'glass' ? (spec.quarantined || 0) : 0,
        available: spec.available,
      },
      count: entries.length,
      entries,
    },
  });
});

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return fail(res, 400, '请求体不是合法 JSON');
  console.error(err);
  fail(res, 500, '服务器内部错误');
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`彩绘玻璃拼片台已启动: http://localhost:${PORT}`);
    console.log(`数据库文件: ${DB_PATH}`);
  });
}

module.exports = app;
