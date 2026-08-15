import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// ============================================================
//  CẤU HÌNH & GLOBAL STATE (V23)
// ============================================================
const PORT = 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PATTERN_LENGTH = 20;                // Số phiên so sánh pattern
const PATTERN_DATABASE_SIZE = 150;         // Số pattern mẫu lưu trong DB
const MAX_HISTORY = 700;
const MAX_PREDICTIONS = 600;

let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;
let currentPattern = "n/a";
let predictionHistory = [];
let predictionMap = {};
let performanceStats = {
    total: 0, win: 0, lose: 0, accuracy: 0, last100: []
};
let patternDatabase = [];                 // Lưu 150 pattern mẫu (chuỗi 20 ký tự)
let patternMatchResult = null;            // Kết quả so sánh gần nhất

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  UTILITIES NÂNG CẤP
// ============================================================
function parseLines(data) {
    if (!data || !Array.isArray(data.list)) return [];
    const sortedList = data.list.sort((a, b) => b.id - a.id);
    const arr = sortedList.map(item => ({
        session: item.id,
        dice: item.dices,
        total: item.point,
        result: item.resultTruyenThong,
        tx: item.point >= 11 ? 'T' : 'X'
    }));
    return arr.sort((a, b) => a.session - b.session);
}

function lastN(arr, n) {
    const start = Math.max(0, arr.length - n);
    return arr.slice(start);
}

function majority(obj) {
    let maxK = null, maxV = -Infinity;
    for (const k in obj) {
        if (obj[k] > maxV) { maxV = obj[k]; maxK = k; }
    }
    return { key: maxK, val: maxV };
}

function sum(nums) { return nums.reduce((a, b) => a + b, 0); }
function avg(nums) { return nums.length ? sum(nums) / nums.length : 0; }
function stdDev(nums) {
    const m = avg(nums);
    return Math.sqrt(avg(nums.map(x => (x - m) ** 2)));
}

function entropy(arr) {
    if (!arr.length) return 0;
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    let e = 0, n = arr.length;
    for (const k in freq) {
        const p = freq[k] / n;
        e -= p * Math.log2(p);
    }
    return e;
}

function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) m++;
    return m / a.length;
}

function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    const freq = {};
    for (const v of tx) freq[v] = (freq[v] || 0) + 1;
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push({ val: cur, len }); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push({ val: cur, len });
    const meanTotal = avg(totals);
    const variance = avg(totals.map(t => Math.pow(t - meanTotal, 2)));
    const last10Totals = totals.slice(-10);
    const upward = last10Totals.filter((t, i) => i > 0 && t > last10Totals[i-1]).length;
    const downward = last10Totals.filter((t, i) => i > 0 && t < last10Totals[i-1]).length;
    return {
        tx, totals, freq, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        meanTotal, stdTotal: Math.sqrt(variance),
        entropy: entropy(tx),
        last3Pattern: tx.slice(-3).join(''),
        last5Pattern: tx.slice(-5).join(''),
        last8Pattern: tx.slice(-8).join(''),
        trends: { upward, downward }
    };
}

// ============================================================
//  PHÁT HIỆN 30+ MẪU CẦU (ĐẦY ĐỦ)
// ============================================================
function detectPatternType(runs) {
    if (runs.length < 3) return null;
    const lastRuns = runs.slice(-6);
    const lengths = lastRuns.map(r => r.len);
    const values = lastRuns.map(r => r.val);

    if (lengths.every(l => l === 1)) {
        const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
        if (isAlternating) return '1_1_pattern';
    }
    if (lengths.every(l => l === 2)) {
        const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
        if (isAlternating) return '2_2_pattern';
    }
    if (lengths.every(l => l === 3)) {
        const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
        if (isAlternating) return '3_3_pattern';
    }
    if (lengths.every(l => l === 4)) {
        const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
        if (isAlternating) return '4_4_pattern';
    }
    if (lengths.every(l => l === 5)) {
        const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
        if (isAlternating) return '5_5_pattern';
    }

    if (lengths.length >= 3 && lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 2) {
        if (runs.length >= 5 && runs[runs.length-5].len === 2 && runs[runs.length-4].len === 1 && runs[runs.length-3].len === 2)
            return '2_1_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 1) {
        if (runs.length >= 5 && runs[runs.length-5].len === 1 && runs[runs.length-4].len === 2 && runs[runs.length-3].len === 1)
            return '1_2_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 3) {
        if (runs.length >= 5 && runs[runs.length-5].len === 3 && runs[runs.length-4].len === 2 && runs[runs.length-3].len === 3)
            return '3_2_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2) {
        if (runs.length >= 5 && runs[runs.length-5].len === 2 && runs[runs.length-4].len === 3 && runs[runs.length-3].len === 2)
            return '2_3_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 3 && lengths[1] === 4 && lengths[2] === 3) {
        if (runs.length >= 5 && runs[runs.length-5].len === 3 && runs[runs.length-4].len === 4 && runs[runs.length-3].len === 3)
            return '3_4_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 4 && lengths[1] === 3 && lengths[2] === 4) {
        if (runs.length >= 5 && runs[runs.length-5].len === 4 && runs[runs.length-4].len === 3 && runs[runs.length-3].len === 4)
            return '4_3_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 4) {
        if (runs.length >= 5 && runs[runs.length-5].len === 4 && runs[runs.length-4].len === 2 && runs[runs.length-3].len === 4)
            return '4_2_pattern';
    }
    if (lengths.length >= 3 && lengths[0] === 2 && lengths[1] === 4 && lengths[2] === 2) {
        if (runs.length >= 5 && runs[runs.length-5].len === 2 && runs[runs.length-4].len === 4 && runs[runs.length-3].len === 2)
            return '2_4_pattern';
    }

    if (lengths.length >= 5 &&
        lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 2 && lengths[3] === 1 && lengths[4] === 2) {
        return '2_1_2_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 1) {
        return '1_2_1_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 3 && lengths[3] === 2 && lengths[4] === 3) {
        return '3_2_3_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 4 && lengths[3] === 2 && lengths[4] === 4) {
        return '4_2_4_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 2 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 2) {
        return '2_2_1_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 1 && lengths[1] === 3 && lengths[2] === 1 && lengths[3] === 3 && lengths[4] === 1) {
        return '1_3_1_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 3 && lengths[1] === 1 && lengths[2] === 3 && lengths[3] === 1 && lengths[4] === 3) {
        return '3_1_3_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 3 && lengths[4] === 2) {
        return '2_3_2_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 2 && lengths[3] === 3 && lengths[4] === 2) {
        return '3_2_2_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 3) {
        return '2_3_1_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 3 && lengths[3] === 1 && lengths[4] === 2) {
        return '1_2_3_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 3 && lengths[4] === 2) {
        return '3_2_1_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 3 && lengths[3] === 2 && lengths[4] === 1) {
        return '2_1_3_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 3 && lengths[1] === 1 && lengths[2] === 2 && lengths[3] === 3 && lengths[4] === 1) {
        return '3_1_2_pattern';
    }
    if (lengths.length >= 5 &&
        lengths[0] === 1 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 1 && lengths[4] === 3) {
        return '1_3_2_pattern';
    }

    const lastRun = lastRuns[lastRuns.length - 1];
    if (lastRun && lastRun.len >= 5) return 'long_run_pattern';

    return 'random_pattern';
}

function predictNextFromPattern(patternType, runs, lastTx) {
    if (!patternType) return null;
    const lastRun = runs[runs.length - 1];

    switch (patternType) {
        case '1_1_pattern': return lastTx === 'T' ? 'X' : 'T';
        case '2_2_pattern':
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            return lastRun.val;
        case '3_3_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            return lastRun.val;
        case '4_4_pattern':
            if (lastRun.len === 4) return lastRun.val === 'T' ? 'X' : 'T';
            return lastRun.val;
        case '5_5_pattern':
            if (lastRun.len === 5) return lastRun.val === 'T' ? 'X' : 'T';
            return lastRun.val;
        case '2_1_pattern':
            if (lastRun.len === 2) return 'X';
            if (lastRun.len === 1) return 'T';
            return lastRun.val;
        case '1_2_pattern':
            if (lastRun.len === 1) return 'X';
            if (lastRun.len === 2) return 'T';
            return lastRun.val;
        case '3_2_pattern':
            if (lastRun.len === 3) return 'X';
            if (lastRun.len === 2) return 'T';
            return lastRun.val;
        case '2_3_pattern':
            if (lastRun.len === 2) return 'X';
            if (lastRun.len === 3) return 'T';
            return lastRun.val;
        case '3_4_pattern':
            if (lastRun.len === 3) return 'X';
            if (lastRun.len === 4) return 'T';
            return lastRun.val;
        case '4_3_pattern':
            if (lastRun.len === 4) return 'X';
            if (lastRun.len === 3) return 'T';
            return lastRun.val;
        case '4_2_pattern':
            if (lastRun.len === 4) return 'X';
            if (lastRun.len === 2) return 'T';
            return lastRun.val;
        case '2_4_pattern':
            if (lastRun.len === 2) return 'X';
            if (lastRun.len === 4) return 'T';
            return lastRun.val;
        case '2_1_2_pattern':
            if (lastRun.val === 'T' && lastRun.len === 2) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 2) return 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '1_2_1_pattern':
            if (lastRun.val === 'T' && lastRun.len === 1) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 1) return 'T';
            if (lastRun.len === 2) return lastRun.val;
            return null;
        case '3_2_3_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '4_2_4_pattern':
            if (lastRun.len === 4) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '2_2_1_pattern':
            if (lastRun.len === 2 && lastRun.val === 'T') return 'T';
            if (lastRun.len === 2 && lastRun.val === 'X') return 'X';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '1_3_1_pattern':
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '3_1_3_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '2_3_2_pattern':
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '3_2_2_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '2_3_1_pattern':
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '1_2_3_pattern':
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '3_2_1_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '2_1_3_pattern':
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '3_1_2_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case '1_3_2_pattern':
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
            return null;
        case 'long_run_pattern':
            if (lastRun.len > 7) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len >= 4 && lastRun.len <= 7) return lastRun.val;
            return null;
        default:
            return null;
    }
}

// ============================================================
//  16 THUẬT TOÁN CŨ (VIẾT ĐẦY ĐỦ)
// ============================================================
function algo5_freqRebalance(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { freq, entropy: e } = features;
    const tCount = freq['T'] || 0;
    const xCount = freq['X'] || 0;
    const diff = Math.abs(tCount - xCount);
    const total = tCount + xCount;
    let threshold;
    if (e > 0.9) threshold = 0.45;
    else if (e < 0.4) threshold = 0.65;
    else threshold = 0.55;
    const recent = history.slice(-30);
    const recentT = recent.filter(h => h.tx === 'T').length;
    const recentX = recent.filter(h => h.tx === 'X').length;
    const recentDiff = Math.abs(recentT - recentX);
    const recentTotal = recentT + recentX;
    if (total > 0 && recentTotal > 0) {
        const longTermRatio = diff / total;
        const shortTermRatio = recentDiff / recentTotal;
        const combinedRatio = (longTermRatio * 0.4) + (shortTermRatio * 0.6);
        if (combinedRatio > threshold) {
            if (recentT > recentX + 2) return 'X';
            if (recentX > recentT + 2) return 'T';
        }
    }
    return null;
}

function algoA_markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    let maxOrder = 4;
    if (history.length < 30) maxOrder = 3;
    if (history.length < 20) maxOrder = 2;
    let bestPred = null;
    let bestScore = -1;
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        const transitions = {};
        const totalTransitions = tx.length - order;
        const decayFactor = 0.95;
        for (let i = 0; i < totalTransitions; i++) {
            const key = tx.slice(i, i + order).join('');
            const next = tx[i + order];
            const weight = Math.pow(decayFactor, totalTransitions - i - 1);
            if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
            transitions[key][next] += weight;
        }
        const lastKey = tx.slice(-order).join('');
        const counts = transitions[lastKey];
        if (counts && (counts.T + counts.X) > 0.5) {
            const total = counts.T + counts.X;
            const confidence = Math.abs(counts.T - counts.X) / total;
            const pred = counts.T > counts.X ? 'T' : 'X';
            const orderWeight = order / maxOrder;
            const supportWeight = Math.min(1, (counts.T + counts.X) / 10);
            const score = confidence * orderWeight * supportWeight;
            if (score > bestScore) {
                bestScore = score;
                bestPred = pred;
            }
        }
    }
    return bestPred;
}

function algoB_ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const ngramSizes = [];
    if (history.length >= 50) ngramSizes.push(5, 6);
    if (history.length >= 40) ngramSizes.push(4);
    ngramSizes.push(3, 2);
    let bestPred = null;
    let bestConfidence = 0;
    for (const n of ngramSizes) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        let matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            const gram = tx.slice(i, i + n).join('');
            if (gram === target) {
                matches.push({ position: i, next: tx[i + n], distance: tx.length - i });
            }
        }
        if (matches.length >= 2) {
            const weights = { T: 0, X: 0 };
            let totalWeight = 0;
            for (const match of matches) {
                const weight = 1 / (match.distance * 0.5 + 1);
                weights[match.next] += weight;
                totalWeight += weight;
            }
            if (totalWeight > 0) {
                const tRatio = weights.T / totalWeight;
                const xRatio = weights.X / totalWeight;
                const confidence = Math.abs(tRatio - xRatio);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestPred = weights.T > weights.X ? 'T' : 'X';
                }
            }
        }
    }
    return bestConfidence > 0.3 ? bestPred : null;
}

function algoS_NeoPattern(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const prediction = predictNextFromPattern(patternType, runs, lastTx);
    if (prediction) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const patternConsistency = recentRuns.filter(r =>
            patternType.includes('_pattern') ||
            (patternType === 'long_run_pattern' && r.len >= 4)
        ).length / recentRuns.length;
        if (patternConsistency > 0.6) return prediction;
    }
    return null;
}

function algoF_SuperDeepAnalysis(history) {
    if (history.length < 60) return null;
    const timeframes = [
        { lookback: 10, weight: 0.3 },
        { lookback: 30, weight: 0.4 },
        { lookback: 60, weight: 0.3 }
    ];
    let totalScore = { T: 0, X: 0 };
    let totalWeight = 0;
    for (const tf of timeframes) {
        if (history.length < tf.lookback) continue;
        const slice = history.slice(-tf.lookback);
        const sliceTx = slice.map(h => h.tx);
        const sliceTotals = slice.map(h => h.total);
        const tCount = sliceTx.filter(t => t === 'T').length;
        const xCount = sliceTx.filter(t => t === 'X').length;
        const meanTotal = avg(sliceTotals);
        const volatility = Math.sqrt(avg(sliceTotals.map(t => Math.pow(t - meanTotal, 2))));
        let tScore = 0, xScore = 0;
        if (meanTotal > 12) xScore += 0.4;
        if (meanTotal < 9) tScore += 0.4;
        if (tCount > xCount + 3) xScore += 0.3;
        if (xCount > tCount + 3) tScore += 0.3;
        if (volatility > 4) {
            if (sliceTx[sliceTx.length - 1] === 'T') tScore += 0.2;
            else xScore += 0.2;
        }
        const trend = sliceTotals[sliceTotals.length - 1] - sliceTotals[0];
        if (trend > 3) xScore += 0.1;
        if (trend < -3) tScore += 0.1;
        const timeframeWeight = tf.weight * (sliceTx.length / tf.lookback);
        totalScore.T += tScore * timeframeWeight;
        totalScore.X += xScore * timeframeWeight;
        totalWeight += timeframeWeight;
    }
    if (totalWeight > 0 && Math.abs(totalScore.T - totalScore.X) > 0.15) {
        return totalScore.T > totalScore.X ? 'T' : 'X';
    }
    return null;
}

function algoE_Transformer(history) {
    if (history.length < 100) return null;
    const tx = history.map(h => h.tx);
    const seqLengths = [6, 8, 10, 12];
    let attentionScores = { T: 0, X: 0 };
    for (const seqLen of seqLengths) {
        if (tx.length < seqLen * 2) continue;
        const targetSeq = tx.slice(-seqLen).join('');
        let seqMatches = 0;
        for (let i = 0; i <= tx.length - seqLen - 1; i++) {
            const historySeq = tx.slice(i, i + seqLen).join('');
            const matchScore = similarity(historySeq, targetSeq);
            if (matchScore >= 0.7) {
                const nextResult = tx[i + seqLen];
                const recency = 1 / (tx.length - i);
                const lengthFactor = seqLen / 12;
                const weight = matchScore * recency * lengthFactor;
                attentionScores[nextResult] = (attentionScores[nextResult] || 0) + weight;
                seqMatches++;
            }
        }
        if (seqMatches >= 3) {
            const boostFactor = Math.min(1.5, seqMatches / 2);
            attentionScores.T *= boostFactor;
            attentionScores.X *= boostFactor;
        }
    }
    if (attentionScores.T + attentionScores.X > 0.2) {
        const total = attentionScores.T + attentionScores.X;
        const confidence = Math.abs(attentionScores.T - attentionScores.X) / total;
        if (confidence > 0.25) {
            return attentionScores.T > attentionScores.X ? 'T' : 'X';
        }
    }
    return null;
}

function algoG_SuperBridgePredictor(history) {
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 4) return null;
    const lastRun = runs[runs.length - 1];
    let prediction = null;
    let confidence = 0;
    if (lastRun.len >= 5) {
        if (lastRun.len >= 8) {
            prediction = lastRun.val === 'T' ? 'X' : 'T';
            confidence = 0.8;
        } else if (lastRun.len >= 5 && lastRun.len <= 7) {
            const avgRunLength = avg(runs.map(r => r.len));
            if (lastRun.len > avgRunLength * 1.8) {
                prediction = lastRun.val === 'T' ? 'X' : 'T';
                confidence = 0.65;
            } else {
                prediction = lastRun.val;
                confidence = 0.6;
            }
        }
    }
    if (!prediction && runs.length >= 5) {
        const last5Runs = runs.slice(-5);
        const lengths = last5Runs.map(r => r.len);
        if (lengths[0] === 1 && lengths[1] === 1 && lengths[2] >= 3) {
            if (lastRun.len >= 3) {
                prediction = lastRun.val === 'T' ? 'X' : 'T';
                confidence = 0.7;
            }
        }
        if (lengths.length >= 4) {
            if (lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 3) {
                prediction = lastRun.val === 'T' ? 'T' : 'X';
                confidence = 0.6;
            }
        }
    }
    if (!prediction && runs.length >= 8) {
        const recentRuns = runs.slice(-8);
        const runLengths = recentRuns.map(r => r.len);
        const currentRunLength = lastRun.len;
        const meanLength = avg(runLengths);
        const stdLength = Math.sqrt(avg(runLengths.map(l => Math.pow(l - meanLength, 2))));
        if (currentRunLength > meanLength + (stdLength * 1.5)) {
            prediction = lastRun.val === 'T' ? 'X' : 'T';
            confidence = 0.6;
        }
    }
    return confidence > 0.55 ? prediction : null;
}

function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const models = [
        { type: 'markov', orders: [2, 3, 4] },
        { type: 'frequency', lookbacks: [10, 20, 30] },
        { type: 'momentum', windows: [5, 10, 15] }
    ];
    let ensembleVotes = { T: 0, X: 0 };
    for (const model of models) {
        if (model.type === 'markov') {
            for (const order of model.orders) {
                if (tx.length < order + 5) continue;
                const transitions = {};
                for (let i = 0; i <= tx.length - order - 1; i++) {
                    const key = tx.slice(i, i + order).join('');
                    const next = tx[i + order];
                    if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
                    transitions[key][next]++;
                }
                const lastKey = tx.slice(-order).join('');
                const counts = transitions[lastKey];
                if (counts && counts.T + counts.X >= 2) {
                    const pred = counts.T > counts.X ? 'T' : 'X';
                    const confidence = Math.abs(counts.T - counts.X) / (counts.T + counts.X);
                    ensembleVotes[pred] += confidence * (order / 10);
                }
            }
        }
        if (model.type === 'frequency') {
            for (const lookback of model.lookbacks) {
                if (tx.length < lookback) continue;
                const recent = tx.slice(-lookback);
                const tCount = recent.filter(t => t === 'T').length;
                const xCount = recent.filter(t => t === 'X').length;
                if (Math.abs(tCount - xCount) > lookback * 0.2) {
                    const pred = tCount > xCount ? 'X' : 'T';
                    const confidence = Math.abs(tCount - xCount) / lookback;
                    ensembleVotes[pred] += confidence * 0.5;
                }
            }
        }
        if (model.type === 'momentum') {
            for (const window of model.windows) {
                if (tx.length < window * 2) continue;
                const firstHalf = tx.slice(-window * 2, -window);
                const secondHalf = tx.slice(-window);
                const firstT = firstHalf.filter(t => t === 'T').length;
                const firstX = firstHalf.filter(t => t === 'X').length;
                const secondT = secondHalf.filter(t => t === 'T').length;
                const secondX = secondHalf.filter(t => t === 'X').length;
                const momentumT = secondT - firstT;
                const momentumX = secondX - firstX;
                if (Math.abs(momentumT - momentumX) > window * 0.3) {
                    const pred = momentumT > momentumX ? 'T' : 'X';
                    const confidence = Math.abs(momentumT - momentumX) / window;
                    ensembleVotes[pred] += confidence * 0.3;
                }
            }
        }
    }
    if (ensembleVotes.T + ensembleVotes.X > 0.3) {
        return ensembleVotes.T > ensembleVotes.X ? 'T' : 'X';
    }
    return null;
}

function algoI_PatternMaster(history) {
    if (history.length < 35) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    if (runs.length < 5) return null;
    const recentRuns = runs.slice(-Math.min(8, runs.length));
    const runLengths = recentRuns.map(r => r.len);
    const runValues = recentRuns.map(r => r.val);
    let patternStrength = { T: 0, X: 0 };
    const runPattern = runLengths.join('');
    const valuePattern = runValues.join('');
    const patternLibrary = [
        { pattern: '12121', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.7 },
        { pattern: '21212', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'T' : 'X', strength: 0.7 },
        { pattern: '13131', prediction: valuePattern[valuePattern.length-1], strength: 0.6 },
        { pattern: '31313', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.6 },
        { pattern: '24242', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.65 },
        { pattern: '42424', prediction: valuePattern[valuePattern.length-1], strength: 0.65 }
    ];
    for (const libPattern of patternLibrary) {
        if (runPattern.includes(libPattern.pattern)) {
            patternStrength[libPattern.prediction] += libPattern.strength;
        }
    }
    const last10Tx = tx.slice(-10).join('');
    const txPatterns = [
        { pattern: 'TXTXTXTX', prediction: 'X', strength: 0.8 },
        { pattern: 'XTXTXTXT', prediction: 'T', strength: 0.8 },
        { pattern: 'TTXXTTXX', prediction: 'X', strength: 0.7 },
        { pattern: 'XXTTXXTT', prediction: 'T', strength: 0.7 },
        { pattern: 'TTTXXXTT', prediction: 'T', strength: 0.75 },
        { pattern: 'XXXTTTXX', prediction: 'X', strength: 0.75 },
        { pattern: 'TTXTTXTT', prediction: 'X', strength: 0.7 },
        { pattern: 'XXTXXTXX', prediction: 'T', strength: 0.7 }
    ];
    for (const txPattern of txPatterns) {
        if (last10Tx.includes(txPattern.pattern)) {
            patternStrength[txPattern.prediction] += txPattern.strength;
        }
    }
    const lastRun = recentRuns[recentRuns.length - 1];
    if (lastRun) {
        const avgRecentLength = avg(runLengths);
        const currentRunAge = lastRun.len;
        if (currentRunAge > avgRecentLength * 1.8) {
            patternStrength[lastRun.val === 'T' ? 'X' : 'T'] += 0.5;
        } else if (currentRunAge < avgRecentLength * 0.6) {
            patternStrength[lastRun.val] += 0.4;
        }
    }
    if (patternStrength.T > 0 || patternStrength.X > 0) {
        const totalStrength = patternStrength.T + patternStrength.X;
        const confidence = Math.abs(patternStrength.T - patternStrength.X) / totalStrength;
        if (confidence > 0.3) {
            return patternStrength.T > patternStrength.X ? 'T' : 'X';
        }
    }
    return null;
}

function algoJ_QuantumEntropy(history) {
    if (history.length < 40) return null;
    const features = extractFeatures(history);
    const { entropy: e, tx, runs } = features;
    const entropyWindows = [10, 20, 30];
    let entropyPredictions = { T: 0, X: 0 };
    for (const window of entropyWindows) {
        if (tx.length < window) continue;
        const windowTx = tx.slice(-window);
        const windowEntropy = entropy(windowTx);
        if (windowEntropy < 0.3) {
            const lastVal = windowTx[windowTx.length - 1];
            entropyPredictions[lastVal] += 0.6;
        } else if (windowEntropy > 0.9) {
            const tCount = windowTx.filter(t => t === 'T').length;
            const xCount = windowTx.filter(t => t === 'X').length;
            if (tCount > xCount) entropyPredictions['X'] += 0.5;
            else if (xCount > tCount) entropyPredictions['T'] += 0.5;
        } else {
            const recentRuns = runs.slice(-4);
            if (recentRuns.length >= 3) {
                const runLengths = recentRuns.map(r => r.len);
                const isEmergingPattern = Math.max(...runLengths) - Math.min(...runLengths) <= 2;
                if (isEmergingPattern) {
                    const lastVal = tx[tx.length - 1];
                    entropyPredictions[lastVal] += 0.4;
                }
            }
        }
    }
    if (e < 0.4) {
        const lastVal = tx[tx.length - 1];
        entropyPredictions[lastVal] += 0.3;
    } else if (e > 0.95) {
        const recentT = tx.slice(-20).filter(t => t === 'T').length;
        const recentX = tx.slice(-20).filter(t => t === 'X').length;
        if (recentT > recentX) entropyPredictions['X'] += 0.4;
        else if (recentX > recentT) entropyPredictions['T'] += 0.4;
    }
    if (entropyPredictions.T + entropyPredictions.X > 0.4) {
        return entropyPredictions.T > entropyPredictions.X ? 'T' : 'X';
    }
    return null;
}

function algoK_PatternHunter(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const prediction = predictNextFromPattern(patternType, runs, lastTx);
    if (prediction) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const patternConsistency = recentRuns.filter(r =>
            patternType.includes('_pattern') ||
            (patternType === 'long_run_pattern' && r.len >= 4)
        ).length / recentRuns.length;
        if (patternConsistency > 0.55) return prediction;
    }
    return null;
}

function algoL_CycleDetector(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    for (let cycle = 2; cycle <= 6; cycle++) {
        if (tx.length < cycle * 2) continue;
        const lastCycle = tx.slice(-cycle).join('');
        let matchCount = 0, totalChecks = 0;
        for (let i = tx.length - cycle - 1; i >= 0; i -= cycle) {
            const prevCycle = tx.slice(i, i + cycle).join('');
            if (prevCycle === lastCycle) matchCount++;
            totalChecks++;
            if (totalChecks >= 5) break;
        }
        if (totalChecks >= 3 && matchCount / totalChecks >= 0.6) {
            const nextIndex = (tx.length % cycle);
            const nextTx = tx[tx.length - cycle + nextIndex];
            if (nextTx) return nextTx;
        }
    }
    return null;
}

function algoM_HyperCycle(history) {
    if (history.length < 50) return null;
    const tx = history.map(h => h.tx);
    for (let cycle = 7; cycle <= 15; cycle++) {
        if (tx.length < cycle * 3) continue;
        const lastCycle = tx.slice(-cycle).join('');
        let matches = 0, total = 0;
        for (let i = tx.length - cycle - 1; i >= 0; i -= cycle) {
            const prev = tx.slice(i, i + cycle).join('');
            if (prev === lastCycle) matches++;
            total++;
            if (total >= 4) break;
        }
        if (total >= 3 && matches / total >= 0.6) {
            const nextIdx = (tx.length % cycle);
            const next = tx[tx.length - cycle + nextIdx];
            if (next) return next;
        }
    }
    return null;
}

function algoN_Fourier(history) {
    if (history.length < 40) return null;
    const tx = history.map(h => h.tx);
    const map = { T: 1, X: -1 };
    const signal = tx.map(v => map[v]);
    for (let len = 2; len <= 6; len++) {
        const patterns = {};
        for (let i = 0; i <= signal.length - len - 1; i++) {
            const key = tx.slice(i, i + len).join('');
            const next = tx[i + len];
            if (!patterns[key]) patterns[key] = { T: 0, X: 0 };
            patterns[key][next]++;
        }
        const lastKey = tx.slice(-len).join('');
        const counts = patterns[lastKey];
        if (counts && (counts.T + counts.X) >= 3) {
            const ratio = counts.T / (counts.T + counts.X);
            if (ratio > 0.65) return 'T';
            if (ratio < 0.35) return 'X';
        }
    }
    return null;
}

function algoO_AdaptiveNeural(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const weights = [];
    const window = 10;
    for (let i = 0; i <= tx.length - window - 1; i++) {
        const slice = tx.slice(i, i + window);
        const next = tx[i + window];
        const val = slice.map(v => v === 'T' ? 1 : -1);
        const sum = val.reduce((a, b) => a + b, 0);
        weights.push({ sum, next });
    }
    const recentWindow = tx.slice(-window);
    const recentSum = recentWindow.map(v => v === 'T' ? 1 : -1).reduce((a, b) => a + b, 0);
    let tScore = 0, xScore = 0;
    for (const w of weights) {
        const diff = Math.abs(w.sum - recentSum);
        if (diff <= 2) {
            if (w.next === 'T') tScore++;
            else xScore++;
        }
    }
    if (tScore + xScore >= 5) {
        return tScore > xScore ? 'T' : 'X';
    }
    return null;
}

function algoP_StatisticalArima(history) {
    if (history.length < 50) return null;
    const totals = history.map(h => h.total);
    const tx = history.map(h => h.tx);
    const recent = totals.slice(-20);
    const mean = avg(recent);
    const std = stdDev(recent);
    const last = recent[recent.length - 1];
    const diff = last - mean;
    if (diff > 1.5 * std) return 'X';
    if (diff < -1.5 * std) return 'T';
    const lastRun = tx.slice(-5);
    const tCount = lastRun.filter(v => v === 'T').length;
    if (tCount >= 4) return 'X';
    if (tCount <= 1) return 'T';
    return null;
}

// ============================================================
//  5 THUẬT TOÁN MỚI (BỔ SUNG)
// ============================================================
function algoQ_RandomForest(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const features = extractFeatures(history);
    const { runs, meanTotal, stdTotal, entropy } = features;
    let votes = { T: 0, X: 0 };
    for (let i = 0; i < 10; i++) {
        const rand = Math.random();
        if (rand < 0.3) {
            if (meanTotal > 11) votes.X++;
            else votes.T++;
        } else if (rand < 0.6) {
            if (entropy < 0.4) votes[tx[tx.length-1]]++;
            else votes[tx[tx.length-1] === 'T' ? 'X' : 'T']++;
        } else if (rand < 0.8) {
            const lastRun = runs[runs.length-1];
            if (lastRun && lastRun.len > 3) votes[lastRun.val === 'T' ? 'X' : 'T']++;
            else votes[lastRun ? lastRun.val : 'T']++;
        } else {
            const tCount = tx.filter(v => v === 'T').length;
            const xCount = tx.length - tCount;
            votes[tCount > xCount ? 'T' : 'X']++;
        }
    }
    if (votes.T === votes.X) return null;
    return votes.T > votes.X ? 'T' : 'X';
}

function algoR_DecisionTree(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const features = extractFeatures(history);
    const { runs, meanTotal, stdTotal } = features;
    if (meanTotal > 11.5) {
        if (stdTotal > 3) return tx[tx.length-1] === 'T' ? 'X' : 'T';
        else return 'X';
    } else if (meanTotal < 9.5) {
        if (stdTotal < 2) return 'T';
        else return tx[tx.length-1] === 'T' ? 'T' : 'X';
    } else {
        const lastRun = runs[runs.length-1];
        if (lastRun && lastRun.len >= 4) return lastRun.val === 'T' ? 'X' : 'T';
        else return tx[tx.length-1];
    }
}

function algoS_LstmSim(history) {
    if (history.length < 40) return null;
    const tx = history.map(h => h.tx);
    const window = 10;
    const sequences = [];
    for (let i = 0; i <= tx.length - window - 1; i++) {
        const seq = tx.slice(i, i + window).join('');
        const next = tx[i + window];
        sequences.push({ seq, next });
    }
    const lastSeq = tx.slice(-window).join('');
    let tScore = 0, xScore = 0;
    for (const s of sequences) {
        const sim = similarity(lastSeq.split(''), s.seq.split(''));
        if (sim > 0.6) {
            if (s.next === 'T') tScore += sim;
            else xScore += sim;
        }
    }
    if (tScore + xScore < 0.5) return null;
    return tScore > xScore ? 'T' : 'X';
}

function algoT_Hybrid(history) {
    if (history.length < 30) return null;
    const preds = [];
    const algs = [algoA_markov, algoS_NeoPattern, algoN_Fourier];
    for (const fn of algs) {
        try { const p = fn(history); if (p) preds.push(p); } catch(e) {}
    }
    if (preds.length === 0) return null;
    const tCount = preds.filter(p => p === 'T').length;
    const xCount = preds.length - tCount;
    if (tCount === xCount) {
        const features = extractFeatures(history);
        return features.entropy < 0.5 ? preds[0] : (preds[0] === 'T' ? 'X' : 'T');
    }
    return tCount > xCount ? 'T' : 'X';
}

function algoU_EnsembleStacking(history) {
    if (history.length < 40) return null;
    const subModels = [algo5_freqRebalance, algoB_ngram, algoF_SuperDeepAnalysis, algoJ_QuantumEntropy];
    let votes = { T: 0, X: 0 };
    let totalWeight = 0;
    for (const fn of subModels) {
        try {
            const pred = fn(history);
            if (!pred) continue;
            const weight = 1 + Math.random() * 0.5;
            votes[pred] += weight;
            totalWeight += weight;
        } catch(e) {}
    }
    if (totalWeight === 0) return null;
    return votes.T > votes.X ? 'T' : 'X';
}

// ============================================================
//  DANH SÁCH 21 THUẬT TOÁN
// ============================================================
const ALL_ALGS = [
    { id: 'algo5_freqrebalance', fn: algo5_freqRebalance },
    { id: 'a_markov', fn: algoA_markov },
    { id: 'b_ngram', fn: algoB_ngram },
    { id: 's_neo_pattern', fn: algoS_NeoPattern },
    { id: 'f_super_deep_analysis', fn: algoF_SuperDeepAnalysis },
    { id: 'e_transformer', fn: algoE_Transformer },
    { id: 'g_super_bridge_predictor', fn: algoG_SuperBridgePredictor },
    { id: 'h_adaptive_markov', fn: algoH_AdaptiveMarkov },
    { id: 'i_pattern_master', fn: algoI_PatternMaster },
    { id: 'j_quantum_entropy', fn: algoJ_QuantumEntropy },
    { id: 'k_pattern_hunter', fn: algoK_PatternHunter },
    { id: 'l_cycle_detector', fn: algoL_CycleDetector },
    { id: 'm_hyper_cycle', fn: algoM_HyperCycle },
    { id: 'n_fourier', fn: algoN_Fourier },
    { id: 'o_adaptive_neural', fn: algoO_AdaptiveNeural },
    { id: 'p_statistical_arima', fn: algoP_StatisticalArima },
    { id: 'q_random_forest', fn: algoQ_RandomForest },
    { id: 'r_decision_tree', fn: algoR_DecisionTree },
    { id: 's_lstm_sim', fn: algoS_LstmSim },
    { id: 't_hybrid', fn: algoT_Hybrid },
    { id: 'u_ensemble_stacking', fn: algoU_EnsembleStacking }
];

// ============================================================
//  ENSEMBLE CLASSIFIER V23
// ============================================================
class SEIUEnsembleV23 {
    constructor(algorithms, opts = {}) {
        this.algs = algorithms;
        this.weights = {};
        this.emaAlpha = opts.emaAlpha ?? 0.08;
        this.minWeight = opts.minWeight ?? 0.01;
        this.historyWindow = opts.historyWindow ?? 700;
        this.performanceHistory = {};
        this.patternMemory = {};
        for (const a of algorithms) {
            this.weights[a.id] = 1.0;
            this.performanceHistory[a.id] = [];
        }
    }

    fitInitial(history) {
        const window = lastN(history, Math.min(this.historyWindow, history.length));
        if (window.length < 30) return;
        const algScores = {};
        for (const a of this.algs) algScores[a.id] = 0;
        const evalSamples = Math.min(40, window.length - 15);
        const startIdx = window.length - evalSamples;
        for (let i = Math.max(15, startIdx); i < window.length; i++) {
            const prefix = window.slice(0, i);
            const actual = window[i].tx;
            const features = extractFeatures(prefix);
            const patternType = detectPatternType(features.runs);
            for (const a of this.algs) {
                try {
                    const pred = a.fn(prefix);
                    if (pred && pred === actual) {
                        algScores[a.id] += 1;
                        if (patternType) {
                            const key = `${a.id}_${patternType}`;
                            this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                        }
                    }
                } catch (e) {}
            }
        }
        let totalWeight = 0;
        for (const id in algScores) {
            const score = algScores[id] || 0;
            const accuracy = score / evalSamples;
            const baseWeight = 0.3 + (accuracy * 0.7);
            this.weights[id] = Math.max(this.minWeight, baseWeight);
            totalWeight += this.weights[id];
        }
        if (totalWeight > 0) {
            for (const id in this.weights) {
                this.weights[id] /= totalWeight;
            }
        }
        console.log(`⚖️ V23: Khởi tạo trọng số cho ${Object.keys(this.weights).length} thuật toán.`);
    }

    updateWithOutcome(historyPrefix, actualTx) {
        if (historyPrefix.length < 10) return;
        const features = extractFeatures(historyPrefix);
        const patternType = detectPatternType(features.runs);
        for (const a of this.algs) {
            try {
                const pred = a.fn(historyPrefix);
                const correct = pred === actualTx ? 1 : 0;
                this.performanceHistory[a.id].push(correct);
                if (this.performanceHistory[a.id].length > 60) {
                    this.performanceHistory[a.id].shift();
                }
                const recentPerf = lastN(this.performanceHistory[a.id], 25);
                let weightedAccuracy = 0, weightSum = 0;
                for (let i = 0; i < recentPerf.length; i++) {
                    const weight = Math.pow(0.92, recentPerf.length - i - 1);
                    weightedAccuracy += recentPerf[i] * weight;
                    weightSum += weight;
                }
                const recentAccuracy = weightSum > 0 ? weightedAccuracy / weightSum : 0.5;
                let patternBonus = 0;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 3) patternBonus = 0.15;
                }
                const targetWeight = Math.min(1, recentAccuracy + patternBonus + 0.1);
                const currentWeight = this.weights[a.id] || this.minWeight;
                const newWeight = this.emaAlpha * targetWeight + (1 - this.emaAlpha) * currentWeight;
                this.weights[a.id] = Math.max(this.minWeight, Math.min(1.6, newWeight));
                if (patternType && correct) {
                    const key = `${a.id}_${patternType}`;
                    this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                }
            } catch (e) {
                this.weights[a.id] = Math.max(this.minWeight, (this.weights[a.id] || 1) * 0.9);
            }
        }
        const sumWeights = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (sumWeights > 0) {
            for (const id in this.weights) {
                this.weights[id] /= sumWeights;
            }
        }
    }

    predict(history) {
        if (history.length < 12) {
            return { prediction: 'tài', confidence: 0.5, rawPrediction: 'T' };
        }
        const features = extractFeatures(history);
        const patternType = detectPatternType(features.runs);
        const votes = { T: 0, X: 0 };
        let algorithmDetails = [];
        for (const a of this.algs) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                let weight = this.weights[a.id] || this.minWeight;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 2) weight *= 1.25;
                }
                votes[pred] = (votes[pred] || 0) + weight;
                algorithmDetails.push({ algorithm: a.id, prediction: pred, weight: weight });
            } catch (e) {}
        }
        if (votes.T === 0 && votes.X === 0) {
            const fallback = algo5_freqRebalance(history) || 'T';
            return { prediction: fallback === 'T' ? 'tài' : 'xỉu', confidence: 0.5, rawPrediction: fallback };
        }
        const { key: best, val: bestVal } = majority(votes);
        const totalVotes = votes.T + votes.X;
        const baseConfidence = bestVal / totalVotes;
        let consensusBonus = 0;
        const tAlgorithms = algorithmDetails.filter(a => a.prediction === 'T').length;
        const xAlgorithms = algorithmDetails.filter(a => a.prediction === 'X').length;
        const totalAlgorithms = tAlgorithms + xAlgorithms;
        if (totalAlgorithms > 0) {
            const consensusRatio = Math.max(tAlgorithms, xAlgorithms) / totalAlgorithms;
            if (consensusRatio > 0.7) consensusBonus = 0.12;
            if (consensusRatio > 0.85) consensusBonus = 0.18;
        }
        const confidence = Math.min(0.97, Math.max(0.55, baseConfidence + consensusBonus));
        return {
            prediction: best === 'T' ? 'tài' : 'xỉu',
            confidence,
            rawPrediction: best
        };
    }
}

// ============================================================
//  XÂY DỰNG DATABASE 150 PATTERN MẪU
// ============================================================
function buildPatternDatabase(history, size = PATTERN_DATABASE_SIZE) {
    const patterns = [];
    const tx = history.map(h => h.tx);
    if (tx.length < PATTERN_LENGTH + 2) return patterns;
    const step = Math.max(1, Math.floor((tx.length - PATTERN_LENGTH) / size));
    for (let i = 0; i <= tx.length - PATTERN_LENGTH && patterns.length < size; i += step) {
        const p = tx.slice(i, i + PATTERN_LENGTH).join('');
        const next = (i + PATTERN_LENGTH < tx.length) ? tx[i + PATTERN_LENGTH] : null;
        patterns.push({ pattern: p, next });
    }
    if (patterns.length < size && tx.length >= PATTERN_LENGTH) {
        for (let i = 0; patterns.length < size && i < tx.length - PATTERN_LENGTH; i++) {
            const p = tx.slice(i, i + PATTERN_LENGTH).join('');
            const next = (i + PATTERN_LENGTH < tx.length) ? tx[i + PATTERN_LENGTH] : null;
            if (!patterns.some(item => item.pattern === p)) {
                patterns.push({ pattern: p, next });
            }
        }
    }
    return patterns;
}

// ============================================================
//  HÀM SO SÁNH PATTERN
// ============================================================
function matchPattern(history, db) {
    if (history.length < PATTERN_LENGTH || db.length === 0) return null;
    const currentTx = history.map(h => h.tx).slice(-PATTERN_LENGTH);
    const currentStr = currentTx.join('');
    let bestMatch = null;
    let bestSim = 0;
    let bestNext = null;
    for (const entry of db) {
        const sim = similarity(currentStr.split(''), entry.pattern.split(''));
        if (sim > bestSim) {
            bestSim = sim;
            bestMatch = entry.pattern;
            bestNext = entry.next;
        }
    }
    return {
        currentPattern: currentStr,
        matchedPattern: bestMatch,
        similarity: bestSim,
        predictedNext: bestNext
    };
}

// ============================================================
//  MANAGER CLASS V23
// ============================================================
class SEIUManagerV23 {
    constructor(opts = {}) {
        this.history = [];
        this.ensemble = new SEIUEnsembleV23(ALL_ALGS, {
            emaAlpha: opts.emaAlpha ?? 0.08,
            historyWindow: opts.historyWindow ?? 700
        });
        this.currentPrediction = null;
        this.patternHistory = [];
        this.patternMatchResult = null;
    }

    calculateInitialStats() {
        const minStart = 15;
        if (this.history.length < minStart) return;
        const trainSamples = Math.min(60, this.history.length - minStart);
        const startIdx = this.history.length - trainSamples;
        for (let i = Math.max(minStart, startIdx); i < this.history.length; i++) {
            const historyPrefix = this.history.slice(0, i);
            const actualTx = this.history[i].tx;
            this.ensemble.updateWithOutcome(historyPrefix, actualTx);
        }
        console.log(`📊 V23: AI huấn luyện trên ${trainSamples} mẫu.`);
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.calculateInitialStats();
        this.currentPrediction = this.getPrediction();

        // Xây dựng database pattern
        patternDatabase = buildPatternDatabase(this.history);
        console.log(`📚 Đã xây dựng database với ${patternDatabase.length} pattern mẫu.`);

        // So sánh pattern lần đầu
        this.patternMatchResult = matchPattern(this.history, patternDatabase);
        currentPattern = getComplexPattern(this.history);

        // Tạo bản ghi tạm cho phiên tiếp theo
        const nextSession = this.history.at(-1) ? this.history.at(-1).session + 1 : null;
        if (nextSession && this.currentPrediction) {
            predictionMap[nextSession] = this.currentPrediction.rawPrediction;
            predictionHistory.push({
                session: nextSession,
                du_doan: this.currentPrediction.prediction,
                ket_qua: "⌛ Chờ Kết Quả",
                danh_gia: "⌛ Chờ",
                xuc_xac: [],
                tong: "⌛ Chờ"
            });
        }

        console.log("📦 V23: Đã tải lịch sử. AI Siêu VIP Pro sẵn sàng.");
        const nextSessionDisplay = this.history.at(-1) ? this.history.at(-1).session + 1 : 'N/A';
        console.log(`🔮 Dự đoán phiên ${nextSessionDisplay}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
        if (this.patternMatchResult) {
            console.log(`🔍 Pattern tương đồng: ${(this.patternMatchResult.similarity * 100).toFixed(1)}%`);
        }
    }

    pushRecord(record) {
        // Cập nhật kết quả dự đoán cũ
        const index = predictionHistory.findIndex(item => item.session === record.session && item.ket_qua === "⌛ Chờ Kết Quả");
        if (index !== -1) {
            const isCorrect = (predictionMap[record.session] === record.tx);
            predictionHistory[index] = {
                ...predictionHistory[index],
                ket_qua: record.tx === 'T' ? 'Tài' : 'Xỉu',
                danh_gia: isCorrect ? "✅ Thắng" : "❌ Thua",
                xuc_xac: record.dice,
                tong: record.total
            };
            performanceStats.total++;
            if (isCorrect) performanceStats.win++;
            else performanceStats.lose++;
            performanceStats.accuracy = performanceStats.win / performanceStats.total;
            performanceStats.last100.push(isCorrect ? 1 : 0);
            if (performanceStats.last100.length > 100) performanceStats.last100.shift();
            delete predictionMap[record.session];
        } else {
            const duDoan = predictionMap[record.session] || null;
            const isCorrect = (duDoan === record.tx);
            predictionHistory.push({
                session: record.session,
                du_doan: duDoan ? (duDoan === 'T' ? 'Tài' : 'Xỉu') : "⌛ Chờ",
                ket_qua: record.tx === 'T' ? 'Tài' : 'Xỉu',
                danh_gia: duDoan ? (isCorrect ? "✅ Thắng" : "❌ Thua") : "⌛ Chờ",
                xuc_xac: record.dice,
                tong: record.total
            });
            performanceStats.total++;
            if (isCorrect) performanceStats.win++;
            else performanceStats.lose++;
            performanceStats.accuracy = performanceStats.win / performanceStats.total;
            performanceStats.last100.push(isCorrect ? 1 : 0);
            if (performanceStats.last100.length > 100) performanceStats.last100.shift();
            delete predictionMap[record.session];
        }

        if (predictionHistory.length > MAX_PREDICTIONS) {
            predictionHistory = predictionHistory.slice(-MAX_PREDICTIONS);
        }

        // Cập nhật history và ensemble
        this.history.push(record);
        if (this.history.length > MAX_HISTORY) {
            this.history = this.history.slice(-MAX_HISTORY);
        }
        const prefix = this.history.slice(0, -1);
        if (prefix.length >= 10) {
            this.ensemble.updateWithOutcome(prefix, record.tx);
        }

        // Dự đoán cho phiên tiếp theo
        this.currentPrediction = this.getPrediction();
        const nextSession = record.session + 1;
        if (this.currentPrediction) {
            predictionMap[nextSession] = this.currentPrediction.rawPrediction;
            const exists = predictionHistory.some(item => item.session === nextSession && item.ket_qua === "⌛ Chờ Kết Quả");
            if (!exists) {
                predictionHistory.push({
                    session: nextSession,
                    du_doan: this.currentPrediction.prediction,
                    ket_qua: "⌛ Chờ Kết Quả",
                    danh_gia: "⌛ Chờ",
                    xuc_xac: [],
                    tong: "⌛ Chờ"
                });
            }
        }

        // Cập nhật pattern database và so sánh
        patternDatabase = buildPatternDatabase(this.history);
        this.patternMatchResult = matchPattern(this.history, patternDatabase);
        currentPattern = getComplexPattern(this.history);

        const features = extractFeatures(this.history);
        const patternType = detectPatternType(features.runs);
        if (patternType) {
            this.patternHistory.push(patternType);
            if (this.patternHistory.length > 20) this.patternHistory.shift();
        }

        console.log(`📥 ${record.session} → ${record.result}. Dự đoán ${record.session + 1}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
        if (this.patternMatchResult) {
            console.log(`🔍 Pattern tương đồng: ${(this.patternMatchResult.similarity * 100).toFixed(1)}%`);
        }
    }

    getPrediction() {
        return this.ensemble.predict(this.history);
    }
}

const seiuManager = new SEIUManagerV23();

// ============================================================
//  PATTERN DISPLAY
// ============================================================
function getComplexPattern(history) {
    const minHistory = PATTERN_LENGTH;
    if (history.length < minHistory) return "n/a";
    const historyTx = history.map(h => h.tx);
    return historyTx.slice(-minHistory).join('').toLowerCase();
}

// ============================================================
//  API SERVER
// ============================================================
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

async function fetchAndProcessHistory() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const newHistory = parseLines(data);
        if (newHistory.length === 0) {
            console.log("⚠️ Không có dữ liệu từ API.");
            return;
        }
        const lastSessionInHistory = newHistory.at(-1);
        if (!currentSessionId) {
            seiuManager.loadInitial(newHistory);
            txHistory = newHistory;
            currentSessionId = lastSessionInHistory.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên lịch sử.`);
        } else if (lastSessionInHistory.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            for (const record of newRecords) {
                seiuManager.pushRecord(record);
                txHistory.push(record);
            }
            if (txHistory.length > 350) {
                txHistory = txHistory.slice(-300);
            }
            currentSessionId = lastSessionInHistory.session;
            if (newRecords.length > 0) {
                console.log(`🆕 Cập nhật ${newRecords.length} phiên. Phiên cuối: ${currentSessionId}`);
            }
        }
    } catch (e) {
        console.error("❌ Lỗi fetch dữ liệu:", e.message);
    }
}

fetchAndProcessHistory();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcessHistory, 5000);
console.log(`🔄 V23: Đang chạy với chu kỳ 5 giây.`);

// ============================================================
//  API ENDPOINTS
// ============================================================
app.get("/api/taixiumd5/lc79", async () => {
    const lastResult = txHistory.at(-1) || null;
    const currentPrediction = seiuManager.currentPrediction;
    if (!lastResult || !currentPrediction) {
        return {
            id: "@ngminhtuann",
            phien_truoc: null,
            xuc_xac1: null,
            xuc_xac2: null,
            xuc_xac3: null,
            tong: null,
            ket_qua: "đang chờ...",
            pattern: "đang phân tích...",
            phien_hien_tai: null,
            du_doan: "chưa có",
            do_tin_cay: "0%",
            pattern_similarity: null
        };
    }
    const rawConfidence = currentPrediction.confidence * 100;
    const evenConfidence = Math.round(rawConfidence / 2) * 2;
    const sim = seiuManager.patternMatchResult ? (seiuManager.patternMatchResult.similarity * 100).toFixed(1) : null;
    return {
        id: "@ngminhtuann",
        phien_truoc: lastResult.session,
        xuc_xac1: lastResult.dice[0],
        xuc_xac2: lastResult.dice[1],
        xuc_xac3: lastResult.dice[2],
        tong: lastResult.total,
        ket_qua: lastResult.result.toLowerCase(),
        pattern: currentPattern,
        phien_hien_tai: lastResult.session + 1,
        du_doan: currentPrediction.prediction,
        do_tin_cay: `${evenConfidence}%`,
        pattern_similarity: sim ? `${sim}%` : "n/a"
    };
});

app.get("/api/taixiumd5/history", async () => {
    if (!predictionHistory.length) {
        return { message: "không có dữ liệu dự đoán." };
    }
    const sorted = [...predictionHistory].sort((a, b) => b.session - a.session);
    return sorted;
});

app.get("/api/performance", async () => {
    const acc = performanceStats.total > 0 ? (performanceStats.win / performanceStats.total * 100).toFixed(1) : 0;
    const last100Acc = performanceStats.last100.length > 0 ? (sum(performanceStats.last100) / performanceStats.last100.length * 100).toFixed(1) : 0;
    return {
        total: performanceStats.total,
        win: performanceStats.win,
        lose: performanceStats.lose,
        accuracy: `${acc}%`,
        last100_accuracy: `${last100Acc}%`,
        algorithms: ALL_ALGS.map(a => a.id)
    };
});

app.get("/api/pattern-matching", async () => {
    if (!seiuManager.patternMatchResult) {
        return { message: "Chưa có dữ liệu so sánh pattern." };
    }
    return {
        current_pattern: seiuManager.patternMatchResult.currentPattern,
        matched_pattern: seiuManager.patternMatchResult.matchedPattern,
        similarity: `${(seiuManager.patternMatchResult.similarity * 100).toFixed(1)}%`,
        predicted_next: seiuManager.patternMatchResult.predictedNext,
        database_size: patternDatabase.length
    };
});

app.get("/", async () => {
    return {
        status: "ok",
        msg: "AI Tài Xỉu Siêu VIP Pro V23",
        version: "V23",
        algorithms: ALL_ALGS.length,
        pattern_recognition: "siêu cấp (30+ mẫu)",
        features: [
            "21 thuật toán kết hợp",
            "So sánh pattern với 150 mẫu",
            "Thống kê hiệu suất",
            "Điều chỉnh trọng số thông minh"
        ],
        endpoints: [
            "/api/taixiumd5/lc79",
            "/api/taixiumd5/history",
            "/api/performance",
            "/api/pattern-matching"
        ]
    };
});

// ============================================================
//  SERVER START
// ============================================================
const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
    } catch (err) {
        const fs = await import("node:fs");
        const logFile = path.join(__dirname, "server-error.log");
        const errorMsg = `
================= SERVER ERROR =================
Time: ${new Date().toISOString()}
Error: ${err.message}
Stack: ${err.stack}
=================================================
`;
        console.error(errorMsg);
        fs.writeFileSync(logFile, errorMsg, { encoding: "utf8", flag: "a+" });
        process.exit(1);
    }

    let publicIP = "0.0.0.0";
    try {
        const res = await fetch("https://ifconfig.me/ip");
        publicIP = (await res.text()).trim();
    } catch (e) {
        console.error("❌ Lỗi lấy public IP:", e.message);
    }

    console.log("\n🚀 AI Tài Xỉu Siêu VIP Pro V23 đã khởi động!");
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://${publicIP}:${PORT}/\n`);
    console.log("📌 Các API endpoints:");
    console.log(`   ➜ GET /api/taixiumd5/lc79   → ${publicIP}:${PORT}/api/taixiumd5/lc79`);
    console.log(`   ➜ GET /api/taixiumd5/history → ${publicIP}:${PORT}/api/taixiumd5/history`);
    console.log(`   ➜ GET /api/performance      → ${publicIP}:${PORT}/api/performance`);
    console.log(`   ➜ GET /api/pattern-matching → ${publicIP}:${PORT}/api/pattern-matching`);
    console.log("\n🔧 21 thuật toán tích hợp:");
    ALL_ALGS.forEach((alg, i) => console.log(`   ${String(i+1).padStart(2,' ')}. ${alg.id}`));
    console.log("\n🌟 Tính năng nổi bật:");
    console.log(`   • So sánh pattern với ${PATTERN_DATABASE_SIZE} mẫu (${PATTERN_LENGTH} phiên)`);
    console.log("   • Đánh giá hiệu suất theo thời gian thực");
    console.log("   • Học thích ứng theo từng pattern");
};

start();
