// VERTEX PREMIUM V14 — Adaptive Tài/Xỉu bias correction + 40-character analyzer + web UI
// Requires Node.js 18+. Run: node vertex_analyzer_v13.js
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
  const nBits = bits.length;
  if (!nBits) return {
    prediction: 0, mode: "CHƯA ĐỦ DỮ LIỆU", patterns: [],
    votes: { 0: 0.5, 1: 0.5 }, confidence: 0.5, familySummary: {}
  };
  const last = bits[nBits - 1];
  const families = {};
  const addFamily = (name, pTai, evidence = 0, note = "") => {
    if (!Number.isFinite(pTai)) pTai = 0.5;
    // Shrink weak evidence toward neutral; no family gets extra votes for producing many patterns.
    const reliability = clamp(evidence / (evidence + 5), 0, 0.75);
    const adjusted = 0.5 + (clamp(pTai, 0, 1) - 0.5) * reliability;
    families[name] = { pTai: adjusted, rawPTai: clamp(pTai, 0, 1), evidence, reliability, note };
  };

  // FAMILY 1: matching suffix contexts, using the best-supported context at each length.
  const contextSamples = [];
  for (let len = 2; len <= Math.min(12, nBits - 1); len++) {
    const ctx = bits.slice(-len), matches = [];
    for (let i = 0; i + len < nBits; i++) {
      let same = true;
      for (let j = 0; j < len; j++) if (bits[i + j] !== ctx[j]) { same = false; break; }
      if (same) {
        const age = (nBits - 1) - (i + len);
        matches.push({ bit: bits[i + len], weight: Math.exp(-age / 18) });
      }
    }
    if (matches.length) {
      const r = weightedRate(matches);
      contextSamples.push({ p: r.p, evidence: r.support, len });
    }
  }
  if (contextSamples.length) {
    // Long contexts matter, but unsupported exact matches cannot dominate.
    contextSamples.sort((a,b) => b.len - a.len);
    const top = contextSamples.slice(0, 4);
    const totalW = top.reduce((s,x) => s + Math.min(3, Math.sqrt(x.evidence)) * (0.8 + x.len / 15), 0);
    const p = top.reduce((s,x) => s + x.p * Math.min(3, Math.sqrt(x.evidence)) * (0.8 + x.len / 15), 0) / totalW;
    addFamily("suffix", p, top.reduce((s,x)=>s+x.evidence,0), "Mẫu lịch sử khớp hậu tố");
  } else addFamily("suffix", 0.5, 0, "Chưa có mẫu khớp");

  // FAMILY 2: transition/Markov; all orders are merged into one family vote.
  const markov = [];
  for (let len = 1; len <= Math.min(4, nBits - 1); len++) {
    const ctx = bits.slice(-len), matches = [];
    for (let i = 0; i + len < nBits; i++) {
      if (ctx.every((v,j)=>bits[i+j]===v)) {
        const age = (nBits - 1) - (i + len);
        matches.push({ bit: bits[i+len], weight: Math.exp(-age/24) });
      }
    }
    if (matches.length) {
      const r = weightedRate(matches);
      markov.push({ p:r.p, evidence:r.support, len });
    }
  }
  if (markov.length) {
    const den = markov.reduce((s,x)=>s+Math.min(2.5,Math.sqrt(x.evidence))*(1+x.len/8),0);
    const p = markov.reduce((s,x)=>s+x.p*Math.min(2.5,Math.sqrt(x.evidence))*(1+x.len/8),0)/den;
    addFamily("markov", p, markov.reduce((s,x)=>s+x.evidence,0), "Chuyển tiếp bậc 1–4");
  } else addFamily("markov", 0.5, 0, "Chưa đủ chuyển tiếp");

  // FAMILY 3: run length and alternating behavior, using historical contexts of same structure.
  let run = 1;
  for (let i=nBits-2;i>=0 && bits[i]===last;i--) run++;
  const structural = [];
  for (let i=0;i<nBits-1;i++) {
    let r=1;
    for(let j=i;j>0 && bits[j-1]===bits[j];j--) r++;
    if (r===run) {
      const nextIndex=i+1;
      if(nextIndex<nBits) structural.push({bit:bits[nextIndex],weight:Math.exp(-((nBits-1)-nextIndex)/25)});
    }
  }
  const altLen = (() => {
    let k=1;
    for(let i=nBits-1;i>0 && bits[i]!==bits[i-1];i--) k++;
    return k;
  })();
  for (let i=1;i<nBits-1;i++) {
    let k=1;
    for(let j=i;j>0 && bits[j]!==bits[j-1];j--) k++;
    if(k===altLen && bits[i]!==bits[i-1]) {
      structural.push({bit:bits[i+1],weight:Math.exp(-((nBits-1)-(i+1))/25)});
    }
  }
  const sr = weightedRate(structural);
  addFamily("structure", sr.p, sr.support, `Bệt ${run} · luân phiên ${altLen}`);

  // FAMILY 4: repeated short rhythms and cycle positions; one combined vote, not one vote per pattern.
  const periodic = [];
  for (let period=2;period<=8;period++) {
    const target = (nBits-1) % period;
    for(let i=period;i<nBits-1;i++) {
      if(i % period === target) {
        const age=(nBits-1)-(i+1);
        periodic.push({bit:bits[i+1],weight:Math.exp(-age/30)});
      }
    }
  }
  for (let len=3;len<=Math.min(6,nBits-1);len++) {
    const ctx=bits.slice(-len);
    for(let i=0;i+len<nBits;i++) {
      if(ctx.every((v,j)=>bits[i+j]===v)) {
        const age=(nBits-1)-(i+len);
        periodic.push({bit:bits[i+len],weight:0.7*Math.exp(-age/30)});
      }
    }
  }
  const pr=weightedRate(periodic);
  addFamily("rhythm", pr.p, pr.support, "Nhịp ngắn và vị trí chu kỳ");

  // FAMILY 5: recency-aware frequencies; windows are combined into a single baseline estimate.
  const windows=[8,15,25,40].filter(n=>nBits>=Math.min(n,8));
  let freqSum=0, freqWeight=0;
  for(const wlen of windows) {
    const w=bits.slice(-wlen), tai=w.filter(v=>v===1).length, xiu=w.length-tai;
    const p=smoothedRate(tai,xiu,0.5,4);
    const weight = wlen===8 ? 1.2 : wlen===15 ? 1.1 : wlen===25 ? 0.9 : 0.7;
    freqSum+=p*weight;freqWeight+=weight;
  }
  addFamily("frequency",freqWeight?freqSum/freqWeight:0.5,Math.min(nBits,40),"Tần suất cửa sổ 8/15/25/40");

  // Every family contributes exactly once. Families without evidence stay neutral (0.5).
  const familyRows=Object.values(families);
  const pTai=familyRows.reduce((s,x)=>s+x.pTai,0)/familyRows.length;
  const pXiu=1-pTai;
  const margin=Math.abs(pTai-0.5)*2;
  const active=familyRows.filter(x=>x.evidence>=2);
  const agreement=active.length ? Math.max(
    active.filter(x=>x.pTai>=0.5).length,
    active.filter(x=>x.pTai<0.5).length
  )/active.length : 0.5;
  const prediction=pTai>0.5000001?1:pTai<0.4999999?0:1-last;
  const mode=active.length<3?"TÍN HIỆU YẾU · ƯU TIÊN TRUNG LẬP":agreement>=0.7?"CÁC NHÓM TƯƠNG ĐỒNG":"CÁC NHÓM CHƯA ĐỒNG THUẬN";
  return {
    prediction, mode, run, runLength:run, patterns:[],
    votes:{0:pXiu,1:pTai}, familySummary:families,
    voteDifference:Math.abs(pTai-pXiu), agreement,
    confidence:0.5 + Math.min(0.12, margin*0.12) * (0.55+0.45*agreement),
    familyCount:familyRows.length, activeFamilies:active.length
  };
}
function forecast(history) {
  // Strictly restrict each model input to the latest 40 T/X results.
  const bits = bitsOf(history).slice(-40);
  const result = forecastBits(bits);
  const testStart = Math.max(8, bits.length - 20);
  let tested=0, correct=0, correctTai=0, predictedTai=0, actualTai=0;
  for(let i=testStart;i<bits.length;i++) {
    const test=forecastBits(bits.slice(Math.max(0,i-40),i));
    if(test.prediction===null) continue;
    tested++;
    if(test.prediction===bits[i]) correct++;
    if(test.prediction===1) predictedTai++;
    if(bits[i]===1) actualTai++;
    if(test.prediction===1 && bits[i]===1) correctTai++;
  }
  const accuracy=tested?correct/tested:null;
  // Confidence is deliberately capped: small historical samples must not look like certainty.
  const empirical= tested>=10 ? accuracy : 0.5;
  const signal=Number(result.confidence)||0.5;
  const reliability=clamp((tested/20),0,1);
  const confidence=clamp(0.5 + (signal-0.5)*0.55 + (empirical-0.5)*0.25*reliability,0.50,0.65);
  result.confidence=confidence;
  result.backtest={tested,correct,accuracy:tested>=10?accuracy:null,predictedTai,actualTai};
  result.confidenceLabel=`${(confidence*100).toFixed(1)}%`;
  result.predictionBalance={samples:tested,predictedTai,predictedXiu:tested-predictedTai};
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
    success: true, source: "VERTEX PREMIUM V14 · Adaptive Balanced Analyzer",
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
<section class="card"><h2>Dự đoán phiên tiếp theo</h2><div class="hero"><div><div class="label">PHIÊN <span id="currentSid">—</span></div><div id="pred" class="prediction">—</div><span class="mode" id="mode">Đang phân tích</span></div><div class="confidence"><strong id="confidence">—</strong><small>Backtest quá khứ · không đảm bảo tương lai</small></div></div>
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
 $("history").innerHTML=rows.length?rows.map(x=>'<tr><td>'+esc(x.sid)+'</td><td class="'+(x.prediction==="Tài"?"taiText":"xiuText")+'">'+esc(x.prediction)+'</td><td>'+esc(x.actual)+'</td><td>'+esc(x.sum??"—")+'</td><td><span class="badge '+(x.status==="THẮNG"?"win":"loss")+'">'+esc(x.status)+'</span></td></tr>').join(""):'<tr><td colspan="5">Chưa có phiên nào được chấm. Chờ API trả kết quả của phiên dự đoán.</td></tr>';
}
async function refresh(){try{const r=await fetch("/api/state",{cache:"no-store"});render(await r.json());}catch(e){$("status").textContent="Mất kết nối giao diện";}}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "VERTEX PREMIUM V14", updatedAt: state.lastUpdate, apiError: lastApiError })); return;
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
  console.log(`VERTEX PREMIUM V14 UI: http://localhost:${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(`Health: /health · Ping: /ping · State: /api/state`);
  console.log(`Refresh API every ${POLL_MS/1000}s. Stop with Ctrl+C.`);
  pollApi();
  setInterval(pollApi, POLL_MS);
});
