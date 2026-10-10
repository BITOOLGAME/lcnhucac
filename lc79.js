// VERTEX PREMIUM V15 — Adaptive Tài/Xỉu bias correction + 40-character analyzer + web UI
// Requires Node.js 18+. Run: npm start
// Uses only Node built-ins; state is saved to vertex_state_v9.json beside this file.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = 10_000;
const STATE_FILE = path.join(__dirname, "vertex_state_v9.json");
const MAX_HISTORY = 500;
let state = loadState();
let lastApiError = null;
let busy = false;

function defaultState() {
  return { pending: {}, evaluated: [], wins: 0, losses: 0, lastSession: null, lastUpdate: null };
}
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const s = { ...defaultState(), ...parsed };
    s.pending ||= {};
    s.evaluated ||= [];
    s.wins = Number(s.wins) || 0;
    s.losses = Number(s.losses) || 0;
    return s;
  } catch { return defaultState(); }
}
function saveState() {
  const tmp = STATE_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error("[STATE SAVE ERROR]", e.message); }
}
function cleanResult(value, dices) {
  const v = String(value ?? "").trim().toUpperCase();
  if (["TAI", "TÀI", "BIG", "大"].includes(v)) return { label: "Tài", bit: 1 };
  if (["XIU", "XỈU", "SMALL", "小"].includes(v)) return { label: "Xỉu", bit: 0 };
  const sum = Array.isArray(dices) ? dices.reduce((a, x) => a + Number(x || 0), 0) : NaN;
  if (Number.isFinite(sum)) return { label: sum >= 11 ? "Tài" : "Xỉu", bit: sum >= 11 ? 1 : 0 };
  return null;
}
function normalize(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.list || payload?.data || payload?.sessions || []);
  const unique = new Map();
  for (const x of raw) {
    const sid = Number(x.id ?? x.sid ?? x.phien ?? x.sessionId);
    if (!Number.isFinite(sid)) continue;
    const dice = Array.isArray(x.dices) ? x.dices.map(Number) :
      [x.d1, x.d2, x.d3].every(v => v !== undefined) ? [Number(x.d1), Number(x.d2), Number(x.d3)] :
      Array.isArray(x.xuc_xac) ? x.xuc_xac.map(Number) : [];
    const rawResult = x.resultTruyenThong ?? x.ket_qua ?? x.result ?? x.resultText;
    const outcome = cleanResult(rawResult, dice);
    if (!outcome) continue;
    const sum = Number.isFinite(Number(x.point)) ? Number(x.point) :
      Number.isFinite(Number(x.tong)) ? Number(x.tong) :
      dice.length ? dice.reduce((a, b) => a + b, 0) : null;
    unique.set(sid, { sid, dice, sum, result: outcome.label, bit: outcome.bit, raw: rawResult ?? null });
  }
  return [...unique.values()].sort((a, b) => b.sid - a.sid).slice(0, MAX_HISTORY);
}
function bitsOf(history) { return history.slice().reverse().map(x => x.bit); } // oldest -> newest

// Pattern evidence uses only observed outcomes. Each matching historical context votes for the
// actual next outcome; ties abstain. Recent examples get slightly higher weight.
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function smoothedRate(tai, xiu, prior = 0.5, strength = 2) {
  const total = tai + xiu;
  return (tai + prior * strength) / (total + strength);
}
function weightedRate(samples) {
  let tai = 0, xiu = 0, support = 0;
  for (const s of samples) {
    const w = Number(s.weight) || 0;
    if (s.bit === 1) tai += w;
    else if (s.bit === 0) xiu += w;
    support += w;
  }
  return { tai, xiu, support, p: smoothedRate(tai, xiu, 0.5, 2) };
}
function forecastBits(bits) {
  const n = bits.length;
  const neutral = {
    prediction: 0, mode: "CHƯA ĐỦ DỮ LIỆU", patterns: [],
    votes: { 0: 0.5, 1: 0.5 }, confidence: 0.5,
    familySummary: {}, evidenceCount: 0, agreement: 0.5
  };
  if (n < 8) return { ...neutral, prediction: n ? 1 - bits[n - 1] : 0 };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (tai, total, strength = 4) => (tai + strength * 0.5) / (total + strength);
  const weightedStats = (samples, priorStrength = 3) => {
    let tai = 0, xiu = 0;
    for (const s of samples) {
      if (s.bit === 1) tai += s.w;
      else if (s.bit === 0) xiu += s.w;
    }
    const total = tai + xiu;
    return { p: smooth(tai, total, priorStrength), support: total, tai, xiu };
  };
  const families = {};
  const add = (name, p, support, detail) => {
    if (!Number.isFinite(p)) p = 0.5;
    // Evidence reliability shrinks weak/noisy estimates toward 50%; each family gets one vote.
    const rel = clamp(support / (support + 7), 0, 0.82);
    const adjusted = 0.5 + (clamp(p, 0, 1) - 0.5) * rel;
    families[name] = {
      pTai: adjusted, rawPTai: clamp(p, 0, 1),
      support: Number(support.toFixed(2)), reliability: Number(rel.toFixed(3)),
      detail
    };
  };
  const decayedSamples = (samples, decay = 24) =>
    samples.map(s => ({ bit: s.bit, w: Math.exp(-Math.max(0, s.age) / decay) * (s.base || 1) }));

  // 1. Variable-length suffix matching: patterns from length 2 to 16.
  const suffixModels = [];
  for (let len = 2; len <= Math.min(16, n - 1); len++) {
    const context = bits.slice(n - len), matches = [];
    for (let i = 0; i + len < n; i++) {
      let match = true;
      for (let j = 0; j < len; j++) {
        if (bits[i + j] !== context[j]) { match = false; break; }
      }
      if (match) matches.push({ bit: bits[i + len], age: n - (i + len) });
    }
    if (matches.length) {
      const stats = weightedStats(decayedSamples(matches, 20), 3);
      suffixModels.push({ len, ...stats });
    }
  }
  suffixModels.sort((a, b) => (b.len * Math.log1p(b.support)) - (a.len * Math.log1p(a.support)));
  const suffixTop = suffixModels.slice(0, 5);
  if (suffixTop.length) {
    const weights = suffixTop.map(m => Math.min(2.5, Math.sqrt(m.support)) * (0.65 + m.len / 18));
    const den = weights.reduce((a, b) => a + b, 0);
    add("suffix", suffixTop.reduce((s, m, i) => s + m.p * weights[i], 0) / den,
      suffixTop.reduce((s, m) => s + m.support, 0), `Mẫu hậu tố ${suffixTop.map(x => x.len).join("/")}`);
  } else add("suffix", 0.5, 0, "Chưa có mẫu khớp");

  // 2. Markov transitions: combine orders 1–6 into one family vote.
  const markovModels = [];
  for (let order = 1; order <= Math.min(6, n - 1); order++) {
    const ctx = bits.slice(n - order), matches = [];
    for (let i = 0; i + order < n; i++) {
      if (ctx.every((v, j) => bits[i + j] === v)) {
        matches.push({ bit: bits[i + order], age: n - (i + order) });
      }
    }
    if (matches.length) markovModels.push({ order, ...weightedStats(decayedSamples(matches, 28), 3) });
  }
  if (markovModels.length) {
    const ws = markovModels.map(m => Math.min(2.5, Math.sqrt(m.support)) * (0.8 + m.order / 12));
    const den = ws.reduce((a, b) => a + b, 0);
    add("markov", markovModels.reduce((s, m, i) => s + m.p * ws[i], 0) / den,
      markovModels.reduce((s, m) => s + m.support, 0), `Bậc ${markovModels.map(x => x.order).join("/")}`);
  } else add("markov", 0.5, 0, "Thiếu mẫu chuyển tiếp");

  // 3. Run-length / streak continuation versus reversal.
  let run = 1;
  for (let i = n - 2; i >= 0 && bits[i] === bits[n - 1]; i--) run++;
  const runMatches = [];
  for (let i = 0; i < n - 1; i++) {
    let r = 1;
    for (let j = i; j > 0 && bits[j - 1] === bits[j]; j--) r++;
    if (r === run && i + 1 < n) runMatches.push({ bit: bits[i + 1], age: n - (i + 1) });
  }
  const runStats = weightedStats(decayedSamples(runMatches, 24), 4);
  add("streak", runStats.p, runStats.support, `Bệt hiện tại ${run}`);

  // 4. Alternation length: examine historical transitions after similar alternating runs.
  let alt = 1;
  for (let i = n - 1; i > 0 && bits[i] !== bits[i - 1]; i--) alt++;
  const altMatches = [];
  for (let i = 1; i < n - 1; i++) {
    let k = 1;
    for (let j = i; j > 0 && bits[j] !== bits[j - 1]; j--) k++;
    if (k === alt && bits[i] !== bits[i - 1]) altMatches.push({ bit: bits[i + 1], age: n - (i + 1) });
  }
  const altStats = weightedStats(decayedSamples(altMatches, 25), 4);
  add("alternation", altStats.p, altStats.support, `Luân phiên ${alt}`);

  // 5. Cycle analysis across periods 2–12. All periods make one family vote.
  const cycleSamples = [];
  for (let period = 2; period <= Math.min(12, Math.floor(n / 2)); period++) {
    const target = (n - 1) % period;
    for (let i = 0; i < n - 1; i++) {
      if (i % period === target) {
        cycleSamples.push({ bit: bits[i + 1], age: n - (i + 1), base: 1 / Math.sqrt(period) });
      }
    }
  }
  const cycleStats = weightedStats(decayedSamples(cycleSamples, 30), 5);
  add("cycle", cycleStats.p, cycleStats.support, "Chu kỳ 2–12");

  // 6. Short motif mining: repeated 2–8 symbol motifs followed by the observed next bit.
  const motifSamples = [];
  for (let len = 2; len <= Math.min(8, n - 1); len++) {
    const motif = bits.slice(n - len);
    for (let i = 0; i + len < n; i++) {
      if (motif.every((v, j) => bits[i + j] === v)) {
        motifSamples.push({ bit: bits[i + len], age: n - (i + len), base: 1 / Math.sqrt(len) });
      }
    }
  }
  const motifStats = weightedStats(decayedSamples(motifSamples, 22), 4);
  add("motif", motifStats.p, motifStats.support, "Motif lặp 2–8");

  // 7. Frequency baseline: smoothed multi-window rate, with recent windows weighted more.
  const windows = [6, 10, 16, 24, 40].filter(w => n >= w);
  let freqSum = 0, freqDen = 0;
  const freqNotes = [];
  for (const w of windows) {
    const chunk = bits.slice(-w);
    const tai = chunk.filter(x => x === 1).length;
    const p = smooth(tai, chunk.length, 5);
    const weight = w === 6 ? 1.3 : w === 10 ? 1.2 : w === 16 ? 1.0 : w === 24 ? 0.85 : 0.7;
    freqSum += p * weight; freqDen += weight;
    freqNotes.push(`${w}:${Math.round(p * 100)}`);
  }
  add("frequency", freqDen ? freqSum / freqDen : 0.5, Math.min(n, 40), `Cửa sổ ${freqNotes.join(" · ")}`);

  // 8. Recent weighted trend: exponential decay rather than a hard T/X count.
  const trendSamples = bits.map((bit, i) => ({ bit, w: Math.exp(-(n - 1 - i) / 9) }));
  const trendStats = weightedStats(trendSamples.map((s, i) => ({ bit: s.bit, age: n - 1 - i, base: 1 })), 5);
  // Recompute explicitly with a shorter decay for the recent-regime estimate.
  let trendTai = 0, trendTotal = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.exp(-(n - 1 - i) / 9);
    trendTotal += w;
    if (bits[i] === 1) trendTai += w;
  }
  add("trend", smooth(trendTai, trendTotal, 4), trendTotal, "Trọng số giảm dần theo thời gian");

  // 9. Block-to-block transition: compare recent blocks and historical next-block outcomes.
  const blockSamples = [];
  for (const size of [2, 3, 4, 5]) {
    if (n < size * 3) continue;
    const recent = bits.slice(-size);
    for (let i = 0; i + size * 2 <= n; i++) {
      const prev = bits.slice(i, i + size);
      if (prev.every((v, j) => v === recent[j])) {
        const nextStart = i + size;
        const nextBlock = bits.slice(nextStart, nextStart + size);
        if (nextBlock.length === size) {
          const taiRatio = nextBlock.reduce((s, b) => s + b, 0) / size;
          blockSamples.push({ bit: taiRatio >= 0.5 ? 1 : 0, age: n - (nextStart + size), base: 1 / size });
        }
      }
    }
  }
  const blockStats = weightedStats(decayedSamples(blockSamples, 28), 4);
  add("block", blockStats.p, blockStats.support, "So sánh khối 2–5");

  // 10. Entropy/regime stability: only estimates how noisy the recent stream is.
  const recent = bits.slice(-Math.min(16, n));
  const recentTai = recent.filter(x => x === 1).length;
  const p = recentTai / recent.length;
  const entropy = (p === 0 || p === 1) ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  const stability = 1 - entropy;
  const stabilityP = smooth(recentTai, recent.length, 5);
  add("regime", stabilityP, recent.length * (0.5 + stability), `Độ ổn định ${(stability * 100).toFixed(0)}%`);

  // Aggregate each family exactly once; family scores are not independent probabilities.
  const rows = Object.values(families);
  const pTai = rows.reduce((s, x) => s + x.pTai, 0) / rows.length;
  const pXiu = 1 - pTai;
  const active = rows.filter(x => x.support >= 1.5);
  const agreeTai = active.filter(x => x.pTai > 0.5).length;
  const agreeXiu = active.filter(x => x.pTai < 0.5).length;
  const agreement = active.length ? Math.max(agreeTai, agreeXiu) / active.length : 0.5;
  const directionalStrength = Math.abs(pTai - 0.5) * 2;
  const prediction = Math.abs(pTai - 0.5) < 0.008
    ? (pTai >= 0.5 ? 1 : 0)
    : (pTai > 0.5 ? 1 : 0);

  // Internal model score; later combined with rolling backtest. It is not guaranteed win probability.
  const evidenceRatio = active.length / rows.length;
  const confidence = clamp(
    0.50 + 0.24 * directionalStrength * (0.45 + 0.55 * agreement) * (0.55 + 0.45 * evidenceRatio),
    0.50, 0.8999
  );
  const mode = active.length < 4
    ? "DỮ LIỆU CÒN MỎNG"
    : agreement >= 0.75 && directionalStrength >= 0.12
      ? "NHIỀU NHÓM ĐỒNG THUẬN"
      : agreement < 0.60
        ? "TÍN HIỆU MÂU THUẪN"
        : "TÍN HIỆU TRUNG BÌNH";

  return {
    prediction, mode, run, runLength: run, patterns: [],
    votes: { 0: pXiu, 1: pTai }, familySummary: families,
    voteDifference: Math.abs(pTai - pXiu),
    agreement, evidenceRatio, evidenceCount: active.length,
    directionalStrength, confidence,
    confidenceLabel: `${(confidence * 100).toFixed(2)}%`,
    analysis: {
      families: rows.length, activeFamilies: active.length,
      agreeTai, agreeXiu, entropy: Number(entropy.toFixed(3)),
      sampleSize: n, recentBalance: { tai: recentTai, xiu: recent.length - recentTai }
    }
  };
}
function forecast(history) {
  // Model input is strictly limited to the latest 40 T/X results.
  const bits = bitsOf(history).slice(-40);
  const result = forecastBits(bits);
  let tested = 0, correct = 0, predictedTai = 0, predictedXiu = 0;
  let hitsTai = 0, hitsXiu = 0;
  const minTrain = 8;
  for (let i = minTrain; i < bits.length; i++) {
    const train = bits.slice(Math.max(0, i - 40), i);
    const f = forecastBits(train);
    const actual = bits[i];
    tested++;
    if (f.prediction === actual) correct++;
    if (f.prediction === 1) {
      predictedTai++;
      if (actual === 1) hitsTai++;
    } else {
      predictedXiu++;
      if (actual === 0) hitsXiu++;
    }
  }
  const accuracy = tested ? correct / tested : null;
  const baseline = 0.5;
  const backtestReliability = Math.min(1, tested / 20);
  const empiricalLift = accuracy === null ? 0 : (accuracy - baseline);
  const rawModelScore = Number(result.confidence) || 0.5;
  // Blend signal strength with walk-forward performance, but keep the UI range requested.
  const calibrated = 0.50
    + (rawModelScore - 0.50) * 0.72
    + empiricalLift * 0.35 * backtestReliability;
  result.confidence = clamp(calibrated, 0.50, 0.8999);
  result.confidenceLabel = `${(result.confidence * 100).toFixed(2)}%`;
  result.backtest = {
    tested, correct,
    accuracy: tested >= 10 ? Number(accuracy.toFixed(4)) : null,
    predictedTai, predictedXiu, hitsTai, hitsXiu,
    baseline: 0.5,
    label: tested >= 10 ? "Kiểm thử cuốn chiếu" : "Chưa đủ mẫu kiểm thử"
  };
  result.predictionBalance = {
    samples: tested, predictedTai, predictedXiu,
    taiShare: tested ? Number((predictedTai / tested).toFixed(3)) : null
  };
  return result;
}
function evaluatePending(history) {
  const byId = new Map(history.map(x => [String(x.sid), x]));
  let changed = false;
  for (const [sid, p] of Object.entries(state.pending)) {
    const actual = byId.get(String(sid));
    if (!actual) continue;
    const win = p.bit === actual.bit;
    state.wins += win ? 1 : 0;
    state.losses += win ? 0 : 1;
    state.evaluated.unshift({
      sid: Number(sid), prediction: p.prediction, actual: actual.result,
      status: win ? "THẮNG" : "THUA", predictedAt: p.createdAt || null,
      dice: actual.dice, sum: actual.sum
    });
    delete state.pending[sid];
    changed = true;
  }
  state.evaluated = state.evaluated.slice(0, 100);
  if (changed) saveState();
}
function makeSnapshot() {
  return {
    success: true, source: "VERTEX PREMIUM V15 · Adaptive Balanced Analyzer",
    updatedAt: state.lastUpdate, error: lastApiError,
    latest: state.latest || null, prediction: state.prediction || null,
    stats: { wins: state.wins, losses: state.losses },
    evaluated: state.evaluated.slice(0, 50)
  };
}
// Recent prediction distribution is used only to detect model-side imbalance, not as outcome evidence.
function recentForecastBits(limit = 20) {
  const rows = [];
  for (const [sid, p] of Object.entries(state.pending || {})) {
    const bit = Number(p.bit);
    if (Number.isFinite(Number(sid)) && (bit === 0 || bit === 1)) rows.push({ sid: Number(sid), bit });
  }
  for (const row of (state.evaluated || [])) {
    const bit = row.prediction === "Tài" ? 1 : row.prediction === "Xỉu" ? 0 : null;
    if (Number.isFinite(Number(row.sid)) && bit !== null) rows.push({ sid: Number(row.sid), bit });
  }
  const unique = new Map();
  for (const row of rows) if (!unique.has(row.sid) || row.sid > unique.get(row.sid).sid) unique.set(row.sid, row);
  return [...unique.values()].sort((a, b) => b.sid - a.sid).slice(0, limit).map(x => x.bit);
}
function correctPredictionBias(f, previousBits) {
  // Distribution balance is diagnostic only. Never flip a forecast merely to force equal counts.
  const result = { ...f, rawPrediction: f.prediction, biasAdjusted: false };
  if (previousBits.length) {
    const taiCount=previousBits.filter(x=>x===1).length;
    const xiuCount=previousBits.length-taiCount;
    result.predictionBalance={
      samples:previousBits.length,tai:taiCount,xiu:xiuCount,
      taiShare:Number((taiCount/previousBits.length).toFixed(3)),
      xiuShare:Number((xiuCount/previousBits.length).toFixed(3))
    };
  }
  return result;
}

async function pollApi() {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(API_URL, { headers: { "Accept": "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const payload = await res.json();
    const history = normalize(payload);
    if (!history.length) throw new Error("API không có phiên hợp lệ hoặc cấu trúc dữ liệu đã thay đổi.");
    evaluatePending(history);
    const latest = history[0];
    const currentSid = latest.sid + 1;
    let pending = state.pending[String(currentSid)];
    let f;
    if (!pending) {
      f = forecast(history);
      f = correctPredictionBias(f, recentForecastBits(20));
      const prediction = f.prediction === 1 ? "Tài" : "Xỉu";
      pending = {
        bit: f.prediction, prediction, createdAt: new Date().toISOString(),
        rawPrediction: f.rawPrediction === 1 ? "Tài" : f.rawPrediction === 0 ? "Xỉu" : null,
        biasAdjusted: Boolean(f.biasAdjusted), predictionBalance: f.predictionBalance || null,
        mode: f.mode, runLength: f.runLength || f.run || 1,
        confidenceLabel: f.confidenceLabel, backtest: f.backtest,
        followCount: f.patterns.filter(p => p.bit === latest.bit).length,
        breakCount: f.patterns.filter(p => p.bit !== latest.bit).length,
        votes: { tai: (100 * Number(f.votes?.[1] || 0)).toFixed(1) + "%", xiu: (100 * Number(f.votes?.[0] || 0)).toFixed(1) + "%" }
      };
      state.pending[String(currentSid)] = pending;
    }
    // Freeze each session's first forecast: displayed prediction and win/loss evaluation now match.
    state.latest = {
      phien_truoc: latest.sid, xuc_xac: latest.dice, tong: latest.sum, ket_qua: latest.result,
      phien_hien_tai: currentSid,
    };
    state.prediction = {
      du_doan: pending.prediction, dang_cau: pending.mode || "ĐÃ KHÓA DỰ ĐOÁN",
      do_dai_cau: pending.runLength || 1,
      tin_cay: pending.confidenceLabel || "Chưa đủ mẫu",
      backtest: pending.backtest || null,
      mau_theo_cau: pending.followCount ?? 0,
      mau_be_cau: pending.breakCount ?? 0,
      votes: pending.votes || { tai: "0.00", xiu: "0.00" },
      danh_gia: "CHỜ KẾT QUẢ",
      da_can_bang: Boolean(pending.biasAdjusted),
      du_doan_goc: pending.rawPrediction || pending.prediction,
      can_bang_ty_le: pending.predictionBalance || null
    };
    state.lastSession = latest.sid;
    state.lastUpdate = new Date().toISOString();
    lastApiError = null;
    // Keep only a few pending predictions in case the API skips an ID.
    const keys = Object.keys(state.pending).sort((a,b) => Number(a)-Number(b));
    for (const old of keys.slice(0, Math.max(0, keys.length - 20))) delete state.pending[old];
    saveState();
  } catch (e) {
    lastApiError = e?.message || String(e);
    console.error("[API ERROR]", lastApiError);
  } finally { busy = false; }
}

const HTML = String.raw`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VERTEX PREMIUM · Analyzer V14</title>
<style>
:root{color-scheme:dark;--bg:#07111b;--panel:#0e1b29;--line:#20354a;--muted:#91a4b8;--text:#eaf2f9;--green:#3ce6a0;--red:#ff6178;--gold:#ffc86b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 10% -10%,#10334a 0%,transparent 60%),var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1180px;margin:auto;padding:22px 16px 40px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border:1px solid #2c9c83;border-radius:14px;display:grid;place-items:center;color:var(--green);font-weight:900;box-shadow:0 0 24px #1ce5a01a}.brand h1{font-size:17px;letter-spacing:1.2px;margin:0}.brand p{color:var(--muted);font-size:12px;margin:3px 0 0}.pill{border:1px solid var(--line);padding:7px 10px;border-radius:999px;color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.card{background:linear-gradient(150deg,#102031,#0b1723);border:1px solid var(--line);border-radius:17px;padding:17px;min-width:0;box-shadow:0 14px 35px #0002}.card h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#a9bfd1;margin:0 0 14px}.hero{display:flex;align-items:center;justify-content:space-between;gap:18px}.label{color:var(--muted);font-size:12px}.prediction{font-size:36px;font-weight:850;letter-spacing:.3px;margin:4px 0}.prediction.tai{color:var(--green)}.prediction.xiu{color:var(--red)}.mode{display:inline-block;border-radius:8px;padding:5px 8px;font-size:11px;font-weight:750;background:#152c3c;color:#d4e7f5}.confidence{min-width:116px;text-align:right}.confidence strong{display:block;font-size:21px;color:var(--gold)}.confidence small{color:var(--muted);font-size:11px}.dice{display:flex;gap:7px;margin-top:13px}.die{width:34px;height:34px;border-radius:9px;background:#edf5fa;color:#102033;display:grid;place-items:center;font-weight:850}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:16px}.metric{border:1px solid var(--line);border-radius:11px;padding:10px}.metric span{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:17px;margin-top:4px;overflow-wrap:anywhere}.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stat{padding:15px;border-radius:13px;background:#091522;border:1px solid var(--line)}.stat .n{font-size:30px;font-weight:850}.win{color:var(--green)}.loss{color:var(--red)}.stat small{display:block;color:var(--muted)}.bar{height:7px;background:#23364a;border-radius:99px;overflow:hidden;margin-top:12px}.bar span{height:100%;display:block;background:linear-gradient(90deg,var(--green),#65e0ff);width:0}.wide{margin-top:14px}.pattern{font-family:ui-monospace,Consolas,monospace;letter-spacing:3px;font-size:18px;word-break:break-all;color:#c8d8e7}.legend{display:flex;gap:13px;font-size:11px;color:var(--muted);margin-top:9px}.legend b{color:var(--green)}.legend i{color:var(--red);font-style:normal}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{text-align:left;padding:10px 9px;border-bottom:1px solid #1b2d3e;font-size:12px}th{color:var(--muted);font-weight:650}td{color:#dce7ef}.badge{display:inline-block;padding:4px 7px;border-radius:6px;font-weight:800;font-size:10px}.badge.win{background:#0d382d}.badge.loss{background:#401b28}.badge.wait{background:#2d2b1d;color:var(--gold)}.patterns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pat{border:1px solid var(--line);border-radius:10px;padding:10px}.pat strong{font-size:12px;display:block}.pat small{color:var(--muted);display:block;margin-top:4px}.pat em{font-size:12px;font-style:normal;font-weight:800}.taiText{color:var(--green)}.xiuText{color:var(--red)}.error{color:var(--red);font-size:12px;margin-top:8px}.foot{color:#71869a;text-align:center;font-size:11px;margin-top:18px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{align-items:flex-start}.prediction{font-size:32px}.confidence{min-width:92px}.patterns{grid-template-columns:1fr}.head{align-items:flex-start}.pill{max-width:135px;text-align:center}}
</style></head><body><div class="wrap">
<header class="head"><div class="brand"><div class="logo">V</div><div><h1>VERTEX PREMIUM</h1><p>5 NHÓM PHÂN TÍCH · TRỌNG SỐ CÂN BẰNG</p></div></div><div class="pill" id="status">Đang kết nối API…</div></header>
<div class="grid">
<section class="card"><h2>Dự đoán phiên tiếp theo</h2><div class="hero"><div><div class="label">PHIÊN <span id="currentSid">—</span></div><div id="pred" class="prediction">—</div><span class="mode" id="mode">Đang phân tích</span></div><div class="confidence"><strong id="confidence">—</strong><small>Điểm mô hình · không bảo đảm tương lai</small></div></div>
<div class="label" style="margin-top:17px">Kết quả phiên gần nhất · <span id="lastSid">—</span></div><div class="dice" id="dice"></div>
<div class="metrics"><div class="metric"><span>Tổng điểm</span><strong id="sum">—</strong></div><div class="metric"><span>Kết quả thật</span><strong id="actual">—</strong></div><div class="metric"><span>Độ dài cầu</span><strong id="run">—</strong></div><div class="metric"><span>Đánh giá</span><strong id="evaluation">CHỜ</strong></div></div>
<div id="error" class="error"></div></section>
<section class="card"><h2>Thống kê thắng / thua</h2><div class="stats"><div class="stat"><div class="n win" id="wins">0</div><small>THẮNG</small></div><div class="stat"><div class="n loss" id="losses">0</div><small>THUA</small></div></div><div class="bar"><span id="winbar"></span></div><p class="label" style="margin:10px 0 0">Chỉ tính dự đoán đã có kết quả thật. Dữ liệu lưu trên máy chủ.</p><div class="metrics"><div class="metric"><span>Mẫu theo cầu</span><strong id="follow">0</strong></div><div class="metric"><span>Mẫu bẻ cầu</span><strong id="break">0</strong></div><div class="metric"><span>Phiếu Tài</span><strong id="vTai">0</strong></div><div class="metric"><span>Phiếu Xỉu</span><strong id="vXiu">0</strong></div></div></section></div>

<section class="card wide"><h2>Lịch sử đánh giá thắng / thua</h2><div class="scroll"><table><thead><tr><th>Phiên</th><th>Dự đoán</th><th>Kết quả thật</th><th>Tổng điểm</th><th>Đánh giá</th></tr></thead><tbody id="history"><tr><td colspan="5">Chưa có dữ liệu đánh giá.</td></tr></tbody></table></div></section>
<div class="foot">Tự cập nhật 10 giây · 5 nhóm tín hiệu trọng số ngang nhau · tối đa 40 kết quả · Dự đoán mỗi phiên được khóa để chấm đúng · Không đảm bảo thắng.</div></div>
<script>
const $=id=>document.getElementById(id);
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function render(d){
 const l=d.latest,p=d.prediction,s=d.stats||{wins:0,losses:0};
 $("status").textContent=d.error?"Lỗi API":d.updatedAt?"API đang hoạt động":"Đang kết nối";
 $("error").textContent=d.error?("API: "+d.error):"";
 if(l){
  $("currentSid").textContent=l.phien_hien_tai;$("lastSid").textContent=l.phien_truoc;
  $("sum").textContent=l.tong??"—";$("actual").textContent=l.ket_qua??"—";
  $("dice").innerHTML=(l.xuc_xac||[]).map(n=>'<div class="die">'+esc(n)+'</div>').join("")||'<span class="label">Không có dữ liệu xúc xắc</span>';
 }
 if(p){
  $("pred").textContent=p.du_doan||"—";$("pred").className="prediction "+(p.du_doan==="Tài"?"tai":"xiu");
  $("mode").textContent=p.dang_cau||"CHƯA RÕ CẦU";$("confidence").textContent=p.tin_cay||"—";
  $("run").textContent=p.do_dai_cau??"—";$("evaluation").textContent=p.danh_gia||"CHỜ";
  $("follow").textContent=p.mau_theo_cau??0;$("break").textContent=p.mau_be_cau??0;
  $("vTai").textContent=p.votes?.tai??"0";$("vXiu").textContent=p.votes?.xiu??"0";

 }
 const wins=Number(s.wins)||0,losses=Number(s.losses)||0,total=wins+losses;
 $("wins").textContent=wins;$("losses").textContent=losses;$("winbar").style.width=(total?100*wins/total:0)+"%";
 const rows=d.evaluated||[];
 $("history").innerHTML=rows.length?rows.map(x=>'<tr><td>'+esc(x.sid)+'</td><td class="'+(x.prediction==="Tài"?"taiText":"xiuText")+'">'+esc(x.prediction)+'</td><td>'+esc(x.actual)+'</td><td>'+esc(x.sum??"—")+'</td><td><span class="badge '+(["WIN","THẮNG"].includes(x.status)?"win":"loss")+'">'+esc(x.status==="THẮNG"?"WIN":x.status==="THUA"?"LOSS":x.status)+'</span></td></tr>').join(""):'<tr><td colspan="5">Chưa có phiên nào được chấm. Chờ API trả kết quả của phiên dự đoán.</td></tr>';
}
async function refresh(){try{const r=await fetch("/api/state",{cache:"no-store"});render(await r.json());}catch(e){$("status").textContent="Mất kết nối giao diện";}}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "VERTEX PREMIUM V15", updatedAt: state.lastUpdate, apiError: lastApiError })); return;
  }
  if (req.url === "/" || req.url.startsWith("/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(HTML); return;
  }
  if (req.url.startsWith("/api/state")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(makeSnapshot())); return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VERTEX PREMIUM V15 UI: http://localhost:${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(`Health: /health · Ping: /ping · State: /api/state`);
  console.log(`Refresh API every ${POLL_MS/1000}s. Stop with Ctrl+C.`);
  pollApi();
  setInterval(pollApi, POLL_MS);
});
