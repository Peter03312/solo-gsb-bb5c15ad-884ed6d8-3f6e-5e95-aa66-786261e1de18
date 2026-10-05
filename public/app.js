'use strict';

// ================= 状态 =================

const state = {
  draft: null,          // GET /designs/:id 返回
  drawing: null,        // { points:[[x,y]...] } 正在绘制的多边形
  editingId: null,      // 正在编辑（拖拽）的拼片 id
  error: null,          // { message, at, category, pieceId }
  showGaps: true,
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ================= API =================

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* ignore */ }
  if (!resp.ok || (data && data.ok === false)) {
    const err = new Error(data?.error || `请求失败 (${resp.status})`);
    err.data = data || {};
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ================= 坐标变换 =================

function getTransform(draft, cv) {
  const pad = 40;
  const sx = (cv.width - pad * 2) / draft.width;
  const sy = (cv.height - pad * 2) / draft.height;
  const scale = Math.min(sx, sy);
  const ox = (cv.width - draft.width * scale) / 2;
  const oy = (cv.height - draft.height * scale) / 2;
  return {
    scale, ox, oy,
    toPx: (x, y) => [ox + x * scale, cv.height - (oy + y * scale)],
    toMm: (px, py) => [
      Math.round((px - ox) / scale),
      Math.round((cv.height - py - oy) / scale),
    ],
  };
}

// ================= 草稿渲染 =================

function renderDraft() {
  const d = state.draft;
  const banner = document.getElementById('errorBanner');
  if (!d) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    banner.hidden = true;
    return;
  }
  const t = getTransform(d, canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 背景
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 缺口（红色斜纹，含“孤岛片”形成的带洞缺口）
  if (state.showGaps && !d.coverage.covered) {
    for (const gap of d.coverage.gaps) drawGap(gap, t);
    for (const ov of d.coverage.overlapping) drawOverlap(ov, t);
  }

  // 玻璃片
  for (const pc of d.pieces) drawPiece(pc, t);

  // 外框
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3;
  ctx.strokeRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 正在绘制的多边形
  if (state.drawing) drawInProgress(t);

  // 错误位置标记
  if (state.error?.at) drawErrorMarker(state.error.at, t);

  renderPieceList();
  renderCoverage();
  renderLeadList();
}

function drawPiece(pc, t) {
  const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = pc.color;
  ctx.globalAlpha = 0.78;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 编号 + 面积，写在面积中心
  const [cx0, cy0] = centroid(pc.polygon);
  const [cx, cy] = t.toPx(cx0, cy0);
  const label = `#${pc.pieceNo} ${pc.area}mm²`;
  ctx.font = 'bold 13px sans-serif';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(cx - w / 2 - 4, cy - 10, w + 8, 18);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
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
    const sx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const sy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    return [sx, sy];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function tracePath(rings, t) {
  ctx.beginPath();
  for (const ring of rings) {
    const pts = ring.map(([x, y]) => t.toPx(x, y));
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
}

function drawGap(gap, t) {
  const rings = [gap.outer || gap.polygon, ...(gap.holes || [])];
  tracePath(rings, t);
  ctx.fillStyle = 'rgba(210, 40, 30, 0.18)';
  ctx.fill('evenodd');
  ctx.save();
  ctx.clip('evenodd');
  ctx.strokeStyle = 'rgba(210, 40, 30, 0.55)';
  ctx.lineWidth = 2;
  for (let k = -600; k < 600; k += 10) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 600, 600);
    ctx.stroke();
  }
  ctx.restore();
  tracePath(rings, t);
  ctx.strokeStyle = '#c0281c';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOverlap(ov, t) {
  tracePath([ov.polygon], t);
  ctx.fillStyle = 'rgba(160, 0, 200, 0.2)';
  ctx.fill();
  ctx.strokeStyle = '#8b00b8';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawInProgress(t) {
  const pts = state.drawing.points;
  if (!pts.length) return;
  const px = pts.map(([x, y]) => t.toPx(x, y));
  if (px.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1]);
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  px.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#1565c0' : '#fff';
    ctx.fill();
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1565c0';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}(${pts[i][0]},${pts[i][1]})`, x + 7, y - 7);
  });
}

function drawErrorMarker(at, t) {
  const [x, y] = t.toPx(at[0], at[1]);
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ================= 画布交互：绘制 =================

canvas.addEventListener('mousemove', (e) => {
  if (!state.draft) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  const inside = x >= 0 && y >= 0 && x <= state.draft.width && y <= state.draft.height;
  document.getElementById('cursorPos').textContent =
    `光标坐标: ${inside ? `${x}, ${y} mm` : '（窗框外）'}`;
});

canvas.addEventListener('click', (e) => {
  if (!state.draft || !state.drawing) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  if (x < 0 || y < 0 || x > state.draft.width || y > state.draft.height) {
    showError({ error: '顶点越出窗框', at: [x, y] });
    return;
  }
  // 吸附到已有顶点（8px 内），便于精确 T 接
  const snap = snapToVertex(x, y, t);
  state.drawing.points.push(snap || [x, y]);
  clearError();
  syncCoordsText();
  renderDraft();
});

canvas.addEventListener('dblclick', () => {
  if (state.drawing) finishDrawing();
});

function snapToVertex(x, y, t) {
  let best = null, bestD = 8;
  const consider = (vx, vy) => {
    const [px, py] = t.toPx(vx, vy);
    const [cx, cy] = t.toPx(x, y);
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) { bestD = d; best = [vx, vy]; }
  };
  for (const pc of state.draft.pieces) pc.polygon.forEach((p) => consider(p[0], p[1]));
  [[0, 0], [state.draft.width, 0], [state.draft.width, state.draft.height], [0, state.draft.height]]
    .forEach((c) => consider(c[0], c[1]));
  state.drawing?.points.forEach((p) => consider(p[0], p[1]));
  return best;
}

function startDrawing() {
  state.drawing = { points: [] };
  document.getElementById('editHint').textContent = '在画布上依次点击顶点（自动吸附已有顶点），双击或点“闭合多边形”完成。';
  syncCoordsText();
  renderDraft();
}

function finishDrawing() {
  if (!state.drawing) return;
  const pts = state.drawing.points;
  if (pts.length < 3) {
    showError({ error: '多边形至少需要 3 个顶点' });
    return;
  }
  submitPiece(pts);
}

async function submitPiece(polygon) {
  const color = document.getElementById('pieceColor').value;
  const wasEditing = state.editingId !== null;
  try {
    const data = wasEditing
      ? await api('PUT', `/api/designs/${state.draft.id}/pieces/${state.editingId}`, { color, polygon })
      : await api('POST', `/api/designs/${state.draft.id}/pieces`, { color, polygon });
    state.draft = data.draft;
    state.drawing = null;
    state.editingId = null;
    document.getElementById('coordsInput').value = '';
    document.getElementById('editHint').textContent = '';
    showSuccess(wasEditing ? '拼片已更新' : '拼片已加入草稿');
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message, at: err.data?.at });
  }
}

function cancelDrawing() {
  state.drawing = null;
  state.editingId = null;
  document.getElementById('coordsInput').value = '';
  document.getElementById('editHint').textContent = '';
  clearError();
  renderDraft();
}

function syncCoordsText() {
  if (!state.drawing) return;
  document.getElementById('coordsInput').value =
    state.drawing.points.map((p) => p.join(',')).join('\n');
}

// 手工坐标 → 开始绘制状态（供预览/提交）
function coordsFromTextarea() {
  const lines = document.getElementById('coordsInput').value
    .split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const pts = [];
  for (const line of lines) {
    const m = line.match(/^(-?\d+)\s*[,，\s]\s*(-?\d+)$/);
    if (!m) return { error: `无法解析坐标行: “${line}”` };
    pts.push([Number(m[1]), Number(m[2])]);
  }
  return { points: pts };
}

// ================= 侧栏列表与状态 =================

function renderPieceList() {
  const d = state.draft;
  document.getElementById('pieceCount').textContent = d.pieces.length;
  const ul = document.getElementById('pieceList');
  ul.innerHTML = '';
  for (const pc of d.pieces) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = pc.color;
    const meta = document.createElement('span');
    meta.className = 'piece-meta';
    meta.innerHTML = `<span class="no">#${pc.pieceNo}</span><span class="area">${pc.area} mm²</span><br>
      <span class="small muted">${pc.polygon.length} 顶点</span>`;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-pick';
    colorInput.value = pc.color;
    colorInput.title = '改颜色';
    colorInput.addEventListener('change', () => recolor(pc.id, colorInput.value));
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.title = '编辑顶点（载入到画布）';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => editPiece(pc));
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.title = '删除';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => removePiece(pc.id));
    li.append(sw, meta, colorInput, editBtn, delBtn);
    ul.appendChild(li);
  }
}

async function recolor(id, color) {
  const pc = state.draft.pieces.find((p) => p.id === id);
  try {
    const data = await api('PUT', `/api/designs/${state.draft.id}/pieces/${id}`,
      { color, polygon: pc.polygon });
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message });
  }
}

function editPiece(pc) {
  state.editingId = pc.id;
  state.drawing = { points: pc.polygon.map((p) => p.slice()) };
  document.getElementById('pieceColor').value = pc.color;
  syncCoordsText();
  document.getElementById('editHint').textContent =
    `正在编辑 #${pc.pieceNo}：可修改坐标文本后“闭合多边形”保存，或取消放弃。`;
  renderDraft();
}

async function removePiece(id) {
  if (!confirm('确定删除这片拼片？（仅影响草稿）')) return;
  try {
    const data = await api('DELETE', `/api/designs/${state.draft.id}/pieces/${id}`);
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError({ error: err.message });
  }
}

function renderCoverage() {
  const c = state.draft.coverage;
  const box = document.getElementById('coverageStatus');
  if (c.covered) {
    box.innerHTML = `<span class="badge ok">✓ 完整覆盖，无空隙</span>
      <div class="muted">玻璃总面积 ${c.totalPieceArea} mm² ＝ 窗框面积 ${c.frameArea} mm²，可以发布。</div>`;
  } else {
    let html = `<span class="badge bad">✗ 尚未完整覆盖</span>`;
    if (c.gaps.length) {
      html += `<div class="gap-info">检测到 ${c.gaps.length} 个缺口（图中红色斜纹）：<br>` +
        c.gaps.map((g, i) => `缺口${i + 1}：面积 ${g.area} mm²`).join('<br>') + '</div>';
    }
    if (c.overlapping.length) {
      html += `<div class="gap-info">存在 ${c.overlapping.length} 处面积重叠（紫色区域），发布前必须修正。</div>`;
    }
    html += `<div class="muted">已覆盖 ${c.totalPieceArea} / ${c.frameArea} mm²</div>`;
    box.innerHTML = html;
  }
}

function renderLeadList() {
  const L = state.draft.leadList;
  const el = document.getElementById('leadList');
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]}) → (${b[0]},${b[1]})${r.points.length > 2 ? ` <span class="muted">(${r.points.length - 1} 段合并)</span>` : ''}</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边小计（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<table><thead><tr><th>外框</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td>外框小计（4 根）</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td>铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<div class="hint">公共边无论一侧整边、另一侧分几段，均合并为一根只计一次；长度先求和再四舍五入到 0.01 mm。</div>';
  el.innerHTML = html;
}

const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ================= 横幅 =================

let bannerTimer = null;
function showError(payload) {
  state.error = payload;
  const b = document.getElementById('errorBanner');
  b.className = 'banner error';
  b.hidden = false;
  let txt = `⛔ ${payload.error}`;
  if (payload.at) txt += `　位置：(${payload.at[0]}, ${payload.at[1]}) mm`;
  if (payload.gaps?.length) txt += `<br>缺口面积：${payload.gaps.map((g) => g.area).join('、')} mm²`;
  b.innerHTML = txt;
  renderDraft();
}
function showSuccess(msg) {
  clearError();
  const b = document.getElementById('errorBanner');
  b.className = 'banner success';
  b.hidden = false;
  b.textContent = '✓ ' + msg;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 2500);
}
function clearError() {
  state.error = null;
  document.getElementById('errorBanner').hidden = true;
}

// ================= 图纸加载 / 新建 =================

async function loadDraft(id) {
  cancelDrawing();
  const data = await api('GET', `/api/designs/${id}`);
  state.draft = data.draft;
  document.getElementById('designMeta').innerHTML =
    `<b>${escapeHtml(data.draft.name)}</b><br>窗框 ${data.draft.width} × ${data.draft.height} mm`;
  document.getElementById('editSection').hidden = false;
  document.getElementById('pieceListSection').hidden = false;
  document.getElementById('statusSection').hidden = false;
  state.drawing = null;
  renderAllDraft();
}

function renderAllDraft() {
  document.getElementById('designSelect').value = state.draft.id;
  renderDraft();
}

async function refreshDesignSelect(selectId, selectId2) {
  const data = await api('GET', '/api/designs');
  for (const id of [selectId, selectId2].filter(Boolean)) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const d of data.designs) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name}（${d.width}×${d.height}mm）`;
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  return data.designs;
}

async function createDesign() {
  const name = document.getElementById('newName').value;
  const width = Number(document.getElementById('newWidth').value);
  const height = Number(document.getElementById('newHeight').value);
  try {
    const data = await api('POST', '/api/designs', { name, width, height });
    await refreshDesignSelect('designSelect', 'pubDesignSelect');
    document.getElementById('designSelect').value = data.design.id;
    await loadDraft(data.design.id);
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================= 发布 =================

async function publishDraft() {
  try {
    const data = await api('POST', `/api/designs/${state.draft.id}/publish`);
    showSuccess(`已发布为 v${data.publication.version}（历史版本不可修改）`);
  } catch (err) {
    const d = err.data || {};
    showError({
      error: d.error || err.message,
      gaps: d.gaps,
      at: d.gaps?.[0]?.polygon?.[0] || null,
    });
  }
}

// ================= 已发布视图 =================

const pubCanvas = document.getElementById('pubCanvas');
const pubCtx = pubCanvas.getContext('2d');
let currentPub = null;

async function loadPubDesignOptions() {
  await refreshDesignSelect('designSelect', 'pubDesignSelect');
  await loadPubVersions();
}

async function loadPubVersions() {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  const sel = document.getElementById('pubVersionSelect');
  sel.innerHTML = '';
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    currentPub = null;
    renderPublished();
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.version;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
  await loadPubVersion(sel.value);
}

async function loadPubVersion(version) {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id || !version) { currentPub = null; renderPublished(); return; }
  const data = await api('GET', `/api/designs/${id}/publications/${version}`);
  currentPub = data.publication;
  renderPublished();
}

function renderPublished() {
  pubCtx.clearRect(0, 0, pubCanvas.width, pubCanvas.height);
  document.getElementById('pubPieceList').innerHTML = '';
  document.getElementById('pubLeadList').innerHTML = '';
  document.getElementById('pubMeta').textContent = '';
  if (!currentPub) return;
  const { snapshot: s } = currentPub;
  const t = getTransform(s, pubCanvas);

  pubCtx.fillStyle = '#fbfaf7';
  pubCtx.fillRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);
  for (const pc of s.pieces) {
    const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
    pubCtx.beginPath();
    pubCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) pubCtx.lineTo(pts[i][0], pts[i][1]);
    pubCtx.closePath();
    pubCtx.fillStyle = pc.color;
    pubCtx.globalAlpha = 0.82;
    pubCtx.fill();
    pubCtx.globalAlpha = 1;
    pubCtx.strokeStyle = '#222';
    pubCtx.lineWidth = 2;
    pubCtx.stroke();
    const [cx0, cy0] = centroid(pc.polygon);
    const [cx, cy] = t.toPx(cx0, cy0);
    pubCtx.font = 'bold 13px sans-serif';
    const label = `#${pc.pieceNo}`;
    const area = `${pc.area} mm²`;
    pubCtx.textAlign = 'center';
    pubCtx.textBaseline = 'middle';
    pubCtx.fillStyle = 'rgba(255,255,255,0.8)';
    const w1 = pubCtx.measureText(label).width;
    const w2 = pubCtx.measureText(area).width;
    pubCtx.fillRect(cx - Math.max(w1, w2) / 2 - 5, cy - 16, Math.max(w1, w2) + 10, 34);
    pubCtx.fillStyle = '#000';
    pubCtx.fillText(label, cx, cy - 7);
    pubCtx.font = '11px sans-serif';
    pubCtx.fillStyle = '#444';
    pubCtx.fillText(area, cx, cy + 9);
  }
  pubCtx.strokeStyle = '#111';
  pubCtx.lineWidth = 3.5;
  pubCtx.strokeRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);

  document.getElementById('pubMeta').innerHTML =
    `<b>${escapeHtml(s.name)}</b> v${currentPub.version}<br>` +
    `${s.width} × ${s.height} mm · 发布于 ${currentPub.publishedAt}`;

  // 明细
  const ul = document.getElementById('pubPieceList');
  for (const pc of s.pieces) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${pc.color}"></span>
      <span class="piece-meta"><span class="no">#${pc.pieceNo}</span>
      <span class="area">${pc.area} mm²</span></span>`;
    ul.appendChild(li);
  }

  // 清单
  const L = s.leadList;
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]})→(${b[0]},${b[1]})</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td></td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">外框</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td colspan="2">铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  document.getElementById('pubLeadList').innerHTML = html;
}

// ================= 事件绑定与启动 =================

document.getElementById('tabDraft').addEventListener('click', () => switchTab('draft'));
document.getElementById('tabPublished').addEventListener('click', () => switchTab('published'));
document.getElementById('tabProduction').addEventListener('click', () => switchTab('production'));
document.getElementById('btnCreate').addEventListener('click', createDesign);
document.getElementById('designSelect').addEventListener('change', (e) => loadDraft(Number(e.target.value)));
document.getElementById('pubDesignSelect').addEventListener('change', loadPubVersions);
document.getElementById('pubVersionSelect').addEventListener('change', (e) => loadPubVersion(e.target.value));
document.getElementById('btnStart').addEventListener('click', () => {
  if (state.editingId) cancelDrawing();
  if (!state.drawing) startDrawing();
});
document.getElementById('btnFinish').addEventListener('click', () => {
  if (!state.drawing) {
    showError({ error: '请先点击“开始绘制新片”，或直接在文本框输入坐标' });
    return;
  }
  const parsed = coordsFromTextarea();
  if (parsed.error) { showError({ error: parsed.error }); return; }
  if (parsed.points.length) state.drawing.points = parsed.points;
  finishDrawing();
});
document.getElementById('btnUndo').addEventListener('click', () => {
  if (state.drawing?.points.length) {
    state.drawing.points.pop();
    syncCoordsText();
    renderDraft();
  }
});
document.getElementById('btnCancel').addEventListener('click', cancelDrawing);
document.getElementById('btnPublish').addEventListener('click', publishDraft);

function switchTab(which) {
  document.getElementById('tabDraft').classList.toggle('active', which === 'draft');
  document.getElementById('tabPublished').classList.toggle('active', which === 'published');
  document.getElementById('tabReuse').classList.toggle('active', which === 'reuse');
  document.getElementById('tabDiff').classList.toggle('active', which === 'diff');
  document.getElementById('tabPrint').classList.toggle('active', which === 'print');
  document.getElementById('tabProduction').classList.toggle('active', which === 'production');
  document.getElementById('tabCutting').classList.toggle('active', which === 'cutting');
  document.getElementById('tabCombo').classList.toggle('active', which === 'combo');
  document.getElementById('tabStocktake').classList.toggle('active', which === 'stocktake');
  document.getElementById('tabIssue').classList.toggle('active', which === 'issue');
  document.getElementById('tabQuarantine').classList.toggle('active', which === 'quarantine');
  document.getElementById('tabLedger').classList.toggle('active', which === 'ledger');
  document.getElementById('viewDraft').hidden = which !== 'draft';
  document.getElementById('viewPublished').hidden = which !== 'published';
  document.getElementById('viewReuse').hidden = which !== 'reuse';
  document.getElementById('viewDiff').hidden = which !== 'diff';
  document.getElementById('viewPrint').hidden = which !== 'print';
  document.getElementById('viewProduction').hidden = which !== 'production';
  document.getElementById('viewCutting').hidden = which !== 'cutting';
  document.getElementById('viewCombo').hidden = which !== 'combo';
  document.getElementById('viewStocktake').hidden = which !== 'stocktake';
  document.getElementById('viewIssue').hidden = which !== 'issue';
  document.getElementById('viewQuarantine').hidden = which !== 'quarantine';
  document.getElementById('viewLedger').hidden = which !== 'ledger';
  if (which === 'published') loadPubVersions();
  if (which === 'reuse') enterReuse();
  if (which === 'diff') enterDiff();
  if (which === 'print') enterPrint();
  if (which === 'production') enterProduction();
  if (which === 'cutting') enterCutting();
  if (which === 'combo') enterCombo();
  if (which === 'stocktake') enterStocktake();
  if (which === 'issue') enterIssue();
  if (which === 'quarantine') enterQuarantine();
  if (which === 'ledger') enterLedger();
}

(async function init() {
  const designs = await refreshDesignSelect('designSelect', 'pubDesignSelect');
  if (designs.length) {
    document.getElementById('designSelect').value = designs[0].id;
    await loadDraft(designs[0].id);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('请在左侧“新建图纸”，输入正整数毫米的窗框宽高', canvas.width / 2, canvas.height / 2);
  }
})();

// ================= 版本核对 =================

const diffState = { result: null };

const diffCanvas = document.getElementById('diffCanvas');
const diffCtx = diffCanvas.getContext('2d');

const DIFF_STYLE = {
  kept: { color: '#1565c0', text: '沿用' },
  removed: { color: '#d32f2f', text: '取消' },
  added: { color: '#2e7d4f', text: '新增' },
};

async function enterDiff() {
  await refreshDesignSelect('diffDesignSelect');
  await loadDiffVersions();
}

async function loadDiffVersions() {
  const id = document.getElementById('diffDesignSelect').value;
  const fromSel = document.getElementById('diffFromSelect');
  const toSel = document.getElementById('diffToSelect');
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  const pubs = data.publications; // 版本倒序
  if (!pubs.length) {
    fromSel.innerHTML = '<option value="">（暂无发布版）</option>';
    toSel.innerHTML = '<option value="">（暂无发布版）</option>';
    return;
  }
  const asc = pubs.slice().reverse();
  for (const p of asc) {
    for (const sel of [fromSel, toSel]) {
      const opt = document.createElement('option');
      opt.value = p.version;
      opt.textContent = `v${p.version} · ${p.publishedAt}`;
      sel.appendChild(opt);
    }
  }
  fromSel.value = asc[asc.length - 2] ? asc[asc.length - 2].version : asc[0].version;
  toSel.value = asc[asc.length - 1].version;
}

async function runDiff() {
  const designId = document.getElementById('diffDesignSelect').value;
  const fromVersion = Number(document.getElementById('diffFromSelect').value);
  const toVersion = Number(document.getElementById('diffToSelect').value);
  const msg = document.getElementById('diffMsg');
  if (!designId || !fromVersion || !toVersion) {
    msg.textContent = '请选择同一图纸的两个已发布版本。';
    return;
  }
  if (fromVersion === toVersion) {
    msg.textContent = '请选择两个不同的版本（同版本可比较，但所有线段都会归为“沿用”）。';
  } else {
    msg.textContent = '';
  }
  try {
    const url = `/api/designs/${designId}/publications/diff?fromVersion=${fromVersion}&toVersion=${toVersion}`;
    const data = await api('GET', url);
    diffState.result = data;
    renderDiff();
    showDiffBanner(false);
  } catch (err) {
    diffState.result = null;
    renderDiffEmpty();
    showDiffBanner('error', err.message);
  }
}

function showDiffBanner(kind, text) {
  const b = document.getElementById('diffBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.textContent = text;
}

function renderDiffEmpty() {
  diffCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);
  document.getElementById('diffSummary').innerHTML = '';
  document.getElementById('diffInternal').innerHTML = '';
  document.getElementById('diffFrame').innerHTML = '';
}

function renderDiff() {
  const { meta, diff } = diffState.result;

  // ---- 合计卡 ----
  document.getElementById('diffSummary').innerHTML = `
    <div class="muted" style="margin:0 0 6px">
      <b>${escapeHtml(meta.designName || `图纸 #${meta.designId}`)}</b><br>
      v${meta.earlier.version}（${meta.earlier.publishedAt}） →
      v${meta.later.version}（${meta.later.publishedAt}）<br>
      窗框 ${meta.width} × ${meta.height} mm
    </div>
    ${summaryTable(diff.internal.totals, diff.internal.counts, '内部公共边')}
    ${summaryTable(diff.frameTotals, diff.frameCounts, '四根外框')}
    ${summaryTable(diff.totals, diff.counts, '铅条总长')}
    <div class="hint">合计均先对各段原始长度求和，再四舍五入到 0.01 mm。</div>`;

  // ---- 内部明细 ----
  const intEl = document.getElementById('diffInternal');
  const ic = diff.internal;
  if (!ic.kept.length && !ic.removed.length && !ic.added.length) {
    intEl.innerHTML = '<div class="hint">两版都没有内部公共边。</div>';
  } else {
    let html = '<table><thead><tr><th>类别</th><th>起点 → 终点 (mm)</th><th class="num">长度</th></tr></thead><tbody>';
    html += rowsOf(ic.removed, 'removed');
    html += rowsOf(ic.added, 'added');
    html += rowsOf(ic.kept, 'kept');
    html += `<tr class="totals"><td colspan="2">内部公共边合计</td><td class="num">
      沿用 ${fmt(ic.totals.kept)} / 取消 ${fmt(ic.totals.removed)} / 新增 ${fmt(ic.totals.added)}</td></tr>`;
    html += '</tbody></table>';
    intEl.innerHTML = html;
  }

  // ---- 外框明细 ----
  const frEl = document.getElementById('diffFrame');
  let frHtml = '<table><thead><tr><th>外框</th><th>沿用</th><th>取消</th><th>新增</th></tr></thead><tbody>';
  for (const side of diff.frameOrder) {
    const f = diff.frame[side];
    frHtml += `<tr><td>${side}</td>
      <td class="num kept">${f.counts.kept ? `${fmt(f.totals.kept)}（${f.counts.kept}）` : '—'}</td>
      <td class="num removed">${f.counts.removed ? `${fmt(f.totals.removed)}（${f.counts.removed}）` : '—'}</td>
      <td class="num added">${f.counts.added ? `${fmt(f.totals.added)}（${f.counts.added}）` : '—'}</td></tr>`;
  }
  frHtml += `<tr class="totals"><td>外框合计</td>
    <td class="num kept">${fmt(diff.frameTotals.kept)}</td>
    <td class="num removed">${fmt(diff.frameTotals.removed)}</td>
    <td class="num added">${fmt(diff.frameTotals.added)}</td></tr>`;
  frHtml += '</tbody></table>';
  frEl.innerHTML = frHtml;

  document.getElementById('diffCanvasHint').textContent =
    `共沿用 ${diff.counts.kept} 段、取消 ${diff.counts.removed} 段、新增 ${diff.counts.added} 段；部分重叠处已按端点拆分。`;

  renderDiffCanvas();
}

function summaryTable(totals, counts, title) {
  return `<table class="diff-sum"><thead><tr><th>${title}</th><th class="num">沿用</th><th class="num">取消</th><th class="num">新增</th></tr></thead>
    <tbody><tr>
      <td class="muted">${counts.kept} / ${counts.removed} / ${counts.added} 段</td>
      <td class="num kept">${fmt(totals.kept)}</td>
      <td class="num removed">${fmt(totals.removed)}</td>
      <td class="num added">${fmt(totals.added)}</td>
    </tr></tbody></table>`;
}

function rowsOf(list, kind) {
  return list.map((s) => `<tr>
    <td><span class="diff-tag ${kind}">${DIFF_STYLE[kind].text}</span></td>
    <td>(${s.from[0]},${s.from[1]}) → (${s.to[0]},${s.to[1]})</td>
    <td class="num">${fmt(s.length)}</td></tr>`).join('');
}

function renderDiffCanvas() {
  const { diff } = diffState.result;
  const frame = { width: diff.width, height: diff.height };
  const t = getTransform(frame, diffCanvas);
  diffCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);

  // 背景
  diffCtx.fillStyle = '#fbfaf7';
  diffCtx.fillRect(...t.toPx(0, frame.height), frame.width * t.scale, frame.height * t.scale);

  // 先画取消/新增（偏离中线向两侧微移，避免与沿用重叠时互相盖住）
  drawDiffSegments(diff.internal.removed, 'removed', t, -2.5);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].removed, 'removed', t, -2.5);
  drawDiffSegments(diff.internal.added, 'added', t, 2.5);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].added, 'added', t, 2.5);
  // 沿用最后画在中线上
  drawDiffSegments(diff.internal.kept, 'kept', t, 0);
  for (const side of diff.frameOrder) drawDiffSegments(diff.frame[side].kept, 'kept', t, 0);

  // 窗框
  diffCtx.strokeStyle = '#222';
  diffCtx.lineWidth = 2;
  diffCtx.strokeRect(...t.toPx(0, frame.height), frame.width * t.scale, frame.height * t.scale);
}

function drawDiffSegments(list, kind, t, offsetPx) {
  if (!list.length) return;
  diffCtx.lineCap = 'round';
  for (const s of list) {
    let [x1, y1] = t.toPx(s.from[0], s.from[1]);
    let [x2, y2] = t.toPx(s.to[0], s.to[1]);
    if (offsetPx) {
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const nl = Math.hypot(nx, ny) || 1;
      x1 += nx / nl * offsetPx; x2 += nx / nl * offsetPx;
      y1 += ny / nl * offsetPx; y2 += ny / nl * offsetPx;
    }
    diffCtx.beginPath();
    diffCtx.moveTo(x1, y1);
    diffCtx.lineTo(x2, y2);
    diffCtx.strokeStyle = DIFF_STYLE[kind].color;
    diffCtx.globalAlpha = kind === 'kept' ? 0.9 : 0.75;
    diffCtx.lineWidth = kind === 'kept' ? 4 : 6;
    if (kind === 'removed') diffCtx.setLineDash([7, 5]); else diffCtx.setLineDash([]);
    diffCtx.stroke();
    diffCtx.setLineDash([]);
    diffCtx.globalAlpha = 1;
    // 端点
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      if (kind !== 'kept' || offsetPx === 0) {
        diffCtx.beginPath();
        diffCtx.arc(x, y, 2.5, 0, Math.PI * 2);
        diffCtx.fillStyle = DIFF_STYLE[kind].color;
        diffCtx.fill();
      }
    }
  }
}

document.getElementById('tabDiff').addEventListener('click', () => switchTab('diff'));
document.getElementById('tabPrint').addEventListener('click', () => switchTab('print'));
document.getElementById('diffDesignSelect').addEventListener('change', loadDiffVersions);
document.getElementById('btnDiffRun').addEventListener('click', runDiff);

// ================= 铅条生产 =================

const prod = {
  materials: [],
  designs: [],
  publications: [],   // 选中图纸的发布版
  plans: [],
  detailPlan: null,   // 当前展示详情的计划
};

function prodBanner(kind, msg) {
  const b = document.getElementById('prodBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
  clearTimeout(prodBanner._t);
  if (kind === 'success') prodBanner._t = setTimeout(() => { b.hidden = true; }, 3000);
}

async function enterProduction() {
  prodBanner(false);
  await Promise.all([loadMaterials(), refreshProdDesigns(), loadPlans()]);
}

// ---------- 库存 ----------

async function loadMaterials() {
  const data = await api('GET', '/api/materials');
  prod.materials = data.materials;
  renderMaterials();
  renderMaterialOptions();
}

function renderMaterials() {
  const el = document.getElementById('matList');
  if (!prod.materials.length) {
    el.innerHTML = '<div class="hint">尚未登记原材。</div>';
    return;
  }
  let html = '<table><thead><tr><th>规格</th><th class="num">定尺</th><th class="num">库存</th><th class="num">已领</th><th class="num">未领预留</th><th class="num">可用</th><th></th></tr></thead><tbody>';
  for (const m of prod.materials) {
    html += `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td class="num">${fmt(m.length)}</td>
      <td class="num">${m.stock}</td>
      <td class="num">${m.picked || 0}</td>
      <td class="num">${m.reserved}</td>
      <td class="num"><b>${m.available}</b></td>
      <td><input type="number" min="0" step="1" value="${m.stock}" class="stock-edit" data-id="${m.id}" style="width:72px"></td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  el.querySelectorAll('.stock-edit').forEach((inp) => {
    inp.addEventListener('change', () => updateStock(Number(inp.dataset.id), Number(inp.value), inp));
  });
}

function renderMaterialOptions() {
  const sel = document.getElementById('planMaterialSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const m of prod.materials) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name}（定尺 ${fmt(m.length)} mm · 可用 ${m.available} 根）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function addMaterial() {
  const msg = document.getElementById('matMsg');
  const name = document.getElementById('matName').value;
  const length = Number(document.getElementById('matLength').value);
  const stock = Number(document.getElementById('matStock').value);
  if (!name.trim()) { msg.textContent = '请填写规格名称'; return; }
  try {
    await api('POST', '/api/materials', { name, length, stock });
    document.getElementById('matName').value = '';
    msg.textContent = '✓ 已登记';
    await loadMaterials();
  } catch (err) { msg.textContent = '⛔ ' + err.message; }
}

async function updateStock(id, stock, inp) {
  const msg = document.getElementById('matMsg');
  if (!Number.isInteger(stock) || stock < 0) {
    msg.textContent = '⛔ 库存根数必须是非负整数，输入已忽略';
    await loadMaterials();
    return;
  }
  try {
    await api('PATCH', `/api/materials/${id}`, { stock });
    msg.textContent = '✓ 库存已更新';
    await loadMaterials();
    await loadPlans();
  } catch (err) {
    msg.textContent = '⛔ ' + err.message;
    await loadMaterials();
  }
}

// ---------- 图纸/版本/规格选择 ----------

async function refreshProdDesigns() {
  const data = await api('GET', '/api/designs');
  prod.designs = data.designs;
  const sel = document.getElementById('planDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of prod.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.latest_version
      ? `${d.name}（最新 v${d.latest_version}）`
      : `${d.name}（暂无发布版）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadPlanVersions();
}

async function loadPlanVersions() {
  const sel = document.getElementById('planVersionSelect');
  sel.innerHTML = '';
  prod.publications = [];
  const id = Number(document.getElementById('planDesignSelect').value);
  if (!id) {
    sel.innerHTML = '<option value="">（请先选择图纸）</option>';
    return;
  }
  const data = await api('GET', `/api/designs/${id}/publications`);
  prod.publications = data.publications;
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（该图纸暂无发布版）</option>';
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    // 列表接口只有 id/version/publishedAt；需要 publication 的完整 id
    opt.value = p.id;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

function selectedPlanInput() {
  return {
    publicationId: Number(document.getElementById('planVersionSelect').value),
    materialId: Number(document.getElementById('planMaterialSelect').value),
    copies: Number(document.getElementById('planCopies').value),
    kerf: Number(document.getElementById('planKerf').value),
  };
}

// ---------- 预览 ----------

async function previewPlan() {
  const body = selectedPlanInput();
  if (!body.publicationId) { showPreviewHint('请先发布图纸，再选择发布版本。'); return; }
  if (!body.materialId) { showPreviewHint('请先登记原材规格。'); return; }
  try {
    const data = await api('POST', '/api/plans/preview', body);
    prod.detailPlan = null;
    renderLayout(data.preview, { preview: true });
    prodBanner(false);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.segment) txt += `（${d.segment.name}：成品 ${fmt(d.segment.length)} mm，含刀损 ${fmt(d.segment.withKerf)} mm，超过原材定尺）`;
    prodBanner('error', txt);
    showPreviewHint(txt.replace('⛔ ', ''));
  }
}

function showPreviewHint(text) {
  document.getElementById('previewContent').innerHTML =
    `<div class="hint">${escapeHtml(text)}</div>`;
}

// detail: { preview:true } 或 { plan:obj }
function renderLayout(detail, mode) {
  const p = mode.preview ? detail : detail.plan;
  const L = p.layout;
  const isPreview = !!mode.preview;
  let html = '';

  html += `<div class="plan-head">
    <div><b>${isPreview ? '排产预览（不落库、不占库存）' : `计划 #${p.id} · ${escapeHtml(p.name)}`}</b></div>
    <div class="muted">发布版 v${p.version} · ${p.copies} 件 ·
      原材 ${escapeHtml(p.material ? p.material.name : '')}（定尺 ${fmt(L.materialLength)} mm）·
      每刀损耗 ${fmt(L.kerf)} mm</div></div>`;

  // 库存结论
  if (isPreview || p.status === 'draft') {
    const need = L.requiredBars, avail = p.availableBars ?? detail.availableBars;
    const shortage = p.shortage ?? detail.shortage ?? Math.max(0, need - avail);
    if (shortage > 0) {
      html += `<div class="stock-badge bad">⚠ 需用 <b>${need}</b> 根，可用 <b>${avail}</b> 根，缺口 <b>${shortage}</b> 根——不能确认</div>`;
    } else {
      html += `<div class="stock-badge ok">✓ 需用 <b>${need}</b> 根，可用 <b>${avail}</b> 根，库存充足（预览不占库存）</div>`;
    }
  } else {
    html += `<div class="stock-badge ${p.status === 'confirmed' ? 'ok' : 'cancel'}">
      ${p.status === 'confirmed' ? '✓ 已确认（库存已原子预留）' : '已取消（预留已释放）'}</div>`;
  }

  if (p.comboId) {
    html += `<div class="stock-badge replace">🔗 该计划属于整套用料单 #${p.comboId}，只能随整套单取消；此处不能单独取消、修改或删除。</div>`;
  }

  html += `<div class="muted">共 ${L.totals.segmentCount} 段；成品合计 ${fmt(L.totals.finishedLength)} mm，
    刀损合计 ${fmt(L.totals.kerfTotal)} mm，余料合计 ${fmt(L.totals.remainderTotal)} mm。</div>`;

  html += '<div class="bars">';
  for (const bar of L.bars) {
    html += `<div class="bar-card">
      <div class="bar-title">原材 #${bar.index} · 用 ${fmt(bar.usedLength)} mm · 余料 <b>${fmt(bar.remainder)}</b> mm</div>
      <div class="bar-track">${barTrack(bar, L.materialLength)}</div>
      <table><thead><tr><th>件次</th><th>切段</th><th class="num">成品</th><th class="num">刀损</th></tr></thead><tbody>`;
    for (const c of bar.cuts) {
      html += `<tr><td>第 ${c.piece} 件</td><td>${sourceLabel(c)}</td>
        <td class="num">${fmt(c.length)}</td><td class="num muted">${fmt(c.kerf)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';

  if (isPreview) {
    html += `<div class="btn-row"><button id="btnSaveDraft" class="primary">存为草稿计划</button></div>`;
  } else if (p.comboId) {
    // 整套关联计划：无任何独立操作按钮
  } else if (p.status === 'draft') {
    html += `<div class="btn-row">
      <button id="btnPlanConfirm" class="primary">确认计划（预留 ${L.requiredBars} 根）</button>
      <button id="btnPlanDelete" class="danger">删除草稿</button>
      <button id="btnPlanReedit">按此参数重新编辑</button></div>`;
  } else if (p.status === 'confirmed') {
    html += `<div class="btn-row"><button id="btnPlanCancel" class="danger">取消计划（释放预留）</button></div>`;
  }

  document.getElementById('previewContent').innerHTML = html;

  const saveBtn = document.getElementById('btnSaveDraft');
  if (saveBtn) saveBtn.addEventListener('click', () => saveDraft(detail));
  const cf = document.getElementById('btnPlanConfirm');
  if (cf) cf.addEventListener('click', () => confirmPlan(p.id));
  const de = document.getElementById('btnPlanDelete');
  if (de) de.addEventListener('click', () => deletePlan(p.id));
  const ca = document.getElementById('btnPlanCancel');
  if (ca) ca.addEventListener('click', () => cancelPlan(p.id));
  const re = document.getElementById('btnPlanReedit');
  if (re) re.addEventListener('click', () => fillEditorFromPlan(p));
}

function sourceLabel(c) {
  const tail = c.from && c.to
    ? ` <span class="muted small">(${c.from[0]},${c.from[1]})→(${c.to[0]},${c.to[1]})</span>`
    : '';
  return `${c.name}${tail}`;
}

// 简单的余料比例条
function barTrack(bar, totalLen) {
  let pct = 0, acc = 0;
  const colors = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9'];
  let html = '<div class="track">';
  bar.cuts.forEach((c, i) => {
    const w = (c.length + c.kerf) / totalLen * 100;
    html += `<div class="seg" style="left:${acc}%;width:${w}%;background:${colors[i % colors.length]}"
      title="第${c.piece}件 ${c.name} ${fmt(c.length)} + ${fmt(c.kerf)}"></div>`;
    acc += w;
  });
  pct = acc;
  html += `<div class="rem" style="left:${pct}%;width:${100 - pct}%"></div></div>`;
  return html;
}

// ---------- 草稿保存 / 确认 / 取消 / 删除 ----------

async function saveDraft(preview) {
  const name = document.getElementById('planName').value;
  try {
    const data = await api('POST', '/api/plans', {
      name: name || undefined,
      publicationId: preview.publicationId,
      materialId: preview.material.id,
      copies: preview.copies,
      kerf: preview.kerf,
    });
    prodBanner('success', `✓ 已存为草稿计划 #${data.plan.id}（尚未占用库存）`);
    await loadPlans(data.plan.id);
  } catch (err) { prodBanner('error', '⛔ ' + err.message); }
}

async function confirmPlan(id) {
  try {
    const data = await api('POST', `/api/plans/${id}/confirm`);
    prodBanner('success', `✓ 计划 #${id} 已确认，预留 ${data.plan.requiredBars} 根`);
    await loadMaterials();
    await loadPlans(id);
  } catch (err) {
    const d = err.data || {};
    prodBanner('error', '⛔ ' + (d.error || err.message));
    await loadMaterials();
    await loadPlans(id);
  }
}

async function cancelPlan(id) {
  if (!confirm(`确定取消计划 #${id}？已预留的根数将释放。`)) return;
  try {
    const data = await api('POST', `/api/plans/${id}/cancel`);
    prodBanner('success', `计划 #${id} 已取消，释放 ${data.plan.requiredBars} 根`);
    await loadMaterials();
    await loadPlans(id);
  } catch (err) { prodBanner('error', '⛔ ' + err.message); await loadPlans(id); }
}

async function deletePlan(id) {
  if (!confirm(`确定删除草稿计划 #${id}？`)) return;
  try {
    await api('DELETE', `/api/plans/${id}`);
    prodBanner('success', `草稿 #${id} 已删除`);
    prod.detailPlan = null;
    showPreviewHint('草稿已删除。');
    await loadPlans();
  } catch (err) { prodBanner('error', '⛔ ' + err.message); }
}

function fillEditorFromPlan(p) {
  document.getElementById('planDesignSelect').value = p.designId;
  document.getElementById('planCopies').value = p.copies;
  document.getElementById('planKerf').value = p.kerf;
  loadPlanVersions().then(() => {
    document.getElementById('planVersionSelect').value = p.publicationId;
    document.getElementById('planMaterialSelect').value = p.materialId;
  });
}

// ---------- 计划列表 ----------

async function loadPlans(selectId) {
  const data = await api('GET', '/api/plans');
  prod.plans = data.plans;
  renderPlanList();
  if (selectId) {
    const p = prod.plans.find((x) => x.id === selectId);
    if (p) renderLayout({ plan: p }, { preview: false });
  }
}

function renderPlanList() {
  const el = document.getElementById('planList');
  if (!prod.plans.length) {
    el.innerHTML = '<div class="hint">暂无计划。</div>';
    return;
  }
  el.innerHTML = prod.plans.map((p) => {
    const badge = p.status === 'confirmed'
      ? '<span class="badge ok">已确认</span>'
      : p.status === 'canceled'
        ? '<span class="badge bad" style="background:#eee;color:#888">已取消</span>'
        : '<span class="badge bad">草稿</span>';
    const warn = p.status === 'draft' && p.shortage > 0
      ? ` <span class="gap-info">缺 ${p.shortage} 根</span>` : '';
    const comboTag = p.comboId
      ? ` <span class="muted small">🔗 整套 #${p.comboId}</span>` : '';
    const issueTag = p.status === 'confirmed' && p.pickedBars > 0
      ? ` <span class="badge" style="background:#fff4e0;color:#b26a00">已领 ${p.pickedBars}/${p.requiredBars} · 余 ${p.remainingBars}</span>`
      : '';
    return `<div class="plan-item${prod.detailPlan === p.id ? ' active' : ''}" data-id="${p.id}">
      <div>${badge} <b>#${p.id}</b> ${escapeHtml(p.name)}${warn}${comboTag}${issueTag}</div>
      <div class="muted small">v${p.version} · ${p.copies}件 · 用 ${p.requiredBars} 根 ·
        ${escapeHtml(p.material ? p.material.name : '规格已删')}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.plan-item').forEach((div) => {
    div.addEventListener('click', () => {
      const p = prod.plans.find((x) => x.id === Number(div.dataset.id));
      prod.detailPlan = p.id;
      renderPlanList();
      renderLayout({ plan: p }, { preview: false });
    });
  });
}

// ---------- 事件绑定 ----------

document.getElementById('btnMatAdd').addEventListener('click', addMaterial);
document.getElementById('planDesignSelect').addEventListener('change', loadPlanVersions);
document.getElementById('btnPlanPreview').addEventListener('click', previewPlan);

// ================= 已发布图纸 1:1 分张打印 =================

const printState = {
  snapshot: null,   // 所选不可变发布版快照
  version: null,
  preview: null,    // 预览返回的 print 结构
  params: null,
  designId: null,
  activePage: 1,
};

const printCanvas = document.getElementById('printCanvas');
const printCtx = printCanvas.getContext('2d');

function printBanner(kind, msg) {
  const b = document.getElementById('printBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.textContent = msg;
}

async function enterPrint() {
  printBanner(false);
  const data = await api('GET', '/api/designs');
  const sel = document.getElementById('printDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of data.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.latest_version
      ? `${d.name}（${d.width}×${d.height}mm · 最新 v${d.latest_version}）`
      : `${d.name}（暂无发布版）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadPrintVersions();
  if (printState.preview) renderPrintCanvas();
}

async function loadPrintVersions() {
  const id = Number(document.getElementById('printDesignSelect').value);
  const sel = document.getElementById('printVersionSelect');
  sel.innerHTML = '';
  printState.snapshot = null;
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.version;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

function printParamsFromForm() {
  return {
    paperWidth: Number(document.getElementById('printPaperW').value),
    paperHeight: Number(document.getElementById('printPaperH').value),
    margin: Number(document.getElementById('printMargin').value),
    overlap: Number(document.getElementById('printOverlap').value),
  };
}

async function runPrintPreview() {
  const designId = Number(document.getElementById('printDesignSelect').value);
  const version = Number(document.getElementById('printVersionSelect').value);
  if (!designId || !version) { printBanner('error', '请先选择图纸与已发布版本'); return; }
  const params = printParamsFromForm();
  try {
    const [pv, pubd] = await Promise.all([
      api('POST', `/api/designs/${designId}/publications/${version}/print/preview`, params),
      api('GET', `/api/designs/${designId}/publications/${version}`),
    ]);
    printState.designId = designId;
    printState.version = version;
    printState.params = params;
    printState.preview = pv.preview.print;
    printState.snapshot = pubd.publication.snapshot;
    printState.activePage = 1;
    renderPrintResult();
    printBanner(false);
  } catch (err) {
    printState.preview = null;
    document.getElementById('printSummarySection').hidden = true;
    document.getElementById('printPageListSection').hidden = true;
    printCtx.clearRect(0, 0, printCanvas.width, printCanvas.height);
    printBanner('error', '⛔ ' + err.message);
  }
}

function renderPrintResult() {
  const P = printState.preview;
  document.getElementById('printSummarySection').hidden = false;
  document.getElementById('printPageListSection').hidden = false;
  document.getElementById('printSummary').innerHTML = `
    <div class="muted">
      <b>${escapeHtml(printState.snapshot.name)}</b> v${printState.version} ·
      图纸 ${P.content.width} × ${P.content.height} mm
    </div>
    <div class="stock-badge ok">共 <b>${P.rows}</b> 行 × <b>${P.cols}</b> 列 ＝
      <b>${P.totalPages}</b> 页</div>
    <div class="muted small">纸张 ${P.paper.width} × ${P.paper.height} mm ｜ 留白 ${P.margin} mm ｜
      可打印 ${P.printable.width} × ${P.printable.height} mm ｜ 相邻页重叠 ${P.overlap} mm</div>
    <div class="muted small">${escapeHtml(P.pageNumbering)}</div>`;

  const ul = document.getElementById('printPageList');
  ul.innerHTML = '';
  for (const pg of P.pages) {
    const li = document.createElement('li');
    li.className = 'print-page-item';
    li.dataset.page = pg.page;
    const seamTxt = pg.seams
      .map((s) => `${({ left: '左', right: '右', top: '上', bottom: '下' })[s.edge]}→第${s.neighborPage}页`)
      .join('，');
    li.innerHTML = `<div><b>第 ${pg.page}/${P.totalPages} 页</b>
        <span class="muted small">（${pg.row}行 ${pg.col}列）</span></div>
      <div class="small muted">覆盖 x ${pg.coverage.x0}–${pg.coverage.x1}，y ${pg.coverage.y0}–${pg.coverage.y1} mm
        （${pg.coverage.width} × ${pg.coverage.height} mm）</div>
      <div class="small">${seamTxt ? `拼接：${seamTxt}` : '本页无需拼接'}</div>`;
    const dl = document.createElement('button');
    dl.className = 'icon-btn';
    dl.title = '下载本页 SVG（1:1 毫米尺寸）';
    dl.textContent = '⬇ SVG';
    dl.addEventListener('click', (e) => { e.stopPropagation(); downloadPageSvg(pg.page); });
    li.appendChild(dl);
    li.addEventListener('click', () => { printState.activePage = pg.page; renderPrintCanvas(); markActivePage(); });
    ul.appendChild(li);
  }
  markActivePage();
  renderPrintCanvas();
}

function markActivePage() {
  document.querySelectorAll('.print-page-item').forEach((li) => {
    li.classList.toggle('active', Number(li.dataset.page) === printState.activePage);
  });
}

// 直接用浏览器导航 svgUrl（同站 GET），浏览器对 image/svg+xml 触发下载/打开；
// 为强制“另存”，fetch 成 Blob 后用 a[download] 保存。
async function downloadPageSvg(page) {
  const pg = printState.preview.pages.find((p) => p.page === page);
  if (!pg) return;
  const resp = await fetch(pg.svgUrl);
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    printBanner('error', '⛔ ' + (d.error || `下载失败 (${resp.status})`));
    return;
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `design-${printState.designId}-v${printState.version}-page-${page}of${printState.preview.totalPages}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadAllSvgs() {
  if (!printState.preview) return;
  for (const pg of printState.preview.pages) {
    // 顺序下载，避免浏览器同时弹出大量保存框
    await downloadPageSvg(pg.page);
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ---------- 拼接示意画布 ----------

function renderPrintCanvas() {
  const cv = printCanvas, cx = printCtx;
  cx.clearRect(0, 0, cv.width, cv.height);
  const P = printState.preview;
  const s = printState.snapshot;
  if (!P || !s) return;

  // 以图纸坐标系铺满画布
  const pad = 46;
  const scale = Math.min((cv.width - pad * 2) / s.width, (cv.height - pad * 2 - 24) / s.height);
  const ox = (cv.width - s.width * scale) / 2;
  const oy = (cv.height - s.height * scale) / 2 + 10;
  const toPx = (x, y) => [ox + x * scale, cv.height - (oy + y * scale)];

  // 图纸底
  cx.fillStyle = '#fbfaf7';
  cx.fillRect(...toPx(0, s.height), s.width * scale, s.height * scale);

  // 玻璃片（淡色）
  for (const pc of s.pieces) {
    const pts = pc.polygon.map(([x, y]) => toPx(x, y));
    cx.beginPath();
    cx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i][0], pts[i][1]);
    cx.closePath();
    cx.fillStyle = pc.color;
    cx.globalAlpha = 0.35;
    cx.fill();
    cx.globalAlpha = 1;
    cx.strokeStyle = '#999';
    cx.lineWidth = 1;
    cx.stroke();
  }

  // 每页覆盖矩形（蓝框）+ 重叠带高亮
  for (const pg of P.pages) {
    const [rx0, ry1] = toPx(pg.coverage.x0, pg.coverage.y0);
    const w = pg.coverage.width * scale, h = pg.coverage.height * scale;
    const active = pg.page === printState.activePage;
    cx.strokeStyle = active ? '#0d47a1' : '#1565c0';
    cx.lineWidth = active ? 2.6 : 1.3;
    cx.setLineDash(active ? [] : [6, 3]);
    cx.strokeRect(rx0, ry1 - h, w, h);
    cx.setLineDash([]);
    // 页码标签（左上角）
    cx.fillStyle = active ? '#0d47a1' : 'rgba(21,101,192,0.85)';
    cx.font = 'bold 12px sans-serif';
    cx.textAlign = 'left';
    cx.textBaseline = 'top';
    cx.fillText(`${pg.page}`, rx0 + 3, ry1 - h + 3);
  }

  // 拼接边（绿虚线）与对位十字（红）
  for (const pg of P.pages) {
    for (const seam of pg.seams) {
      // 每条拼接边画一次（只画 left/bottom 边，避免重复）
      if (seam.edge === 'right' || seam.edge === 'top') continue;
      const b = seam.overlap;
      cx.fillStyle = 'rgba(21,101,192,0.12)';
      const [bx0, by1] = toPx(b.x0, b.y0);
      cx.fillRect(bx0, by1 - b.height * scale, b.width * scale, b.height * scale);
      cx.strokeStyle = '#2e7d4f';
      cx.lineWidth = 1.6;
      cx.setLineDash([7, 4]);
      cx.beginPath();
      if (seam.direction === 'vertical') {
        const [x1, y1] = toPx(seam.drawingCoord, pg.coverage.y0);
        const [, y2] = toPx(seam.drawingCoord, pg.coverage.y1);
        cx.moveTo(x1, y1); cx.lineTo(x1, y2);
      } else {
        const [x1, y1] = toPx(pg.coverage.x0, seam.drawingCoord);
        const [x2] = toPx(pg.coverage.x1, seam.drawingCoord);
        cx.moveTo(x1, y1); cx.lineTo(x2, y1);
      }
      cx.stroke();
      cx.setLineDash([]);
      for (const cr of seam.crosses) {
        const [px2, py2] = toPx(cr.x, cr.y);
        cx.strokeStyle = '#c62828';
        cx.lineWidth = 1.4;
        cx.beginPath();
        cx.moveTo(px2 - 6, py2); cx.lineTo(px2 + 6, py2);
        cx.moveTo(px2, py2 - 6); cx.lineTo(px2, py2 + 6);
        cx.stroke();
      }
    }
  }

  // 外框
  cx.strokeStyle = '#222';
  cx.lineWidth = 2.4;
  cx.strokeRect(...toPx(0, s.height), s.width * scale, s.height * scale);

  // 坐标注记
  cx.fillStyle = '#666';
  cx.font = '11px sans-serif';
  cx.textAlign = 'center';
  cx.fillText(`图纸 ${s.width} mm`, ox + s.width * scale / 2, cv.height - 8);
  cx.save();
  cx.translate(12, oy + s.height * scale / 2);
  cx.rotate(-Math.PI / 2);
  cx.fillText(`${s.height} mm`, 0, 0);
  cx.restore();

  document.getElementById('printCanvasHint').textContent =
    P.totalPages === 1
      ? '图纸在一张纸内即可完整打印，无需拼接。'
      : `共 ${P.totalPages} 页：蓝色虚线框为每页覆盖的图纸坐标，绿色虚线为拼接边，` +
        `红色十字为跨页对位标记（相邻页使用同一图纸坐标），蓝色色块为重叠区域。点击左侧列表高亮单页。`;
}

document.getElementById('printDesignSelect').addEventListener('change', loadPrintVersions);
document.getElementById('btnPrintPreview').addEventListener('click', runPrintPreview);
document.getElementById('btnPrintDownloadAll').addEventListener('click', downloadAllSvgs);

// ================= 玻璃裁片（彩色原片排样） =================

const cut = {
  sheets: [],
  designs: [],
  publications: [],
  publicationsByDesign: {}, // 换单面板按图纸缓存发布版列表
  orders: [],
  detailId: null,
};

function cutBanner(kind, msg) {
  const b = document.getElementById('cutBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.textContent = msg;
  clearTimeout(cutBanner._t);
  if (kind === 'success') cutBanner._t = setTimeout(() => { b.hidden = true; }, 3000);
}

async function enterCutting() {
  cutBanner(false);
  await Promise.all([loadGlassSheets(), refreshCutDesigns(), loadCutOrders()]);
}

// ---------- 原片库存 ----------

async function loadGlassSheets() {
  const data = await api('GET', '/api/glass-sheets');
  cut.sheets = data.sheets;
  renderGlassList();
}

function renderGlassList() {
  const el = document.getElementById('glassList');
  if (!cut.sheets.length) {
    el.innerHTML = '<div class="hint">尚未登记颜色原片。每种颜色仅可登记一种宽×高规格。</div>';
    return;
  }
  let html = '<table><thead><tr><th>颜色</th><th class="num">宽×高</th><th class="num">库存</th><th class="num">已领</th><th class="num">未领预留</th><th class="num">瑕疵隔离</th><th class="num">可用</th><th></th></tr></thead><tbody>';
  for (const s of cut.sheets) {
    html += `<tr>
      <td><span class="color-chip" style="background:${s.color}"></span>${s.color}</td>
      <td class="num">${s.width}×${s.height}</td>
      <td class="num">${s.stock}</td>
      <td class="num">${s.picked || 0}</td>
      <td class="num">${s.reserved}</td>
      <td class="num${s.quarantined > 0 ? ' neg-text' : ''}">${s.quarantined || 0}</td>
      <td class="num"><b>${s.available}</b></td>
      <td><input type="number" min="0" step="1" value="${s.stock}" class="glass-stock" data-id="${s.id}" style="width:72px"></td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  el.querySelectorAll('.glass-stock').forEach((inp) => {
    inp.addEventListener('change', () => updateGlassStock(Number(inp.dataset.id), Number(inp.value)));
  });
}

async function addGlassSheet() {
  const msg = document.getElementById('glassMsg');
  const body = {
    color: document.getElementById('glassColor').value,
    width: Number(document.getElementById('glassWidth').value),
    height: Number(document.getElementById('glassHeight').value),
    stock: Number(document.getElementById('glassStock').value),
  };
  try {
    await api('POST', '/api/glass-sheets', body);
    msg.textContent = '✓ 已登记';
    await loadGlassSheets();
  } catch (err) { msg.textContent = '⛔ ' + err.message; }
}

async function updateGlassStock(id, stock) {
  const msg = document.getElementById('glassMsg');
  if (!Number.isInteger(stock) || stock < 0) {
    msg.textContent = '⛔ 库存张数必须是非负整数，输入已忽略';
    await loadGlassSheets();
    return;
  }
  try {
    await api('PATCH', `/api/glass-sheets/${id}`, { stock });
    msg.textContent = '✓ 库存已更新';
    await Promise.all([loadGlassSheets(), loadCutOrders()]);
  } catch (err) {
    msg.textContent = '⛔ ' + err.message;
    await loadGlassSheets();
  }
}

// ---------- 图纸/版本 ----------

async function refreshCutDesigns() {
  const data = await api('GET', '/api/designs');
  cut.designs = data.designs;
  const sel = document.getElementById('cutDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of cut.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.latest_version
      ? `${d.name}（最新 v${d.latest_version}）`
      : `${d.name}（暂无发布版）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadCutVersions();
}

async function loadCutVersions() {
  const sel = document.getElementById('cutVersionSelect');
  sel.innerHTML = '';
  cut.publications = [];
  const id = Number(document.getElementById('cutDesignSelect').value);
  if (!id) { sel.innerHTML = '<option value="">（请先选择图纸）</option>'; return; }
  const data = await api('GET', `/api/designs/${id}/publications`);
  cut.publications = data.publications;
  if (!data.publications.length) { sel.innerHTML = '<option value="">（该图纸暂无发布版）</option>'; return; }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

function cutInput() {
  return {
    publicationId: Number(document.getElementById('cutVersionSelect').value),
    copies: Number(document.getElementById('cutCopies').value),
    gap: Number(document.getElementById('cutGap').value),
  };
}

// ---------- 预览 ----------

async function previewCutOrder() {
  const body = cutInput();
  if (!body.publicationId) { showCutHint('请先发布图纸，再选择发布版本。'); return; }
  try {
    const data = await api('POST', '/api/cut-orders/preview', body);
    cut.detailId = null;
    renderCutDetail({ preview: data.preview });
    cutBanner(false);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'piece_too_large') txt += `（拼片 #${d.pieceNo} 外接 ${d.pieceWidth}×${d.pieceHeight} mm，原片 ${d.sheetWidth}×${d.sheetHeight} mm）`;
    cutBanner('error', txt);
    showCutHint(txt.replace('⛔ ', ''));
  }
}

function showCutHint(text) {
  document.getElementById('cutPreviewContent').innerHTML = `<div class="hint">${escapeHtml(text)}</div>`;
}

function cutStockBadge(p, isPreview) {
  if (isPreview || p.status === 'draft') {
    if (p.totalShortage > 0) {
      const detail = p.colors.filter((c) => c.shortage > 0)
        .map((c) => `${c.color} 需 ${c.requiredSheets}/可用 ${c.available}（缺 ${c.shortage}）`).join('；');
      return `<div class="stock-badge bad">⚠ 库存缺口：${escapeHtml(detail)} —— 不能确认</div>`;
    }
    return `<div class="stock-badge ok">✓ 各色原片库存充足（共 ${p.totalSheets} 张；预览不占库存）</div>`;
  }
  if (p.status === 'confirmed') {
    return '<div class="stock-badge ok">✓ 已确认（各色所需原片已原子预留）</div>';
  }
  if (p.status === 'replaced') {
    const nb = p.replacedBy || {};
    return `<div class="stock-badge replace">⇄ 已被订单 #${nb.newOrderId || '?'} 替换（v${p.version} 的预留已退出并转给新单），不能再取消或修改</div>`;
  }
  if (p.comboId) {
    return `<div class="stock-badge replace">🔗 该订单属于整套用料单 #${p.comboId}，只能随整套单取消；此处不能单独取消、修改或换单。</div>`;
  }
  return '<div class="stock-badge cancel">已取消（预留已释放）</div>';
}

// mode: { preview: obj } 或 { order: obj }
function renderCutDetail(mode) {
  const isPreview = !!mode.preview;
  const p = isPreview ? mode.preview : mode.order;
  let html = '';

  html += `<div class="plan-head">
    <div><b>${isPreview ? '排样预览（不落库、不占库存）' : `裁片订单 #${p.id} · ${escapeHtml(p.name)}`}</b></div>
    <div class="muted">发布版 v${p.version} · ${p.copies} 件 · 片间最小间距 ${p.gap} mm ·
      总裁片数 <b>${p.totalSheets}</b> / ${p.maxSheets} 张</div></div>`;
  html += cutStockBadge(p, isPreview);

  html += '<div class="cut-color-summary"><table><thead><tr><th>颜色</th><th class="num">原片宽×高</th><th class="num">用板</th><th class="num">库存</th><th class="num">已预留</th><th class="num">瑕疵隔离</th><th class="num">可用</th><th class="num">缺口</th></tr></thead><tbody>';
  for (const c of p.colors) {
    html += `<tr>
      <td><span class="color-chip" style="background:${c.color}"></span>${c.color}</td>
      <td class="num">${c.sheetWidth}×${c.sheetHeight}</td>
      <td class="num"><b>${c.requiredSheets}</b></td>
      <td class="num">${c.stock}</td>
      <td class="num">${c.reserved}</td>
      <td class="num">${c.quarantined || 0}</td>
      <td class="num">${c.available}</td>
      <td class="num">${c.shortage > 0 ? `<span class="gap-info">${c.shortage}</span>` : 0}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  // 逐张原片
  html += '<div class="cut-sheets">';
  for (const c of p.layout.colors) {
    html += `<h3><span class="color-chip" style="background:${c.color}"></span>${c.color} · ${c.sheetWidth}×${c.sheetHeight} mm · ${c.sheets.length} 张</h3>`;
    for (const sheet of c.sheets) {
      html += `<div class="cut-sheet-card">
        <div class="bar-title">原片 #${sheet.index}（${sheet.width}×${sheet.height} mm）· ${sheet.placements.length} 片</div>
        ${sheetSvg(sheet, c.color)}
        <table><thead><tr><th>片号</th><th>件次</th><th class="num">旋转</th><th class="num">x,y</th><th class="num">外接宽×高</th></tr></thead><tbody>`;
      for (const q of sheet.placements) {
        html += `<tr><td>#${q.pieceNo}</td><td>第 ${q.copy} 件</td>
          <td class="num">${q.rotation}°</td><td class="num">${q.x}, ${q.y}</td>
          <td class="num muted">${q.width}×${q.height}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }
  }
  html += '</div>';

  if (isPreview) {
    html += '<div class="btn-row"><button id="btnCutSave" class="primary">存为草稿订单</button></div>';
  } else if (p.comboId) {
    // 整套关联订单：无独立操作按钮（确认时已预留，随整套单取消释放）
  } else if (p.status === 'draft') {
    html += `<div class="btn-row">
      <button id="btnCutConfirm" class="primary">确认订单（预留 ${p.totalSheets} 张）</button>
      <button id="btnCutDelete" class="danger">删除草稿</button></div>`;
  } else if (p.status === 'confirmed') {
    html += '<div class="btn-row"><button id="btnCutCancel" class="danger">取消订单（释放预留）</button></div>';
    html += cutReplacePanel(p);
  } else if (p.status === 'replaced') {
    html += `<div class="replace-info">此订单为已替换的历史记录，发布快照与排样仍可查阅。
      <button id="btnGotoReplacement" class="link-btn" data-id="${p.replacedBy?.newOrderId || ''}">
      查看接替的新订单 #${p.replacedBy?.newOrderId || '?'} →</button></div>`;
  } else if (p.replaces) {
    html += `<div class="replace-info muted">本订单由订单 #${p.replaces.oldOrderId} 换单生成（已接替其预留）。</div>`;
  }

  document.getElementById('cutPreviewContent').innerHTML = html;

  const save = document.getElementById('btnCutSave');
  if (save) save.addEventListener('click', () => saveCutDraft(mode.preview));
  const cf = document.getElementById('btnCutConfirm');
  if (cf) cf.addEventListener('click', () => confirmCutOrder(p.id));
  const de = document.getElementById('btnCutDelete');
  if (de) de.addEventListener('click', () => deleteCutOrder(p.id));
  const ca = document.getElementById('btnCutCancel');
  if (ca) ca.addEventListener('click', () => cancelCutOrder(p.id));
  const rp = document.getElementById('btnReplacePreview');
  if (rp) rp.addEventListener('click', () => previewReplacement(p));
  const sel = document.getElementById('repVersion');
  if (sel) loadReplaceVersions(p.designId, sel);
  const goto = document.getElementById('btnGotoReplacement');
  if (goto) goto.addEventListener('click', () => openOrderById(Number(goto.dataset.id)));
}

// 加载该订单所属图纸的全部发布版（换入目标下拉，排除旧单当前版本）
async function loadReplaceVersions(designId, sel) {
  try {
    if (!cut.publicationsByDesign[designId]) {
      const data = await api('GET', `/api/designs/${designId}/publications`);
      cut.publicationsByDesign[designId] = data.publications;
    }
    const current = Number(sel.value);
    const pubs = cut.publicationsByDesign[designId];
    sel.innerHTML = pubs.length > 1
      ? pubs.map((x) => `<option value="${x.id}"${x.id === current ? ' selected' : ''}>v${x.version} · ${x.publishedAt}</option>`).join('')
      : '<option value="">（该图纸暂无可换的其他发布版）</option>';
  } catch (err) { /* 保留占位 */ }
}

// 已确认订单的换单面板：选同一图纸的另一发布版本、件数、片间距
function cutReplacePanel(p) {
  const cached = (cut.publicationsByDesign[p.designId] || [])
    .filter((x) => x.id !== p.publicationId);
  const opts = cached.length
    ? cached.map((x) => `<option value="${x.id}">v${x.version} · ${x.publishedAt}</option>`).join('')
    : '<option value="">（加载发布版本…）</option>';
  return `<details class="replace-panel">
    <summary><b>⇄ 换单</b>：客户改图后，把本订单换到同一图纸的另一已发布版本（旧单退出预留，新单原子确认）</summary>
    <div class="form-row">
      <label>新订单名称（可选）<input id="repName" type="text" maxlength="80" placeholder="留空自动命名"></label>
    </div>
    <label>换到发布版本
      <select id="repVersion">${opts}</select>
    </label>
    <div class="form-row two">
      <label>件数<input id="repCopies" type="number" min="1" step="1" value="${p.copies}"></label>
      <label>片间最小间距 (mm)<input id="repGap" type="number" min="0" max="50" step="1" value="${p.gap}"></label>
    </div>
    <div class="btn-row">
      <button id="btnReplacePreview" class="primary">换单预览（不占库存）</button>
    </div>
    <div id="replacePreviewBox"></div>
  </details>`;
}

// ---------- 换单 ----------

async function previewReplacement(order) {
  const box = document.getElementById('replacePreviewBox');
  const targetPublicationId = Number(document.getElementById('repVersion').value);
  if (!targetPublicationId) {
    box.innerHTML = '<div class="hint">该图纸没有其他已发布版本可换；请先在编辑器发布新版本。</div>';
    return;
  }
  const body = {
    targetPublicationId,
    copies: Number(document.getElementById('repCopies').value),
    gap: Number(document.getElementById('repGap').value),
  };
  try {
    const data = await api('POST', `/api/cut-orders/${order.id}/replacement/preview`, body);
    renderReplacementPreview(order, body, data.preview, box);
    cutBanner(false);
  } catch (err) {
    const d = err.data || {};
    box.innerHTML = `<div class="hint">⛔ ${escapeHtml(d.error || err.message)}</div>`;
  }
}

function renderReplacementPreview(order, req, p, box) {
  const netTxt = p.netSheets > 0 ? `<span class="gap-info">+${p.netSheets}</span>`
    : p.netSheets < 0 ? `<span class="ok-text">${p.netSheets}</span>` : '±0';
  let html = `<div class="plan-head">
    <div><b>换单预览（不落库、不占库存）</b></div>
    <div class="muted">旧单 v${p.old.version}（${p.oldTotalSheets} 张）→ 新排样 v${p.target.version}
      （${p.copies} 件 · 间距 ${p.gap} mm · ${p.totalSheets} 张）· 净增减 ${netTxt} 张</div></div>`;
  html += p.feasible
    ? '<div class="stock-badge ok">✓ 计入旧单退出预留后，各色库存充足，可确认换单</div>'
    : `<div class="stock-badge bad">⚠ 计入旧单退出预留后仍有缺口：${
      p.colors.filter((c) => c.shortage > 0).map((c) => `${c.color} 缺 ${c.shortage}`).join('；')
    } —— 不能确认</div>`;
  html += '<div class="cut-color-summary"><table><thead><tr>'
    + '<th>颜色</th><th class="num">旧单用板</th><th class="num">新排样用板</th><th class="num">净增减</th>'
    + '<th class="num">库存</th><th class="num">当前已预留</th><th class="num">旧单释放后可用</th><th class="num">缺口</th>'
    + '</tr></thead><tbody>';
  for (const c of p.colors) {
    const net = c.netChange > 0 ? `+${c.netChange}` : `${c.netChange}`;
    html += `<tr>
      <td><span class="color-chip" style="background:${c.color}"></span>${c.color}</td>
      <td class="num">${c.oldSheets}</td>
      <td class="num"><b>${c.requiredSheets}</b></td>
      <td class="num">${net}</td>
      <td class="num">${c.stock}</td>
      <td class="num">${c.reserved}</td>
      <td class="num">${c.availableAfter}</td>
      <td class="num">${c.shortage > 0 ? `<span class="gap-info">${c.shortage}</span>` : 0}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  // 新排样逐张示意（复用现有 sheetSvg）
  html += '<div class="cut-sheets">';
  for (const c of p.layout.colors) {
    html += `<h3><span class="color-chip" style="background:${c.color}"></span>${c.color} · ${c.sheetWidth}×${c.sheetHeight} mm · ${c.sheets.length} 张</h3>`;
    for (const sheet of c.sheets) {
      html += `<div class="cut-sheet-card"><div class="bar-title">原片 #${sheet.index}（${sheet.width}×${sheet.height} mm）· ${sheet.placements.length} 片</div>${sheetSvg(sheet, c.color)}</div>`;
    }
  }
  html += '</div>';

  if (p.feasible) {
    html += `<div class="btn-row"><button id="btnReplaceConfirm" class="primary big">
      确认换单（旧单退出预留并确认新单）</button></div>
      <div class="hint">确认是原子操作：任一颜色不足都会整体回滚，旧单、库存与订单记录保持原状。</div>`;
  }
  box.innerHTML = html;
  const btn = document.getElementById('btnReplaceConfirm');
  if (btn) btn.addEventListener('click', () => confirmReplacement(order, req));
}

async function confirmReplacement(order, req) {
  const name = document.getElementById('repName').value;
  if (!confirm(`确认把订单 #${order.id}（v${order.version}）换到 v… 新版本？旧单将立即退出预留并标记“已替换”，不能再取消或修改。`)) return;
  const box = document.getElementById('replacePreviewBox');
  try {
    const data = await api('POST', `/api/cut-orders/${order.id}/replacement`, {
      name: name || undefined,
      targetPublicationId: req.targetPublicationId,
      copies: req.copies,
      gap: req.gap,
    });
    cutBanner('success', data.idempotent
      ? `该换单已完成：返回原新单 #${data.order.id}（未重复预留）`
      : `✓ 换单成功：旧单 #${order.id} 已替换，新单 #${data.order.id} 已确认`);
    await loadGlassSheets();
    await loadCutOrders(data.order.id);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'shortage' && Array.isArray(d.shortages)) {
      txt += '（' + d.shortages.map((s) => `${s.color} 需 ${s.required}/旧单释放后可用 ${s.available}（缺 ${s.shortage}）`).join('；') + '）';
    }
    box.innerHTML = `<div class="hint">${escapeHtml(txt)}</div>`;
    cutBanner('error', txt);
    await loadGlassSheets();
    await loadCutOrders(order.id);
  }
}

async function openOrderById(id) {
  if (!id) return;
  const o = cut.orders.find((x) => x.id === id);
  if (o) { cut.detailId = o.id; renderCutOrderList(); renderCutDetail({ order: o }); return; }
  try {
    const data = await api('GET', `/api/cut-orders/${id}`);
    await loadCutOrders(id);
    cut.detailId = id;
    renderCutDetail({ order: data.order });
  } catch (err) { cutBanner('error', '⛔ ' + err.message); }
}

// 单张原片排样示意 SVG：viewBox 取原片毫米尺寸，y 轴翻转（屏幕坐标向下）
function sheetSvg(sheet, fallbackColor) {
  const W = sheet.width, H = sheet.height;
  const maxW = 340;
  const cssW = Math.min(maxW, W * 0.8);
  return `<svg class="cut-sheet-svg" width="${cssW}" height="${cssW * H / W}" viewBox="0 0 ${W} ${H}"
    preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#fbfaf7" stroke="#222" stroke-width="${Math.max(W, H) * 0.008}"/>
    ${sheet.placements.map((q) => {
      const pts = q.polygon.map(([x, y]) => `${x},${H - y}`).join(' ');
      return `<polygon points="${pts}" fill="${q.color || fallbackColor}" fill-opacity="0.72"
        stroke="#333" stroke-width="${Math.max(W, H) * 0.004}"/>`;
    }).join('')}
  </svg>`;
}

// ---------- 建单 / 确认 / 取消 / 删除 / 列表 ----------

async function saveCutDraft(preview) {
  const name = document.getElementById('cutName').value;
  try {
    const data = await api('POST', '/api/cut-orders', {
      name: name || undefined,
      publicationId: preview.publicationId,
      copies: preview.copies,
      gap: preview.gap,
    });
    cutBanner('success', `✓ 已存为草稿订单 #${data.order.id}（尚未占用库存）`);
    await loadCutOrders(data.order.id);
  } catch (err) { cutBanner('error', '⛔ ' + err.message); }
}

async function confirmCutOrder(id) {
  try {
    const data = await api('POST', `/api/cut-orders/${id}/confirm`);
    cutBanner('success', `✓ 订单 #${id} 已确认，预留 ${data.order.totalSheets} 张原片`);
    await loadGlassSheets();
    await loadCutOrders(id);
  } catch (err) {
    cutBanner('error', '⛔ ' + (err.data?.error || err.message));
    await loadGlassSheets();
    await loadCutOrders(id);
  }
}

async function cancelCutOrder(id) {
  if (!confirm(`确定取消订单 #${id}？已预留的各色原片将一次性释放。`)) return;
  try {
    const data = await api('POST', `/api/cut-orders/${id}/cancel`);
    cutBanner('success', `订单 #${id} 已取消，释放 ${data.order.totalSheets} 张`);
    await loadGlassSheets();
    await loadCutOrders(id);
  } catch (err) { cutBanner('error', '⛔ ' + err.message); await loadCutOrders(id); }
}

async function deleteCutOrder(id) {
  if (!confirm(`确定删除草稿订单 #${id}？`)) return;
  try {
    await api('DELETE', `/api/cut-orders/${id}`);
    cutBanner('success', `草稿 #${id} 已删除`);
    cut.detailId = null;
    showCutHint('草稿已删除。');
    await loadCutOrders();
  } catch (err) { cutBanner('error', '⛔ ' + err.message); }
}

async function loadCutOrders(selectId) {
  const data = await api('GET', '/api/cut-orders');
  cut.orders = data.orders;
  renderCutOrderList();
  if (selectId) {
    const o = cut.orders.find((x) => x.id === selectId);
    if (o) { cut.detailId = o.id; renderCutDetail({ order: o }); }
  }
}

function renderCutOrderList() {
  const el = document.getElementById('cutOrderList');
  if (!cut.orders.length) { el.innerHTML = '<div class="hint">暂无订单。</div>'; return; }
  el.innerHTML = cut.orders.map((o) => {
    const badge = o.status === 'confirmed'
      ? '<span class="badge ok">已确认</span>'
      : o.status === 'canceled'
        ? '<span class="badge" style="background:#eee;color:#888">已取消</span>'
        : o.status === 'replaced'
          ? '<span class="badge replace">已替换</span>'
          : '<span class="badge bad">草稿</span>';
    const colors = o.colors.map((c) =>
      `<span class="color-chip" style="background:${c.color}" title="${c.color} ×${c.requiredSheets}"></span>`).join('');
    const warn = o.status === 'draft' && o.totalShortage > 0
      ? ` <span class="gap-info">缺 ${o.totalShortage} 张</span>` : '';
    const rel = o.status === 'replaced'
      ? ` <span class="muted small">⇄ 由 #${o.replacedBy?.newOrderId || '?'} 接替</span>`
      : o.replaces ? ` <span class="muted small">⇄ 接替 #${o.replaces.oldOrderId}</span>` : '';
    const comboTag = o.comboId ? ` <span class="muted small">🔗 整套 #${o.comboId}</span>` : '';
    const issueTag = o.status === 'confirmed' && o.pickedSheets > 0
      ? ` <span class="badge" style="background:#fff4e0;color:#b26a00">已领 ${o.pickedSheets}/${o.totalSheets} · 余 ${o.remainingSheets}</span>`
      : '';
    return `<div class="plan-item${cut.detailId === o.id ? ' active' : ''}" data-id="${o.id}">
      <div>${badge} <b>#${o.id}</b> ${escapeHtml(o.name)}${warn}</div>
      <div class="muted small">v${o.version} · ${o.copies}件 · 间距 ${o.gap}mm · ${o.totalSheets} 张 ${colors}${rel}${comboTag}${issueTag}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.plan-item').forEach((div) => {
    div.addEventListener('click', () => {
      const o = cut.orders.find((x) => x.id === Number(div.dataset.id));
      cut.detailId = o.id;
      renderCutOrderList();
      renderCutDetail({ order: o });
    });
  });
}

document.getElementById('tabCutting').addEventListener('click', () => switchTab('cutting'));
document.getElementById('btnGlassAdd').addEventListener('click', addGlassSheet);
document.getElementById('cutDesignSelect').addEventListener('change', loadCutVersions);
document.getElementById('btnCutPreview').addEventListener('click', previewCutOrder);

// ================= 整套备料（铅条 + 玻璃 一次备齐） =================

const combo = {
  combos: [],
  detailId: null,
  preview: null,
};

function comboBanner(kind, msg) {
  const b = document.getElementById('comboBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.textContent = msg;
  clearTimeout(comboBanner._t);
  if (kind === 'success') comboBanner._t = setTimeout(() => { b.hidden = true; }, 3500);
}

// 生成本次确认的幂等键（重复提交/网络重试时复用，避免重复预留库存）
function comboRequestKey() {
  if (!combo._keyBase) {
    combo._keyBase = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    combo._keySeq = 0;
  }
  return `${combo._keyBase}-${++combo._keySeq}`;
}
// 同一组参数的“确认”重试应复用同一键
combo._lastKey = null;

async function enterCombo() {
  comboBanner(false);
  await Promise.all([refreshComboDesigns(), loadComboMaterials(), loadComboOrders()]);
}

async function loadComboMaterials() {
  const data = await api('GET', '/api/materials');
  const sel = document.getElementById('comboMaterialSelect');
  const prev = sel.value;
  sel.innerHTML = data.materials.length
    ? data.materials.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（定尺 ${fmt(m.length)} mm，可用 ${m.available}/${m.stock} 根）</option>`).join('')
    : '<option value="">（请先在“铅条生产”登记原材）</option>';
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function refreshComboDesigns() {
  const data = await api('GET', '/api/designs');
  const sel = document.getElementById('comboDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of data.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.latest_version
      ? `${d.name}（最新 v${d.latest_version}）`
      : `${d.name}（暂无发布版）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadComboVersions();
}

async function loadComboVersions() {
  const sel = document.getElementById('comboVersionSelect');
  sel.innerHTML = '';
  const id = Number(document.getElementById('comboDesignSelect').value);
  if (!id) { sel.innerHTML = '<option value="">（请先选择图纸）</option>'; return; }
  const data = await api('GET', `/api/designs/${id}/publications`);
  if (!data.publications.length) { sel.innerHTML = '<option value="">（该图纸暂无发布版）</option>'; return; };
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

function comboInput() {
  return {
    publicationId: Number(document.getElementById('comboVersionSelect').value),
    materialId: Number(document.getElementById('comboMaterialSelect').value),
    copies: Number(document.getElementById('comboCopies').value),
    kerf: Number(document.getElementById('comboKerf').value),
    gap: Number(document.getElementById('comboGap').value),
  };
}

async function previewCombo() {
  const body = comboInput();
  if (!body.publicationId) { showComboHint('请先发布图纸，再选择发布版本。'); return; }
  if (!body.materialId) { showComboHint('请先在“铅条生产”标签登记铅条原材。'); return; }
  try {
    const data = await api('POST', '/api/combo-orders/preview', body);
    combo.preview = { body, data: data.preview };
    combo._lastKey = null; // 新参数 → 新确认键
    combo.detailId = null;
    renderComboList();
    renderComboPreview(data.preview);
    comboBanner(false);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.segment) txt += `（${d.segment.name}：成品 ${fmt(d.segment.length)} mm，含刀损 ${fmt(d.segment.withKerf)} mm，超过原材定尺）`;
    if (d.code === 'piece_too_large') txt += `（拼片 #${d.pieceNo} 外接 ${d.pieceWidth}×${d.pieceHeight} mm，原片 ${d.sheetWidth}×${d.sheetHeight} mm）`;
    comboBanner('error', txt);
    showComboHint(txt.replace('⛔ ', ''));
  }
}

function showComboHint(text) {
  document.getElementById('comboPreviewContent').innerHTML = `<div class="hint">${escapeHtml(text)}</div>`;
}

function renderComboPreview(p) {
  const leadOk = p.leadShortage === 0;
  const glassOk = p.glass.totalShortage === 0;
  let html = `<div class="plan-head">
    <div><b>整套用料预览（不落库、不占库存）</b></div>
    <div class="muted">发布版 v${p.version} · ${p.copies} 件 · 刀损 ${fmt(p.kerf)} mm · 玻璃片距 ${p.gap} mm</div></div>`;

  html += `<h3>铅条</h3>
    <div class="stock-badge ${leadOk ? 'ok' : 'bad'}">
      ${leadOk ? '✓' : '⚠'} 原材 ${escapeHtml(p.lead.material.name)}：需用 <b>${p.lead.requiredBars}</b> 根，
      库存 ${p.lead.stockBars} · 已预留 ${p.lead.reservedBars} · 可用 <b>${p.lead.availableBars}</b>${
      leadOk ? '' : ` · 缺口 <b>${p.lead.shortage}</b> 根`}
    </div>`;
  html += '<div class="bars">';
  for (const bar of p.lead.layout.bars) {
    html += `<div class="bar-card">
      <div class="bar-title">原材 #${bar.index} · 用 ${fmt(bar.usedLength)} mm · 余料 <b>${fmt(bar.remainder)}</b> mm</div>
      <div class="bar-track">${barTrack(bar, p.lead.layout.materialLength)}</div></div>`;
  }
  html += '</div>';

  html += `<h3>玻璃原片（共 <b>${p.glass.totalSheets}</b> 张，上限 ${p.glass.maxSheets}）</h3>
    <div class="stock-badge ${glassOk ? 'ok' : 'bad'}">
      ${glassOk ? '✓ 各色原片库存充足' : '⚠ 部分颜色缺口：' +
        p.glass.colors.filter((c) => c.shortage > 0).map((c) => `${c.color} 缺 ${c.shortage}`).join('；')}
    </div>`;
  html += '<div class="cut-color-summary"><table><thead><tr><th>颜色</th><th class="num">原片宽×高</th><th class="num">用板</th><th class="num">库存</th><th class="num">已预留</th><th class="num">瑕疵隔离</th><th class="num">可用</th><th class="num">缺口</th></tr></thead><tbody>';
  for (const c of p.glass.colors) {
    html += `<tr>
      <td><span class="color-chip" style="background:${c.color}"></span>${c.color}</td>
      <td class="num">${c.sheetWidth}×${c.sheetHeight}</td>
      <td class="num"><b>${c.requiredSheets}</b></td>
      <td class="num">${c.stock}</td>
      <td class="num">${c.reserved}</td>
      <td class="num">${c.quarantined || 0}</td>
      <td class="num">${c.available}</td>
      <td class="num">${c.shortage > 0 ? `<span class="gap-info">${c.shortage}</span>` : 0}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  html += '<details><summary>查看玻璃逐张排样示意</summary><div class="cut-sheets">';
  for (const c of p.glass.layout.colors) {
    html += `<h4><span class="color-chip" style="background:${c.color}"></span>${c.color} · ${c.sheetWidth}×${c.sheetHeight} mm · ${c.sheets.length} 张</h4>`;
    for (const sheet of c.sheets) {
      html += `<div class="cut-sheet-card"><div class="bar-title">原片 #${sheet.index} · ${sheet.placements.length} 片</div>${sheetSvg(sheet, c.color)}</div>`;
    }
  }
  html += '</div></details>';

  if (p.feasible) {
    html += `<div class="btn-row"><button id="btnComboConfirm" class="primary big">
      确认整套单（同事务预留 ${p.lead.requiredBars} 根铅条 + ${p.glass.totalSheets} 张玻璃）</button></div>
      <div class="hint">确认是原子操作：铅条或任一颜色玻璃不足都会整体失败，两类库存保持原状。网络重试请直接点同一张预览卡片的确认（幂等）。</div>`;
  } else {
    html += '<div class="hint">存在缺口，不能确认；请补充库存或调整件数/规格后重新预览。</div>';
  }

  document.getElementById('comboPreviewContent').innerHTML = html;
  const btn = document.getElementById('btnComboConfirm');
  if (btn) btn.addEventListener('click', confirmCombo);
}

async function confirmCombo() {
  if (!combo.preview) return;
  const { body } = combo.preview;
  // 同一张预览的第一次确认生成键，重试复用，保证不重复预留
  if (!combo._lastKey) combo._lastKey = comboRequestKey();
  const name = document.getElementById('comboName').value;
  try {
    const data = await api('POST', '/api/combo-orders', {
      ...body,
      name: name || undefined,
      requestId: combo._lastKey,
    });
    comboBanner('success', data.idempotent
      ? `该整套单已确认：返回原单 #${data.combo.id}（两类库存均未重复预留）`
      : `✓ 整套单 #${data.combo.id} 已确认：关联生产计划 #${data.combo.leadPlanId} 与裁片订单 #${data.combo.cutOrderId}`);
    combo.preview = null;
    await Promise.all([loadComboMaterials(), loadComboOrders(data.combo.id)]);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'shortage') {
      const parts = [];
      if (d.lead && d.lead.shortage) parts.push(`铅条缺 ${d.lead.shortage} 根`);
      if (Array.isArray(d.shortages)) {
        for (const s of d.shortages) parts.push(`${s.color} 需 ${s.required}/可用 ${s.available}（缺 ${s.shortage}）`);
      }
      txt += '（' + parts.join('；') + '）';
    }
    comboBanner('error', txt);
    await Promise.all([loadComboMaterials(), loadComboOrders()]);
  }
}

async function loadComboOrders(selectId) {
  const data = await api('GET', '/api/combo-orders');
  combo.combos = data.combos;
  renderComboList();
  if (selectId) renderComboDetail(data.combos.find((c) => c.id === selectId) || combo.combos[0]);
}

function renderComboList() {
  const el = document.getElementById('comboList');
  if (!combo.combos.length) { el.innerHTML = '<div class="hint">暂无整套单。</div>'; return; }
  el.innerHTML = combo.combos.map((c) => {
    const badge = c.status === 'confirmed'
      ? '<span class="badge ok">已确认</span>'
      : '<span class="badge" style="background:#eee;color:#888">已取消</span>';
    const issueTag = c.status === 'confirmed' && c.issueCount > 0
      ? ` <span class="badge" style="background:#fff4e0;color:#b26a00">已领 ${c.issueCount} 次 · 铅余 ${c.remainingBars}/玻余 ${c.remainingSheets}</span>`
      : '';
    return `<div class="plan-item${combo.detailId === c.id ? ' active' : ''}" data-id="${c.id}">
      <div>${badge} <b>#${c.id}</b> ${escapeHtml(c.name)}${issueTag}</div>
      <div class="muted small">v${c.version} · ${c.copies}件 · 铅条 ${c.requiredBars} 根 · 玻璃 ${c.totalSheets} 张
        · 计划 #${c.leadPlanId} / 订单 #${c.cutOrderId}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.plan-item').forEach((div) => {
    div.addEventListener('click', () => {
      const c = combo.combos.find((x) => x.id === Number(div.dataset.id));
      combo.detailId = c.id;
      renderComboList();
      renderComboDetail(c);
    });
  });
}

function renderComboDetail(c) {
  const lp = c.leadPlan, co = c.cutOrder;
  let html = `<div class="plan-head">
    <div><b>整套单 #${c.id} · ${escapeHtml(c.name)}</b>
      <span class="badge ${c.status === 'confirmed' ? 'ok' : ''}" style="${c.status === 'canceled' ? 'background:#eee;color:#888' : ''}">${c.statusText}</span></div>
    <div class="muted">同一发布快照 v${c.version}（发布版 #${c.publicationId}）· ${c.copies} 件 ·
      刀损 ${fmt(c.kerf)} mm · 玻璃片距 ${c.gap} mm ·
      铅条 ${c.requiredBars} 根 + 玻璃 ${c.totalSheets} 张${c.canceledAt ? ' · 取消于 ' + c.canceledAt : ''}</div></div>`;

  html += c.status === 'confirmed'
    ? '<div class="stock-badge ok">✓ 两类库存已在同一事务内核验并预留；关联单不可单独取消/修改/换单</div>'
    : '<div class="stock-badge cancel">已取消：关联生产计划与裁片订单同时取消，铅条与玻璃预留各释放一次（重复取消不重复变更）</div>';

  html += `<div class="replace-info">关联生产计划：<b>#${c.leadPlanId}</b>「${escapeHtml(lp ? lp.name : '')}」（${lp ? lp.statusText : '?'}，${c.requiredBars} 根）
    —— 仅可查阅，不能从“铅条生产”入口单独取消/修改/删除。</div>`;
  html += `<div class="replace-info">关联裁片订单：<b>#${c.cutOrderId}</b>「${escapeHtml(co ? co.name : '')}」（${co ? co.statusText : '?'}，${c.totalSheets} 张）
    —— 仅可查阅，不能从“玻璃裁片”入口单独取消/修改/换单/删除。</div>`;

  html += '<details><summary>查看铅条切段方案</summary><div class="bars">';
  if (lp) for (const bar of lp.layout.bars) {
    html += `<div class="bar-card">
      <div class="bar-title">原材 #${bar.index} · 用 ${fmt(bar.usedLength)} mm · 余料 ${fmt(bar.remainder)} mm</div>
      <div class="bar-track">${barTrack(bar, lp.layout.materialLength)}</div></div>`;
  }
  html += '</div></details>';

  html += '<details><summary>查看玻璃逐张排样</summary><div class="cut-sheets">';
  if (co) for (const cc of co.layout.colors) {
    html += `<h4><span class="color-chip" style="background:${cc.color}"></span>${cc.color} · ${cc.sheetWidth}×${cc.sheetHeight} mm · ${cc.sheets.length} 张</h4>`;
    for (const sheet of cc.sheets) {
      html += `<div class="cut-sheet-card"><div class="bar-title">原片 #${sheet.index} · ${sheet.placements.length} 片</div>${sheetSvg(sheet, cc.color)}</div>`;
    }
  }
  html += '</div></details>';

  if (c.status === 'confirmed') {
    html += `<div class="btn-row"><button id="btnComboCancel" class="danger big">取消整套单（两类预留各释放一次）</button></div>`;
  }
  document.getElementById('comboPreviewContent').innerHTML = html;
  const btn = document.getElementById('btnComboCancel');
  if (btn) btn.addEventListener('click', () => cancelCombo(c.id));
}

async function cancelCombo(id) {
  if (!confirm(`确定取消整套单 #${id}？关联生产计划与裁片订单将同时取消，铅条与玻璃预留各释放一次。`)) return;
  try {
    await api('POST', `/api/combo-orders/${id}/cancel`);
    comboBanner('success', `✓ 整套单 #${id} 已取消，铅条与玻璃预留各释放一次`);
    await Promise.all([loadComboMaterials(), loadComboOrders(id)]);
  } catch (err) {
    comboBanner('error', '⛔ ' + (err.data?.error || err.message));
    await loadComboOrders(id);
  }
}

document.getElementById('tabCombo').addEventListener('click', () => switchTab('combo'));
document.getElementById('comboDesignSelect').addEventListener('change', loadComboVersions);
document.getElementById('btnComboPreview').addEventListener('click', previewCombo);

// ================= 库存盘点（铅条原材 + 玻璃原片 同一张盘点单） =================

const st = {
  materials: [],
  sheets: [],
  stocktakes: [],
  detailId: null,
};

function stBanner(kind, msg) {
  const b = document.getElementById('stBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
  clearTimeout(stBanner._t);
  if (kind === 'success') stBanner._t = setTimeout(() => { b.hidden = true; }, 3500);
}

async function enterStocktake() {
  stBanner(false);
  await Promise.all([stLoadSpecs(), stLoadList()]);
}

async function stLoadSpecs() {
  const [mats, glass] = await Promise.all([
    api('GET', '/api/materials'),
    api('GET', '/api/glass-sheets'),
  ]);
  st.materials = mats.data.materials;
  st.sheets = glass.data.sheets;
  stRenderPicker();
}

// 勾选+录入实盘数的规格选择表
function stRenderPicker() {
  const leadEl = document.getElementById('stLeadList');
  if (!st.materials.length) {
    leadEl.innerHTML = '<div class="hint">尚未登记铅条原材（请到“铅条生产”登记）。</div>';
  } else {
    leadEl.innerHTML = '<table><thead><tr><th></th><th>规格</th><th class="num">库存/预留</th><th class="num">实盘</th></tr></thead><tbody>' +
      st.materials.map((m) => `<tr>
        <td><input type="checkbox" class="st-pick" data-type="lead" data-id="${m.id}"></td>
        <td>${escapeHtml(m.name)} <span class="muted small">${fmt(m.length)} mm</span></td>
        <td class="num muted small">${m.stock} / ${m.reserved}</td>
        <td><input type="number" min="0" step="1" value="${m.stock}" class="st-count" data-type="lead" data-id="${m.id}" style="width:80px"></td>
      </tr>`).join('') + '</tbody></table>';
  }
  const glassEl = document.getElementById('stGlassList');
  if (!st.sheets.length) {
    glassEl.innerHTML = '<div class="hint">尚未登记玻璃原片（请到“玻璃裁片”登记）。</div>';
  } else {
    glassEl.innerHTML = '<table><thead><tr><th></th><th>颜色</th><th class="num">库存/预留</th><th class="num">实盘</th></tr></thead><tbody>' +
      st.sheets.map((s) => `<tr>
        <td><input type="checkbox" class="st-pick" data-type="glass" data-id="${s.id}"></td>
        <td><span class="color-chip" style="background:${s.color}"></span>${s.color} <span class="muted small">${s.width}×${s.height}</span></td>
        <td class="num muted small">${s.stock} / ${s.reserved}</td>
        <td><input type="number" min="0" step="1" value="${s.stock}" class="st-count" data-type="glass" data-id="${s.id}" style="width:80px"></td>
      </tr>`).join('') + '</tbody></table>';
  }
}

// 从勾选表收集盘点项
function stCollectItems() {
  const items = [];
  document.querySelectorAll('.st-pick:checked').forEach((cb) => {
    const { type, id } = cb.dataset;
    const inp = document.querySelector(`.st-count[data-type="${type}"][data-id="${id}"]`);
    items.push({ type, specId: Number(id), counted: Number(inp.value) });
  });
  return items;
}

function stBody(extra) {
  const body = { items: stCollectItems() };
  const name = document.getElementById('stName').value.trim();
  if (name) body.name = name;
  return { ...body, ...(extra || {}) };
}

async function previewStocktake(id) {
  const items = stCollectItems();
  if (!items.length) { stBanner('error', '⛔ 请至少勾选一个规格'); return; }
  const bad = items.find((it) => !Number.isInteger(it.counted) || it.counted < 0);
  if (bad) { stBanner('error', '⛔ 实盘总数必须是非负整数'); return; }
  try {
    const url = id ? `/api/stocktakes/${id}` : '/api/stocktakes/preview';
    const method = id ? 'PUT' : 'POST';
    const data = await api(method, url, stBody());
    st.detailId = data.stocktake.id;
    stBanner('success', id
      ? `✓ 草稿盘点单 #${data.stocktake.id} 已按当前库存重新固化预览基准（库存未改动）`
      : `✓ 盘点预览已保存为草稿 #${data.stocktake.id}（库存未改动）`);
    await stLoadList(data.stocktake.id);
  } catch (err) {
    stBanner('error', '⛔ ' + (err.data?.error || err.message));
  }
}

async function confirmStocktake(id) {
  if (!confirm(`确认盘点单 #${id}？确认时将在同一事务内重核所有规格，全部通过才会按实盘数更新库存。`)) return;
  try {
    const data = await api('POST', `/api/stocktakes/${id}/confirm`);
    stBanner('success', data.idempotent
      ? `盘点单 #${id} 此前已确认，返回同一记录，未再次调整库存`
      : `✓ 盘点单 #${id} 已确认，库存已按实盘数更新`);
    await stLoadSpecs();
    await stLoadList(id);
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'baseline_mismatch' && Array.isArray(d.items)) {
      txt += '<br>' + d.items.map((it) =>
        `${it.typeName} ${escapeHtml(it.name || `#${it.specId}`)}：${it.reasonText}` +
        (it.currentStock !== undefined ? `（基准库存 ${it.baselineStock}→当前 ${it.currentStock}，基准预留 ${it.baselineReserved}→当前 ${it.currentReserved}，实盘 ${it.countedStock}）` : '')).join('<br>');
    }
    stBanner('error', txt);
    await stLoadSpecs();
    await stLoadList(id);
  }
}

async function deleteStocktake(id) {
  if (!confirm(`确定删除草稿盘点单 #${id}？已确认盘点单不能删除。`)) return;
  try {
    await api('DELETE', `/api/stocktakes/${id}`);
    stBanner('success', `草稿盘点单 #${id} 已删除`);
    if (st.detailId === id) {
      st.detailId = null;
      document.getElementById('stDetail').innerHTML = '<div class="hint">草稿已删除。</div>';
    }
    await stLoadList();
  } catch (err) { stBanner('error', '⛔ ' + (err.data?.error || err.message)); }
}

// 把某张盘点单的项载入左侧勾选表（便于改后重新预览）
function stLoadIntoEditor(s) {
  document.querySelectorAll('.st-pick').forEach((cb) => {
    const found = s.items.find((it) => it.type === cb.dataset.type && it.specId === Number(cb.dataset.id));
    cb.checked = !!found;
    if (found) {
      const inp = document.querySelector(`.st-count[data-type="${cb.dataset.type}"][data-id="${cb.dataset.id}"]`);
      if (inp) inp.value = found.counted;
    }
  });
  document.getElementById('stName').value = s.name && s.name.startsWith('库存盘点（') ? '' : s.name;
}

async function stLoadList(selectId) {
  const data = await api('GET', '/api/stocktakes');
  st.stocktakes = data.stocktakes;
  const el = document.getElementById('stList');
  if (!st.stocktakes.length) {
    el.innerHTML = '<div class="hint">暂无盘点单。</div>';
  } else {
    el.innerHTML = st.stocktakes.map((s) => {
      const badge = s.status === 'confirmed'
        ? '<span class="badge ok">已确认</span>'
        : '<span class="badge bad">草稿</span>';
      return `<div class="plan-item${st.detailId === s.id ? ' active' : ''}" data-id="${s.id}">
        <div>${badge} <b>#${s.id}</b> ${escapeHtml(s.name)}</div>
        <div class="muted small">${s.leadCount} 项铅条 · ${s.glassCount} 项玻璃 · 共 ${s.itemCount} 项
        ${s.confirmedAt ? ' · 确认于 ' + s.confirmedAt : ''}</div>
      </div>`;
    }).join('');
    el.querySelectorAll('.plan-item').forEach((div) => {
      div.addEventListener('click', () => stOpen(Number(div.dataset.id)));
    });
  }
  if (selectId) {
    const full = await api('GET', `/api/stocktakes/${selectId}`);
    stRenderDetail(full.data.stocktake);
  }
}

async function stOpen(id) {
  st.detailId = id;
  const data = await api('GET', `/api/stocktakes/${id}`);
  await stLoadList();
  stRenderDetail(data.stocktake);
}

function stDiffCell(v) {
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  if (v > 0) return `<span class="ok-text">+${v}</span>`;
  if (v < 0) return `<span class="gap-info">${v}</span>`;
  return '0';
}

function stRenderDetail(s) {
  const el = document.getElementById('stDetail');
  let html = `<div class="plan-head">
    <div><b>盘点单 #${s.id} · ${escapeHtml(s.name)}</b>
      <span class="badge ${s.status === 'confirmed' ? 'ok' : 'bad'}">${s.statusText}</span></div>
    <div class="muted">${s.leadCount} 项铅条 · ${s.glassCount} 项玻璃 · 共 ${s.itemCount} 项
      · 创建 ${s.createdAt}${s.confirmedAt ? ' · 确认于 ' + s.confirmedAt : ''}</div></div>`;

  if (s.status === 'confirmed') {
    html += '<div class="stock-badge ok">✓ 已确认：库存已按实盘数更新；记录保留原值、实盘值与确认时间，重复提交返回本记录不再调整。</div>';
  } else {
    html += '<div class="stock-badge cancel">草稿（预览已固化基准，未改库存）。确认前若库存或已确认预留发生变化，将整单拒绝。</div>';
  }

  const leadItems = s.items.filter((i) => i.type === 'lead');
  const glassItems = s.items.filter((i) => i.type === 'glass');
  const tableHead = (cols) => `<table><thead><tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.t}</th>`).join('')}</tr></thead><tbody>`;

  if (leadItems.length) {
    html += '<h3>铅条原材</h3>' + tableHead([
      { t: '规格' }, { t: '系统库存(原)', num: 1 }, { t: '已确认预留', num: 1 },
      { t: '实盘总数', num: 1 }, { t: '差异', num: 1 }, { t: '实盘后可用', num: 1 },
    ]);
    for (const it of leadItems) {
      html += `<tr${it.unavailable ? ' class="muted"' : ''}>
        <td>${escapeHtml(it.name)} <span class="muted small">${fmt(it.length)} mm</span></td>
        <td class="num">${it.stock}</td>
        <td class="num">${it.reserved}</td>
        <td class="num"><b>${it.counted}</b></td>
        <td class="num">${stDiffCell(it.diff)}</td>
        <td class="num"><b>${it.availableAfterCount}</b></td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  if (glassItems.length) {
    html += '<h3>玻璃原片</h3>' + tableHead([
      { t: '颜色' }, { t: '系统库存(原)', num: 1 }, { t: '已确认预留', num: 1 }, { t: '瑕疵隔离', num: 1 },
      { t: '实盘总数', num: 1 }, { t: '差异', num: 1 }, { t: '实盘后可用', num: 1 },
    ]);
    for (const it of glassItems) {
      html += `<tr${it.unavailable ? ' class="muted"' : ''}>
        <td><span class="color-chip" style="background:${it.color}"></span>${it.color}
          <span class="muted small">${it.width}×${it.height} mm</span></td>
        <td class="num">${it.stock}</td>
        <td class="num">${it.reserved}</td>
        <td class="num">${it.quarantined || 0}</td>
        <td class="num"><b>${it.counted}</b></td>
        <td class="num">${stDiffCell(it.diff)}</td>
        <td class="num"><b>${it.availableAfterCount}</b></td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  html += `<div class="hint small">系统库存/已确认预留/瑕疵隔离/差异/实盘后可用量为<b>预览基准口径</b>（确认时即盘点口径）；
    “实盘后可用 = 实盘总数 − 已确认预留 − 瑕疵隔离”，独立计划、裁片订单与整套单随后按该口径计算。</div>`;

  if (s.status === 'draft') {
    html += `<div class="btn-row">
      <button id="btnStConfirm" class="primary big">确认盘点（重核通过后更新库存）</button>
      <button id="btnStRepreview">改后重新预览（刷新基准）</button>
      <button id="btnStLoad">载入到左侧编辑</button>
      <button id="btnStDelete" class="danger">删除草稿</button>
    </div>
    <div class="hint">确认在一个事务内完成：任一项系统库存/预留与预览基准不符，或实盘数低于当前预留，都会返回该项及原因，整单不生效。</div>`;
  }

  el.innerHTML = html;
  const cf = document.getElementById('btnStConfirm');
  if (cf) cf.addEventListener('click', () => confirmStocktake(s.id));
  const rp = document.getElementById('btnStRepreview');
  if (rp) rp.addEventListener('click', () => previewStocktake(s.id));
  const ld = document.getElementById('btnStLoad');
  if (ld) ld.addEventListener('click', () => stLoadIntoEditor(s));
  const de = document.getElementById('btnStDelete');
  if (de) de.addEventListener('click', () => deleteStocktake(s.id));
}

document.getElementById('tabStocktake').addEventListener('click', () => switchTab('stocktake'));
document.getElementById('btnStPreview').addEventListener('click', () => previewStocktake(null));

// ================= 领料（独立计划 / 独立裁片订单 / 整套单 分次领料） =================

const issue = {
  sourceType: 'lead_plan',
  sources: [], // 当前类型可选单据
  current: null, // 选中的单据详情（含剩余预留）
  selectedId: null,
};

function issueBanner(kind, msg) {
  const b = document.getElementById('issueBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
  clearTimeout(issueBanner._t);
  if (kind === 'success') issueBanner._t = setTimeout(() => { b.hidden = true; }, 4000);
}

function genIssueNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `LL-${stamp}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

async function enterIssue() {
  issueBanner(false);
  document.getElementById('issueNo').value = genIssueNo();
  await issueLoadSources();
  await issueLoadHistory();
}

async function issueLoadSources() {
  issue.sourceType = document.getElementById('issueSourceType').value;
  let url;
  if (issue.sourceType === 'lead_plan') url = '/api/plans';
  else if (issue.sourceType === 'cut_order') url = '/api/cut-orders';
  else url = '/api/combo-orders';
  const data = await api('GET', url);
  const key = issue.sourceType === 'lead_plan' ? 'plans'
    : issue.sourceType === 'cut_order' ? 'orders' : 'combos';
  issue.sources = data[key].filter((x) => x.status === 'confirmed');
  const sel = document.getElementById('issueSourceSelect');
  if (!issue.sources.length) {
    sel.innerHTML = '<option value="">（暂无已确认单据）</option>';
  } else {
    sel.innerHTML = issue.sources.map((x) => {
      let label;
      if (issue.sourceType === 'lead_plan') {
        label = `#${x.id} ${x.name}（v${x.version} · 需 ${x.requiredBars} 根 · 余 ${x.remainingBars}）`;
      } else if (issue.sourceType === 'cut_order') {
        label = `#${x.id} ${x.name}（v${x.version} · 需 ${x.totalSheets} 张 · 余 ${x.remainingSheets}）`;
      } else {
        label = `#${x.id} ${x.name}（v${x.version} · 铅条余 ${x.remainingBars} / 玻璃余 ${x.remainingSheets}）`;
      }
      return `<option value="${x.id}">${escapeHtml(label)}</option>`;
    }).join('');
  }
  await issueSelectSource();
}

async function issueSelectSource() {
  issue.selectedId = Number(document.getElementById('issueSourceSelect').value) || null;
  const leadBox = document.getElementById('issueLeadBox');
  const glassBox = document.getElementById('issueGlassBox');
  if (!issue.selectedId) {
    leadBox.hidden = true;
    glassBox.hidden = true;
    document.getElementById('issueDetail').innerHTML = '<div class="hint">没有已确认单据可选。</div>';
    return;
  }
  leadBox.hidden = issue.sourceType === 'cut_order';
  glassBox.hidden = issue.sourceType === 'lead_plan';

  let detailUrl, statsUrl;
  if (issue.sourceType === 'lead_plan') {
    detailUrl = `/api/plans/${issue.selectedId}/issues`;
  } else if (issue.sourceType === 'cut_order') {
    detailUrl = `/api/cut-orders/${issue.selectedId}/issues`;
  } else {
    detailUrl = `/api/combo-orders/${issue.selectedId}/issues`;
  }
  void statsUrl;
  const data = await api('GET', detailUrl);
  issue.current = data;
  issueRenderInputs(data);
  issueRenderDetail(data);
}

function issueRenderInputs(d) {
  const leadInput = document.getElementById('issueLeadBars');
  if (d.lead) {
    leadInput.max = d.lead.remainingBars;
    leadInput.value = 0;
  }
  const box = document.getElementById('issueGlassInputs');
  if (!d.glass || !d.glass.colors || !d.glass.colors.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<table><tbody>' + d.glass.colors.map((c) => `
    <tr>
      <td><span class="color-chip" style="background:${c.color}"></span>${c.color}</td>
      <td class="num muted small">预留 ${c.requiredSheets} · 已领 ${c.pickedSheets} · <b>余 ${c.remainingSheets}</b></td>
      <td><input type="number" min="0" max="${c.remainingSheets}" step="1" value="0"
            data-issue-sheet="${c.sheetId}" data-issue-color="${c.color}" style="width:80px"></td>
    </tr>`).join('') + '</tbody></table>';
}

function issueRenderDetail(d) {
  const el = document.getElementById('issueDetail');
  let html = '';
  if (d.lead) {
    html += `<h3>铅条</h3>
      <div class="stock-badge ${d.lead.remainingBars > 0 ? 'ok' : ''}">
        ${escapeHtml(d.lead.materialName || '')}：预留 <b>${d.lead.requiredBars}</b> 根 ·
        已领 <b>${d.lead.pickedBars}</b> · 尚未领出 <b>${d.lead.remainingBars}</b> ·
        实物库存 ${d.lead.stockBars === null ? '—' : d.lead.stockBars} 根
      </div>`;
  }
  if (d.glass && d.glass.colors && d.glass.colors.length) {
    html += `<h3>玻璃原片（预留 ${d.glass.totalRequired} · 已领 ${d.glass.totalPicked} · 余 ${d.glass.totalRemaining} 张）</h3>
      <table><thead><tr><th>颜色</th><th class="num">预留</th><th class="num">已领</th><th class="num">余留</th><th class="num">实物库存</th></tr></thead><tbody>`;
    for (const c of d.glass.colors) {
      html += `<tr>
        <td><span class="color-chip" style="background:${c.color}"></span>${c.color}</td>
        <td class="num">${c.requiredSheets}</td>
        <td class="num">${c.pickedSheets}</td>
        <td class="num"><b>${c.remainingSheets}</b></td>
        <td class="num">${c.stockSheets === null ? '—' : c.stockSheets}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  const issues = d.issues || [];
  html += `<h3>本单领料记录（${issues.length} 次，不可变、不可取消）</h3>`;
  if (!issues.length) {
    html += '<div class="hint">尚未领料。</div>';
  } else {
    html += '<ul class="issue-records">' + issues.map(issueRecordHtml).join('') + '</ul>';
  }
  el.innerHTML = html;
}

function issueRecordHtml(i) {
  const typeZh = { lead_plan: '铅条计划', cut_order: '裁片订单', combo: '整套单' }[i.sourceType];
  const parts = [];
  if (i.leadBars > 0) parts.push(`铅条 <b>${i.leadBars}</b> 根`);
  for (const g of i.glass) parts.push(`<span class="color-chip" style="background:${g.color}"></span>${g.color} <b>${g.count}</b> 张`);
  return `<li><span class="badge ok">${typeZh}</span> <code>${escapeHtml(i.issueNo)}</code>
    <span class="muted small">${i.issuedAt}</span><br>${parts.join('　') || '—'}</li>`;
}

async function issueSubmit() {
  if (!issue.selectedId) { issueBanner('error', '⛔ 请先选择已确认单据'); return; }
  const issueNo = document.getElementById('issueNo').value.trim();
  if (!issueNo) { issueBanner('error', '⛔ 请填写唯一领料号（可点“生成领料号”）'); return; }
  const body = { issueNo };
  if (issue.sourceType !== 'cut_order') {
    const v = Number(document.getElementById('issueLeadBars').value);
    if (!Number.isInteger(v) || v < 0) { issueBanner('error', '⛔ 铅条根数必须是非负整数'); return; }
    body.leadBars = v;
  }
  if (issue.sourceType !== 'lead_plan') {
    const sheets = [];
    document.querySelectorAll('[data-issue-sheet]').forEach((inp) => {
      const n = Number(inp.value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error('玻璃张数必须是非负整数');
      }
      if (n > 0) sheets.push({ sheetId: Number(inp.dataset.issueSheet), count: n });
    });
    body.sheets = sheets;
  }
  const url = issue.sourceType === 'lead_plan'
    ? `/api/plans/${issue.selectedId}/issues`
    : issue.sourceType === 'cut_order'
      ? `/api/cut-orders/${issue.selectedId}/issues`
      : `/api/combo-orders/${issue.selectedId}/issues`;
  try {
    const data = await api('POST', url, body);
    const i = data.issue;
    const parts = [];
    if (i.lead) parts.push(`铅条本次 ${i.lead.thisBars} / 累计 ${i.lead.pickedBars} / 余留 ${i.lead.remainingBars} 根`);
    if (i.glass && i.glass.colors && i.glass.colors.some((c) => c.thisSheets > 0)) {
      parts.push(i.glass.colors.filter((c) => c.thisSheets > 0)
        .map((c) => `${c.color} 本次 ${c.thisSheets} / 累计 ${c.pickedSheets} / 余留 ${c.remainingSheets}`).join('；'));
    }
    issueBanner('success', (data.idempotent ? '该领料号已提交过：返回原记录（未再次扣减）。<br>' : '✓ 领料成功（库存与预留已在同一事务内核减）。<br>') +
      parts.join('<br>'));
    document.getElementById('issueNo').value = genIssueNo();
    await issueLoadSources();
    await issueLoadHistory();
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'invalid_issue' && Array.isArray(d.problems)) {
      txt += '<br>' + d.problems.map((p) => escapeHtml(p.message)).join('<br>');
      txt += '<br>整次领料未生效，库存未扣减。';
    }
    if (d.code === 'issue_no_conflict') txt += '；请更换领料号。';
    issueBanner('error', txt);
    await issueLoadSources();
    await issueLoadHistory();
  }
}

async function issueLoadHistory() {
  const source = document.getElementById('issueFilter').value;
  const data = await api('GET', '/api/issues' + (source ? `?source=${source}` : ''));
  const el = document.getElementById('issueHistory');
  if (!data.issues.length) { el.innerHTML = '<div class="hint">暂无领料记录。</div>'; return; }
  el.innerHTML = '<ul class="issue-records">' + data.issues.map(issueRecordHtml).join('') + '</ul>';
}

document.getElementById('tabIssue').addEventListener('click', () => switchTab('issue'));
document.getElementById('issueSourceType').addEventListener('change', issueLoadSources);
document.getElementById('issueSourceSelect').addEventListener('change', issueSelectSource);
document.getElementById('issueFilter').addEventListener('change', issueLoadHistory);
document.getElementById('btnIssueSubmit').addEventListener('click', () => { issueSubmit().catch((e) => issueBanner('error', '⛔ ' + e.message)); });
document.getElementById('btnIssueNewNo').addEventListener('click', () => {
  document.getElementById('issueNo').value = genIssueNo();
});

// ================= 玻璃原片瑕疵隔离（隔离 / 解除隔离） =================

const quar = { sheets: [], history: [] };

function qBanner(kind, msg) {
  const b = document.getElementById('qBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
  clearTimeout(qBanner._t);
  if (kind === 'success') qBanner._t = setTimeout(() => { b.hidden = true; }, 5000);
}

function genQOpNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `Q-${stamp}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

async function enterQuarantine() {
  qBanner(false);
  document.getElementById('qOpNo').value = genQOpNo();
  await qLoadAll();
}

async function qLoadAll() {
  await qLoadSheets();
  await qLoadHistory();
}

async function qLoadSheets() {
  const data = await api('GET', '/api/glass-sheets');
  quar.sheets = data.sheets;
  qRenderColorList();
  qRenderBalances();
  // 历史筛选下拉
  const sel = document.getElementById('qFilterSpec');
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部颜色</option>' + quar.sheets
    .map((s) => `<option value="${s.id}">${s.color}（${s.width}×${s.height}mm）</option>`).join('');
  sel.value = prev;
}

// 左侧：按当前操作（hold/release）渲染各色可输入行
function qRenderColorList() {
  const action = document.getElementById('qAction').value;
  const el = document.getElementById('qColorList');
  if (!quar.sheets.length) {
    el.innerHTML = '<div class="hint">尚未登记任何颜色原片，请到“玻璃裁片”标签先登记。</div>';
    return;
  }
  el.innerHTML = '<table><tbody>' + quar.sheets.map((s) => {
    const free = s.stock - s.reserved - s.quarantined; // 未预留且未隔离
    const hint = action === 'hold'
      ? `可隔离 <b>${free}</b>（实物 ${s.stock} − 净预留 ${s.reserved} − 已隔离 ${s.quarantined}）`
      : `隔离余额 <b>${s.quarantined}</b>`;
    return `<tr>
      <td><span class="color-chip" style="background:${s.color}"></span>${s.color}</td>
      <td class="num muted small">${hint}</td>
      <td><input type="number" min="1" step="1" value="0" data-q-sheet="${s.id}"
            data-q-action-limit="${action === 'hold' ? free : s.quarantined}" style="width:72px"></td>
    </tr>`;
  }).join('') + '</tbody></table>';
}

// 右侧：各色隔离余额与实际可用量总表
function qRenderBalances() {
  const el = document.getElementById('qBalances');
  if (!quar.sheets.length) { el.innerHTML = '<div class="hint">暂无已登记颜色原片。</div>'; return; }
  let html = `<div class="hint">实际可用量 = 实物库存 − 净预留（未领预留）− 瑕疵隔离；新裁片订单与整套单按此口径扣减隔离量。</div>
    <table><thead><tr>
      <th>颜色</th><th class="num">原片宽×高</th><th class="num">实物库存</th>
      <th class="num">净预留</th><th class="num">隔离余额</th><th class="num">实际可用</th>
    </tr></thead><tbody>`;
  for (const s of quar.sheets) {
    html += `<tr>
      <td><span class="color-chip" style="background:${s.color}"></span>${s.color}</td>
      <td class="num">${s.width}×${s.height}</td>
      <td class="num">${s.stock}</td>
      <td class="num">${s.reserved}</td>
      <td class="num${s.quarantined > 0 ? ' neg-text' : ''}"><b>${s.quarantined}</b></td>
      <td class="num"><b>${s.available}</b></td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function qLoadHistory() {
  const specId = document.getElementById('qFilterSpec').value;
  const url = '/api/glass-quarantines' + (specId ? `?sheetId=${specId}` : '');
  const data = await api('GET', url);
  quar.history = data.quarantines;
  const el = document.getElementById('qHistory');
  if (!quar.history.length) { el.innerHTML = '<div class="hint">暂无隔离记录。</div>'; return; }
  el.innerHTML = '<ul class="issue-records">' + quar.history.map(qRecordHtml).join('') + '</ul>';
}

function qRecordHtml(q) {
  const badge = q.action === 'hold'
    ? '<span class="badge bad">隔离</span>'
    : '<span class="badge ok">解除</span>';
  const parts = q.items.map((it) =>
    `<span class="color-chip" style="background:${it.color}"></span>${it.color} <b>${it.count}</b> 张（笔后隔离 ${it.balanceQuarantined}）`);
  return `<li class="q-record" data-q-id="${q.id}">${badge} <code>${escapeHtml(q.opNo)}</code>
    <span class="muted small">${q.createdAt}</span><br>
    <span class="muted small">原因：${escapeHtml(q.reason)}</span><br>${parts.join('　')}</li>`;
}

function qRenderDetail(q) {
  const el = document.getElementById('qDetail');
  let html = `<div class="plan-head">
    <div><b>操作 #${q.id} · ${q.actionText}</b>
      <span class="badge ${q.action === 'hold' ? 'bad' : 'ok'}">${q.actionText}</span>
      <code>${escapeHtml(q.opNo)}</code></div>
    <div class="muted">${q.createdAt} · 原因：${escapeHtml(q.reason)}</div></div>
    <table><thead><tr><th>颜色</th><th class="num">本次${q.actionText}</th><th class="num">笔后隔离余额</th>
      <th class="num">实物库存</th><th class="num">净预留</th><th class="num">实际可用</th></tr></thead><tbody>`;
  for (const it of q.items) {
    html += `<tr>
      <td><span class="color-chip" style="background:${it.color}"></span>${it.color}</td>
      <td class="num"><b>${it.count}</b></td>
      <td class="num"><b>${it.balanceQuarantined}</b></td>
      <td class="num">${it.stock === null ? '—' : it.stock}</td>
      <td class="num">${it.reserved === null ? '—' : it.reserved}</td>
      <td class="num">${it.available === null ? '—' : it.available}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function qSubmit() {
  const action = document.getElementById('qAction').value;
  const opNo = document.getElementById('qOpNo').value.trim();
  const reason = document.getElementById('qReason').value.trim();
  if (!opNo) { qBanner('error', '⛔ 请填写唯一操作号（可点“生成操作号”）'); return; }
  if (!reason) { qBanner('error', '⛔ 请填写非空原因'); return; }
  const items = [];
  let bad = false;
  document.querySelectorAll('[data-q-sheet]').forEach((inp) => {
    const n = Number(inp.value);
    if (!Number.isInteger(n) || n < 0) { bad = true; return; }
    if (n > 0) items.push({ sheetId: Number(inp.dataset.qSheet), count: n });
  });
  if (bad) { qBanner('error', '⛔ 各色张数必须是非负整数（要操作的颜色请填正整数，其余保持 0）'); return; }
  if (!items.length) { qBanner('error', '⛔ 请至少为一种颜色填写正整数张数'); return; }
  try {
    const data = await api('POST', '/api/glass-quarantines', { opNo, action, reason, items });
    qRenderDetail(data.quarantine);
    const parts = data.quarantine.items.map((it) => `${it.color} ${it.count} 张（笔后隔离 ${it.balanceQuarantined}）`);
    qBanner('success',
      (data.idempotent ? `操作号 ${opNo} 已提交过：返回原记录（未重复变更）。<br>` : '✓ 操作已原子生效（实物库存不变，已写不可变记录与台账）。<br>') +
      parts.join('；'));
    document.getElementById('qOpNo').value = genQOpNo();
    document.getElementById('qReason').value = '';
    await qLoadAll();
  } catch (err) {
    const d = err.data || {};
    let txt = '⛔ ' + (d.error || err.message);
    if (d.code === 'shortage' && Array.isArray(d.problems)) {
      txt += '<br>' + d.problems.map((p) => escapeHtml(p.reasonText)).join('<br>');
      txt += '<br>整次操作未生效，未写任何记录。';
    }
    if (d.code === 'op_no_conflict') txt += '；请更换操作号。';
    qBanner('error', txt);
    await qLoadAll();
  }
}

document.getElementById('tabQuarantine').addEventListener('click', () => switchTab('quarantine'));
document.getElementById('qAction').addEventListener('change', qRenderColorList);
document.getElementById('qFilterSpec').addEventListener('change', qLoadHistory);
document.getElementById('btnQSubmit').addEventListener('click', () => { qSubmit().catch((e) => qBanner('error', '⛔ ' + e.message)); });
document.getElementById('btnQNewNo').addEventListener('click', () => {
  document.getElementById('qOpNo').value = genQOpNo();
});
document.getElementById('qHistory').addEventListener('click', async (e) => {
  const li = e.target.closest('.q-record');
  if (!li) return;
  const data = await api('GET', `/api/glass-quarantines/${li.dataset.qId}`);
  qRenderDetail(data.quarantine);
});

// ================= 库存台账（按规格追溯实物库存与净预留） =================

const ledger = {
  type: 'lead',
  specs: [],
  result: null,
};

function ledgerBanner(kind, msg) {
  const b = document.getElementById('ledgerBanner');
  if (!kind) { b.hidden = true; b.textContent = ''; return; }
  b.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  b.hidden = false;
  b.innerHTML = msg;
}

async function enterLedger() {
  ledgerBanner(false);
  try {
    await ledgerLoadSpecs();
  } catch (err) {
    ledgerBanner('error', '⛔ ' + (err.data?.error || err.message));
  }
}

async function ledgerLoadSpecs() {
  ledger.type = document.getElementById('ledgerType').value;
  const data = await api('GET', ledger.type === 'lead' ? '/api/materials' : '/api/glass-sheets');
  ledger.specs = ledger.type === 'lead' ? data.materials : data.sheets;
  const sel = document.getElementById('ledgerSpec');
  if (!ledger.specs.length) {
    sel.innerHTML = '<option value="">（暂无已登记规格）</option>';
    return;
  }
  sel.innerHTML = ledger.specs.map((s) => {
    const label = ledger.type === 'lead'
      ? `#${s.id} ${s.name}（定尺 ${fmt(s.length)}mm · 库存 ${s.stock} / 净预留 ${s.reserved}）`
      : `#${s.id} ${s.color}（${s.width}×${s.height}mm · 库存 ${s.stock} / 净预留 ${s.reserved} / 隔离 ${s.quarantined || 0}）`;
    return `<option value="${s.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

async function ledgerQuery() {
  const specId = Number(document.getElementById('ledgerSpec').value);
  if (!specId) { ledgerBanner('error', '⛔ 请先登记并选择要追溯的规格'); return; }
  const params = new URLSearchParams({ type: ledger.type, specId: String(specId) });
  const fromRaw = document.getElementById('ledgerFrom').value;
  const toRaw = document.getElementById('ledgerTo').value;
  if (fromRaw) params.set('from', fromRaw.replace('T', ' '));
  if (toRaw) params.set('to', toRaw.replace('T', ' '));
  try {
    const data = await api('GET', `/api/ledger?${params.toString()}`);
    ledger.result = data.ledger;
    ledgerRender();
    ledgerBanner(false);
  } catch (err) {
    ledgerBanner('error', '⛔ ' + (err.data?.error || err.message));
  }
}

function ledgerDeltaHtml(n) {
  const cls = n > 0 ? 'ok-text' : n < 0 ? 'neg-text' : 'muted';
  return `<td class="num ${cls}">${n > 0 ? `+${n}` : n}</td>`;
}

function ledgerRender() {
  const L = ledger.result;
  if (!L) return;
  const isGlass = L.materialType === 'glass';
  document.getElementById('ledgerCurrentSection').hidden = false;
  document.getElementById('ledgerCurrent').innerHTML =
    `<div class="stock-badge ok">${escapeHtml(L.materialTypeText)} ${escapeHtml(L.specName)}
      <span class="muted small">${escapeHtml(L.specDetail)}</span><br>
      实物库存 <b>${L.current.stock}</b> ${L.unit} · 净预留 <b>${L.current.reserved}</b>${
        isGlass ? ` · 瑕疵隔离 <b>${L.current.quarantined || 0}</b>` : ''
      } · 可用 <b>${L.current.available}</b>
    </div>`;
  const el = document.getElementById('ledgerTable');
  if (!L.entries.length) {
    el.innerHTML = '<div class="hint">该条件下暂无台账记录（换个时间范围或规格试试）。</div>';
    return;
  }
  let html = `<div class="hint">共 ${L.count} 笔，按发生顺序排列；笔后余额可与当前结存逐笔核对。</div>
    <table><thead><tr>
      <th>#</th><th>发生时间</th><th>业务来源</th><th>事件</th>
      <th class="num">实物增减</th><th class="num">净预留增减</th>${
        isGlass ? '<th class="num">隔离增减</th>' : ''
      }
      <th class="num">笔后实物</th><th class="num">笔后净预留</th>${
        isGlass ? '<th class="num">笔后隔离</th>' : ''
      }
    </tr></thead><tbody>`;
  for (const e of L.entries) {
    html += `<tr>
      <td class="muted">${e.id}</td>
      <td>${escapeHtml(e.occurredAt)}</td>
      <td>${escapeHtml(e.sourceLabel)}</td>
      <td>${escapeHtml(e.eventText)}</td>
      ${ledgerDeltaHtml(e.deltaStock)}
      ${ledgerDeltaHtml(e.deltaReserved)}
      ${isGlass ? ledgerDeltaHtml(e.deltaQuarantined || 0) : ''}
      <td class="num"><b>${e.balanceStock}</b></td>
      <td class="num"><b>${e.balanceReserved}</b></td>
      ${isGlass ? `<td class="num"><b>${e.balanceQuarantined || 0}</b></td>` : ''}
    </tr>`;
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

document.getElementById('tabLedger').addEventListener('click', () => switchTab('ledger'));
document.getElementById('ledgerType').addEventListener('change', () => {
  ledgerLoadSpecs().catch((e) => ledgerBanner('error', '⛔ ' + (e.data?.error || e.message)));
});
document.getElementById('btnLedgerQuery').addEventListener('click', () => { ledgerQuery(); });

// ================= 跨图纸拼片复用（发布快照 → 目标草稿） =================

const reuseState = {
  srcDesigns: [],
  srcPubs: null,       // 当前来源图纸的发布版列表
  srcSnapshot: null,   // 当前选中发布版的 snapshot
  targetDraft: null,   // GET 目标草稿
  preview: null,       // 最近一次成功预览
};

const reuseCanvas = document.getElementById('reuseCanvas');
const reuseCtx = reuseCanvas.getContext('2d');

function reuseBanner(kind, msg) {
  const el = document.getElementById('reuseBanner');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `banner ${kind === 'error' ? 'error' : 'success'}`;
  el.textContent = msg;
}

async function enterReuse() {
  await reuseLoadDesigns();
  await reuseLoadSourceVersions();
  await reuseLoadPending();
}

async function reuseLoadDesigns() {
  const data = await api('GET', '/api/designs');
  reuseState.srcDesigns = data.designs;
  for (const [selId, ph] of [
    ['reuseSrcDesign', '来源图纸'],
    ['reuseTargetDesign', '目标草稿'],
  ]) {
    const sel = document.getElementById(selId);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const d of data.designs) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name}（${d.width}×${d.height}mm）`;
      sel.appendChild(opt);
    }
    void ph;
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  if (data.designs.length) await reuseLoadTargetDraft();
}

async function reuseLoadSourceVersions() {
  const designId = document.getElementById('reuseSrcDesign').value;
  const sel = document.getElementById('reuseSrcVersion');
  sel.innerHTML = '';
  reuseState.srcPubs = null;
  reuseState.srcSnapshot = null;
  if (!designId) { reuseRenderPieces(); return; }
  const data = await api('GET', `/api/designs/${designId}/publications`);
  reuseState.srcPubs = data.publications; // 倒序
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    reuseRenderPieces();
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.version;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
  await reuseLoadSnapshot();
}

async function reuseLoadSnapshot() {
  const designId = document.getElementById('reuseSrcDesign').value;
  const version = document.getElementById('reuseSrcVersion').value;
  if (!designId || !version) { reuseState.srcSnapshot = null; reuseRenderPieces(); return; }
  const data = await api('GET', `/api/designs/${designId}/publications/${version}`);
  reuseState.srcSnapshot = data.publication;
  reuseRenderPieces();
  reuseRenderCanvas();
}

function reuseRenderPieces() {
  const ul = document.getElementById('reusePieceList');
  ul.innerHTML = '';
  const snap = reuseState.srcSnapshot?.snapshot;
  if (!snap) {
    ul.innerHTML = '<li class="hint">来源图纸还没有已发布版本。</li>';
    return;
  }
  for (const pc of snap.pieces) {
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" value="${pc.pieceNo}">
      <span class="swatch" style="background:${pc.color}"></span>
      <span><b>#${pc.pieceNo}</b> · ${pc.area} mm²</span></label>`;
    li.querySelector('input').addEventListener('change', () => {
      // 选择变化只影响下一次预览，不自动请求
      reuseBanner(false);
    });
    ul.appendChild(li);
  }
}

async function reuseLoadTargetDraft() {
  const id = document.getElementById('reuseTargetDesign').value;
  if (!id) { reuseState.targetDraft = null; reuseRenderCanvas(); return; }
  const data = await api('GET', `/api/designs/${id}`);
  reuseState.targetDraft = data.draft;
  reuseRenderCanvas();
}

function reuseCollectPieceNos() {
  return [...document.querySelectorAll('#reusePieceList input:checked')]
    .map((c) => Number(c.value))
    .sort((a, b) => a - b);
}

async function reuseRunPreview() {
  reuseBanner(false);
  const targetId = Number(document.getElementById('reuseTargetDesign').value);
  const srcDesignId = Number(document.getElementById('reuseSrcDesign').value);
  const srcVersion = Number(document.getElementById('reuseSrcVersion').value);
  const pieceNos = reuseCollectPieceNos();
  const rotation = Number(document.getElementById('reuseRotation').value);
  const dx = Number(document.getElementById('reuseDx').value);
  const dy = Number(document.getElementById('reuseDy').value);
  if (!targetId || !srcDesignId || !srcVersion) {
    reuseBanner('error', '请先选择来源图纸、发布版本和目标草稿');
    return;
  }
  if (!pieceNos.length) {
    reuseBanner('error', '请至少勾选一片拼片');
    return;
  }
  try {
    const data = await api('POST', `/api/designs/${targetId}/imports/preview`, {
      sourceDesignId: srcDesignId,
      sourceVersion: srcVersion,
      pieceNos, rotation, dx, dy,
    });
    reuseState.preview = data.preview;
    reuseRenderResult(data.preview, null);
    reuseRenderCanvas();
    await reuseLoadPending();
    reuseBanner('success', `预览 #${data.preview.id} 已生成（未写入）：核对无误后点“确认整批导入”。`);
  } catch (err) {
    reuseState.preview = null;
    const d = err.data || {};
    if (d.code === 'geometry_conflict' && Array.isArray(d.problems)) {
      reuseRenderResult(null, d.problems);
      reuseRenderCanvas(d.problems);
    } else {
      reuseRenderResult(null, null, err.message);
      reuseRenderCanvas();
    }
    reuseBanner('error', '⛔ ' + (d.error || err.message));
  }
}

function reuseCoverageBadge(cov) {
  if (!cov) return '';
  if (cov.covered) return '<span class="badge ok">✓ 完整覆盖，无空隙</span>';
  const gapN = cov.gaps.length;
  const ovN = cov.overlapping.length;
  return `<span class="badge bad">✗ 缺口 ${gapN} 块${ovN ? `、重叠 ${ovN} 处` : ''}</span>`;
}

function reuseRenderResult(pv, problems, errorText) {
  const box = document.getElementById('reuseResult');
  if (errorText) { box.className = 'hint'; box.textContent = errorText; return; }
  if (problems) {
    box.className = '';
    let html = '<div class="badge bad" style="margin-bottom:8px">几何冲突，整批未写入</div><table><thead><tr><th>来源片</th><th>问题</th><th>位置 (mm)</th><th>冲突对象</th></tr></thead><tbody>';
    for (const p of problems) {
      const who = p.withKind === 'existing' ? `目标已有片 #${p.withPieceNo}`
        : p.withKind === 'import' ? `本批来源片 #${p.withPieceNo}` : '—';
      const reason = p.reason === 'out_of_frame' ? '超出目标窗框'
        : p.reason === 'invalid_polygon' ? '多边形不合法' : '面积重叠';
      html += `<tr><td>#${p.sourcePieceNo}</td><td>${reason}</td>` +
        `<td>${p.at ? `(${p.at[0]}, ${p.at[1]})` : '—'}</td><td>${who}</td></tr>`;
    }
    html += '</tbody></table>';
    box.innerHTML = html;
    return;
  }
  if (!pv) { box.className = 'hint'; box.textContent = '尚未生成预览。'; return; }
  box.className = '';
  let html = `<div style="margin-bottom:8px">
      来源：<b>${escapeHtml(pv.source.designName)}</b> v${pv.source.version}
      （发布版 #${pv.source.publicationId}） → 目标图纸 #${pv.target.designId}
      （${pv.target.width}×${pv.target.height} mm）<br>
      旋转 ${pv.rotation}° · 平移 (${pv.dx}, ${pv.dy}) mm · 共 ${pv.items.length} 片
    </div>
    <table><thead><tr><th>新序</th><th>来源片</th><th>颜色</th><th>外接范围 (mm)</th><th>面积 mm²</th></tr></thead><tbody>`;
  pv.items.forEach((it, i) => {
    html += `<tr><td>${i + 1}</td><td>#${it.sourcePieceNo}</td>
      <td><span class="color-chip" style="background:${it.color}"></span>${it.color}</td>
      <td>x ${it.bounds.minX}–${it.bounds.maxX}, y ${it.bounds.minY}–${it.bounds.maxY}</td>
      <td class="num">${it.area}</td></tr>`;
  });
  html += '</tbody></table><div style="margin-top:10px; display:flex; gap:16px; flex-wrap:wrap">' +
    `<div>预览前目标草稿：${pv.targetDraft.pieceCount} 片 ${reuseCoverageBadge(pv.targetDraft.coverage)}</div>` +
    `<div>导入后模拟：${pv.simulated.pieceCount} 片 ${reuseCoverageBadge(pv.simulated.coverage)}</div></div>` +
    `<div class="btn-row" style="margin-top:12px">
      <button class="primary" onclick="reuseConfirm(${pv.id})">确认整批导入（整批写入）</button>
      <button class="danger" onclick="reuseDelete(${pv.id})">放弃此预览</button>
    </div>
    <div class="hint">确认后这些拼片整批赋予目标图纸新编号并保留原色；源发布快照、生产单与库存均不变。</div>`;
  box.innerHTML = html;
}

async function reuseConfirm(id) {
  const targetId = Number(document.getElementById('reuseTargetDesign').value);
  try {
    const data = await api('POST', `/api/designs/${targetId}/imports/${id}/confirm`);
    reuseBanner('success',
      `已整批导入 ${data.addedPieces.length} 片：新编号 ${data.addedPieces.map((p) => `#${p.pieceNo}`).join('、')}，颜色保留。`);
    reuseState.preview = null;
    reuseRenderResult(null, null);
    document.querySelectorAll('#reusePieceList input:checked').forEach((c) => { c.checked = false; });
    await Promise.all([reuseLoadTargetDraft(), reuseLoadPending()]);
    // 草稿编辑标签也刷新，便于继续编辑/发布
    if (Number(document.getElementById('designSelect').value) === targetId) {
      await loadDraft(targetId);
    }
  } catch (err) {
    const d = err.data || {};
    reuseBanner('error', '⛔ ' + (d.error || err.message));
    if (d.code === 'draft_changed') {
      reuseRenderResult(null, null, '目标草稿在预览后已被编辑：请重新点击“定位预览”再确认。');
    } else if (d.code === 'geometry_conflict') {
      reuseRenderResult(null, d.problems);
      reuseRenderCanvas(d.problems);
    }
    await reuseLoadPending();
  }
}

async function reuseDelete(id) {
  const targetId = Number(document.getElementById('reuseTargetDesign').value);
  try {
    await api('DELETE', `/api/designs/${targetId}/imports/${id}`);
    if (reuseState.preview?.id === id) {
      reuseState.preview = null;
      reuseRenderResult(null, null);
      reuseRenderCanvas();
    }
    await reuseLoadPending();
    reuseBanner('success', '预览已删除（未写入任何拼片）。');
  } catch (err) {
    reuseBanner('error', '⛔ ' + err.message);
  }
}

async function reuseLoadPending() {
  const section = document.getElementById('reusePendingSection');
  const box = document.getElementById('reusePendingList');
  const targetId = Number(document.getElementById('reuseTargetDesign').value);
  if (!targetId) { section.hidden = true; return; }
  const data = await api('GET', `/api/designs/${targetId}/imports?status=pending`);
  const pending = data.imports;
  if (!pending.length) { section.hidden = true; box.innerHTML = ''; return; }
  section.hidden = false;
  box.innerHTML = pending.map((p) => {
    const stale = false; // 列表不做逐行 stale 探测；打开确认时服务端权威判定
    void stale;
    return `<div class="reuse-item">
      <b>预览 #${p.id}</b> · 来源 v${p.sourceVersion} · ${p.pieceNos.length} 片
      （#${p.pieceNos.join(', #')}）<br>
      旋转 ${p.rotation}° · 平移 (${p.dx}, ${p.dy}) mm · ${p.createdAt}
      <div class="btn-row">
        <button class="primary" onclick="reuseOpenPending(${p.id})">载入到画布</button>
        <button class="danger" onclick="reuseDelete(${p.id})">删除</button>
      </div>
    </div>`;
  }).join('');
}

async function reuseOpenPending(id) {
  const targetId = Number(document.getElementById('reuseTargetDesign').value);
  try {
    const data = await api('GET', `/api/designs/${targetId}/imports/${id}`);
    const p = data.pieceImport;
    // 还原表单与勾选
    const srcSel = document.getElementById('reuseSrcDesign');
    if ([...srcSel.options].some((o) => Number(o.value) === p.sourceDesignId)) {
      srcSel.value = String(p.sourceDesignId);
      await reuseLoadSourceVersions();
    }
    document.getElementById('reuseSrcVersion').value = String(p.sourceVersion);
    await reuseLoadSnapshot();
    document.getElementById('reuseRotation').value = String(p.rotation);
    document.getElementById('reuseDx').value = p.dx;
    document.getElementById('reuseDy').value = p.dy;
    document.querySelectorAll('#reusePieceList input').forEach((c) => {
      c.checked = p.pieceNos.includes(Number(c.value));
    });
    const pv = {
      id: p.id,
      status: p.status,
      target: { designId: targetId, width: reuseState.targetDraft.width, height: reuseState.targetDraft.height },
      source: { publicationId: p.publicationId, designId: p.sourceDesignId, version: p.sourceVersion,
        designName: reuseState.srcSnapshot?.snapshot?.name || `图纸 #${p.sourceDesignId}` },
      selection: p.pieceNos, rotation: p.rotation, dx: p.dx, dy: p.dy,
      items: p.items, draftToken: p.draftFingerprint,
      targetDraft: { pieceCount: reuseState.targetDraft.pieces.length, coverage: reuseState.targetDraft.coverage },
      simulated: { pieceCount: null, coverage: null },
    };
    // 服务端已给 stale
    reuseState.preview = pv;
    reuseRenderResult(pv, null);
    reuseRenderCanvas();
    if (data.stale) {
      reuseBanner('error', '该预览生成后目标草稿已被编辑，不能直接确认；请重新点击“定位预览”。');
    } else {
      reuseBanner('success', `已载入待确认预览 #${p.id}。`);
    }
  } catch (err) {
    reuseBanner('error', '⛔ ' + err.message);
  }
}

// 画布：以目标窗框为坐标系，淡色画已有片，蓝边半透明画导入片，红 ✕ 画冲突位置
function reuseRenderCanvas(problems) {
  reuseCtx.clearRect(0, 0, reuseCanvas.width, reuseCanvas.height);
  const d = reuseState.targetDraft;
  if (!d) return;
  const t = getTransform(d, reuseCanvas);

  reuseCtx.fillStyle = '#fbfaf7';
  reuseCtx.fillRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  for (const pc of d.pieces) {
    const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
    reuseCtx.beginPath();
    reuseCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) reuseCtx.lineTo(pts[i][0], pts[i][1]);
    reuseCtx.closePath();
    reuseCtx.fillStyle = pc.color;
    reuseCtx.globalAlpha = 0.35;
    reuseCtx.fill();
    reuseCtx.globalAlpha = 1;
    reuseCtx.strokeStyle = '#777';
    reuseCtx.lineWidth = 1.2;
    reuseCtx.stroke();
  }

  const pv = reuseState.preview;
  if (pv && Array.isArray(pv.items)) {
    pv.items.forEach((it, i) => {
      const pts = it.polygon.map(([x, y]) => t.toPx(x, y));
      reuseCtx.beginPath();
      reuseCtx.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) reuseCtx.lineTo(pts[j][0], pts[j][1]);
      reuseCtx.closePath();
      reuseCtx.fillStyle = it.color;
      reuseCtx.globalAlpha = 0.7;
      reuseCtx.fill();
      reuseCtx.globalAlpha = 1;
      reuseCtx.strokeStyle = '#1565c0';
      reuseCtx.lineWidth = 2.2;
      reuseCtx.stroke();
      const [cx0, cy0] = centroid(it.polygon);
      const [cx, cy] = t.toPx(cx0, cy0);
      reuseCtx.font = 'bold 13px sans-serif';
      reuseCtx.textAlign = 'center';
      reuseCtx.textBaseline = 'middle';
      reuseCtx.fillStyle = 'rgba(255,255,255,0.85)';
      const label = `新${i + 1}←#${it.sourcePieceNo}`;
      const w = reuseCtx.measureText(label).width;
      reuseCtx.fillRect(cx - w / 2 - 4, cy - 9, w + 8, 18);
      reuseCtx.fillStyle = '#0b3d70';
      reuseCtx.fillText(label, cx, cy);
    });
  }

  // 冲突问题位置（红 ✕）
  if (Array.isArray(problems)) {
    for (const p of problems) {
      if (!p.at) continue;
      const [x, y] = t.toPx(p.at[0], p.at[1]);
      reuseCtx.beginPath();
      reuseCtx.arc(x, y, 9, 0, Math.PI * 2);
      reuseCtx.strokeStyle = '#d32f2f';
      reuseCtx.lineWidth = 3;
      reuseCtx.stroke();
      reuseCtx.beginPath();
      reuseCtx.moveTo(x - 5, y - 5); reuseCtx.lineTo(x + 5, y + 5);
      reuseCtx.moveTo(x + 5, y - 5); reuseCtx.lineTo(x - 5, y + 5);
      reuseCtx.strokeStyle = '#d32f2f';
      reuseCtx.lineWidth = 2.5;
      reuseCtx.stroke();
    }
  }

  reuseCtx.strokeStyle = '#222';
  reuseCtx.lineWidth = 3;
  reuseCtx.strokeRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);
}

window.reuseConfirm = reuseConfirm;
window.reuseDelete = reuseDelete;
window.reuseOpenPending = reuseOpenPending;

document.getElementById('tabReuse').addEventListener('click', () => switchTab('reuse'));
document.getElementById('reuseSrcDesign').addEventListener('change', reuseLoadSourceVersions);
document.getElementById('reuseSrcVersion').addEventListener('change', reuseLoadSnapshot);
document.getElementById('reuseTargetDesign').addEventListener('change', async () => {
  await reuseLoadTargetDraft();
  await reuseLoadPending();
});
document.getElementById('btnReusePreview').addEventListener('click', () => {
  reuseRunPreview().catch((e) => reuseBanner('error', '⛔ ' + (e.data?.error || e.message)));
});

