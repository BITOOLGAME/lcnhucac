// ============================================================
// LC79.JS
// HU + MD5 TÀI XỈU ANALYZER
// ============================================================

const express = require("express");

const app = express();

app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";

const HU_API =
    "https://wtx.tele68.com/v1/tx/sessions";

const MD5_API =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const MAX_SOURCE_HISTORY = 100;
const MAX_PREDICTION_HISTORY = 100;

const MAX_PATTERN = 20;

const FETCH_INTERVAL = 3000;

// ============================================================
// BASIC
// ============================================================

function tx(value) {
    if (!value) {
        return null;
    }

    const v =
        String(value)
            .trim()
            .toUpperCase();

    if (
        v === "TAI" ||
        v === "T" ||
        v === "TÀI"
    ) {
        return "T";
    }

    if (
        v === "XIU" ||
        v === "X" ||
        v === "XỈU"
    ) {
        return "X";
    }

    return null;
}

// ============================================================
// OUTPUT TÀI / XỈU
// ============================================================

function result(value) {
    if (value === "T") {
        return "Tài";
    }

    if (value === "X") {
        return "Xỉu";
    }

    return null;
}

function opposite(value) {
    return value === "T"
        ? "X"
        : "T";
}

function clamp(
    value,
    min,
    max
) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function safeArray(value) {
    return Array.isArray(value)
        ? value
        : [];
}

// ============================================================
// DICE
// ============================================================

function normalizeDice(dices) {
    if (!Array.isArray(dices)) {
        return [];
    }

    return dices
        .map(Number)
        .filter(
            n =>
                Number.isFinite(n)
        );
}

function diceTotal(
    dices,
    point
) {
    const arr =
        normalizeDice(dices);

    if (arr.length) {
        return arr.reduce(
            (a, b) => a + b,
            0
        );
    }

    const p =
        Number(point);

    return Number.isFinite(p)
        ? p
        : null;
}

// ============================================================
// SIMILARITY
// ============================================================

function similarity(a, b) {
    if (!a || !b) {
        return 0;
    }

    const length =
        Math.min(
            a.length,
            b.length
        );

    if (!length) {
        return 0;
    }

    let same = 0;

    for (
        let i = 0;
        i < length;
        i++
    ) {
        if (a[i] === b[i]) {
            same++;
        }
    }

    const positional =
        same / length;

    const lengthFactor =
        Math.min(
            a.length,
            b.length
        ) /
        Math.max(
            a.length,
            b.length
        );

    return (
        positional * 0.8 +
        lengthFactor * 0.2
    );
}

// ============================================================
// PATTERN
// CŨ BÊN TRÁI -> MỚI BÊN PHẢI
// ============================================================

function buildPattern(
    history,
    length = MAX_PATTERN
) {
    /*
        history luôn được lưu:

        CŨ -> MỚI

        Ví dụ:

        [
            X,
            X,
            T,
            T,
            X
        ]

        pattern:

        XXTTX
    */

    return history
        .slice(-length)
        .map(
            item => item.result
        )
        .filter(Boolean)
        .join("");
}

// ============================================================
// PATTERN TRANSFORM
// ============================================================

function oppositePattern(pattern) {
    return pattern
        .split("")
        .map(
            char =>
                opposite(char)
        )
        .join("");
}

function reversePattern(pattern) {
    return pattern
        .split("")
        .reverse()
        .join("");
}

function transformPatterns(
    pattern
) {
    if (!pattern) {
        return [];
    }

    const set =
        new Set();

    set.add(pattern);

    set.add(
        oppositePattern(pattern)
    );

    set.add(
        reversePattern(pattern)
    );

    set.add(
        oppositePattern(
            reversePattern(pattern)
        )
    );

    return [...set];
}

// ============================================================
// RUN / CẦU
// ============================================================

function getRuns(pattern) {
    if (!pattern) {
        return [];
    }

    const runs = [];

    let current =
        pattern[0];

    let count = 1;

    for (
        let i = 1;
        i < pattern.length;
        i++
    ) {
        if (
            pattern[i] ===
            current
        ) {
            count++;
        } else {
            runs.push({
                value: current,
                count
            });

            current =
                pattern[i];

            count = 1;
        }
    }

    runs.push({
        value: current,
        count
    });

    return runs;
}

// ============================================================
// CẦU DẠNG 1-3-1
// ============================================================

function patternTemplate(
    pattern
) {
    return getRuns(pattern)
        .map(
            item =>
                item.count
        )
        .join("-");
}

// ============================================================
// MARKOV
// ============================================================

function markovScore(history) {
    const count = {
        TT: 0,
        TX: 0,
        XT: 0,
        XX: 0
    };

    for (
        let i = 1;
        i < history.length;
        i++
    ) {
        const a =
            history[i - 1]
                .result;

        const b =
            history[i]
                .result;

        if (!a || !b) {
            continue;
        }

        const key =
            a + b;

        if (
            count[key] !==
            undefined
        ) {
            count[key]++;
        }
    }

    const last =
        history.at(-1)
            ?.result;

    if (!last) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const t =
        last === "T"
            ? count.TT
            : count.XT;

    const x =
        last === "T"
            ? count.TX
            : count.XX;

    const total =
        t + x;

    if (!total) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    return {
        T: t / total,
        X: x / total
    };
}

// ============================================================
// STREAK
// ============================================================

function streakAnalysis(
    pattern
) {
    if (!pattern) {
        return {
            side: null,
            length: 0,
            T: 0,
            X: 0
        };
    }

    const runs =
        getRuns(pattern);

    const last =
        runs.at(-1);

    if (!last) {
        return {
            side: null,
            length: 0,
            T: 0,
            X: 0
        };
    }

    let T = 0;
    let X = 0;

    if (
        last.value === "T"
    ) {
        T =
            Math.min(
                last.count / 5,
                1
            );
    } else {
        X =
            Math.min(
                last.count / 5,
                1
            );
    }

    return {
        side: last.value,
        length: last.count,
        T,
        X
    };
}

// ============================================================
// DISTRIBUTION
// ============================================================

function distribution(
    history
) {
    const recent =
        history.slice(-20);

    let T = 0;
    let X = 0;

    for (
        const item of recent
    ) {
        if (
            item.result === "T"
        ) {
            T++;
        }

        if (
            item.result === "X"
        ) {
            X++;
        }
    }

    const total =
        T + X;

    if (!total) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    return {
        T: T / total,
        X: X / total
    };
}

// ============================================================
// SELF LEARNING
// ============================================================

function createLearning() {
    return {
        T: {
            win: 1,
            lose: 1
        },

        X: {
            win: 1,
            lose: 1
        },

        dice: {
            low: {
                T: 1,
                X: 1
            },

            high: {
                T: 1,
                X: 1
            }
        },

        totalPredictions: 0,

        totalWins: 0,

        totalLosses: 0
    };
}

// ============================================================
// UPDATE LEARNING
// ============================================================

function updateLearning(
    engine,
    prediction,
    actual,
    dices
) {
    if (
        !prediction ||
        !actual
    ) {
        return;
    }

    const win =
        prediction === actual;

    engine.learning
        .totalPredictions++;

    if (win) {
        engine.learning
            .totalWins++;

        engine.learning[
            prediction
        ].win++;

    } else {
        engine.learning
            .totalLosses++;

        engine.learning[
            prediction
        ].lose++;
    }

    const total =
        diceTotal(dices);

    if (
        Number.isFinite(total)
    ) {
        const group =
            total >= 11
                ? "high"
                : "low";

        engine.learning
            .dice[group][actual]++;
    }
}

// ============================================================
// LEARNING SCORE
// ============================================================

function learningScore(
    engine,
    dices
) {
    const learning =
        engine.learning;

    const tTotal =
        learning.T.win +
        learning.T.lose;

    const xTotal =
        learning.X.win +
        learning.X.lose;

    let T =
        tTotal > 0
            ? learning.T.win /
              tTotal
            : 0.5;

    let X =
        xTotal > 0
            ? learning.X.win /
              xTotal
            : 0.5;

    const total =
        diceTotal(dices);

    if (
        Number.isFinite(total)
    ) {
        const group =
            total >= 11
                ? "high"
                : "low";

        const dice =
            learning.dice[group];

        const diceCount =
            dice.T + dice.X;

        if (diceCount > 0) {
            const dt =
                dice.T /
                diceCount;

            const dx =
                dice.X /
                diceCount;

            T =
                T * 0.65 +
                dt * 0.35;

            X =
                X * 0.65 +
                dx * 0.35;
        }
    }

    return {
        T,
        X
    };
}

// ============================================================
// MINE PATTERNS
// ============================================================

function minePatterns(
    history
) {
    const patterns = [];

    const maxLength =
        Math.min(
            10,
            history.length - 1
        );

    for (
        let length = 3;
        length <= maxLength;
        length++
    ) {
        const occurrences =
            {};

        for (
            let i = 0;
            i + length <
            history.length;
            i++
        ) {
            const pattern =
                history
                    .slice(
                        i,
                        i + length
                    )
                    .map(
                        item =>
                            item.result
                    )
                    .join("");

            const next =
                history[
                    i + length
                ]?.result;

            if (
                !pattern ||
                !next
            ) {
                continue;
            }

            if (
                !occurrences[
                    pattern
                ]
            ) {
                occurrences[
                    pattern
                ] = {
                    T: 0,
                    X: 0,
                    samples: 0
                };
            }

            occurrences[
                pattern
            ][next]++;

            occurrences[
                pattern
            ].samples++;
        }

        for (
            const [
                pattern,
                stats
            ]
            of Object.entries(
                occurrences
            )
        ) {
            if (
                stats.samples < 2
            ) {
                continue;
            }

            const total =
                stats.T +
                stats.X;

            if (!total) {
                continue;
            }

            const next =
                stats.T >=
                stats.X
                    ? "T"
                    : "X";

            const confidence =
                Math.max(
                    stats.T,
                    stats.X
                ) / total;

            patterns.push({
                pattern,

                sample:
                    stats.samples,

                T:
                    stats.T,

                X:
                    stats.X,

                next,

                confidence,

                template:
                    patternTemplate(
                        pattern
                    )
            });
        }
    }

    patterns.sort(
        (a, b) => {
            if (
                b.sample !==
                a.sample
            ) {
                return (
                    b.sample -
                    a.sample
                );
            }

            return (
                b.confidence -
                a.confidence
            );
        }
    );

    return patterns.slice(
        0,
        100
    );
}

// ============================================================
// PATTERN ANALYSIS
// ============================================================

function analyzePattern(
    history
) {
    const current =
        buildPattern(
            history,
            MAX_PATTERN
        );

    if (!current) {
        return {
            pattern: "",
            cau: "",
            T: 0,
            X: 0
        };
    }

    const templates =
        minePatterns(
            history
        );

    let scoreT = 0;
    let scoreX = 0;

    let bestMatch =
        null;

    for (
        const item
        of templates
    ) {
        const variants =
            transformPatterns(
                item.pattern
            );

        let bestSimilarity =
            0;

        let matched = "";

        for (
            const variant
            of variants
        ) {
            const currentPart =
                current.slice(
                    -variant.length
                );

            const sim =
                similarity(
                    currentPart,
                    variant
                );

            if (
                sim >
                bestSimilarity
            ) {
                bestSimilarity =
                    sim;

                matched =
                    variant;
            }
        }

        if (
            bestSimilarity <
            0.55
        ) {
            continue;
        }

        const sampleFactor =
            Math.min(
                item.sample / 10,
                1
            );

        const weight =
            bestSimilarity *
            item.confidence *
            sampleFactor;

        if (
            item.next === "T"
        ) {
            scoreT += weight;
        } else {
            scoreX += weight;
        }

        if (
            !bestMatch ||
            weight >
            bestMatch.weight
        ) {
            bestMatch = {
                pattern:
                    item.pattern,

                cau:
                    item.template,

                matched,

                similarity:
                    bestSimilarity,

                confidence:
                    item.confidence,

                weight,

                next:
                    item.next
            };
        }
    }

    return {
        pattern:
            current,

        cau:
            bestMatch?.cau ||
            patternTemplate(
                current
            ),

        T:
            scoreT,

        X:
            scoreX
    };
}

// ============================================================
// DICE ANALYSIS
// ============================================================

function analyzeDice(
    history
) {
    const recent =
        history
            .filter(
                item =>
                    Array.isArray(
                        item.xuc_xac
                    )
            )
            .slice(-30);

    if (!recent.length) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    let T = 0;
    let X = 0;

    for (
        const item
        of recent
    ) {
        const total =
            diceTotal(
                item.xuc_xac,
                item.tong
            );

        if (
            !Number.isFinite(
                total
            )
        ) {
            continue;
        }

        if (
            total >= 11
        ) {
            if (
                item.result === "T"
            ) {
                T++;
            } else {
                X += 0.5;
            }
        } else {
            if (
                item.result === "X"
            ) {
                X++;
            } else {
                T += 0.5;
            }
        }
    }

    const total =
        T + X;

    if (!total) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    return {
        T: T / total,
        X: X / total
    };
}

// ============================================================
// PREDICTION
// ============================================================

function predict(
    engine
) {
    const history =
        engine.history;

    const patternData =
        analyzePattern(
            history
        );

    const markov =
        markovScore(
            history
        );

    const streak =
        streakAnalysis(
            patternData.pattern
        );

    const dist =
        distribution(
            history
        );

    const dice =
        analyzeDice(
            history
        );

    const learned =
        learningScore(
            engine,
            engine.lastDice
        );

    let scoreT = 0;
    let scoreX = 0;

    // Pattern
    scoreT +=
        patternData.T * 4;

    scoreX +=
        patternData.X * 4;

    // Markov
    scoreT +=
        markov.T * 2;

    scoreX +=
        markov.X * 2;

    // Streak
    scoreT +=
        streak.T * 1.5;

    scoreX +=
        streak.X * 1.5;

    // Distribution
    scoreT +=
        dist.T;

    scoreX +=
        dist.X;

    // Dice
    scoreT +=
        dice.T * 1.5;

    scoreX +=
        dice.X * 1.5;

    // Learning
    scoreT +=
        learned.T * 2;

    scoreX +=
        learned.X * 2;

    const total =
        scoreT + scoreX;

    let prediction;

    if (
        scoreT === scoreX
    ) {
        prediction =
            history.at(-1)
                ?.result === "T"
                ? "X"
                : "T";
    } else {
        prediction =
            scoreT > scoreX
                ? "T"
                : "X";
    }

    let confidence =
        total > 0
            ? Math.max(
                scoreT,
                scoreX
            ) / total
            : 0.5;

    confidence =
        clamp(
            confidence * 100,
            50,
            97
        );

    const rateTotal =
        scoreT +
        scoreX ||
        1;

    const tiLeTai =
        Math.round(
            (
                scoreT /
                rateTotal
            ) * 100
        );

    const tiLeXiu =
        Math.round(
            (
                scoreX /
                rateTotal
            ) * 100
        );

    return {
        side:
            prediction,

        du_doan:
            result(
                prediction
            ),

        do_tin_cay:
            `${Math.round(
                confidence
            )}%`,

        pattern:
            patternData.pattern,

        chi_tiet: {
            cau:
                patternData.cau,

            ti_le_tai:
                `${tiLeTai}%`,

            ti_le_xiu:
                `${tiLeXiu}%`,

            xu_huong:
                prediction === "T"
                    ? "Tài"
                    : "Xỉu"
        }
    };
}

// ============================================================
// CREATE ENGINE
// ============================================================

function createEngine(
    name,
    apiUrl
) {
    return {
        name,

        apiUrl,

        history: [],

        predictionHistory: [],

        learning:
            createLearning(),

        lastSessionId:
            null,

        lastDice: [],

        currentPrediction:
            null
    };
}

// ============================================================
// TÁCH RIÊNG HU / MD5
// ============================================================

const ttoan_hu =
    createEngine(
        "HU",
        HU_API
    );

const ttoan_md5 =
    createEngine(
        "MD5",
        MD5_API
    );

// ============================================================
// FETCH API
// ============================================================

async function fetchSource(
    engine
) {
    const response =
        await fetch(
            engine.apiUrl,
            {
                method: "GET",

                headers: {
                    Accept:
                        "application/json",

                    "User-Agent":
                        "LC79-Analyzer/1.0"
                },

                signal:
                    AbortSignal.timeout(
                        8000
                    )
            }
        );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    const json =
        await response.json();

    return safeArray(
        json?.list
    );
}

// ============================================================
// NORMALIZE
// ============================================================

function normalizeSession(
    item
) {
    const dices =
        normalizeDice(
            item.dices
        );

    const total =
        diceTotal(
            dices,
            item.point
        );

    const side =
        tx(
            item.resultTruyenThong
        );

    return {
        id:
            item.id,

        _id:
            item._id,

        result:
            side,

        phien:
            item.id,

        xuc_xac:
            dices,

        tong:
            total,

        ket_qua:
            result(side)
    };
}

// ============================================================
// FINALIZE PREDICTION
// ============================================================

function finalizePrediction(
    engine,
    actual
) {
    const prediction =
        engine
            .predictionHistory
            .find(
                item =>
                    String(
                        item.phien
                    ) ===
                    String(
                        actual.phien
                    ) &&
                    item.ket_qua ===
                    "⌛ Chờ Kết Quả"
            );

    if (!prediction) {
        return;
    }

    prediction.ket_qua =
        actual.ket_qua;

    prediction.xuc_xac =
        actual.xuc_xac;

    prediction.tong =
        actual.tong;

    const win =
        prediction.predictionSide ===
        actual.result;

    prediction.danh_gia =
        win
            ? "✅ Thắng"
            : "❌ Thua";

    updateLearning(
        engine,

        prediction.predictionSide,

        actual.result,

        actual.xuc_xac
    );
}

// ============================================================
// PROCESS SOURCE
// ============================================================

function processSource(
    engine,
    rawList
) {
    const normalized =
        rawList
            .map(
                normalizeSession
            )
            .filter(
                item =>
                    item.result
            );

    if (!normalized.length) {
        return;
    }

    /*
        API:
        MỚI -> CŨ

        Đảo lại:

        CŨ -> MỚI

        để pattern luôn:

        CŨ BÊN TRÁI
        MỚI BÊN PHẢI
    */

    const ascending =
        [...normalized]
            .reverse();

    for (
        const session
        of ascending
    ) {
        const exists =
            engine.history.some(
                item =>
                    String(
                        item.phien
                    ) ===
                    String(
                        session.phien
                    )
            );

        if (exists) {
            continue;
        }

        // Chốt prediction
        // nếu phiên này đã có kết quả.
        finalizePrediction(
            engine,
            session
        );

        // Lưu theo CŨ -> MỚI
        engine.history.push(
            session
        );

        if (
            engine.history.length >
            MAX_SOURCE_HISTORY
        ) {
            engine.history =
                engine.history.slice(
                    -MAX_SOURCE_HISTORY
                );
        }
    }

    const latest =
        normalized[0];

    engine.lastSessionId =
        latest.phien;

    engine.lastDice =
        latest.xuc_xac;
}

// ============================================================
// CREATE NEXT PREDICTION
// ============================================================

function createPrediction(
    engine
) {
    if (
        !engine.history.length
    ) {
        return null;
    }

    const latest =
        engine.history.at(-1);

    const nextPhien =
        Number(
            latest.phien
        ) + 1;

    const existed =
        engine
            .predictionHistory
            .find(
                item =>
                    String(
                        item.phien
                    ) ===
                    String(
                        nextPhien
                    )
            );

    if (existed) {
        engine.currentPrediction =
            existed;

        return existed;
    }

    const prediction =
        predict(engine);

    const item = {
        phien:
            nextPhien,

        phien_tham_chieu:
            latest.phien,

        du_doan:
            prediction.du_doan,

        predictionSide:
            prediction.side,

        ket_qua:
            "⌛ Chờ Kết Quả",

        xuc_xac:
            "⌛ Chờ",

        tong:
            "⌛ Chờ",

        danh_gia:
            "⌛ Chờ Kết Quả",

        do_tin_cay:
            prediction.do_tin_cay,

        pattern:
            prediction.pattern,

        chi_tiet:
            prediction.chi_tiet,

        thoi_gian:
            new Date()
                .toISOString()
    };

    engine
        .predictionHistory
        .push(item);

    if (
        engine
            .predictionHistory
            .length >
        MAX_PREDICTION_HISTORY
    ) {
        engine
            .predictionHistory =
            engine
                .predictionHistory
                .slice(
                    -MAX_PREDICTION_HISTORY
                );
    }

    engine.currentPrediction =
        item;

    return item;
}

// ============================================================
// SYNC
// ============================================================

async function syncEngine(
    engine
) {
    try {
        const list =
            await fetchSource(
                engine
            );

        processSource(
            engine,
            list
        );

        createPrediction(
            engine
        );

        console.log(
            `[${engine.name}] PHIEN=${engine.lastSessionId} | DU_DOAN=${engine.currentPrediction?.du_doan || "-"} | CONF=${engine.currentPrediction?.do_tin_cay || "-"} | PATTERN=${engine.currentPrediction?.pattern || "-"}`
        );

    } catch (error) {
        console.error(
            `[${engine.name}] ${error.message}`
        );
    }
}

// ============================================================
// CURRENT RESPONSE
// ============================================================

function getCurrentResponse(
    engine
) {
    const latest =
        engine.history.at(-1);

    const current =
        engine.currentPrediction;

    if (
        !latest ||
        !current
    ) {
        return {
            phien:
                null,

            xuc_xac:
                "⌛ Chờ",

            tong:
                "⌛ Chờ",

            ket_qua:
                "⌛ Chờ Kết Quả",

            phien_hien_tai:
                null,

            pattern:
                "",

            du_doan:
                "⌛ Đang Phân Tích",

            do_tin_cay:
                "0%",

            chi_tiet: {
                cau:
                    "",

                ti_le_tai:
                    "0%",

                ti_le_xiu:
                    "0%",

                xu_huong:
                    "Chưa xác định"
            }
        };
    }

    return {
        phien:
            current.phien,

        xuc_xac:
            current.xuc_xac,

        tong:
            current.tong,

        ket_qua:
            current.ket_qua,

        phien_hien_tai:
            latest.phien,

        pattern:
            current.pattern,

        du_doan:
            current.du_doan,

        do_tin_cay:
            current.do_tin_cay,

        chi_tiet:
            current.chi_tiet
    };
}

// ============================================================
// HISTORY
// CHỈ 6 FIELD
// ============================================================

function getHistoryResponse(
    engine
) {
    return engine
        .predictionHistory
        .slice()
        .reverse()
        .map(
            item => ({
                phien:
                    item.phien,

                du_doan:
                    item.du_doan,

                ket_qua:
                    item.ket_qua,

                danh_gia:
                    item.danh_gia,

                xuc_xac:
                    item.xuc_xac,

                tong:
                    item.tong
            })
        );
}

// ============================================================
// HU
// ============================================================

app.get(
    "/tx/lc79/hu",
    (req, res) => {
        res.json(
            getCurrentResponse(
                ttoan_hu
            )
        );
    }
);

app.get(
    "/tx/lc79/hu/history",
    (req, res) => {
        res.json(
            getHistoryResponse(
                ttoan_hu
            )
        );
    }
);

// ============================================================
// MD5
// ============================================================

app.get(
    "/tx/lc79/md5",
    (req, res) => {
        res.json(
            getCurrentResponse(
                ttoan_md5
            )
        );
    }
);

app.get(
    "/tx/lc79/md5/history",
    (req, res) => {
        res.json(
            getHistoryResponse(
                ttoan_md5
            )
        );
    }
);

// ============================================================
// STATUS
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "LC79 Analyzer",

            version:
                "1.0.0",

            engines: {
                hu: {
                    history:
                        ttoan_hu
                            .history
                            .length,

                    predictions:
                        ttoan_hu
                            .predictionHistory
                            .length
                },

                md5: {
                    history:
                        ttoan_md5
                            .history
                            .length,

                    predictions:
                        ttoan_md5
                            .predictionHistory
                            .length
                }
            },

            endpoints: [
                "/tx/lc79/hu",
                "/tx/lc79/hu/history",
                "/tx/lc79/md5",
                "/tx/lc79/md5/history"
            ]
        });
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    HOST,
    () => {
        console.log(
            "============================================================"
        );

        console.log(
            "🚀 LC79 ANALYZER"
        );

        console.log(
            "============================================================"
        );

        console.log(
            `🌐 HTTP: http://${HOST}:${PORT}`
        );

        console.log(
            `🟢 HU : ${HU_API}`
        );

        console.log(
            `🟣 MD5: ${MD5_API}`
        );

        console.log(
            "============================================================"
        );

        syncEngine(
            ttoan_hu
        );

        syncEngine(
            ttoan_md5
        );

        setInterval(
            () => {
                syncEngine(
                    ttoan_hu
                );

                syncEngine(
                    ttoan_md5
                );
            },
            FETCH_INTERVAL
        );
    }
);
