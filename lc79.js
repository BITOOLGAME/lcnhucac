
// server.js - Ultimate Tai Xiu Prediction API v10.0 (AI Self-Learning)
// Chuyển đổi từ Python sang NodeJS
// Hỗ trợ 8 game: LC79(TX/MD5), BETVIP(TX/MD5), XENGLIVE(TX/MD5), XOCDIA88(TX/MD5)

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_KEY = "apinova";
const USER_ID = "@novavyr";
const ALGO_NAME = "Nova SIÊU VIP v10.0 (AI)";

// ================= CONFIG =================
const GAME_CONFIG = {
    "lc79_tx": {
        game_key: "LC79_TX",
        api_url: "https://wtx.tele68.com/v1/tx/sessions",
        name: "LC79 Tài Xỉu",
        type: "legacy"
    },
    "lc79_md5": {
        game_key: "LC79_MD5",
        api_url: "https://wtxmd52.tele68.com/v1/txmd5/sessions",
        name: "LC79 MD5",
        type: "legacy"
    },
    "betvip_tx": {
        game_key: "BETVIP_TX",
        api_url: "https://wtx.macminim6.online/v1/tx/sessions",
        name: "BETVIP Tài Xỉu",
        type: "legacy"
    },
    "betvip_md5": {
        game_key: "BETVIP_MD5",
        api_url: "https://wtxmd52.macminim6.online/v1/txmd5/sessions",
        name: "BETVIP MD5",
        type: "legacy"
    },
    "xenglive_tx": {
        game_key: "XENGLIVE_TX",
        api_url: "https://taixiu.backend-98423498294223x1.online/api/luckydice/GetSoiCau",
        name: "XengLive Tài Xỉu",
        type: "new"
    },
    "xenglive_md5": {
        game_key: "XENGLIVE_MD5",
        api_url: "https://taixiumd5.backend-98423498294223x1.online/api/md5luckydice/GetSoiCau",
        name: "XengLive MD5",
        type: "new"
    },
    "xocdia88_tx": {
        game_key: "XOCDIA88_TX",
        api_url: "https://taixiu.system32-cloudfare-356783752985678522.monster/api/luckydice/GetSoiCau",
        name: "XocDia88 Tài Xỉu",
        type: "new"
    },
    "xocdia88_md5": {
        game_key: "XOCDIA88_MD5",
        api_url: "https://taixiumd5.system32-cloudfare-356783752985678522.monster/api/md5luckydice/GetSoiCau",
        name: "XocDia88 MD5",
        type: "new"
    }
};

// ================= CACHE =================
let gameCache = {};
let actualHistory = {};
let pendingPredictions = {};

// ================= HÀM TIỆN ÍCH =================
function movingAverage(data, window) {
    if (data.length < window) return data.reduce((a, b) => a + b, 0) / data.length;
    const slice = data.slice(-window);
    return slice.reduce((a, b) => a + b, 0) / window;
}

function standardDeviation(data, mean = null) {
    if (data.length === 0) return 0;
    if (mean === null) mean = data.reduce((a, b) => a + b, 0) / data.length;
    const variance = data.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / data.length;
    return Math.sqrt(variance);
}

async function fetchData(url) {
    try {
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        console.error(`Lỗi fetch ${url}:`, error.message);
        return null;
    }
}

async function fetchAndCache(gameId) {
    const config = GAME_CONFIG[gameId];
    if (!config) return null;
    const data = await fetchData(config.api_url);
    if (data) {
        gameCache[gameId] = { data, ts: new Date().toISOString() };
    }
    return data;
}

async function getCachedData(gameId) {
    if (gameCache[gameId]) return gameCache[gameId].data;
    return await fetchAndCache(gameId);
}

function parseSession(item, gameType) {
    let result = null, point = 0, dices = [0, 0, 0], sessionId = null;
    
    if (gameType === "legacy") {
        const resultRaw = (item.resultTruyenThong || "").toUpperCase();
        result = resultRaw.includes("TAI") ? "T" : resultRaw.includes("XIU") ? "X" : null;
        point = item.point || 0;
        dices = item.dices || [0, 0, 0];
        sessionId = item.id;
    } else {
        const betSide = item.BetSide;
        result = betSide === 0 ? "T" : betSide === 1 ? "X" : null;
        point = item.DiceSum || 0;
        dices = [item.FirstDice || 0, item.SecondDice || 0, item.ThirdDice || 0];
        sessionId = item.SessionId;
    }
    return { result, point, dices, sessionId };
}

function buildHistory(dataList, gameType, maxLen = 100) {
    if (!dataList) return { history: "", totals: [] };
    const items = dataList.list || dataList;
    const recent = items.slice(0, maxLen).reverse();
    let history = "";
    let totals = [];
    for (const item of recent) {
        const { result, point } = parseSession(item, gameType);
        if (result) {
            history += result;
            totals.push(point);
        }
    }
    return { history, totals };
}

// ================= SELF LEARNING =================
class SelfLearning {
    constructor(decay = 0.95, minWeight = 30, maxWeight = 120) {
        this.weights = new Map();
        this.history = new Map();
        this.decay = decay;
        this.minWeight = minWeight;
        this.maxWeight = maxWeight;
    }

    update(algoName, gameId, correct) {
        const key = `${gameId}_${algoName}`;
        if (!this.history.has(key)) this.history.set(key, []);
        const hist = this.history.get(key);
        hist.push(correct ? 1 : 0);
        if (hist.length > 200) hist.shift();
        
        const recent = hist.slice(-50);
        if (recent.length > 0) {
            const accuracy = recent.reduce((a, b) => a + b, 0) / recent.length;
            let newWeight = 50 + accuracy * 70;
            newWeight = Math.max(this.minWeight, Math.min(this.maxWeight, newWeight));
            const oldWeight = this.weights.get(key) || 70;
            this.weights.set(key, oldWeight * this.decay + newWeight * (1 - this.decay));
        } else {
            this.weights.set(key, 70);
        }
    }

    getWeight(algoName, gameId) {
        const key = `${gameId}_${algoName}`;
        return this.weights.get(key) || 70;
    }
}

const selfLearning = new SelfLearning();

// ================= PATTERN DETECTORS (35 patterns) =================
class UltimatePatternDetector {
    static detectBet(history) {
        if (history.length < 2) return null;
        const last = history[history.length - 1];
        let run = 1;
        for (let i = history.length - 2; i >= 0; i--) {
            if (history[i] === last) run++;
            else break;
        }
        if (run >= 10) return { name: `🔥 Bệt ${run} (BẺ GẤP)`, confidence: 90, next: last === 'T' ? 'X' : 'T', weight: 95 };
        if (run >= 8) return { name: `⚠️ Bệt ${run} (BẺ CẦU)`, confidence: 85, next: last === 'T' ? 'X' : 'T', weight: 85 };
        if (run >= 6) return { name: `📈 Bệt ${run} (CẢNH BÁO)`, confidence: 75, next: last, weight: 75 };
        if (run >= 4) return { name: `📊 Bệt ${run}`, confidence: 65, next: last, weight: 70 };
        if (run >= 2) return { name: `📉 Bệt ${run}`, confidence: 55, next: last, weight: 60 };
        return null;
    }

    static detect11(history) {
        if (history.length >= 4) {
            const last4 = history.slice(-4).join('');
            if (last4 === "TXTX" || last4 === "XTXT") {
                return { name: "⚡ Cầu 1-1", confidence: 88, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 85 };
            }
        }
        return null;
    }

    static detect22(history) {
        if (history.length >= 4) {
            const last4 = history.slice(-4).join('');
            if (last4 === "TTXX" || last4 === "XXTT") {
                const nextPred = history.slice(-2).join('') === "TT" || history.slice(-2).join('') === "XT" ? 'T' : 'X';
                return { name: "🎯 Cầu 2-2", confidence: 82, next: nextPred, weight: 80 };
            }
        }
        return null;
    }

    static detect33(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TTTXXX" || last6 === "XXXTTT") {
                const nextPred = history.slice(-3).join('') === "TTT" ? 'X' : 'T';
                return { name: "🎲 Cầu 3-3", confidence: 78, next: nextPred, weight: 75 };
            }
        }
        return null;
    }

    static detect12(history) {
        const patterns = { "TXX": "T", "XTT": "X" };
        for (const [pat, nxt] of Object.entries(patterns)) {
            if (history.length >= pat.length && history.slice(-pat.length).join('') === pat) {
                return { name: `🌀 Cầu 1-2 (${pat})`, confidence: 72, next: nxt, weight: 70 };
            }
        }
        return null;
    }

    static detect21(history) {
        const patterns = { "TTX": "X", "XXT": "T" };
        for (const [pat, nxt] of Object.entries(patterns)) {
            if (history.length >= pat.length && history.slice(-pat.length).join('') === pat) {
                return { name: `🌀 Cầu 2-1 (${pat})`, confidence: 72, next: nxt, weight: 70 };
            }
        }
        return null;
    }

    static detect123(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TXXTTT") return { name: "🏆 Cầu 1-2-3 (T)", confidence: 77, next: 'X', weight: 75 };
            if (last6 === "XTTXXX") return { name: "🏆 Cầu 1-2-3 (X)", confidence: 77, next: 'T', weight: 75 };
        }
        return null;
    }

    static detect321(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TTTXXT") return { name: "🏆 Cầu 3-2-1 (T)", confidence: 77, next: 'X', weight: 75 };
            if (last6 === "XXXTTX") return { name: "🏆 Cầu 3-2-1 (X)", confidence: 77, next: 'T', weight: 75 };
        }
        return null;
    }

    static detectTriangle(history) {
        if (history.length >= 5) {
            const last5 = history.slice(-5).join('');
            if (last5 === "TXTXT") return { name: "🔺 Cầu tam giác T", confidence: 80, next: 'X', weight: 78 };
            if (last5 === "XTXTX") return { name: "🔺 Cầu tam giác X", confidence: 80, next: 'T', weight: 78 };
        }
        if (history.length >= 7) {
            const last7 = history.slice(-7).join('');
            if (last7 === "TXTXTXT") return { name: "🔺🔺 Cầu tam giác mở rộng T", confidence: 85, next: 'X', weight: 82 };
            if (last7 === "XTXTXTX") return { name: "🔺🔺 Cầu tam giác mở rộng X", confidence: 85, next: 'T', weight: 82 };
        }
        return null;
    }

    static detectPhaseShift(history) {
        if (history.length >= 5) {
            const last5 = history.slice(-5).join('');
            if (last5 === "TTXXX") return { name: "📐 Cầu lệch pha 2-3", confidence: 75, next: 'T', weight: 72 };
            if (last5 === "XXTTT") return { name: "📐 Cầu lệch pha 3-2", confidence: 75, next: 'X', weight: 72 };
        }
        if (history.length >= 8) {
            const last8 = history.slice(-8).join('');
            if (last8 === "TTXXXTTX") return { name: "📐📐 Cầu lệch pha 2-3-2", confidence: 80, next: 'X', weight: 78 };
            if (last8 === "XXTTTXXT") return { name: "📐📐 Cầu lệch pha 3-2-3", confidence: 80, next: 'T', weight: 78 };
        }
        return null;
    }

    static detectArithmetic(history) {
        if (history.length < 8) return null;
        const nums = history.slice(-8).map(c => c === 'T' ? 1 : 0);
        const total = nums.reduce((a, b) => a + b, 0);
        if ([2, 3, 5, 6].includes(total)) {
            return { name: "🧮 Cầu số học", confidence: 68, next: total > 4 ? 'T' : 'X', weight: 65 };
        }
        return null;
    }

    static detectFibonacci(history) {
        if (history.length < 9) return null;
        const fibs = [1, 1, 2, 3, 5, 8];
        let tCount = 0;
        for (const f of fibs) {
            if (history.length > f && history[history.length - f] === 'T') tCount++;
        }
        if (tCount >= 4) return { name: "🌀 Cầu Fibonacci T", confidence: 75, next: 'X', weight: 73 };
        if (tCount <= 2) return { name: "🌀 Cầu Fibonacci X", confidence: 75, next: 'T', weight: 73 };
        return null;
    }

    static detectRegressionBreak(history) {
        if (history.length < 10) return null;
        const nums = history.slice(-10).map(c => c === 'T' ? 1 : 0);
        const ma5 = movingAverage(nums.slice(-5), 5);
        const ma10 = movingAverage(nums, 10);
        if (Math.abs(ma5 - ma10) > 0.3) {
            return { name: "📈📉 Cầu phá vỡ xu hướng", confidence: 72, next: nums[nums.length - 1] === 0 ? 'T' : 'X', weight: 70 };
        }
        return null;
    }

    static detectCycle(history, minC = 2, maxC = 6) {
        for (let c = minC; c <= maxC; c++) {
            if (history.length < c * 2) continue;
            const pattern = history.slice(-c).join('');
            const prevPattern = history.slice(-c * 2, -c).join('');
            if (prevPattern === pattern) {
                const pos = history.length % c;
                return { name: `🔄 Cầu chu kỳ ${c}`, confidence: 78, next: pattern[pos], weight: 75 };
            }
        }
        return null;
    }

    static detectTrend(history) {
        if (history.length < 20) return null;
        const short = history.slice(-7).filter(c => c === 'T').length / 7;
        const medium = history.slice(-14).filter(c => c === 'T').length / 14;
        const long = history.slice(-21).filter(c => c === 'T').length / 21;
        if (short > medium && medium > long && short - long > 0.2) {
            return { name: "🚀 Xu hướng TÀI tăng mạnh", confidence: 80, next: 'T', weight: 78 };
        }
        if (long > medium && medium > short && long - short > 0.2) {
            return { name: "📉 Xu hướng XỈU tăng mạnh", confidence: 80, next: 'X', weight: 78 };
        }
        if (short > medium + 0.15) {
            return { name: "📈 Xu hướng TÀI ngắn hạn", confidence: 70, next: 'T', weight: 68 };
        }
        if (medium > long + 0.15) {
            return { name: "📊 Xu hướng XỈU dài hạn", confidence: 70, next: 'X', weight: 68 };
        }
        return null;
    }

    static detectBalanceBreak(history) {
        if (history.length < 12) return null;
        const recent = history.slice(-12);
        const tCount = recent.filter(c => c === 'T').length;
        if (Math.abs(tCount - (12 - tCount)) <= 2) {
            return { name: "⚖️ Bẻ cầu do cân bằng", confidence: 75, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 72 };
        }
        return null;
    }

    static detectBetReverse(history) {
        if (history.length < 6) return null;
        let run = 1;
        const last = history[history.length - 1];
        for (let i = history.length - 2; i >= 0; i--) {
            if (history[i] === last) run++;
            else break;
        }
        if (run >= 5 && history[history.length - 2] === last && history[history.length - 1] !== last) {
            return { name: "🔄 Cầu bệt đảo", confidence: 70, next: last, weight: 68 };
        }
        return null;
    }

    static detect11Reverse(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TXTXXT" || last6 === "XTXTXX") {
                return { name: "🔄 Cầu 1-1 đảo", confidence: 73, next: history[history.length - 1], weight: 70 };
            }
        }
        return null;
    }

    static detect22Reverse(history) {
        if (history.length >= 8) {
            const last8 = history.slice(-8).join('');
            if (last8 === "TTXXTTXX" || last8 === "XXTTXXTT") {
                return { name: "🔄 Cầu 2-2 đảo", confidence: 75, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 72 };
            }
        }
        return null;
    }

    static detect33Reverse(history) {
        if (history.length >= 12) {
            const last12 = history.slice(-12).join('');
            if (last12 === "TTTXXXTTTXXX" || last12 === "XXXTTTXXXTTT") {
                return { name: "🔄 Cầu 3-3 đảo", confidence: 78, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 75 };
            }
        }
        return null;
    }

    static detectDragon(history) {
        if (history.length < 5) return null;
        let tRun = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i] === 'T') tRun++;
            else break;
        }
        if (tRun >= 6) return { name: `🐉 Cầu Rồng ${tRun} (BẺ)`, confidence: 82, next: 'X', weight: 80 };
        if (tRun >= 4) return { name: `🐉 Cầu Rồng ${tRun}`, confidence: 72, next: 'T', weight: 70 };
        return null;
    }

    static detectTiger(history) {
        if (history.length < 5) return null;
        let xRun = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i] === 'X') xRun++;
            else break;
        }
        if (xRun >= 6) return { name: `🐯 Cầu Hổ ${xRun} (BẺ)`, confidence: 82, next: 'T', weight: 80 };
        if (xRun >= 4) return { name: `🐯 Cầu Hổ ${xRun}`, confidence: 72, next: 'X', weight: 70 };
        return null;
    }

    static detectEvenOdd(history, totals) {
        if (totals.length < 5) return null;
        const recentTotals = totals.slice(-5);
        const evenCount = recentTotals.filter(t => t % 2 === 0).length;
        if (evenCount >= 4) return { name: "🎲 Cầu tổng CHẴN", confidence: 70, next: evenCount > 2 ? 'T' : 'X', weight: 68 };
        if (evenCount <= 1) return { name: "🎲 Cầu tổng LẺ", confidence: 70, next: evenCount > 2 ? 'X' : 'T', weight: 68 };
        return null;
    }

    static detectTotalBet(history, totals) {
        if (totals.length < 6) return null;
        const recent = totals.slice(-6);
        let increasing = true, decreasing = true;
        for (let i = 0; i < recent.length - 1; i++) {
            if (recent[i] > recent[i + 1]) increasing = false;
            if (recent[i] < recent[i + 1]) decreasing = false;
        }
        if (increasing) return { name: "📈 Cầu tổng tăng dần", confidence: 68, next: 'T', weight: 65 };
        if (decreasing) return { name: "📉 Cầu tổng giảm dần", confidence: 68, next: 'X', weight: 65 };
        return null;
    }

    static detectChain(history) {
        if (history.length < 7) return null;
        const last7 = history.slice(-7);
        let allAlternating = true;
        for (let i = 0; i < last7.length - 1; i++) {
            if (last7[i] === last7[i + 1]) allAlternating = false;
        }
        if (allAlternating) return { name: "⛓️ Cầu chuỗi đảo liên tục", confidence: 85, next: last7[last7.length - 1] === 'T' ? 'X' : 'T', weight: 82 };
        if (new Set(last7).size === 1) return { name: "⛓️ Cầu chuỗi bệt dài", confidence: 75, next: last7[last7.length - 1], weight: 72 };
        return null;
    }

    static detect44(history) {
        if (history.length >= 8) {
            const last8 = history.slice(-8).join('');
            if (last8 === "TTTTXXXX" || last8 === "XXXXTTTT") {
                const nextPred = history.slice(-4).join('') === "XXXX" ? 'T' : 'X';
                return { name: "🎯 Cầu 4-4", confidence: 79, next: nextPred, weight: 76 };
            }
        }
        return null;
    }

    static detect55(history) {
        if (history.length >= 10) {
            const last10 = history.slice(-10).join('');
            if (last10 === "TTTTTXXXXX" || last10 === "XXXXXTTTTT") {
                const nextPred = history.slice(-5).join('') === "XXXXX" ? 'T' : 'X';
                return { name: "🎯 Cầu 5-5", confidence: 77, next: nextPred, weight: 74 };
            }
        }
        return null;
    }

    static detectZigzag(history) {
        if (history.length >= 5) {
            const last5 = history.slice(-5).join('');
            if (last5 === "TXTXT" || last5 === "XTXTX") {
                return { name: "⚡ Cầu Zigzag 5", confidence: 80, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 78 };
            }
        }
        if (history.length >= 7) {
            const last7 = history.slice(-7).join('');
            if (last7 === "TXTXTXT" || last7 === "XTXTXTX") {
                return { name: "⚡ Cầu Zigzag 7", confidence: 84, next: history[history.length - 1] === 'T' ? 'X' : 'T', weight: 82 };
            }
        }
        return null;
    }

    static detectDouble12(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TXXTXX") return { name: "🔄 Cầu 1-2 kép", confidence: 74, next: 'X', weight: 71 };
            if (last6 === "XTTXTT") return { name: "🔄 Cầu 1-2 kép", confidence: 74, next: 'T', weight: 71 };
        }
        return null;
    }

    static detectPyramid(history) {
        if (history.length >= 7) {
            const last7 = history.slice(-7).join('');
            if (last7 === "TTXXTTX") return { name: "🔺 Cầu kim tự tháp", confidence: 76, next: 'X', weight: 73 };
            if (last7 === "XXTTXXT") return { name: "🔺 Cầu kim tự tháp", confidence: 76, next: 'T', weight: 73 };
        }
        return null;
    }

    static detectGap(history) {
        if (history.length >= 6) {
            const last6 = history.slice(-6).join('');
            if (last6 === "TXXTXX") return { name: "🚪 Cầu khoảng trống", confidence: 69, next: 'X', weight: 66 };
            if (last6 === "XTTXTT") return { name: "🚪 Cầu khoảng trống", confidence: 69, next: 'T', weight: 66 };
        }
        return null;
    }

    static detectMomentum(history) {
        if (history.length >= 5) {
            const last5 = history.slice(-5).join('');
            if (last5 === "TTTTT") return { name: "🚀 Đà tăng cực mạnh", confidence: 88, next: 'X', weight: 86 };
            if (last5 === "XXXXX") return { name: "📉 Đà giảm cực mạnh", confidence: 88, next: 'T', weight: 86 };
        }
        return null;
    }

    static detectAlternatingShort(history) {
        if (history.length >= 4) {
            const last4 = history.slice(-4).join('');
            if (last4 === "TXXT") return { name: "🔄 Đảo ngắn T-X-X-T", confidence: 72, next: 'X', weight: 70 };
            if (last4 === "XTTX") return { name: "🔄 Đảo ngắn X-T-T-X", confidence: 72, next: 'T', weight: 70 };
        }
        return null;
    }

    static detectFourCycle(history) {
        if (history.length >= 8) {
            const last8 = history.slice(-8).join('');
            if (last8 === "TTXXTTXX") return { name: "🔁 Chu kỳ 2-2-2-2", confidence: 78, next: 'X', weight: 76 };
            if (last8 === "XXTTXXTT") return { name: "🔁 Chu kỳ 2-2-2-2", confidence: 78, next: 'T', weight: 76 };
        }
        return null;
    }
}

// ================= ADVANCED ALGORITHMS (40 algorithms) =================
class UltimateAdvancedAlgo {
    static markov1(history) {
        if (history.length < 2) return null;
        const last = history[history.length - 1];
        let tCount = 0, xCount = 0;
        for (let i = 0; i < history.length - 1; i++) {
            if (history[i] === last) {
                if (history[i + 1] === 'T') tCount++;
                else xCount++;
            }
        }
        if (tCount > xCount) return 'T';
        if (xCount > tCount) return 'X';
        return null;
    }

    static markov2(history) {
        if (history.length < 3) return null;
        const last2 = history.slice(-2).join('');
        const trans = new Map();
        for (let i = 0; i < history.length - 2; i++) {
            const key = history.slice(i, i + 2).join('');
            const next = history[i + 2];
            if (!trans.has(key)) trans.set(key, { T: 0, X: 0 });
            trans.get(key)[next]++;
        }
        const stats = trans.get(last2);
        if (stats) {
            if (stats.T > stats.X) return 'T';
            if (stats.X > stats.T) return 'X';
        }
        return null;
    }

    static markov3(history) {
        if (history.length < 4) return null;
        const last3 = history.slice(-3).join('');
        const trans = new Map();
        for (let i = 0; i < history.length - 3; i++) {
            const key = history.slice(i, i + 3).join('');
            const next = history[i + 3];
            if (!trans.has(key)) trans.set(key, { T: 0, X: 0 });
            trans.get(key)[next]++;
        }
        const stats = trans.get(last3);
        if (stats) {
            if (stats.T > stats.X) return 'T';
            if (stats.X > stats.T) return 'X';
        }
        return null;
    }

    static markov4(history) {
        if (history.length < 5) return null;
        const last4 = history.slice(-4).join('');
        const trans = new Map();
        for (let i = 0; i < history.length - 4; i++) {
            const key = history.slice(i, i + 4).join('');
            const next = history[i + 4];
            if (!trans.has(key)) trans.set(key, { T: 0, X: 0 });
            trans.get(key)[next]++;
        }
        const stats = trans.get(last4);
        if (stats) {
            if (stats.T > stats.X) return 'T';
            if (stats.X > stats.T) return 'X';
        }
        return null;
    }

    static markov5(history) {
        if (history.length < 6) return null;
        const last5 = history.slice(-5).join('');
        const trans = new Map();
        for (let i = 0; i < history.length - 5; i++) {
            const key = history.slice(i, i + 5).join('');
            const next = history[i + 5];
            if (!trans.has(key)) trans.set(key, { T: 0, X: 0 });
            trans.get(key)[next]++;
        }
        const stats = trans.get(last5);
        if (stats) {
            if (stats.T > stats.X) return 'T';
            if (stats.X > stats.T) return 'X';
        }
        return null;
    }

    static weightedFrequency(history, window = 20) {
        if (history.length === 0) return null;
        const recent = history.slice(-window);
        let wt = 0, wx = 0;
        for (let i = 0; i < recent.length; i++) {
            const weight = i + 1;
            if (recent[recent.length - 1 - i] === 'T') wt += weight;
            else wx += weight;
        }
        if (wt > wx) return 'T';
        if (wx > wt) return 'X';
        return null;
    }

    static simpleMajority(history, window = 15) {
        if (history.length < window) return null;
        const recent = history.slice(-window);
        const tCount = recent.filter(c => c === 'T').length;
        const xCount = window - tCount;
        if (tCount > xCount) return 'T';
        if (xCount > tCount) return 'X';
        return null;
    }

    static movingAverageCross(history, short = 5, long = 13) {
        if (history.length < long) return null;
        const shortT = history.slice(-short).filter(c => c === 'T').length / short;
        const longT = history.slice(-long).filter(c => c === 'T').length / long;
        if (shortT > longT + 0.12) return 'T';
        if (longT > shortT + 0.12) return 'X';
        return null;
    }

    static entropyPrediction(history, window = 12) {
        if (history.length < window) return null;
        const recent = history.slice(-window);
        const pT = recent.filter(c => c === 'T').length / window;
        if (pT === 0 || pT === 1) return recent[recent.length - 1];
        const entropy = -pT * Math.log2(pT) - (1 - pT) * Math.log2(1 - pT);
        if (entropy > 0.95) return recent[recent.length - 1] === 'T' ? 'X' : 'T';
        return recent[recent.length - 1];
    }

    static fibonacciFractal(history) {
        const fibs = [1, 1, 2, 3, 5, 8, 13];
        let matchCount = 0;
        for (const f of fibs) {
            if (history.length > f && history[history.length - f] === history[history.length - 1]) matchCount++;
        }
        if (matchCount >= fibs.length / 2) return history[history.length - 1];
        return history[history.length - 1] === 'T' ? 'X' : 'T';
    }

    static cumulativeImbalance(history, window = 25) {
        if (history.length < window) return null;
        const recent = history.slice(-window);
        const imbalance = recent.filter(c => c === 'T').length - recent.filter(c => c === 'X').length;
        if (imbalance > 7) return 'X';
        if (imbalance < -7) return 'T';
        return null;
    }

    static zigzagPredict(history) {
        if (history.length < 5) return null;
        let changes = 0;
        for (let i = 1; i < Math.min(5, history.length); i++) {
            if (history[history.length - i] !== history[history.length - i - 1]) changes++;
        }
        if (changes >= 4) return history[history.length - 1] === 'T' ? 'X' : 'T';
        if (changes >= 3) return history[history.length - 1];
        return null;
    }

    static rsiPredict(history, period = 7) {
        if (history.length < period) return null;
        const nums = history.slice(-period).map(c => c === 'T' ? 1 : 0);
        let gains = 0, losses = 0;
        for (let i = 1; i < nums.length; i++) {
            const diff = nums[i] - nums[i - 1];
            if (diff > 0) gains += diff;
            else losses += Math.abs(diff);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        let rsi = 50;
        if (avgLoss === 0) rsi = 100;
        else rsi = 100 - (100 / (1 + avgGain / avgLoss));
        if (rsi > 75) return history[history.length - 1] === 'T' ? 'X' : 'T';
        if (rsi < 25) return history[history.length - 1] === 'T' ? 'X' : 'T';
        if (rsi > 65) return 'X';
        if (rsi < 35) return 'T';
        return null;
    }

    static bollingerPredict(history, period = 12) {
        if (history.length < period) return null;
        const nums = history.slice(-period).map(c => c === 'T' ? 1 : 0);
        const mean = nums.reduce((a, b) => a + b, 0) / period;
        const std = standardDeviation(nums, mean);
        const upper = mean + 2 * std;
        const lower = mean - 2 * std;
        const last = nums[nums.length - 1];
        if (last > upper) return 'X';
        if (last < lower) return 'T';
        return null;
    }

    static macdPredict(history, short = 6, long = 13, signal = 4) {
        if (history.length < long + signal) return null;
        const nums = history.map(c => c === 'T' ? 1 : 0);
        const emaShort = movingAverage(nums.slice(-short), short);
        const emaLong = movingAverage(nums.slice(-long), long);
        const macd = emaShort - emaLong;
        const macdHistory = [];
        for (let i = nums.length - signal; i < nums.length; i++) {
            const slice = nums.slice(0, i + 1);
            const es = movingAverage(slice.slice(-short), Math.min(short, slice.length));
            const el = movingAverage(slice.slice(-long), Math.min(long, slice.length));
            macdHistory.push(es - el);
        }
        const signalLine = movingAverage(macdHistory, Math.min(signal, macdHistory.length));
        if (macd > signalLine + 0.05) return 'T';
        if (macd < signalLine - 0.05) return 'X';
        return null;
    }

    static stochasticPredict(history, period = 7) {
        if (history.length < period) return null;
        const nums = history.slice(-period).map(c => c === 'T' ? 1 : 0);
        const highest = Math.max(...nums);
        const lowest = Math.min(...nums);
        if (highest === lowest) return null;
        const k = (nums[nums.length - 1] - lowest) / (highest - lowest) * 100;
        if (k > 80) return 'X';
        if (k < 20) return 'T';
        return null;
    }

    static williamsR(history, period = 7) {
        if (history.length < period) return null;
        const nums = history.slice(-period).map(c => c === 'T' ? 1 : 0);
        const highest = Math.max(...nums);
        const lowest = Math.min(...nums);
        if (highest === lowest) return null;
        const wr = (highest - nums[nums.length - 1]) / (highest - lowest) * (-100);
        if (wr < -80) return 'T';
        if (wr > -20) return 'X';
        return null;
    }

    static cciPredict(history, period = 10) {
        if (history.length < period) return null;
        const nums = history.slice(-period).map(c => c === 'T' ? 1 : 0);
        const mean = nums.reduce((a, b) => a + b, 0) / period;
        const mad = nums.reduce((sum, x) => sum + Math.abs(x - mean), 0) / period;
        if (mad === 0) return null;
        const cci = (nums[nums.length - 1] - mean) / (0.015 * mad);
        if (cci > 100) return 'X';
        if (cci < -100) return 'T';
        return null;
    }

    static adxPredict(history, period = 10) {
        if (history.length < period + 1) return null;
        const nums = history.map(c => c === 'T' ? 1 : 0);
        const plusDM = [], minusDM = [];
        for (let i = 1; i < nums.length; i++) {
            const diff = nums[i] - nums[i - 1];
            if (diff > 0) {
                plusDM.push(diff);
                minusDM.push(0);
            } else if (diff < 0) {
                plusDM.push(0);
                minusDM.push(Math.abs(diff));
            } else {
                plusDM.push(0);
                minusDM.push(0);
            }
        }
        if (plusDM.length < period) return null;
        const tr = [];
        for (let i = 1; i < nums.length; i++) {
            tr.push(Math.abs(nums[i] - nums[i - 1]));
        }
        const atr = movingAverage(tr.slice(-period), period);
        if (atr === 0) return null;
        const plusDI = movingAverage(plusDM.slice(-period), period) / atr * 100;
        const minusDI = movingAverage(minusDM.slice(-period), period) / atr * 100;
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        if (dx > 40) return plusDI > minusDI ? 'T' : 'X';
        return null;
    }

    static meanReversion(history, window = 12) {
        if (history.length < window) return null;
        const recent = history.slice(-window);
        const mean = recent.filter(c => c === 'T').length / window;
        if (mean > 0.75) return 'X';
        if (mean < 0.25) return 'T';
        return null;
    }

    static patternMatching(history, lookback = 25) {
        if (history.length < lookback) return null;
        const query = history.slice(-lookback);
        let bestMatch = -1, bestScore = -1;
        for (let i = 0; i < history.length - lookback; i++) {
            const segment = history.slice(i, i + lookback);
            let score = 0;
            for (let j = 0; j < lookback; j++) {
                if (segment[j] === query[j]) score++;
            }
            if (score > bestScore) {
                bestScore = score;
                bestMatch = i;
            }
        }
        if (bestMatch !== -1 && bestMatch + lookback < history.length) {
            return history[bestMatch + lookback];
        }
        return null;
    }

    static linearRegression(history, window = 12) {
        if (history.length < window) return null;
        const y = history.slice(-window).map(c => c === 'T' ? 1 : 0);
        const x = Array.from({ length: window }, (_, i) => i);
        const n = window;
        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
        const denom = n * sumX2 - sumX * sumX;
        if (denom === 0) return null;
        const slope = (n * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / n;
        const pred = slope * window + intercept;
        return pred > 0.5 ? 'T' : 'X';
    }

    static knnPredict(history, k = 5, lookback = 10) {
        if (history.length < lookback + k) return null;
        const query = history.slice(-lookback);
        const distances = [];
        for (let i = 0; i < history.length - lookback - 1; i++) {
            const segment = history.slice(i, i + lookback);
            let distance = 0;
            for (let j = 0; j < lookback; j++) {
                if (segment[j] !== query[j]) distance++;
            }
            distances.push({ dist: distance, next: history[i + lookback] });
        }
        distances.sort((a, b) => a.dist - b.dist);
        const neighbors = distances.slice(0, k);
        const tCount = neighbors.filter(n => n.next === 'T').length;
        return tCount > k - tCount ? 'T' : 'X';
    }

    static naiveBayes(history, window = 15) {
        if (history.length < window) return null;
        const pT = history.filter(c => c === 'T').length / history.length;
        const pX = 1 - pT;
        const last5 = history.slice(-5);
        let condT = 0, condX = 0;
        let tCount = 0, xCount = 0;
        for (let i = 0; i < history.length - 5; i++) {
            const segment = history.slice(i, i + 5);
            if (segment.join('') === last5.join('')) {
                const next = history[i + 5];
                if (next === 'T') {
                    condT++;
                    tCount++;
                } else {
                    condX++;
                    xCount++;
                }
            }
        }
        condT = condT / Math.max(1, tCount);
        condX = condX / Math.max(1, xCount);
        const postT = pT * condT;
        const postX = pX * condX;
        return postT > postX ? 'T' : 'X';
    }

    static decisionTree(history) {
        if (history.length < 10) return null;
        const last1 = history[history.length - 1];
        const last2 = history.length > 1 ? history[history.length - 2] : null;
        const last3 = history.length > 2 ? history[history.length - 3] : null;
        const t5 = history.slice(-5).filter(c => c === 'T').length;
        if (last1 === 'T' && last2 === 'T' && last3 === 'T') return 'X';
        if (last1 === 'X' && last2 === 'X' && last3 === 'X') return 'T';
        if (last1 === 'T' && last2 === 'X' && last3 === 'T') return 'X';
        if (last1 === 'X' && last2 === 'T' && last3 === 'X') return 'T';
        if (t5 >= 4) return 'X';
        if (t5 <= 1) return 'T';
        return last1;
    }

    static ensembleVoting(history) {
        const algos = [
            UltimateAdvancedAlgo.markov3,
            UltimateAdvancedAlgo.weightedFrequency,
            UltimateAdvancedAlgo.rsiPredict,
            UltimateAdvancedAlgo.meanReversion,
            UltimateAdvancedAlgo.patternMatching
        ];
        const votes = [];
        for (const algo of algos) {
            const pred = algo(history);
            if (pred) votes.push(pred);
        }
        if (votes.length === 0) return null;
        const tCount = votes.filter(v => v === 'T').length;
        return tCount > votes.length - tCount ? 'T' : 'X';
    }

    static reinforcementLearning(history, gameId) {
        if (!actualHistory[gameId] || actualHistory[gameId].length === 0) return null;
        const recentResults = actualHistory[gameId].slice(-20);
        if (recentResults.length < 10) return null;
        const patternWinRate = new Map();
        for (let i = 0; i < recentResults.length - 1; i++) {
            const pat = recentResults[i];
            const nxt = recentResults[i + 1];
            if (!patternWinRate.has(pat)) patternWinRate.set(pat, { win: 0, total: 0 });
            const stats = patternWinRate.get(pat);
            stats.total++;
            if (nxt === 'T') stats.win++;
        }
        const currentPattern = history.slice(-5).join('');
        if (!patternWinRate.has(currentPattern) || patternWinRate.get(currentPattern).total < 3) return null;
        const stats = patternWinRate.get(currentPattern);
        const winRate = stats.win / stats.total;
        return winRate > 0.5 ? 'T' : 'X';
    }

    static logisticRegression(history, window = 15) {
        if (history.length < window) return null;
        const y = history.slice(-window).map(c => c === 'T' ? 1 : 0);
        const ma5 = movingAverage(y.slice(-5), Math.min(5, y.length));
        const ma10 = movingAverage(y.slice(-10), Math.min(10, y.length));
        const std = standardDeviation(y);
        const mom = y.length > 1 ? y[y.length - 1] - y[y.length - 2] : 0;
        const z = 0.5 * ma5 + 0.3 * ma10 - 0.2 * std + 0.1 * mom - 0.5;
        const prob = 1 / (1 + Math.exp(-z));
        return prob > 0.5 ? 'T' : 'X';
    }

    static randomForestSimple(history, nTrees = 5) {
        if (history.length < 12) return null;
        const votes = [];
        for (let t = 0; t < nTrees; t++) {
            const windows = [5, 8, 10, 12];
            const validWindows = windows.filter(w => history.length >= w);
            if (validWindows.length === 0) continue;
            const w = validWindows[0];
            const tRate = history.slice(-w).filter(c => c === 'T').length / w;
            if (tRate > 0.6) votes.push('X');
            else if (tRate < 0.4) votes.push('T');
            else votes.push(history[history.length - 1]);
        }
        if (votes.length === 0) return null;
        const tCount = votes.filter(v => v === 'T').length;
        return tCount > votes.length - tCount ? 'T' : 'X';
    }

    static adaboostStyle(history) {
        if (history.length < 8) return null;
        const weakLearners = [
            (h) => h.slice(-2).filter(c => c === 'T').length >= 1 ? 'T' : 'X',
            (h) => h.slice(-4).filter(c => c === 'X').length >= 3 ? 'X' : 'T',
            (h) => h[history.length - 5] === 'T' ? 'T' : 'X'
        ];
        const weights = [0.5, 0.3, 0.2];
        let tWeight = 0, xWeight = 0;
        for (let i = 0; i < weakLearners.length; i++) {
            const pred = weakLearners[i](history);
            if (pred === 'T') tWeight += weights[i];
            else xWeight += weights[i];
        }
        return tWeight > xWeight ? 'T' : 'X';
    }

    static lstmMock(history, window = 10) {
        if (history.length < window) return null;
        const seq = history.slice(-window);
        const last3 = seq.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
            return last3[0] === 'T' ? 'X' : 'T';
        }
        let countSame = 0;
        for (let i = 1; i < Math.min(6, seq.length); i++) {
            if (seq[seq.length - i] === seq[seq.length - i - 1]) countSame++;
            else break;
        }
        if (countSame >= 3) return seq[seq.length - 1];
        return seq[seq.length - 1] === 'T' ? 'X' : 'T';
    }

    static transformerMock(history) {
        if (history.length < 12) return null;
        const recent = history.slice(-6);
        const older = history.slice(-12, -6);
        let attention = 0;
        for (let i = 0; i < 6; i++) {
            if (recent[i] === older[i]) attention++;
        }
        attention /= 6;
        if (attention > 0.7) return recent[recent.length - 1];
        if (attention < 0.3) return recent[recent.length - 1] === 'T' ? 'X' : 'T';
        return null;
    }
}

// ================= BREAK SIGNAL DETECTORS (20 signals) =================
class BreakSignalDetector {
    static rsiBreak(history) {
        const pred = UltimateAdvancedAlgo.rsiPredict(history, 7);
        return pred !== null && pred !== history[history.length - 1];
    }
    static bollingerBreak(history) {
        const pred = UltimateAdvancedAlgo.bollingerPredict(history, 10);
        return pred !== null && pred !== history[history.length - 1];
    }
    static macdBreak(history) {
        const pred = UltimateAdvancedAlgo.macdPredict(history, 5, 12, 3);
        return pred !== null && pred !== history[history.length - 1];
    }
    static stochasticBreak(history) {
        const pred = UltimateAdvancedAlgo.stochasticPredict(history, 7);
        return pred !== null && pred !== history[history.length - 1];
    }
    static williamsBreak(history) {
        const pred = UltimateAdvancedAlgo.williamsR(history, 7);
        return pred !== null && pred !== history[history.length - 1];
    }
    static cciBreak(history) {
        const pred = UltimateAdvancedAlgo.cciPredict(history, 10);
        return pred !== null && pred !== history[history.length - 1];
    }
    static adxBreak(history) {
        const pred = UltimateAdvancedAlgo.adxPredict(history, 10);
        return pred !== null && pred !== history[history.length - 1];
    }
    static divergenceBreak(history) {
        if (history.length < 10) return false;
        const nums = history.slice(-10).map(c => c === 'T' ? 1 : 0);
        const priceTrend = nums[nums.length - 1] - nums[0];
        const rsiValues = [];
        for (let i = 6; i < nums.length; i++) {
            const sub = nums.slice(i - 6, i + 1);
            let gains = 0, losses = 0;
            for (let j = 1; j < sub.length; j++) {
                const diff = sub[j] - sub[j - 1];
                if (diff > 0) gains += diff;
                else losses += Math.abs(diff);
            }
            const avgGain = gains / 7;
            const avgLoss = losses / 7;
            let rsi = 50;
            if (avgLoss === 0) rsi = 100;
            else rsi = 100 - (100 / (1 + avgGain / avgLoss));
            rsiValues.push(rsi);
        }
        if (rsiValues.length >= 2) {
            const rsiTrend = rsiValues[rsiValues.length - 1] - rsiValues[0];
            if ((priceTrend > 0 && rsiTrend < 0) || (priceTrend < 0 && rsiTrend > 0)) return true;
        }
        return false;
    }
    static harmonicBreak(history) {
        if (history.length < 8) return false;
        const last8 = history.slice(-8).join('');
        return ["TXTXTXTX", "XTXTXTXT", "TTXXTTXX", "XXTTXXTT"].includes(last8);
    }
    static fibonacciRetracement(history) {
        if (history.length < 10) return false;
        const nums = history.slice(-10).map(c => c === 'T' ? 1 : 0);
        const high = Math.max(...nums);
        const low = Math.min(...nums);
        if (high === low) return false;
        const retrace = (nums[nums.length - 1] - low) / (high - low);
        return [0.382, 0.5, 0.618].some(level => Math.abs(retrace - level) < 0.1);
    }
    static atrBreak(history, period = 10) {
        if (history.length < period + 1) return false;
        const nums = history.map(c => c === 'T' ? 1 : 0);
        const trueRanges = [];
        for (let i = 1; i < nums.length; i++) {
            trueRanges.push(Math.abs(nums[i] - nums[i - 1]));
        }
        if (trueRanges.length < period) return false;
        const atr = movingAverage(trueRanges.slice(-period), period);
        const lastTr = trueRanges[trueRanges.length - 1];
        return lastTr > atr * 1.5;
    }
    static ichimokuBreak(history) {
        if (history.length < 26) return false;
        const nums = history.map(c => c === 'T' ? 1 : 0);
        const tenkan = (Math.max(...nums.slice(-9)) + Math.min(...nums.slice(-9))) / 2;
        const kijun = (Math.max(...nums.slice(-26)) + Math.min(...nums.slice(-26))) / 2;
        const chikou = nums[nums.length - 26] || 0;
        const current = nums[nums.length - 1];
        return (current > tenkan && current > kijun && chikou > kijun) || (current < tenkan && current < kijun && chikou < kijun);
    }
    static momentumDivergence(history) {
        if (history.length < 12) return false;
        const nums = history.slice(-12).map(c => c === 'T' ? 1 : 0);
        const mom3 = [];
        const mom6 = [];
        for (let i = 3; i < nums.length; i++) mom3.push(nums[i] - nums[i - 3]);
        for (let i = 6; i < nums.length; i++) mom6.push(nums[i] - nums[i - 6]);
        if (mom3.length >= 2 && mom6.length >= 2) {
            if ((mom3[mom3.length - 1] > 0 && mom6[mom6.length - 1] < 0) || (mom3[mom3.length - 1] < 0 && mom6[mom6.length - 1] > 0)) return true;
        }
        return false;
    }
    static volumeSpike(history) {
        if (history.length < 10) return false;
        let changes = 0;
        for (let i = 1; i < Math.min(10, history.length); i++) {
            if (history[history.length - i] !== history[history.length - i - 1]) changes++;
        }
        return changes >= 7;
    }
    static patternExhaustion(history) {
        if (history.length < 8) return false;
        const last8 = history.slice(-8).join('');
        return ["TXTXTXTX", "XTXTXTXT", "TTXXTTXX", "XXTTXXTT"].includes(last8);
    }
    static doubleTopBottom(history) {
        if (history.length < 10) return false;
        const nums = history.slice(-10).map(c => c === 'T' ? 1 : 0);
        const peaks = [];
        const troughs = [];
        for (let i = 1; i < nums.length - 1; i++) {
            if (nums[i] > nums[i - 1] && nums[i] > nums[i + 1]) peaks.push(i);
            if (nums[i] < nums[i - 1] && nums[i] < nums[i + 1]) troughs.push(i);
        }
        if (peaks.length >= 2 && Math.abs(nums[peaks[peaks.length - 2]] - nums[peaks[peaks.length - 1]]) < 0.2) return true;
        if (troughs.length >= 2 && Math.abs(nums[troughs[troughs.length - 2]] - nums[troughs[troughs.length - 1]]) < 0.2) return true;
        return false;
    }
    static supportResistanceBreak(history) {
        if (history.length < 15) return false;
        const nums = history.slice(-15).map(c => c === 'T' ? 1 : 0);
        const high = Math.max(...nums);
        const low = Math.min(...nums);
        if (nums[nums.length - 1] > high - 0.2 && nums[nums.length - 2] <= high - 0.2) return true;
        if (nums[nums.length - 1] < low + 0.2 && nums[nums.length - 2] >= low + 0.2) return true;
        return false;
    }
    static elliottWaveBreak(history) {
        if (history.length < 13) return false;
        const nums = history.slice(-13).map(c => c === 'T' ? 1 : 0);
        const diff = [];
        for (let i = 1; i < nums.length; i++) diff.push(nums[i] - nums[i - 1]);
        let signChanges = 0;
        for (let i = 1; i < diff.length; i++) {
            if (diff[i] * diff[i - 1] < 0) signChanges++;
        }
        return signChanges >= 3;
    }
    static gannBreak(history) {
        if (history.length < 12) return false;
        const nums = history.slice(-12).map(c => c === 'T' ? 1 : 0);
        let increasing = true, decreasing = true;
        for (let i = 0; i < nums.length - 1; i++) {
            if (nums[i] > nums[i + 1]) increasing = false;
            if (nums[i] < nums[i + 1]) decreasing = false;
        }
        if (increasing && (nums[nums.length - 1] - nums[0]) / 11 > 0.05) return true;
        if (decreasing && (nums[0] - nums[nums.length - 1]) / 11 > 0.05) return true;
        return false;
    }
}

// ================= SUPER VIP DECISION =================
class SuperVipDecision {
    constructor(history, totals, gameId) {
        this.history = history.split('');
        this.totals = totals;
        this.gameId = gameId;
        this.breakSignals = 0;
        
        this.detectors = [
            UltimatePatternDetector.detectBet,
            UltimatePatternDetector.detect11,
            UltimatePatternDetector.detect22,
            UltimatePatternDetector.detect33,
            UltimatePatternDetector.detect12,
            UltimatePatternDetector.detect21,
            UltimatePatternDetector.detect123,
            UltimatePatternDetector.detect321,
            UltimatePatternDetector.detectTriangle,
            UltimatePatternDetector.detectPhaseShift,
            UltimatePatternDetector.detectArithmetic,
            UltimatePatternDetector.detectFibonacci,
            UltimatePatternDetector.detectRegressionBreak,
            (h) => UltimatePatternDetector.detectCycle(h, 2, 6),
            UltimatePatternDetector.detectTrend,
            UltimatePatternDetector.detectBalanceBreak,
            UltimatePatternDetector.detectBetReverse,
            UltimatePatternDetector.detect11Reverse,
            UltimatePatternDetector.detect22Reverse,
            UltimatePatternDetector.detect33Reverse,
            UltimatePatternDetector.detectDragon,
            UltimatePatternDetector.detectTiger,
            (h) => UltimatePatternDetector.detectEvenOdd(h, this.totals),
            (h) => UltimatePatternDetector.detectTotalBet(h, this.totals),
            UltimatePatternDetector.detectChain,
            UltimatePatternDetector.detect44,
            UltimatePatternDetector.detect55,
            UltimatePatternDetector.detectZigzag,
            UltimatePatternDetector.detectDouble12,
            UltimatePatternDetector.detectPyramid,
            UltimatePatternDetector.detectGap,
            UltimatePatternDetector.detectMomentum,
            UltimatePatternDetector.detectAlternatingShort,
            UltimatePatternDetector.detectFourCycle
        ];
        
        this.algos = [
            { name: 'Markov1', func: UltimateAdvancedAlgo.markov1 },
            { name: 'Markov2', func: UltimateAdvancedAlgo.markov2 },
            { name: 'Markov3', func: UltimateAdvancedAlgo.markov3 },
            { name: 'Markov4', func: UltimateAdvancedAlgo.markov4 },
            { name: 'Markov5', func: UltimateAdvancedAlgo.markov5 },
            { name: 'WeightedFreq', func: UltimateAdvancedAlgo.weightedFrequency },
            { name: 'SimpleMajority', func: UltimateAdvancedAlgo.simpleMajority },
            { name: 'MovingAvg', func: UltimateAdvancedAlgo.movingAverageCross },
            { name: 'Entropy', func: UltimateAdvancedAlgo.entropyPrediction },
            { name: 'Fibonacci', func: UltimateAdvancedAlgo.fibonacciFractal },
            { name: 'Cumulative', func: UltimateAdvancedAlgo.cumulativeImbalance },
            { name: 'Zigzag', func: UltimateAdvancedAlgo.zigzagPredict },
            { name: 'RSI', func: UltimateAdvancedAlgo.rsiPredict },
            { name: 'Bollinger', func: UltimateAdvancedAlgo.bollingerPredict },
            { name: 'MACD', func: UltimateAdvancedAlgo.macdPredict },
            { name: 'Stochastic', func: UltimateAdvancedAlgo.stochasticPredict },
            { name: 'Williams%R', func: UltimateAdvancedAlgo.williamsR },
            { name: 'CCI', func: UltimateAdvancedAlgo.cciPredict },
            { name: 'ADX', func: UltimateAdvancedAlgo.adxPredict },
            { name: 'MeanReversion', func: UltimateAdvancedAlgo.meanReversion },
            { name: 'PatternMatch', func: UltimateAdvancedAlgo.patternMatching },
            { name: 'LinearReg', func: UltimateAdvancedAlgo.linearRegression },
            { name: 'KNN', func: UltimateAdvancedAlgo.knnPredict },
            { name: 'NaiveBayes', func: UltimateAdvancedAlgo.naiveBayes },
            { name: 'DecisionTree', func: UltimateAdvancedAlgo.decisionTree },
            { name: 'Ensemble', func: UltimateAdvancedAlgo.ensembleVoting },
            { name: 'RL', func: (h) => UltimateAdvancedAlgo.reinforcementLearning(h, this.gameId) },
            { name: 'Logistic', func: UltimateAdvancedAlgo.logisticRegression },
            { name: 'RandomForest', func: UltimateAdvancedAlgo.randomForestSimple },
            { name: 'AdaBoost', func: UltimateAdvancedAlgo.adaboostStyle },
            { name: 'LSTM', func: UltimateAdvancedAlgo.lstmMock },
            { name: 'Transformer', func: UltimateAdvancedAlgo.transformerMock }
        ];
        
        this.breakDetectors = [
            BreakSignalDetector.rsiBreak,
            BreakSignalDetector.bollingerBreak,
            BreakSignalDetector.macdBreak,
            BreakSignalDetector.stochasticBreak,
            BreakSignalDetector.williamsBreak,
            BreakSignalDetector.cciBreak,
            BreakSignalDetector.adxBreak,
            BreakSignalDetector.divergenceBreak,
            BreakSignalDetector.harmonicBreak,
            BreakSignalDetector.fibonacciRetracement,
            BreakSignalDetector.atrBreak,
            BreakSignalDetector.ichimokuBreak,
            BreakSignalDetector.momentumDivergence,
            BreakSignalDetector.volumeSpike,
            BreakSignalDetector.patternExhaustion,
            BreakSignalDetector.doubleTopBottom,
            BreakSignalDetector.supportResistanceBreak,
            BreakSignalDetector.elliottWaveBreak,
            BreakSignalDetector.gannBreak
        ];
    }
    
    checkBreakSignals() {
        let count = 0;
        for (const det of this.breakDetectors) {
            if (det(this.history)) count++;
        }
        this.breakSignals = count;
        return count;
    }
    
    analyze() {
        const breakCount = this.checkBreakSignals();
        const shouldBreak = breakCount >= 3;
        
        const votes = []; // { name, prediction, weight, isAlgo }
        
        // Pattern detectors
        for (const det of this.detectors) {
            try {
                const res = det(this.history);
                if (res) {
                    votes.push({ name: res.name, prediction: res.next, weight: res.weight || res.confidence, isAlgo: false });
                }
            } catch (e) {}
        }
        
        // Algorithms
        for (const algo of this.algos) {
            try {
                const pred = algo.func(this.history);
                if (pred) {
                    let weight = selfLearning.getWeight(algo.name, this.gameId);
                    if (shouldBreak && pred !== this.history[this.history.length - 1]) {
                        weight += 10;
                    }
                    votes.push({ name: algo.name, prediction: pred, weight: weight, isAlgo: true });
                }
            } catch (e) {}
        }
        
        if (votes.length === 0) {
            const last5 = this.history.slice(-5);
            const fb = last5.filter(c => c === 'T').length >= last5.filter(c => c === 'X').length ? 'T' : 'X';
            return { final: fb, confidence: 50, pattern: "Fallback", details: {} };
        }
        
        let wT = 0, wX = 0;
        for (const v of votes) {
            if (v.prediction === 'T') wT += v.weight;
            else wX += v.weight;
        }
        
        let final = wT > wX ? 'T' : 'X';
        let confBoost = 0;
        
        if (shouldBreak) {
            if (wT > wX) final = 'X';
            else final = 'T';
            confBoost = Math.min(25, breakCount * 5);
        }
        
        const total = wT + wX;
        let conf = total > 0 ? Math.round(Math.max(wT, wX) / total * 100) : 50;
        conf = Math.min(99, conf + confBoost);
        
        const bestPattern = votes.filter(v => !v.isAlgo).sort((a, b) => b.weight - a.weight)[0];
        let pattern = bestPattern ? bestPattern.name : "Không xác định";
        if (shouldBreak) pattern = `🔥 BẺ CẦU (${breakCount} tín hiệu) - ${pattern}`;
        
        return { final, confidence: conf, pattern, details: {} };
    }
}

// ================= AUTO PING =================
async function pingAllApis() {
    while (true) {
        for (const gameId of Object.keys(GAME_CONFIG)) {
            try {
                await fetchAndCache(gameId);
                console.log(`[${new Date().toISOString()}] Ping ${gameId} thành công`);
            } catch (e) {
                console.error(`[${new Date().toISOString()}] Lỗi ping ${gameId}:`, e.message);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

// ================= CREATE ENDPOINTS =================
function createEndpoint(gameId) {
    return async (req, res) => {
        const key = req.query.key;
        if (key !== AUTH_KEY) {
            return res.status(403).json({ error: "Truy cập bị từ chối." });
        }
        
        const config = GAME_CONFIG[gameId];
        if (!config) {
            return res.status(400).json({ error: "Game không hợp lệ." });
        }
        
        let data = await getCachedData(gameId);
        if (!data) {
            data = await fetchData(config.api_url);
            if (!data) {
                return res.status(500).json({ error: "Không thể lấy dữ liệu." });
            }
        }
        
        const { history, totals } = buildHistory(data, config.type);
        if (!history) {
            return res.status(500).json({ error: "Không có lịch sử." });
        }
        
        const items = data.list || data;
        const currentItem = items[0];
        const { result, point, dices, sessionId } = parseSession(currentItem, config.type);
        
        // Update actual history
        if (result) {
            if (!actualHistory[gameId]) actualHistory[gameId] = [];
            actualHistory[gameId].push(result);
            if (actualHistory[gameId].length > 100) actualHistory[gameId].shift();
        }
        
        const dec = new SuperVipDecision(history, totals, gameId);
        const { final, confidence, pattern } = dec.analyze();
        
        const taiPercent = final === 'T' ? confidence : 100 - confidence;
        const xiuPercent = 100 - taiPercent;
        
        const response = {
            phien: sessionId,
            xuc_xac: dices,
            tong: point,
            ket_qua: result === 'T' ? "Tài" : result === 'X' ? "Xỉu" : "?",
            phien_hien_tai: sessionId ? sessionId + 1 : "?",
            du_doan: final === 'T' ? "Tài" : "Xỉu",
            do_tin_cay: `${taiPercent}%-${xiuPercent}%`,
            id: USER_ID,
            ai_model: ALGO_NAME,
            self_learning: "Active"
        };
        
        res.json(response);
    };
}

// ================= START SERVER =================
app.use(express.json());

for (const gameId of Object.keys(GAME_CONFIG)) {
    app.get(`/api/${gameId}`, createEndpoint(gameId));
}

app.get('/api/health', (req, res) => {
    res.json({ status: "healthy", games: Object.keys(GAME_CONFIG).length });
});

app.get('/', (req, res) => {
    res.json({
        service: ALGO_NAME,
        endpoints: Object.keys(GAME_CONFIG).map(id => `/api/${id}`),
        auth: "?key=apihdx"
    });
});

// Start auto ping
pingAllApis();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server SIÊU VIP v10.0 (AI Self-Learning) đang chạy...`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔑 Auth Key: ${AUTH_KEY}`);
    console.log(`👤 User ID: ${USER_ID}`);
    console.log(`🎮 Games: ${Object.keys(GAME_CONFIG).length} games`);
    console.log(`=========================================`);
});
