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
// MODEL CONFIG
// HU + MD5 DÙNG CÙNG HỆ MODEL
// NHƯNG DATA LEARNING TÁCH RIÊNG
// ============================================================

const MODELS = {
    pattern: 4.0,
    patternMatch: 3.0,
    markov: 2.0,
    streak: 1.5,
    distribution: 1.0,
    dice: 2.0,
    learning: 2.0,
    transition: 1.5,
    repeat: 1.0,
    opposite: 1.0
};

// ============================================================
// PATTERN LIBRARY
// DỄ -> KHÓ
// ============================================================

const PATTERN_LIBRARY = {
    level1: [
        "1-1",
        "1-2",
        "2-1",
        "2-2",
        "3-1",
        "1-3",
        "3-2",
        "2-3",
        "4-1",
        "1-4"
    ],

    level2: [
        "1-1-1",
        "1-2-1",
        "2-1-2",
        "1-3-1",
        "3-1-3",
        "2-2-1",
        "1-2-2",
        "2-1-1"
    ],

    level3: [
        "1-1-1-1",
        "1-2-1-2",
        "2-1-2-1",
        "1-3-1-3",
        "3-1-3-1",
        "1-2-2-1",
        "2-1-1-2"
    ],

    level4: [
        "TXTX",
        "XTXT",
        "TXXT",
        "XTTX",
        "TTXX",
        "XXTT",
        "TXTTX",
        "XTXTX"
    ],

    level5: [
        "1-3-1-2-1",
        "2-1-3-1-2",
        "1-2-1-3-2",
        "2-2-1-1-2",
        "1-3-2-1-3",
        "3-1-2-2-1"
    ],

    level6: [
        "1-2-1-2-1-2",
        "2-1-2-1-2-1",
        "1-3-1-3-1",
        "3-1-3-1-3",
        "1-2-2-1-2-2"
    ]
};

// ============================================================
// BASIC
// ============================================================

function tx(value) {
    if (!value) return null;

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

function result(value) {
    if (value === "T") return "Tài";
    if (value === "X") return "Xỉu";
    return null;
}

function opposite(value) {
    return value === "T" ? "X" : "T";
}

function clamp(value, min, max) {
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

function diceTotal(dices, point) {
    const arr =
        normalizeDice(dices);

    if (arr.length) {
        return arr.reduce(
            (a, b) => a + b,
            0
        );
    }

    const p = Number(point);

    return Number.isFinite(p)
        ? p
        : null;
}

// ============================================================
// SIMILARITY
// ============================================================

function similarity(a, b) {
    if (!a || !b) return 0;

    const len =
        Math.min(
            a.length,
            b.length
        );

    if (!len) return 0;

    let same = 0;

    for (
        let i = 0;
        i < len;
        i++
    ) {
        if (a[i] === b[i]) {
            same++;
        }
    }

    const positional =
        same / len;

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
// RUN
// ============================================================

function getRuns(pattern) {
    if (!pattern) return [];

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
// CẦU: 1-3-1
// ============================================================

function patternTemplate(pattern) {
    return getRuns(pattern)
        .map(
            item =>
                item.count
        )
        .join("-");
}

// ============================================================
// PATTERN CHÍNH
// CŨ -> MỚI
// ============================================================

function buildPattern(
    history,
    length = MAX_PATTERN
) {
    return history
        .slice(-length)
        .map(
            item =>
                item.result
        )
        .filter(Boolean)
        .join("");
}

// ============================================================
// PATTERN LEVEL
// ============================================================

function getPatternLevel(template) {
    for (
        const [level, patterns]
        of Object.entries(
            PATTERN_LIBRARY
        )
    ) {
        if (
            patterns.includes(
                template
            )
        ) {
            return Number(
                level.replace(
                    "level",
                    ""
                )
            );
        }
    }

    return 0;
}

// ============================================================
// TRANSFORM
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

function transformPatterns(pattern) {
    if (!pattern) return [];

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
// PATTERN WEIGHT
// ============================================================

function patternWeight(
    sample,
    sim
) {
    const level =
        sample.level || 0;

    const lengthWeight =
        Math.min(
            sample.length / 10,
            1.5
        );

    const levelWeight =
        level >= 6
            ? 1.50
            : level >= 5
                ? 1.35
                : level >= 4
                    ? 1.20
                    : level >= 3
                        ? 1.10
                        : level >= 2
                            ? 1.00
                            : 0.90;

    const sampleWeight =
        Math.min(
            sample.samples / 5,
            1.5
        );

    return (
        sim *
        lengthWeight *
        levelWeight *
        sampleWeight
    );
}

// ============================================================
// MINE PATTERNS
// ============================================================

function mineAdvancedPatterns(history) {
    const database = [];

    const values =
        history
            .map(
                x => x.result
            )
            .filter(Boolean);

    if (values.length < 5) {
        return database;
    }

    for (
        let length = 2;
        length <= 15;
        length++
    ) {
        const grouped = {};

        for (
            let i = 0;
            i + length <
            values.length;
            i++
        ) {
            const pattern =
                values
                    .slice(
                        i,
                        i + length
                    )
                    .join("");

            const next =
                values[
                    i + length
                ];

            if (!next) continue;

            const template =
                patternTemplate(
                    pattern
                );

            if (
                !grouped[pattern]
            ) {
                grouped[pattern] = {
                    T: 0,
                    X: 0
                };
            }

            grouped[
                pattern
            ][next]++;
        }

        for (
            const [
                pattern,
                stats
            ]
            of Object.entries(
                grouped
            )
        ) {
            const samples =
                stats.T +
                stats.X;

            if (!samples) {
                continue;
            }

            const template =
                patternTemplate(
                    pattern
                );

            database.push({
                pattern,

                template,

                next:
                    stats.T >=
                    stats.X
                        ? "T"
                        : "X",

                T:
                    stats.T,

                X:
                    stats.X,

                samples,

                length,

                level:
                    getPatternLevel(
                        template
                    ),

                confidence:
                    Math.max(
                        stats.T,
                        stats.X
                    ) /
                    samples
            });
        }
    }

    return database;
}

// ============================================================
// ADVANCED PATTERN ANALYSIS
// ============================================================

function analyzeAdvancedPattern(
    engine
) {
    const history =
        engine.history;

    const mainPattern =
        buildPattern(
            history,
            MAX_PATTERN
        );

    if (!mainPattern) {
        return {
            pattern: "",
            cau: "",
            T: 0,
            X: 0,
            matches: []
        };
    }

    const database =
        engine.patternDatabase;

    let scoreT = 0;
    let scoreX = 0;

    const matches = [];

    // ==========================================
    // NHIỀU ĐỘ DÀI
    // ==========================================

    for (
        let length = 2;
        length <=
        Math.min(
            15,
            mainPattern.length
        );
        length++
    ) {
        const current =
            mainPattern.slice(
                -length
            );

        for (
            const sample
            of database
        ) {
            if (
                sample.length !==
                length
            ) {
                continue;
            }

            const variants =
                transformPatterns(
                    sample.pattern
                );

            let bestSim = 0;
            let matched = "";

            for (
                const variant
                of variants
            ) {
                const sim =
                    similarity(
                        current,
                        variant
                    );

                if (
                    sim > bestSim
                ) {
                    bestSim = sim;
                    matched =
                        variant;
                }
            }

            if (
                bestSim < 0.55
            ) {
                continue;
            }

            const weight =
                patternWeight(
                    sample,
                    bestSim
                );

            const finalWeight =
                weight *
                engine.models
                    .patternMatch
                    .weight;

            if (
                sample.next === "T"
            ) {
                scoreT +=
                    finalWeight;
            } else {
                scoreX +=
                    finalWeight;
            }

            matches.push({
                level:
                    sample.level,

                cau:
                    sample.template,

                pattern:
                    sample.pattern,

                matched,

                next:
                    result(
                        sample.next
                    ),

                similarity:
                    Number(
                        bestSim.toFixed(
                            2
                        )
                    ),

                samples:
                    sample.samples,

                weight:
                    Number(
                        finalWeight.toFixed(
                            3
                        )
                    )
            });
        }
    }

    matches.sort(
        (a, b) =>
            b.weight -
            a.weight
    );

    // ==========================================
    // CẦU CHÍNH
    // ==========================================

    const cau =
        patternTemplate(
            mainPattern
        );

    return {
        pattern:
            mainPattern,

        cau,

        T:
            scoreT,

        X:
            scoreX,

        matches:
            matches.slice(
                0,
                50
            )
    };
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

function streakAnalysis(pattern) {
    if (!pattern) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const runs =
        getRuns(pattern);

    const last =
        runs.at(-1);

    if (!last) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    if (
        last.value === "T"
    ) {
        return {
            T:
                Math.min(
                    last.count / 5,
                    1
                ),

            X: 0
        };
    }

    return {
        T: 0,

        X:
            Math.min(
                last.count / 5,
                1
            )
    };
}

// ============================================================
// DISTRIBUTION
// ============================================================

function distribution(history) {
    const recent =
        history.slice(-30);

    let T = 0;
    let X = 0;

    for (
        const item of recent
    ) {
        if (
            item.result === "T"
        ) T++;

        if (
            item.result === "X"
        ) X++;
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
// TRANSITION
// ============================================================

function transitionScore(history) {
    if (
        history.length < 3
    ) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    let T = 0;
    let X = 0;

    for (
        let i = 2;
        i < history.length;
        i++
    ) {
        const a =
            history[i - 2]
                .result;

        const b =
            history[i - 1]
                .result;

        const c =
            history[i]
                .result;

        if (
            a === b &&
            b === c
        ) {
            if (c === "T") T++;
            if (c === "X") X++;
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
// REPEAT
// ============================================================

function repeatScore(history) {
    if (
        history.length < 2
    ) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const last =
        history.at(-1)
            .result;

    const prev =
        history.at(-2)
            .result;

    if (
        last === prev
    ) {
        return {
            T:
                last === "T"
                    ? 1
                    : 0,

            X:
                last === "X"
                    ? 1
                    : 0
        };
    }

    return {
        T: 0.5,
        X: 0.5
    };
}

// ============================================================
// OPPOSITE
// ============================================================

function oppositeScore(history) {
    if (
        history.length < 2
    ) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const last =
        history.at(-1)
            .result;

    return {
        T:
            last === "X"
                ? 1
                : 0,

        X:
            last === "T"
                ? 1
                : 0
    };
}

// ============================================================
// DICE MODEL
// ============================================================

function analyzeDice(history) {
    const recent =
        history
            .filter(
                x =>
                    Array.isArray(
                        x.xuc_xac
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
        const item of recent
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
// LEARNING
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
        learning.T.win /
        tTotal;

    let X =
        learning.X.win /
        xTotal;

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

        const count =
            dice.T + dice.X;

        if (count > 0) {
            T =
                T * 0.65 +
                (
                    dice.T /
                    count
                ) * 0.35;

            X =
                X * 0.65 +
                (
                    dice.X /
                    count
                ) * 0.35;
        }
    }

    return {
        T,
        X
    };
}

// ============================================================
// MODEL SCORE
// ============================================================

function calculateModelScores(
    engine
) {
    const history =
        engine.history;

    const patternData =
        analyzeAdvancedPattern(
            engine
        );

    const markov =
        markovScore(
            history
        );

    const streak =
        streakAnalysis(
            buildPattern(
                history
            )
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

    const transition =
        transitionScore(
            history
        );

    const repeat =
        repeatScore(
            history
        );

    const opposite =
        oppositeScore(
            history
        );

    let T = 0;
    let X = 0;

    // Pattern
    T +=
        patternData.T *
        MODELS.pattern;

    X +=
        patternData.X *
        MODELS.pattern;

    // Pattern match
    T +=
        patternData.T *
        MODELS.patternMatch;

    X +=
        patternData.X *
        MODELS.patternMatch;

    // Markov
    T +=
        markov.T *
        MODELS.markov;

    X +=
        markov.X *
        MODELS.markov;

    // Streak
    T +=
        streak.T *
        MODELS.streak;

    X +=
        streak.X *
        MODELS.streak;

    // Distribution
    T +=
        dist.T *
        MODELS.distribution;

    X +=
        dist.X *
        MODELS.distribution;

    // Dice
    T +=
        dice.T *
        MODELS.dice;

    X +=
        dice.X *
        MODELS.dice;

    // Learning
    T +=
        learned.T *
        MODELS.learning;

    X +=
        learned.X *
        MODELS.learning;

    // Transition
    T +=
        transition.T *
        MODELS.transition;

    X +=
        transition.X *
        MODELS.transition;

    // Repeat
    T +=
        repeat.T *
        MODELS.repeat;

    X +=
        repeat.X *
        MODELS.repeat;

    // Opposite
    T +=
        opposite.T *
        MODELS.opposite;

    X +=
        opposite.X *
        MODELS.opposite;

    return {
        T,
        X,

        patternData,
        markov,
        streak,
        dist,
        dice,
        learned,
        transition,
        repeat,
        opposite
    };
}

// ============================================================
// PREDICT
// ============================================================

function predict(engine) {
    const scores =
        calculateModelScores(
            engine
        );

    const T =
        scores.T;

    const X =
        scores.X;

    const total =
        T + X || 1;

    const side =
        T >= X
            ? "T"
            : "X";

    const confidence =
        clamp(
            Math.max(T, X) /
            total *
            100,
            50,
            97
        );

    const tiLeTai =
        Math.round(
            T / total * 100
        );

    const tiLeXiu =
        Math.round(
            X / total * 100
        );

    return {
        side,

        du_doan:
            result(side),

        do_tin_cay:
            `${Math.round(
                confidence
            )}%`,

        pattern:
            scores
                .patternData
                .pattern,

        chi_tiet: {
            cau:
                scores
                    .patternData
                    .cau,

            ti_le_tai:
                `${tiLeTai}%`,

            ti_le_xiu:
                `${tiLeXiu}%`,

            xu_huong:
                result(side)
        }
    };
}

// ============================================================
// ENGINE
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

        patternDatabase: [],

        learning:
            createLearning(),

        models: {
            ...MODELS
        },

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
// FETCH
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

function normalizeSession(item) {
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
            Number(item.id),

        xuc_xac:
            dices,

        tong:
            total,

        ket_qua:
            result(side)
    };
}

// ============================================================
// FINALIZE
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
                        item.phien_hien_tai
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
// PROCESS
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

    // API MỚI -> CŨ
    // Chuyển thành CŨ -> MỚI

    const ascending =
        [...normalized]
            .sort(
                (a, b) =>
                    a.phien -
                    b.phien
            );

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

        // Chốt prediction cũ
        finalizePrediction(
            engine,
            session
        );

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
        engine.history.at(-1);

    if (!latest) return;

    engine.lastSessionId =
        latest.phien;

    engine.lastDice =
        latest.xuc_xac;

    // Rebuild database
    engine.patternDatabase =
        mineAdvancedPatterns(
            engine.history
        );
}

// ============================================================
// CREATE PREDICTION
// ============================================================

function createPrediction(
    engine
) {
    if (
        !engine.history.length
    ) {
        return null;
    }

    const phienTruoc =
        engine.history.at(-1);

    const phienHienTai =
        Number(
            phienTruoc.phien
        ) + 1;

    const existed =
        engine
            .predictionHistory
            .find(
                item =>
                    String(
                        item.phien_hien_tai
                    ) ===
                    String(
                        phienHienTai
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
        // Phiên đã kết thúc
        phien:
            phienTruoc.phien,

        // Phiên đang dự đoán
        phien_hien_tai:
            phienHienTai,

        du_doan:
            prediction.du_doan,

        predictionSide:
            prediction.side,

        // Thông tin phiên trước
        ket_qua:
            phienTruoc.ket_qua,

        xuc_xac:
            phienTruoc.xuc_xac,

        tong:
            phienTruoc.tong,

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
            `[${engine.name}] ` +
            `PHIEN=${engine.currentPrediction?.phien} | ` +
            `HIEN_TAI=${engine.currentPrediction?.phien_hien_tai} | ` +
            `DU_DOAN=${engine.currentPrediction?.du_doan} | ` +
            `CONF=${engine.currentPrediction?.do_tin_cay} | ` +
            `PATTERN=${engine.currentPrediction?.pattern}`
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
    const phienTruoc =
        engine.history.at(-1);

    const current =
        engine.currentPrediction;

    if (
        !phienTruoc ||
        !current
    ) {
        return {
            phien: null,

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
        // PHIÊN TRƯỚC
        phien:
            phienTruoc.phien,

        xuc_xac:
            phienTruoc.xuc_xac,

        tong:
            phienTruoc.tong,

        ket_qua:
            phienTruoc.ket_qua,

        // PHIÊN HIỆN TẠI
        phien_hien_tai:
            current.phien_hien_tai,

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
// DEBUG MODEL
// ============================================================

app.get(
    "/tx/lc79/hu/models",
    (req, res) => {
        res.json({
            engine: "HU",

            models:
                ttoan_hu.models,

            pattern_count:
                ttoan_hu
                    .patternDatabase
                    .length,

            learning:
                ttoan_hu.learning
        });
    }
);

app.get(
    "/tx/lc79/md5/models",
    (req, res) => {
        res.json({
            engine: "MD5",

            models:
                ttoan_md5.models,

            pattern_count:
                ttoan_md5
                    .patternDatabase
                    .length,

            learning:
                ttoan_md5.learning
        });
    }
);

// ============================================================
// ROOT
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
                "2.0.0",

            engines: {
                hu: {
                    history:
                        ttoan_hu
                            .history
                            .length,

                    predictions:
                        ttoan_hu
                            .predictionHistory
                            .length,

                    patterns:
                        ttoan_hu
                            .patternDatabase
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
                            .length,

                    patterns:
                        ttoan_md5
                            .patternDatabase
                            .length
                }
            },

            endpoints: [
                "/tx/lc79/hu",
                "/tx/lc79/hu/history",
                "/tx/lc79/hu/models",
                "/tx/lc79/md5",
                "/tx/lc79/md5/history",
                "/tx/lc79/md5/models"
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
            "🚀 LC79 ANALYZER 2.0"
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
