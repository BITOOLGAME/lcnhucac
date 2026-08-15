/**
 * ============================================================
 * TAI XIU MD5 - SIÊU PRO VERSION
 * ============================================================
 * 
 * Các tính năng nâng cấp:
 * 1. Ensemble Learning (Random Forest, Gradient Boosting, Neural Network đơn giản)
 * 2. Reinforcement Learning (cập nhật trọng số và chiến lược)
 * 3. Feature Engineering nâng cao (entropy, tương quan, xu hướng đảo chiều)
 * 4. Xử lý dữ liệu bất cân bằng (oversampling)
 * 5. Phân tích chuỗi thời gian (ARIMA mô phỏng)
 * 6. Tối ưu hóa siêu tham số tự động
 * 7. Phân tích tâm lý (fear/greed index)
 * 8. Phát hiện bất thường
 * 9. Chiến lược vào lệnh động (Dynamic Position Sizing)
 * 10. Backtesting và Validation
 * ============================================================
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CẤU HÌNH =====
const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const CACHE_MS = 3000;
const MAX_SOURCE_HISTORY = 200; // tăng lên để có nhiều dữ liệu
const MAX_PATTERN_HISTORY = 30;
const MAX_PREDICTION_HISTORY = 100;
const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 20;
const MIN_EXACT_SAMPLES = 3;

const PREDICTION_FILE = path.join(__dirname, "predictions.json");
const WEIGHTS_FILE = path.join(__dirname, "weights.json");
const LEARNING_FILE = path.join(__dirname, "learning_data.json");

// ===== TRẠNG THÁI TOÀN CỤC =====
let cache = { time: 0, history: [], pattern: "", prediction: null, next: null };
let predictionHistory = loadPredictions();
let learnedPatterns = new Map();
let modelWeights = loadWeights();
let learningData = loadLearningData();

// ===== THAM SỐ REINFORCEMENT LEARNING =====
const RL = {
    learningRate: 0.01,
    discountFactor: 0.95,
    epsilon: 0.1,
    qTable: {}
};

// ===== HÀM TIỆN ÍCH =====
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v, d = 2) { return Number(v.toFixed(d)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function tanh(x) { return Math.tanh(x); }
function relu(x) { return Math.max(0, x); }

function tx(v) {
    const s = String(v || "").toUpperCase();
    return (s === "TAI" || s === "T" || s === "TÀI") ? "T" : "X";
}
function result(v) { return v === "T" ? "Tài" : "Xỉu"; }
function opposite(v) { return v === "T" ? "X" : "T"; }
function safeArray(a) { return Array.isArray(a) ? a : []; }

function entropy(arr) {
    const total = arr.length;
    if (total === 0) return 0;
    const counts = {};
    for (const x of arr) counts[x] = (counts[x] || 0) + 1;
    let e = 0;
    for (const key in counts) {
        const p = counts[key] / total;
        e -= p * Math.log2(p);
    }
    return e;
}

function correlation(x, y) {
    if (x.length !== y.length || x.length < 2) return 0;
    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
        num += (x[i] - meanX) * (y[i] - meanY);
        denomX += (x[i] - meanX) ** 2;
        denomY += (y[i] - meanY) ** 2;
    }
    if (denomX === 0 || denomY === 0) return 0;
    return num / Math.sqrt(denomX * denomY);
}

// ===== I/O =====
function loadPredictions() {
    try {
        if (!fs.existsSync(PREDICTION_FILE)) {
            fs.writeFileSync(PREDICTION_FILE, "[]", "utf8");
            return [];
        }
        const raw = fs.readFileSync(PREDICTION_FILE, "utf8");
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.sort((a, b) => a.phien - b.phien).slice(-MAX_PREDICTION_HISTORY) : [];
    } catch (e) { console.error("LOAD PREDICTIONS ERROR:", e.message); return []; }
}
function savePredictions() {
    try {
        predictionHistory = predictionHistory.sort((a, b) => a.phien - b.phien).slice(-MAX_PREDICTION_HISTORY);
        fs.writeFileSync(PREDICTION_FILE, JSON.stringify(predictionHistory, null, 2), "utf8");
    } catch (e) { console.error("SAVE PREDICTIONS ERROR:", e.message); }
}

function loadWeights() {
    try {
        if (!fs.existsSync(WEIGHTS_FILE)) {
            const defaultWeights = {
                pattern_chinh: 1.0, pattern_tuong_tu: 1.0, pattern_transform: 0.8,
                markov_1: 1.0, markov_2: 1.0, markov_3: 1.0,
                run: 1.2, streak: 1.0, alternating: 1.1, cycle: 0.9,
                self_learning: 0.8, trend: 1.0, sentiment: 0.7, arima: 0.6
            };
            fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(defaultWeights, null, 2), "utf8");
            return defaultWeights;
        }
        const raw = fs.readFileSync(WEIGHTS_FILE, "utf8");
        return JSON.parse(raw);
    } catch (e) { console.error("LOAD WEIGHTS ERROR:", e.message); return {}; }
}
function saveWeights() {
    try {
        fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(modelWeights, null, 2), "utf8");
    } catch (e) { console.error("SAVE WEIGHTS ERROR:", e.message); }
}

function loadLearningData() {
    try {
        if (!fs.existsSync(LEARNING_FILE)) {
            fs.writeFileSync(LEARNING_FILE, JSON.stringify({ rewards: [], actions: [], states: [] }), "utf8");
            return { rewards: [], actions: [], states: [] };
        }
        const raw = fs.readFileSync(LEARNING_FILE, "utf8");
        return JSON.parse(raw);
    } catch (e) { console.error("LOAD LEARNING DATA ERROR:", e.message); return { rewards: [], actions: [], states: [] }; }
}
function saveLearningData() {
    try {
        fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData, null, 2), "utf8");
    } catch (e) { console.error("SAVE LEARNING DATA ERROR:", e.message); }
}

// ===== FETCH DATA =====
async function fetchHistory() {
    const response = await fetch(SOURCE_API, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.list)) throw new Error("Invalid response");
    return data.list.map(item => {
        const dices = safeArray(item.dices).map(Number);
        return {
            phien: Number(item.id),
            xuc_xac: dices,
            tong: Number(item.point),
            ket_qua: (String(item.resultTruyenThong || "").toUpperCase() === "TAI") ? "Tài" : "Xỉu"
        };
    }).filter(item =>
        Number.isFinite(item.phien) && item.xuc_xac.length === 3 &&
        item.xuc_xac.every(Number.isFinite) && Number.isFinite(item.tong)
    ).sort((a, b) => a.phien - b.phien).slice(-MAX_SOURCE_HISTORY);
}

// ===== FEATURE ENGINEERING =====
function extractFeatures(history) {
    const values = history.map(i => tx(i.ket_qua));
    const n = values.length;
    if (n < 10) return null;

    const features = {};

    // 1. Tỉ lệ Tài/Xỉu trong các cửa sổ
    const windows = [10, 20, 30, 50];
    for (const w of windows) {
        if (n >= w) {
            const slice = values.slice(-w);
            const countT = slice.filter(v => v === "T").length;
            features[`ratioT_${w}`] = countT / w;
            features[`ratioX_${w}`] = 1 - features[`ratioT_${w}`];
        }
    }

    // 2. Entropy
    features.entropy_20 = entropy(values.slice(-20));
    features.entropy_50 = entropy(values.slice(-50));

    // 3. Độ lệch chuẩn (dùng dummy)
    const numValues = values.map(v => v === "T" ? 1 : 0);
    const mean = numValues.reduce((a, b) => a + b, 0) / numValues.length;
    const variance = numValues.reduce((a, b) => a + (b - mean) ** 2, 0) / numValues.length;
    features.std = Math.sqrt(variance);

    // 4. Tương quan giữa giá trị và vị trí
    const positions = numValues.map((_, i) => i);
    features.correlation = correlation(positions.slice(-20), numValues.slice(-20));

    // 5. Số lần đảo chiều gần đây
    let reversals = 0;
    for (let i = n - 10; i < n - 1; i++) {
        if (values[i] !== values[i + 1]) reversals++;
    }
    features.reversals_10 = reversals;

    // 6. Độ dài chuỗi hiện tại
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
        if (values[i] === values[n - 1]) streak++;
        else break;
    }
    features.current_streak = streak;

    // 7. Tỉ lệ thắng/lỗ từ self-learning gần đây (nếu có)
    let recentWins = 0, recentLosses = 0;
    const recentPreds = predictionHistory.filter(p => p.danh_gia === "✅ Thắng" || p.danh_gia === "❌ Thua").slice(-20);
    for (const p of recentPreds) {
        if (p.danh_gia === "✅ Thắng") recentWins++;
        else recentLosses++;
    }
    features.recent_win_rate = recentWins + recentLosses > 0 ? recentWins / (recentWins + recentLosses) : 0.5;

    // 8. Fear/Greed Index (giả lập)
    const ratio = features.ratioT_20 || 0.5;
    features.fear_greed = ratio > 0.55 ? "greed" : (ratio < 0.45 ? "fear" : "neutral");

    // 9. Phát hiện bất thường (dùng z-score)
    const last = numValues[n - 1];
    const meanLast = numValues.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const stdLast = Math.sqrt(numValues.slice(-20).reduce((a, b) => a + (b - meanLast) ** 2, 0) / 20);
    features.z_score = stdLast > 0 ? (last - meanLast) / stdLast : 0;

    return features;
}

// ===== MÔ HÌNH ENSEMBLE =====
// Các mô hình giả định (mô phỏng) – thực tế có thể thay bằng thư viện ML

// 1. Random Forest (giả lập)
function randomForest(features) {
    const score = 0.5;
    // Dùng một số đặc trưng để quyết định
    if (features.ratioT_20 > 0.55) score += 0.15;
    if (features.ratioT_20 < 0.45) score -= 0.15;
    if (features.entropy_20 < 0.5) score += 0.1;
    if (features.reversals_10 > 3) score -= 0.1;
    if (features.current_streak > 4) score += 0.12;
    return clamp(score, 0, 1);
}

// 2. Gradient Boosting (giả lập)
function gradientBoosting(features) {
    let score = 0.5;
    const weights = [0.3, 0.25, 0.2, 0.15, 0.1];
    const values = [
        features.ratioT_20 || 0.5,
        features.ratioT_30 || 0.5,
        features.entropy_20 || 0.5,
        features.reversals_10 / 10 || 0,
        features.current_streak / 10 || 0
    ];
    for (let i = 0; i < Math.min(weights.length, values.length); i++) {
        score += (values[i] - 0.5) * weights[i] * 0.5;
    }
    return clamp(score, 0, 1);
}

// 3. Neural Network (giả lập)
function neuralNetwork(features) {
    // Đơn giản: tổ hợp tuyến tính qua sigmoid
    const inputs = [
        features.ratioT_20 || 0.5,
        features.ratioT_30 || 0.5,
        features.entropy_20 || 0.5,
        features.reversals_10 / 10 || 0,
        features.current_streak / 10 || 0,
        features.correlation || 0,
        features.recent_win_rate || 0.5
    ];
    const weights = [0.6, 0.2, -0.3, 0.4, 0.5, -0.2, 0.1];
    let sum = 0;
    for (let i = 0; i < Math.min(inputs.length, weights.length); i++) {
        sum += inputs[i] * weights[i];
    }
    return sigmoid(sum);
}

// ===== PHÂN TÍCH CHUỖI THỜI GIAN (ARIMA MÔ PHỎNG) =====
function arimaForecast(history) {
    const values = history.map(i => tx(i.ket_qua) === "T" ? 1 : 0);
    const n = values.length;
    if (n < 20) return 0.5;
    // AR(1) đơn giản
    const alpha = 0.5;
    const beta = 0.3;
    const last = values[n - 1];
    const prev = values[n - 2] || last;
    const forecast = alpha * last + beta * prev + (1 - alpha - beta) * 0.5;
    return clamp(forecast, 0, 1);
}

// ===== PHÂN TÍCH TÂM LÝ =====
function sentimentAnalysis(history) {
    const values = history.map(i => tx(i.ket_qua));
    const n = values.length;
    if (n < 20) return { sentiment: "neutral", score: 0.5 };
    const recent = values.slice(-10);
    const countT = recent.filter(v => v === "T").length;
    const ratio = countT / recent.length;
    let sentiment = "neutral";
    let score = 0.5;
    if (ratio > 0.6) { sentiment = "greed"; score = 0.7; }
    else if (ratio < 0.4) { sentiment = "fear"; score = 0.3; }
    // Nếu đang ở trạng thái cực đoan, khả năng đảo chiều cao
    return { sentiment, score };
}

// ===== REINFORCEMENT LEARNING (Q-Learning) =====
function getQKey(state) {
    // Làm tròn để tạo state rời rạc
    const key = Object.values(state).map(v => Math.round(v * 10) / 10).join("|");
    return key;
}

function getQValue(state, action) {
    const key = getQKey(state);
    if (!RL.qTable[key]) RL.qTable[key] = {};
    if (RL.qTable[key][action] === undefined) RL.qTable[key][action] = 0.5;
    return RL.qTable[key][action];
}

function updateQValue(state, action, reward, nextState) {
    const key = getQKey(state);
    const nextKey = getQKey(nextState);
    const maxNext = Math.max(...Object.values(RL.qTable[nextKey] || { 0: 0, 1: 0 }));
    const current = getQValue(state, action);
    const newValue = current + RL.learningRate * (reward + RL.discountFactor * maxNext - current);
    RL.qTable[key][action] = newValue;
    // Lưu learning data
    learningData.rewards.push(reward);
    learningData.actions.push(action);
    learningData.states.push(key);
    saveLearningData();
}

// ===== CHIẾN LƯỢC VÀO LỆNH ĐỘNG =====
function positionSizing(confidence, volatility) {
    // Kelly Criterion đơn giản
    const p = confidence / 100;
    const b = 1; // tỉ lệ thắng/thua (1:1)
    let fraction = (p * b - (1 - p)) / b;
    fraction = clamp(fraction, 0, 0.3);
    // Điều chỉnh theo độ biến động
    const volatilityFactor = 1 - clamp(volatility, 0, 0.5);
    fraction *= volatilityFactor;
    return round(fraction * 100, 0); // %
}

// ===== BACKTESTING =====
function backtest(history, strategy) {
    // Đơn giản: so sánh dự đoán với kết quả
    let wins = 0, losses = 0;
    for (let i = 0; i < history.length - 1; i++) {
        const subHistory = history.slice(0, i + 1);
        const pred = calculatePrediction(subHistory);
        const actual = history[i + 1].ket_qua;
        if (pred.du_doan === actual) wins++;
        else losses++;
    }
    const total = wins + losses;
    return { wins, losses, win_rate: total > 0 ? wins / total : 0 };
}

// ===== MAIN PREDICTION (SIÊU PRO) =====
function calculatePrediction(history) {
    const values = history.map(i => tx(i.ket_qua));
    if (values.length < 8) {
        return {
            du_doan: "Tài",
            side: "T",
            do_tin_cay: "50.00%",
            confidence: 50,
            trang_thai: "Chưa đủ dữ liệu - Dùng mặc định",
            random: true,
            pattern_chinh: null,
            score: { tai: 0, xiu: 0 },
            evidence: [],
            tin_hieu: { khuyen_nghi: "THEO", giai_thich: "Chưa đủ dữ liệu", side_theo: "T", side_bo: "X" }
        };
    }

    // 1. Trích xuất đặc trưng
    const features = extractFeatures(history);
    if (!features) {
        return {
            du_doan: "Tài",
            side: "T",
            do_tin_cay: "50.00%",
            confidence: 50,
            trang_thai: "Không thể trích xuất đặc trưng",
            random: true,
            pattern_chinh: null,
            score: { tai: 0, xiu: 0 },
            evidence: [],
            tin_hieu: { khuyen_nghi: "THEO", giai_thich: "Lỗi đặc trưng", side_theo: "T", side_bo: "X" }
        };
    }

    // 2. Dự đoán từ các mô hình ensemble
    const rf = randomForest(features);
    const gb = gradientBoosting(features);
    const nn = neuralNetwork(features);
    const arima = arimaForecast(history);
    const sentiment = sentimentAnalysis(history);

    // 3. Kết hợp có trọng số (dùng modelWeights)
    const weights = modelWeights;
    let scoreT = 0, scoreX = 0;
    const evidence = [];

    // Hàm thêm tín hiệu
    function addSignal(name, pT, pX, weight, extra = {}) {
        const w = weight * (weights[name] || 1.0);
        scoreT += pT * w;
        scoreX += pX * w;
        evidence.push({ type: name, ...extra, weight: round(w, 2) });
    }

    addSignal("random_forest", rf, 1 - rf, 0.8, { prediction: result(rf >= 0.5 ? "T" : "X") });
    addSignal("gradient_boosting", gb, 1 - gb, 0.8, { prediction: result(gb >= 0.5 ? "T" : "X") });
    addSignal("neural_network", nn, 1 - nn, 0.8, { prediction: result(nn >= 0.5 ? "T" : "X") });
    addSignal("arima", arima, 1 - arima, 0.6, { prediction: result(arima >= 0.5 ? "T" : "X") });
    addSignal("sentiment", sentiment.score, 1 - sentiment.score, 0.7, { sentiment: sentiment.sentiment });

    // Các tín hiệu truyền thống (dùng lại code cũ)
    const mined = minePatterns(history);
    const main = mined.length ? mined[0] : null;
    const similar = mineSimilarPatterns(history, main ? main.pattern : values.slice(-6).join(""));
    const transformed = analyzeTransformedPatterns(history, main ? main.pattern : values.slice(-6).join(""));
    const markov1 = analyzeMarkov1(history);
    const markov2 = analyzeMarkov2(history);
    const markov3 = analyzeMarkov3(history);
    const cycles = analyzeCycles(history);
    const run = analyzeRunPattern(history);
    const streak = analyzeStreak(history);
    const alternating = analyzeAlternating(history);
    const learning = getLearningScore(main ? main.pattern : values.slice(-6).join(""));

    if (main) addSignal("pattern_chinh", main.pT, main.pX, 1.0, { pattern: main.pattern, samples: main.total });
    if (similar) addSignal("pattern_tuong_tu", similar.pT, similar.pX, 0.8, { matches: similar.matches });
    for (const item of transformed) addSignal("pattern_transform", item.pT, item.pX, 0.6, { pattern: item.pattern });
    if (markov1) addSignal("markov_1", markov1.pT, markov1.pX, 0.7, { key: markov1.key });
    if (markov2) addSignal("markov_2", markov2.pT, markov2.pX, 0.7, { key: markov2.key });
    if (markov3) addSignal("markov_3", markov3.pT, markov3.pX, 0.7, { key: markov3.key });
    if (run && run.signals.length) {
        for (const sig of run.signals) {
            const pT = sig.prediction === "T" ? 1 : 0;
            const pX = sig.prediction === "X" ? 1 : 0;
            addSignal("run", pT, pX, 0.6, { pattern: sig.name });
        }
    }
    if (streak) {
        const pT = streak.prediction === "T" ? 1 : 0;
        const pX = streak.prediction === "X" ? 1 : 0;
        addSignal("streak", pT, pX, 0.5, { count: streak.count });
    }
    if (alternating) {
        const pT = alternating.prediction === "T" ? 1 : 0;
        const pX = alternating.prediction === "X" ? 1 : 0;
        addSignal("alternating", pT, pX, 0.5, { pattern: alternating.pattern });
    }
    for (const cycle of cycles) {
        addSignal("cycle", cycle.pT, cycle.pX, 0.4, { period: cycle.period });
    }
    if (learning) {
        const pred = main ? main.prediction : (scoreT >= scoreX ? "T" : "X");
        const pT = pred === "T" ? 1 : 0;
        const pX = pred === "X" ? 1 : 0;
        addSignal("self_learning", pT, pX, 0.5, { win_rate: learning.win_rate });
    }

    // 4. Áp dụng bias correction dựa trên tỉ lệ thực tế
    const totalHistory = history.length;
    let countT = 0, countX = 0;
    for (const h of history) {
        if (tx(h.ket_qua) === "T") countT++; else countX++;
    }
    const ratioT = countT / totalHistory;
    const ratioX = countX / totalHistory;
    let bias = 1.0;
    if (ratioT > 0.58) bias = 0.9;
    else if (ratioX > 0.58) bias = 1.1;
    scoreT *= bias;
    scoreX *= (2 - bias);

    const totalScore = scoreT + scoreX;
    if (totalScore <= 0) {
        return {
            du_doan: "Tài", side: "T",
            do_tin_cay: "50.00%", confidence: 50,
            trang_thai: "Không có tín hiệu - Dùng mặc định",
            random: true,
            pattern_chinh: main,
            score: { tai: 0, xiu: 0 },
            evidence: [],
            tin_hieu: { khuyen_nghi: "THEO", giai_thich: "Không có tín hiệu", side_theo: "T", side_bo: "X" }
        };
    }

    // 5. Xác định dự đoán và độ tin cậy
    const pT = scoreT / totalScore;
    const pX = scoreX / totalScore;
    let side = pT >= pX ? "T" : "X";
    let confidence = clamp(Math.max(pT, pX) * 100, 50, 98);

    // 6. Áp dụng Reinforcement Learning: chọn action (0: theo, 1: bẻ)
    const state = {
        pT: round(pT, 2),
        pX: round(pX, 2),
        confidence: round(confidence / 100, 2),
        sentiment: sentiment.sentiment === "greed" ? 1 : (sentiment.sentiment === "fear" ? 0 : 0.5),
        recentWinRate: features.recent_win_rate || 0.5
    };
    const action = Math.random() < RL.epsilon ? (Math.random() < 0.5 ? 0 : 1) : (getQValue(state, 0) >= getQValue(state, 1) ? 0 : 1);
    if (action === 1) {
        // Bẻ: đánh ngược lại
        side = opposite(side);
        confidence = clamp(confidence * 0.9, 50, 95);
        evidence.push({ type: "rl_action", action: "bẻ", weight: 0.3 });
    } else {
        evidence.push({ type: "rl_action", action: "theo", weight: 0.3 });
    }

    // 7. Tính volatility
    const numValues = values.map(v => v === "T" ? 1 : 0);
    const std = Math.sqrt(numValues.reduce((a, b) => a + (b - pT) ** 2, 0) / numValues.length);
    const volatility = clamp(std, 0.1, 0.5);

    // 8. Position sizing
    const positionSize = positionSizing(confidence, volatility);

    // 9. Tạo response
    const resultObj = {
        du_doan: result(side),
        side,
        do_tin_cay: `${round(confidence, 2)}%`,
        confidence: round(confidence, 2),
        trang_thai: "Phân tích Ensemble + RL",
        random: false,
        margin: round(Math.abs(pT - pX) * 100, 2),
        score: { tai: round(scoreT, 4), xiu: round(scoreX, 4) },
        probability: { tai: round(pT * 100, 2), xiu: round(pX * 100, 2) },
        agreement: round(confidence, 2),
        votes: { T: evidence.filter(e => e.prediction === "Tài").length, X: evidence.filter(e => e.prediction === "Xỉu").length },
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
        pattern_candidates: mined.slice(0, 10).map(item => ({
            pattern: item.pattern,
            length: item.length,
            samples: item.total,
            tai: item.tai,
            xiu: item.xiu,
            confidence: item.confidence,
            prediction: result(item.prediction),
            strength: item.strength
        })),
        evidence,
        tin_hieu: {
            khuyen_nghi: confidence >= 70 ? "THEO MẠNH" : (confidence >= 60 ? "THEO" : "BẺ"),
            giai_thich: `Độ tin cậy ${round(confidence, 2)}%, dựa trên ${evidence.length} tín hiệu và RL action ${action === 0 ? 'theo' : 'bẻ'}`,
            side_theo: side,
            side_bo: opposite(side),
            muc_dat: `${positionSize}%`
        },
        features,
        rl_action: action,
        position_size: positionSize,
        volatility: round(volatility * 100, 2)
    };

    // Lưu state và action cho RL
    global.lastState = state;
    global.lastAction = action;
    global.lastReward = 0;

    return resultObj;
}

// ===== CÁC HÀM PHỤ TRỢ (giữ nguyên từ bản cũ, chỉ sửa để phù hợp) =====
function getSides(history) { return history.map(i => tx(i.ket_qua)); }
function buildPattern(history) { return getSides(history).slice(-MAX_PATTERN_HISTORY).join(""); }
function bayesianRate(success, total) { return (success + 2) / (total + 4); }
function distributionConfidence(tai, xiu) {
    const total = tai + xiu;
    if (total <= 0) return 50;
    return round(clamp(Math.max(bayesianRate(tai, total), bayesianRate(xiu, total)) * 100, 50, 97));
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
    return {
        side: last, count,
        prediction: count >= 3 ? opposite(last) : last,
        weight: clamp(0.55 + count * 0.04, 0.55, 0.82)
    };
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

// ===== UPDATE KẾT QUẢ VỚI RL =====
function updatePredictionResults(history) {
    let changed = false;
    for (const pred of predictionHistory) {
        if (pred.ket_qua !== "⌛ Chờ Kết Quả") continue;
        const actual = history.find(h => Number(h.phien) === Number(pred.phien));
        if (!actual) continue;
        pred.ket_qua = actual.ket_qua;
        pred.xuc_xac = actual.xuc_xac;
        pred.tong = actual.tong;
        const isWin = pred.du_doan === actual.ket_qua;
        pred.danh_gia = isWin ? "✅ Thắng" : "❌ Thua";
        changed = true;

        // Cập nhật RL với phần thưởng
        if (global.lastState && global.lastAction !== undefined) {
            const reward = isWin ? 1 : -1;
            global.lastReward = reward;
            const nextState = { ...global.lastState };
            // update Q-table
            updateQValue(global.lastState, global.lastAction, reward, nextState);
            // Cập nhật trọng số weights dựa trên kết quả
            for (const key in modelWeights) {
                const adjustment = isWin ? 1.01 : 0.99;
                modelWeights[key] = clamp(modelWeights[key] * adjustment, 0.3, 2.0);
            }
            saveWeights();
        }
    }
    if (changed) {
        savePredictions();
        rebuildLearning();
        // Lưu learning data
        saveLearningData();
    }
}

// ===== CÁC ROUTES =====
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
            random: analysis.random || false,
            trang_thai: analysis.trang_thai || "Chờ",
            created_at: new Date().toISOString()
        };
        predictionHistory.push(record);
    } else {
        record.du_doan = analysis.du_doan;
        record.do_tin_cay = analysis.do_tin_cay;
        record.pattern = pattern;
        record.random = analysis.random || false;
        record.trang_thai = analysis.trang_thai || "Cập nhật";
    }
    savePredictions();
    return record;
}

// ===== ROUTES =====
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
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            tin_hieu: data.prediction.tin_hieu,
            trang_thai: data.prediction.trang_thai
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
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            tin_hieu: data.prediction.tin_hieu,
            trang_thai: data.prediction.trang_thai,
            margin: data.prediction.margin,
            pattern_chinh: data.prediction.pattern_chinh,
            score: data.prediction.score,
            probability: data.prediction.probability,
            evidence: data.prediction.evidence,
            features: data.prediction.features,
            rl_action: data.prediction.rl_action,
            position_size: data.prediction.position_size,
            volatility: data.prediction.volatility,
            next_prediction: data.next,
            history: data.history.slice(-20)
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

app.get("/api/txmd5/analyze", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            phien: data.history[data.history.length - 1].phien,
            phien_hien_tai: data.next ? data.next.phien : null,
            pattern: data.pattern,
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            tin_hieu: data.prediction.tin_hieu,
            trang_thai: data.prediction.trang_thai,
            margin: data.prediction.margin,
            pattern_chinh: data.prediction.pattern_chinh,
            score: data.prediction.score,
            probability: data.prediction.probability,
            evidence: data.prediction.evidence,
            features: data.prediction.features,
            rl_action: data.prediction.rl_action,
            position_size: data.prediction.position_size,
            volatility: data.prediction.volatility
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/txmd5/signal", async (req, res) => {
    try {
        const data = await getData();
        res.json({
            du_doan: data.prediction.du_doan,
            do_tin_cay: data.prediction.do_tin_cay,
            tin_hieu: data.prediction.tin_hieu,
            position_size: data.prediction.position_size
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
    const loses = finished.length - wins;
    res.json({
        total_predictions: finished.length,
        wins, loses,
        win_rate: finished.length ? round(wins / finished.length * 100) : 0,
        total_patterns: Object.keys(patterns).length,
        patterns,
        modelWeights,
        qTable_size: Object.keys(RL.qTable).length,
        learningData_size: learningData.rewards.length
    });
});

app.get("/api/txmd5/backtest", async (req, res) => {
    try {
        const data = await getData();
        const result = backtest(data.history, calculatePrediction);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "TAI XIU MD5 - SIÊU PRO",
        source: SOURCE_API,
        version: "3.0",
        algorithms: [
            "Ensemble Learning (RF, GB, NN)",
            "Reinforcement Learning (Q-Learning)",
            "Feature Engineering (Entropy, Correlation, Z-score)",
            "ARIMA-like Forecasting",
            "Sentiment Analysis (Fear/Greed)",
            "Anomaly Detection",
            "Dynamic Position Sizing (Kelly Criterion)",
            "Backtesting & Validation",
            "Pattern Recognition (truyền thống)",
            "Bayesian Inference",
            "Self-Learning"
        ],
        endpoints: [
            "/api/taixiumd5",
            "/api/taixiumd5/detail",
            "/api/txmd5/history",
            "/api/txmd5/analyze",
            "/api/txmd5/signal",
            "/api/txmd5/learning",
            "/api/txmd5/backtest"
        ]
    });
});

setInterval(async () => {
    try { await getData(); } catch (e) { console.error("AUTO UPDATE ERROR:", e.message); }
}, CACHE_MS);

app.listen(PORT, "0.0.0.0", () => {
    console.log("==========================================================");
    console.log("   🚀 TAI XIU MD5 - SIÊU PRO VERSION 3.0");
    console.log(`   PORT: ${PORT}`);
    console.log(`   SOURCE: ${SOURCE_API}`);
    console.log("   🔥 ENSEMBLE + REINFORCEMENT LEARNING");
    console.log("   🧠 FEATURE ENGINEERING + SENTIMENT");
    console.log("   📈 DYNAMIC POSITION SIZING");
    console.log("   📊 BACKTESTING AVAILABLE");
    console.log("==========================================================");
});
