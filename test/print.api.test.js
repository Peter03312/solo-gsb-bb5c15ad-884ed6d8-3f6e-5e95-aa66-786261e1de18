'use strict';

// 端到端：已发布图纸 1:1 分张打印预览与逐页 SVG。
// 覆盖：正常分页/编号/重叠坐标、各类非法参数整单拒绝、版本不存在 404、
// 页码越界、SVG 物理尺寸与只读（预览/下载不改草稿、发布版、计划、库存）。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39125';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `print-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId;

async function req(method, url, body, raw) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: resp.status, text: await resp.text(), headers: resp.headers };
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data, headers: resp.headers };
}

const GOOD = { paperWidth: 210, paperHeight: 297, margin: 10, overlap: 15 };

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await req('GET', '/api/materials'); break; } catch { await sleep(50); }
  }
  const d = await req('POST', '/api/designs', { name: '打印窗', width: 250, height: 180 });
  designId = d.data.design.id;
  await req('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [100, 0], [100, 180], [0, 180]],
  });
  await req('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[100, 0], [250, 0], [250, 180], [100, 180]],
  });
  const p = await req('POST', `/api/designs/${designId}/publish`);
  pubId = p.data.publication.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('预览：行列页数、逐页覆盖坐标与编号正确', async () => {
  // 可打印 190×277，重叠 15；内容 250×180 → 2 列 1 行
  const r = await req('POST', `/api/designs/${designId}/publications/1/print/preview`, GOOD);
  assert.strictEqual(r.status, 200);
  const pr = r.data.preview;
  assert.strictEqual(pr.version, 1);
  assert.strictEqual(pr.publicationId, pubId);
  assert.deepStrictEqual([pr.print.cols, pr.print.rows, pr.print.totalPages], [2, 1, 2]);
  assert.strictEqual(pr.print.printable.width, 190);
  assert.strictEqual(pr.print.printable.height, 277);
  const [p1, p2] = pr.print.pages;
  assert.strictEqual(p1.page, 1);
  assert.deepStrictEqual([p1.col, p1.row], [1, 1]);
  assert.deepStrictEqual(p1.coverage, { x0: 0, y0: 0, x1: 190, y1: 180, width: 190, height: 180 });
  assert.strictEqual(p2.page, 2);
  assert.deepStrictEqual(p2.coverage, { x0: 175, y0: 0, x1: 250, y1: 180, width: 75, height: 180 });
  // 拼接标记互为邻页，重叠带两页同坐标
  const s1 = p1.seams.find((s) => s.edge === 'right');
  const s2 = p2.seams.find((s) => s.edge === 'left');
  assert.strictEqual(s1.neighborPage, 2);
  assert.strictEqual(s2.neighborPage, 1);
  assert.deepStrictEqual(s1.overlap, s2.overlap);
  assert.deepStrictEqual(s1.crosses, s2.crosses);
  assert.ok(s1.crosses.length >= 1);
  // 下载地址带参数与页码
  assert.match(p1.svgUrl, /\/print\/page\?paperWidth=210&paperHeight=297&margin=10&overlap=15&page=1/);
});

test('非法参数全部明确拒绝（不输出部分页面）', async () => {
  const url = `/api/designs/${designId}/publications/1/print/preview`;
  const cases = [
    { body: { ...GOOD, paperWidth: 0 }, code: 'invalid' },
    { body: { ...GOOD, paperHeight: -5 }, code: 'invalid' },
    { body: { ...GOOD, margin: -1 }, code: 'invalid' },
    { body: { ...GOOD, overlap: 0 }, code: 'invalid' },
    { body: { ...GOOD, paperWidth: 20.5 }, code: 'invalid' },
    { body: { paperWidth: 20, paperHeight: 20, margin: 10, overlap: 1 }, code: 'printable_not_positive' },
    { body: { paperWidth: 30, paperHeight: 100, margin: 5, overlap: 20 }, code: 'overlap_too_large' },
    { body: { paperWidth: 210, paperHeight: 297 }, code: 'invalid' },
  ];
  for (const c of cases) {
    const r = await req('POST', url, c.body);
    assert.strictEqual(r.status, 400, `body=${JSON.stringify(c.body)}`);
    assert.strictEqual(r.data.ok, false);
    assert.strictEqual(r.data.code, c.code);
    assert.ok(!r.data.pages, '拒绝时不输出部分页面');
  }
});

test('页数超过 200 整单拒绝（422，含行列数）', async () => {
  const r = await req('POST', `/api/designs/${designId}/publications/1/print/preview`,
    { paperWidth: 12, paperHeight: 12, margin: 1, overlap: 1 });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.data.code, 'too_many_pages');
  assert.strictEqual(r.data.totalPages, r.data.cols * r.data.rows);
  assert.ok(r.data.totalPages > 200);
  assert.ok(!r.data.pages);
});

test('版本不存在 → 404；版本号非正 → 400；图纸不存在 → 404', async () => {
  const r = await req('POST', `/api/designs/${designId}/publications/99/print/preview`, GOOD);
  assert.strictEqual(r.status, 404);
  assert.match(r.data.error, /v99/);
  assert.strictEqual((await req('POST', `/api/designs/${designId}/publications/0/print/preview`, GOOD)).status, 400);
  assert.strictEqual((await req('POST', '/api/designs/9999/publications/1/print/preview', GOOD)).status, 404);
});

test('逐页 SVG：image/svg+xml、物理尺寸 mm、裁剪与标尺', async () => {
  const qs = 'paperWidth=210&paperHeight=297&margin=10&overlap=15';
  const r1 = await req('GET', `/api/designs/${designId}/publications/1/print/page?${qs}&page=1`, null, true);
  assert.strictEqual(r1.status, 200);
  assert.match(r1.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(r1.text, /^<\?xml/);
  assert.match(r1.text, /width="210mm" height="297mm"/);
  assert.match(r1.text, /clipPath/);
  assert.match(r1.text, /毫米校准标尺/);
  assert.match(r1.text, /第 1\/2 页/);
  assert.match(r1.text, /与第 2 页拼接/);
  // 快照中的两片编号与颜色
  assert.match(r1.text, /#1/);
  assert.match(r1.text, /#ff0000/);
  // 第二页
  const r2 = await req('GET', `/api/designs/${designId}/publications/1/print/page?${qs}&page=2`, null, true);
  assert.strictEqual(r2.status, 200);
  assert.match(r2.text, /第 2\/2 页/);
  assert.match(r2.text, /x 175–250/);
});

test('SVG 下载参数同样严格校验；页码越界 400', async () => {
  const base = `/api/designs/${designId}/publications/1/print/page`;
  assert.strictEqual((await req('GET', `${base}?paperWidth=0&paperHeight=297&margin=10&overlap=15&page=1`)).status, 400);
  assert.strictEqual((await req('GET', `${base}?paperWidth=20&paperHeight=20&margin=10&overlap=1&page=1`)).status, 400);
  assert.strictEqual((await req('GET', `${base}?paperWidth=30&paperHeight=100&margin=5&overlap=20&page=1`)).status, 400);
  const qs = 'paperWidth=210&paperHeight=297&margin=10&overlap=15';
  assert.strictEqual((await req('GET', `${base}?${qs}&page=3`)).status, 400);
  assert.strictEqual((await req('GET', `${base}?${qs}&page=0`)).status, 400);
  assert.strictEqual((await req('GET', `${base}?${qs}&page=x`)).status, 400);
  // 参数不同（仍是合法分页）时页码上限随之变化
  assert.strictEqual((await req('GET',
    `/api/designs/${designId}/publications/1/print/page?paperWidth=300&paperHeight=300&margin=10&overlap=15&page=2`)).status, 400);
});

test('只读：预览与下载不改变草稿/发布版/计划/库存', async () => {
  const beforeDraft = (await req('GET', `/api/designs/${designId}`)).data.draft;
  const beforePubs = (await req('GET', `/api/designs/${designId}/publications`)).data.publications;
  const beforePlans = (await req('GET', '/api/plans')).data.plans.length;
  const beforeMats = (await req('GET', '/api/materials')).data.materials;

  await req('POST', `/api/designs/${designId}/publications/1/print/preview`, GOOD);
  const qs = 'paperWidth=210&paperHeight=297&margin=10&overlap=15';
  await req('GET', `/api/designs/${designId}/publications/1/print/page?${qs}&page=1`, null, true);
  await req('GET', `/api/designs/${designId}/publications/1/print/page?${qs}&page=2`, null, true);

  const afterDraft = (await req('GET', `/api/designs/${designId}`)).data.draft;
  const afterPubs = (await req('GET', `/api/designs/${designId}/publications`)).data.publications;
  assert.strictEqual(afterDraft.pieces.length, beforeDraft.pieces.length);
  assert.strictEqual(afterDraft.updatedAt, beforeDraft.updatedAt, '草稿 updatedAt 不变');
  assert.deepStrictEqual(afterPubs.map((p) => p.id), beforePubs.map((p) => p.id));
  assert.strictEqual((await req('GET', '/api/plans')).data.plans.length, beforePlans);
  const afterMats = (await req('GET', '/api/materials')).data.materials;
  assert.deepStrictEqual(
    afterMats.map((m) => [m.id, m.stock, m.reserved, m.available]),
    beforeMats.map((m) => [m.id, m.stock, m.reserved, m.available]));
});

test('二维拼接：上下行页码与重叠带坐标一致', async () => {
  // 可打印 120×80（纸 140×100，留白 10），重叠 20 → 步距 100/60；
  // 250×180 → 3 列 ×3 行 = 9 页
  const body = { paperWidth: 140, paperHeight: 100, margin: 10, overlap: 20 };
  const r = await req('POST', `/api/designs/${designId}/publications/1/print/preview`, body);
  assert.deepStrictEqual([r.data.preview.print.cols, r.data.preview.print.rows], [3, 3]);
  const pages = Object.fromEntries(r.data.preview.print.pages.map((p) => [p.page, p]));
  // 第 5 页（中列中行）与第 2 页（正下方）纵向重叠
  const bottom = pages[5].seams.find((s) => s.edge === 'bottom');
  assert.strictEqual(bottom.neighborPage, 2);
  const top2 = pages[2].seams.find((s) => s.edge === 'top');
  assert.strictEqual(top2.neighborPage, 5);
  assert.deepStrictEqual(bottom.overlap, top2.overlap);
  assert.deepStrictEqual(bottom.crosses, top2.crosses);
  assert.ok(bottom.overlap.height >= 20);
  // 每张纸物理尺寸仍为输入纸张
  const pg = await req('GET',
    `/api/designs/${designId}/publications/1/print/page?paperWidth=140&paperHeight=100&margin=10&overlap=20&page=5`,
    null, true);
  assert.match(pg.text, /width="140mm" height="100mm"/);
});
