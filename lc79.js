const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

const SOURCE_API =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const MAX_HISTORY = 50;
const MAX_PATTERN_LENGTH = 12;

// =====================================================
// CACHE
// =====================================================

let cachedHistory = [];
let cachedPrediction = null;
let lastUpdate = 0;

const CACHE_TIME = 3000;

// =====================================================
// TỰ HỌC TRONG RAM
// =====================================================

const learnedPatterns = new Map();

// =====================================================
// FETCH API GỐC
// =====================================================

async function fetchSource() {
    const response = await fetch(SOURCE_API, {
        headers: {
            "Accept": "application/json",
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
        .sort(
            (a, b) =>
                a.phien - b.phien
        )
        .slice(-MAX_HISTORY);
}

// =====================================================
// T/X
// =====================================================

function txOf(result) {
    return result === "Tài"
        ? "T"
        : "X";
}

function resultOf(tx) {
    return tx === "T"
        ? "Tài"
        : "Xỉu";
}

// =====================================================
// ĐẢO PATTERN
// =====================================================

function invertPattern(pattern) {
    return pattern
        .split("")
        .map(x =>
            x === "T"
                ? "X"
                : "T"
        )
        .join("");
}

// =====================================================
// WEIGHT PATTERN
// =====================================================

function patternLengthWeight(length) {
    if (length >= 12) return 3.0;
    if (length >= 10) return 2.7;
    if (length >= 8) return 2.4;
    if (length >= 7) return 2.2;
    if (length >= 6) return 2.0;
    if (length >= 5) return 1.8;
    if (length >= 4) return 1.5;
    if (length >= 3) return 1.2;

    return 1;
}

// =====================================================
// LEARNING
// =====================================================

function getLearning(pattern) {
    if (!learnedPatterns.has(pattern)) {
        learnedPatterns.set(
            pattern,
            {
                total: 0,
                win: 0,
                lose: 0,
                weight: 1
            }
        );
    }

    return learnedPatterns.get(pattern);
}

function learningRate(pattern) {
    const data =
        learnedPatterns.get(pattern);

    if (!data || data.total === 0) {
        return 50;
    }

    return (
        (data.win + 1) /
        (data.total + 2)
    ) * 100;
}

// =====================================================
// TẠO PATTERN TỪ LỊCH SỬ
// =====================================================

function generatePatterns(history) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    const result = new Set();

    for (
        let length = 2;
        length <= MAX_PATTERN_LENGTH;
        length++
    ) {
        for (
            let i = 0;
            i + length <= tx.length;
            i++
        ) {
            result.add(
                tx
                    .slice(i, i + length)
                    .join("")
            );
        }
    }

    return [...result];
}

// =====================================================
// TÌM PATTERN
// =====================================================

function analyzePattern(
    history,
    pattern
) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i + pattern.length < tx.length;
        i++
    ) {
        const current =
            tx
                .slice(
                    i,
                    i + pattern.length
                )
                .join("");

        if (current !== pattern) {
            continue;
        }

        total++;

        const next =
            tx[i + pattern.length];

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

// =====================================================
// PATTERN HIỆN TẠI
// =====================================================

function currentPatterns(history) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    const result = [];

    const maxLength =
        Math.min(
            MAX_PATTERN_LENGTH,
            tx.length - 1
        );

    for (
        let length = 2;
        length <= maxLength;
        length++
    ) {
        const current =
            tx
                .slice(-length)
                .join("");

        const normal =
            analyzePattern(
                history,
                current
            );

        if (
            normal &&
            normal.total >= 2
        ) {
            result.push({
                ...normal,
                mode: "chinh"
            });
        }

        const inverted =
            invertPattern(current);

        const inverse =
            analyzePattern(
                history,
                inverted
            );

        if (
            inverse &&
            inverse.total >= 2
        ) {
            result.push({
                ...inverse,
                mode: "dao"
            });
        }
    }

    return result;
}

// =====================================================
// MARKOV
// =====================================================

function markov(history) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    if (tx.length < 5) {
        return null;
    }

    const current =
        tx[tx.length - 1];

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < tx.length - 1;
        i++
    ) {
        if (tx[i] !== current) {
            continue;
        }

        total++;

        if (tx[i + 1] === "T") {
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

// =====================================================
// STREAK
// =====================================================

function streak(history) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    if (!tx.length) {
        return null;
    }

    const last =
        tx[tx.length - 1];

    let count = 1;

    for (
        let i = tx.length - 2;
        i >= 0;
        i--
    ) {
        if (tx[i] === last) {
            count++;
        } else {
            break;
        }
    }

    return {
        side: last,
        length: count
    };
}

// =====================================================
// CHẠY DẠNG CẦU
// =====================================================

function specialPatterns(history) {
    const tx =
        history.map(
            item => txOf(item.ket_qua)
        );

    const result = [];

    if (tx.length < 4) {
        return result;
    }

    const p4 =
        tx.slice(-4).join("");

    const p5 =
        tx.slice(-5).join("");

    const p6 =
        tx.slice(-6).join("");

    const p7 =
        tx.slice(-7).join("");

    const p8 =
        tx.slice(-8).join("");

    const p10 =
        tx.slice(-10).join("");

    const p12 =
        tx.slice(-12).join("");

    const opposite =
        tx[tx.length - 1] === "T"
            ? "X"
            : "T";

    // ================================================
    // 1-1
    // ================================================

    if (
        p6 === "TXTXTX" ||
        p6 === "XTXTXT"
    ) {
        result.push({
            type: "1-1",
            prediction: opposite,
            strength: 0.89
        });
    }

    // ================================================
    // 2-2
    // ================================================

    if (
        p8 === "TTXXTTXX" ||
        p8 === "XXTTXXTT"
    ) {
        result.push({
            type: "2-2",
            prediction: opposite,
            strength: 0.86
        });
    }

    // ================================================
    // 3-3
    // ================================================

    if (
        p6 === "TTTXXX" ||
        p6 === "XXXTTT"
    ) {
        result.push({
            type: "3-3",
            prediction: opposite,
            strength: 0.84
        });
    }

    // ================================================
    // 1-2-1
    // ================================================

    if (
        p4 === "TXXT" ||
        p4 === "XTTX"
    ) {
        result.push({
            type: "1-2-1",
            prediction: opposite,
            strength: 0.82
        });
    }

    // ================================================
    // 2-1-2
    // ================================================

    if (
        p5 === "TTXTT" ||
        p5 === "XXTXX"
    ) {
        result.push({
            type: "2-1-2",
            prediction: opposite,
            strength: 0.82
        });
    }

    // ================================================
    // 1-3-1
    // ================================================

    if (
        p5 === "XTTTX" ||
        p5 === "TXXXT"
    ) {
        result.push({
            type: "1-3-1",
            prediction: opposite,
            strength: 0.80
        });
    }

    // ================================================
    // 3-1-3
    // ================================================

    if (
        p7 === "TTTXTTT" ||
        p7 === "XXXTX XX".replace(" ", "")
    ) {
        result.push({
            type: "3-1-3",
            prediction: opposite,
            strength: 0.78
        });
    }

    // ================================================
    // 3-2
    // ================================================

    if (
        p5 === "TTTXX" ||
        p5 === "XXXTT"
    ) {
        result.push({
            type: "3-2",
            prediction: opposite,
            strength: 0.77
        });
    }

    // ================================================
    // 2-3
    // ================================================

    if (
        p5 === "TTXXX" ||
        p5 === "XXTTT"
    ) {
        result.push({
            type: "2-3",
            prediction: opposite,
            strength: 0.77
        });
    }

    // ================================================
    // 4-1
    // ================================================

    if (
        p5 === "TTTTX" ||
        p5 === "XXXXT"
    ) {
        result.push({
            type: "4-1",
            prediction: opposite,
            strength: 0.76
        });
    }

    // ================================================
    // 1-4
    // ================================================

    if (
        p5 === "XTTTT" ||
        p5 === "TXXXX"
    ) {
        result.push({
            type: "1-4",
            prediction: opposite,
            strength: 0.76
        });
    }

    // ================================================
    // 4-2
    // ================================================

    if (
        p6 === "TTTTXX" ||
        p6 === "XXXXTT"
    ) {
        result.push({
            type: "4-2",
            prediction: opposite,
            strength: 0.75
        });
    }

    // ================================================
    // 2-4
    // ================================================

    if (
        p6 === "TTXXXX" ||
        p6 === "XXTTTT"
    ) {
        result.push({
            type: "2-4",
            prediction: opposite,
            strength: 0.75
        });
    }

    // ================================================
    // 5-1
    // ================================================

    if (
        p6 === "TTTTTX" ||
        p6 === "XXXXXT"
    ) {
        result.push({
            type: "5-1",
            prediction: opposite,
            strength: 0.72
        });
    }

    // ================================================
    // 1-5
    // ================================================

    if (
        p6 === "XTTTTT" ||
        p6 === "TXXXXX"
    ) {
        result.push({
            type: "1-5",
            prediction: opposite,
            strength: 0.72
        });
    }

    // ================================================
    // 2-1
    // ================================================

    if (
        p6 === "TTXTTX" ||
        p6 === "XXTXXT"
    ) {
        result.push({
            type: "2-1",
            prediction: opposite,
            strength: 0.81
        });
    }

    // ================================================
    // 1-2
    // ================================================

    if (
        p6 === "TXXTXX" ||
        p6 === "XTTXTT"
    ) {
        result.push({
            type: "1-2",
            prediction: opposite,
            strength: 0.81
        });
    }

    // ================================================
    // CẦU ĐẢO
    // ================================================

    if (
        /^[TX](TX|XT)+[TX]?$/.test(
            p8
        )
    ) {
        result.push({
            type: "dao",
            prediction: opposite,
            strength: 0.85
        });
    }

    // ================================================
    // CẦU LẶP 4
    // ================================================

    if (
        p8.slice(0, 4) ===
        p8.slice(4)
    ) {
        result.push({
            type: "lap-4",
            prediction:
                p8[0],
            strength: 0.79
        });
    }

    // ================================================
    // CẦU LẶP 3
    // ================================================

    if (
        p6.slice(0, 3) ===
        p6.slice(3)
    ) {
        result.push({
            type: "lap-3",
            prediction:
                p6[0],
            strength: 0.78
        });
    }

    // ================================================
    // CẦU LẶP 2
    // ================================================

    if (
        p8[0] === p8[2] &&
        p8[0] === p8[4] &&
        p8[0] === p8[6] &&
        p8[1] === p8[3] &&
        p8[1] === p8[5] &&
        p8[1] === p8[7]
    ) {
        result.push({
            type: "lap-2",
            prediction:
                p8[0],
            strength: 0.80
        });
    }

    // ================================================
    // ĐỐI XỨNG
    // ================================================

    if (
        p8 ===
        p8
            .split("")
            .reverse()
            .join("")
    ) {
        result.push({
            type: "doi-xung",
            prediction: opposite,
            strength: 0.80
        });
    }

    // ================================================
    // MẪU DÀI
    // ================================================

    if (
        p12 ===
        "TXTTXTXTTXTX"
    ) {
        result.push({
            type: "special-12-A",
            prediction: "T",
            strength: 0.90
        });
    }

    if (
        p12 ===
        "XTTXTXTTXTTX"
    ) {
        result.push({
            type: "special-12-B",
            prediction: "X",
            strength: 0.90
        });
    }

    // ================================================
    // CẦU GÃY
    // ================================================

    if (
        p6 === "TTTXXT" ||
        p6 === "XXXTTX" ||
        p6 === "TTXXXT" ||
        p6 === "XXTTTX"
    ) {
        result.push({
            type: "cau-gay",
            prediction:
                tx[tx.length - 1],
            strength: 0.70
        });
    }

    return result;
}

// =====================================================
// TÍNH DỰ ĐOÁN
// =====================================================

function predict(history) {
    const score = {
        T: 0,
        X: 0
    };

    const evidence = [];

    // =================================================
    // PATTERN
    // =================================================

    const patterns =
        currentPatterns(history);

    for (const item of patterns) {
        const winRate =
            learningRate(
                item.pattern
            );

        const lengthWeight =
            patternLengthWeight(
                item.pattern.length
            );

        const occurrenceWeight =
            Math.min(
                2.5,
                Math.log2(
                    item.total + 1
                )
            );

        const learningWeight =
            0.5 +
            winRate / 100;

        const modeWeight =
            item.mode === "chinh"
                ? 1
                : 0.85;

        const weight =
            lengthWeight *
            occurrenceWeight *
            learningWeight *
            modeWeight;

        score.T +=
            item.pT * weight;

        score.X +=
            item.pX * weight;

        evidence.push({
            type: "pattern",
            pattern: item.pattern,
            mode: item.mode,
            total: item.total,
            tai: Number(
                (
                    item.pT * 100
                ).toFixed(2)
            ),
            xiu: Number(
                (
                    item.pX * 100
                ).toFixed(2)
            ),
            win_rate:
                Number(
                    winRate.toFixed(2)
                ),
            weight:
                Number(
                    weight.toFixed(3)
                )
        });
    }

    // =================================================
    // MARKOV
    // =================================================

    const mk =
        markov(history);

    if (mk) {
        score.T +=
            mk.pT * 3;

        score.X +=
            mk.pX * 3;

        evidence.push({
            type: "markov",
            total: mk.total,
            tai: Number(
                (
                    mk.pT * 100
                ).toFixed(2)
            ),
            xiu: Number(
                (
                    mk.pX * 100
                ).toFixed(2)
            )
        });
    }

    // =================================================
    // STREAK
    // =================================================

    const st =
        streak(history);

    if (st) {
        let weight = 0.7;

        if (st.length >= 3)
            weight = 1.5;

        if (st.length >= 4)
            weight = 2.0;

        if (st.length >= 5)
            weight = 2.4;

        score[st.side] +=
            weight;

        evidence.push({
            type: "streak",
            result:
                resultOf(st.side),
            length:
                st.length,
            weight
        });
    }

    // =================================================
    // CẦU ĐẶC BIỆT
    // =================================================

    const special =
        specialPatterns(history);

    for (const item of special) {
        score[item.prediction] +=
            item.strength * 3;

        evidence.push({
            type:
                item.type,

            prediction:
                resultOf(
                    item.prediction
                ),

            strength:
                item.strength
        });
    }

    // =================================================
    // KẾT QUẢ
    // =================================================

    const total =
        score.T + score.X;

    if (total <= 0) {
        return {
            du_doan:
                "Không rõ cầu",

            do_tin_cay:
                "0.00%",

            raw:
                0,

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
        Math.min(
            98,
            Math.max(
                50,
                confidence
            )
        );

    confidence =
        Number(
            confidence.toFixed(2)
        );

    return {
        du_doan:
            resultOf(prediction),

        do_tin_cay:
            `${confidence.toFixed(2)}%`,

        raw:
            confidence,

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

// =====================================================
// CACHE
// =====================================================

async function getPrediction() {
    const now =
        Date.now();

    if (
        cachedPrediction &&
        now - lastUpdate <
            CACHE_TIME
    ) {
        return {
            history:
                cachedHistory,

            prediction:
                cachedPrediction
        };
    }

    const history =
        await fetchSource();

    if (!history.length) {
        throw new Error(
            "Không có lịch sử"
        );
    }

    const prediction =
        predict(history);

    cachedHistory =
        history;

    cachedPrediction =
        prediction;

    lastUpdate =
        now;

    return {
        history,
        prediction
    };
}

// =====================================================
// API CHÍNH
// =====================================================

app.get(
    "/api/taixiumd5",
    async (req, res) => {
        try {
            const {
                history,
                prediction
            } =
                await getPrediction();

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

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay
            });

        } catch (error) {
            console.error(
                error.message
            );

            res.status(500).json({
                error:
                    "API prediction error",

                message:
                    error.message
            });
        }
    }
);

// =====================================================
// DETAIL
// =====================================================

app.get(
    "/api/taixiumd5/detail",
    async (req, res) => {
        try {
            const {
                history,
                prediction
            } =
                await getPrediction();

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

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay,

                diem:
                    prediction.score,

                so_cau:
                    prediction.evidence.length,

                phan_tich:
                    prediction.evidence,

                history
            });

        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// =====================================================
// LEARNING
// =====================================================

app.get(
    "/api/taixiumd5/learning",
    (req, res) => {
        const data =
            Object.fromEntries(
                learnedPatterns
            );

        res.json({
            total:
                learnedPatterns.size,

            learning:
                data
        });
    }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "TAI XIU MD5",

            endpoints: [
                "/api/taixiumd5",
                "/api/taixiumd5/detail",
                "/api/taixiumd5/learning"
            ]
        });
    }
);

// =====================================================
// ERROR
// =====================================================

app.use(
    (err, req, res, next) => {
        console.error(err);

        res.status(500).json({
            error:
                "Internal Server Error"
        });
    }
);

// =====================================================
// START
// =====================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            "================================"
        );

        console.log(
            "TAI XIU MD5 API"
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            "================================"
        );
    }
);
