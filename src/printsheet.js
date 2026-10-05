'use strict';

// 已发布图纸 1:1 分张打印核心。
// 输入全部为整数毫米：纸张宽高、四边统一留白、相邻页重叠宽度。
// 输出：行列分页方案（每页覆盖的图纸坐标、拼接标记）与逐页 SVG（物理尺寸 mm）。
// 纯计算、不访问数据库、不产生任何副作用。

const MAX_PAPER_MM = 100000;
const MAX_PAGES = 200;

// ---------- 参数解析与校验 ----------

function toInt(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, error: `${name}必须是整数毫米` };
  }
  if (!Number.isInteger(v)) return { ok: false, error: `${name}必须是整数毫米` };
  return { ok: true, n: v };
}

// body: { paperWidth, paperHeight, margin, overlap }
// 返回 { ok:true, params } 或 { ok:false, code,error,status }
function parseParams(body) {
  const b = body || {};
  const wR = toInt(b.paperWidth, '纸张宽');
  if (!wR.ok) return { ok: false, code: 'invalid', status: 400, error: wR.error };
  const hR = toInt(b.paperHeight, '纸张高');
  if (!hR.ok) return { ok: false, code: 'invalid', status: 400, error: hR.error };
  const mR = toInt(b.margin, '四边留白');
  if (!mR.ok) return { ok: false, code: 'invalid', status: 400, error: mR.error };
  const oR = toInt(b.overlap, '相邻页重叠宽度');
  if (!oR.ok) return { ok: false, code: 'invalid', status: 400, error: oR.error };

  const paperWidth = wR.n, paperHeight = hR.n, margin = mR.n, overlap = oR.n;

  if (paperWidth <= 0 || paperHeight <= 0) {
    return { ok: false, code: 'invalid', status: 400, error: '纸张宽高必须为正整数毫米' };
  }
  if (paperWidth > MAX_PAPER_MM || paperHeight > MAX_PAPER_MM) {
    return { ok: false, code: 'invalid', status: 400, error: `纸张尺寸过大（上限 ${MAX_PAPER_MM} 毫米）` };
  }
  if (margin < 0) {
    return { ok: false, code: 'invalid', status: 400, error: '四边留白必须是不小于 0 的整数毫米' };
  }
  if (overlap <= 0) {
    return { ok: false, code: 'invalid', status: 400, error: '相邻页重叠宽度必须为正整数毫米' };
  }
  const printableWidth = paperWidth - margin * 2;
  const printableHeight = paperHeight - margin * 2;
  if (printableWidth <= 0 || printableHeight <= 0) {
    return {
      ok: false, code: 'printable_not_positive', status: 400,
      error: '可打印尺寸非正：四边留白之和必须分别小于纸张宽、高',
      printableWidth, printableHeight,
    };
  }
  if (overlap >= printableWidth || overlap >= printableHeight) {
    return {
      ok: false, code: 'overlap_too_large', status: 400,
      error: `相邻页重叠宽度（${overlap} mm）必须小于任一可打印边长（${printableWidth} × ${printableHeight} mm）`,
      printableWidth, printableHeight, overlap,
    };
  }
  return {
    ok: true,
    params: { paperWidth, paperHeight, margin, overlap, printableWidth, printableHeight },
  };
}

// ---------- 分页 ----------

// 沿一个方向分页：内容长 contentLen，每页可打印长 printLen，相邻页重叠 overlap。
// 步距 = printLen - overlap；最后一页与前一页重叠不少于 overlap。
function axisCount(contentLen, printLen, overlap) {
  if (contentLen <= printLen) return 1;
  const step = printLen - overlap; // > 0（overlap < printLen 已在 parseParams 保证）
  return Math.max(1, Math.ceil((contentLen - overlap) / step));
}

function axisOrigin(index, printLen, overlap) {
  return index * (printLen - overlap);
}

// 依据发布快照与参数生成完整分页方案；页数超过 MAX_PAGES 时拒绝（不输出部分页面）。
// 返回 { ok:true, layout } 或 { ok:false, code,error,status }
function buildLayout(snapshot, params) {
  if (!snapshot || !Number.isInteger(snapshot.width) || !Number.isInteger(snapshot.height)
      || !Array.isArray(snapshot.pieces)) {
    return { ok: false, code: 'bad_snapshot', status: 500, error: '发布快照缺少图纸数据' };
  }
  const W = snapshot.width, H = snapshot.height;
  const { paperWidth: PW, paperHeight: PH, margin: M,
    printableWidth: pw, printableHeight: ph, overlap } = params;
  const cols = axisCount(W, pw, overlap);
  const rows = axisCount(H, ph, overlap);
  const totalPages = cols * rows;
  if (totalPages > MAX_PAGES) {
    return {
      ok: false, code: 'too_many_pages', status: 422,
      error: `分张总页数 ${totalPages} 超过上限 ${MAX_PAGES} 页，请改用更大纸张或减小留白`,
      cols, rows, totalPages, maxPages: MAX_PAGES,
    };
  }

  const pages = [];
  // 行号自下而上（图纸 y 向上），列号自左而右；页码先行内从左到右、再自下而上。
  // 先算每页覆盖的图纸坐标（原点按步距推进，末端夹到窗框）。
  const covAt = {};
  for (let r = 0; r < rows; r++) {
    const y0 = axisOrigin(r, ph, overlap);
    const y1 = Math.min(H, y0 + ph);
    for (let c = 0; c < cols; c++) {
      const x0 = axisOrigin(c, pw, overlap);
      const x1 = Math.min(W, x0 + pw);
      covAt[`${c},${r}`] = { x0, y0, x1, y1 };
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cov = covAt[`${c},${r}`];
      const pageNo = r * cols + c + 1;
      const seams = [];
      // 每个拼接方向的重叠带 = 本页与邻页覆盖区域的严格交集；
      // 两页因此使用完全相同的图纸坐标，末端自动夹在窗框 W/H 内。
      if (c > 0) {
        const nCov = covAt[`${c - 1},${r}`];
        seams.push(makeSeam('left', 'vertical', M, cov.x0, intersect(cov, nCov), pageNo - 1));
      }
      if (c < cols - 1) {
        const nCov = covAt[`${c + 1},${r}`];
        seams.push(makeSeam('right', 'vertical', PW - M, cov.x1, intersect(cov, nCov), pageNo + 1));
      }
      if (r > 0) {
        const nCov = covAt[`${c},${r - 1}`];
        seams.push(makeSeam('bottom', 'horizontal', PH - M, cov.y0, intersect(cov, nCov), pageNo - cols));
      }
      if (r < rows - 1) {
        const nCov = covAt[`${c},${r + 1}`];
        seams.push(makeSeam('top', 'horizontal', M, cov.y1, intersect(cov, nCov), pageNo + cols));
      }
      pages.push({
        page: pageNo,
        row: r + 1, col: c + 1, rows, cols,
        coverage: { ...cov, width: cov.x1 - cov.x0, height: cov.y1 - cov.y0 },
        seams,
      });
    }
  }

  return {
    ok: true,
    layout: {
      paper: { width: params.paperWidth, height: params.paperHeight },
      margin: params.margin,
      overlap,
      printable: { width: pw, height: ph },
      content: { width: W, height: H },
      cols, rows, totalPages,
      pageNumbering: '行自下而上（图纸 y 轴向上），列自左而右；页码先行内自左至右、再自下而上',
      pages,
    },
  };
}

// 两页覆盖区域的严格交集（拼接重叠带）；相邻页必有非空交集
function intersect(a, b) {
  return {
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
  };
}

// edge: 本页上的拼接边；paperCoord: 该边在纸张上的坐标（mm）；drawingCoord: 图纸坐标；
// band: 与邻页覆盖区域的交集（图纸坐标，两页计算结果完全一致）。
function makeSeam(edge, direction, paperCoord, drawingCoord, band, neighborPage) {
  const along = direction === 'vertical'
    ? alongPositions(band.y0, band.y1)
    : alongPositions(band.x0, band.x1);
  const crosses = along.map((v) => direction === 'vertical'
    ? { x: (band.x0 + band.x1) / 2, y: v }
    : { x: v, y: (band.y0 + band.y1) / 2 });
  return {
    edge, direction, paperCoord, drawingCoord, neighborPage,
    overlap: { x0: band.x0, y0: band.y0, x1: band.x1, y1: band.y1,
      width: band.x1 - band.x0, height: band.y1 - band.y0 },
    crosses,
  };
}

// 拼接十字定位标记沿线的位置：长边放 3 个，短边放中间 1 个（坐标夹在两页共同覆盖范围内，
// 相邻两页同排行/列覆盖范围一致，故两页上的标记物理位置完全重合）。
function alongPositions(lo, hi) {
  const len = hi - lo;
  if (len >= 100) return [lo + len / 4, lo + len / 2, lo + (len * 3) / 4];
  return [lo + len / 2];
}

// ---------- 预览序列化（附带逐页 SVG 下载地址） ----------

function svgUrlPath(designId, version, layout, page) {
  const q = new URLSearchParams({
    paperWidth: String(layout.paper.width),
    paperHeight: String(layout.paper.height),
    margin: String(layout.margin),
    overlap: String(layout.overlap),
    page: String(page),
  });
  return `/api/designs/${designId}/publications/${version}/print/page?${q.toString()}`;
}

function serializePreview(designId, version, layout) {
  return {
    ...layout,
    pages: layout.pages.map((p) => ({ ...p, svgUrl: svgUrlPath(designId, version, layout, p.page) })),
  };
}

// ---------- SVG ----------

const num = (v) => String(Math.round(v * 1000) / 1000);

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    return [poly.reduce((s, p) => s + p[0], 0) / poly.length,
      poly.reduce((s, p) => s + p[1], 0) / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// 生成某一页的 SVG（1:1，尺寸以 mm 给出）。
function pageSvg(pub, params, page) {
  const { snapshot } = pub;
  const W = snapshot.width, H = snapshot.height;
  const { paperWidth: PW, paperHeight: PH, margin: M, overlap: OV,
    printableWidth: pw, printableHeight: ph } = params;
  const { coverage: cov, seams } = page;
  const { x0, y0, x1, y1 } = cov;

  // 图纸坐标（y 向上）→ 纸张坐标（SVG y 向下）
  const px = (x) => M + (x - x0);
  const py = (y) => M + ph - (y - y0);

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="${num(PW)}mm" height="${num(PH)}mm" viewBox="0 0 ${num(PW)} ${num(PH)}">`);
  const total = page.rows * page.cols;
  out.push(`<title>${xmlEscape(`${snapshot.name} v${pub.version} 第${page.page}/${total}页 1:1打印`)}</title>`);
  out.push(`<desc>纸张 ${PW}×${PH}mm，留白 ${M}mm，相邻页重叠 ${OV}mm；` +
    `本页覆盖图纸 x ${x0}-${x1}、y ${y0}-${y1} mm。打印时请选择“实际大小/100%”，勿缩放。</desc>`);
  out.push(`<defs>
  <clipPath id="printable-clip"><rect x="${num(M)}" y="${num(M)}" width="${num(pw)}" height="${num(ph)}"/></clipPath>
</defs>`);

  // 纸张底
  out.push(`<rect x="0" y="0" width="${num(PW)}" height="${num(PH)}" fill="#ffffff"/>`);

  // ===== 图纸内容（裁到可打印区域；重叠带两页使用相同图纸坐标） =====
  out.push(`<g clip-path="url(#printable-clip)">`);
  out.push(`<g transform="translate(${num(M - x0)},${num(M + ph + y0)}) scale(1,-1)">`);

  // 重叠带浅色底
  for (const s of seams) {
    const b = s.overlap;
    out.push(`<rect x="${num(b.x0)}" y="${num(b.y0)}" width="${num(b.width)}" height="${num(b.height)}" ` +
      `fill="#1565c0" fill-opacity="0.07" stroke="#1565c0" stroke-opacity="0.55" stroke-width="0.18" stroke-dasharray="1.5,1"/>`);
  }

  // 玻璃片（轮廓/编号/颜色均取自不可变快照；跨页轮廓由 clipPath 裁切）
  for (const pc of snapshot.pieces) {
    const pts = pc.polygon.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
    out.push(`<polygon points="${pts}" fill="${xmlEscape(pc.color)}" fill-opacity="0.6" ` +
      `stroke="#222222" stroke-width="0.3" stroke-linejoin="round"/>`);
  }

  // 外框（四根，取自快照窗框尺寸）
  out.push(`<rect x="0" y="0" width="${num(W)}" height="${num(H)}" fill="none" ` +
    `stroke="#111111" stroke-width="0.7"/>`);

  // 拼接边虚线 + 十字定位标记的几何（坐标标签在翻转组外正立绘制）
  for (const s of seams) {
    if (s.direction === 'vertical') {
      const x = s.drawingCoord;
      out.push(`<line x1="${num(x)}" y1="${num(y0)}" x2="${num(x)}" y2="${num(y1)}" ` +
        `stroke="#2e7d4f" stroke-width="0.35" stroke-dasharray="2.5,1.2"/>`);
    } else {
      const y = s.drawingCoord;
      out.push(`<line x1="${num(x0)}" y1="${num(y)}" x2="${num(x1)}" y2="${num(y)}" ` +
        `stroke="#2e7d4f" stroke-width="0.35" stroke-dasharray="2.5,1.2"/>`);
    }
    for (const cr of s.crosses) {
      out.push(`<line x1="${num(cr.x - 3)}" y1="${num(cr.y)}" x2="${num(cr.x + 3)}" y2="${num(cr.y)}" ` +
        `stroke="#c62828" stroke-width="0.3"/>`);
      out.push(`<line x1="${num(cr.x)}" y1="${num(cr.y - 3)}" x2="${num(cr.x)}" y2="${num(cr.y + 3)}" ` +
        `stroke="#c62828" stroke-width="0.3"/>`);
      out.push(`<circle cx="${num(cr.x)}" cy="${num(cr.y)}" r="1.6" fill="#ffffff" ` +
        `stroke="#c62828" stroke-width="0.3"/>`);
    }
  }
  out.push(`</g></g>`);

  // ===== 正立标注（纸张坐标） =====

  // 拼片编号（质心落在本页覆盖区域内才标注；重叠带内的编号因此可能两页都出现，便于对位）
  for (const pc of snapshot.pieces) {
    const [cx0, cy0] = centroid(pc.polygon);
    if (cx0 >= x0 && cx0 <= x1 && cy0 >= y0 && cy0 <= y1) {
      const cx = px(cx0), cy = py(cy0);
      out.push(labelText(cx, cy - 0.4, `#${pc.pieceNo}`, 3.4, 'bold', '#111111', 'middle'));
      out.push(labelText(cx, cy + 3.2, `${num(pc.area)} mm²`, 2.1, 'normal', '#555555', 'middle'));
    }
  }

  // 拼接标记坐标标签
  for (const s of seams) {
    for (const cr of s.crosses) {
      out.push(labelText(px(cr.x) + 3.4, py(cr.y) - 2.6, `(${num(cr.x)}, ${num(cr.y)})`,
        2.3, 'normal', '#b71c1c', 'start'));
    }
    // 拼接边说明
    const ovMm = s.direction === 'vertical' ? s.overlap.width : s.overlap.height;
    const txt = `与第 ${s.neighborPage} 页拼接 · 重叠 ${ovMm} mm`;
    if (s.direction === 'vertical') {
      const sx = s.edge === 'right' ? PW - M - 2.2 : M + 2.2;
      const sy = M + ph / 2;
      out.push(`<g transform="rotate(-90 ${num(sx)} ${num(sy)})">` +
        labelText(sx, sy, txt, 2.6, 'bold', '#1b5e20', s.edge === 'right' ? 'end' : 'start') + `</g>`);
    } else {
      const sx = M + pw / 2;
      const sy = s.edge === 'top' ? M + 4.6 : PH - M - 2.4;
      out.push(labelText(sx, sy, txt, 2.6, 'bold', '#1b5e20', 'middle'));
    }
  }

  // 页眉（左上角可打印区域内）
  const headerLines = [
    `${snapshot.name} · v${pub.version} · 实物 1:1 分张打印`,
    `第 ${page.page}/${total} 页（第 ${page.row}/${page.rows} 行，自下而上；第 ${page.col}/${page.cols} 列，自左而右）`,
    `覆盖图纸坐标 x ${num(x0)}–${num(x1)}，y ${num(y0)}–${num(y1)} mm ｜ ` +
      `纸张 ${PW}×${PH} mm，留白 ${M} mm，相邻重叠 ${OV} mm`,
  ];
  out.push(`<rect x="${num(M + 1.5)}" y="${num(M + 1.5)}" width="${num(Math.max(0, pw - 3))}" height="14.5" ` +
    `fill="#ffffff" fill-opacity="0.88" stroke="#bbbbbb" stroke-width="0.2"/>`);
  headerLines.forEach((line, i) => {
    out.push(labelText(M + 4, M + 5.4 + i * 4, line, i === 0 ? 3 : 2.6, i === 0 ? 'bold' : 'normal',
      i === 0 ? '#1a1a1a' : '#444444', 'start'));
  });
  if (pw >= 130) {
    out.push(labelText(PW - M - 4, M + 6, '↑ 图纸 y+ 方向', 2.8, 'bold', '#333333', 'end'));
  }

  // 毫米校准标尺（位于可打印区域内）
  out.push(ruler(params));

  // 纸张边与可打印区域边界
  out.push(`<rect x="${num(M)}" y="${num(M)}" width="${num(pw)}" height="${num(ph)}" ` +
    `fill="none" stroke="#888888" stroke-width="0.25" stroke-dasharray="2,1.5"/>`);
  out.push(`<rect x="0.25" y="0.25" width="${num(PW - 0.5)}" height="${num(PH - 0.5)}" ` +
    `fill="none" stroke="#bbbbbb" stroke-width="0.25"/>`);

  out.push(`</svg>`);
  return out.join('\n');
}

// 正立文字（纸张坐标，y 向下）；白色描边做衬底，压在线条上仍可辨。
function labelText(x, y, text, size, weight, fill, anchor) {
  return `<text x="${num(x)}" y="${num(y)}" font-family="${FONT}" font-size="${num(size)}" ` +
    `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ` +
    `stroke="#ffffff" stroke-width="0.7" paint-order="stroke">${xmlEscape(text)}</text>`;
}

const FONT = "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC',sans-serif";

// 毫米校准标尺：优先横尺（贴可打印区域左下），横向放不下用竖尺；再退化画 5mm 短线。
function ruler(params) {
  const { paperHeight: PH, margin: M, printableWidth: pw, printableHeight: ph } = params;
  const bx = M + 6, by = PH - M - 6; // 横尺基线左端点
  const availW = pw - 12;
  const parts = [];
  if (availW >= 10) {
    const L = Math.min(100, Math.floor(availW / 10) * 10);
    parts.push(`<rect x="${num(bx - 2)}" y="${num(by - 9)}" width="${num(L + 4)}" height="13.5" fill="#ffffff"/>`);
    parts.push(`<line x1="${num(bx)}" y1="${num(by)}" x2="${num(bx + L)}" y2="${num(by)}" stroke="#111" stroke-width="0.3"/>`);
    for (let t = 0; t <= L; t++) {
      let h = 1;
      if (t % 10 === 0) h = 5;
      else if (t % 5 === 0) h = 3;
      parts.push(`<line x1="${num(bx + t)}" y1="${num(by)}" x2="${num(bx + t)}" y2="${num(by - h)}" stroke="#111" stroke-width="0.25"/>`);
      if (t % 10 === 0) {
        parts.push(labelText(bx + t, by - 6, String(t), 2.6, 'normal', '#111111', 'middle'));
      }
    }
    parts.push(labelText(bx, by + 3.2,
      `毫米校准标尺 · 0–${L} mm（1:1；打印请选“实际大小/100%”，勿缩放）`, 2.4, 'normal', '#333333', 'start'));
    return parts.join('\n');
  }
  const availH = ph - 12;
  if (availH >= 10) {
    const L = Math.min(100, Math.floor(availH / 10) * 10);
    parts.push(`<rect x="${num(bx - 3)}" y="${num(by - L - 1)}" width="16" height="${num(L + 4)}" fill="#ffffff"/>`);
    parts.push(`<line x1="${num(bx)}" y1="${num(by)}" x2="${num(bx)}" y2="${num(by - L)}" stroke="#111" stroke-width="0.3"/>`);
    for (let t = 0; t <= L; t++) {
      let h = 1;
      if (t % 10 === 0) h = 5;
      else if (t % 5 === 0) h = 3;
      parts.push(`<line x1="${num(bx)}" y1="${num(by - t)}" x2="${num(bx + h)}" y2="${num(by - t)}" stroke="#111" stroke-width="0.25"/>`);
      if (t % 10 === 0) {
        parts.push(labelText(bx + 6, by - t + 0.9, String(t), 2.4, 'normal', '#111111', 'start'));
      }
    }
    parts.push(labelText(bx, by - L - 1.6, `毫米标尺 0–${L} mm（1:1 勿缩放）`, 2.2, 'normal', '#333333', 'start'));
    return parts.join('\n');
  }
  // 极小可打印区域：至少给出一段 5mm 参照
  return `<line x1="${num(M + 2)}" y1="${num(PH - M - 2)}" x2="${num(M + 7)}" y2="${num(PH - M - 2)}" stroke="#111" stroke-width="0.3"/>` +
    labelText(M + 2, PH - M - 3, '5mm', 2, 'normal', '#111111', 'start');
}

module.exports = {
  MAX_PAPER_MM, MAX_PAGES,
  parseParams, buildLayout, serializePreview, pageSvg,
  axisCount, svgUrlPath,
};
