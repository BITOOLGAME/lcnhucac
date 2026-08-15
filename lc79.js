const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const MAX_HISTORY = 50;
const MAX_PATTERN_LENGTH = 12;
const CACHE_MS = 3000;

let cache = {
    time: 0,
    history: [],
    prediction: null
};

const learning = new Map();

function tx(result) {
    return result === "Tài" ? "T" : "X";
}

function result(txValue) {
    return txValue === "T" ? "Tài" : "Xỉu";
}

function invert(pattern) {
    return pattern.split("").map(v => v === "T" ? "X" : "T").join("");
}

async function fetchHistory() {
    const response = await fetch(SOURCE_API, {
        headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
        }
    });

    if (!response.ok) {
        throw new Error(`Source API HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.list)) {
        throw new Error("Source API không trả về list");
    }

    return data.list
        .map(item => ({
            phien: Number(item.id),
            xuc_xac: Array.isArray(item.dices) ? item.dices.map(Number) : [],
            tong: Number(item.point),
            ket_qua: String(item.resultTruyenThong).toUpperCase() === "TAI" ? "Tài" : "Xỉu"
        }))
        .filter(item =>
            Number.isFinite(item.phien) &&
            item.xuc_xac.length === 3 &&
            item.xuc_xac.every(Number.isFinite) &&
            Number.isFinite(item.tong)
        )
        .sort((a, b) => a.phien - b.phien)
        .slice(-MAX_HISTORY);
}

function getLearning(pattern) {
    if (!learning.has(pattern)) {
        learning.set(pattern, {
            total: 0,
            win: 0,
            lose: 0,
            weight: 1
        });
    }
    return learning.get(pattern);
}

function getWinRate(pattern) {
    const data = learning.get(pattern);
    if (!data || data.total === 0) return 50;
    return ((data.win + 1) / (data.total + 2)) * 100;
}

function lengthWeight(length) {
    if (length >= 12) return 3;
    if (length >= 10) return 2.7;
    if (length >= 8) return 2.4;
    if (length >= 7) return 2.2;
    if (length >= 6) return 2;
    if (length >= 5) return 1.8;
    if (length >= 4) return 1.5;
    return 1.2;
}

function analyzePattern(history, pattern) {
    const values = history.map(v => tx(v.ket_qua));
    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (let i = 0; i + pattern.length < values.length; i++) {
        const current = values.slice(i, i + pattern.length).join("");
        if (current !== pattern) continue;

        total++;

        if (values[i + pattern.length] === "T") tai++;
        else xiu++;
    }

    if (!total) return null;

    return {
        pattern,
        total,
        tai,
        xiu,
        pT: tai / total,
        pX: xiu / total
    };
}

function getCurrentPatterns(history) {
    const values = history.map(v => tx(v.ket_qua));
    const output = [];

    const maxLength = Math.min(MAX_PATTERN_LENGTH, values.length - 1);

    for (let length = 2; length <= maxLength; length++) {
        const pattern = values.slice(-length).join("");
        const reversed = invert(pattern);

        const main = analyzePattern(history, pattern);
        const reverse = analyzePattern(history, reversed);

        if (main && main.total >= 2) {
            output.push({
                ...main,
                mode: "chinh"
            });
        }

        if (reverse && reverse.total >= 2 && reversed !== pattern) {
            output.push({
                ...reverse,
                mode: "dao"
            });
        }
    }

    return output;
}

function analyzeMarkov(history) {
    const values = history.map(v => tx(v.ket_qua));
    if (values.length < 5) return null;

    const current = values[values.length - 1];
    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (let i = 0; i < values.length - 1; i++) {
        if (values[i] !== current) continue;

        total++;

        if (values[i + 1] === "T") tai++;
        else xiu++;
    }

    if (!total) return null;

    return {
        total,
        pT: tai / total,
        pX: xiu / total
    };
}

function analyzeStreak(history) {
    const values = history.map(v => tx(v.ket_qua));
    if (!values.length) return null;

    const last = values[values.length - 1];
    let count = 1;

    for (let i = values.length - 2; i >= 0; i--) {
        if (values[i] !== last) break;
        count++;
    }

    return {
        side: last,
        length: count
    };
}

function analyzeRuns(history) {
    const values = history.map(v => tx(v.ket_qua));
    const runs = [];

    if (!values.length) return runs;

    let side = values[0];
    let count = 1;

    for (let i = 1; i < values.length; i++) {
        if (values[i] === side) {
            count++;
        } else {
            runs.push({ side, count });
            side = values[i];
            count = 1;
        }
    }

    runs.push({ side, count });
    return runs;
}

function specialPatterns(history) {
    const values = history.map(v => tx(v.ket_qua));
    const output = [];

    if (values.length < 4) return output;

    const p4 = values.slice(-4).join("");
    const p5 = values.slice(-5).join("");
    const p6 = values.slice(-6).join("");
    const p7 = values.slice(-7).join("");
    const p8 = values.slice(-8).join("");
    const p10 = values.slice(-10).join("");
    const p12 = values.slice(-12).join("");

    const opposite = values[values.length - 1] === "T" ? "X" : "T";

    const add = (type, prediction, strength) => {
        output.push({ type, prediction, strength });
    };

    // 1-1
    if (p6 === "TXTXTX" || p6 === "XTXTXT") {
        add("1-1", opposite, 0.89);
    }

    // 1-2-1
    if (p4 === "TXXT" || p4 === "XTTX") {
        add("1-2-1", opposite, 0.82);
    }

    // 2-1-2
    if (p5 === "TTXTT" || p5 === "XXTXX") {
        add("2-1-2", opposite, 0.82);
    }

    // 2-2
    if (p8 === "TTXXTTXX" || p8 === "XXTTXXTT") {
        add("2-2", opposite, 0.86);
    }

    // 3-3
    if (p6 === "TTTXXX" || p6 === "XXXTTT") {
        add("3-3", opposite, 0.84);
    }

    // 3-2
    if (p5 === "TTTXX" || p5 === "XXXTT") {
        add("3-2", opposite, 0.77);
    }

    // 2-3
    if (p5 === "TTXXX" || p5 === "XXTTT") {
        add("2-3", opposite, 0.77);
    }

    // 4-1
    if (p5 === "TTTTX" || p5 === "XXXXT") {
        add("4-1", opposite, 0.76);
    }

    // 1-4
    if (p5 === "XTTTT" || p5 === "TXXXX") {
        add("1-4", opposite, 0.76);
    }

    // 4-2
    if (p6 === "TTTTXX" || p6 === "XXXXTT") {
        add("4-2", opposite, 0.75);
    }

    // 2-4
    if (p6 === "TTXXXX" || p6 === "XXTTTT") {
        add("2-4", opposite, 0.75);
    }

    // 5-1
    if (p6 === "TTTTTX" || p6 === "XXXXXT") {
        add("5-1", opposite, 0.72);
    }

    // 1-5
    if (p6 === "XTTTTT" || p6 === "TXXXXX") {
        add("1-5", opposite, 0.72);
    }

    // 2-1 lặp
    if (p6 === "TTXTTX" || p6 === "XXTXXT") {
        add("2-1", opposite, 0.81);
    }

    // 1-2 lặp
    if (p6 === "TXXTXX" || p6 === "XTTXTT") {
        add("1-2", opposite, 0.81);
    }

    // 1-3-1
    if (p5 === "XTTTX" || p5 === "TXXXT") {
        add("1-3-1", opposite, 0.80);
    }

    // 3-1-3
    if (p7 === "TTTXTTT" || p7 === "XXX TXXX".replaceAll(" ", "")) {
        add("3-1-3", opposite, 0.78);
    }

    // Cầu đảo
    if (/^(TX)+T?$/.test(p8) || /^(XT)+X?$/.test(p8)) {
        add("dao", opposite, 0.85);
    }

    // Chu kỳ 2
    if (
        p8[0] === p8[2] &&
        p8[0] === p8[4] &&
        p8[0] === p8[6] &&
        p8[1] === p8[3] &&
        p8[1] === p8[5] &&
        p8[1] === p8[7]
    ) {
        add("chu-ky-2", p8[0], 0.80);
    }

    // Chu kỳ 3
    if (p6.slice(0, 3) === p6.slice(3)) {
        add("chu-ky-3", p6[0], 0.78);
    }

    // Chu kỳ 4
    if (p8.slice(0, 4) === p8.slice(4)) {
        add("chu-ky-4", p8[0], 0.79);
    }

    // Đối xứng
    if (p8 === p8.split("").reverse().join("")) {
        add("doi-xung", opposite, 0.80);
    }

    // Cầu gãy
    if (
        p6 === "TTTXXT" ||
        p6 === "XXXTTX" ||
        p6 === "TTXXXT" ||
        p6 === "XXTTTX"
    ) {
        add("cau-gay", values[values.length - 1], 0.70);
    }

    // Pattern dài đặc biệt
    if (p12 === "TXTTXTXTTXTX") {
        add("special-12-A", "T", 0.90);
    }

    if (p12 === "XTTXTXTTXTTX") {
        add("special-12-B", "X", 0.90);
    }

    // Cầu tăng
    if (p10 === "TXXTTXXXTT") {
        add("cau-tang", "T", 0.72);
    }

    // Cầu giảm
    if (p10 === "TTTXXXTTXX") {
        add("cau-giam", "X", 0.72);
    }

    return output;
}

function calculatePrediction(history) {
    const score = {
        T: 0,
        X: 0
    };

    const evidence = [];

    // Pattern chính + đảo
    for (const item of getCurrentPatterns(history)) {
        const winRate = getWinRate(item.pattern);
        const lengthFactor = lengthWeight(item.pattern.length);
        const occurrenceFactor = Math.min(2.5, Math.log2(item.total + 1));
        const learningFactor = 0.5 + winRate / 100;
        const modeFactor = item.mode === "chinh" ? 1 : 0.85;

        const weight =
            lengthFactor *
            occurrenceFactor *
            learningFactor *
            modeFactor;

        score.T += item.pT * weight;
        score.X += item.pX * weight;

        evidence.push({
            type: "pattern",
            pattern: item.pattern,
            mode: item.mode,
            total: item.total,
            tai: Number((item.pT * 100).toFixed(2)),
            xiu: Number((item.pX * 100).toFixed(2)),
            win_rate: Number(winRate.toFixed(2)),
            weight: Number(weight.toFixed(3))
        });
    }

    // Markov
    const mk = analyzeMarkov(history);

    if (mk) {
        score.T += mk.pT * 3;
        score.X += mk.pX * 3;

        evidence.push({
            type: "markov",
            total: mk.total,
            tai: Number((mk.pT * 100).toFixed(2)),
            xiu: Number((mk.pX * 100).toFixed(2))
        });
    }

    // Streak
    const st = analyzeStreak(history);

    if (st) {
        let weight = 0.7;

        if (st.length >= 3) weight = 1.5;
        if (st.length >= 4) weight = 2;
        if (st.length >= 5) weight = 2.4;

        score[st.side] += weight;

        evidence.push({
            type: "streak",
            result: result(st.side),
            length: st.length,
            weight
        });
    }

    // Các cầu đặc biệt
    for (const item of specialPatterns(history)) {
        score[item.prediction] += item.strength * 3;

        evidence.push({
            type: item.type,
            prediction: result(item.prediction),
            strength: item.strength
        });
    }

    const totalScore = score.T + score.X;

    if (totalScore <= 0) {
        return {
            du_doan: "Không rõ cầu",
            do_tin_cay: "0.00%",
            rawConfidence: 0,
            score,
            evidence
        };
    }

    const prediction = score.T >= score.X ? "T" : "X";

    let confidence =
        (Math.max(score.T, score.X) / totalScore) * 100;

    confidence = Math.min(98, Math.max(50, confidence));
    confidence = Number(confidence.toFixed(2));

    return {
        du_doan: result(prediction),
        do_tin_cay: `${confidence.toFixed(2)}%`,
        rawConfidence: confidence,
        score: {
            tai: Number(score.T.toFixed(4)),
            xiu: Number(score.X.toFixed(4))
        },
        evidence
    };
}

async function getData() {
    const now = Date.now();

    if (
        cache.prediction &&
        now - cache.time < CACHE_MS
    ) {
        return cache;
    }

    const history = await fetchHistory();

    if (!history.length) {
        throw new Error("Không lấy được lịch sử");
    }

    const prediction = calculatePrediction(history);

    cache = {
        time: now,
        history,
        prediction
    };

    return cache;
}

// =====================================================
// API CHÍNH
// =====================================================

app.get("/api/taixiumd5", async (req, res) => {
    try {
        const { history, prediction } = await getData();
        const latest = history[history.length - 1];

        res.json({
            phien: latest.phien,
            xuc_xac: latest.xuc_xac,
            tong: latest.tong,
            ket_qua: latest.ket_qua,
            phien_hien_tai: latest.phien + 1,
            du_doan: prediction.du_doan,
            do_tin_cay: prediction.do_tin_cay
        });
    } catch (error) {
        console.error("API ERROR:", error.message);

        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================================
// API CHI TIẾT
// =====================================================

app.get("/api/taixiumd5/detail", async (req, res) => {
    try {
        const { history, prediction } = await getData();
        const latest = history[history.length - 1];

        res.json({
            phien: latest.phien,
            xuc_xac: latest.xuc_xac,
            tong: latest.tong,
            ket_qua: latest.ket_qua,
            phien_hien_tai: latest.phien + 1,
            du_doan: prediction.du_doan,
            do_tin_cay: prediction.do_tin_cay,
            diem: prediction.score,
            so_cau: prediction.evidence.length,
            phan_tich: prediction.evidence,
            history
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================================
// API HEALTH
// =====================================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        name: "TAI XIU MD5 API",
        endpoint: "/api/taixiumd5",
        detail: "/api/taixiumd5/detail"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`TAI XIU MD5 API running on port ${PORT}`);
});
