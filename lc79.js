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

const MAX_PATTERN_LENGTH = 20;
const COMPARE_CURRENT_COUNT = 6;
const COMPARE_SAMPLE_COUNT = 6;

const FETCH_INTERVAL = 3000;

// ============================================================
// MODEL
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
// SAFE
// ============================================================

function finiteNumber(value, fallback = 0) {
    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;
}

function clamp(value, min, max) {
    value = finiteNumber(value, min);

    return Math.max(
        min,
        Math.min(max, value)
    );
}

function safeRatio(a, b, fallback = 0.5) {
    a = finiteNumber(a, 0);
    b = finiteNumber(b, 0);

    if (b <= 0) {
        return fallback;
    }

    const result = a / b;

    return Number.isFinite(result)
        ? clamp(result, 0, 1)
        : fallback;
}

function safeArray(value) {
    return Array.isArray(value)
        ? value
        : [];
}

// ============================================================
// RESULT
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
            n => Number.isFinite(n)
        );
}

function diceTotal(dices, point) {
    const arr =
        normalizeDice(dices);

    if (arr.length > 0) {
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
// NORMALIZE API
// ============================================================

function normalizeSession(item) {
    const id =
        Number(item?.id);

    if (!Number.isFinite(id)) {
        return null;
    }

    const resultSide =
        tx(
            item?.resultTruyenThong
        );

    if (!resultSide) {
        return null;
    }

    const dices =
        normalizeDice(
            item?.dices
        );

    const total =
        diceTotal(
            dices,
            item?.point
        );

    return {
        id,

        _id:
            item?._id || null,

        phien:
            id,

        result:
            resultSide,

        ket_qua:
            result(resultSide),

        xuc_xac:
            dices,

        tong:
            finiteNumber(
                total,
                0
            )
    };
}

// ============================================================
// PATTERN
// ============================================================

function buildPattern(
    history,
    length = MAX_PATTERN_LENGTH
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
// CẦU
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

function patternTemplate(pattern) {
    return getRuns(pattern)
        .map(
            x =>
                x.count
        )
        .join("-");
}

// ============================================================
// 6 PATTERN HIỆN TẠI
// ============================================================

function getLatest6Patterns(pattern) {
    if (
        !pattern ||
        pattern.length < 2
    ) {
        return [];
    }

    const result = [];

    const maxLength =
        Math.min(
            MAX_PATTERN_LENGTH,
            pattern.length
        );

    for (
        let length = 2;
        length <= maxLength;
        length++
    ) {
        result.push(
            pattern.slice(-length)
        );
    }

    // Chỉ lấy 6 pattern mới nhất
    return result.slice(
        -COMPARE_CURRENT_COUNT
    );
}

// ============================================================
// PATTERN TRANSFORM
// ============================================================

function oppositePattern(pattern) {
    return pattern
        .split("")
        .map(
            x => opposite(x)
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

    if (length <= 0) {
        return 0;
    }

    let same = 0;

    for (
        let i = 0;
        i < length;
        i++
    ) {
        if (
            a[i] === b[i]
        ) {
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

    return finiteNumber(
        positional * 0.8 +
        lengthFactor * 0.2,
        0
    );
}

// ============================================================
// PATTERN LEVEL
// ============================================================

function patternLevel(pattern) {
    const runs =
        getRuns(pattern);

    const template =
        patternTemplate(pattern);

    let level = 1;

    if (
        runs.length >= 2
    ) {
        level = 2;
    }

    if (
        runs.length >= 3
    ) {
        level = 3;
    }

    if (
        runs.length >= 5
    ) {
        level = 4;
    }

    if (
        runs.length >= 7
    ) {
        level = 5;
    }

    if (
        runs.length >= 9
    ) {
        level = 6;
    }

    // Pattern càng dài càng khó
    if (pattern.length >= 12) {
        level = Math.max(
            level,
            5
        );
    }

    if (pattern.length >= 16) {
        level = 6;
    }

    return {
        level,
        template
    };
}

// ============================================================
// MINE PATTERN DATABASE
// ============================================================

function minePatterns(history) {
    const values =
        history
            .map(
                x =>
                    x.result
            )
            .filter(Boolean);

    const database = [];

    if (
        values.length < 4
    ) {
        return database;
    }

    for (
        let length = 2;
        length <=
        Math.min(
            15,
            values.length - 1
        );
        length++
    ) {
        const groups = {};

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

            if (!next) {
                continue;
            }

            if (
                !groups[pattern]
            ) {
                groups[pattern] = {
                    T: 0,
                    X: 0
                };
            }

            if (next === "T") {
                groups[pattern].T++;
            }

            if (next === "X") {
                groups[pattern].X++;
            }
        }

        for (
            const [
                pattern,
                stats
            ]
            of Object.entries(
                groups
            )
        ) {
            const samples =
                stats.T +
                stats.X;

            if (
                samples <= 0
            ) {
                continue;
            }

            const info =
                patternLevel(
                    pattern
                );

            database.push({
                pattern,

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
                    info.level,

                template:
                    info.template,

                confidence:
                    safeRatio(
                        Math.max(
                            stats.T,
                            stats.X
                        ),
                        samples
                    )
            });
        }
    }

    return database;
}

// ============================================================
// PATTERN WEIGHT
// ============================================================

function patternWeight(
    sample,
    similarityValue
) {
    const length =
        finiteNumber(
            sample.length,
            2
        );

    const samples =
        finiteNumber(
            sample.samples,
            1
        );

    const level =
        finiteNumber(
            sample.level,
            1
        );

    const lengthWeight =
        clamp(
            length / 8,
            0.5,
            2
        );

    const sampleWeight =
        clamp(
            samples / 5,
            0.5,
            2
        );

    const levelWeight =
        clamp(
            level / 3,
            0.7,
            2
        );

    return finiteNumber(
        similarityValue *
        lengthWeight *
        sampleWeight *
        levelWeight,
        0
    );
}

// ============================================================
// PHÂN TÍCH 6 × 6
// ============================================================

function analyzeAdvancedPattern(
    engine
) {
    const mainPattern =
        buildPattern(
            engine.history
        );

    if (
        mainPattern.length < 2
    ) {
        return {
            pattern:
                mainPattern,

            cau:
                patternTemplate(
                    mainPattern
                ),

            T: 0,

            X: 0,

            matches: []
        };
    }

    // --------------------------------------------------------
    // 6 PATTERN HIỆN TẠI
    // --------------------------------------------------------

    const currentPatterns =
        getLatest6Patterns(
            mainPattern
        );

    // --------------------------------------------------------
    // DATABASE MẪU
    // --------------------------------------------------------

    const database =
        engine.patternDatabase;

    const candidates = [];

    // --------------------------------------------------------
    // SO SÁNH
    // --------------------------------------------------------

    for (
        const currentPattern
        of currentPatterns
    ) {
        for (
            const sample
            of database
        ) {
            // Không lấy pattern quá khác độ dài
            if (
                Math.abs(
                    currentPattern.length -
                    sample.length
                ) > 5
            ) {
                continue;
            }

            const variants =
                transformPatterns(
                    sample.pattern
                );

            let bestSimilarity = 0;

            let matchedPattern =
                sample.pattern;

            for (
                const variant
                of variants
            ) {
                const sim =
                    similarity(
                        currentPattern,
                        variant
                    );

                if (
                    sim >
                    bestSimilarity
                ) {
                    bestSimilarity =
                        sim;

                    matchedPattern =
                        variant;
                }
            }

            if (
                !Number.isFinite(
                    bestSimilarity
                )
            ) {
                continue;
            }

            if (
                bestSimilarity < 0.55
            ) {
                continue;
            }

            const weight =
                patternWeight(
                    sample,
                    bestSimilarity
                );

            candidates.push({
                current:
                    currentPattern,

                sample,

                matched:
                    matchedPattern,

                similarity:
                    bestSimilarity,

                weight
            });
        }
    }

    // --------------------------------------------------------
    // SẮP XẾP PATTERN MẪU
    // --------------------------------------------------------

    candidates.sort(
        (a, b) => {
            const simDiff =
                b.similarity -
                a.similarity;

            if (
                Math.abs(simDiff) >
                0.001
            ) {
                return simDiff;
            }

            return (
                b.weight -
                a.weight
            );
        }
    );

    // --------------------------------------------------------
    // CHỈ LẤY 6 PATTERN MẪU
    // --------------------------------------------------------

    const best6 =
        candidates.slice(
            0,
            COMPARE_SAMPLE_COUNT
        );

    // --------------------------------------------------------
    // TỔNG HỢP
    // --------------------------------------------------------

    let scoreT = 0;
    let scoreX = 0;

    const matches = [];

    for (
        const item
        of best6
    ) {
        const sample =
            item.sample;

        const sim =
            finiteNumber(
                item.similarity,
                0
            );

        const weight =
            finiteNumber(
                item.weight,
                0
            );

        const finalWeight =
            finiteNumber(
                weight *
                MODELS.patternMatch,
                0
            );

        if (
            sample.next === "T"
        ) {
            scoreT +=
                finalWeight;
        }

        if (
            sample.next === "X"
        ) {
            scoreX +=
                finalWeight;
        }

        matches.push({
            pattern_cu:
                item.current,

            pattern_mau:
                sample.pattern,

            cau:
                sample.template,

            du_doan:
                result(
                    sample.next
                ),

            similarity:
                Number(
                    sim.toFixed(2)
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

    return {
        pattern:
            mainPattern,

        cau:
            patternTemplate(
                mainPattern
            ),

        T:
            finiteNumber(
                scoreT,
                0
            ),

        X:
            finiteNumber(
                scoreX,
                0
            ),

        matches
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
            history[
                i - 1
            ]?.result;

        const b =
            history[i]
                ?.result;

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

    const T =
        last === "T"
            ? count.TT
            : count.XT;

    const X =
        last === "T"
            ? count.TX
            : count.XX;

    const total =
        T + X;

    return {
        T:
            safeRatio(
                T,
                total
            ),

        X:
            safeRatio(
                X,
                total
            )
    };
}

// ============================================================
// STREAK
// ============================================================

function streakScore(pattern) {
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

    const strength =
        clamp(
            last.count / 6,
            0,
            1
        );

    if (
        last.value === "T"
    ) {
        return {
            T: strength,
            X: 1 - strength
        };
    }

    return {
        T: 1 - strength,
        X: strength
    };
}

// ============================================================
// DISTRIBUTION
// ============================================================

function distributionScore(
    history
) {
    const recent =
        history.slice(-30);

    let T = 0;
    let X = 0;

    for (
        const item
        of recent
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

    return {
        T:
            safeRatio(
                T,
                total
            ),

        X:
            safeRatio(
                X,
                total
            )
    };
}

// ============================================================
// TRANSITION
// ============================================================

function transitionScore(
    history
) {
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
            history[
                i - 2
            ]?.result;

        const b =
            history[
                i - 1
            ]?.result;

        const c =
            history[i]
                ?.result;

        if (
            a === b &&
            b === c
        ) {
            if (c === "T") {
                T++;
            }

            if (c === "X") {
                X++;
            }
        }
    }

    const total =
        T + X;

    return {
        T:
            safeRatio(
                T,
                total
            ),

        X:
            safeRatio(
                X,
                total
            )
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

    const a =
        history.at(-1)
            ?.result;

    const b =
        history.at(-2)
            ?.result;

    if (
        a &&
        a === b
    ) {
        return {
            T:
                a === "T"
                    ? 1
                    : 0,

            X:
                a === "X"
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

function oppositeScore(
    history
) {
    const last =
        history.at(-1)
            ?.result;

    if (!last) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

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

function diceScore(history) {
    const recent =
        history
            .filter(
                item =>
                    Array.isArray(
                        item.xuc_xac
                    )
            )
            .slice(-30);

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
            T++;
        } else {
            X++;
        }
    }

    const total =
        T + X;

    if (total <= 0) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    return {
        T:
            safeRatio(
                T,
                total
            ),

        X:
            safeRatio(
                X,
                total
            )
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
    predicted,
    actual,
    dices
) {
    if (
        !predicted ||
        !actual
    ) {
        return;
    }

    if (
        predicted !== "T" &&
        predicted !== "X"
    ) {
        return;
    }

    if (
        actual !== "T" &&
        actual !== "X"
    ) {
        return;
    }

    const win =
        predicted === actual;

    engine.learning
        .totalPredictions++;

    if (win) {
        engine.learning
            .totalWins++;

        engine.learning[
            predicted
        ].win++;
    } else {
        engine.learning
            .totalLosses++;

        engine.learning[
            predicted
        ].lose++;
    }

    const total =
        diceTotal(dices);

    if (
        Number.isFinite(
            total
        )
    ) {
        const group =
            total >= 11
                ? "high"
                : "low";

        engine.learning
            .dice[group][
                actual
            ]++;
    }
}

function learningScore(
    engine
) {
    const data =
        engine.learning;

    const tTotal =
        data.T.win +
        data.T.lose;

    const xTotal =
        data.X.win +
        data.X.lose;

    return {
        T:
            safeRatio(
                data.T.win,
                tTotal
            ),

        X:
            safeRatio(
                data.X.win,
                xTotal
            )
    };
}

// ============================================================
// CALCULATE ALL MODELS
// ============================================================

function calculateScores(
    engine
) {
    const pattern =
        analyzeAdvancedPattern(
            engine
        );

    const markov =
        markovScore(
            engine.history
        );

    const streak =
        streakScore(
            buildPattern(
                engine.history
            )
        );

    const distribution =
        distributionScore(
            engine.history
        );

    const dice =
        diceScore(
            engine.history
        );

    const learning =
        learningScore(
            engine
        );

    const transition =
        transitionScore(
            engine.history
        );

    const repeat =
        repeatScore(
            engine.history
        );

    const opposite =
        oppositeScore(
            engine.history
        );

    let T = 0;
    let X = 0;

    T +=
        finiteNumber(
            pattern.T,
            0
        ) *
        MODELS.pattern;

    X +=
        finiteNumber(
            pattern.X,
            0
        ) *
        MODELS.pattern;

    T +=
        finiteNumber(
            pattern.T,
            0
        ) *
        MODELS.patternMatch;

    X +=
        finiteNumber(
            pattern.X,
            0
        ) *
        MODELS.patternMatch;

    T +=
        finiteNumber(
            markov.T,
            0.5
        ) *
        MODELS.markov;

    X +=
        finiteNumber(
            markov.X,
            0.5
        ) *
        MODELS.markov;

    T +=
        finiteNumber(
            streak.T,
            0.5
        ) *
        MODELS.streak;

    X +=
        finiteNumber(
            streak.X,
            0.5
        ) *
        MODELS.streak;

    T +=
        finiteNumber(
            distribution.T,
            0.5
        ) *
        MODELS.distribution;

    X +=
        finiteNumber(
            distribution.X,
            0.5
        ) *
        MODELS.distribution;

    T +=
        finiteNumber(
            dice.T,
            0.5
        ) *
        MODELS.dice;

    X +=
        finiteNumber(
            dice.X,
            0.5
        ) *
        MODELS.dice;

    T +=
        finiteNumber(
            learning.T,
            0.5
        ) *
        MODELS.learning;

    X +=
        finiteNumber(
            learning.X,
            0.5
        ) *
        MODELS.learning;

    T +=
        finiteNumber(
            transition.T,
            0.5
        ) *
        MODELS.transition;

    X +=
        finiteNumber(
            transition.X,
            0.5
        ) *
        MODELS.transition;

    T +=
        finiteNumber(
            repeat.T,
            0.5
        ) *
        MODELS.repeat;

    X +=
        finiteNumber(
            repeat.X,
            0.5
        ) *
        MODELS.repeat;

    T +=
        finiteNumber(
            opposite.T,
            0.5
        ) *
        MODELS.opposite;

    X +=
        finiteNumber(
            opposite.X,
            0.5
        ) *
        MODELS.opposite;

    return {
        T:
            finiteNumber(T, 0),

        X:
            finiteNumber(X, 0),

        pattern,

        markov,
        streak,
        distribution,
        dice,
        learning,
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
        calculateScores(
            engine
        );

    let T =
        finiteNumber(
            scores.T,
            0
        );

    let X =
        finiteNumber(
            scores.X,
            0
        );

    if (T < 0) T = 0;
    if (X < 0) X = 0;

    let total =
        T + X;

    if (
        !Number.isFinite(
            total
        ) ||
        total <= 0
    ) {
        T = 0.5;
        X = 0.5;
        total = 1;
    }

    const ratioT =
        safeRatio(
            T,
            total
        );

    const ratioX =
        safeRatio(
            X,
            total
        );

    const side =
        ratioT >= ratioX
            ? "T"
            : "X";

    let confidence =
        Math.max(
            ratioT,
            ratioX
        ) * 100;

    confidence =
        clamp(
            confidence,
            50,
            97
        );

    const patternData =
        scores.pattern;

    return {
        side,

        du_doan:
            result(side),

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
                `${Math.round(
                    ratioT * 100
                )}%`,

            ti_le_xiu:
                `${Math.round(
                    ratioX * 100
                )}%`,

            xu_huong:
                result(side)
        },

        pattern_matches:
            patternData.matches
    };
}

// ============================================================
// ENGINE
// ============================================================

function createEngine(
    name,
    api
) {
    return {
        name,

        api,

        history: [],

        predictionHistory: [],

        patternDatabase: [],

        learning:
            createLearning(),

        currentPrediction:
            null,

        lastSessionId:
            null
    };
}

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

async function fetchAPI(
    engine
) {
    const response =
        await fetch(
            engine.api,
            {
                method: "GET",

                headers: {
                    Accept:
                        "application/json",

                    "User-Agent":
                        "LC79/6x6"
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
// FINALIZE
// ============================================================

function finalizePrediction(
    engine,
    session
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
                        session.phien
                    ) &&
                    item.danh_gia ===
                    "⌛ Chờ Kết Quả"
            );

    if (!prediction) {
        return;
    }

    prediction.ket_qua =
        session.ket_qua;

    prediction.xuc_xac =
        session.xuc_xac;

    prediction.tong =
        session.tong;

    const win =
        prediction.predictionSide ===
        session.result;

    prediction.danh_gia =
        win
            ? "✅ Thắng"
            : "❌ Thua";

    updateLearning(
        engine,

        prediction.predictionSide,

        session.result,

        session.xuc_xac
    );
}

// ============================================================
// PROCESS
// ============================================================

function processData(
    engine,
    list
) {
    const sessions =
        list
            .map(
                normalizeSession
            )
            .filter(Boolean)
            .sort(
                (a, b) =>
                    a.phien -
                    b.phien
            );

    for (
        const session
        of sessions
    ) {
        const exists =
            engine.history.some(
                x =>
                    String(
                        x.phien
                    ) ===
                    String(
                        session.phien
                    )
            );

        if (exists) {
            continue;
        }

        // So sánh dự đoán cũ
        finalizePrediction(
            engine,
            session
        );

        engine.history.push(
            session
        );
    }

    engine.history =
        engine.history.slice(
            -MAX_SOURCE_HISTORY
        );

    engine.patternDatabase =
        minePatterns(
            engine.history
        );

    engine.lastSessionId =
        engine.history.at(-1)
            ?.phien || null;
}

// ============================================================
// CREATE PREDICTION
// ============================================================

function createPrediction(
    engine
) {
    const previous =
        engine.history.at(-1);

    if (!previous) {
        return null;
    }

    const currentId =
        Number(
            previous.phien
        ) + 1;

    const exists =
        engine
            .predictionHistory
            .find(
                x =>
                    String(
                        x.phien_hien_tai
                    ) ===
                    String(
                        currentId
                    )
            );

    if (exists) {
        engine.currentPrediction =
            exists;

        return exists;
    }

    const prediction =
        predict(engine);

    const item = {
        // phiên trước
        phien:
            previous.phien,

        // phiên hiện tại
        phien_hien_tai:
            currentId,

        du_doan:
            prediction.du_doan,

        predictionSide:
            prediction.side,

        ket_qua:
            "⌛ Chờ Kết Quả",

        danh_gia:
            "⌛ Chờ",

        xuc_xac:
            "⌛ Chờ",

        tong:
            "⌛ Chờ",

        pattern:
            prediction.pattern,

        do_tin_cay:
            prediction.do_tin_cay,

        chi_tiet:
            prediction.chi_tiet,

        // Internal
        pattern_matches:
            prediction.pattern_matches,

        createdAt:
            Date.now()
    };

    engine
        .predictionHistory
        .push(item);

    engine.predictionHistory =
        engine
            .predictionHistory
            .slice(
                -MAX_PREDICTION_HISTORY
            );

    engine.currentPrediction =
        item;

    return item;
}

// ============================================================
// SYNC
// ============================================================

async function sync(
    engine
) {
    try {
        const list =
            await fetchAPI(
                engine
            );

        processData(
            engine,
            list
        );

        const prediction =
            createPrediction(
                engine
            );

        if (prediction) {
            console.log(
                `[${engine.name}] ` +
                `Phiên: ${prediction.phien} | ` +
                `Hiện tại: ${prediction.phien_hien_tai} | ` +
                `Dự đoán: ${prediction.du_doan} | ` +
                `Tin cậy: ${prediction.do_tin_cay} | ` +
                `Pattern: ${prediction.pattern}`
            );
        }
    } catch (error) {
        console.error(
            `[${engine.name}]`,
            error.message
        );
    }
}

// ============================================================
// CURRENT
// ============================================================

function currentResponse(
    engine
) {
    const prediction =
        engine.currentPrediction;

    if (!prediction) {
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
                "50%",

            chi_tiet: {
                cau:
                    "",

                ti_le_tai:
                    "50%",

                ti_le_xiu:
                    "50%",

                xu_huong:
                    "Chưa xác định"
            }
        };
    }

    return {
        phien:
            prediction.phien,

        xuc_xac:
            prediction.xuc_xac,

        tong:
            prediction.tong,

        ket_qua:
            prediction.ket_qua,

        phien_hien_tai:
            prediction.phien_hien_tai,

        pattern:
            prediction.pattern,

        du_doan:
            prediction.du_doan,

        do_tin_cay:
            prediction.do_tin_cay,

        chi_tiet:
            prediction.chi_tiet
    };
}

// ============================================================
// HISTORY
// CHỈ 6 FIELD
// ============================================================

function historyResponse(
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
            currentResponse(
                ttoan_hu
            )
        );
    }
);

app.get(
    "/tx/lc79/hu/history",
    (req, res) => {
        res.json(
            historyResponse(
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
            currentResponse(
                ttoan_md5
            )
        );
    }
);

app.get(
    "/tx/lc79/md5/history",
    (req, res) => {
        res.json(
            historyResponse(
                ttoan_md5
            )
        );
    }
);

// ============================================================
// MODEL DEBUG
// ============================================================

function modelResponse(
    engine
) {
    return {
        engine:
            engine.name,

        pattern:
            buildPattern(
                engine.history
            ),

        six_current_patterns:
            getLatest6Patterns(
                buildPattern(
                    engine.history
                )
            ),

        six_sample_patterns:
            engine
                .currentPrediction
                ?.pattern_matches ||
            [],

        pattern_database:
            engine
                .patternDatabase
                .length,

        learning:
            engine.learning,

        models:
            engine.models
    };
}

app.get(
    "/tx/lc79/hu/models",
    (req, res) => {
        res.json(
            modelResponse(
                ttoan_hu
            )
        );
    }
);

app.get(
    "/tx/lc79/md5/models",
    (req, res) => {
        res.json(
            modelResponse(
                ttoan_md5
            )
        );
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
                "LC79",

            version:
                "6x6",

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
            "🚀 LC79 6×6 ANALYZER"
        );

        console.log(
            "============================================================"
        );

        console.log(
            `🌐 http://${HOST}:${PORT}`
        );

        console.log(
            "🟢 HU: ttoan_hu"
        );

        console.log(
            "🟣 MD5: ttoan_md5"
        );

        console.log(
            "🔹 Current patterns: 6"
        );

        console.log(
            "🔹 Sample patterns: 6"
        );

        console.log(
            "============================================================"
        );

        sync(ttoan_hu);
        sync(ttoan_md5);

        setInterval(
            () => {
                sync(ttoan_hu);
                sync(ttoan_md5);
            },
            FETCH_INTERVAL
        );
    }
);
