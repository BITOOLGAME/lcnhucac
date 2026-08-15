const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const MAX_SOURCE_HISTORY = 50;
const MAX_PATTERN_HISTORY = 20;
const MAX_ANALYZE_PATTERN = 12;
const CACHE_MS = 3000;

let cache = {
    time: 0,
    history: [],
    prediction: null,
    pattern: ""
};

// ============================================================
// BASIC
// ============================================================

function tx(result) {
    return result === "Tài" ? "T" : "X";
}

function result(value) {
    return value === "T" ? "Tài" : "Xỉu";
}

function opposite(value) {
    return value === "T" ? "X" : "T";
}

function invertPattern(pattern) {
    return pattern
        .split("")
        .map(v => v === "T" ? "X" : "T")
        .join("");
}

// ============================================================
// FETCH SOURCE
// ============================================================

async function fetchHistory() {
    const response = await fetch(SOURCE_API, {
        headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
        }
    });

    if (!response.ok) {
        throw new Error(
            `Source API HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.list)) {
        throw new Error(
            "Source API không có list"
        );
    }

    return data.list
        .map(item => ({
            phien: Number(item.id),

            xuc_xac: Array.isArray(item.dices)
                ? item.dices.map(Number)
                : [],

            tong: Number(item.point),

            ket_qua:
                String(item.resultTruyenThong)
                    .toUpperCase() === "TAI"
                    ? "Tài"
                    : "Xỉu"
        }))
        .filter(item =>
            Number.isFinite(item.phien) &&
            item.xuc_xac.length === 3 &&
            item.xuc_xac.every(Number.isFinite) &&
            Number.isFinite(item.tong)
        )
        .sort((a, b) => a.phien - b.phien)
        .slice(-MAX_SOURCE_HISTORY);
}

// ============================================================
// PATTERN 20 PHIÊN
// CŨ BÊN TRÁI - MỚI BÊN PHẢI
// ============================================================

function buildPattern(history) {
    return history
        .slice(-MAX_PATTERN_HISTORY)
        .map(item => tx(item.ket_qua))
        .join("");
}

// ============================================================
// WEIGHT THEO ĐỘ DÀI PATTERN
// ============================================================

function patternLengthWeight(length) {
    if (length >= 12) return 3.2;
    if (length === 11) return 3.0;
    if (length === 10) return 2.8;
    if (length === 9) return 2.6;
    if (length === 8) return 2.4;
    if (length === 7) return 2.2;
    if (length === 6) return 2.0;
    if (length === 5) return 1.8;
    if (length === 4) return 1.5;
    if (length === 3) return 1.25;

    return 1;
}

// ============================================================
// PATTERN MATCHING
// ============================================================

function analyzePattern(history, pattern) {
    const values = history.map(
        item => tx(item.ket_qua)
    );

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i + pattern.length < values.length;
        i++
    ) {
        const current =
            values
                .slice(i, i + pattern.length)
                .join("");

        if (current !== pattern) {
            continue;
        }

        total++;

        const next =
            values[i + pattern.length];

        if (next === "T") {
            tai++;
        } else {
            xiu++;
        }
    }

    if (total === 0) {
        return null;
    }

    return {
        pattern,
        total,
        tai,
        xiu,

        pT: tai / total,
        pX: xiu / total
    };
}

// ============================================================
// PHÂN TÍCH PATTERN HIỆN TẠI
// ============================================================

function getCurrentPatterns(history) {
    const values = history.map(
        item => tx(item.ket_qua)
    );

    const output = [];

    const maxLength = Math.min(
        MAX_ANALYZE_PATTERN,
        values.length - 1
    );

    for (
        let length = 2;
        length <= maxLength;
        length++
    ) {
        const pattern =
            values
                .slice(-length)
                .join("");

        const reverse =
            invertPattern(pattern);

        const main =
            analyzePattern(
                history,
                pattern
            );

        if (
            main &&
            main.total >= 2
        ) {
            output.push({
                ...main,
                mode: "chinh"
            });
        }

        const inverse =
            analyzePattern(
                history,
                reverse
            );

        if (
            inverse &&
            inverse.total >= 2 &&
            reverse !== pattern
        ) {
            output.push({
                ...inverse,
                mode: "dao"
            });
        }
    }

    return output;
}

// ============================================================
// MARKOV
// ============================================================

function analyzeMarkov(history) {
    const values = history.map(
        item => tx(item.ket_qua)
    );

    if (values.length < 5) {
        return null;
    }

    const current =
        values[values.length - 1];

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < values.length - 1;
        i++
    ) {
        if (values[i] !== current) {
            continue;
        }

        total++;

        if (values[i + 1] === "T") {
            tai++;
        } else {
            xiu++;
        }
    }

    if (!total) {
        return null;
    }

    return {
        total,
        tai,
        xiu,

        pT: tai / total,
        pX: xiu / total
    };
}

// ============================================================
// STREAK
// ============================================================

function analyzeStreak(history) {
    const values = history.map(
        item => tx(item.ket_qua)
    );

    if (!values.length) {
        return null;
    }

    const last =
        values[values.length - 1];

    let count = 1;

    for (
        let i = values.length - 2;
        i >= 0;
        i--
    ) {
        if (values[i] !== last) {
            break;
        }

        count++;
    }

    return {
        side: last,
        length: count
    };
}

// ============================================================
// CÁC CẦU ĐẶC BIỆT
// ============================================================

function analyzeSpecialPatterns(history) {
    const values = history.map(
        item => tx(item.ket_qua)
    );

    const output = [];

    if (values.length < 4) {
        return output;
    }

    const p4 =
        values.slice(-4).join("");

    const p5 =
        values.slice(-5).join("");

    const p6 =
        values.slice(-6).join("");

    const p7 =
        values.slice(-7).join("");

    const p8 =
        values.slice(-8).join("");

    const p10 =
        values.slice(-10).join("");

    const p12 =
        values.slice(-12).join("");

    const last =
        values[values.length - 1];

    const next =
        opposite(last);

    function add(
        type,
        prediction,
        strength
    ) {
        output.push({
            type,
            prediction,
            strength
        });
    }

    // --------------------------------------------------------
    // 1-1
    // --------------------------------------------------------

    if (
        p6 === "TXTXTX" ||
        p6 === "XTXTXT"
    ) {
        add(
            "1-1",
            next,
            0.89
        );
    }

    // --------------------------------------------------------
    // 2-2
    // --------------------------------------------------------

    if (
        p8 === "TTXXTTXX" ||
        p8 === "XXTTXXTT"
    ) {
        add(
            "2-2",
            next,
            0.86
        );
    }

    // --------------------------------------------------------
    // 3-3
    // --------------------------------------------------------

    if (
        p6 === "TTTXXX" ||
        p6 === "XXXTTT"
    ) {
        add(
            "3-3",
            next,
            0.84
        );
    }

    // --------------------------------------------------------
    // 1-2-1
    // --------------------------------------------------------

    if (
        p4 === "TXXT" ||
        p4 === "XTTX"
    ) {
        add(
            "1-2-1",
            next,
            0.82
        );
    }

    // --------------------------------------------------------
    // 2-1-2
    // --------------------------------------------------------

    if (
        p5 === "TTXTT" ||
        p5 === "XXTXX"
    ) {
        add(
            "2-1-2",
            next,
            0.82
        );
    }

    // --------------------------------------------------------
    // 1-3-1
    // --------------------------------------------------------

    if (
        p5 === "XTTTX" ||
        p5 === "TXXXT"
    ) {
        add(
            "1-3-1",
            next,
            0.80
        );
    }

    // --------------------------------------------------------
    // 3-1-3
    // --------------------------------------------------------

    if (
        p7 === "TTTXTTT" ||
        p7 === "XXX TXXX".replaceAll(" ", "")
    ) {
        add(
            "3-1-3",
            next,
            0.78
        );
    }

    // --------------------------------------------------------
    // 1-2
    // --------------------------------------------------------

    if (
        p6 === "TXXTXX" ||
        p6 === "XTTXTT"
    ) {
        add(
            "1-2",
            next,
            0.81
        );
    }

    // --------------------------------------------------------
    // 2-1
    // --------------------------------------------------------

    if (
        p6 === "TTXTTX" ||
        p6 === "XXTXXT"
    ) {
        add(
            "2-1",
            next,
            0.81
        );
    }

    // --------------------------------------------------------
    // 3-2
    // --------------------------------------------------------

    if (
        p5 === "TTTXX" ||
        p5 === "XXXTT"
    ) {
        add(
            "3-2",
            next,
            0.77
        );
    }

    // --------------------------------------------------------
    // 2-3
    // --------------------------------------------------------

    if (
        p5 === "TTXXX" ||
        p5 === "XXTTT"
    ) {
        add(
            "2-3",
            next,
            0.77
        );
    }

    // --------------------------------------------------------
    // 4-1
    // --------------------------------------------------------

    if (
        p5 === "TTTTX" ||
        p5 === "XXXXT"
    ) {
        add(
            "4-1",
            next,
            0.76
        );
    }

    // --------------------------------------------------------
    // 1-4
    // --------------------------------------------------------

    if (
        p5 === "XTTTT" ||
        p5 === "TXXXX"
    ) {
        add(
            "1-4",
            next,
            0.76
        );
    }

    // --------------------------------------------------------
    // 4-2
    // --------------------------------------------------------

    if (
        p6 === "TTTTXX" ||
        p6 === "XXXXTT"
    ) {
        add(
            "4-2",
            next,
            0.75
        );
    }

    // --------------------------------------------------------
    // 2-4
    // --------------------------------------------------------

    if (
        p6 === "TTXXXX" ||
        p6 === "XXTTTT"
    ) {
        add(
            "2-4",
            next,
            0.75
        );
    }

    // --------------------------------------------------------
    // 5-1
    // --------------------------------------------------------

    if (
        p6 === "TTTTTX" ||
        p6 === "XXXXXT"
    ) {
        add(
            "5-1",
            next,
            0.72
        );
    }

    // --------------------------------------------------------
    // 1-5
    // --------------------------------------------------------

    if (
        p6 === "XTTTTT" ||
        p6 === "TXXXXX"
    ) {
        add(
            "1-5",
            next,
            0.72
        );
    }

    // --------------------------------------------------------
    // CẦU ĐẢO
    // --------------------------------------------------------

    if (
        /^(TX)+T?$/.test(p8) ||
        /^(XT)+X?$/.test(p8)
    ) {
        add(
            "dao",
            next,
            0.85
        );
    }

    // --------------------------------------------------------
    // CHU KỲ 2
    // --------------------------------------------------------

    if (
        p8[0] === p8[2] &&
        p8[0] === p8[4] &&
        p8[0] === p8[6] &&
        p8[1] === p8[3] &&
        p8[1] === p8[5] &&
        p8[1] === p8[7]
    ) {
        add(
            "chu-ky-2",
            p8[0],
            0.80
        );
    }

    // --------------------------------------------------------
    // CHU KỲ 3
    // --------------------------------------------------------

    if (
        p6.slice(0, 3) ===
        p6.slice(3)
    ) {
        add(
            "chu-ky-3",
            p6[0],
            0.78
        );
    }

    // --------------------------------------------------------
    // CHU KỲ 4
    // --------------------------------------------------------

    if (
        p8.slice(0, 4) ===
        p8.slice(4)
    ) {
        add(
            "chu-ky-4",
            p8[0],
            0.79
        );
    }

    // --------------------------------------------------------
    // LẶP 4
    // --------------------------------------------------------

    if (
        p8.slice(0, 4) ===
        p8.slice(4)
    ) {
        add(
            "lap-4",
            p8[0],
            0.79
        );
    }

    // --------------------------------------------------------
    // ĐỐI XỨNG
    // --------------------------------------------------------

    if (
        p8 ===
        p8.split("").reverse().join("")
    ) {
        add(
            "doi-xung",
            next,
            0.80
        );
    }

    // --------------------------------------------------------
    // CẦU GÃY
    // --------------------------------------------------------

    if (
        p6 === "TTTXXT" ||
        p6 === "XXXTTX" ||
        p6 === "TTXXXT" ||
        p6 === "XXTTTX"
    ) {
        add(
            "cau-gay",
            last,
            0.70
        );
    }

    // --------------------------------------------------------
    // CẦU 6-1
    // --------------------------------------------------------

    if (
        p7 === "TTTTTTX" ||
        p7 === "XXXXXXT"
    ) {
        add(
            "6-1",
            next,
            0.70
        );
    }

    // --------------------------------------------------------
    // CẦU 1-6
    // --------------------------------------------------------

    if (
        p7 === "XTTTTTT" ||
        p7 === "TXXXXXX"
    ) {
        add(
            "1-6",
            next,
            0.70
        );
    }

    // --------------------------------------------------------
    // CẦU 2-2-2
    // --------------------------------------------------------

    if (
        p6 === "TTXXTT" ||
        p6 === "XXTTXX"
    ) {
        add(
            "2-2-2",
            next,
            0.82
        );
    }

    // --------------------------------------------------------
    // CẦU 3-2-1
    // --------------------------------------------------------

    if (
        p6 === "TTTXXT" ||
        p6 === "XXXTTX"
    ) {
        add(
            "3-2-1",
            next,
            0.73
        );
    }

    // --------------------------------------------------------
    // CẦU 1-2-3
    // --------------------------------------------------------

    if (
        p6 === "TXXTTT" ||
        p6 === "XTTXXX"
    ) {
        add(
            "1-2-3",
            next,
            0.73
        );
    }

    // --------------------------------------------------------
    // CẦU TĂNG
    // --------------------------------------------------------

    if (
        p10 === "TXXTTXXXTT"
    ) {
        add(
            "cau-tang",
            "T",
            0.72
        );
    }

    // --------------------------------------------------------
    // CẦU GIẢM
    // --------------------------------------------------------

    if (
        p10 === "TTTXXXTTXX"
    ) {
        add(
            "cau-giam",
            "X",
            0.72
        );
    }

    // --------------------------------------------------------
    // MẪU DÀI
    // --------------------------------------------------------

    if (
        p12 === "TXTTXTXTTXTX"
    ) {
        add(
            "special-12-A",
            "T",
            0.90
        );
    }

    if (
        p12 === "XTTXTXTTXTTX"
    ) {
        add(
            "special-12-B",
            "X",
            0.90
        );
    }

    return output;
}

// ============================================================
// TỰ HỌC
// ============================================================

const learnedPatterns = new Map();

function getLearnData(pattern) {
    if (!learnedPatterns.has(pattern)) {
        learnedPatterns.set(pattern, {
            total: 0,
            win: 0,
            lose: 0
        });
    }

    return learnedPatterns.get(pattern);
}

function getLearnRate(pattern) {
    const data =
        learnedPatterns.get(pattern);

    if (!data || data.total === 0) {
        return 50;
    }

    return (
        ((data.win + 1) /
            (data.total + 2)) *
        100
    );
}

// ============================================================
// DỰ ĐOÁN
// ============================================================

function calculatePrediction(history) {
    const score = {
        T: 0,
        X: 0
    };

    const evidence = [];

    // Pattern chính
    const patterns =
        getCurrentPatterns(history);

    for (const item of patterns) {
        const learnRate =
            getLearnRate(
                item.pattern
            );

        const lengthFactor =
            patternLengthWeight(
                item.pattern.length
            );

        const occurrenceFactor =
            Math.min(
                2.5,
                Math.log2(
                    item.total + 1
                )
            );

        const learningFactor =
            0.5 +
            learnRate / 100;

        const modeFactor =
            item.mode === "chinh"
                ? 1
                : 0.85;

        const weight =
            lengthFactor *
            occurrenceFactor *
            learningFactor *
            modeFactor;

        score.T +=
            item.pT * weight;

        score.X +=
            item.pX * weight;

        evidence.push({
            type: "pattern",
            pattern:
                item.pattern,
            mode:
                item.mode,
            total:
                item.total,
            tai:
                Number(
                    (
                        item.pT * 100
                    ).toFixed(2)
                ),
            xiu:
                Number(
                    (
                        item.pX * 100
                    ).toFixed(2)
                ),
            hoc:
                Number(
                    learnRate.toFixed(2)
                ),
            weight:
                Number(
                    weight.toFixed(3)
                )
        });
    }

    // Markov
    const markov =
        analyzeMarkov(history);

    if (markov) {
        score.T +=
            markov.pT * 3;

        score.X +=
            markov.pX * 3;

        evidence.push({
            type: "markov",
            total:
                markov.total,
            tai:
                Number(
                    (
                        markov.pT * 100
                    ).toFixed(2)
                ),
            xiu:
                Number(
                    (
                        markov.pX * 100
                    ).toFixed(2)
                )
        });
    }

    // Streak
    const streak =
        analyzeStreak(history);

    if (streak) {
        let weight = 0.7;

        if (streak.length >= 3) {
            weight = 1.5;
        }

        if (streak.length >= 4) {
            weight = 2;
        }

        if (streak.length >= 5) {
            weight = 2.4;
        }

        score[streak.side] +=
            weight;

        evidence.push({
            type: "streak",
            result:
                result(
                    streak.side
                ),
            length:
                streak.length,
            weight
        });
    }

    // Cầu đặc biệt
    const special =
        analyzeSpecialPatterns(
            history
        );

    for (const item of special) {
        score[item.prediction] +=
            item.strength * 3;

        evidence.push({
            type:
                item.type,
            prediction:
                result(
                    item.prediction
                ),
            strength:
                item.strength
        });
    }

    const total =
        score.T + score.X;

    if (total <= 0) {
        return {
            du_doan:
                "Không rõ cầu",
            do_tin_cay:
                "0.00%",
            score,
            evidence
        };
    }

    const prediction =
        score.T >= score.X
            ? "T"
            : "X";

    let confidence =
        (
            Math.max(
                score.T,
                score.X
            ) / total
        ) * 100;

    confidence =
        Math.max(
            50,
            Math.min(
                98,
                confidence
            )
        );

    confidence =
        Number(
            confidence.toFixed(2)
        );

    return {
        du_doan:
            result(prediction),

        do_tin_cay:
            `${confidence.toFixed(2)}%`,

        score: {
            tai:
                Number(
                    score.T.toFixed(4)
                ),
            xiu:
                Number(
                    score.X.toFixed(4)
                )
        },

        evidence
    };
}

// ============================================================
// UPDATE CACHE
// ============================================================

async function getData() {
    const now = Date.now();

    if (
        cache.prediction &&
        now - cache.time < CACHE_MS
    ) {
        return cache;
    }

    const history =
        await fetchHistory();

    if (!history.length) {
        throw new Error(
            "Không có lịch sử"
        );
    }

    const prediction =
        calculatePrediction(
            history
        );

    const pattern =
        buildPattern(
            history
        );

    cache = {
        time: now,
        history,
        prediction,
        pattern
    };

    return cache;
}

// ============================================================
// API CHÍNH
// ============================================================

app.get(
    "/api/taixiumd5",
    async (req, res) => {
        try {
            const {
                history,
                prediction,
                pattern
            } = await getData();

            const latest =
                history[
                    history.length - 1
                ];

            res.json({
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    latest.ket_qua,

                phien_hien_tai:
                    latest.phien + 1,

                pattern:
                    pattern,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay
            });
        } catch (error) {
            console.error(
                "API ERROR:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// API DETAIL
// ============================================================

app.get(
    "/api/taixiumd5/detail",
    async (req, res) => {
        try {
            const {
                history,
                prediction,
                pattern
            } = await getData();

            const latest =
                history[
                    history.length - 1
                ];

            res.json({
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    latest.ket_qua,

                phien_hien_tai:
                    latest.phien + 1,

                pattern:
                    pattern,

                pattern_length:
                    pattern.length,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay,

                diem:
                    prediction.score,

                so_mau:
                    prediction.evidence.length,

                phan_tich:
                    prediction.evidence,

                history:
                    history.slice(
                        -MAX_PATTERN_HISTORY
                    )
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// LEARNING API
// ============================================================

app.get(
    "/api/taixiumd5/learning",
    (req, res) => {
        res.json({
            total:
                learnedPatterns.size,

            learning:
                Object.fromEntries(
                    learnedPatterns
                )
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "TAI XIU MD5",

            pattern:
                "20 phiên - cũ trái, mới phải",

            endpoints: [
                "/api/taixiumd5",
                "/api/taixiumd5/detail",
                "/api/taixiumd5/learning"
            ]
        });
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `TAI XIU MD5 API running on port ${PORT}`
        );
    }
);
