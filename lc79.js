const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3001;

// =========================================================
// API GỐC
// =========================================================

const SOURCE_TX =
    "https://wtx.tele68.com/v1/tx/sessions";

const SOURCE_MD5 =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// =========================================================
// CONFIG
// =========================================================

const MAX_HISTORY = 100;
const MIN_HISTORY = 5;

const histories = {
    tx: [],
    md5: []
};

// =========================================================
// 60 PATTERN MẪU
// =========================================================

const PATTERN_MAU = [
    "T",
    "X",

    "TT",
    "TX",
    "XT",
    "XX",

    "TTT",
    "TTX",
    "TXT",
    "TXX",
    "XTT",
    "XTX",
    "XXT",
    "XXX",

    "TTTT",
    "TTTX",
    "TTXT",
    "TTXX",
    "TXTT",
    "TXTX",
    "TXXT",
    "TXXX",
    "XTTT",
    "XTTX",
    "XTXT",
    "XTXX",
    "XXTT",
    "XXTX",
    "XXXT",
    "XXXX",

    "TTTTT",
    "TTTTX",
    "TTTXT",
    "TTTXX",
    "TTXTT",
    "TTXTX",
    "TTXXT",
    "TTXXX",
    "TXTTT",
    "TXTTX",
    "TXTXT",
    "TXTXX",
    "TXXTT",
    "TXXTX",
    "TXXXT",
    "TXXXX",

    "XTTTT",
    "XTTTX",
    "XTTXT",
    "XTTXX",
    "XTXTT",
    "XTXTX",
    "XTXXT",
    "XTXXX",
    "XXTTT",
    "XXTTX",
    "XXTXT",
    "XXXTT"
];

// =========================================================
// HIỂN THỊ TÀI / XỈU
// =========================================================

function displayResult(value) {

    if (value === "TAI") {
        return "Tài";
    }

    if (value === "XIU") {
        return "Xỉu";
    }

    return value;
}

// =========================================================
// FETCH API
// =========================================================

async function fetchSource(url) {

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 10000);

    try {

        const response = await fetch(url, {
            method: "GET",

            headers: {
                "Accept": "application/json",
                "User-Agent": "LC79-TX-API/1.0"
            },

            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(
                `Source API HTTP ${response.status}`
            );
        }

        return await response.json();

    } finally {

        clearTimeout(timeout);
    }
}

// =========================================================
// CHUẨN HÓA KẾT QUẢ
// =========================================================

function normalizeResult(value) {

    if (!value) {
        return null;
    }

    const v = String(value)
        .toUpperCase()
        .trim();

    if (
        v === "TAI" ||
        v === "TÀI"
    ) {
        return "TAI";
    }

    if (
        v === "XIU" ||
        v === "XỈU"
    ) {
        return "XIU";
    }

    return null;
}

// =========================================================
// CHUYỂN SANG T / X
// =========================================================

function toTX(value) {

    return normalizeResult(value) === "TAI"
        ? "T"
        : "X";
}

// =========================================================
// CHUYỂN API GỐC
// =========================================================

function normalizeSessions(json) {

    if (
        !json ||
        !Array.isArray(json.list)
    ) {
        return [];
    }

    return json.list

        .map(item => {

            const dices =
                Array.isArray(item.dices)
                    ? item.dices.map(Number)
                    : [];

            const point =
                Number(item.point);

            const tong =
                Number.isFinite(point)
                    ? point
                    : dices.reduce(
                        (a, b) => a + b,
                        0
                    );

            return {

                phien: Number(item.id),

                xuc_xac: dices,

                tong,

                ket_qua:
                    normalizeResult(
                        item.resultTruyenThong
                    )
            };
        })

        .filter(item =>

            Number.isFinite(item.phien) &&

            item.ket_qua &&

            Array.isArray(item.xuc_xac)

        )

        .sort(
            (a, b) =>
                a.phien - b.phien
        );
}

// =========================================================
// BUILD PATTERN
// =========================================================

function buildPattern(
    history,
    length = 10
) {

    return history

        .slice(-length)

        .map(item =>
            toTX(item.ket_qua)
        )

        .join("");
}

// =========================================================
// SO SÁNH PATTERN
// =========================================================

function comparePattern(currentPattern) {

    let best = null;
    let bestScore = 0;

    for (
        const sample of PATTERN_MAU
    ) {

        const maxLength =
            Math.min(
                sample.length,
                currentPattern.length
            );

        if (maxLength < 2) {
            continue;
        }

        const current =
            currentPattern.slice(
                -maxLength
            );

        const target =
            sample.slice(
                -maxLength
            );

        let same = 0;

        for (
            let i = 0;
            i < maxLength;
            i++
        ) {

            if (
                current[i] ===
                target[i]
            ) {
                same++;
            }
        }

        const score =
            (same / maxLength) * 100;

        if (score > bestScore) {

            bestScore = score;

            best = {

                pattern: sample,

                score:
                    Number(
                        score.toFixed(2)
                    )
            };
        }
    }

    return best;
}

// =========================================================
// PHÂN PHỐI TÀI / XỈU
// =========================================================

function distributionScore(history) {

    if (!history.length) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    let tai = 0;
    let xiu = 0;

    for (
        const item of
        history.slice(-20)
    ) {

        if (
            item.ket_qua === "TAI"
        ) {
            tai++;
        }

        if (
            item.ket_qua === "XIU"
        ) {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    return {

        tai:
            (tai / total) * 100,

        xiu:
            (xiu / total) * 100
    };
}

// =========================================================
// MARKOV
// =========================================================

function markovScore(history) {

    if (history.length < 2) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    const last =
        history[
            history.length - 1
        ].ket_qua;

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < history.length - 1;
        i++
    ) {

        if (
            history[i].ket_qua !== last
        ) {
            continue;
        }

        if (
            history[i + 1].ket_qua ===
            "TAI"
        ) {
            tai++;
        }

        if (
            history[i + 1].ket_qua ===
            "XIU"
        ) {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    return {

        tai:
            (tai / total) * 100,

        xiu:
            (xiu / total) * 100
    };
}

// =========================================================
// PHÂN TÍCH CẦU
// =========================================================

function analyzeStreak(history) {

    if (!history.length) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    const last =
        history[
            history.length - 1
        ].ket_qua;

    let streak = 0;

    for (
        let i = history.length - 1;
        i >= 0;
        i--
    ) {

        if (
            history[i].ket_qua === last
        ) {

            streak++;

        } else {

            break;
        }
    }

    let tai = 50;
    let xiu = 50;

    if (last === "TAI") {

        tai +=
            Math.min(
                streak * 3,
                12
            );

        xiu -=
            Math.min(
                streak * 3,
                12
            );

    } else {

        xiu +=
            Math.min(
                streak * 3,
                12
            );

        tai -=
            Math.min(
                streak * 3,
                12
            );
    }

    return {
        tai,
        xiu
    };
}

// =========================================================
// AI TỰ HỌC PATTERN
// =========================================================

function learnedPatternScore(history) {

    if (history.length < 4) {

        return {

            tai: 50,

            xiu: 50,

            samples: 0
        };
    }

    const tx =
        history.map(
            item =>
                toTX(item.ket_qua)
        );

    let tai = 0;
    let xiu = 0;

    let samples = 0;

    const maxPatternLength =
        Math.min(
            8,
            tx.length - 1
        );

    for (
        let len = 2;
        len <= maxPatternLength;
        len++
    ) {

        const pattern =
            tx.slice(-len).join("");

        for (
            let i = 0;
            i <= tx.length - len - 1;
            i++
        ) {

            const found =
                tx
                    .slice(i, i + len)
                    .join("");

            if (
                found !== pattern
            ) {
                continue;
            }

            const next =
                tx[i + len];

            if (next === "T") {
                tai++;
            }

            if (next === "X") {
                xiu++;
            }

            samples++;
        }
    }

    if (!samples) {

        return {

            tai: 50,

            xiu: 50,

            samples: 0
        };
    }

    return {

        tai:
            (tai / samples) * 100,

        xiu:
            (xiu / samples) * 100,

        samples
    };
}

// =========================================================
// ĐỘ TIN CẬY
// =========================================================

function calculateConfidence(scores) {

    const max =
        Math.max(
            scores.tai,
            scores.xiu
        );

    const min =
        Math.min(
            scores.tai,
            scores.xiu
        );

    let confidence =
        50 +
        Math.abs(max - min) *
        0.65;

    confidence =
        Math.max(
            50,
            Math.min(
                97,
                confidence
            )
        );

    return Number(
        confidence.toFixed(2)
    );
}

// =========================================================
// AI PHÂN TÍCH
// =========================================================

function analyzeAI(history) {

    if (
        history.length <
        MIN_HISTORY
    ) {

        return {

            prediction:
                "KHONG_RO",

            confidence: 50,

            pattern:
                buildPattern(history),

            pattern_mau: null,

            pattern_score: 0,

            samples: 0,

            scores: {

                TAI: 50,

                XIU: 50
            }
        };
    }

    const pattern =
        buildPattern(
            history,
            10
        );

    const distribution =
        distributionScore(
            history
        );

    const markov =
        markovScore(
            history
        );

    const streak =
        analyzeStreak(
            history
        );

    const learned =
        learnedPatternScore(
            history
        );

    const sample =
        comparePattern(
            pattern
        );

    // =====================================================
    // TRỌNG SỐ AI
    // =====================================================

    const tai =

        distribution.tai * 0.20 +

        markov.tai * 0.25 +

        streak.tai * 0.15 +

        learned.tai * 0.40;

    const xiu =

        distribution.xiu * 0.20 +

        markov.xiu * 0.25 +

        streak.xiu * 0.15 +

        learned.xiu * 0.40;

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const confidence =
        calculateConfidence({

            tai,

            xiu
        });

    return {

        prediction,

        confidence,

        pattern,

        pattern_mau:
            sample
                ? sample.pattern
                : null,

        pattern_score:
            sample
                ? sample.score
                : 0,

        samples:
            learned.samples,

        scores: {

            TAI:
                Number(
                    tai.toFixed(2)
                ),

            XIU:
                Number(
                    xiu.toFixed(2)
                )
        }
    };
}

// =========================================================
// PROCESS API
// =========================================================

async function processAPI(
    sourceUrl,
    type
) {

    const json =
        await fetchSource(
            sourceUrl
        );

    const sessions =
        normalizeSessions(
            json
        );

    if (!sessions.length) {

        throw new Error(
            "API gốc không trả về dữ liệu hợp lệ"
        );
    }

    histories[type] =
        sessions.slice(
            -MAX_HISTORY
        );

    const history =
        histories[type];

    const latest =
        history[
            history.length - 1
        ];

    const analysis =
        analyzeAI(
            history
        );

    return {

        phien:
            latest.phien,

        xuc_xac:
            latest.xuc_xac,

        tong:
            latest.tong,

        ket_qua:
            displayResult(
                latest.ket_qua
            ),

        phien_hien_tai:
            latest.phien + 1,

        pattern:
            analysis.pattern,

        pattern_mau:
            analysis.pattern_mau,

        du_doan:
            displayResult(
                analysis.prediction
            ),

        do_tin_cay:
            `${analysis.confidence.toFixed(2)}%`
    };
}

// =========================================================
// API 1
// /lc79/tx/hu
// =========================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    SOURCE_TX,
                    "tx"
                );

            res.json(data);

        } catch (error) {

            console.error(
                "[TX ERROR]",
                error.message
            );

            res.status(502).json({

                error: true,

                message:
                    error.message
            });
        }
    }
);

// =========================================================
// API 2
// /lc79/tx/md5
// =========================================================

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    SOURCE_MD5,
                    "md5"
                );

            res.json(data);

        } catch (error) {

            console.error(
                "[MD5 ERROR]",
                error.message
            );

            res.status(502).json({

                error: true,

                message:
                    error.message
            });
        }
    }
);

// =========================================================
// HEALTH CHECK
// =========================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status: "online",

            service:
                "LC79 TX API",

            endpoints: [

                "/lc79/tx/hu",

                "/lc79/tx/md5"
            ],

            pattern_mau:
                PATTERN_MAU.length,

            ai_learning:
                true,

            max_history:
                MAX_HISTORY
        });
    }
);

// =========================================================
// START SERVER
// =========================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔══════════════════════════════════════╗
║          LC79 TX API ONLINE          ║
╠══════════════════════════════════════╣
║ PORT        : ${PORT}
║ TX API      : /lc79/tx/hu
║ MD5 API     : /lc79/tx/md5
║ PATTERN     : ${PATTERN_MAU.length}
║ AI LEARNING : ON
║ HISTORY     : ${MAX_HISTORY}
╚══════════════════════════════════════╝
`);
    }
);
