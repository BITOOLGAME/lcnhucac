// VERTEX PREMIUM V9 — Multi-pattern Tài/Xỉu analyzer + web UI
// Requires Node.js 18+. Run: node vertex_analyzer_v9.js
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
function forecastBits(bits) {
  if (!bits.length) return { prediction: null, mode: "CHƯA ĐỦ DỮ LIỆU", patterns: [], votes: { 0: 0, 1: 0 }, confidence: null };
  const last = bits[bits.length - 1];
  const patterns = [];
  const add = (name, counts, samples, family, detail) => {
    const total = counts[0] + counts[1];
    if (!total || counts[0] === counts[1]) return;
    const bit = counts[1] > counts[0] ? 1 : 0;
    const ratio = Math.max(counts[0], counts[1]) / total;
    const weight = Math.min(4, Math.log2(total + 1)) * (0.5 + ratio / 2);
    patterns.push({ name, bit, samples: total, support: Math.max(...counts), ratio, weight, family, detail });
  };

  // Exact n-gram contexts, lengths 2–12.
  for (let n = 2; n <= Math.min(12, bits.length - 1); n++) {
    const ctx = bits.slice(-n), counts = [0, 0];
    for (let i = 0; i + n < bits.length; i++) {
      let same = true;
      for (let j = 0; j < n; j++) if (bits[i + j] !== ctx[j]) { same = false; break; }
      if (same) counts[bits[i + n]]++;
    }
    add(`N-GRAM ${n}`, counts, counts[0] + counts[1], "ngram", `Mẫu cuối dài ${n}`);
  }
  // Transition/Markov contexts of order 1–4.
  for (let n = 1; n <= Math.min(4, bits.length - 1); n++) {
    const ctx = bits.slice(-n), counts = [0, 0];
    for (let i = 0; i + n < bits.length; i++) {
      if (ctx.every((v, j) => bits[i + j] === v)) counts[bits[i + n]]++;
    }
    add(`MARKOV ${n}`, counts, counts[0] + counts[1], "markov", `Chuyển tiếp bậc ${n}`);
  }
  // Current run length: look at what followed historical runs of the same length and side.
  let run = 1;
  for (let i = bits.length - 2; i >= 0 && bits[i] === last; i--) run++;
  for (const n of [...new Set([Math.max(2, run - 1), run, run + 1])]) {
    if (n >= bits.length) continue;
    const counts = [0, 0];
    for (let i = 0; i + n < bits.length; i++) {
      if (bits.slice(i, i + n).every(v => v === last)) counts[bits[i + n]]++;
    }
    add(`CẦU BỆT ${n}`, counts, counts[0] + counts[1], "bet", `Sau chuỗi cùng mặt dài ${n}`);
  }
  // Alternating suffixes 3–10.
  for (let n = 3; n <= Math.min(10, bits.length - 1); n++) {
    const ctx = bits.slice(-n);
    if (!ctx.every((v, i) => i === 0 || v !== ctx[i - 1])) continue;
    const counts = [0, 0];
    for (let i = 0; i + n < bits.length; i++) {
      const w = bits.slice(i, i + n);
      if (w.every((v, j) => j === 0 || v !== w[j - 1])) counts[bits[i + n]]++;
    }
    add(`LUÂN PHIÊN ${n}`, counts, counts[0] + counts[1], "alternating", `Chuỗi luân phiên dài ${n}`);
  }
  // Common short rhythm patterns that match the very end of history.
  const rhythms = [
    ["NHỊP TTX", [1,1,0]], ["NHỊP XTT", [0,1,1]], ["NHỊP XXT", [0,0,1]], ["NHỊP TXX", [1,0,0]],
    ["NHỊP TTXX", [1,1,0,0]], ["NHỊP XXTT", [0,0,1,1]], ["NHỊP TXTX", [1,0,1,0]],
    ["NHỊP XTXT", [0,1,0,1]], ["NHỊP TXXT", [1,0,0,1]], ["NHỊP XTTX", [0,1,1,0]],
    ["NHỊP TTTX", [1,1,1,0]], ["NHỊP XXXT", [0,0,0,1]], ["NHỊP TXTT", [1,0,1,1]], ["NHỊP XTXX", [0,1,0,0]]
  ];
  for (const [name, rhythm] of rhythms) {
    const n = rhythm.length;
    if (bits.length <= n || !rhythm.every((v, j) => bits[bits.length - n + j] === v)) continue;
    const counts = [0, 0];
    for (let i = 0; i + n < bits.length; i++) {
      if (rhythm.every((v, j) => bits[i + j] === v)) counts[bits[i + n]]++;
    }
    add(name, counts, counts[0] + counts[1], "rhythm", "Nhịp đã khớp ở cuối lịch sử");
  }
  // ONLINE PATTERN LEARNING: learn the next result after historical suffix patterns.
  // Recency weighting lets recent examples matter more, while still requiring repeat samples.
  for (let n = 2; n <= Math.min(15, bits.length - 1); n++) {
    const ctx = bits.slice(-n);
    const weightedCounts = [0, 0];
    let samples = 0;
    for (let i = 0; i + n < bits.length; i++) {
      let same = true;
      for (let j = 0; j < n; j++) {
        if (bits[i + j] !== ctx[j]) { same = false; break; }
      }
      if (!same) continue;
      const age = (bits.length - 1) - (i + n);
      const recencyWeight = Math.exp(-age / 120);
      weightedCounts[bits[i + n]] += recencyWeight;
      samples++;
    }
    // Require at least two historical matches; do not manufacture a direction on a tie.
    if (samples >= 2 && Math.abs(weightedCounts[1] - weightedCounts[0]) > 0.15) {
      const bit = weightedCounts[1] > weightedCounts[0] ? 1 : 0;
      const total = weightedCounts[0] + weightedCounts[1];
      const ratio = Math.max(...weightedCounts) / total;
      const weight = Math.min(3, Math.log2(samples + 1)) * (0.5 + ratio / 2);
      patterns.push({
        name: `HỌC PATTERN ${n}`, bit, samples, support: Math.round(Math.max(...weightedCounts) * 100) / 100,
        ratio, weight, family: "learned", detail: `Học mẫu độ dài ${n} · ${samples} lần khớp · ưu tiên dữ liệu gần`
      });
    }
  }

  // Cycle-position pattern (2–8).
  for (let period = 2; period <= 8; period++) {
    const counts = [0, 0];
    const targetPos = (bits.length - 1) % period;
    for (let i = period; i < bits.length - 1; i++) {
      if (i % period === targetPos) counts[bits[i + 1]]++;
    }
    add(`CHU KỲ ${period}`, counts, counts[0] + counts[1], "cycle", `Chu kỳ ${period}`,);
  }
  // Short-window frequency: use it as a weak pattern vote, not a hard prediction.
  for (const n of [5, 10, 15, 20, 30, 50]) {
    const w = bits.slice(-n);
    if (w.length < 5) continue;
    const counts = [w.filter(v => v === 0).length, w.filter(v => v === 1).length];
    add(`TẦN SUẤT ${n}`, counts, w.length, "frequency", `Tần suất ${w.length} phiên`,);
  }

  const familyCounts = {};
  const familyVotes = {};
  for (const p of patterns) {
    familyCounts[p.family] = (familyCounts[p.family] || 0) + 1;
    if (!familyVotes[p.family]) familyVotes[p.family] = { 0: 0, 1: 0, n: 0 };
    familyVotes[p.family][p.bit] += p.weight;
    familyVotes[p.family].n += 1;
  }
  // Normalize inside each family first, then give each family equal maximum influence.
  // This prevents dozens of overlapping Xiu patterns in one family from overpowering all others.
  const votes = { 0: 0, 1: 0 }, familySummary = {};
  for (const [family, v] of Object.entries(familyVotes)) {
    const total = v[0] + v[1];
    if (!total) continue;
    const pTai = v[1] / total;
    const pXiu = v[0] / total;
    const strength = Math.abs(pTai - pXiu);
    const familyWeight = Math.min(1, 0.35 + strength * 0.65);
    votes[1] += pTai * familyWeight;
    votes[0] += pXiu * familyWeight;
    familySummary[family] = {
      patternCount: v.n,
      taiShare: Number(pTai.toFixed(3)),
      xiuShare: Number(pXiu.toFixed(3)),
      strength: Number(strength.toFixed(3))
    };
  }
  let prediction = null, mode = "CHƯA RÕ CẦU";
  const difference = Math.abs(votes[0] - votes[1]);
  if (Object.keys(familySummary).length >= 2 && difference > 0.035) {
    prediction = votes[1] > votes[0] ? 1 : 0;
    mode = prediction === last ? "THEO CẦU" : "BẺ CẦU";
  }
  return {
    prediction, mode, run, patterns: patterns.sort((a,b) => b.weight-a.weight),
    votes, familyCounts, familySummary, runLength: run,
    voteDifference: difference,
    agreement: votes[0] + votes[1] ? Math.max(votes[0], votes[1]) / (votes[0] + votes[1]) : null
  };
}
function forecast(history) {
  const bits = bitsOf(history);
  const result = forecastBits(bits);
  // Use a simple non-biased fallback if pattern evidence is insufficient.
  if (result.prediction === null) {
    const recent = bits.slice(-20);
    if (recent.length >= 8) {
      const tai = recent.filter(x => x === 1).length;
      const xiu = recent.length - tai;
      result.prediction = tai === xiu ? (bits[bits.length - 1] === 1 ? 0 : 1) : (tai > xiu ? 1 : 0);
      result.mode = "CHƯA RÕ CẦU · DỰ PHÒNG";
    } else {
      result.prediction = bits.length ? 1 - bits[bits.length - 1] : 0;
      result.mode = "CHƯA ĐỦ MẪU";
    }
  }
  // Rolling-origin backtest: predictions at each historical point use only earlier sessions.
  const testStart = Math.max(20, bits.length - 100);
  let tested = 0, correct = 0;
  for (let i = testStart; i < bits.length; i++) {
    const test = forecastBits(bits.slice(0, i));
    if (test.prediction === null) continue;
    tested++;
    if (test.prediction === bits[i]) correct++;
  }
  result.backtest = { tested, correct, accuracy: tested >= 10 ? correct / tested : null };
  result.confidenceLabel = tested >= 10 ? `${(100 * correct / tested).toFixed(1)}%` : "Chưa đủ mẫu";
  result.patterns = result.patterns.slice(0, 30);
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
    success: true, source: "VERTEX PREMIUM V10 · Learned Patterns",
    updatedAt: state.lastUpdate, error: lastApiError,
    latest: state.latest || null, prediction: state.prediction || null,
    stats: { wins: state.wins, losses: state.losses },
    evaluated: state.evaluated.slice(0, 50),
    patternNames: state.prediction?.patterns?.map(p => p.name) || []
  };
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
    const f = forecast(history);
    const currentSid = latest.sid + 1;
    const prediction = f.prediction === 1 ? "Tài" : "Xỉu";
    if (!state.pending[String(currentSid)]) {
      state.pending[String(currentSid)] = { bit: f.prediction, prediction, createdAt: new Date().toISOString() };
    }
    // Store current prediction summary and patterns for UI. A pending prediction is not scored until actual result arrives.
    state.latest = {
      phien_truoc: latest.sid, xuc_xac: latest.dice, tong: latest.sum, ket_qua: latest.result,
      phien_hien_tai: currentSid,
      pattern: history.slice(0, 15).reverse().map(x => x.bit ? "T" : "X").join("").padStart(15, "-"),
    };
    state.prediction = {
      du_doan: prediction, dang_cau: f.mode,
      do_dai_cau: f.runLength || f.run || 1,
      tin_cay: f.confidenceLabel,
      backtest: f.backtest,
      mau_theo_cau: f.patterns.filter(p => p.bit === (latest.bit)).length,
      mau_be_cau: f.patterns.filter(p => p.bit !== (latest.bit)).length,
      votes: { tai: Number(f.votes?.[1] || 0).toFixed(2), xiu: Number(f.votes?.[0] || 0).toFixed(2) },
      patterns: f.patterns,
      familyCounts: f.familyCounts || {},
      familySummary: f.familySummary || {},
      danh_gia: "CHỜ KẾT QUẢ"
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
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VERTEX PREMIUM · Analyzer V10</title>
<style>
:root{color-scheme:dark;--bg:#07111b;--panel:#0e1b29;--line:#20354a;--muted:#91a4b8;--text:#eaf2f9;--green:#3ce6a0;--red:#ff6178;--gold:#ffc86b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 10% -10%,#10334a 0%,transparent 60%),var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1180px;margin:auto;padding:22px 16px 40px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border:1px solid #2c9c83;border-radius:14px;display:grid;place-items:center;color:var(--green);font-weight:900;box-shadow:0 0 24px #1ce5a01a}.brand h1{font-size:17px;letter-spacing:1.2px;margin:0}.brand p{color:var(--muted);font-size:12px;margin:3px 0 0}.pill{border:1px solid var(--line);padding:7px 10px;border-radius:999px;color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.card{background:linear-gradient(150deg,#102031,#0b1723);border:1px solid var(--line);border-radius:17px;padding:17px;min-width:0;box-shadow:0 14px 35px #0002}.card h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#a9bfd1;margin:0 0 14px}.hero{display:flex;align-items:center;justify-content:space-between;gap:18px}.label{color:var(--muted);font-size:12px}.prediction{font-size:36px;font-weight:850;letter-spacing:.3px;margin:4px 0}.prediction.tai{color:var(--green)}.prediction.xiu{color:var(--red)}.mode{display:inline-block;border-radius:8px;padding:5px 8px;font-size:11px;font-weight:750;background:#152c3c;color:#d4e7f5}.confidence{min-width:116px;text-align:right}.confidence strong{display:block;font-size:21px;color:var(--gold)}.confidence small{color:var(--muted);font-size:11px}.dice{display:flex;gap:7px;margin-top:13px}.die{width:34px;height:34px;border-radius:9px;background:#edf5fa;color:#102033;display:grid;place-items:center;font-weight:850}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:16px}.metric{border:1px solid var(--line);border-radius:11px;padding:10px}.metric span{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:17px;margin-top:4px;overflow-wrap:anywhere}.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stat{padding:15px;border-radius:13px;background:#091522;border:1px solid var(--line)}.stat .n{font-size:30px;font-weight:850}.win{color:var(--green)}.loss{color:var(--red)}.stat small{display:block;color:var(--muted)}.bar{height:7px;background:#23364a;border-radius:99px;overflow:hidden;margin-top:12px}.bar span{height:100%;display:block;background:linear-gradient(90deg,var(--green),#65e0ff);width:0}.wide{margin-top:14px}.pattern{font-family:ui-monospace,Consolas,monospace;letter-spacing:3px;font-size:18px;word-break:break-all;color:#c8d8e7}.legend{display:flex;gap:13px;font-size:11px;color:var(--muted);margin-top:9px}.legend b{color:var(--green)}.legend i{color:var(--red);font-style:normal}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:620px}th,td{text-align:left;padding:10px 9px;border-bottom:1px solid #1b2d3e;font-size:12px}th{color:var(--muted);font-weight:650}td{color:#dce7ef}.badge{display:inline-block;padding:4px 7px;border-radius:6px;font-weight:800;font-size:10px}.badge.win{background:#0d382d}.badge.loss{background:#401b28}.badge.wait{background:#2d2b1d;color:var(--gold)}.patterns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pat{border:1px solid var(--line);border-radius:10px;padding:10px}.pat strong{font-size:12px;display:block}.pat small{color:var(--muted);display:block;margin-top:4px}.pat em{font-size:12px;font-style:normal;font-weight:800}.taiText{color:var(--green)}.xiuText{color:var(--red)}.error{color:var(--red);font-size:12px;margin-top:8px}.foot{color:#71869a;text-align:center;font-size:11px;margin-top:18px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{align-items:flex-start}.prediction{font-size:32px}.confidence{min-width:92px}.patterns{grid-template-columns:1fr}.head{align-items:flex-start}.pill{max-width:135px;text-align:center}}
</style></head><body><div class="wrap">
<header class="head"><div class="brand"><div class="logo">V</div><div><h1>VERTEX PREMIUM</h1><p>HỌC PATTERN · CÂN BẰNG NHÓM CẦU</p></div></div><div class="pill" id="status">Đang kết nối API…</div></header>
<div class="grid">
<section class="card"><h2>Dự đoán phiên tiếp theo</h2><div class="hero"><div><div class="label">PHIÊN <span id="currentSid">—</span></div><div id="pred" class="prediction">—</div><span class="mode" id="mode">Đang phân tích</span></div><div class="confidence"><strong id="confidence">—</strong><small>Độ chính xác kiểm thử</small></div></div>
<div class="label" style="margin-top:17px">Kết quả phiên gần nhất · <span id="lastSid">—</span></div><div class="dice" id="dice"></div>
<div class="metrics"><div class="metric"><span>Tổng điểm</span><strong id="sum">—</strong></div><div class="metric"><span>Kết quả thật</span><strong id="actual">—</strong></div><div class="metric"><span>Độ dài cầu</span><strong id="run">—</strong></div><div class="metric"><span>Đánh giá</span><strong id="evaluation">CHỜ</strong></div></div>
<div class="wide"><div class="label">Pattern 15 phiên · Cũ → mới</div><div class="pattern" id="pattern">———————————————</div><div class="legend"><span><b>T = Tài</b></span><span><i>X = Xỉu</i></span><span>— = thiếu dữ liệu</span></div></div><div id="error" class="error"></div></section>
<section class="card"><h2>Thống kê thắng / thua</h2><div class="stats"><div class="stat"><div class="n win" id="wins">0</div><small>THẮNG</small></div><div class="stat"><div class="n loss" id="losses">0</div><small>THUA</small></div></div><div class="bar"><span id="winbar"></span></div><p class="label" style="margin:10px 0 0">Chỉ tính dự đoán đã có kết quả thật. Dữ liệu lưu trên máy chủ.</p><div class="metrics"><div class="metric"><span>Mẫu theo cầu</span><strong id="follow">0</strong></div><div class="metric"><span>Mẫu bẻ cầu</span><strong id="break">0</strong></div><div class="metric"><span>Phiếu Tài</span><strong id="vTai">0</strong></div><div class="metric"><span>Phiếu Xỉu</span><strong id="vXiu">0</strong></div></div></section></div>
<section class="card wide"><h2>Pattern đã học và được dùng trong dự đoán</h2><div class="patterns" id="patterns"><div class="label">Đang tải pattern…</div></div></section>
<section class="card wide"><h2>Lịch sử đánh giá thắng / thua</h2><div class="scroll"><table><thead><tr><th>Phiên</th><th>Dự đoán</th><th>Kết quả thật</th><th>Tổng điểm</th><th>Đánh giá</th></tr></thead><tbody id="history"><tr><td colspan="5">Chưa có dữ liệu đánh giá.</td></tr></tbody></table></div></section>
<div class="foot">Tự cập nhật 10 giây · Pattern học từ lịch sử · Dữ liệu thắng/thua được lưu trong vertex_state_v9.json · Dự đoán không đảm bảo thắng.</div></div>
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
  $("pattern").textContent=l.pattern||"—";
  $("dice").innerHTML=(l.xuc_xac||[]).map(n=>'<div class="die">'+esc(n)+'</div>').join("")||'<span class="label">Không có dữ liệu xúc xắc</span>';
 }
 if(p){
  $("pred").textContent=p.du_doan||"—";$("pred").className="prediction "+(p.du_doan==="Tài"?"tai":"xiu");
  $("mode").textContent=p.dang_cau||"CHƯA RÕ CẦU";$("confidence").textContent=p.tin_cay||"—";
  $("run").textContent=p.do_dai_cau??"—";$("evaluation").textContent=p.danh_gia||"CHỜ";
  $("follow").textContent=p.mau_theo_cau??0;$("break").textContent=p.mau_be_cau??0;
  $("vTai").textContent=p.votes?.tai??"0";$("vXiu").textContent=p.votes?.xiu??"0";
  $("patterns").innerHTML=(p.patterns||[]).slice(0,30).map(x=>'<div class="pat"><strong>'+esc(x.name)+'</strong><small>'+esc(x.detail)+' · '+x.samples+' mẫu</small><em class="'+(x.bit===1?"taiText":"xiuText")+'">'+(x.bit===1?"TÀI":"XỈU")+' · '+(x.ratio*100).toFixed(0)+'% đồng thuận</em></div>').join("")||'<div class="label">Chưa đủ mẫu để hiển thị pattern có ưu thế.</div>';
 }
 const wins=Number(s.wins)||0,losses=Number(s.losses)||0,total=wins+losses;
 $("wins").textContent=wins;$("losses").textContent=losses;$("winbar").style.width=(total?100*wins/total:0)+"%";
 const rows=d.evaluated||[];
 $("history").innerHTML=rows.length?rows.map(x=>'<tr><td>'+esc(x.sid)+'</td><td class="'+(x.prediction==="Tài"?"taiText":"xiuText")+'">'+esc(x.prediction)+'</td><td>'+esc(x.actual)+'</td><td>'+esc(x.sum??"—")+'</td><td><span class="badge '+(x.status==="THẮNG"?"win":"loss")+'">'+esc(x.status)+'</span></td></tr>').join(""):'<tr><td colspan="5">Chưa có phiên nào được chấm. Chờ API trả kết quả của phiên dự đoán.</td></tr>';
}
async function refresh(){try{const r=await fetch("/api/state",{cache:"no-store"});render(await r.json());}catch(e){$("status").textContent="Mất kết nối giao diện";}}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const server = http.createServer((req, res) => {
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
  console.log(`VERTEX PREMIUM V10 UI: http://localhost:${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(`Refresh API every ${POLL_MS/1000}s. Stop with Ctrl+C.`);
  pollApi();
  setInterval(pollApi, POLL_MS);
});
