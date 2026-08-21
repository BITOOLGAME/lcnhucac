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
// MODEL WEIGHTS
// 2 THUẬT TOÁN DÙNG CÙNG HỆ MODEL
// NHƯNG DATA HỌC TÁCH RIÊNG
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
// PATTERN MẪU
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
// SAFE NUMBER
// ============================================================

function finiteNumber(value, fallback = 0) {
    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;
}

function safeRatio(
    a,
    b,
    fallback = 0.5
) {
    a = finiteNumber(a, 0);
    b = finiteNumber(b, 0);

    if (b <= 0) {
        return fallback;
    }

    const value = a / b;

    if (!Number.isFinite(value)) {
        return fallback;
    }

    return clamp(value, 0, 1);
}

function clamp(value, min, max) {
    value = finiteNumber(
        value,
        min
    );

    return Math.max(
        min,
        Math.min(max, value)
    );
}

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
            (a, b) =>
                a + b,
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

    const len =
        Math.min(
            a.length,
            b.length
        );

    if (!len) {
        return 0;
    }

    let same = 0;

    for (
        let i = 0;
        i < len;
        i++
    ) {
        if (
            a[i] === b[i]
        ) {
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

    const value =
        positional * 0.8 +
        lengthFactor * 0.2;

    return finiteNumber(
        value,
        0
    );
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

function patternTemplate(pattern) {
    return getRuns(pattern)
        .map(
            item =>
                item.count
        )
        .join("-");
}

// ============================================================
// PATTERN CŨ -> MỚI
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

function getPatternLevel(
    template
) {
    for (
        const [
            level,
            patterns
        ]
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
// TRANSFORM PATTERN
// ============================================================

function oppositePattern(
    pattern
) {
    return pattern
        .split("")
        .map(
            char =>
                opposite(char)
        )
        .join("");
}

function reversePattern(
    pattern
) {
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
        oppositePattern(
            pattern
        )
    );

    set.add(
        reversePattern(
            pattern
        )
    );

    set.add(
        oppositePattern(
            reversePattern(
                pattern
            )
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
        finiteNumber(
            sample.level,
            0
        );

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

    const lengthWeight =
        Math.min(
            length / 10,
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
            samples / 5,
            1.5
        );

    return finiteNumber(
        sim *
        lengthWeight *
        levelWeight *
        sampleWeight,
        0
    );
}

// ============================================================
// MINE PATTERN
// ============================================================

function mineAdvancedPatterns(
    history
) {
    const database = [];

    const values =
        history
            .map(
                x =>
                    x.result
            )
            .filter(Boolean);

    if (
        values.length < 5
    ) {
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

            if (!next) {
                continue;
            }

            if (
                !grouped[
                    pattern
                ]
            ) {
                grouped[
                    pattern
                ] = {
                    T: 0,
                    X: 0
                };
            }

            if (
                next === "T"
            ) {
                grouped[
                    pattern
                ].T++;
            }

            if (
                next === "X"
            ) {
                grouped[
                    pattern
                ].X++;
            }
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

            if (
                samples <= 0
            ) {
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
                    safeRatio(
                        Math.max(
                            stats.T,
                            stats.X
                        ),
                        samples,
                        0.5
                    )
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
                    sim >
                    bestSim
                ) {
                    bestSim = sim;
                    matched =
                        variant;
                }
            }

            if (
                !Number.isFinite(
                    bestSim
                ) ||
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

function markovScore(
    history
) {
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

    return {
        T:
            safeRatio(
                t,
                total
            ),

        X:
            safeRatio(
                x,
                total
            )
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
                clamp(
                    last.count /
                    5,
                    0,
                    1
                ),

            X: 0
        };
    }

    return {
        T: 0,

        X:
            clamp(
                last.count /
                5,
                0,
                1
            )
    };
}

// ============================================================
// DISTRIBUTION
// ============================================================

function distribution(
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
            item.result ===
            "T"
        ) {
            T++;
        }

        if (
            item.result ===
            "X"
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
            if (
                c === "T"
            ) {
                T++;
            }

            if (
                c === "X"
            ) {
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

function repeatScore(
    history
) {
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
            ?.result;

    const prev =
        history.at(-2)
            ?.result;

    if (
        last === prev &&
        last
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
                item.result ===
                "T"
            ) {
                T++;
            } else {
                X += 0.5;
            }
        } else {
            if (
                item.result ===
                "X"
            ) {
                X++;
            } else {
                T += 0.5;
            }
        }
    }

    const total =
        T + X;

    if (
        !Number.isFinite(
            total
        ) ||
        total <= 0
    ) {
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

    if (
        prediction !== "T" &&
        prediction !== "X"
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
    engine,
    dices
) {
    const learning =
        engine.learning;

    const tTotal =
        finiteNumber(
            learning.T.win,
            1
        ) +
        finiteNumber(
            learning.T.lose,
            1
        );

    const xTotal =
        finiteNumber(
            learning.X.win,
            1
        ) +
        finiteNumber(
            learning.X.lose,
            1
        );

    let T =
        safeRatio(
            learning.T.win,
            tTotal
        );

    let X =
        safeRatio(
            learning.X.win,
            xTotal
        );

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

        const dice =
            learning
                .dice[group];

        const diceT =
            finiteNumber(
                dice.T,
                1
            );

        const diceX =
            finiteNumber(
                dice.X,
                1
            );

        const count =
            diceT +
            diceX;

        if (
            count > 0
        ) {
            T =
                T * 0.65 +
                safeRatio(
                    diceT,
                    count
                ) * 0.35;

            X =
                X * 0.65 +
                safeRatio(
                    diceX,
                    count
                ) * 0.35;
        }
    }

    return {
        T:
            finiteNumber(
                T,
                0.5
            ),

        X:
            finiteNumber(
                X,
                0.5
            )
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

    T +=
        finiteNumber(
            patternData.T,
            0
        ) *
        MODELS.pattern;

    X +=
        finiteNumber(
            patternData.X,
            0
        ) *
        MODELS.pattern;

    T +=
        finiteNumber(
            patternData.T,
            0
        ) *
        MODELS.patternMatch;

    X +=
        finiteNumber(
            patternData.X,
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
            dist.T,
            0.5
        ) *
        MODELS.distribution;

    X +=
        finiteNumber(
            dist.X,
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
            learned.T,
            0.5
        ) *
        MODELS.learning;

    X +=
        finiteNumber(
            learned.X,
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
            finiteNumber(
                T,
                0
            ),

        X:
            finiteNumber(
                X,
                0
            ),

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

    if (T < 0) {
        T = 0;
    }

    if (X < 0) {
        X = 0;
    }

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

    if (
        !Number.isFinite(
            confidence
        )
    ) {
        confidence = 50;
    }

    confidence =
        clamp(
            confidence,
            50,
            97
        );

    const tiLeTai =
        Math.round(
            ratioT * 100
        );

    const tiLeXiu =
        Math.round(
            ratioX * 100
        );

    const patternData =
        scores.patternData ||
        {};

    const pattern =
        typeof patternData.pattern ===
        "string"
            ? patternData.pattern
            : "";

    const cau =
        typeof patternData.cau ===
        "string"
            ? patternData.cau
            : "";

    return {
        side,

        du_doan:
            result(side),

        do_tin_cay:
            `${Math.round(
                confidence
            )}%`,

        pattern,

        chi_tiet: {
            cau,

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
// 2 THUẬT TOÁN TÁCH RIÊNG
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
                        "LC79-Analyzer/3.0"
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
// NORMALIZE API
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

    const id =
        Number(item.id);

    if (
        !Number.isFinite(id)
    ) {
        return null;
    }

    if (!side) {
        return null;
    }

    return {
        id,

        _id:
            item._id,

        result:
            side,

        phien:
            id,

        xuc_xac:
            dices,

        tong:
            finiteNumber(
                total,
                0
            ),

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
// PROCESS API
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
            .filter(Boolean);

    if (
        !normalized.length
    ) {
        return;
    }

    // API trả mới -> cũ
    // Chuyển thành cũ -> mới
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

        // Chốt phiên dự đoán
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

    if (!latest) {
        return;
    }

    engine.lastSessionId =
        latest.phien;

    engine.lastDice =
        latest.xuc_xac;

    // Build pattern database
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
        // Phiên trước
        phien:
            phienTruoc.phien,

        // Phiên đang dự đoán
        phien_hien_tai:
            phienHienTai,

        du_doan:
            prediction.du_doan,

        predictionSide:
            prediction.side,

        // Kết quả phiên trước
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

        const current =
            engine.currentPrediction;

        console.log(
            `[${engine.name}] ` +
            `PHIEN=${current?.phien} | ` +
            `HIEN_TAI=${current?.phien_hien_tai} | ` +
            `DU_DOAN=${current?.du_doan} | ` +
            `CONF=${current?.do_tin_cay} | ` +
            `PATTERN=${current?.pattern}`
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
            phienTruoc.phien,

        xuc_xac:
            phienTruoc.xuc_xac,

        tong:
            phienTruoc.tong,

        ket_qua:
            phienTruoc.ket_qua,

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
// CHỈ TRẢ 6 FIELD
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
// HU API
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
// MD5 API
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
// MODEL INFO
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
                "3.0.0",

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
            "🚀 LC79 ANALYZER 3.0"
        );

        console.log(
            "============================================================"
        );

        console.log(
            `🌐 http://${HOST}:${PORT}`
        );

        console.log(
            "🟢 HU MODEL READY"
        );

        console.log(
            "🟣 MD5 MODEL READY"
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
