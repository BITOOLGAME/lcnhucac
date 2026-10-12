// VERTEX PREMIUM V18 — 500 Patterns · 200 Models · 100 AI Signals · 50 Markov
// Node.js 18+. No dependencies. Run: node index.js
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = 10_000;
const STATE_FILE = path.join(__dirname, "vertex_state_v17.json");
const MAX_HISTORY = 500;
let state = loadState(), lastApiError = null, busy = false;

function defaultState() {
  return { pending: {}, evaluated: [], wins: 0, losses: 0, lastSession: null, lastUpdate: null };
}
function loadState() {
  try {
    const x = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...defaultState(), ...x, pending: x.pending || {}, evaluated: x.evaluated || [],
      wins: Number(x.wins) || 0, losses: Number(x.losses) || 0 };
  } catch { return defaultState(); }
}
function saveState() {
  const tmp = STATE_FILE + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, STATE_FILE); }
  catch (e) { console.error("[STATE SAVE ERROR]", e.message); }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0.5;
const sigmoid = x => 1 / (1 + Math.exp(-x));

function outcome(value, dice) {
  const v = String(value ?? "").trim().toUpperCase();
  if (["TAI", "TÀI", "BIG", "大"].includes(v)) return { label: "Tài", bit: 1 };
  if (["XIU", "XỈU", "SMALL", "小"].includes(v)) return { label: "Xỉu", bit: 0 };
  if (Array.isArray(dice) && dice.length >= 3 && dice.every(n => Number.isFinite(n))) {
    const sum = dice.reduce((a, b) => a + b, 0);
    return { label: sum >= 11 ? "Tài" : "Xỉu", bit: sum >= 11 ? 1 : 0 };
  }
  return null;
}
function normalize(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.list || payload?.data || payload?.sessions || []);
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  for (const x of raw) {
    const sid = Number(x.id ?? x.sid ?? x.phien ?? x.sessionId);
    if (!Number.isFinite(sid)) continue;
    const dice = Array.isArray(x.dices) ? x.dices.map(Number)
      : [x.d1, x.d2, x.d3].every(v => v !== undefined) ? [Number(x.d1), Number(x.d2), Number(x.d3)]
      : Array.isArray(x.xuc_xac) ? x.xuc_xac.map(Number) : [];
    const o = outcome(x.resultTruyenThong ?? x.ket_qua ?? x.result ?? x.resultText, dice);
    if (!o) continue;
    const sumRaw = x.point ?? x.tong;
    const sum = Number.isFinite(Number(sumRaw)) ? Number(sumRaw)
      : dice.length ? dice.reduce((a, b) => a + b, 0) : null;
    map.set(sid, { sid, dice, sum, result: o.label, bit: o.bit });
  }
  return [...map.values()].sort((a, b) => b.sid - a.sid).slice(0, MAX_HISTORY);
}
const bitsOf = history => history.slice().reverse().map(x => x.bit);
function smoothRate(tai, total, strength = 4) { return (tai + strength * 0.5) / (total + strength); }
function weightedRate(samples, prior = 4) {
  let tai = 0, total = 0;
  for (const s of samples) { const w = s.w ?? 1; total += w; if (s.bit === 1) tai += w; }
  return { p: smoothRate(tai, total, prior), support: total, tai, total };
}
function decay(samples, tau = 24) {
  return samples.map(s => ({ bit: s.bit, w: Math.exp(-Math.max(0, s.age || 0) / tau) * (s.base || 1) }));
}

// Exactly 500 balanced templates: every context length 2–7 (254), plus 123
// complementary pairs of length 8 (246). Templates are evidence, not guarantees.
function buildPatterns() {
  const a = [];
  for (let len = 2; len <= 7; len++) for (let m = 0; m < (1 << len); m++)
    a.push(Array.from({ length: len }, (_, i) => (m >> (len - i - 1)) & 1));
  for (let m = 0; m < 123; m++) {
    const rep = [0, ...Array.from({ length: 7 }, (_, i) => (m >> (6 - i)) & 1)];
    a.push(rep, rep.map(x => 1 - x));
  }
  return a.slice(0, 500).map((bits, i) => ({ id: `P${String(i + 1).padStart(3, "0")}`, bits, len: bits.length }));
}
const PATTERNS = buildPatterns();

function analyze(bits) {
  const n = bits.length;
  const families = {};
  const add = (name, p, support, note) => {
    p = clamp(Number.isFinite(p) ? p : 0.5, 0, 1);
    const reliability = clamp(support / (support + 8), 0, 0.82);
    families[name] = {
      pTai: 0.5 + (p - 0.5) * reliability,
      rawPTai: p, support: Number(support.toFixed(2)),
      reliability: Number(reliability.toFixed(3)), note
    };
  };
  if (n < 4) {
    add("pattern150", .5, 0, "Chưa đủ dữ liệu");
    return finalize(families, bits, 0, "DỮ LIỆU CÒN MỎNG");
  }
  const latest = bits[n - 1];
  // 1. Pattern library: exact historical matches vote for the following result.
  let pSum = 0, wSum = 0, support = 0, matched = 0;
  for (const pat of PATTERNS) {
    const len = pat.len;
    if (len >= n) continue;
    const tail = bits.slice(n - len);
    const dist = tail.reduce((s, b, i) => s + (b !== pat.bits[i] ? 1 : 0), 0);
    if (dist > (len <= 3 ? 1 : Math.floor(len * .34))) continue;
    const samples = [];
    for (let i = 0; i + len < n; i++) {
      if (pat.bits.every((b, j) => bits[i + j] === b))
        samples.push({ bit: bits[i + len], age: n - i - len });
    }
    if (!samples.length) continue;
    const r = weightedRate(decay(samples, 22), 3);
    const w = Math.exp(-dist * .8) * Math.min(2.5, Math.sqrt(r.support)) * (0.7 + len / 10);
    pSum += r.p * w; wSum += w; support += r.support * Math.exp(-dist * .8); matched++;
  }
  add("pattern150", wSum ? pSum / wSum : .5, support, `500 mẫu · khớp ${matched}`);

  // 2. Variable-length suffix contexts.
  const suffix = [];
  for (let len = 2; len <= Math.min(16, n - 1); len++) {
    const ctx = bits.slice(n - len), samples = [];
    for (let i = 0; i + len < n; i++)
      if (ctx.every((b, j) => bits[i + j] === b)) samples.push({ bit: bits[i + len], age: n - i - len });
    if (samples.length) suffix.push({ len, ...weightedRate(decay(samples, 20), 3) });
  }
  suffix.sort((a, b) => b.len * Math.log1p(b.support) - a.len * Math.log1p(a.support));
  const top = suffix.slice(0, 5), sw = top.map(x => Math.min(2.5, Math.sqrt(x.support)) * (.65 + x.len / 18));
  add("suffix", sw.length ? top.reduce((s, x, i) => s + x.p * sw[i], 0) / sw.reduce((a,b)=>a+b,0) : .5,
    top.reduce((s, x) => s + x.support, 0), `Hậu tố ${top.map(x => x.len).join("/") || "chưa khớp"}`);

  // 3. Markov orders 1–50, aggregated as one family. Long orders naturally abstain when unsupported.
  const markov = [];
  for (let order = 1; order <= Math.min(50, n - 1); order++) {
    const ctx = bits.slice(n - order), samples = [];
    for (let i = 0; i + order < n; i++)
      if (ctx.every((b, j) => bits[i + j] === b)) samples.push({ bit: bits[i + order], age: n - i - order });
    if (samples.length) markov.push({ order, ...weightedRate(decay(samples, 28), 3) });
  }
  const mw = markov.map(x => Math.min(2.5, Math.sqrt(x.support)) * (.8 + x.order / 12));
  add("markov", mw.length ? markov.reduce((s, x, i) => s + x.p * mw[i], 0) / mw.reduce((a,b)=>a+b,0) : .5,
    markov.reduce((s, x) => s + x.support, 0), `Bậc ${markov.map(x=>x.order).join("/") || "—"}`);

  // 4. Streak continuation and historical run endings.
  let run = 1;
  for (let i = n - 2; i >= 0 && bits[i] === latest; i--) run++;
  const runs = [];
  for (let i = 0; i < n - 1; i++) {
    let r = 1; for (let j = i; j > 0 && bits[j-1] === bits[j]; j--) r++;
    if (r === run) runs.push({ bit: bits[i + 1], age: n - i - 1 });
  }
  const rr = weightedRate(decay(runs, 24), 4);
  add("streak", rr.p, rr.support, `Bệt hiện tại ${run}`);

  // 5. Alternation lengths.
  let alt = 1;
  for (let i = n - 1; i > 0 && bits[i] !== bits[i - 1]; i--) alt++;
  const alts = [];
  for (let i = 1; i < n - 1; i++) {
    let k = 1; for (let j = i; j > 0 && bits[j] !== bits[j-1]; j--) k++;
    if (k === alt) alts.push({ bit: bits[i + 1], age: n - i - 1 });
  }
  const ar = weightedRate(decay(alts, 25), 4);
  add("alternation", ar.p, ar.support, `Luân phiên ${alt}`);

  // 6. Cycles of periods 2–12.
  const cyc = [];
  for (let period = 2; period <= Math.min(12, Math.floor(n / 2)); period++) {
    const target = (n - 1) % period;
    for (let i = 0; i < n - 1; i++) if (i % period === target)
      cyc.push({ bit: bits[i + 1], age: n - i - 1, base: 1 / Math.sqrt(period) });
  }
  const cr = weightedRate(decay(cyc, 30), 5);
  add("cycle", cr.p, cr.support, "Chu kỳ 2–12");

  // 7. Motifs of length 2–8.
  const motifs = [];
  for (let len = 2; len <= Math.min(8, n - 1); len++) {
    const ctx = bits.slice(n - len);
    for (let i = 0; i + len < n; i++) if (ctx.every((b,j)=>bits[i+j]===b))
      motifs.push({ bit: bits[i+len], age: n-i-len, base: 1/Math.sqrt(len) });
  }
  const mr = weightedRate(decay(motifs, 22), 4);
  add("motif", mr.p, mr.support, "Motif 2–8");

  // 8. Frequency windows.
  const wins = [6, 10, 16, 24, 40, 80, 120, 160, 200].filter(w => n >= w);
  const fp = wins.map(w => {
    const c = bits.slice(-w), tai = c.reduce((s,b)=>s+b,0);
    return { p: smoothRate(tai, c.length, 5), w: ({6:1.3,10:1.2,16:1,24:.85,40:.7,80:.65,120:.6,160:.55,200:.5})[w] };
  });
  add("frequency", fp.length ? fp.reduce((s,x)=>s+x.p*x.w,0)/fp.reduce((s,x)=>s+x.w,0) : .5,
    Math.min(n, 40), `Cửa sổ ${wins.join("/") || "—"}`);

  // 9. Exponentially weighted recent trend.
  let tTai = 0, tTotal = 0;
  bits.forEach((b,i) => { const w = Math.exp(-(n-1-i)/9); tTotal += w; if (b) tTai += w; });
  add("trend", smoothRate(tTai, tTotal, 4), tTotal, "Xu hướng giảm trọng số theo tuổi");

  // 10. Block recurrence (2–5 symbols).
  const blocks = [];
  for (const size of [2,3,4,5]) {
    if (n < size * 3) continue;
    const recent = bits.slice(-size);
    for (let i=0; i + size*2 <= n; i++) {
      if (recent.every((b,j)=>bits[i+j]===b)) {
        const next = bits.slice(i+size, i+size*2);
        blocks.push({ bit: next.reduce((s,b)=>s+b,0) >= Math.ceil(size/2) ? 1 : 0,
          age: n-i-size*2, base: 1/size });
      }
    }
  }
  const br = weightedRate(decay(blocks, 28), 4);
  add("block", br.p, br.support, "Khối lặp 2–5");

  // 11. Recent regime: smoothed proportion with entropy-based support.
  const recent = bits.slice(-Math.min(16,n)), recentTai = recent.reduce((s,b)=>s+b,0);
  const q = recentTai / recent.length;
  const entropy = q === 0 || q === 1 ? 0 : -(q*Math.log2(q)+(1-q)*Math.log2(1-q));
  const stability = 1 - entropy;
  add("regime", smoothRate(recentTai, recent.length, 5), recent.length*(.5+stability), `Ổn định ${(stability*100).toFixed(0)}%`);

  // 12. 200 model variants: 10 lookback windows × 20 decay horizons.
  // Aggregate them as ONE family to avoid artificially inflating the vote count.
  const modelWindows = [8, 12, 16, 20, 24, 32, 40, 60, 80, 100];
  const modelTaus = Array.from({length:20}, (_,i) => 4 + i*4);
  const modelScores = [];
  for (const win of modelWindows) for (const tau of modelTaus) {
    const start = Math.max(0, n - win); let tai = 0, total = 0;
    for (let i = start; i < n; i++) { const w = Math.exp(-(n - 1 - i) / tau); total += w; if (bits[i] === 1) tai += w; }
    modelScores.push({ p: smoothRate(tai, total, 4 + tau/10), support: total });
  }
  add("models200", mean(modelScores.map(x => x.p)), mean(modelScores.map(x => x.support)), "200 cấu hình · 10 cửa sổ × 20 decay");

  // 13. 100 AI analysis probes: one probe for each window size from 5 to 104.
  // They are diagnostic variants, not 100 independent AIs or 100 independent votes.
  const probes = [];
  for (let win = 5; win <= 104; win++) {
    const c = bits.slice(-Math.min(win, n));
    if (!c.length) continue;
    const tai = c.reduce((sum,b)=>sum+b,0), pFreq = smoothRate(tai, c.length, 5);
    let flips = 0; for (let i=1;i<c.length;i++) if(c[i]!==c[i-1]) flips++;
    const flipRate = c.length > 1 ? flips/(c.length-1) : .5;
    probes.push({ p: clamp(.8*pFreq + .2*(flipRate > .6 ? 1-pFreq : pFreq), 0, 1), support:c.length });
  }
  add("ai100", mean(probes.map(x=>x.p)), mean(probes.map(x=>x.support)), "100 tín hiệu · cửa sổ 5–104 phiên");

  // Dice totals are intentionally excluded from walk-forward signal scoring to prevent
  // future-data leakage and false confidence. Dice remain visible in the UI/API snapshot.

  return finalize(families, bits, run, "PHÂN TÍCH ĐA NHÓM");
}
function finalize(families, bits, run, fallbackMode) {
  const rows = Object.values(families);
  const pTai = rows.length ? mean(rows.map(x => x.pTai)) : .5;
  const active = rows.filter(x => x.support >= 1.5);
  const tai = active.filter(x => x.pTai > .5).length, xiu = active.filter(x => x.pTai < .5).length;
  const agreement = active.length ? Math.max(tai,xiu)/active.length : .5;
  const strength = Math.abs(pTai-.5)*2;
  const pred = pTai >= .5 ? 1 : 0;
  const mode = active.length < 4 ? "DỮ LIỆU CÒN MỎNG"
    : agreement >= .75 && strength >= .12 ? "NHIỀU NHÓM ĐỒNG THUẬN"
    : agreement < .60 ? "TÍN HIỆU MÂU THUẪN" : fallbackMode;
  // A model score, not a guaranteed chance of winning. Backtest adjustment is applied below.
  const conf = clamp(.50 + .24*strength*(.45+.55*agreement)*(.55+.45*active.length/Math.max(1,rows.length)), .50, .90);
  return { prediction: pred, mode, run, runLength: run, votes: {0:1-pTai,1:pTai},
    familySummary: families, agreement, evidenceCount: active.length, confidence: conf,
    confidenceLabel: (conf*100).toFixed(2)+"%", analysis: {
      families: rows.length, activeFamilies: active.length, patternCatalogSize: PATTERNS.length,
      agreeTai: tai, agreeXiu: xiu, sampleSize: bits.length, modelVariants: 200, aiSignals: 100, markovOrders: 50
    }};
}
function forecast(history) {
  const bits = bitsOf(history).slice(-200);
  const result = analyze(bits);
  let tested=0, correct=0, predictedTai=0, predictedXiu=0, hitsTai=0, hitsXiu=0;
  const backtestStart = Math.max(8, bits.length - 40);
  for (let i=backtestStart; i<bits.length; i++) {
    const f = analyze(bits.slice(Math.max(0,i-200),i)), actual=bits[i];
    tested++; if (f.prediction===actual) correct++;
    if (f.prediction===1) { predictedTai++; if(actual===1) hitsTai++; }
    else { predictedXiu++; if(actual===0) hitsXiu++; }
  }
  const accuracy = tested ? correct/tested : null;
  const reliability = Math.min(1,tested/20);
  const lift = accuracy===null ? 0 : accuracy-.5;
  result.confidence = clamp(.50+(result.confidence-.50)*.72+lift*.35*reliability,.50,.90);
  result.confidenceLabel = (result.confidence*100).toFixed(2)+"%";
  result.backtest = { tested, correct, accuracy: tested>=10 ? Number(accuracy.toFixed(4)) : null,
    predictedTai, predictedXiu, hitsTai, hitsXiu, baseline:.5,
    label: tested>=10 ? "Kiểm thử cuốn chiếu" : "Chưa đủ mẫu kiểm thử" };
  result.predictionBalance = { samples:tested, predictedTai, predictedXiu,
    taiShare:tested ? Number((predictedTai/tested).toFixed(3)) : null };
  return result;
}
function evaluatePending(history) {
  const byId = new Map(history.map(x=>[String(x.sid),x])); let changed=false;
  for (const [sid,p] of Object.entries(state.pending)) {
    const actual=byId.get(String(sid)); if(!actual) continue;
    const win=p.bit===actual.bit;
    state.wins += win?1:0; state.losses += win?0:1;
    state.evaluated.unshift({sid:Number(sid),prediction:p.prediction,actual:actual.result,
      status:win?"THẮNG":"THUA",predictedAt:p.createdAt||null,dice:actual.dice,sum:actual.sum});
    delete state.pending[sid]; changed=true;
  }
  state.evaluated=state.evaluated.slice(0,100); if(changed) saveState();
}
function snapshot() {
  return { success:true, source:"VERTEX PREMIUM V18 · 500 Patterns / 200 Models / 100 AI / 50 Markov",
    updatedAt:state.lastUpdate,error:lastApiError,latest:state.latest||null,
    prediction:state.prediction||null,stats:{wins:state.wins,losses:state.losses},
    evaluated:state.evaluated.slice(0,50),analysis:state.analysis||null };
}
async function pollApi() {
  if(busy) return; busy=true;
  try {
    const r=await fetch(API_URL,{headers:{Accept:"application/json","Cache-Control":"no-cache"},signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error(`API HTTP ${r.status}`);
    const payload=await r.json(), history=normalize(payload);
    if(!history.length) throw new Error("API không có phiên hợp lệ hoặc cấu trúc dữ liệu đã đổi.");
    state.apiHistory=history;
    evaluatePending(history);
    const latest=history[0], currentSid=latest.sid+1;
    let p=state.pending[String(currentSid)];
    if(!p) {
      const f=forecast(history);
      p={bit:f.prediction,prediction:f.prediction===1?"Tài":"Xỉu",createdAt:new Date().toISOString(),
        mode:f.mode,runLength:f.runLength||1,confidenceLabel:f.confidenceLabel,backtest:f.backtest,
        votes:{tai:(100*f.votes[1]).toFixed(1)+"%",xiu:(100*f.votes[0]).toFixed(1)+"%"},
        analysis:f.analysis,familySummary:f.familySummary};
      state.pending[String(currentSid)]=p;
    }
    state.latest={phien_truoc:latest.sid,xuc_xac:latest.dice,tong:latest.sum,ket_qua:latest.result,phien_hien_tai:currentSid};
    state.prediction={du_doan:p.prediction,dang_cau:p.mode||"ĐÃ KHÓA DỰ ĐOÁN",
      do_dai_cau:p.runLength||1,tin_cay:p.confidenceLabel||"50.00%",backtest:p.backtest||null,
      votes:p.votes||{tai:"50.0%",xiu:"50.0%"},danh_gia:"CHỜ KẾT QUẢ",
      analysis:p.analysis||null,familySummary:p.familySummary||{}};
    state.analysis=p.analysis||null; state.lastSession=latest.sid; state.lastUpdate=new Date().toISOString();
    lastApiError=null;
    const keys=Object.keys(state.pending).sort((a,b)=>Number(a)-Number(b));
    for(const k of keys.slice(0,Math.max(0,keys.length-20))) delete state.pending[k];
    saveState();
  } catch(e) { lastApiError=e?.message||String(e); console.error("[API ERROR]",lastApiError); }
  finally { busy=false; }
}

const HTML = String.raw`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07111b">
<title>VERTEX PREMIUM V17 · AI Analyzer</title>
<style>
:root{color-scheme:dark;--bg:#07111b;--panel:#0d1b2a;--line:#23394d;--muted:#91a7ba;--text:#edf5fb;--green:#39e6a0;--red:#ff657c;--gold:#ffd078;--blue:#54c8ff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(850px 480px at 5% -10%,#12405a 0%,transparent 62%),radial-gradient(700px 450px at 100% 0%,#351c37 0%,transparent 55%),var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1160px;margin:auto;padding:22px 15px 38px}.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:12px}.logo{width:46px;height:46px;display:grid;place-items:center;border-radius:15px;border:1px solid #36d9ad;color:var(--green);font-weight:950;font-size:22px;box-shadow:0 0 25px #39e6a022}.brand h1{font-size:16px;letter-spacing:1.4px;margin:0}.brand p{font-size:11px;color:var(--muted);margin:3px 0 0}.pill{border:1px solid var(--line);border-radius:99px;padding:7px 11px;color:var(--muted);font-size:11px}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:13px}.card{min-width:0;padding:17px;border:1px solid var(--line);border-radius:17px;background:linear-gradient(145deg,#112337ed,#0a1724f2);box-shadow:0 16px 40px #0002}.card h2{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#aec4d5;margin:0 0 14px}.hero{display:flex;align-items:center;justify-content:space-between;gap:12px}.label{color:var(--muted);font-size:11px}.prediction{font-size:39px;font-weight:900;letter-spacing:.4px;margin:3px 0}.prediction.tai{color:var(--green)}.prediction.xiu{color:var(--red)}.mode{display:inline-block;padding:5px 8px;border-radius:8px;background:#183247;color:#d6eafa;font-size:10px;font-weight:800}.confidence{text-align:right;min-width:112px}.confidence strong{display:block;font-size:24px;color:var(--gold)}.confidence small{font-size:10px;color:var(--muted)}.dice{display:flex;gap:7px;margin-top:12px}.die{width:34px;height:34px;display:grid;place-items:center;border-radius:9px;background:#eaf4fb;color:#102234;font-weight:900}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:15px}.metric{border:1px solid var(--line);border-radius:11px;padding:10px}.metric span{display:block;color:var(--muted);font-size:10px}.metric strong{display:block;margin-top:4px;font-size:16px;overflow-wrap:anywhere}.stats{display:grid;grid-template-columns:1fr 1fr;gap:9px}.stat{padding:14px;border:1px solid var(--line);border-radius:12px;background:#081522}.stat .n{font-size:30px;font-weight:900}.win{color:var(--green)}.loss{color:var(--red)}.stat small{display:block;color:var(--muted)}.bar{height:7px;border-radius:99px;overflow:hidden;background:#23384c;margin-top:12px}.bar span{height:100%;display:block;width:0;background:linear-gradient(90deg,var(--green),var(--blue));transition:width .3s}.wide{margin-top:13px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:570px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #1b3042;font-size:11px}th{color:var(--muted)}td{color:#dce9f2}.badge{display:inline-block;padding:4px 7px;border-radius:6px;font-size:10px;font-weight:850}.badge.win{background:#10382d}.badge.loss{background:#421d29}.error{color:var(--red);font-size:11px;margin-top:9px}.familyGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.family{border:1px solid var(--line);border-radius:10px;padding:10px}.family b{display:block;font-size:11px}.family small{display:block;color:var(--muted);font-size:10px;margin-top:3px}.family em{font-style:normal;font-size:12px;font-weight:850}.foot{text-align:center;color:#748ba0;font-size:10px;margin-top:17px}.sectionSub{font-size:10px;color:var(--muted);margin:-8px 0 12px}
@media(max-width:760px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.familyGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.prediction{font-size:33px}.confidence{min-width:95px}.head{align-items:flex-start}.pill{max-width:130px;text-align:center}}
</style></head><body><main class="wrap">
<header class="head"><div class="brand"><div class="logo">V</div><div><h1>VERTEX PREMIUM</h1><p>V18 · 500 PATTERNS · 200 MODELS · 100 AI · 50 MARKOV</p></div></div><div class="pill" id="status">ĐANG KẾT NỐI API</div></header>
<div class="grid"><section class="card"><h2>Dự đoán phiên kế tiếp</h2><div class="hero"><div><div class="label">PHIÊN <span id="sid">—</span></div><div id="pred" class="prediction">—</div><span class="mode" id="mode">Đang phân tích</span></div><div class="confidence"><strong id="conf">—</strong><small>Điểm mô hình · không bảo đảm thắng</small></div></div>
<div class="label" style="margin-top:16px">KẾT QUẢ GẦN NHẤT · PHIÊN <span id="last">—</span></div><div class="dice" id="dice"></div>
<div class="metrics"><div class="metric"><span>Tổng điểm</span><strong id="sum">—</strong></div><div class="metric"><span>Kết quả thật</span><strong id="actual">—</strong></div><div class="metric"><span>Độ dài cầu</span><strong id="run">—</strong></div><div class="metric"><span>Trạng thái</span><strong id="eval">CHỜ</strong></div></div><div id="error" class="error"></div></section>
<section class="card"><h2>Hiệu suất thực tế</h2><div class="stats"><div class="stat"><div class="n win" id="wins">0</div><small>THẮNG</small></div><div class="stat"><div class="n loss" id="losses">0</div><small>THUA</small></div></div><div class="bar"><span id="bar"></span></div><p class="label" id="wr" style="margin:9px 0 0">Tỷ lệ thắng: chưa có mẫu</p>
<div class="metrics"><div class="metric"><span>Phiếu Tài</span><strong id="vt">—</strong></div><div class="metric"><span>Phiếu Xỉu</span><strong id="vx">—</strong></div><div class="metric"><span>Backtest</span><strong id="acc">—</strong></div><div class="metric"><span>Mẫu kiểm thử</span><strong id="tested">0</strong></div></div></section></div>
<section class="card wide"><h2>Tín hiệu thuật toán</h2><p class="sectionSub">500 pattern · 200 cấu hình mô hình · 100 tín hiệu phân tích · Markov bậc 1–50. Các nhóm được gộp để tránh đếm trùng phiếu.</p><div class="familyGrid" id="families"></div></section>
<section class="card wide"><h2>Lịch sử WIN / LOSS</h2><div class="scroll"><table><thead><tr><th>Phiên</th><th>Dự đoán</th><th>Kết quả</th><th>Tổng</th><th>Đánh giá</th></tr></thead><tbody id="history"><tr><td colspan="5">Đang chờ dữ liệu.</td></tr></tbody></table></div></section>
<div class="foot">Tự cập nhật 3 giây · API lấy dữ liệu mỗi 10 giây · tối đa 200 kết quả cho mô hình · điểm tin cậy không phải cam kết thắng.</div></main>
<script>
const $=id=>document.getElementById(id);
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
const labels={pattern150:"500 Pattern",models200:"200 Models",ai100:"100 AI Signals",suffix:"Hậu tố",markov:"Markov",streak:"Cầu bệt",alternation:"Cầu đảo",cycle:"Chu kỳ",motif:"Motif",frequency:"Tần suất",trend:"Xu hướng",block:"Khối lặp",regime:"Ổn định"};
function render(d){
 const l=d.latest,p=d.prediction,s=d.stats||{wins:0,losses:0};
 $("status").textContent=d.error?"LỖI API":d.updatedAt?"API ĐANG HOẠT ĐỘNG":"ĐANG KẾT NỐI";
 $("error").textContent=d.error?"API: "+d.error:"";
 if(l){$("sid").textContent=l.phien_hien_tai;$("last").textContent=l.phien_truoc;$("sum").textContent=l.tong??"—";$("actual").textContent=l.ket_qua??"—";$("dice").innerHTML=(l.xuc_xac||[]).map(n=>'<div class="die">'+esc(n)+'</div>').join("")||"—";}
 if(p){
  $("pred").textContent=p.du_doan||"—";$("pred").className="prediction "+(p.du_doan==="Tài"?"tai":"xiu");$("mode").textContent=p.dang_cau||"—";$("conf").textContent=p.tin_cay||"—";$("run").textContent=p.do_dai_cau??"—";$("eval").textContent=p.danh_gia||"CHỜ";
  $("vt").textContent=p.votes?.tai??"—";$("vx").textContent=p.votes?.xiu??"—";
  const b=p.backtest||{};$("acc").textContent=b.accuracy==null?"—":(b.accuracy*100).toFixed(1)+"%";$("tested").textContent=b.tested??0;
  const fs=p.familySummary||{};$("families").innerHTML=Object.entries(fs).map(([k,v])=>'<div class="family"><b>'+esc(labels[k]||k)+'</b><small>'+esc(v.note||"")+' · hỗ trợ '+esc(v.support)+'</small><em class="'+(v.pTai>.5?"win":v.pTai<.5?"loss":"")+'">Tài '+(100*v.pTai).toFixed(1)+'% · Xỉu '+(100*(1-v.pTai)).toFixed(1)+'%</em></div>').join("")||'<div class="label">Chưa có dữ liệu phân tích.</div>';
 }
 const wins=Number(s.wins)||0,losses=Number(s.losses)||0,total=wins+losses;
 $("wins").textContent=wins;$("losses").textContent=losses;$("bar").style.width=(total?100*wins/total:0)+"%";$("wr").textContent=total?"Tỷ lệ thắng đã chấm: "+(100*wins/total).toFixed(2)+"% ("+total+" phiên)":"Tỷ lệ thắng: chưa có mẫu";
 const rows=d.evaluated||[];$("history").innerHTML=rows.length?rows.map(x=>'<tr><td>'+esc(x.sid)+'</td><td class="'+(x.prediction==="Tài"?"win":"loss")+'">'+esc(x.prediction)+'</td><td>'+esc(x.actual)+'</td><td>'+esc(x.sum??"—")+'</td><td><span class="badge '+(x.status==="THẮNG"?"win":"loss")+'">'+(x.status==="THẮNG"?"WIN":"LOSS")+'</span></td></tr>').join(""):'<tr><td colspan="5">Chưa có phiên nào được chấm.</td></tr>';
}
async function refresh(){try{const r=await fetch("/api/state",{cache:"no-store"});render(await r.json());}catch(e){$("status").textContent="MẤT KẾT NỐI";}}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const server = http.createServer((req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health" || url.pathname === "/ping") {
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({ok:true,service:"VERTEX PREMIUM V18",updatedAt:state.lastUpdate,apiError:lastApiError})); return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}); res.end(HTML); return;
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify(snapshot())); return;
  }
  res.writeHead(404,{"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify({success:false,error:"Not found"}));
});
server.listen(PORT,"0.0.0.0",()=>{
  console.log(`VERTEX PREMIUM V18 listening on ${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log("Endpoints: / /api/state /health /ping");
  pollApi(); setInterval(pollApi,POLL_MS);
});
