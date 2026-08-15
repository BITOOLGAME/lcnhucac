const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const CACHE_MS = 3000;
const MAX_SOURCE_HISTORY = 100;
const MAX_PATTERN_HISTORY = 20;
const MAX_PREDICTION_HISTORY = 50;
const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 15;
const MIN_EXACT_SAMPLES = 2;
const PREDICTION_FILE = path.join(__dirname, "predictions.json");

// Cache
let cache = { time: 0, history: [], pattern: "", prediction: null, next: null };
let predictionHistory = loadPredictions();
let learnedPatterns = new Map();

// === Trọng số ensemble (sẽ được tối ưu online) ===
let ensembleWeights = {
    patternModel: 1.0,
    markovModel: 1.0,
    trendModel: 1.0
};
let weightHistory = []; // lưu lịch sử để theo dõi

// === Utility ===
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v, d = 2) { return Number(Number(v).toFixed(d)); }
function tx(v) {
    const s = String(v || "").toUpperCase();
    return (s === "TAI" || s === "T" || s === "TÀI") ? "T" : "X";
}
function result(v) { return v === "T" ? "Tài" : "Xỉu"; }
function opposite(v) { return v === "T" ? "X" : "T"; }
function safeArray(a) { return Array.isArray(a) ? a : []; }

// === Random thông minh (có bias) ===
function smartRandom(scoreT, scoreX, bias = 0) {
    const total = scoreT + scoreX;
    if (total <= 0) return Math.random() < 0.5 ? "T" : "X";
    let pT = (scoreT / total) + bias;
    pT = clamp(pT, 0.1, 0.9);
    return Math.random() < pT ? "T" : "X";
}

// === File I/O ===
function loadPredictions() {
    try {
        if (!fs.existsSync(PREDICTION_FILE)) {
            fs.writeFileSync(PREDICTION_FILE, "[]", "utf8");
            return [];
        }
        const raw = fs.readFileSync(PREDICTION_FILE, "utf8");
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.sort((a, b) => a.phien - b.phien).slice(-MAX_PREDICTION_HISTORY) : [];
    } catch (e) { console.error("LOAD ERROR:", e.message); return []; }
}

function savePredictions() {
    try {
        predictionHistory = predictionHistory.sort((a, b) => a.phien - b.phien).slice(-MAX_PREDICTION_HISTORY);
        fs.writeFileSync(PREDICTION_FILE, JSON.stringify(predictionHistory, null, 2), "utf8");
    } catch (e) { console.error("SAVE ERROR:", e.message); }
}

// === Fetch API ===
async function fetchHistory() {
    const resp = await fetch(SOURCE_API, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || !Array.isArray(data.list)) throw new Error("Invalid response");
    return data.list
        .map(item => {
            const dices = safeArray(item.dices).map(Number);
            return {
                phien: Number(item.id),
                xuc_xac: dices,
                tong: Number(item.point),
                ket_qua: (String(item.resultTruyenThong || "").toUpperCase() === "TAI") ? "Tài" : "Xỉu"
            };
        })
        .filter(item =>
            Number.isFinite(item.phien) && item.xuc_xac.length === 3 &&
            item.xuc_xac.every(Number.isFinite) && Number.isFinite(item.tong)
        )
        .sort((a, b) => a.phien - b.phien)
        .slice(-MAX_SOURCE_HISTORY);
}

// === Pattern Helpers (giữ nguyên) ===
function getSides(history) { return history.map(i => tx(i.ket_qua)); }
function buildPattern(history) { return getSides(history).slice(-MAX_PATTERN_HISTORY).join(""); }
function bayesianRate(success, total) { return (success + 2) / (total + 4); }
function distributionConfidence(tai, xiu) {
    const total = tai + xiu;
    if (total <= 0) return 50;
    const p = Math.max(bayesianRate(tai, total), bayesianRate(xiu, total));
    return round(clamp(p * 100, 50, 97));
}
function getPatternStats(history, pattern) {
    const values = getSides(history);
    let tai = 0, xiu = 0, matches = [];
    for (let i = 0; i + pattern.length < values.length; i++) {
        if (values.slice(i, i + pattern.length).join("") !== pattern) continue;
        const next = values[i + pattern.length];
        if (next === "T") tai++; else xiu++;
        matches.push({ index: i, next });
    }
    const total = tai + xiu;
    if (!total) return null;
    const pT = bayesianRate(tai, total), pX = bayesianRate(xiu, total);
    return {
        pattern, length: pattern.length, total, tai, xiu,
        raw_tai: round(tai / total * 100), raw_xiu: round(xiu / total * 100),
        bayes_tai: round(pT * 100), bayes_xiu: round(pX * 100),
        pT, pX, prediction: pT >= pX ? "T" : "X",
        confidence: distributionConfidence(tai, xiu),
        matches
    };
}

function minePatterns(history) {
    const values = getSides(history);
    const maxLen = Math.min(MAX_PATTERN_LENGTH, values.length - 1);
    const patterns = [];
    for (let len = MIN_PATTERN_LENGTH; len <= maxLen; len++) {
        const pattern = values.slice(-len).join("");
        const stats = getPatternStats(history, pattern);
        if (!stats || stats.total < MIN_EXACT_SAMPLES) continue;
        const strength = Math.min(1, stats.total / 10) * (1 + Math.min(0.9, len / 15)) * (stats.confidence / 100);
        patterns.push({ ...stats, strength: round(strength, 4) });
    }
    return patterns.sort((a, b) => b.strength - a.strength);
}

// === Similar, Transform (giữ nguyên) ===
function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    return same / a.length;
}
function mineSimilarPatterns(history, currentPattern) {
    const values = getSides(history);
    const len = currentPattern.length;
    if (len < 3 || values.length <= len) return null;
    let tai = 0, xiu = 0, matches = [];
    for (let i = 0; i + len < values.length; i++) {
        const cand = values.slice(i, i + len).join("");
        if (cand === currentPattern) continue;
        const sim = similarity(currentPattern, cand);
        if (sim < 0.70) continue;
        const w = Math.pow(sim, 4);
        if (values[i + len] === "T") tai += w; else xiu += w;
        matches.push({ pattern: cand, similarity: round(sim * 100), next: result(values[i + len]), weight: round(w, 4) });
    }
    const total = tai + xiu;
    if (!total) return null;
    return {
        current: currentPattern, matches: matches.length,
        examples: matches.slice(-20),
        pT: tai / total, pX: xiu / total,
        confidence: distributionConfidence(tai, xiu),
        prediction: tai >= xiu ? "T" : "X"
    };
}
function invertPattern(p) { return p.split("").map(c => c === "T" ? "X" : "T").join(""); }
function reversePattern(p) { return p.split("").reverse().join(""); }
function rotatePattern(p) { return p.length < 2 ? p : p.slice(1) + p[0]; }
function patternTransforms(p) {
    const set = new Set([p, invertPattern(p), reversePattern(p), invertPattern(reversePattern(p))]);
    if (p.length >= 3) set.add(rotatePattern(p));
    return [...set];
}
function analyzeTransformedPatterns(history, pattern) {
    const result = [];
    for (const item of patternTransforms(pattern)) {
        if (item === pattern) continue;
        const stats = getPatternStats(history, item);
        if (stats && stats.total >= MIN_EXACT_SAMPLES) result.push(stats);
    }
    return result;
}

// === Run Pattern (giữ nguyên) ===
function getRuns(history) {
    const values = getSides(history);
    if (!values.length) return [];
    const runs = [];
    let side = values[0], count = 1;
    for (let i = 1; i < values.length; i++) {
        if (values[i] === side) count++;
        else { runs.push({ side, count }); side = values[i]; count = 1; }
    }
    runs.push({ side, count });
    return runs;
}
function analyzeRunPattern(history) {
    const runs = getRuns(history);
    if (runs.length < 2) return { signature: "", signals: [] };
    const lengths = runs.map(i => i.count);
    const recent = runs.slice(-10);
    const last = recent[recent.length - 1];
    const signals = [];
    const add = (name, pred, weight) => signals.push({ name, prediction: pred, weight });
    if (last.count >= 3) add(`bet-${last.count}`, last.side, clamp(0.55 + last.count * 0.035, 0.55, 0.78));
    if (recent.length >= 2) {
        const prev = recent[recent.length - 2];
        if (prev.count >= 3 && last.count === 1) add("gay-bet", last.side, 0.72);
    }
    const special = [
        ["1-1",0.82],["2-2",0.82],["3-3",0.80],["4-4",0.78],
        ["1-2",0.76],["2-1",0.76],["1-3",0.75],["3-1",0.75],
        ["1-4",0.74],["4-1",0.74],["1-5",0.73],["5-1",0.73],
        ["1-2-1",0.82],["2-1-2",0.82],["1-3-1",0.81],["3-1-3",0.81],
        ["1-4-1",0.79],["4-1-4",0.79],["1-2-3",0.79],["2-3-4",0.80],
        ["3-4-5",0.81],["3-2-1",0.79],["4-3-2",0.80],["5-4-3",0.81],
        ["1-2-3-4",0.84],["2-3-4-5",0.85],["1-2-3-4-5",0.87],
        ["4-3-2-1",0.84],["5-4-3-2",0.85],["5-4-3-2-1",0.87],
        ["1-2-1-2",0.83],["2-1-2-1",0.83],["1-3-1-3",0.82],["3-1-3-1",0.82],
        ["2-3-2-3",0.82],["3-2-3-2",0.82],
        ["1-2-3-2-1",0.87],["2-3-4-3-2",0.88],["3-4-5-4-3",0.88],
        ["1-2-3-4-3-2-1",0.91],["2-3-4-5-4-3-2",0.91],
        ["1-2-3-4-5-4-3-2-1",0.93],
        ["1-2-2-1",0.80],["2-1-1-2",0.80],["1-3-3-1",0.79],["3-1-1-3",0.79],
        ["1-1-2-2",0.80],["2-2-1-1",0.80],["1-1-3-3",0.79],["3-3-1-1",0.79],
        ["1-2-3-1-2-3",0.85],["2-3-4-2-3-4",0.86],
        ["1-3-2-3-1",0.83],["2-4-3-4-2",0.84],
        ["1-3-2-4",0.78],["4-2-3-1",0.78],
        ["2-3-1-2",0.78],["1-2-4-2",0.78],
        ["1-2-1-3-1-2-1",0.87],["2-1-2-3-2-1-2",0.87],
        ["1-2-3-3-2-1",0.87],["2-3-4-4-3-2",0.88],
        ["1-2-3-2-3-4",0.84],["2-3-2-3-4-3",0.84],
        ["1-3-2-1-2-3",0.82],["3-1-2-3-2-1",0.82]
    ];
    for (const [pat, w] of special) {
        const current = lengths.slice(-pat.split("-").length).join("-");
        if (current === pat) add(pat, opposite(last.side), w);
    }
    if (lengths.length >= 3) {
        const r = lengths.slice(-5);
        let inc = true, dec = true;
        for (let i = 1; i < r.length; i++) {
            if (r[i] <= r[i-1]) inc = false;
            if (r[i] >= r[i-1]) dec = false;
        }
        if (inc && r.length >= 3) add("dynamic-increase", opposite(last.side), 0.80);
        if (dec && r.length >= 3) add("dynamic-decrease", opposite(last.side), 0.80);
    }
    for (let len = 3; len <= 7; len++) {
        const part = lengths.slice(-len);
        if (part.join(",") === [...part].reverse().join(","))
            add(`symmetric-${len}`, opposite(last.side), clamp(0.72 + len * 0.025, 0.72, 0.90));
    }
    for (let period = 2; period <= 4; period++) {
        if (lengths.length < period * 2) continue;
        const a = lengths.slice(-period);
        const b = lengths.slice(-period * 2, -period);
        if (a.join(",") === b.join(","))
            add(`run-cycle-${period}`, opposite(last.side), clamp(0.76 + period * 0.025, 0.76, 0.86));
    }
    return { signature: getRuns(history).slice(-10).map(i => i.count).join("-"), runs: recent, signals };
}

// === Markov (giữ nguyên) ===
function analyzeMarkov1(history) {
    const v = getSides(history);
    if (v.length < 5) return null;
    const key = v[v.length - 1];
    let tai = 0, xiu = 0;
    for (let i = 0; i < v.length - 1; i++) {
        if (v[i] !== key) continue;
        if (v[i+1] === "T") tai++; else xiu++;
    }
    const total = tai + xiu;
    if (!total) return null;
    return { key, total, tai, xiu, pT: bayesianRate(tai, total), pX: bayesianRate(xiu, total) };
}
function analyzeMarkov2(history) {
    const v = getSides(history);
    if (v.length < 7) return null;
    const key = v.slice(-2).join("");
    let tai = 0, xiu = 0;
    for (let i = 0; i < v.length - 2; i++) {
        if (v.slice(i, i+2).join("") !== key) continue;
        if (v[i+2] === "T") tai++; else xiu++;
    }
    const total = tai + xiu;
    if (!total) return null;
    return { key, total, tai, xiu, pT: bayesianRate(tai, total), pX: bayesianRate(xiu, total) };
}
function analyzeMarkov3(history) {
    const v = getSides(history);
    if (v.length < 9) return null;
    const key = v.slice(-3).join("");
    let tai = 0, xiu = 0;
    for (let i = 0; i < v.length - 3; i++) {
        if (v.slice(i, i+3).join("") !== key) continue;
        if (v[i+3] === "T") tai++; else xiu++;
    }
    const total = tai + xiu;
    if (!total) return null;
    return { key, total, tai, xiu, pT: bayesianRate(tai, total), pX: bayesianRate(xiu, total) };
}

// === Cycle, Streak, Alternating (giữ nguyên) ===
function analyzeCycles(history) {
    const v = getSides(history);
    const signals = [];
    for (let p = 2; p <= 8; p++) {
        if (v.length < p * 2 + 1) continue;
        const cur = v.slice(-p);
        let tai = 0, xiu = 0;
        for (let i = p; i < v.length; i++) {
            if (v.slice(i-p, i).join("") !== cur.join("")) continue;
            if (v[i] === "T") tai++; else xiu++;
        }
        const total = tai + xiu;
        if (total < MIN_EXACT_SAMPLES) continue;
        const pT = bayesianRate(tai, total), pX = bayesianRate(xiu, total);
        signals.push({ period: p, total, tai, xiu, pT, pX, prediction: pT >= pX ? "T" : "X", confidence: distributionConfidence(tai, xiu) });
    }
    return signals;
}
function analyzeStreak(history) {
    const v = getSides(history);
    if (!v.length) return null;
    const last = v[v.length - 1];
    let count = 0;
    for (let i = v.length - 1; i >= 0; i--) {
        if (v[i] === last) count++; else break;
    }
    return { side: last, count, prediction: count >= 3 ? opposite(last) : last, weight: clamp(0.55 + count * 0.04, 0.55, 0.82) };
}
function analyzeAlternating(history) {
    const v = getSides(history);
    if (v.length < 4) return null;
    const recent = v.slice(-8);
    let alt = true;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] === recent[i-1]) { alt = false; break; }
    }
    if (!alt) return null;
    return { pattern: recent.join(""), prediction: opposite(recent[recent.length-1]), weight: 0.88 };
}

// === Self Learning (giữ nguyên) ===
function rebuildLearning() {
    learnedPatterns = new Map();
    for (const item of predictionHistory) {
        if (item.danh_gia !== "✅ Thắng" && item.danh_gia !== "❌ Thua") continue;
        if (!item.pattern) continue;
        if (!learnedPatterns.has(item.pattern)) learnedPatterns.set(item.pattern, { total: 0, win: 0, lose: 0 });
        const data = learnedPatterns.get(item.pattern);
        data.total++;
        if (item.danh_gia === "✅ Thắng") data.win++; else data.lose++;
    }
}
function getLearningScore(pattern) {
    const data = learnedPatterns.get(pattern);
    if (!data) return null;
    return { ...data, win_rate: data.total ? round(data.win / data.total * 100) : 0 };
}

// === Tín hiệu báo tool (cải tiến) ===
function isPatternGood(prediction) {
    const p = prediction.pattern_chinh;
    if (!p) return false;
    const conf = parseFloat(p.do_tin_cay) || 0;
    const samples = p.so_lan_gap || 0;
    const agree = prediction.agreement || 0;
    return conf >= 60 && samples >= 4 && agree >= 65;
}
function getRecommendation(prediction) {
    const du_doan = prediction.du_doan;
    const do_tin_cay = prediction.confidence || 50;
    const side = prediction.side;
    if (do_tin_cay >= 60) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% >= 60%, theo ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    }
    const good = isPatternGood(prediction);
    if (good) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 60%, pattern đẹp → theo ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    } else {
        const bo = side === "T" ? "X" : "T";
        return {
            khuyen_nghi: "BẺ",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 60%, pattern xấu → bẻ sang ${result(bo)}`,
            side_theo: bo,
            side_bo: side
        };
    }
}

// === MÔ HÌNH 1: Pattern-based ===
function patternModel(history) {
    const mined = minePatterns(history);
    if (!mined.length) return { scoreT: 0, scoreX: 0, confidence: 0, evidence: [] };
    const main = mined[0];
    const weight = clamp(3 + main.length * 0.4 + Math.log2(main.total + 1), 3, 8);
    return {
        scoreT: main.pT * weight,
        scoreX: main.pX * weight,
        confidence: main.confidence,
        evidence: [{ type: "patternModel", pattern: main.pattern, samples: main.total, weight }]
    };
}

// === MÔ HÌNH 2: Markov-chain ===
function markovModel(history) {
    const m1 = analyzeMarkov1(history);
    const m2 = analyzeMarkov2(history);
    const m3 = analyzeMarkov3(history);
    let totalScoreT = 0, totalScoreX = 0, totalWeight = 0, ev = [];
    if (m1) {
        const w = 1.5;
        totalScoreT += m1.pT * w; totalScoreX += m1.pX * w; totalWeight += w;
        ev.push({ type: "markov1", key: m1.key, samples: m1.total });
    }
    if (m2) {
        const w = 2.0;
        totalScoreT += m2.pT * w; totalScoreX += m2.pX * w; totalWeight += w;
        ev.push({ type: "markov2", key: m2.key, samples: m2.total });
    }
    if (m3) {
        const w = 2.2;
        totalScoreT += m3.pT * w; totalScoreX += m3.pX * w; totalWeight += w;
        ev.push({ type: "markov3", key: m3.key, samples: m3.total });
    }
    if (totalWeight === 0) return { scoreT: 0, scoreX: 0, confidence: 0, evidence: [] };
    const conf = distributionConfidence(totalScoreT, totalScoreX);
    return { scoreT: totalScoreT, scoreX: totalScoreX, confidence: conf, evidence: ev };
}

// === MÔ HÌNH 3: Trend-based (xu hướng dài hạn, run, cycle, streak) ===
function trendModel(history) {
    const run = analyzeRunPattern(history);
    const cycles = analyzeCycles(history);
    const streak = analyzeStreak(history);
    const alt = analyzeAlternating(history);
    let scoreT = 0, scoreX = 0, ev = [];
    if (run && run.signals.length) {
        for (const sig of run.signals) {
            const w = sig.weight * 1.2;
            if (sig.prediction === "T") scoreT += w; else scoreX += w;
            ev.push({ type: "run", pattern: sig.name, weight: w });
        }
    }
    for (const cyc of cycles) {
        const w = clamp(0.7 + cyc.total * 0.06, 0.7, 1.6);
        if (cyc.prediction === "T") scoreT += w; else scoreX += w;
        ev.push({ type: "cycle", period: cyc.period, weight: w });
    }
    if (streak) {
        const w = streak.weight;
        if (streak.prediction === "T") scoreT += w; else scoreX += w;
        ev.push({ type: "streak", count: streak.count, weight: w });
    }
    if (alt) {
        const w = alt.weight;
        if (alt.prediction === "T") scoreT += w; else scoreX += w;
        ev.push({ type: "alternating", weight: w });
    }
    const total = scoreT + scoreX;
    if (total === 0) return { scoreT: 0, scoreX: 0, confidence: 0, evidence: [] };
    const conf = distributionConfidence(scoreT, scoreX);
    return { scoreT, scoreX, confidence: conf, evidence: ev };
}

// === Ensemble kết hợp 3 mô hình ===
function ensemblePrediction(history) {
    const pModel = patternModel(history);
    const mModel = markovModel(history);
    const tModel = trendModel(history);

    // Trọng số ensemble hiện tại
    const wP = ensembleWeights.patternModel;
    const wM = ensembleWeights.markovModel;
    const wT = ensembleWeights.trendModel;
    const totalW = wP + wM + wT;
    if (totalW === 0) return { scoreT: 0, scoreX: 0, confidence: 0, evidence: [] };

    const scoreT = (pModel.scoreT * wP + mModel.scoreT * wM + tModel.scoreT * wT) / totalW;
    const scoreX = (pModel.scoreX * wP + mModel.scoreX * wM + tModel.scoreX * wT) / totalW;
    const conf = distributionConfidence(scoreT, scoreX);
    const evidence = [
        ...pModel.evidence.map(e => ({ ...e, model: "pattern", weight: e.weight * wP / totalW })),
        ...mModel.evidence.map(e => ({ ...e, model: "markov", weight: (e.weight || 1) * wM / totalW })),
        ...tModel.evidence.map(e => ({ ...e, model: "trend", weight: (e.weight || 1) * wT / totalW }))
    ];
    return { scoreT, scoreX, confidence: conf, evidence };
}

// === Phân tích xu hướng dài hạn để điều chỉnh bias ===
function getTrendBias(history) {
    const sides = getSides(history);
    if (sides.length < 20) return 0;
    const recent20 = sides.slice(-20);
    const countT = recent20.filter(s => s === "T").length;
    const countX = 20 - countT;
    const ratio = countT / 20;
    // Nếu lệch > 60% thì tạo bias ngược nhẹ
    if (ratio > 0.60) return -0.05; // giảm xác suất T
    if (ratio < 0.40) return 0.05;  // tăng xác suất T
    return 0;
}

// === Hàm dự đoán chính (siêu pro) ===
function calculatePrediction(history) {
    const values = getSides(history);
    if (values.length < 5) {
        const side = smartRandom(0, 0);
        const obj = {
            du_doan: result(side), side,
            do_tin_cay: "50.00%", confidence: 50,
            trang_thai: "Chưa đủ dữ liệu - Random",
            random: true,
            pattern_chinh: null,
            score: { tai: 0, xiu: 0 },
            evidence: []
        };
        obj.recommendation = getRecommendation({ du_doan: obj.du_doan, side: obj.side, confidence: 50, pattern_chinh: null, agreement: 0 });
        return obj;
    }

    // Lấy kết quả ensemble
    const ensemble = ensemblePrediction(history);
    let { scoreT, scoreX, confidence, evidence } = ensemble;

    // Thêm bias từ xu hướng dài hạn
    const bias = getTrendBias(history);
    if (bias !== 0) {
        scoreT += bias * (scoreT + scoreX);
        scoreX -= bias * (scoreT + scoreX);
        // Đảm bảo không âm
        scoreT = Math.max(0, scoreT);
        scoreX = Math.max(0, scoreX);
        evidence.push({ type: "trend_bias", bias: round(bias, 3) });
    }

    const totalScore = scoreT + scoreX;
    if (totalScore <= 0) {
        const side = smartRandom(0, 0);
        const obj = {
            du_doan: result(side), side,
            do_tin_cay: "50.00%", confidence: 50,
            trang_thai: "Không tín hiệu - Random",
            random: true,
            pattern_chinh: null,
            score: { tai: 0, xiu: 0 },
            evidence,
            margin: 0, probability: { tai: 50, xiu: 50 },
            agreement: 50, votes: { T: 0, X: 0 },
            pattern_candidates: []
        };
        obj.recommendation = getRecommendation({ du_doan: obj.du_doan, side: obj.side, confidence: 50, pattern_chinh: null, agreement: 0 });
        return obj;
    }

    const pT = scoreT / totalScore;
    const pX = scoreX / totalScore;
    const margin = Math.abs(scoreT - scoreX) / totalScore;

    let side, random = false;
    // Nếu margin thấp hoặc confidence < 55 → random thông minh có bias
    if (margin < 0.12 || confidence < 55) {
        side = smartRandom(scoreT, scoreX, bias);
        random = true;
    } else {
        side = scoreT >= scoreX ? "T" : "X";
    }

    // Tính votes và agreement
    const votes = { T: 0, X: 0 };
    for (const ev of evidence) {
        if (ev.prediction === "Tài") votes.T++;
        else if (ev.prediction === "Xỉu") votes.X++;
    }
    const voteTotal = votes.T + votes.X;
    const agreement = voteTotal ? Math.max(votes.T, votes.X) / voteTotal : 0.5;

    // Điều chỉnh confidence dựa trên margin và agreement
    let finalConf = confidence;
    if (margin < 0.05) finalConf -= 10;
    else if (margin < 0.10) finalConf -= 5;
    if (agreement < 0.55) finalConf -= 5;
    if (random) finalConf = Math.min(finalConf, 60);
    finalConf = clamp(round(finalConf), 50, 97);

    // Lấy pattern chính (từ mô hình pattern)
    const mined = minePatterns(history);
    const main = mined.length ? mined[0] : null;

    const resultObj = {
        du_doan: result(side),
        side,
        do_tin_cay: `${finalConf.toFixed(2)}%`,
        confidence: finalConf,
        trang_thai: random ? "Tín hiệu yếu - Random thông minh" : "Ensemble phân tích",
        random,
        margin: round(margin * 100),
        score: { tai: round(scoreT, 4), xiu: round(scoreX, 4) },
        probability: { tai: round(pT * 100), xiu: round(pX * 100) },
        agreement: round(agreement * 100),
        votes,
        pattern_chinh: main ? {
            pattern: main.pattern,
            length: main.length,
            so_lan_gap: main.total,
            tai_sau_pattern: main.tai,
            xiu_sau_pattern: main.xiu,
            ty_le_tai: main.raw_tai,
            ty_le_xiu: main.raw_xiu,
            bayes_tai: main.bayes_tai,
            bayes_xiu: main.bayes_xiu,
            du_doan: result(main.prediction),
            do_tin_cay: `${main.confidence.toFixed(2)}%`
        } : null,
        pattern_candidates: mined.slice(0, 20).map(item => ({
            pattern: item.pattern,
            length: item.length,
            samples: item.total,
            tai: item.tai,
            xiu: item.xiu,
            confidence: item.confidence,
            prediction: result(item.prediction),
            strength: item.strength
        })),
        evidence
    };

    resultObj.recommendation = getRecommendation({
        du_doan: resultObj.du_doan,
        side: resultObj.side,
        confidence: resultObj.confidence,
        pattern_chinh: main,
        agreement: resultObj.agreement
    });

    // Lưu để cập nhật trọng số sau
    global.lastPrediction = { side, evidence: resultObj.evidence, confidence: finalConf };
    return resultObj;
}

// === Cập nhật kết quả và tối ưu trọng số ensemble ===
function updatePredictionResults(history) {
    let changed = false;
    for (const pred of predictionHistory) {
        if (pred.ket_qua !== "⌛ Chờ Kết Quả") continue;
        const actual = history.find(h => Number(h.phien) === Number(pred.phien));
        if (!actual) continue;
        pred.ket_qua = actual.ket_qua;
        pred.xuc_xac = actual.xuc_xac;
        pred.tong = actual.tong;
        pred.danh_gia = pred.du_doan === actual.ket_qua ? "✅ Thắng" : "❌ Thua";
        changed = true;
    }
    if (changed) savePredictions();
    rebuildLearning();

    // Cập nhật trọng số ensemble dựa trên kết quả gần nhất (nếu có)
    if (changed && global.lastPrediction) {
        const last = global.lastPrediction;
        const latest = history[history.length - 1];
        if (latest) {
            const actualSide = tx(latest.ket_qua);
            const isWin = last.side === actualSide;
            // Gradient descent đơn giản: tăng trọng số của các mô hình có evidence tích cực
            const evs = last.evidence || [];
            // Gom nhóm theo model
            const modelScores = { pattern: 0, markov: 0, trend: 0 };
            for (const ev of evs) {
                if (ev.model === "pattern") modelScores.pattern += (ev.weight || 0);
                else if (ev.model === "markov") modelScores.markov += (ev.weight || 0);
                else if (ev.model === "trend") modelScores.trend += (ev.weight || 0);
            }
            // Tổng trọng số từng mô hình
            const totalW = ensembleWeights.patternModel + ensembleWeights.markovModel + ensembleWeights.trendModel;
            if (totalW > 0) {
                const currentWeights = {
                    pattern: ensembleWeights.patternModel / totalW,
                    markov: ensembleWeights.markovModel / totalW,
                    trend: ensembleWeights.trendModel / totalW
                };
                // Điều chỉnh: nếu thắng, tăng trọng số mô hình có điểm cao; nếu thua, giảm
                const learningRate = 0.02;
                let adjustment = {};
                if (isWin) {
                    // Tăng trọng số các mô hình có điểm cao (dựa trên evidence)
                    const maxModel = Object.keys(modelScores).reduce((a, b) => modelScores[a] > modelScores[b] ? a : b);
                    adjustment = { [maxModel]: learningRate };
                } else {
                    // Giảm trọng số các mô hình có điểm cao
                    const maxModel = Object.keys(modelScores).reduce((a, b) => modelScores[a] > modelScores[b] ? a : b);
                    adjustment = { [maxModel]: -learningRate };
                }
                // Áp dụng
                for (const [model, delta] of Object.entries(adjustment)) {
                    if (model === "pattern") ensembleWeights.patternModel = clamp(ensembleWeights.patternModel + delta, 0.3, 3.0);
                    else if (model === "markov") ensembleWeights.markovModel = clamp(ensembleWeights.markovModel + delta, 0.3, 3.0);
                    else if (model === "trend") ensembleWeights.trendModel = clamp(ensembleWeights.trendModel + delta, 0.3, 3.0);
                }
                console.log("[Ensemble] Cập nhật trọng số:", ensembleWeights);
            }
        }
    }
}

// === Next Prediction ===
function createNextPrediction(history, analysis, pattern) {
    const latest = history[history.length - 1];
    if (!latest) return null;
    const nextPhien = Number(latest.phien) + 1;
    let record = predictionHistory.find(item => Number(item.phien) === nextPhien);
    if (!record) {
        record = {
            phien: nextPhien,
            du_doan: analysis.du_doan,
            do_tin_cay: analysis.do_tin_cay,
            ket_qua: "⌛ Chờ Kết Quả",
            danh_gia: "⌛ Chờ",
            xuc_xac: [],
            tong: "⌛ Chờ",
            pattern,
            random: analysis.random,
            trang_thai: analysis.trang_thai,
            created_at: new Date().toISOString()
        };
        predictionHistory.push(record);
    } else {
        record.du_doan = analysis.du_doan;
        record.do_tin_cay = analysis.do_tin_cay;
        record.pattern = pattern;
        record.random = analysis.random;
        record.trang_thai = analysis.trang_thai;
    }
    savePredictions();
    return record;
}

// === Main data ===
async function getData() {
    const now = Date.now();
    if (cache.prediction && now - cache.time < CACHE_MS) return cache;
    const history = await fetchHistory();
    updatePredictionResults(history);
    const pattern = buildPattern(history);
    const prediction = calculatePrediction(history);
    const next = createNextPrediction(history, prediction, pattern);
    cache = { time: now, history, pattern, prediction, next };
    return cache;
}

// === Routes ===
app.get("/api/taixiumd5", async (req, res) => {
    try {
        const data = await getData();
        const latest = data.history[data.history.length - 1];
        if (!latest) return res.status(503).json({ error: "Chưa có dữ liệu" });
        res.json({
            phien: latest.phien,
            xuc_xac: latest.xuc_xac,
            tong: latest.tong,
            ket_qua: latest.ket_qua,
            phien_hien_tai: data.next ? data.next.phien : latest.phien + 1,
            pattern: data.pattern,
            pattern_direction: "Cũ trái - Mới phải",
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/taixiumd5/detail", async (req, res) => {
    try {
        const data = await getData();
        const latest = data.history[data.history.length - 1];
        res.json({
            phien: latest.phien,
            xuc_xac: latest.xuc_xac,
            tong: latest.tong,
            ket_qua: latest.ket_qua,
            phien_hien_tai: data.next ? data.next.phien : latest.phien + 1,
            pattern: data.pattern,
            pattern_length: data.pattern.length,
            pattern_direction: "Cũ trái - Mới phải",
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random,
            margin: data.prediction.margin,
            pattern_chinh: data.prediction.pattern_chinh,
            pattern_candidates: data.prediction.pattern_candidates,
            score: data.prediction.score,
            probability: data.prediction.probability,
            agreement: data.prediction.agreement,
            votes: data.prediction.votes,
            evidence: data.prediction.evidence,
            tin_hieu: data.prediction.recommendation,
            next_prediction: data.next,
            history: data.history.slice(-MAX_PATTERN_HISTORY)
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/history", async (req, res) => {
    try {
        const data = await getData();
        updatePredictionResults(data.history);
        const output = predictionHistory.slice().sort((a, b) => b.phien - a.phien).slice(0, MAX_PREDICTION_HISTORY)
            .map(item => ({ phien: item.phien, du_doan: item.du_doan, ket_qua: item.ket_qua, danh_gia: item.danh_gia, xuc_xac: item.xuc_xac, tong: item.tong }));
        if (data.next && !output.some(i => Number(i.phien) === Number(data.next.phien))) {
            output.unshift({ phien: data.next.phien, du_doan: data.next.du_doan, ket_qua: "⌛ Chờ Kết Quả", danh_gia: "⌛ Chờ", xuc_xac: [], tong: "⌛ Chờ" });
        }
        res.json(output.slice(0, MAX_PREDICTION_HISTORY));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/pattern", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            pattern: data.pattern,
            length: data.pattern.length,
            direction: "Cũ trái - Mới phải",
            pattern_chinh: data.prediction.pattern_chinh,
            candidates: data.prediction.pattern_candidates,
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/analyze", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            phien: data.history[data.history.length - 1].phien,
            phien_hien_tai: data.next ? data.next.phien : null,
            pattern: data.pattern,
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random,
            margin: data.prediction.margin,
            pattern_chinh: data.prediction.pattern_chinh,
            pattern_candidates: data.prediction.pattern_candidates,
            score: data.prediction.score,
            probability: data.prediction.probability,
            agreement: data.prediction.agreement,
            votes: data.prediction.votes,
            evidence: data.prediction.evidence,
            tin_hieu: data.prediction.recommendation
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/signal", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            pattern_chinh: data.prediction.pattern_chinh,
            agreement: data.prediction.agreement,
            tin_hieu: data.prediction.recommendation
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/learning", (req, res) => {
    rebuildLearning();
    const patterns = {};
    for (const [pattern, data] of learnedPatterns) {
        patterns[pattern] = { total: data.total, win: data.win, lose: data.lose, win_rate: data.total ? round(data.win / data.total * 100) : 0 };
    }
    const finished = predictionHistory.filter(item => item.danh_gia === "✅ Thắng" || item.danh_gia === "❌ Thua");
    const wins = finished.filter(i => i.danh_gia === "✅ Thắng").length;
    res.json({
        total_predictions: finished.length,
        wins,
        loses: finished.length - wins,
        win_rate: finished.length ? round(wins / finished.length * 100) : 0,
        total_patterns: Object.keys(patterns).length,
        patterns,
        ensembleWeights
    });
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "TAI XIU MD5 - SIÊU PRO",
        source: SOURCE_API,
        pattern: "20 phiên - cũ trái - mới phải",
        algorithm: [
            "Ensemble Learning (3 mô hình)",
            "Pattern-based",
            "Markov-chain (1,2,3)",
            "Trend-based (Run, Cycle, Streak, Alternating)",
            "Dynamic Bias Correction",
            "Self Learning (online)",
            "Adaptive Weights (Gradient Descent)",
            "Smart Random (exploration)",
            "Tín hiệu báo tool thông minh"
        ],
        endpoints: ["/api/taixiumd5", "/api/taixiumd5/detail", "/api/txmd5/history", "/api/txmd5/pattern", "/api/txmd5/analyze", "/api/txmd5/signal", "/api/txmd5/learning"]
    });
});

setInterval(async () => { try { await getData(); } catch (e) { console.error("AUTO UPDATE:", e.message); } }, CACHE_MS);

app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log("   TAI XIU MD5 - SIÊU PRO");
    console.log(`   PORT: ${PORT}`);
    console.log(`   SOURCE: ${SOURCE_API}`);
    console.log("   ENSEMBLE 3 MÔ HÌNH: BẬT");
    console.log("   ADAPTIVE WEIGHTS: BẬT");
    console.log("   SMART RANDOM: BẬT");
    console.log("   TÍN HIỆU BÁO TOOL: BẬT");
    console.log("======================================");
});
