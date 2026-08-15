import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// --- CẤU HÌNH ---
const PORT = 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// --- GLOBAL STATE ---
let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;
let currentPattern = "n/a";
let predictionHistory = [];
let predictionMap = {};

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

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function avg(arr) { return arr.length ? sum(arr) / arr.length : 0; }
function std(arr) {
    const m = avg(arr);
    return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
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

// Hàm tạo đặc trưng mở rộng
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
    const variance = avg(totals.map(t => (t - meanTotal) ** 2));
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
        trends: { upward, downward },
        // Thêm đặc trưng mới
        runLengths: runs.map(r => r.len),
        runValues: runs.map(r => r.val),
        totalStd: Math.sqrt(variance),
        recentVolatility: avg(totals.slice(-5).map((t, i, arr) => i > 0 ? Math.abs(t - arr[i-1]) : 0))
    };
}

// ============================================================
//  PHÁT HIỆN 50+ MẪU CẦU (SIÊU VIP)
// ============================================================
function detectPatternType(runs) {
    if (runs.length < 3) return null;
    const lastRuns = runs.slice(-8);
    const lengths = lastRuns.map(r => r.len);
    const values = lastRuns.map(r => r.val);

    // Mẫu cơ bản 1-1, 2-2, 3-3, 4-4, 5-5
    const basicPatterns = [1,2,3,4,5];
    for (const k of basicPatterns) {
        if (lengths.every(l => l === k)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return `${k}_${k}_pattern`;
        }
    }

    // Mẫu kết hợp 2 số (mở rộng)
    const pairPatterns = [
        [2,1], [1,2], [3,2], [2,3], [3,4], [4,3], [4,2], [2,4],
        [5,2], [2,5], [5,3], [3,5], [5,4], [4,5]
    ];
    for (const [a,b] of pairPatterns) {
        if (lengths.length >= 3 && lengths[0] === a && lengths[1] === b && lengths[2] === a) {
            if (runs.length >= 5 && runs[runs.length-5].len === a && runs[runs.length-4].len === b && runs[runs.length-3].len === a) {
                return `${a}_${b}_pattern`;
            }
        }
    }

    // Mẫu kết hợp 3 số (mở rộng)
    const triplePatterns = [
        [2,1,2], [1,2,1], [3,2,3], [4,2,4], [2,2,1], [1,3,1], [3,1,3],
        [2,3,2], [3,2,2], [2,3,1], [1,2,3], [3,2,1], [2,1,3], [3,1,2], [1,3,2],
        [4,3,4], [4,2,4], [3,4,3], [2,4,2], [5,2,5], [5,3,5], [5,4,5], [4,5,4],
        [3,3,2], [2,2,3], [1,1,2], [2,1,1], [4,4,3], [3,4,4]
    ];
    for (const [a,b,c] of triplePatterns) {
        if (lengths.length >= 5 &&
            lengths[0] === a && lengths[1] === b && lengths[2] === c &&
            lengths[3] === a && lengths[4] === b && lengths[5] === c) {
            return `${a}_${b}_${c}_pattern`;
        }
    }

    // Cầu bệt dài
    const lastRun = lastRuns[lastRuns.length - 1];
    if (lastRun && lastRun.len >= 5) {
        if (lastRun.len >= 8) return 'super_long_run';
        return 'long_run_pattern';
    }

    // Cầu đảo chiều đột ngột
    if (runs.length >= 3) {
        const last3 = runs.slice(-3);
        if (last3[0].len <= 2 && last3[1].len <= 2 && last3[2].len >= 4) {
            return 'sudden_reversal';
        }
    }

    return 'random_pattern';
}

function predictNextFromPattern(patternType, runs, lastTx) {
    if (!patternType) return null;
    const lastRun = runs[runs.length - 1];
    const prevRun = runs.length > 1 ? runs[runs.length - 2] : null;

    // Giải mã pattern
    const parts = patternType.split('_');
    if (parts.length === 3 && parts[2] === 'pattern') {
        const a = parseInt(parts[0]), b = parseInt(parts[1]);
        if (!isNaN(a) && !isNaN(b)) {
            if (lastRun.len === a) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === b) return lastRun.val === 'T' ? 'T' : 'X';
            return lastRun.val;
        }
    }
    if (parts.length === 4 && parts[3] === 'pattern') {
        const a = parseInt(parts[0]), b = parseInt(parts[1]), c = parseInt(parts[2]);
        if (!isNaN(a) && !isNaN(b) && !isNaN(c)) {
            if (lastRun.len === a) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === b) return lastRun.val === 'T' ? 'T' : 'X';
            if (lastRun.len === c) return lastRun.val === 'T' ? 'X' : 'T';
            return lastRun.val;
        }
    }
    if (patternType === '1_1_pattern') return lastTx === 'T' ? 'X' : 'T';
    if (patternType === '2_2_pattern') {
        if (lastRun.len === 2) return lastRun.val === 'T' ? 'X' : 'T';
        return lastRun.val;
    }
    if (patternType === '3_3_pattern') {
        if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
        return lastRun.val;
    }
    if (patternType === '4_4_pattern') {
        if (lastRun.len === 4) return lastRun.val === 'T' ? 'X' : 'T';
        return lastRun.val;
    }
    if (patternType === '5_5_pattern') {
        if (lastRun.len === 5) return lastRun.val === 'T' ? 'X' : 'T';
        return lastRun.val;
    }
    if (patternType === 'long_run_pattern' || patternType === 'super_long_run') {
        if (lastRun.len > 7) return lastRun.val === 'T' ? 'X' : 'T';
        if (lastRun.len >= 4 && lastRun.len <= 7) return lastRun.val;
        return null;
    }
    if (patternType === 'sudden_reversal') {
        return lastRun.val === 'T' ? 'X' : 'T';
    }

    return null;
}

// ============================================================
//  16 THUẬT TOÁN SIÊU VIP (cũ + mới)
// ============================================================

// 1. Frequency Balancer (cải tiến)
function algo1_freqBalance(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { freq, entropy: e } = features;
    const tCount = freq['T'] || 0, xCount = freq['X'] || 0;
    const total = tCount + xCount;
    if (total < 10) return null;
    const diff = Math.abs(tCount - xCount);
    let threshold = 0.45 + 0.1 * (1 - e);
    const recent = history.slice(-30);
    const recentT = recent.filter(h => h.tx === 'T').length;
    const recentX = recent.filter(h => h.tx === 'X').length;
    if (recentT + recentX < 5) return null;
    const recentDiff = Math.abs(recentT - recentX);
    const longRatio = diff / total;
    const shortRatio = recentDiff / (recentT + recentX);
    const combined = longRatio * 0.3 + shortRatio * 0.7;
    if (combined > threshold) {
        if (recentT > recentX + 1) return 'X';
        if (recentX > recentT + 1) return 'T';
    }
    return null;
}

// 2. Markov Chain (cải tiến)
function algo2_markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    let maxOrder = Math.min(4, Math.floor(history.length / 10) + 1);
    let bestPred = null, bestScore = -1;
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 5) continue;
        const transitions = {};
        const totalTrans = tx.length - order;
        for (let i = 0; i < totalTrans; i++) {
            const key = tx.slice(i, i + order).join('');
            const next = tx[i + order];
            if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
            transitions[key][next] += 1 + 0.1 * (i / totalTrans); // ưu tiên gần đây
        }
        const lastKey = tx.slice(-order).join('');
        const counts = transitions[lastKey];
        if (counts && counts.T + counts.X >= 2) {
            const total = counts.T + counts.X;
            const conf = Math.abs(counts.T - counts.X) / total;
            const pred = counts.T > counts.X ? 'T' : 'X';
            const score = conf * (order / maxOrder) * Math.min(1, total / 5);
            if (score > bestScore) { bestScore = score; bestPred = pred; }
        }
    }
    return bestPred;
}

// 3. N-Gram (cải tiến)
function algo3_ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const sizes = [5,4,3,2];
    let bestPred = null, bestConf = 0;
    for (const n of sizes) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        let matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            const gram = tx.slice(i, i + n).join('');
            if (gram === target) matches.push({ next: tx[i + n], dist: tx.length - i });
        }
        if (matches.length >= 2) {
            const weights = { T: 0, X: 0 };
            let totalW = 0;
            for (const m of matches) {
                const w = 1 / (m.dist * 0.3 + 1);
                weights[m.next] += w;
                totalW += w;
            }
            const conf = Math.abs(weights.T - weights.X) / totalW;
            const pred = weights.T > weights.X ? 'T' : 'X';
            if (conf > bestConf) { bestConf = conf; bestPred = pred; }
        }
    }
    return bestConf > 0.25 ? bestPred : null;
}

// 4. Neo Pattern (cải tiến)
function algo4_neoPattern(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const pred = predictNextFromPattern(patternType, runs, lastTx);
    if (pred) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const consistency = recentRuns.filter(r =>
            patternType.includes('_pattern') || (patternType.includes('long') && r.len >= 4)
        ).length / recentRuns.length;
        if (consistency > 0.5) return pred;
    }
    return null;
}

// 5. Super Deep Analysis (cải tiến)
function algo5_superDeep(history) {
    if (history.length < 50) return null;
    const timeframes = [
        { lookback: 10, weight: 0.2 },
        { lookback: 25, weight: 0.3 },
        { lookback: 50, weight: 0.3 },
        { lookback: 80, weight: 0.2 }
    ];
    let scores = { T: 0, X: 0 }, totalW = 0;
    for (const tf of timeframes) {
        if (history.length < tf.lookback) continue;
        const slice = history.slice(-tf.lookback);
        const sliceTx = slice.map(h => h.tx);
        const sliceTotals = slice.map(h => h.total);
        const tCount = sliceTx.filter(t => t === 'T').length;
        const xCount = sliceTx.filter(t => t === 'X').length;
        const mean = avg(sliceTotals);
        const vol = std(sliceTotals);
        let tScore = 0, xScore = 0;
        if (mean > 11.5) xScore += 0.5;
        if (mean < 9.5) tScore += 0.5;
        if (tCount > xCount + 2) xScore += 0.3;
        if (xCount > tCount + 2) tScore += 0.3;
        if (vol > 3.5) {
            if (sliceTx[sliceTx.length-1] === 'T') tScore += 0.2;
            else xScore += 0.2;
        }
        const trend = sliceTotals[sliceTotals.length-1] - sliceTotals[0];
        if (trend > 2) xScore += 0.15;
        if (trend < -2) tScore += 0.15;
        const w = tf.weight * (sliceTx.length / tf.lookback);
        scores.T += tScore * w;
        scores.X += xScore * w;
        totalW += w;
    }
    if (totalW > 0 && Math.abs(scores.T - scores.X) > 0.2) {
        return scores.T > scores.X ? 'T' : 'X';
    }
    return null;
}

// 6. Transformer XL (cải tiến)
function algo6_transformer(history) {
    if (history.length < 80) return null;
    const tx = history.map(h => h.tx);
    const seqLengths = [6,8,10,12];
    let attn = { T: 0, X: 0 };
    for (const seqLen of seqLengths) {
        if (tx.length < seqLen * 2) continue;
        const target = tx.slice(-seqLen).join('');
        let matches = 0;
        for (let i = 0; i <= tx.length - seqLen - 1; i++) {
            const hist = tx.slice(i, i + seqLen).join('');
            const sim = similarity(hist, target);
            if (sim >= 0.65) {
                const next = tx[i + seqLen];
                const weight = sim * (1 / (tx.length - i)) * (seqLen / 12);
                attn[next] = (attn[next] || 0) + weight;
                matches++;
            }
        }
        if (matches >= 3) {
            const boost = Math.min(1.5, matches / 2);
            attn.T *= boost;
            attn.X *= boost;
        }
    }
    const total = attn.T + attn.X;
    if (total > 0.3) {
        const conf = Math.abs(attn.T - attn.X) / total;
        if (conf > 0.2) return attn.T > attn.X ? 'T' : 'X';
    }
    return null;
}

// 7. Bridge Breaker (cải tiến)
function algo7_bridgeBreaker(history) {
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 4) return null;
    const lastRun = runs[runs.length - 1];
    let pred = null, conf = 0;
    if (lastRun.len >= 5) {
        if (lastRun.len >= 8) { pred = lastRun.val === 'T' ? 'X' : 'T'; conf = 0.85; }
        else if (lastRun.len >= 5 && lastRun.len <= 7) {
            const avgLen = avg(runs.map(r => r.len));
            if (lastRun.len > avgLen * 1.7) { pred = lastRun.val === 'T' ? 'X' : 'T'; conf = 0.7; }
            else { pred = lastRun.val; conf = 0.6; }
        }
    }
    if (!pred && runs.length >= 5) {
        const last5 = runs.slice(-5);
        const lens = last5.map(r => r.len);
        if (lens[0] === 1 && lens[1] === 1 && lens[2] >= 3) {
            if (lastRun.len >= 3) { pred = lastRun.val === 'T' ? 'X' : 'T'; conf = 0.7; }
        }
        if (lens.length >= 4 && lens[0] === 2 && lens[1] === 3 && lens[2] === 2 && lens[3] === 3) {
            pred = lastRun.val === 'T' ? 'T' : 'X';
            conf = 0.6;
        }
    }
    if (!pred && runs.length >= 8) {
        const recentRuns = runs.slice(-8);
        const lens = recentRuns.map(r => r.len);
        const meanL = avg(lens);
        const stdL = std(lens);
        if (lastRun.len > meanL + 1.5 * stdL) {
            pred = lastRun.val === 'T' ? 'X' : 'T';
            conf = 0.6;
        }
    }
    return conf > 0.55 ? pred : null;
}

// 8. Adaptive Markov (cải tiến)
function algo8_adaptiveMarkov(history) {
    if (history.length < 20) return null;
    const tx = history.map(h => h.tx);
    const models = [
        { type: 'markov', orders: [2,3,4] },
        { type: 'freq', lookbacks: [10,20,30] },
        { type: 'momentum', windows: [5,10,15] }
    ];
    let votes = { T: 0, X: 0 };
    for (const model of models) {
        if (model.type === 'markov') {
            for (const order of model.orders) {
                if (tx.length < order + 5) continue;
                const trans = {};
                for (let i = 0; i <= tx.length - order - 1; i++) {
                    const key = tx.slice(i, i + order).join('');
                    const next = tx[i + order];
                    if (!trans[key]) trans[key] = { T: 0, X: 0 };
                    trans[key][next] += 1 + 0.05 * i;
                }
                const lastKey = tx.slice(-order).join('');
                const counts = trans[lastKey];
                if (counts && counts.T + counts.X >= 2) {
                    const pred = counts.T > counts.X ? 'T' : 'X';
                    const conf = Math.abs(counts.T - counts.X) / (counts.T + counts.X);
                    votes[pred] += conf * (order / 10);
                }
            }
        }
        if (model.type === 'freq') {
            for (const lookback of model.lookbacks) {
                if (tx.length < lookback) continue;
                const recent = tx.slice(-lookback);
                const t = recent.filter(v => v === 'T').length;
                const x = recent.filter(v => v === 'X').length;
                if (Math.abs(t - x) > lookback * 0.15) {
                    const pred = t > x ? 'X' : 'T';
                    const conf = Math.abs(t - x) / lookback;
                    votes[pred] += conf * 0.5;
                }
            }
        }
        if (model.type === 'momentum') {
            for (const window of model.windows) {
                if (tx.length < window * 2) continue;
                const first = tx.slice(-window * 2, -window);
                const second = tx.slice(-window);
                const fT = first.filter(v => v === 'T').length;
                const fX = first.filter(v => v === 'X').length;
                const sT = second.filter(v => v === 'T').length;
                const sX = second.filter(v => v === 'X').length;
                const mT = sT - fT, mX = sX - fX;
                if (Math.abs(mT - mX) > window * 0.25) {
                    const pred = mT > mX ? 'T' : 'X';
                    const conf = Math.abs(mT - mX) / window;
                    votes[pred] += conf * 0.3;
                }
            }
        }
    }
    if (votes.T + votes.X > 0.35) return votes.T > votes.X ? 'T' : 'X';
    return null;
}

// 9. Pattern Master (cải tiến)
function algo9_patternMaster(history) {
    if (history.length < 30) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    if (runs.length < 5) return null;
    const recentRuns = runs.slice(-Math.min(8, runs.length));
    const runLengths = recentRuns.map(r => r.len);
    const runValues = recentRuns.map(r => r.val);
    let strength = { T: 0, X: 0 };
    const runPattern = runLengths.join('');
    const valuePattern = runValues.join('');
    const library = [
        { pattern: '12121', pred: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', w: 0.7 },
        { pattern: '21212', pred: valuePattern[valuePattern.length-1] === 'T' ? 'T' : 'X', w: 0.7 },
        { pattern: '13131', pred: valuePattern[valuePattern.length-1], w: 0.6 },
        { pattern: '31313', pred: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', w: 0.6 },
        { pattern: '24242', pred: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', w: 0.65 },
        { pattern: '42424', pred: valuePattern[valuePattern.length-1], w: 0.65 }
    ];
    for (const lib of library) {
        if (runPattern.includes(lib.pattern)) strength[lib.pred] += lib.w;
    }
    const last10Tx = tx.slice(-10).join('');
    const txLib = [
        { pattern: 'TXTXTXTX', pred: 'X', w: 0.8 },
        { pattern: 'XTXTXTXT', pred: 'T', w: 0.8 },
        { pattern: 'TTXXTTXX', pred: 'X', w: 0.7 },
        { pattern: 'XXTTXXTT', pred: 'T', w: 0.7 },
        { pattern: 'TTTXXXTT', pred: 'T', w: 0.75 },
        { pattern: 'XXXTTTXX', pred: 'X', w: 0.75 }
    ];
    for (const lib of txLib) {
        if (last10Tx.includes(lib.pattern)) strength[lib.pred] += lib.w;
    }
    const lastRun = recentRuns[recentRuns.length - 1];
    if (lastRun) {
        const avgLen = avg(runLengths);
        if (lastRun.len > avgLen * 1.8) strength[lastRun.val === 'T' ? 'X' : 'T'] += 0.5;
        else if (lastRun.len < avgLen * 0.6) strength[lastRun.val] += 0.4;
    }
    const total = strength.T + strength.X;
    if (total > 0) {
        const conf = Math.abs(strength.T - strength.X) / total;
        if (conf > 0.25) return strength.T > strength.X ? 'T' : 'X';
    }
    return null;
}

// 10. Quantum Entropy (cải tiến)
function algo10_quantumEntropy(history) {
    if (history.length < 30) return null;
    const features = extractFeatures(history);
    const { entropy: e, tx, runs } = features;
    const windows = [10,20,30];
    let preds = { T: 0, X: 0 };
    for (const w of windows) {
        if (tx.length < w) continue;
        const win = tx.slice(-w);
        const ent = entropy(win);
        if (ent < 0.3) {
            preds[win[win.length-1]] += 0.6;
        } else if (ent > 0.9) {
            const t = win.filter(v => v === 'T').length;
            const x = win.filter(v => v === 'X').length;
            if (t > x) preds['X'] += 0.5;
            else if (x > t) preds['T'] += 0.5;
        } else {
            const recentRuns = runs.slice(-4);
            if (recentRuns.length >= 3) {
                const lens = recentRuns.map(r => r.len);
                if (Math.max(...lens) - Math.min(...lens) <= 2) {
                    preds[tx[tx.length-1]] += 0.4;
                }
            }
        }
    }
    if (e < 0.4) preds[tx[tx.length-1]] += 0.3;
    else if (e > 0.95) {
        const t = tx.slice(-20).filter(v => v === 'T').length;
        const x = tx.slice(-20).filter(v => v === 'X').length;
        if (t > x) preds['X'] += 0.4;
        else if (x > t) preds['T'] += 0.4;
    }
    if (preds.T + preds.X > 0.4) return preds.T > preds.X ? 'T' : 'X';
    return null;
}

// 11. Pattern Hunter (cải tiến)
function algo11_patternHunter(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const pred = predictNextFromPattern(patternType, runs, lastTx);
    if (pred) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const consistency = recentRuns.filter(r =>
            patternType.includes('_pattern') || (patternType.includes('long') && r.len >= 4)
        ).length / recentRuns.length;
        if (consistency > 0.45) return pred;
    }
    return null;
}

// 12. Cycle Detector (cải tiến)
function algo12_cycleDetector(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    for (let cycle = 2; cycle <= 7; cycle++) {
        if (tx.length < cycle * 2) continue;
        const lastCycle = tx.slice(-cycle).join('');
        let matchCount = 0, totalChecks = 0;
        for (let i = tx.length - cycle - 1; i >= 0; i -= cycle) {
            const prev = tx.slice(i, i + cycle).join('');
            if (prev === lastCycle) matchCount++;
            totalChecks++;
            if (totalChecks >= 6) break;
        }
        if (totalChecks >= 3 && matchCount / totalChecks >= 0.5) {
            const nextIndex = (tx.length % cycle);
            const nextTx = tx[tx.length - cycle + nextIndex];
            if (nextTx) return nextTx;
        }
    }
    return null;
}

// 13. Wavelet Analysis (mới)
function algo13_wavelet(history) {
    if (history.length < 40) return null;
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    // Chuyển đổi T/X thành số: T=1, X=-1
    const seq = tx.map(v => v === 'T' ? 1 : -1);
    // Lọc xu hướng bằng trung bình động
    const window = 5;
    const smoothed = [];
    for (let i = 0; i < seq.length; i++) {
        const start = Math.max(0, i - window + 1);
        const slice = seq.slice(start, i + 1);
        smoothed.push(avg(slice));
    }
    // Dự đoán dựa trên độ dốc
    const last = smoothed.slice(-3);
    if (last.length >= 3) {
        const slope = (last[2] - last[0]) / 2;
        if (Math.abs(slope) > 0.15) {
            return slope > 0 ? 'T' : 'X';
        }
    }
    return null;
}

// 14. Fourier Trend (mới)
function algo14_fourier(history) {
    if (history.length < 50) return null;
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    // Phân tích chu kỳ ngắn hạn
    const seq = totals.slice(-30);
    const mean = avg(seq);
    const detrend = seq.map(v => v - mean);
    // Tìm đỉnh và đáy
    let peaks = 0, valleys = 0;
    for (let i = 1; i < detrend.length - 1; i++) {
        if (detrend[i] > detrend[i-1] && detrend[i] > detrend[i+1]) peaks++;
        if (detrend[i] < detrend[i-1] && detrend[i] < detrend[i+1]) valleys++;
    }
    if (peaks > valleys) return 'X';
    if (valleys > peaks) return 'T';
    return null;
}

// 15. LSTM Simulation (mới)
function algo15_lstm(history) {
    if (history.length < 60) return null;
    const tx = history.map(h => h.tx);
    const seq = tx.map(v => v === 'T' ? 1 : 0);
    // Mô phỏng LSTM đơn giản với trọng số theo thời gian
    const weights = [];
    for (let i = 0; i < seq.length; i++) {
        weights.push(Math.exp(- (seq.length - i) / 15));
    }
    const weightedSum = seq.reduce((s, v, i) => s + v * weights[i], 0);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const avgWeighted = weightedSum / totalWeight;
    const threshold = 0.45; // có thể điều chỉnh
    if (avgWeighted > 0.55) return 'T';
    if (avgWeighted < 0.45) return 'X';
    return null;
}

// 16. Ensemble Meta (mới) - kết hợp các thuật toán khác
function algo16_ensembleMeta(history) {
    if (history.length < 30) return null;
    // Gọi các thuật toán mạnh nhất
    const algs = [
        algo1_freqBalance, algo2_markov, algo3_ngram,
        algo4_neoPattern, algo5_superDeep, algo6_transformer,
        algo7_bridgeBreaker, algo8_adaptiveMarkov, algo9_patternMaster,
        algo10_quantumEntropy, algo11_patternHunter, algo12_cycleDetector,
        algo13_wavelet, algo14_fourier, algo15_lstm
    ];
    let votes = { T: 0, X: 0 };
    for (const alg of algs) {
        try {
            const pred = alg(history);
            if (pred) votes[pred] += 1;
        } catch (e) {}
    }
    if (votes.T + votes.X >= 3) {
        return votes.T > votes.X ? 'T' : 'X';
    }
    return null;
}

// ============================================================
//  DANH SÁCH 16 THUẬT TOÁN
// ============================================================
const ALL_ALGS = [
    { id: 'algo1_freqBalance', fn: algo1_freqBalance },
    { id: 'algo2_markov', fn: algo2_markov },
    { id: 'algo3_ngram', fn: algo3_ngram },
    { id: 'algo4_neoPattern', fn: algo4_neoPattern },
    { id: 'algo5_superDeep', fn: algo5_superDeep },
    { id: 'algo6_transformer', fn: algo6_transformer },
    { id: 'algo7_bridgeBreaker', fn: algo7_bridgeBreaker },
    { id: 'algo8_adaptiveMarkov', fn: algo8_adaptiveMarkov },
    { id: 'algo9_patternMaster', fn: algo9_patternMaster },
    { id: 'algo10_quantumEntropy', fn: algo10_quantumEntropy },
    { id: 'algo11_patternHunter', fn: algo11_patternHunter },
    { id: 'algo12_cycleDetector', fn: algo12_cycleDetector },
    { id: 'algo13_wavelet', fn: algo13_wavelet },
    { id: 'algo14_fourier', fn: algo14_fourier },
    { id: 'algo15_lstm', fn: algo15_lstm },
    { id: 'algo16_ensembleMeta', fn: algo16_ensembleMeta }
];

// ============================================================
//  ENSEMBLE CLASSIFIER SIÊU VIP
// ============================================================
class SEIUEnsemblePro {
    constructor(algorithms, opts = {}) {
        this.algs = algorithms;
        this.weights = {};
        this.emaAlpha = opts.emaAlpha ?? 0.07;
        this.minWeight = opts.minWeight ?? 0.005;
        this.historyWindow = opts.historyWindow ?? 800;
        this.performanceHistory = {};
        this.patternMemory = {};
        this.reinforcement = {}; // Học tăng cường
        for (const a of algorithms) {
            this.weights[a.id] = 0.5 + Math.random() * 0.5;
            this.performanceHistory[a.id] = [];
            this.reinforcement[a.id] = 0;
        }
        // Tự chuẩn hóa
        this.normalizeWeights();
    }

    normalizeWeights() {
        const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (total > 0) {
            for (const id in this.weights) this.weights[id] /= total;
        }
    }

    fitInitial(history) {
        const window = lastN(history, Math.min(this.historyWindow, history.length));
        if (window.length < 30) return;
        const algScores = {};
        for (const a of this.algs) algScores[a.id] = 0;
        const evalSamples = Math.min(60, window.length - 15);
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
            const baseWeight = 0.2 + (accuracy * 0.8);
            this.weights[id] = Math.max(this.minWeight, baseWeight);
            totalWeight += this.weights[id];
        }
        if (totalWeight > 0) {
            for (const id in this.weights) this.weights[id] /= totalWeight;
        }
        console.log(`⚖️ Khởi tạo trọng số cho ${Object.keys(this.weights).length} thuật toán.`);
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
                if (this.performanceHistory[a.id].length > 80) {
                    this.performanceHistory[a.id].shift();
                }
                const recentPerf = lastN(this.performanceHistory[a.id], 30);
                let weightedAcc = 0, weightSum = 0;
                for (let i = 0; i < recentPerf.length; i++) {
                    const w = Math.pow(0.92, recentPerf.length - i - 1);
                    weightedAcc += recentPerf[i] * w;
                    weightSum += w;
                }
                const recentAccuracy = weightSum > 0 ? weightedAcc / weightSum : 0.5;
                let patternBonus = 0;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const success = this.patternMemory[key] || 0;
                    if (success > 4) patternBonus = 0.12;
                }
                // Học tăng cường: thưởng thêm nếu dự đoán đúng ở các pattern khó
                let reinforce = 0;
                if (correct && patternType && patternType.includes('long')) reinforce = 0.15;
                else if (correct && patternType && patternType !== 'random_pattern') reinforce = 0.05;
                this.reinforcement[a.id] = (this.reinforcement[a.id] || 0) + reinforce;

                const targetWeight = Math.min(1.2, recentAccuracy + patternBonus + 0.1 + this.reinforcement[a.id] * 0.02);
                const currentWeight = this.weights[a.id] || this.minWeight;
                const newWeight = this.emaAlpha * targetWeight + (1 - this.emaAlpha) * currentWeight;
                this.weights[a.id] = Math.max(this.minWeight, Math.min(2.0, newWeight));
                if (patternType && correct) {
                    const key = `${a.id}_${patternType}`;
                    this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                }
                // Giảm reinforcement dần
                this.reinforcement[a.id] *= 0.9;
            } catch (e) {
                this.weights[a.id] = Math.max(this.minWeight, (this.weights[a.id] || 1) * 0.88);
            }
        }
        this.normalizeWeights();
    }

    predict(history) {
        if (history.length < 10) {
            return { prediction: 'tài', confidence: 0.5, rawPrediction: 'T' };
        }
        const features = extractFeatures(history);
        const patternType = detectPatternType(features.runs);
        const votes = { T: 0, X: 0 };
        const details = [];
        for (const a of this.algs) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                let weight = this.weights[a.id] || this.minWeight;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const success = this.patternMemory[key] || 0;
                    if (success > 3) weight *= 1.25;
                }
                votes[pred] += weight;
                details.push({ id: a.id, pred, weight });
            } catch (e) {}
        }
        if (votes.T === 0 && votes.X === 0) {
            const fallback = algo1_freqBalance(history) || 'T';
            return { prediction: fallback === 'T' ? 'tài' : 'xỉu', confidence: 0.5, rawPrediction: fallback };
        }
        const { key: best, val: bestVal } = majority(votes);
        const totalVotes = votes.T + votes.X;
        let baseConfidence = bestVal / totalVotes;
        // Điều chỉnh độ tin cậy dựa trên số lượng thuật toán đồng thuận
        const tAlgos = details.filter(d => d.pred === 'T').length;
        const xAlgos = details.filter(d => d.pred === 'X').length;
        const totalAlgos = tAlgos + xAlgos;
        let consensusBonus = 0;
        if (totalAlgos > 0) {
            const ratio = Math.max(tAlgos, xAlgos) / totalAlgos;
            if (ratio > 0.65) consensusBonus = 0.1;
            if (ratio > 0.8) consensusBonus = 0.18;
            if (ratio > 0.9) consensusBonus = 0.25;
        }
        let confidence = Math.min(0.98, Math.max(0.5, baseConfidence + consensusBonus));
        // Nếu pattern rõ ràng, tăng độ tin cậy
        if (patternType && patternType !== 'random_pattern' && patternType !== 'long_run_pattern') {
            confidence = Math.min(0.98, confidence + 0.05);
        }
        return {
            prediction: best === 'T' ? 'tài' : 'xỉu',
            confidence,
            rawPrediction: best
        };
    }
}

// ============================================================
//  PATTERN ANALYSIS - LẤY 60 PHIÊN
// ============================================================
function getComplexPattern(history) {
    const minHistory = 60;
    if (history.length < minHistory) return "n/a";
    const historyTx = history.map(h => h.tx);
    return historyTx.slice(-minHistory).join('').toLowerCase();
}

// ============================================================
//  MANAGER CLASS
// ============================================================
class SEIUManagerPro {
    constructor(opts = {}) {
        this.history = [];
        this.ensemble = new SEIUEnsemblePro(ALL_ALGS, {
            emaAlpha: opts.emaAlpha ?? 0.07,
            historyWindow: opts.historyWindow ?? 800
        });
        this.currentPrediction = null;
        this.patternHistory = [];
    }

    calculateInitialStats() {
        const minStart = 20;
        if (this.history.length < minStart) return;
        const trainSamples = Math.min(70, this.history.length - minStart);
        const startIdx = this.history.length - trainSamples;
        for (let i = Math.max(minStart, startIdx); i < this.history.length; i++) {
            const prefix = this.history.slice(0, i);
            const actualTx = this.history[i].tx;
            this.ensemble.updateWithOutcome(prefix, actualTx);
        }
        console.log(`📊 AI đã huấn luyện trên ${trainSamples} mẫu.`);
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.calculateInitialStats();
        this.currentPrediction = this.getPrediction();

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

        currentPattern = getComplexPattern(this.history);
        console.log("📦 Đã tải lịch sử. Hệ thống AI siêu VIP sẵn sàng.");
        const nextSessionDisplay = this.history.at(-1) ? this.history.at(-1).session + 1 : 'N/A';
        console.log(`🔮 Dự đoán phiên ${nextSessionDisplay}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    pushRecord(record) {
        // Cập nhật bản ghi tạm
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
            delete predictionMap[record.session];
        }
        if (predictionHistory.length > 500) predictionHistory = predictionHistory.slice(-500);

        // Cập nhật history
        this.history.push(record);
        if (this.history.length > 500) this.history = this.history.slice(-450);
        const prefix = this.history.slice(0, -1);
        if (prefix.length >= 10) {
            this.ensemble.updateWithOutcome(prefix, record.tx);
        }

        // Dự đoán phiên tiếp theo
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

        // Cập nhật pattern
        const features = extractFeatures(this.history);
        const patternType = detectPatternType(features.runs);
        currentPattern = getComplexPattern(this.history);
        if (patternType) {
            this.patternHistory.push(patternType);
            if (this.patternHistory.length > 30) this.patternHistory.shift();
        }

        console.log(`📥 ${record.session} → ${record.result}. Dự đoán ${record.session + 1}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    getPrediction() {
        return this.ensemble.predict(this.history);
    }
}

const seiuManager = new SEIUManagerPro();

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
            if (txHistory.length > 350) txHistory = txHistory.slice(-300);
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
console.log(`🔄 Đang chạy với chu kỳ 5 giây.`);

// API Endpoints
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
            do_tin_cay: "0%"
        };
    }
    const rawConfidence = currentPrediction.confidence * 100;
    const evenConfidence = Math.round(rawConfidence / 2) * 2;
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
        do_tin_cay: `${evenConfidence}%`
    };
});

app.get("/api/taixiumd5/history", async () => {
    if (!predictionHistory.length) {
        return { message: "không có dữ liệu dự đoán." };
    }
    const sorted = [...predictionHistory].sort((a, b) => b.session - a.session);
    return sorted;
});

app.get("/", async () => {
    return {
        status: "ok",
        msg: "AI Tài Xỉu MD5 Pro - Siêu VIP V22",
        version: "V22",
        algorithms: ALL_ALGS.length,
        pattern_recognition: "50+ mẫu cầu phức tạp",
        endpoints: [
            "/api/taixiumd5/lc79",
            "/api/taixiumd5/history"
        ]
    };
});

// --- SERVER START ---
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

    console.log("\n🚀 AI Tài Xỉu MD5 Pro - Siêu VIP V22 đã khởi động!");
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://${publicIP}:${PORT}/\n`);
    console.log("📌 Các API endpoints:");
    console.log(`   ➜ GET /api/taixiumd5/lc79   → http://${publicIP}:${PORT}/api/taixiumd5/lc79`);
    console.log(`   ➜ GET /api/taixiumd5/history   → http://${publicIP}:${PORT}/api/taixiumd5/history`);
    console.log(`\n🔧 ${ALL_ALGS.length} thuật toán Siêu VIP:`);
    ALL_ALGS.forEach((alg, i) => console.log(`   ${i+1}. ${alg.id}`));
    console.log("\n🎯 Nhận diện 50+ mẫu cầu phức tạp:");
    console.log("   • 1-1, 2-2, 3-3, 4-4, 5-5");
    console.log("   • 2-1, 1-2, 3-2, 2-3, 3-4, 4-3, 4-2, 2-4, 5-2, 2-5, 5-3, 3-5, 5-4, 4-5");
    console.log("   • 2-1-2, 1-2-1, 3-2-3, 4-2-4, 2-2-1, 1-3-1, 3-1-3, 2-3-2, 3-2-2, 2-3-1, 1-2-3, 3-2-1, 2-1-3, 3-1-2, 1-3-2, 4-3-4, 4-2-4, 3-4-3, 2-4-2, 5-2-5, 5-3-5, 5-4-5, 4-5-4, 3-3-2, 2-2-3, 1-1-2, 2-1-1, 4-4-3, 3-4-4");
    console.log("   • Cầu bệt dài, cầu đảo chiều đột ngột");
    console.log("   • Phân tích Wavelet, Fourier, LSTM mô phỏng");
};

start();
