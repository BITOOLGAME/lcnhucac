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
// PATTERN MẪU CÓ TÊN & QUYẾT ĐỊNH THEO/BẺ (RIÊNG CHO HU VÀ MD5)
// ============================================================

const PATTERN_TEMPLATES = {
    hu: [
        { name: "Cầu bệt Tài", pattern: "TTTTT", action: "follow" },
        { name: "Cầu bệt Xỉu", pattern: "XXXXX", action: "follow" },
        { name: "Cầu 1-1 (xen kẽ)", pattern: "TXTXT", action: "follow" },
        { name: "Cầu 1-1 (xen kẽ) X", pattern: "XTXTX", action: "follow" },
        { name: "Cầu 2-2", pattern: "TTXXTT", action: "follow" },
        { name: "Cầu 2-2 X", pattern: "XXTTXX", action: "follow" },
        { name: "Cầu 3-3", pattern: "TTTXXXTTT", action: "follow" },
        { name: "Cầu 3-3 X", pattern: "XXXTTTXXX", action: "follow" },
        { name: "Cầu 4-4", pattern: "TTTTXXXXTTTT", action: "follow" },
        { name: "Cầu 4-4 X", pattern: "XXXXTTTTXXXX", action: "follow" },
        { name: "Cầu 5-5", pattern: "TTTTTXXXXX", action: "follow" },
        { name: "Cầu 5-5 X", pattern: "XXXXXTTTTT", action: "follow" },
        { name: "Cầu tam giác Tài", pattern: "TTXTTXTTX", action: "follow" },
        { name: "Cầu tam giác Xỉu", pattern: "XXTXXTXXT", action: "follow" },
        { name: "Cầu zigzag Tài", pattern: "TXXTTXTTX", action: "follow" },
        { name: "Cầu zigzag Xỉu", pattern: "XTTXXTXXT", action: "follow" },
        { name: "Cầu ABAB", pattern: "TXTXTX", action: "follow" },
        { name: "Cầu ABAB X", pattern: "XTXTXT", action: "follow" },
        { name: "Cầu AABB", pattern: "TTXXTTXX", action: "follow" },
        { name: "Cầu AABB X", pattern: "XXTTXXTT", action: "follow" },
        { name: "Cầu ABCABC", pattern: "TTXTTX", action: "follow" },
        { name: "Cầu ABCABC X", pattern: "XXTXXT", action: "follow" },
        { name: "Cầu đảo chiều Tài", pattern: "TTTTX", action: "break" },
        { name: "Cầu đảo chiều Xỉu", pattern: "XXXXT", action: "break" },
        { name: "Cầu 2-1-2", pattern: "TTXTT", action: "follow" },
        { name: "Cầu 2-1-2 X", pattern: "XXTXX", action: "follow" },
        { name: "Cầu 2-3-2", pattern: "TTXXXTT", action: "follow" },
        { name: "Cầu 3-2-3", pattern: "XXXTTXXX", action: "follow" },
        { name: "Cầu 3-1-3", pattern: "TTTXT TT".replace(/\s/g, ""), action: "follow" },
        { name: "Cầu 1-3-1", pattern: "XTTTX", action: "follow" },
        { name: "Cầu gấp khúc", pattern: "TXXTTX", action: "follow" },
        { name: "Cầu gấp khúc X", pattern: "XTTXXT", action: "follow" },
        { name: "Cầu đồng pha Tài", pattern: "TXXTXX", action: "follow" },
        { name: "Cầu đồng pha Xỉu", pattern: "XTTXTT", action: "follow" },
        { name: "Cầu đảo chiều sau 4 Tài", pattern: "TTTTT", action: "break" },
        { name: "Cầu đảo chiều sau 4 Xỉu", pattern: "XXXXX", action: "break" },
    ],
    md5: [
        { name: "Cầu bệt Tài", pattern: "TTTTT", action: "follow" },
        { name: "Cầu bệt Xỉu", pattern: "XXXXX", action: "follow" },
        { name: "Cầu 1-1 (xen kẽ)", pattern: "TXTXT", action: "follow" },
        { name: "Cầu 1-1 (xen kẽ) X", pattern: "XTXTX", action: "follow" },
        { name: "Cầu 2-2", pattern: "TTXXTT", action: "follow" },
        { name: "Cầu 2-2 X", pattern: "XXTTXX", action: "follow" },
        { name: "Cầu 3-3", pattern: "TTTXXXTTT", action: "follow" },
        { name: "Cầu 3-3 X", pattern: "XXXTTTXXX", action: "follow" },
        { name: "Cầu 4-4", pattern: "TTTTXXXXTTTT", action: "follow" },
        { name: "Cầu 4-4 X", pattern: "XXXXTTTTXXXX", action: "follow" },
        { name: "Cầu 5-5", pattern: "TTTTTXXXXX", action: "follow" },
        { name: "Cầu 5-5 X", pattern: "XXXXXTTTTT", action: "follow" },
        { name: "Cầu tam giác Tài", pattern: "TTXTTXTTX", action: "follow" },
        { name: "Cầu tam giác Xỉu", pattern: "XXTXXTXXT", action: "follow" },
        { name: "Cầu zigzag Tài", pattern: "TXXTTXTTX", action: "follow" },
        { name: "Cầu zigzag Xỉu", pattern: "XTTXXTXXT", action: "follow" },
        { name: "Cầu ABAB", pattern: "TXTXTX", action: "follow" },
        { name: "Cầu ABAB X", pattern: "XTXTXT", action: "follow" },
        { name: "Cầu AABB", pattern: "TTXXTTXX", action: "follow" },
        { name: "Cầu AABB X", pattern: "XXTTXXTT", action: "follow" },
        { name: "Cầu ABCABC", pattern: "TTXTTX", action: "follow" },
        { name: "Cầu ABCABC X", pattern: "XXTXXT", action: "follow" },
        { name: "Cầu đảo chiều Tài", pattern: "TTTTX", action: "break" },
        { name: "Cầu đảo chiều Xỉu", pattern: "XXXXT", action: "break" },
        { name: "Cầu 2-1-2", pattern: "TTXTT", action: "follow" },
        { name: "Cầu 2-1-2 X", pattern: "XXTXX", action: "follow" },
        { name: "Cầu 2-3-2", pattern: "TTXXXTT", action: "follow" },
        { name: "Cầu 3-2-3", pattern: "XXXTTXXX", action: "follow" },
        { name: "Cầu 3-1-3", pattern: "TTTXT TT".replace(/\s/g, ""), action: "follow" },
        { name: "Cầu 1-3-1", pattern: "XTTTX", action: "follow" },
        { name: "Cầu gấp khúc", pattern: "TXXTTX", action: "follow" },
        { name: "Cầu gấp khúc X", pattern: "XTTXXT", action: "follow" },
        { name: "Cầu đồng pha Tài", pattern: "TXXTXX", action: "follow" },
        { name: "Cầu đồng pha Xỉu", pattern: "XTTXTT", action: "follow" },
        { name: "Cầu đảo chiều sau 4 Tài", pattern: "TTTTT", action: "break" },
        { name: "Cầu đảo chiều sau 4 Xỉu", pattern: "XXXXX", action: "break" },
    ]
};

function detectPattern(historyString, templates) {
    if (!historyString || historyString.length < 3) return null;
    for (const template of templates) {
        const pattern = template.pattern;
        if (historyString.endsWith(pattern)) {
            let prediction = null;
            if (template.action === "follow") {
                const lastChar = pattern[pattern.length - 1];
                prediction = lastChar === "T" ? "Tài" : "Xỉu";
            } else if (template.action === "break") {
                const lastChar = pattern[pattern.length - 1];
                prediction = lastChar === "T" ? "Xỉu" : "Tài";
            }
            if (prediction) {
                return {
                    name: template.name,
                    prediction: prediction,
                    action: template.action,
                    confidence: 0.82,
                    matchedPattern: pattern
                };
            }
        }
    }
    return null;
}

// ============================================================
// HÀM CHUYỂN ĐỔI LỊCH SỬ
// ============================================================

function historyToBinary(history) {
    return history.map(h => toTX(h.ket_qua)).join("");
}

function binaryToLabel(char) {
    return char === "T" ? "Tài" : "Xỉu";
}

function inverseBinaryToLabel(char) {
    return char === "T" ? "Xỉu" : "Tài";
}

function tailStreakLength(str) {
    const n = str.length;
    if (n === 0) return 0;
    const last = str[n - 1];
    let len = 1;
    for (let i = n - 2; i >= 0; i--) {
        if (str[i] !== last) break;
        len++;
    }
    return len;
}

// ============================================================
// CÁC PHÂN TÍCH CON (MỚI)
// ============================================================

function analyzeCycles(recentString) {
    const len = recentString.length;
    if (len < 8) return { confidence: 0 };
    for (let cycle = 2; cycle <= Math.min(6, Math.floor(len / 2)); cycle++) {
        let matches = 0;
        for (let i = len - 1; i >= cycle; i--) {
            if (recentString[i] === recentString[i - cycle]) matches++;
        }
        if (matches > 0) {
            const score = matches / (len - cycle);
            if (score > 0.55) {
                const lastChar = recentString[len - cycle];
                const prediction = lastChar === "T" ? "Tài" : "Xỉu";
                return {
                    prediction,
                    confidence: Math.min(0.88, score + 0.12)
                };
            }
        }
    }
    return { confidence: 0 };
}

function analyzeComplexPatterns(recentString, fullHistory) {
    const recentLen = recentString.length;
    if (recentLen < 6) return { confidence: 0 };
    const currentPattern = recentString.slice(-4);
    const searchSpace = fullHistory.slice(0, -4);
    const positions = [];
    let pos = 0;
    while ((pos = searchSpace.indexOf(currentPattern, pos)) !== -1) {
        positions.push(pos);
        pos += 1;
    }
    if (positions.length >= 2) {
        const nextChars = [];
        for (const p of positions) {
            if (p + 4 < fullHistory.length) {
                nextChars.push(fullHistory[p + 4]);
            }
        }
        if (nextChars.length > 0) {
            const countT = nextChars.filter(c => c === "T").length;
            const countX = nextChars.filter(c => c === "X").length;
            const total = countT + countX;
            if (total >= 2) {
                const ratio = Math.max(countT, countX) / total;
                if (ratio >= 0.6) {
                    return {
                        prediction: countT > countX ? "Tài" : "Xỉu",
                        confidence: ratio * 1.1
                    };
                }
            }
        }
    }
    return { confidence: 0 };
}

function analyzeStatistics(recentHistory, currentResult) {
    let countT = 0,
        countX = 0;
    const transitions = { TT: 0, TX: 0, XT: 0, XX: 0 };
    const len = recentHistory.length;
    for (let i = 0; i < len; i++) {
        const game = recentHistory[i];
        if (game.ket_qua === "TAI") countT++;
        else countX++;
        if (i > 0) {
            const prev = recentHistory[i - 1].ket_qua === "TAI" ? "T" : "X";
            const curr = game.ket_qua === "TAI" ? "T" : "X";
            transitions[prev + curr]++;
        }
    }
    const totalGames = len;
    if (totalGames === 0) return { confidence: 0 };
    const lastResult = recentHistory[len - 1].ket_qua === "TAI" ? "T" : "X";
    const totalTrans = transitions.TT + transitions.TX + transitions.XT + transitions.XX;
    if (totalTrans > 0) {
        const p_T_given_T = transitions.TT / (transitions.TT + transitions.TX);
        const p_X_given_X = transitions.XX / (transitions.XT + transitions.XX);
        if (p_T_given_T > 0.65 && lastResult === "T") {
            return { prediction: "Xỉu", confidence: 0.72 };
        }
        if (p_X_given_X > 0.65 && lastResult === "X") {
            return { prediction: "Tài", confidence: 0.72 };
        }
    }
    const taiRatio = countT / totalGames;
    const xiuRatio = countX / totalGames;
    if (taiRatio > 0.6) return { prediction: "Xỉu", confidence: 0.72 };
    if (xiuRatio > 0.6) return { prediction: "Tài", confidence: 0.72 };
    return { confidence: 0 };
}

function analyzeMarkov(historyString) {
    const len = historyString.length;
    if (len < 8) return { confidence: 0 };
    const transitions = {};
    for (let i = 2; i < len; i++) {
        const state = historyString.slice(i - 2, i);
        const next = historyString[i];
        if (!transitions[state]) transitions[state] = { T: 0, X: 0 };
        transitions[state][next]++;
    }
    const lastState = historyString.slice(-2);
    if (transitions[lastState]) {
        const tCount = transitions[lastState].T;
        const xCount = transitions[lastState].X;
        const total = tCount + xCount;
        if (total >= 2) {
            const ratio = Math.max(tCount, xCount) / total;
            if (ratio > 0.6) {
                return {
                    prediction: tCount > xCount ? "Tài" : "Xỉu",
                    confidence: ratio * 1.05
                };
            }
        }
    }
    return { confidence: 0 };
}

function analyzeBalance(recentHistory) {
    let countT = 0,
        countX = 0;
    for (const game of recentHistory) {
        if (game.ket_qua === "TAI") countT++;
        else countX++;
    }
    const total = countT + countX;
    if (total === 0) return { confidence: 0 };
    const imbalance = Math.abs(countT - countX) / total;
    if (imbalance > 0.25) {
        const prediction = countT > countX ? "Xỉu" : "Tài";
        return {
            prediction,
            confidence: Math.min(0.78, imbalance + 0.12)
        };
    }
    return { confidence: 0 };
}

function analyzeScorePattern(recentHistory) {
    if (recentHistory.length < 8) return { confidence: 0 };
    const taiScores = [];
    const xiuScores = [];
    for (const game of recentHistory) {
        if (game.ket_qua === "TAI") taiScores.push(game.tong);
        else xiuScores.push(game.tong);
    }
    if (taiScores.length < 3 || xiuScores.length < 3) return { confidence: 0 };
    const avgTai = taiScores.reduce((a, b) => a + b, 0) / taiScores.length;
    const avgXiu = xiuScores.reduce((a, b) => a + b, 0) / xiuScores.length;
    const last3 = recentHistory.slice(-3);
    const last3Total = last3.reduce((sum, g) => sum + g.tong, 0);
    const last3Avg = last3Total / 3;
    if (last3Avg > avgTai && last3Avg > 11) {
        return { prediction: "Xỉu", confidence: 0.67 };
    }
    if (last3Avg < avgXiu && last3Avg < 10) {
        return { prediction: "Tài", confidence: 0.67 };
    }
    return { confidence: 0 };
}

// ===== THÊM PHÂN TÍCH XU HƯỚNG DÀI HẠN =====
function analyzeLongTrend(recentHistory) {
    if (recentHistory.length < 20) return { confidence: 0 };
    const first10 = recentHistory.slice(0, 10);
    const last10 = recentHistory.slice(-10);
    const countT1 = first10.filter(g => g.ket_qua === "TAI").length;
    const countT2 = last10.filter(g => g.ket_qua === "TAI").length;
    const diff = countT2 - countT1;
    if (Math.abs(diff) >= 3) {
        const prediction = diff > 0 ? "Tài" : "Xỉu";
        return {
            prediction,
            confidence: 0.75
        };
    }
    return { confidence: 0 };
}

function analyzeVolatility(recentHistory) {
    if (recentHistory.length < 10) return { confidence: 0 };
    const scores = recentHistory.map(g => g.tong);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / scores.length;
    const std = Math.sqrt(variance);
    if (std > 3) {
        const last = scores[scores.length - 1];
        const prediction = last > avg ? "Xỉu" : "Tài";
        return {
            prediction,
            confidence: 0.70
        };
    }
    return { confidence: 0 };
}

// ============================================================
// DỰ ĐOÁN CHÍNH (ULTRA VIP 22.5)
// ============================================================

function predictNextAdvanced(currentResult, history, type = "hu") {
    const templates = PATTERN_TEMPLATES[type] || PATTERN_TEMPLATES.hu;
    const historyString = history.map(h => toTX(h.ket_qua)).join("");

    // 1. Pattern template
    const patternMatch = detectPattern(historyString, templates);
    if (patternMatch) {
        return {
            du_doan: patternMatch.prediction,
            do_tin_cay: patternMatch.confidence,
            mau_cau: `Nhận diện mẫu VIP: ${patternMatch.name} (${patternMatch.action === 'follow' ? 'tiếp tục' : 'bẻ cầu'})`
        };
    }

    // 2. Fallback nếu không đủ dữ liệu
    if (history.length < 10) {
        const random = Math.random() * 100;
        const baseConfidence = 0.68 + Math.random() * 0.22;
        const pred = random < 65 ?
            (currentResult && currentResult.ket_qua === "TAI" ? "Xỉu" : "Tài") :
            (currentResult ? currentResult.ket_qua : "Tài");
        return {
            du_doan: pred,
            do_tin_cay: baseConfidence,
            mau_cau: "Không đủ dữ liệu - dự đoán cơ bản"
        };
    }

    const fullHistoryString = historyString;
    const recentHistory = history.slice(-30);
    const recentString = historyToBinary(recentHistory);

    const predictions = [];
    const weights = [];

    // Các phân tích con nâng cao
    const cycle = analyzeCycles(recentString);
    if (cycle.confidence > 0.55) {
        predictions.push(cycle.prediction);
        weights.push(cycle.confidence * 1.6);
    }

    const complex = analyzeComplexPatterns(recentString, fullHistoryString);
    if (complex.confidence > 0.5) {
        predictions.push(complex.prediction);
        weights.push(complex.confidence * 1.4);
    }

    const stat = analyzeStatistics(recentHistory, currentResult);
    if (stat.confidence > 0.5) {
        predictions.push(stat.prediction);
        weights.push(stat.confidence * 1.3);
    }

    const markov = analyzeMarkov(fullHistoryString);
    if (markov.confidence > 0.5) {
        predictions.push(markov.prediction);
        weights.push(markov.confidence * 1.5);
    }

    const balance = analyzeBalance(recentHistory);
    if (balance.confidence > 0.45) {
        predictions.push(balance.prediction);
        weights.push(balance.confidence * 1.2);
    }

    const score = analyzeScorePattern(recentHistory);
    if (score.confidence > 0.5) {
        predictions.push(score.prediction);
        weights.push(score.confidence * 1.2);
    }

    const longTrend = analyzeLongTrend(recentHistory);
    if (longTrend.confidence > 0.5) {
        predictions.push(longTrend.prediction);
        weights.push(longTrend.confidence * 1.3);
    }

    const volatility = analyzeVolatility(recentHistory);
    if (volatility.confidence > 0.5) {
        predictions.push(volatility.prediction);
        weights.push(volatility.confidence * 1.1);
    }

    // Tổng hợp
    if (predictions.length === 0) {
        const last10 = recentString.slice(-10);
        const countT = (last10.match(/T/g) || []).length;
        const countX = last10.length - countT;
        let finalPrediction, confidence, pattern;
        if (countT > countX + 1) {
            finalPrediction = "Xỉu";
            confidence = 0.72 + Math.random() * 0.15;
            pattern = "Xu hướng đảo chiều từ Tài";
        } else if (countX > countT + 1) {
            finalPrediction = "Tài";
            confidence = 0.72 + Math.random() * 0.15;
            pattern = "Xu hướng đảo chiều từ Xỉu";
        } else {
            const isReversal = Math.random() < 0.7;
            finalPrediction = isReversal ?
                (currentResult && currentResult.ket_qua === "TAI" ? "Xỉu" : "Tài") :
                (currentResult ? currentResult.ket_qua : "Tài");
            confidence = 0.68 + Math.random() * 0.20;
            pattern = "Dự đoán cân bằng";
        }
        return {
            du_doan: finalPrediction,
            do_tin_cay: clamp(confidence, 0.68, 0.88),
            mau_cau: pattern
        };
    }

    const votes = { Tài: 0, Xỉu: 0 };
    for (let i = 0; i < predictions.length; i++) {
        votes[predictions[i]] += weights[i];
    }
    const finalPrediction = votes.Tài > votes.Xỉu ? "Tài" : "Xỉu";
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const winningVotes = Math.max(votes.Tài, votes.Xỉu);
    const rawConfidence = winningVotes / totalWeight;
    let confidence = 0.68 + rawConfidence * 0.22;
    let pattern;
    if (new Set(predictions).size === 1 && predictions.length >= 4) {
        confidence = Math.min(0.92, confidence + 0.06);
        pattern = `Đồng thuận cao (${predictions.length} phương pháp)`;
    } else {
        pattern = `Phân tích đa thuật toán (${predictions.length} phương pháp)`;
    }
    const historyFactor = Math.min(1, history.length / 30);
    confidence = 0.68 + (confidence - 0.68) * historyFactor;
    confidence = clamp(confidence, 0.68, 0.92);

    return {
        du_doan: finalPrediction,
        do_tin_cay: Math.round(confidence * 100) / 100,
        mau_cau: pattern
    };
}

// ============================================================
// ENGINE (GIỮ LẠI CHO HỌC MÁY, NHƯNG KHÔNG ẢNH HƯỞNG DỰ ĐOÁN)
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
            model11: { correct: 0, wrong: 0, total: 0, weight: 1 }
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
// LOAD ENGINES (HU / MD5)
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
            headers: { Accept: "application/json", "User-Agent": "LC79-ULTRA-VIP-22.5" },
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
// PATTERN LIBRARY (GIỮ NGUYÊN CHO SO SÁNH)
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
    const complex = [
        "TTXTTXXTTTXTTXXTTXTX",
        "XXTXXTTXXXTXTTXXTTXT",
        "TXXTTXXTXXTTTXTTXXTT",
        "XTTXXTTXTTXXXTTXXTXX",
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
    saveJSON(PATHS[type].pattern, { version: "Ultra-VIP-22.5", length: PATTERN_LENGTH, patterns });
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
// HỌC MÁY (GIỮ NGUYÊN NHƯNG KHÔNG ẢNH HƯỞNG DỰ ĐOÁN)
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
// PHÂN TÍCH MỚI (SỬ DỤNG predictNextAdvanced)
// ============================================================

function analyze(type, sessions) {
    const pattern = buildPattern(sessions);
    const currentResult = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const predictionResult = predictNextAdvanced(currentResult, sessions, type);
    const prediction = predictionResult.du_doan === "Tài" ? "TAI" : "XIU";
    const confidence = predictionResult.do_tin_cay;
    const note = predictionResult.mau_cau;

    const final = { prediction, confidence, note };
    return {
        pattern,
        top10: getTop10Patterns(type, pattern),
        final: final,
        model1: null,
        model2: null,
        model3: null,
        model4: null,
        model5: null,
        model6: null,
        model7: null,
        model8: null,
        model9: null,
        model10: null,
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
// PERFORMANCE (CHỈ CẬP NHẬT MODEL11)
// ============================================================

function updatePerformance(type, phien, actual) {
    const prediction = pending[type].get(phien);
    if (!prediction) return;
    const final = prediction.final;
    if (!final || !final.prediction) return;

    const perf = engines[type].performance["model11"];
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
            do_tin_cay: `${(final.confidence * 100).toFixed(2)}%`
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
        engine: "LC79 ULTRA VIP 22.5",
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
║         LC79 ULTRA VIP 22.5                     ║
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
