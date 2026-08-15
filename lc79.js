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

let cache = {
    time: 0,
    history: [],
    pattern: "",
    prediction: null,
    next: null
};

let predictionHistory = loadPredictions();
let learnedPatterns = new Map();

// === Adaptive Weights ===
let modelWeights = {
    pattern_chinh: 1.0,
    pattern_tuong_tu: 1.0,
    pattern_transform: 0.8,
    markov_1: 1.0,
    markov_2: 1.0,
    markov_3: 1.0,
    run: 1.2,
    streak: 1.0,
    alternating: 1.1,
    cycle: 0.9,
    self_learning: 0.8
};

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

function lightRandomPrediction(scoreT, scoreX) {
    const total = scoreT + scoreX;
    if (total <= 0) return Math.random() < 0.5 ? "T" : "X";
    let pT = scoreT / total;
    const noise = (Math.random() - 0.5) * 0.15;
    pT = clamp(pT + noise, 0.1, 0.9);
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
    } catch (e) {
        console.error("LOAD ERROR:", e.message);
        return [];
    }
}

function savePredictions() {
    try {
        predictionHistory = predictionHistory.sort((a, b) => a.phien - b.phien).slice(-MAX_PREDICTION_HISTORY);
        fs.writeFileSync(PREDICTION_FILE, JSON.stringify(predictionHistory, null, 2), "utf8");
    } catch (e) {
        console.error("SAVE ERROR:", e.message);
    }
}

// === Fetch API ===
async function fetchHistory() {
    const response = await fetch(SOURCE_API, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
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
            Number.isFinite(item.phien) &&
            item.xuc_xac.length === 3 &&
            item.xuc_xac.every(Number.isFinite) &&
            Number.isFinite(item.tong)
        )
        .sort((a, b) => a.phien - b.phien)
        .slice(-MAX_SOURCE_HISTORY);
}

// === Pattern Helpers ===
function getSides(history) { return history.map(i => tx(i.ket_qua)); }
function buildPattern(history) { return getSides(history).slice(-MAX_PATTERN_HISTORY).join(""); }

function bayesianRate(success, total) {
    const alpha = 2, beta = 2;
    return (success + alpha) / (total + alpha + beta);
}

function distributionConfidence(tai, xiu) {
    const total = tai + xiu;
    if (total <= 0) return 50;
    const pT = bayesianRate(tai, total);
    const pX = bayesianRate(xiu, total);
    return round(clamp(Math.max(pT, pX) * 100, 50, 97));
}

function getPatternStats(history, pattern) {
    const values = getSides(history);
    let tai = 0, xiu = 0, matches = [];
    for (let i = 0; i + pattern.length < values.length; i++) {
        const current = values.slice(i, i + pattern.length).join("");
        if (current !== pattern) continue;
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

// === Dynamic Pattern Mining ===
function minePatterns(history) {
    const values = getSides(history);
    const maxLen = Math.min(MAX_PATTERN_LENGTH, values.length - 1);
    const patterns = [];
    for (let len = MIN_PATTERN_LENGTH; len <= maxLen; len++) {
        const pattern = values.slice(-len).join("");
        const stats = getPatternStats(history, pattern);
        if (!stats || stats.total < MIN_EXACT_SAMPLES) continue;
        const sampleFactor = Math.min(1, stats.total / 10);
        const lengthFactor = 1 + Math.min(0.9, len / 15);
        const confidenceFactor = stats.confidence / 100;
        const strength = sampleFactor * lengthFactor * confidenceFactor;
        patterns.push({ ...stats, strength: round(strength, 4) });
    }
    return patterns.sort((a, b) => b.strength - a.strength);
}

// === Similar Pattern ===
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
        const candidate = values.slice(i, i + len).join("");
        if (candidate === currentPattern) continue;
        const score = similarity(currentPattern, candidate);
        if (score < 0.70) continue;
        const next = values[i + len];
        const weight = Math.pow(score, 4);
        if (next === "T") tai += weight; else xiu += weight;
        matches.push({ pattern: candidate, similarity: round(score * 100), next: result(next), weight: round(weight, 4) });
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

// === Transform ===
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

// === Run Pattern ===
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

    const specialPatterns = [
        ["1-1", 0.82], ["2-2", 0.82], ["3-3", 0.80], ["4-4", 0.78],
        ["1-2", 0.76], ["2-1", 0.76], ["1-3", 0.75], ["3-1", 0.75],
        ["1-4", 0.74], ["4-1", 0.74], ["1-5", 0.73], ["5-1", 0.73],
        ["1-2-1", 0.82], ["2-1-2", 0.82], ["1-3-1", 0.81], ["3-1-3", 0.81],
        ["1-4-1", 0.79], ["4-1-4", 0.79], ["1-2-3", 0.79], ["2-3-4", 0.80],
        ["3-4-5", 0.81], ["3-2-1", 0.79], ["4-3-2", 0.80], ["5-4-3", 0.81],
        ["1-2-3-4", 0.84], ["2-3-4-5", 0.85], ["1-2-3-4-5", 0.87],
        ["4-3-2-1", 0.84], ["5-4-3-2", 0.85], ["5-4-3-2-1", 0.87],
        ["1-2-1-2", 0.83], ["2-1-2-1", 0.83], ["1-3-1-3", 0.82], ["3-1-3-1", 0.82],
        ["2-3-2-3", 0.82], ["3-2-3-2", 0.82],
        ["1-2-3-2-1", 0.87], ["2-3-4-3-2", 0.88], ["3-4-5-4-3", 0.88],
        ["1-2-3-4-3-2-1", 0.91], ["2-3-4-5-4-3-2", 0.91],
        ["1-2-3-4-5-4-3-2-1", 0.93],
        ["1-2-2-1", 0.80], ["2-1-1-2", 0.80], ["1-3-3-1", 0.79], ["3-1-1-3", 0.79],
        ["1-1-2-2", 0.80], ["2-2-1-1", 0.80], ["1-1-3-3", 0.79], ["3-3-1-1", 0.79],
        ["1-2-3-1-2-3", 0.85], ["2-3-4-2-3-4", 0.86],
        ["1-3-2-3-1", 0.83], ["2-4-3-4-2", 0.84],
        ["1-3-2-4", 0.78], ["4-2-3-1", 0.78],
        ["2-3-1-2", 0.78], ["1-2-4-2", 0.78],
        ["1-2-1-3-1-2-1", 0.87], ["2-1-2-3-2-1-2", 0.87],
        ["1-2-3-3-2-1", 0.87], ["2-3-4-4-3-2", 0.88],
        ["1-2-3-2-3-4", 0.84], ["2-3-2-3-4-3", 0.84],
        ["1-3-2-1-2-3", 0.82], ["3-1-2-3-2-1", 0.82]
    ];
    for (const [pattern, weight] of specialPatterns) {
        const current = lengths.slice(-pattern.split("-").length).join("-");
        if (current === pattern) add(pattern, opposite(last.side), weight);
    }

    // Tăng/giảm
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

    // Đối xứng
    for (let len = 3; len <= 7; len++) {
        const part = lengths.slice(-len);
        if (part.join(",") === [...part].reverse().join(","))
            add(`symmetric-${len}`, opposite(last.side), clamp(0.72 + len * 0.025, 0.72, 0.90));
    }

    // Chu kỳ
    for (let period = 2; period <= 4; period++) {
        if (lengths.length < period * 2) continue;
        const a = lengths.slice(-period);
        const b = lengths.slice(-period * 2, -period);
        if (a.join(",") === b.join(","))
            add(`run-cycle-${period}`, opposite(last.side), clamp(0.76 + period * 0.025, 0.76, 0.86));
    }

    return { signature: getRuns(history).slice(-10).map(i => i.count).join("-"), runs: recent, signals };
}

// === Markov ===
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

// === Cycle ===
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

// === Streak ===
function analyzeStreak(history) {
    const v = getSides(history);
    if (!v.length) return null;
    const last = v[v.length - 1];
    let count = 0;
    for (let i = v.length - 1; i >= 0; i--) {
        if (v[i] === last) count++; else break;
    }
    return {
        side: last, count,
        prediction: count >= 3 ? opposite(last) : last,
        weight: clamp(0.55 + count * 0.04, 0.55, 0.82)
    };
}

// === Alternating ===
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

// === Self Learning ===
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

// === Pattern Quality (Tín hiệu báo tool) ===
function isPatternGood(prediction) {
    const pattern = prediction.pattern_chinh;
    if (!pattern) return false;
    const conf = pattern.do_tin_cay ? parseFloat(pattern.do_tin_cay) : 0;
    const samples = pattern.so_lan_gap || 0;
    const agree = prediction.agreement || 0;
    return conf >= 60 && samples >= 4 && agree >= 65;
}

function getRecommendation(prediction) {
    const du_doan = prediction.du_doan;
    const do_tin_cay = prediction.confidence || 50;
    const side = prediction.side;
    // Nếu độ tin cậy >= 60% → THEO
    if (do_tin_cay >= 60) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% >= 60%, theo dự đoán ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    }
    const good = isPatternGood(prediction);
    if (good) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 60%, nhưng pattern đẹp → theo dự đoán ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    } else {
        const side_bo = side === "T" ? "X" : "T";
        return {
            khuyen_nghi: "BẺ",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 60% và pattern xấu → bẻ sang ${result(side_bo)}`,
            side_theo: side_bo,
            side_bo: side
        };
    }
}

// === MAIN PREDICTION (nâng cấp) ===
function calculatePrediction(history) {
    const values = getSides(history);
    if (values.length < 5) {
        const randomSide = lightRandomPrediction(0, 0);
        const obj = {
            du_doan: result(randomSide), side: randomSide,
            do_tin_cay: "50.00%", confidence: 50,
            trang_thai: "Chưa đủ dữ liệu - Random nhẹ",
            random: true, pattern_chinh: null,
            score: { tai: 0, xiu: 0 }, evidence: []
        };
        obj.recommendation = getRecommendation({ du_doan: obj.du_doan, side: obj.side, confidence: obj.confidence, pattern_chinh: null, agreement: 0 });
        return obj;
    }

    // === Tỉ lệ Tài/Xỉu trong lịch sử để cân bằng ===
    const totalHistory = history.length;
    let countT = 0, countX = 0;
    for (const h of history) {
        if (tx(h.ket_qua) === "T") countT++; else countX++;
    }
    const ratioT = countT / totalHistory;
    const ratioX = countX / totalHistory;
    // Nếu một bên > 60% thì áp dụng điều chỉnh
    const biasCorrection = (ratioT > 0.60) ? 0.85 : (ratioX > 0.60) ? 1.15 : 1.0;

    // === Khai thác pattern ===
    const mined = minePatterns(history);
    const main = mined.length ? mined[0] : null;
    const currentPattern = values.slice(-6).join("");
    const patternForAnalysis = main ? main.pattern : currentPattern;

    const similar = mineSimilarPatterns(history, patternForAnalysis);
    const transformed = analyzeTransformedPatterns(history, patternForAnalysis);
    const markov1 = analyzeMarkov1(history);
    const markov2 = analyzeMarkov2(history);
    const markov3 = analyzeMarkov3(history);
    const cycles = analyzeCycles(history);
    const run = analyzeRunPattern(history);
    const streak = analyzeStreak(history);
    const alternating = analyzeAlternating(history);
    const learning = getLearningScore(patternForAnalysis);

    let score = { T: 0, X: 0 };
    const evidence = [];

    // Hàm thêm tín hiệu
    function addSignal(type, pT, pX, weight, extra = {}) {
        const w = weight * (modelWeights[type] || 1.0);
        score.T += pT * w;
        score.X += pX * w;
        evidence.push({ type, ...extra, weight: round(w, 2) });
    }

    // Pattern chính
    if (main) {
        const weight = clamp(3 + main.length * 0.4 + Math.log2(main.total + 1), 3, 8);
        addSignal("pattern_chinh", main.pT, main.pX, weight, {
            pattern: main.pattern, length: main.length, samples: main.total,
            tai: main.tai, xiu: main.xiu, ty_le_tai: main.raw_tai, ty_le_xiu: main.raw_xiu,
            bayes_tai: main.bayes_tai, bayes_xiu: main.bayes_xiu,
            confidence: main.confidence
        });
    }

    // Pattern tương tự
    if (similar && similar.matches >= MIN_EXACT_SAMPLES) {
        const weight = clamp(1.5 + similar.matches * 0.04, 1.5, 3);
        addSignal("pattern_tuong_tu", similar.pT, similar.pX, weight, {
            matches: similar.matches, confidence: similar.confidence,
            prediction: result(similar.prediction)
        });
    }

    // Pattern transform
    for (const item of transformed) {
        const weight = clamp(0.5 + item.length * 0.06, 0.5, 1.5);
        addSignal("pattern_transform", item.pT, item.pX, weight, {
            pattern: item.pattern, samples: item.total,
            prediction: result(item.prediction), confidence: item.confidence
        });
    }

    // Markov
    if (markov1) addSignal("markov_1", markov1.pT, markov1.pX, 1.5, { key: markov1.key, samples: markov1.total, prediction: result(markov1.pT >= markov1.pX ? "T" : "X") });
    if (markov2) addSignal("markov_2", markov2.pT, markov2.pX, 2.0, { key: markov2.key, samples: markov2.total, prediction: result(markov2.pT >= markov2.pX ? "T" : "X") });
    if (markov3) addSignal("markov_3", markov3.pT, markov3.pX, 2.2, { key: markov3.key, samples: markov3.total, prediction: result(markov3.pT >= markov3.pX ? "T" : "X") });

    // Run
    if (run && run.signals.length) {
        for (const sig of run.signals) {
            const pT = sig.prediction === "T" ? 1 : 0;
            const pX = sig.prediction === "X" ? 1 : 0;
            addSignal("run", pT, pX, sig.weight * 1.5, { pattern: sig.name, prediction: result(sig.prediction) });
        }
    }

    // Streak
    if (streak) {
        const pT = streak.prediction === "T" ? 1 : 0;
        const pX = streak.prediction === "X" ? 1 : 0;
        addSignal("streak", pT, pX, streak.weight, { count: streak.count, prediction: result(streak.prediction) });
    }

    // Alternating
    if (alternating) {
        const pT = alternating.prediction === "T" ? 1 : 0;
        const pX = alternating.prediction === "X" ? 1 : 0;
        addSignal("alternating", pT, pX, alternating.weight, { pattern: alternating.pattern, prediction: result(alternating.prediction) });
    }

    // Cycle
    for (const cycle of cycles) {
        const weight = clamp(0.7 + cycle.total * 0.06, 0.7, 1.6);
        addSignal("cycle", cycle.pT, cycle.pX, weight, { period: cycle.period, samples: cycle.total, confidence: cycle.confidence, prediction: result(cycle.prediction) });
    }

    // Self learning
    if (learning) {
        const pred = main ? main.prediction : (score.T >= score.X ? "T" : "X");
        const pT = pred === "T" ? 1 : 0;
        const pX = pred === "X" ? 1 : 0;
        const weight = clamp(0.5 + learning.total * 0.1, 0.5, 2);
        addSignal("self_learning", pT, pX, weight, {
            pattern: patternForAnalysis, total: learning.total, win: learning.win,
            lose: learning.lose, win_rate: learning.win_rate,
            prediction: result(pred)
        });
    }

    // === Áp dụng bias correction ===
    if (biasCorrection !== 1.0) {
        score.T *= biasCorrection;
        score.X *= (2 - biasCorrection); // đảm bảo tổng không đổi
        evidence.push({
            type: "bias_correction",
            correction: round(biasCorrection, 2),
            note: ratioT > 0.60 ? "Giảm điểm Tài do đang chiếm ưu thế" : "Tăng điểm Tài do đang thiếu"
        });
    }

    const totalScore = score.T + score.X;
    if (totalScore <= 0) {
        const randomSide = lightRandomPrediction(0, 0);
        const obj = {
            du_doan: result(randomSide), side: randomSide,
            do_tin_cay: "50.00%", confidence: 50,
            trang_thai: "Không có tín hiệu - Random nhẹ",
            random: true, pattern_chinh: main,
            score: { tai: round(score.T, 4), xiu: round(score.X, 4) },
            evidence, margin: 0, probability: { tai: 50, xiu: 50 },
            agreement: 50, votes: { T: 0, X: 0 },
            pattern_candidates: mined.slice(0, 20).map(item => ({
                pattern: item.pattern, length: item.length,
                samples: item.total, tai: item.tai, xiu: item.xiu,
                confidence: item.confidence, prediction: result(item.prediction),
                strength: item.strength
            }))
        };
        obj.recommendation = getRecommendation({ du_doan: obj.du_doan, side: obj.side, confidence: obj.confidence, pattern_chinh: main, agreement: 0 });
        return obj;
    }

    const margin = Math.abs(score.T - score.X) / totalScore;
    let side, random = false;
    const pT = score.T / totalScore;
    const pX = score.X / totalScore;

    // Nếu margin thấp hoặc tín hiệu yếu → random thông minh
    if (margin < 0.15 || Math.max(pT, pX) < 0.55) {
        side = lightRandomPrediction(score.T, score.X);
        random = true;
    } else {
        side = score.T >= score.X ? "T" : "X";
    }

    // Tính votes và agreement
    const votes = { T: 0, X: 0 };
    for (const item of evidence) {
        if (item.prediction === "Tài") votes.T++;
        else if (item.prediction === "Xỉu") votes.X++;
    }
    const voteTotal = votes.T + votes.X;
    const agreement = voteTotal ? Math.max(votes.T, votes.X) / voteTotal : 0.5;

    const mainConfidence = main ? Math.max(main.pT, main.pX) : 0.5;
    const scoreConfidence = Math.max(pT, pX);
    let confidence = (scoreConfidence * 0.50 + mainConfidence * 0.30 + agreement * 0.20) * 100;

    // Giới hạn dựa trên số mẫu
    if (!main) confidence = Math.min(confidence, 65);
    else if (main.total < 3) confidence = Math.min(confidence, 68);
    else if (main.total < 5) confidence = Math.min(confidence, 75);
    else if (main.total < 8) confidence = Math.min(confidence, 82);

    // Giảm confidence nếu margin thấp
    if (margin < 0.05) confidence -= 12;
    else if (margin < 0.10) confidence -= 8;
    else if (margin < 0.15) confidence -= 4;

    if (agreement < 0.55) confidence -= 5;

    confidence = clamp(round(confidence), 50, 97);
    if (random) confidence = Math.min(confidence, 62);

    const resultObj = {
        du_doan: result(side),
        side,
        do_tin_cay: `${confidence.toFixed(2)}%`,
        confidence,
        trang_thai: random ? "Tín hiệu yếu - Random nhẹ" : "Phân tích Pattern",
        random,
        margin: round(margin * 100),
        score: { tai: round(score.T, 4), xiu: round(score.X, 4) },
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
            pattern: item.pattern, length: item.length,
            samples: item.total, tai: item.tai, xiu: item.xiu,
            confidence: item.confidence, prediction: result(item.prediction),
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

    // Cập nhật trọng số dựa trên kết quả sau này (sẽ được gọi từ update)
    // Lưu tạm vào global để dùng sau
    if (!global.lastPrediction) global.lastPrediction = {};
    global.lastPrediction = { side, evidence, confidence };

    return resultObj;
}

// === Cập nhật kết quả và học online ===
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

    // Cập nhật trọng số thích ứng dựa trên kết quả gần nhất
    if (changed && global.lastPrediction) {
        const last = global.lastPrediction;
        const latestHistory = history[history.length - 1];
        if (latestHistory) {
            const actualSide = tx(latestHistory.ket_qua);
            const isWin = last.side === actualSide;
            // Điều chỉnh trọng số của các tín hiệu đã sử dụng
            for (const ev of last.evidence) {
                if (ev.type && modelWeights[ev.type] !== undefined) {
                    // Tăng/giảm nhẹ dựa trên kết quả
                    const adjustment = isWin ? 1.02 : 0.98;
                    modelWeights[ev.type] = clamp(modelWeights[ev.type] * adjustment, 0.5, 2.0);
                }
            }
            // In ra log để theo dõi
            console.log(`[Adaptive] Cập nhật trọng số: ${isWin ? '✅ Thắng' : '❌ Thua'}`, modelWeights);
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
            pattern_direction: "Cũ bên trái - Mới bên phải",
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
            pattern_direction: "Cũ bên trái - Mới bên phải",
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/txmd5/history", async (req, res) => {
    try {
        const data = await getData();
        updatePredictionResults(data.history);
        const output = predictionHistory.slice().sort((a, b) => b.phien - a.phien).slice(0, MAX_PREDICTION_HISTORY)
            .map(item => ({
                phien: item.phien,
                du_doan: item.du_doan,
                ket_qua: item.ket_qua,
                danh_gia: item.danh_gia,
                xuc_xac: item.xuc_xac,
                tong: item.tong
            }));
        if (data.next && !output.some(i => Number(i.phien) === Number(data.next.phien))) {
            output.unshift({
                phien: data.next.phien,
                du_doan: data.next.du_doan,
                ket_qua: "⌛ Chờ Kết Quả",
                danh_gia: "⌛ Chờ",
                xuc_xac: [],
                tong: "⌛ Chờ"
            });
        }
        res.json(output.slice(0, MAX_PREDICTION_HISTORY));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/txmd5/pattern", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            pattern: data.pattern,
            length: data.pattern.length,
            direction: "Cũ bên trái - Mới bên phải",
            pattern_chinh: data.prediction.pattern_chinh,
            candidates: data.prediction.pattern_candidates,
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            trang_thai: data.prediction.trang_thai,
            random: data.prediction.random
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/txmd5/learning", (req, res) => {
    rebuildLearning();
    const patterns = {};
    for (const [pattern, data] of learnedPatterns) {
        patterns[pattern] = {
            total: data.total,
            win: data.win,
            lose: data.lose,
            win_rate: data.total ? round(data.win / data.total * 100) : 0
        };
    }
    const finished = predictionHistory.filter(item => item.danh_gia === "✅ Thắng" || item.danh_gia === "❌ Thua");
    const wins = finished.filter(i => i.danh_gia === "✅ Thắng").length;
    const loses = finished.length - wins;
    res.json({
        total_predictions: finished.length,
        wins,
        loses,
        win_rate: finished.length ? round(wins / finished.length * 100) : 0,
        total_patterns: Object.keys(patterns).length,
        patterns,
        modelWeights
    });
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "TAI XIU MD5 - NÂNG CẤP",
        source: SOURCE_API,
        pattern: "20 phiên - cũ bên trái - mới bên phải",
        random: "Random thông minh + cân bằng động",
        algorithm: [
            "Dynamic Pattern Miner (tối ưu)",
            "Similar Pattern (điều chỉnh)",
            "Pattern Transform",
            "Markov 1-2-3 (có trọng số thích ứng)",
            "Run Pattern + Cầu đặc biệt",
            "Cycle Analysis",
            "Streak & Alternating",
            "Self Learning (online)",
            "Bayesian với prior động",
            "Bias Correction (cân bằng tỉ lệ)",
            "Adaptive Weights (học từ kết quả)",
            "Smart Random (exploration)",
            "Tín hiệu báo tool (THEO/BẺ thông minh)"
        ],
        endpoints: [
            "/api/taixiumd5",
            "/api/taixiumd5/detail",
            "/api/txmd5/history",
            "/api/txmd5/pattern",
            "/api/txmd5/analyze",
            "/api/txmd5/signal",
            "/api/txmd5/learning"
        ]
    });
});

setInterval(async () => { try { await getData(); } catch (e) { console.error("AUTO UPDATE:", e.message); } }, CACHE_MS);

app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log("   TAI XIU MD5 - NÂNG CẤP");
    console.log(`   PORT: ${PORT}`);
    console.log(`   SOURCE: ${SOURCE_API}`);
    console.log("   PATTERN: 20 PHIEN (CŨ TRÁI - MỚI PHẢI)");
    console.log("   CÂN BẰNG ĐỘNG: BẬT");
    console.log("   TRỌNG SỐ THÍCH ỨNG: BẬT");
    console.log("   RANDOM THÔNG MINH: BẬT");
    console.log("   TÍN HIỆU BÁO TOOL: BẬT");
    console.log("======================================");
});
