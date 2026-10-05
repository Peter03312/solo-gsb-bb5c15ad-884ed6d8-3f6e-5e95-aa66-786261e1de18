'use strict';

// 铅条切段排产核心。
// 所有长度一律以 0.01 mm 为最小单位，内部用整数“厘”（hundredths, 1mm = 100）
// 精确运算，避免浮点误差；仅在与 HTTP/JSON 边界互转时换成毫米数字。

const H_PER_MM = 100;

// ---------- 解析与换算 ----------

// 严格解析“至多两位小数的毫米值”。
// opts.positive=true 要求 >0；否则允许 0 且不允许负数。
// 返回 { ok:true, h }（h 为整数厘）或 { ok:false, error }。
function parseLen2(value, { name = '长度', positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `${name}必须是数字（毫米，至多两位小数）` };
  }
  const h = value * H_PER_MM;
  if (Math.abs(h - Math.round(h)) > 1e-6) {
    return { ok: false, error: `${name}精度不得超过 0.01 mm` };
  }
  const hi = Math.round(h);
  if (positive && hi <= 0) return { ok: false, error: `${name}必须为正数` };
  if (!positive && hi < 0) return { ok: false, error: `${name}不得为负数` };
  return { ok: true, h: hi };
}

// 正整数（件数等）
function parsePositiveInt(value, { name = '数值', max = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: `${name}必须是正整数` };
  }
  if (max !== null && value > max) return { ok: false, error: `${name}不得超过 ${max}` };
  return { ok: true, n: value };
}

// 非负整数（库存根数等）
function parseNonNegInt(value, { name = '数值', max = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${name}必须是不小于 0 的整数` };
  }
  if (max !== null && value > max) return { ok: false, error: `${name}不得超过 ${max}` };
  return { ok: true, n: value };
}

const hToMm = (h) => Math.round(h) / H_PER_MM;

// ---------- 从发布快照提取切段原型 ----------

// 只取该版本铅条清单中的“内部公共边”与“四根外框”，按清单顺序
// （内部公共边 #1..#n，然后 上/下/左/右 四根外框）生成每件一份的切段原型。
// 原型长度取自发布快照，全部转为整数厘。
function segmentsFromSnapshot(snapshot) {
  const ll = snapshot && snapshot.leadList;
  if (!ll || !Array.isArray(ll.internal) || !Array.isArray(ll.frameBars)) {
    return { ok: false, error: '发布快照缺少铅条清单' };
  }
  const segments = [];
  let listIndex = 0;
  let bad = null;
  for (const r of ll.internal) {
    const len = parseLen2(Number(r.length), { name: '内部公共边长度', positive: true });
    if (!len.ok) return len;
    const pts = Array.isArray(r.points) ? r.points : [];
    segments.push({
      source: 'internal',
      sourceNo: Number(r.no) || segments.length + 1,
      name: `内部公共边 #${r.no}`,
      from: pts[0] ? pts[0].slice() : null,
      to: pts.length ? pts[pts.length - 1].slice() : null,
      lengthH: len.h,
      listIndex: listIndex++,
    });
  }
  ll.frameBars.forEach((b, i) => {
    const len = parseLen2(Number(b.length), { name: '外框长度', positive: true });
    if (!len.ok) { bad = len; return; }
    segments.push({
      source: 'frame',
      sourceNo: i + 1,
      name: b.name || `外框${i + 1}`,
      from: Array.isArray(b.from) ? b.from.slice() : null,
      to: Array.isArray(b.to) ? b.to.slice() : null,
      lengthH: len.h,
      listIndex: listIndex++,
    });
  });
  if (bad) return bad;
  if (segments.length !== ll.internal.length + 4 || segments.length === 0) {
    return { ok: false, error: '铅条清单不完整（应含内部公共边与四根外框）' };
  }
  return { ok: true, segments };
}

// ---------- 排产：首次适应递减（FFD） ----------

// 入参（全部整数厘 / 正整数）：
//   segments  每件的切段原型（清单顺序）
//   copies    件数（逐件展开，每段都是不可拼接的独立切段）
//   stockLenH 原材定尺
//   kerfH     每刀损耗
// 返回 { ok:true, bars, requiredBars, cuts, totals }
//   或 { ok:false, code:'segment_too_long', segment }（单段连一刀损耗都放不下）
function planCuts({ segments, copies, stockLenH, kerfH }) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, code: 'empty_lead_list', error: '铅条清单为空，无法排产' };
  }
  // 单段占用 = 成品长度 + 一刀损耗；任何一段放不下则整单拒绝（不产生任何方案）
  for (const s of segments) {
    if (s.lengthH + kerfH > stockLenH) {
      return { ok: false, code: 'segment_too_long', error: '存在单段连同刀损超过原材定尺，无法切段', segment: s };
    }
  }

  // 逐件展开：件 1 的全部清单段、件 2 的全部清单段……
  const cuts = [];
  for (let piece = 1; piece <= copies; piece++) {
    for (const s of segments) {
      cuts.push({
        piece,
        source: s.source,
        sourceNo: s.sourceNo,
        name: s.name,
        from: s.from,
        to: s.to,
        listIndex: s.listIndex,
        lengthH: s.lengthH,
      });
    }
  }
  // 长度降序；同长保持清单顺序（Array.prototype.sort 在 Node 中稳定；
  // 展开为“件优先、清单次之”，故同长时清单靠后的段与后续件次都不会插队）。
  cuts.sort((a, b) => b.lengthH - a.lengthH);

  // 依次放入“首根可容纳”的原材；放不下就开一根新原材
  const bars = [];
  let totalFinishedH = 0;
  let totalKerfH = 0;
  for (const cut of cuts) {
    const occupiedH = cut.lengthH + kerfH;
    let bar = bars.find((b) => b.usedH + occupiedH <= stockLenH);
    if (!bar) {
      bar = { index: bars.length + 1, usedH: 0, cuts: [] };
      bars.push(bar);
    }
    bar.cuts.push({ ...cut, kerfH, occupiedH });
    bar.usedH += occupiedH;
    totalFinishedH += cut.lengthH;
    totalKerfH += kerfH;
  }
  for (const b of bars) b.remainderH = stockLenH - b.usedH;

  return {
    ok: true,
    bars,
    requiredBars: bars.length,
    cuts,
    segmentCount: cuts.length,
    totalFinishedH,
    totalKerfH,
    totalRemainderH: bars.reduce((s, b) => s + b.remainderH, 0),
  };
}

module.exports = {
  H_PER_MM,
  parseLen2,
  parsePositiveInt,
  parseNonNegInt,
  hToMm,
  segmentsFromSnapshot,
  planCuts,
};
