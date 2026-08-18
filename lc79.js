"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3001);
const POLL_MS = 3000;

const PATTERN_LENGTH = 20;
const TOP_PATTERN_SAMPLES = 10;

const MAX_SOURCE_HISTORY = 500;
const MAX_HISTORY = 100;
const MAX_PATTERN_MEMORY = 30000;

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SOURCES = {
    hu: "https://wtx.tele68.com/v1/tx/sessions",
    md5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

// ============================================================
// DATA PATH — TÁCH HOÀN TOÀN HU / MD5
// ============================================================

const PATHS = {
    hu: {
        model: path.join(DATA_DIR, "hu-model.json"),
        pattern: path.join(DATA_DIR, "hu-patterns.json"),
        history: path.join(DATA_DIR, "hu-history.json")
    },
    md5: {
        model: path.join(DATA_DIR, "md5-model.json"),
        pattern: path.join(DATA_DIR, "md5-patterns.json"),
        history: path.join(DATA_DIR, "md5-history.json")
    }
};

// ============================================================
// UTILITIES
// ============================================================

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const data = fs.readFileSync(file, "utf8");
        return JSON.parse(data);
    } catch {
        return fallback;
    }
}

function saveJSON(file, data) {
    try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (error) {
        console.error("[SAVE]", error.message);
    }
}

function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeResult(value) {
    const v = String(value || "").trim().toUpperCase();
    if (v === "TAI" || v === "TÀI") return "TAI";
    if (v === "XIU" || v === "XỈU") return "XIU";
    return null;
}

function displayResult(value) {
    const result = normalizeResult(value);
    if (result === "TAI") return "Tài";
    if (result === "XIU") return "Xỉu";
    return "Không rõ";
}

function toTX(value) {
    return normalizeResult(value) === "TAI" ? "T" : "X";
}

function txResult(value) {
    return value === "T" ? "TAI" : "XIU";
}

function opposite(value) {
    return value === "T" ? "X" : "T";
}

function validPattern(pattern) {
    return typeof pattern === "string" && pattern.length === PATTERN_LENGTH && /^[TX]+$/.test(pattern);
}

// ============================================================
// THUẬT TOÁN DỰ ĐOÁN MỚI (THAY THẾ 11 MODEL CŨ)
// ============================================================

// ---------- HÀM CHUYỂN ĐỔI ----------
function historyToBinary(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    return history.map(h => (h.ket_qua === 'TAI' || h.ket_qua === 'Tài') ? '1' : '0').join('');
}

function binaryToLabel(char) {
    return char === '1' ? 'Tài' : 'Xỉu';
}

function inverseBinaryToLabel(char) {
    return char === '1' ? 'Xỉu' : 'Tài';
}

function tailStreakLength(binaryString) {
    const n = binaryString.length;
    if (n === 0) return 0;
    const lastChar = binaryString[n - 1];
    let length = 1;
    for (let i = n - 2; i >= 0; i--) {
        if (binaryString[i] !== lastChar) break;
        length++;
    }
    return length;
}

// ---------- CÁC MÔ HÌNH CON ----------
function analyzeBet(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 3) return { confidence: 0 };
    const lastChar = recentHistory[n - 1];
    const length = tailStreakLength(recentHistory);
    if (length >= 3) {
        const prediction = inverseBinaryToLabel(lastChar);
        const confidence = Math.min(75, 60 + length * 3) / 100;
        return { prediction, confidence, pattern_note: `Cầu bệt ${length} phiên ${binaryToLabel(lastChar)}, dự đoán đảo chiều` };
    }
    return { confidence: 0 };
}

function analyzeCau11(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 6) return { confidence: 0 };
    const last5 = recentHistory.slice(-5);
    const isAlternate = last5.every((c, i) => i === 0 || c !== last5[i - 1]);
    if (isAlternate) {
        const lastChar = recentHistory[n - 1];
        return { prediction: inverseBinaryToLabel(lastChar), confidence: 0.72, pattern_note: 'Cầu 1-1 (xen kẽ), tiếp tục chu kỳ' };
    }
    return { confidence: 0 };
}

function analyzeCau22(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 8) return { confidence: 0 };
    const last8 = recentHistory.slice(-8);
    let nextBinary = null;
    if (last8 === '00110011') nextBinary = '0';
    else if (last8 === '11001100') nextBinary = '1';
    if (nextBinary !== null) {
        return { prediction: binaryToLabel(nextBinary), confidence: 0.78, pattern_note: 'Cầu 2-2 (AA BB AA BB), tiếp tục chu kỳ' };
    }
    return { confidence: 0 };
}

function analyzeCau33(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 12) return { confidence: 0 };
    const last12 = recentHistory.slice(-12);
    let nextBinary = null;
    if (last12 === '000111000111') nextBinary = '0';
    else if (last12 === '111000111000') nextBinary = '1';
    if (nextBinary !== null) {
        return { prediction: binaryToLabel(nextBinary), confidence: 0.82, pattern_note: 'Cầu 3-3 (AAA BBB AAA BBB), tiếp tục chu kỳ' };
    }
    return { confidence: 0 };
}

function analyzeCauABAB(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 10) return { confidence: 0 };
    const last10 = recentHistory.slice(-10);
    const isCycle2 = last10.every((c, i) => i < 2 || c === last10[i - 2]);
    if (isCycle2) {
        const nextBinary = recentHistory[n - 2];
        return { prediction: binaryToLabel(nextBinary), confidence: 0.75, pattern_note: 'Cầu ABAB (chu kỳ 2)' };
    }
    return { confidence: 0 };
}

function analyzeCauAABB(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 8) return { confidence: 0 };
    const last8 = recentHistory.slice(-8);
    if (last8 === '00110011') {
        return { prediction: 'Xỉu', confidence: 0.76, pattern_note: 'Cầu AABB (00 11 00 11), tiếp tục chu kỳ' };
    }
    if (last8 === '11001100') {
        return { prediction: 'Tài', confidence: 0.76, pattern_note: 'Cầu AABB (11 00 11 00), tiếp tục chu kỳ' };
    }
    return { confidence: 0 };
}

function analyzeCauABCABC(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 12) return { confidence: 0 };
    const last12 = recentHistory.slice(-12);
    const isCycle3 = last12.every((c, i) => i < 3 || c === last12[i - 3]);
    if (isCycle3) {
        const nextBinary = recentHistory[n - 3];
        return { prediction: binaryToLabel(nextBinary), confidence: 0.80, pattern_note: 'Cầu ABCABC (chu kỳ 3)' };
    }
    return { confidence: 0 };
}

function analyzeFibonacci(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 20) return { confidence: 0 };
    const changes = [];
    for (let i = 1; i < n; i++) {
        if (recentHistory[i] !== recentHistory[i - 1]) changes.push(i);
    }
    if (changes.length >= 5) {
        const diffs = [];
        for (let i = 1; i < changes.length; i++) {
            diffs.push(changes[i] - changes[i - 1]);
        }
        if (diffs.length >= 3) {
            const lastDiff = diffs[diffs.length - 1];
            const prevDiff = diffs[diffs.length - 2];
            if (prevDiff > 0 && Math.abs((lastDiff / prevDiff) - 1.618) < 0.3) {
                const prediction = inverseBinaryToLabel(recentHistory[n - 1]);
                return { prediction, confidence: 0.70, pattern_note: 'Phát hiện tỷ lệ Fibonacci (≈1.618)' };
            }
        }
    }
    return { confidence: 0 };
}

function analyzeFourier(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 20) return { confidence: 0 };
    const autocorr = {};
    for (let lag = 1; lag <= Math.min(10, n - 1); lag++) {
        let sum = 0;
        for (let i = 0; i < n - lag; i++) {
            sum += (recentHistory[i] === recentHistory[i + lag]) ? 1 : -1;
        }
        autocorr[lag] = sum / (n - lag);
    }
    let maxCorr = 0, bestLag = 0, bestCorr = 0;
    for (const [lag, corr] of Object.entries(autocorr)) {
        const l = parseInt(lag);
        if (Math.abs(corr) > maxCorr && l >= 2) {
            maxCorr = Math.abs(corr);
            bestLag = l;
            bestCorr = corr;
        }
    }
    if (maxCorr > 0.3 && bestLag > 0) {
        const referenceBit = recentHistory[n - bestLag];
        const nextBit = (bestCorr >= 0) ? referenceBit : (referenceBit === '1' ? '0' : '1');
        return {
            prediction: binaryToLabel(nextBit),
            confidence: Math.min(0.85, maxCorr * 1.5),
            pattern_note: `Phân tích chu kỳ Fourier (lag ${bestLag}, corr ${bestCorr.toFixed(2)})`
        };
    }
    return { confidence: 0 };
}

function analyzeNeuralPattern(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 25) return { confidence: 0 };
    const patternLength = 5;
    const currentPattern = recentHistory.slice(-patternLength);
    const matches = { '0': 0, '1': 0 };
    let matchCount = 0;
    for (let i = 0; i <= n - patternLength - 1; i++) {
        const testPattern = recentHistory.slice(i, i + patternLength);
        let similarity = 0;
        for (let j = 0; j < patternLength; j++) {
            if (testPattern[j] === currentPattern[j]) similarity++;
        }
        similarity /= patternLength;
        if (similarity >= 0.8 && (i + patternLength) < n) {
            const nextChar = recentHistory[i + patternLength];
            matches[nextChar] += similarity;
            matchCount++;
        }
    }
    const totalScore = matches['0'] + matches['1'];
    if (matchCount >= 3 && totalScore > 0) {
        const ratio = Math.max(matches['1'], matches['0']) / totalScore;
        if (ratio > 0.60) {
            return {
                prediction: matches['1'] > matches['0'] ? 'Tài' : 'Xỉu',
                confidence: Math.min(0.90, ratio),
                pattern_note: `Nhận diện pattern Neural (${matchCount} mẫu tương đồng, độ đồng thuận ${Math.round(ratio * 100)}%)`
            };
        }
    }
    return { confidence: 0 };
}

function analyzeMarkovAdvanced(fullHistory, recentHistory, recentArray) {
    const n = fullHistory.length;
    if (n < 30) return { confidence: 0 };
    const order = 3;
    const transitionMatrix = {};
    for (let i = order; i < n; i++) {
        const state = fullHistory.slice(i - order, i);
        const next = fullHistory[i];
        if (!transitionMatrix[state]) transitionMatrix[state] = { '0': 0, '1': 0 };
        transitionMatrix[state][next]++;
    }
    const currentState = fullHistory.slice(-order);
    if (transitionMatrix[currentState]) {
        const count0 = transitionMatrix[currentState]['0'] || 0;
        const count1 = transitionMatrix[currentState]['1'] || 0;
        const total = count0 + count1;
        if (total >= 5) {
            const prob1 = count1 / total;
            const prob0 = count0 / total;
            const confidence = Math.abs(prob1 - prob0);
            if (confidence > 0.25) {
                return {
                    prediction: prob1 > prob0 ? 'Tài' : 'Xỉu',
                    confidence: Math.min(0.85, confidence * 2),
                    pattern_note: `Markov bậc ${order} (xác suất: ${Math.round(Math.max(prob1, prob0) * 100)}%)`
                };
            }
        }
    }
    return { confidence: 0 };
}

function analyzeEntropy(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 20) return { confidence: 0 };
    const counts = { '0': 0, '1': 0 };
    for (const c of recentHistory) counts[c]++;
    let entropy = 0;
    for (const c of ['0', '1']) {
        const p = counts[c] / n;
        if (p > 0) entropy -= p * Math.log2(p);
    }
    const randomness = entropy / 1;
    if (randomness > 0.9) {
        const lastChar = recentHistory[n - 1];
        return {
            prediction: inverseBinaryToLabel(lastChar),
            confidence: 0.65,
            pattern_note: `Entropy cao (${Math.round(randomness * 100)}%), dự đoán đảo chiều`
        };
    }
    if (randomness < 0.3) {
        const lastChar = recentHistory[n - 1];
        return {
            prediction: binaryToLabel(lastChar),
            confidence: 0.75,
            pattern_note: `Entropy thấp (${Math.round(randomness * 100)}%), tiếp tục xu hướng`
        };
    }
    return { confidence: 0 };
}

function analyzeTrendMomentum(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 15) return { confidence: 0 };
    let momentum = 0;
    for (let i = 1; i < n; i++) {
        if (recentHistory[i] === recentHistory[i - 1]) {
            momentum += (recentHistory[i] === '1') ? 1 : -1;
        } else {
            momentum = 0;
        }
    }
    let upChanges = 0, downChanges = 0;
    for (let i = 1; i < n; i++) {
        if (recentHistory[i] === '1' && recentHistory[i - 1] === '0') upChanges++;
        else if (recentHistory[i] === '0' && recentHistory[i - 1] === '1') downChanges++;
    }
    const totalChanges = upChanges + downChanges;
    const rsi = totalChanges > 0 ? upChanges / totalChanges : 0.5;
    if (Math.abs(momentum) > 3) {
        if (momentum > 0 && rsi > 0.7) {
            return {
                prediction: 'Xỉu',
                confidence: 0.70,
                pattern_note: `Động lượng Tài mạnh (RSI: ${Math.round(rsi * 100)}%), dự báo điều chỉnh`
            };
        }
        if (momentum < 0 && rsi < 0.3) {
            return {
                prediction: 'Tài',
                confidence: 0.70,
                pattern_note: `Động lượng Xỉu mạnh (RSI: ${Math.round(rsi * 100)}%), dự báo phục hồi`
            };
        }
    }
    return { confidence: 0 };
}

function analyzeCluster(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 25) return { confidence: 0 };
    const clusters = [];
    let currentCluster = { type: recentHistory[0], length: 1 };
    for (let i = 1; i < n; i++) {
        if (recentHistory[i] === currentCluster.type) {
            currentCluster.length++;
        } else {
            clusters.push(currentCluster);
            currentCluster = { type: recentHistory[i], length: 1 };
        }
    }
    clusters.push(currentCluster);
    const lengths = clusters.map(c => c.length);
    const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const lastCluster = clusters[clusters.length - 1];
    if (lastCluster.length > avgLength * 1.5) {
        return {
            prediction: inverseBinaryToLabel(lastCluster.type),
            confidence: Math.min(0.8, lastCluster.length / (avgLength * 2)),
            pattern_note: `Cụm ${binaryToLabel(lastCluster.type)} kéo dài (${lastCluster.length} phiên)`
        };
    }
    return { confidence: 0 };
}

function analyzeWavelet(fullHistory, recentHistory, recentArray) {
    const n = recentHistory.length;
    if (n < 30) return { confidence: 0 };
    const scales = [2, 3, 5];
    const predictionsAtScale = [];
    for (const scale of scales) {
        let downsampled = '';
        for (let i = 0; i < n; i += scale) {
            const segment = recentHistory.slice(i, Math.min(i + scale, n));
            const ones = segment.split('1').length - 1;
            const zeros = segment.split('0').length - 1;
            downsampled += (ones > zeros) ? '1' : '0';
        }
        if (downsampled.length >= 5) {
            const lastChar = downsampled[downsampled.length - 1];
            const secondLast = downsampled[downsampled.length - 2];
            if (lastChar === secondLast) {
                predictionsAtScale.push(binaryToLabel(lastChar));
            }
        }
    }
    if (predictionsAtScale.length > 0) {
        const counts = {};
        for (const p of predictionsAtScale) counts[p] = (counts[p] || 0) + 1;
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const dominant = sorted[0][0];
        const confidence = sorted[0][1] / predictionsAtScale.length;
        if (confidence > 0.66) {
            return {
                prediction: dominant,
                confidence: Math.min(0.85, confidence),
                pattern_note: `Phân tích đa tỉ lệ Wavelet (${scales.length} scale)`
            };
        }
    }
    return { confidence: 0 };
}

// ---------- FALLBACK ----------
function generateFallbackPrediction(recentHistory, currentResult) {
    const historyString = historyToBinary(recentHistory);
    const n = historyString.length;
    if (n === 0) {
        const pred = (currentResult && (currentResult.ket_qua === 'TAI' || currentResult.ket_qua === 'Tài')) ? 'Xỉu' : 'Tài';
        return { du_doan: pred, do_tin_cay: 58, mau_cau: 'Khởi tạo dữ liệu, đảo chiều phiên hiện tại' };
    }
    if (n >= 3) {
        const lastThree = historyString.slice(-3);
        const patterns = {
            '111': { pred: 'Xỉu', conf: 68, note: '3 Tài liên tiếp' },
            '000': { pred: 'Tài', conf: 68, note: '3 Xỉu liên tiếp' },
            '101': { pred: 'Xỉu', conf: 65, note: 'Mẫu xen kẽ 101' },
            '010': { pred: 'Tài', conf: 65, note: 'Mẫu xen kẽ 010' }
        };
        if (patterns[lastThree]) {
            return {
                du_doan: patterns[lastThree].pred,
                do_tin_cay: patterns[lastThree].conf,
                mau_cau: patterns[lastThree].note
            };
        }
    }
    const countTai = (historyString.match(/1/g) || []).length;
    const countXiu = n - countTai;
    if (n > 0 && Math.abs(countTai - countXiu) > Math.max(2, Math.ceil(n * 0.2))) {
        const pred = (countTai > countXiu) ? 'Xỉu' : 'Tài';
        const imbalance = Math.abs(countTai - countXiu) / n;
        const confidence = Math.min(80, 63 + Math.min(17, imbalance * 100));
        return {
            du_doan: pred,
            do_tin_cay: Math.round(confidence * 100) / 100,
            mau_cau: `Điều chỉnh cân bằng (Tài:${countTai}/Xỉu:${countXiu})`
        };
    }
    const lastChar = historyString[n - 1];
    const streak = tailStreakLength(historyString);
    const pred = inverseBinaryToLabel(lastChar);
    const confidence = Math.min(72, 60 + (streak * 2));
    return {
        du_doan: pred,
        do_tin_cay: confidence,
        mau_cau: `Chiến lược đảo chiều cơ bản (chuỗi cuối ${streak} phiên)`
    };
}

// ---------- DỰ ĐOÁN CHÍNH ----------
function predictNextAdvancedPro(currentResult, history) {
    if (!Array.isArray(history)) history = [];
    if (history.length < 15) {
        const fallback = generateFallbackPrediction(history, currentResult);
        fallback.do_tin_cay = Math.min(68, fallback.do_tin_cay);
        fallback.mau_cau = 'Khởi tạo hệ thống dự đoán | ' + fallback.mau_cau;
        return fallback;
    }

    const fullHistoryString = historyToBinary(history);
    const recentArray = history.slice(-30);
    const recentString = historyToBinary(recentArray);

    const analyzers = [
        { name: 'cau_bet', weight: 1.5, fn: analyzeBet },
        { name: 'cau_11', weight: 1.4, fn: analyzeCau11 },
        { name: 'cau_22', weight: 1.4, fn: analyzeCau22 },
        { name: 'cau_33', weight: 1.4, fn: analyzeCau33 },
        { name: 'cau_abab', weight: 1.3, fn: analyzeCauABAB },
        { name: 'cau_aabb', weight: 1.3, fn: analyzeCauAABB },
        { name: 'cau_abcabc', weight: 1.3, fn: analyzeCauABCABC },
        { name: 'fibonacci', weight: 1.2, fn: analyzeFibonacci },
        { name: 'fourier', weight: 1.2, fn: analyzeFourier },
        { name: 'neural', weight: 1.2, fn: analyzeNeuralPattern },
        { name: 'markov_advanced', weight: 1.1, fn: analyzeMarkovAdvanced },
        { name: 'entropy', weight: 1.0, fn: analyzeEntropy },
        { name: 'trend_momentum', weight: 0.9, fn: analyzeTrendMomentum },
        { name: 'cluster', weight: 0.8, fn: analyzeCluster },
        { name: 'wavelet', weight: 0.7, fn: analyzeWavelet }
    ];

    const predictions = [];
    const weights = [];
    const patternNotes = [];

    for (const analyzer of analyzers) {
        const result = analyzer.fn(fullHistoryString, recentString, recentArray);
        if (result && result.confidence > 0.55 && result.prediction) {
            predictions.push(result.prediction);
            weights.push(result.confidence * analyzer.weight);
            patternNotes.push(result.pattern_note || analyzer.name);
        }
    }

    if (predictions.length > 0) {
        let scoreTai = 0, scoreXiu = 0;
        for (let i = 0; i < predictions.length; i++) {
            if (predictions[i] === 'Tài') scoreTai += weights[i];
            else scoreXiu += weights[i];
        }
        const totalScore = scoreTai + scoreXiu;
        if (totalScore > 0) {
            const finalPrediction = (scoreTai > scoreXiu) ? 'Tài' : 'Xỉu';
            const winningScore = Math.max(scoreTai, scoreXiu);
            let rawConfidence = winningScore / totalScore;
            const methodCount = predictions.length;
            const consensusBonus = (methodCount > 3) ? Math.min(0.2, (methodCount - 3) * 0.05) : 0;
            let confidence = 60 + (rawConfidence * 25) + (consensusBonus * 100);
            confidence = Math.min(92, Math.max(60, confidence));

            let patternText = `Hệ thống AI (${predictions.length}/${analyzers.length} thuật toán)`;
            if (patternNotes.length > 0) {
                const freq = {};
                for (const note of patternNotes) freq[note] = (freq[note] || 0) + 1;
                const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
                if (sorted.length > 0) patternText += ` | Ưu thế: ${sorted[0][0]}`;
            }

            return {
                du_doan: finalPrediction,
                do_tin_cay: Math.round(confidence * 100) / 100,
                mau_cau: patternText
            };
        }
    }
    return generateFallbackPrediction(recentArray, currentResult);
}

// ============================================================
// ENGINE (CHỈ GIỮ LẠI CẤU TRÚC NHƯNG KHÔNG DÙNG 11 MODEL CŨ)
// ============================================================

function createEngine(type) {
    return {
        type,
        patternMemory: {},
        followUp: {},
        markov1: { TT: 1, TX: 1, XT: 1, XX: 1 },
        markov2: {},
        dice: {
            face: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
            total: {},
            totalResult: {},
            triple: {},
            pair: {},
            sequence: {}
        },
        performance: {
            model1: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model2: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model3: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model4: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model5: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model6: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model7: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model8: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model9: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model10: { correct: 0, wrong: 0, total: 0, weight: 1 },
            model11: { correct: 0, wrong: 0, total: 0, weight: 1 }   // chỉ dùng model11
        },
        global: { correct: 0, wrong: 0, total: 0 },
        learnedUntil: 0
    };
}

function ensureEngine(engine, type) {
    if (!engine) engine = createEngine(type);
    const fresh = createEngine(type);
    engine.type = type;
    engine.patternMemory = engine.patternMemory || {};
    engine.followUp = engine.followUp || {};
    engine.markov1 = engine.markov1 || fresh.markov1;
    engine.markov2 = engine.markov2 || {};
    engine.dice = engine.dice || fresh.dice;
    engine.dice.face = engine.dice.face || fresh.dice.face;
    engine.dice.total = engine.dice.total || {};
    engine.dice.totalResult = engine.dice.totalResult || {};
    engine.dice.triple = engine.dice.triple || {};
    engine.dice.pair = engine.dice.pair || {};
    engine.dice.sequence = engine.dice.sequence || {};
    engine.performance = engine.performance || createEngine(type).performance;
    for (let i = 1; i <= 11; i++) {
        const key = `model${i}`;
        if (!engine.performance[key]) engine.performance[key] = { correct: 0, wrong: 0, total: 0, weight: 1 };
    }
    engine.global = engine.global || { correct: 0, wrong: 0, total: 0 };
    engine.learnedUntil = number(engine.learnedUntil);
    return engine;
}

// ============================================================
// LOAD ENGINES
// ============================================================

const engines = {
    hu: ensureEngine(loadJSON(PATHS.hu.model, null), "hu"),
    md5: ensureEngine(loadJSON(PATHS.md5.model, null), "md5")
};

const histories = {
    hu: loadJSON(PATHS.hu.history, []),
    md5: loadJSON(PATHS.md5.history, [])
};

if (!Array.isArray(histories.hu)) histories.hu = [];
if (!Array.isArray(histories.md5)) histories.md5 = [];

// ============================================================
// SOURCE CACHE
// ============================================================

const sourceHistory = { hu: [], md5: [] };
const lastSourceId = { hu: null, md5: null };
const pending = { hu: new Map(), md5: new Map() };

// ============================================================
// SSE
// ============================================================

const clients = { hu: new Set(), md5: new Set() };

function sendSSE(type, event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients[type]) {
        try { client.write(message); } catch { clients[type].delete(client); }
    }
}

// ============================================================
// NORMALIZE SOURCE
// ============================================================

function normalizeSessions(json) {
    if (!json || !Array.isArray(json.list)) return [];
    return json.list
        .map(item => {
            const dices = Array.isArray(item.dices)
                ? item.dices.map(Number).filter(n => n >= 1 && n <= 6)
                : [];
            let total = number(item.point);
            if (!total && dices.length === 3) {
                total = dices[0] + dices[1] + dices[2];
            }
            return {
                phien: number(item.id),
                xuc_xac: dices,
                tong: total,
                ket_qua: normalizeResult(item.resultTruyenThong)
            };
        })
        .filter(x => x.phien > 0 && x.xuc_xac.length === 3 && x.ket_qua)
        .sort((a, b) => a.phien - b.phien);
}

// ============================================================
// FETCH
// ============================================================

async function fetchSource(type) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(SOURCES[type], {
            headers: { Accept: "application/json", "User-Agent": "LC79-ULTRA-V23" },
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
// PATTERN FUNCTIONS (GIỮ NGUYÊN)
// ============================================================

function buildPattern(sessions, length = PATTERN_LENGTH) {
    return sessions.slice(-length).map(x => toTX(x.ket_qua)).join("");
}

function getPatternAt(sessions, endIndex, length = PATTERN_LENGTH) {
    const start = endIndex - length;
    if (start < 0) return null;
    return sessions.slice(start, endIndex).map(x => toTX(x.ket_qua)).join("");
}

function similarity(a, b) {
    if (!validPattern(a) || !validPattern(b)) return 0;
    let score = 0;
    for (let i = 0; i < PATTERN_LENGTH; i++) {
        if (a[i] === b[i]) {
            const weight = 1 + i / PATTERN_LENGTH;
            score += weight;
        }
    }
    let max = 0;
    for (let i = 0; i < PATTERN_LENGTH; i++) max += 1 + i / PATTERN_LENGTH;
    return score / max;
}

function generatePatternSamples() {
    const set = new Set();
    function add(pattern) { if (validPattern(pattern)) set.add(pattern); }
    add("TX".repeat(10));
    add("XT".repeat(10));
    add("TTXX".repeat(5));
    add("XXTT".repeat(5));
    add("TTTXXXTTTXXXTTTXXXTT");
    add("XXXTTTXXXTTTXXXTTTXX");
    add("TTTTXXXXTTTTXXXXTTTT");
    add("XXXXTTTTXXXXTTTTXXXX");
    add("TTTTTXXXXXT TTTTTXXXX".replace(/\s/g, "").slice(0, 20));
    add("XXXX XTTTTTXXXXXT TTT".replace(/\s/g, "").slice(0, 20));
    add("TTXTTXXTTXTTXXTTXTTX");
    add("XXTXXTTXXTXXTTXXTXXT");
    add("TXXTTXXXTTTTXXXXXXTT");
    add("XTTXXXTTTTXXXXXXTTXX");
    add("TTXTXTTXTXTTXTTXTTXX");
    add("XXTXTXXTXTXXTXXTXXTT");
    add("TXTTXXTTXTTXXTTXTXTX");
    add("XTXXTTXXTXXTTXXTXTX");
    add("TTTTTTTTTTTTTTTTTTTX");
    add("XXXXXXXXXXXXXXXXXXXT");
    add("TTTTTTTTTTTTTTTTTTXX");
    add("XXXXXXXXXXXXXXXXXXTT");
    add("TXXTXXTXXTXXTXXTXXTT");
    add("XTTXTTXTTXTTXTTXTTXX");
    add("TTXTTXTTXTTXTTXTTXTT");
    add("XXTXXTXXTXXTXXTXXTXX");
    add("TTXXXTTXXXT TTX TT".replace(/\s/g, "").slice(0, 20));
    add("XXTTTXXTTTXXTTTXXTTT");
    const complex = [
        "TTXTTXXTTTXTTXXTTXTX",
        "XXTXXTTXXXTXTTXXTTXT",
        "TXXTTXXTXXTTTXTTXXTT",
        "XTTXXTTXTTXXXTTXXTXX",
        "TTTTXXTTXTTXXTTTTXXT",
        "XXXXTTXXTXXTTXXXXTTX",
        "TTXXTTTTXXTTXTTXXTTX",
        "XXTTXXXXTTXXTXXTTXXT",
        "TXXTTTTXXTXXTTTXXTTX",
        "XTTXXXXTTXTTXXXTTXXT",
        "TTXTXTTXXTTXTTXXTTTX",
        "XXTXTXTTXXTXTTXXTTTX",
        "TTXXTXXTTTXXTTXTTXTT",
        "XXTTXTTXXXTTXXTXXTXX",
        "TXTTTTXXTTXTTTXXTTXX",
        "XTTTTTXXTTXTTTXXTTXX",
        "TTXXTTXXTTXXTTTTXXTX",
        "XXTTXXTTXXTTXXXXTTXT",
        "TXXTXXTTXXTXXTTXXTTT",
        "XTTXTTXXTTXTTXXTTXXX",
        "TTTXXTTXXXTTTXXTTXXX",
        "XXXTTXXXTTTXXXTTTXXX",
        "TTXXTTXTXTTXTXTTXTTX",
        "XXTTXXTXTXXTXTTXTXXT"
    ];
    for (const p of complex) add(p);
    return [...set].filter(validPattern);
}

function loadPatternLibrary(type) {
    const saved = loadJSON(PATHS[type].pattern, null);
    if (saved && Array.isArray(saved.patterns)) {
        return saved.patterns.filter(validPattern);
    }
    const patterns = generatePatternSamples();
    saveJSON(PATHS[type].pattern, { version: "LC79-V23", length: PATTERN_LENGTH, patterns });
    return patterns;
}

const patternLibraries = {
    hu: loadPatternLibrary("hu"),
    md5: loadPatternLibrary("md5")
};

function getTop10Patterns(type, currentPattern) {
    if (!validPattern(currentPattern)) return [];
    return patternLibraries[type]
        .map(pattern => ({
            pattern,
            similarity: Number((similarity(currentPattern, pattern) * 100).toFixed(2))
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, TOP_PATTERN_SAMPLES);
}

// ============================================================
// HỌC MÁY (VẪN GIỮ ĐỂ LƯU TRẠNG THÁI NHƯNG KHÔNG DÙNG CHO DỰ ĐOÁN)
// ============================================================

function learnPattern(type, sessions) {
    const engine = engines[type];
    if (sessions.length <= PATTERN_LENGTH) return;
    for (let i = PATTERN_LENGTH; i < sessions.length; i++) {
        const pattern = getPatternAt(sessions, i);
        if (!validPattern(pattern)) continue;
        const actual = toTX(sessions[i].ket_qua);
        if (!engine.patternMemory[pattern]) engine.patternMemory[pattern] = { T: 0, X: 0, total: 0 };
        engine.patternMemory[pattern][actual]++;
        engine.patternMemory[pattern].total++;
    }
    const patterns = Object.keys(engine.patternMemory);
    if (patterns.length > MAX_PATTERN_MEMORY) {
        patterns.sort((a, b) => number(engine.patternMemory[a].total) - number(engine.patternMemory[b].total));
        const remove = patterns.length - MAX_PATTERN_MEMORY;
        for (let i = 0; i < remove; i++) delete engine.patternMemory[patterns[i]];
    }
}

function learnFollowUp(type, sessions) {
    const engine = engines[type];
    for (let i = PATTERN_LENGTH; i < sessions.length; i++) {
        const pattern = getPatternAt(sessions, i);
        if (!validPattern(pattern)) continue;
        const actual = toTX(sessions[i].ket_qua);
        if (!engine.followUp[pattern]) engine.followUp[pattern] = { T: 0, X: 0, total: 0 };
        engine.followUp[pattern][actual]++;
        engine.followUp[pattern].total++;
    }
}

function learnMarkov(type, sessions) {
    const engine = engines[type];
    for (let i = 1; i < sessions.length; i++) {
        const prev = toTX(sessions[i - 1].ket_qua);
        const current = toTX(sessions[i].ket_qua);
        const key = prev + current;
        engine.markov1[key] = number(engine.markov1[key]) + 1;
    }
    for (let i = 2; i < sessions.length; i++) {
        const key = sessions.slice(i - 2, i).map(x => toTX(x.ket_qua)).join("");
        const current = toTX(sessions[i].ket_qua);
        if (!engine.markov2[key]) engine.markov2[key] = { T: 1, X: 1 };
        engine.markov2[key][current]++;
    }
}

function learnDice(type, sessions) {
    const dice = engines[type].dice;
    for (const session of sessions) {
        const d = session.xuc_xac;
        if (d.length !== 3) continue;
        for (const face of d) dice.face[face] = number(dice.face[face]) + 1;
        const total = number(session.tong);
        dice.total[total] = number(dice.total[total]) + 1;
        if (!dice.totalResult[total]) dice.totalResult[total] = { T: 0, X: 0 };
        const result = toTX(session.ket_qua);
        dice.totalResult[total][result]++;
        const triple = d.join("-");
        dice.triple[triple] = number(dice.triple[triple]) + 1;
        const pairs = [[d[0], d[1]], [d[0], d[2]], [d[1], d[2]]];
        for (const pair of pairs) {
            const key = pair.slice().sort((a, b) => a - b).join("-");
            dice.pair[key] = number(dice.pair[key]) + 1;
        }
        const sequence = d.join("");
        dice.sequence[sequence] = number(dice.sequence[sequence]) + 1;
    }
}

function learnAll(type, sessions) {
    const engine = engines[type];
    if (!sessions.length) return;
    const latest = sessions[sessions.length - 1].phien;
    if (engine.learnedUntil === latest) return;
    learnPattern(type, sessions);
    learnFollowUp(type, sessions);
    learnMarkov(type, sessions);
    learnDice(type, sessions);
    engine.learnedUntil = latest;
    saveJSON(PATHS[type].model, engine);
}

// ============================================================
// HÀM PHÂN TÍCH MỚI – DÙNG THUẬT TOÁN NÂNG CAO
// ============================================================

function analyze(type, sessions) {
    const pattern = buildPattern(sessions);
    const currentResult = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const predictionResult = predictNextAdvancedPro(currentResult, sessions);
    const prediction = predictionResult.du_doan === 'Tài' ? 'TAI' : 'XIU';
    const confidence = predictionResult.do_tin_cay;
    const note = predictionResult.mau_cau;

    const final = { prediction, confidence, note };
    return {
        pattern,
        top10: getTop10Patterns(type, pattern),
        final: final,
        // các trường model1-10 để tương thích nhưng không dùng
        model1: null, model2: null, model3: null, model4: null, model5: null,
        model6: null, model7: null, model8: null, model9: null, model10: null,
        model11: final
    };
}

// ============================================================
// PENDING HISTORY
// ============================================================

function addPending(type, phien, prediction) {
    if (histories[type].some(x => x.phien === phien)) return false;
    histories[type].unshift({
        phien,
        du_doan: prediction ? displayResult(prediction) : "Không rõ",
        ket_qua: "⌛ Chờ Kết Quả",
        danh_gia: "⌛ Chờ Kết Quả",
        xuc_xac: "⌛ Chờ",
        tong: "⌛ Chờ"
    });
    histories[type] = histories[type].slice(0, MAX_HISTORY);
    saveJSON(PATHS[type].history, histories[type]);
    return true;
}

// ============================================================
// SETTLE
// ============================================================

function settle(type, session) {
    const item = histories[type].find(x => x.phien === session.phien);
    if (!item) return false;
    if (item.ket_qua !== "⌛ Chờ Kết Quả") return false;
    item.ket_qua = displayResult(session.ket_qua);
    item.xuc_xac = session.xuc_xac;
    item.tong = session.tong;
    const prediction = normalizeResult(item.du_doan);
    if (prediction && prediction === session.ket_qua) {
        item.danh_gia = "✅ Thắng";
    } else if (prediction) {
        item.danh_gia = "❌ Thua";
    } else {
        item.danh_gia = "⚪ Không rõ";
    }
    updatePerformance(type, session.phien, session.ket_qua);
    saveJSON(PATHS[type].history, histories[type]);
    return true;
}

// ============================================================
// PERFORMANCE – CHỈ CẬP NHẬT MODEL11
// ============================================================

function updatePerformance(type, phien, actual) {
    const prediction = pending[type].get(phien);
    if (!prediction) return;
    const final = prediction.final;
    if (!final || !final.prediction) return;

    const perf = engines[type].performance['model11'];
    if (!perf) return;
    perf.total++;
    if (final.prediction === actual) {
        perf.correct++;
        perf.weight = Math.min(3, perf.weight + 0.05);
    } else {
        perf.wrong++;
        perf.weight = Math.max(0.15, perf.weight - 0.035);
    }

    engines[type].global.total++;
    if (final.prediction === actual) {
        engines[type].global.correct++;
    } else {
        engines[type].global.wrong++;
    }

    pending[type].delete(phien);
    saveJSON(PATHS[type].model, engines[type]);
}

// ============================================================
// PROCESS TYPE
// ============================================================

async function processType(type) {
    try {
        const json = await fetchSource(type);
        const sessions = normalizeSessions(json);
        if (!sessions.length) throw new Error("API không trả session");
        sourceHistory[type] = sessions.slice(-MAX_SOURCE_HISTORY);
        learnAll(type, sourceHistory[type]);

        let changed = false;
        for (const session of sourceHistory[type]) {
            if (settle(type, session)) changed = true;
        }
        if (sourceHistory[type].length < PATTERN_LENGTH) return null;

        const latest = sourceHistory[type][sourceHistory[type].length - 1];
        const nextPhien = latest.phien + 1;
        const analysis = analyze(type, sourceHistory[type]);
        const final = analysis.final;
        const prediction = final.prediction;

        pending[type].set(nextPhien, analysis);
        if (addPending(type, nextPhien, prediction)) changed = true;

        const newSession = lastSourceId[type] === null || lastSourceId[type] !== latest.phien;
        lastSourceId[type] = latest.phien;
        if (newSession) {
            sendSSE(type, "result", {
                phien: latest.phien,
                xuc_xac: latest.xuc_xac,
                tong: latest.tong,
                ket_qua: displayResult(latest.ket_qua)
            });
            changed = true;
        }
        if (changed) sendSSE(type, "history", histories[type]);

        return {
            phien: latest.phien,
            xuc_xac: latest.xuc_xac,
            tong: latest.tong,
            ket_qua: displayResult(latest.ket_qua),
            phien_hien_tai: nextPhien,
            pattern: analysis.pattern,
            du_doan: prediction ? displayResult(prediction) : "Không rõ",
            do_tin_cay: `${final.confidence.toFixed(2)}%`
        };
    } catch (error) {
        console.error(`[${type.toUpperCase()}]`, error.message);
        return null;
    }
}

// ============================================================
// API ENDPOINTS (GIỮ NGUYÊN)
// ============================================================

app.get("/lc79/tx/hu", async (req, res) => {
    const result = await processType("hu");
    if (!result) return res.status(502).json({ error: true, message: "Không lấy được HU" });
    res.json(result);
});

app.get("/lc79/tx/md5", async (req, res) => {
    const result = await processType("md5");
    if (!result) return res.status(502).json({ error: true, message: "Không lấy được MD5" });
    res.json(result);
});

app.get("/api/lc79/hu/history", (req, res) => res.json(histories.hu));
app.get("/api/lc79/md5/history", (req, res) => res.json(histories.md5));

function stream(type, req, res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) res.flushHeaders();
    clients[type].add(res);
    res.write(`event: history\ndata: ${JSON.stringify(histories[type])}\n\n`);
    const heartbeat = setInterval(() => {
        try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 15000);
    req.on("close", () => { clearInterval(heartbeat); clients[type].delete(res); });
}

app.get("/api/lc79/hu/history/stream", (req, res) => stream("hu", req, res));
app.get("/api/lc79/md5/history/stream", (req, res) => stream("md5", req, res));

app.get("/api/lc79/hu/pattern", (req, res) => {
    const pattern = buildPattern(sourceHistory.hu);
    res.json({ ban: "HU", pattern, length: pattern.length, top10: getTop10Patterns("hu", pattern) });
});

app.get("/api/lc79/md5/pattern", (req, res) => {
    const pattern = buildPattern(sourceHistory.md5);
    res.json({ ban: "MD5", pattern, length: pattern.length, top10: getTop10Patterns("md5", pattern) });
});

app.get("/api/lc79/hu/models", (req, res) => {
    res.json({
        ban: "HU",
        patternLength: PATTERN_LENGTH,
        compare: TOP_PATTERN_SAMPLES,
        library: patternLibraries.hu.length,
        learned: Object.keys(engines.hu.patternMemory).length,
        performance: engines.hu.performance,
        global: engines.hu.global
    });
});

app.get("/api/lc79/md5/models", (req, res) => {
    res.json({
        ban: "MD5",
        patternLength: PATTERN_LENGTH,
        compare: TOP_PATTERN_SAMPLES,
        library: patternLibraries.md5.length,
        learned: Object.keys(engines.md5.patternMemory).length,
        performance: engines.md5.performance,
        global: engines.md5.global
    });
});

app.get("/api/lc79/hu/analyze", (req, res) => {
    if (sourceHistory.hu.length < PATTERN_LENGTH) {
        return res.status(400).json({ error: true, message: "Chưa đủ 20 phiên" });
    }
    res.json(analyze("hu", sourceHistory.hu));
});

app.get("/api/lc79/md5/analyze", (req, res) => {
    if (sourceHistory.md5.length < PATTERN_LENGTH) {
        return res.status(400).json({ error: true, message: "Chưa đủ 20 phiên" });
    }
    res.json(analyze("md5", sourceHistory.md5));
});

app.get("/api/lc79/hu/learning", (req, res) => {
    res.json({
        ban: "HU",
        patternLength: PATTERN_LENGTH,
        patternSamples: TOP_PATTERN_SAMPLES,
        learnedPatterns: Object.keys(engines.hu.patternMemory).length,
        followUp: Object.keys(engines.hu.followUp).length,
        markov1: engines.hu.markov1,
        markov2: engines.hu.markov2,
        dice: engines.hu.dice
    });
});

app.get("/api/lc79/md5/learning", (req, res) => {
    res.json({
        ban: "MD5",
        patternLength: PATTERN_LENGTH,
        patternSamples: TOP_PATTERN_SAMPLES,
        learnedPatterns: Object.keys(engines.md5.patternMemory).length,
        followUp: Object.keys(engines.md5.followUp).length,
        markov1: engines.md5.markov1,
        markov2: engines.md5.markov2,
        dice: engines.md5.dice
    });
});

app.get("/api/lc79/hu/patterns", (req, res) => {
    res.json({ ban: "HU", length: PATTERN_LENGTH, total: patternLibraries.hu.length, patterns: patternLibraries.hu });
});

app.get("/api/lc79/md5/patterns", (req, res) => {
    res.json({ ban: "MD5", length: PATTERN_LENGTH, total: patternLibraries.md5.length, patterns: patternLibraries.md5 });
});

app.post("/api/lc79/hu/reset", (req, res) => {
    engines.hu = createEngine("hu");
    engines.hu.performance = createEngine("hu").performance;
    saveJSON(PATHS.hu.model, engines.hu);
    res.json({ success: true, ban: "HU" });
});

app.post("/api/lc79/md5/reset", (req, res) => {
    engines.md5 = createEngine("md5");
    engines.md5.performance = createEngine("md5").performance;
    saveJSON(PATHS.md5.model, engines.md5);
    res.json({ success: true, ban: "MD5" });
});

app.get("/", (req, res) => {
    res.json({
        status: "online",
        engine: "LC79 ULTRA V23",
        pattern: PATTERN_LENGTH,
        compare: TOP_PATTERN_SAMPLES,
        hu: { isolated: true, source: SOURCES.hu },
        md5: { isolated: true, source: SOURCES.md5 },
        learning: true,
        realtime: "SSE",
        polling: `${POLL_MS}ms`
    });
});

app.use((req, res) => {
    res.status(404).json({ error: true, message: "Endpoint không tồn tại" });
});

// ============================================================
// SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║              LC79 ULTRA V23                     ║
╠══════════════════════════════════════════════════╣
║ Pattern chính       : 20 phiên                  ║
║ Pattern so sánh     : TOP 10                    ║
║ HU Engine           : RIÊNG                     ║
║ MD5 Engine          : RIÊNG                     ║
║ Pattern Memory      : RIÊNG                     ║
║ Follow-up Memory    : RIÊNG                     ║
║ Markov              : RIÊNG                     ║
║ Dice Learning       : RIÊNG                     ║
║ Model Weight        : RIÊNG                     ║
║ Backtest Memory     : RIÊNG                     ║
║ Self Learning       : ON                        ║
║ SSE Realtime        : ON                        ║
║ Auto Update         : 3 giây                    ║
║ PORT                : ${String(PORT).padEnd(25)}║
╚══════════════════════════════════════════════════╝
`);
});

// ============================================================
// AUTO UPDATE
// ============================================================

let updating = false;

async function autoUpdate() {
    if (updating) return;
    updating = true;
    try {
        await Promise.allSettled([processType("hu"), processType("md5")]);
    } catch (error) {
        console.error("[AUTO]", error.message);
    } finally {
        updating = false;
    }
}

autoUpdate();
setInterval(autoUpdate, POLL_MS);
