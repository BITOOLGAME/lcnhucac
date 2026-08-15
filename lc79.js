const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const SOURCE_API =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const CACHE_MS = 3000;

const MAX_SOURCE_HISTORY = 100;
const MAX_PATTERN_HISTORY = 20;
const MAX_PREDICTION_HISTORY = 50;

const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 15;

const MIN_EXACT_SAMPLES = 2;

const PREDICTION_FILE =
    path.join(__dirname, "predictions.json");

let cache = {
    time: 0,
    history: [],
    pattern: "",
    prediction: null,
    next: null
};

let predictionHistory =
    loadPredictions();

let learnedPatterns =
    new Map();

/* =========================================================
   UTIL
========================================================= */

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function round(value, digits = 2) {
    return Number(
        Number(value).toFixed(digits)
    );
}

function tx(value) {
    const v =
        String(value || "")
            .toUpperCase();

    if (
        v === "TAI" ||
        v === "T" ||
        v === "TÀI"
    ) {
        return "T";
    }

    return "X";
}

function result(value) {
    return value === "T"
        ? "Tài"
        : "Xỉu";
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

/* =========================================================
   RANDOM NHẸ
========================================================= */

function lightRandomPrediction(
    scoreT,
    scoreX
) {
    const total =
        scoreT + scoreX;

    /*
     * Không có tín hiệu:
     * random 50/50
     */
    if (total <= 0) {
        return Math.random() < 0.5
            ? "T"
            : "X";
    }

    /*
     * Vẫn dựa trên score hiện tại
     */
    const probabilityT =
        scoreT / total;

    /*
     * Noise nhẹ ±5%
     */
    const noise =
        (Math.random() - 0.5) * 0.10;

    const adjusted =
        clamp(
            probabilityT + noise,
            0.05,
            0.95
        );

    return Math.random() <
        adjusted
        ? "T"
        : "X";
}

/* =========================================================
   FILE
========================================================= */

function loadPredictions() {
    try {
        if (
            !fs.existsSync(
                PREDICTION_FILE
            )
        ) {
            fs.writeFileSync(
                PREDICTION_FILE,
                "[]",
                "utf8"
            );

            return [];
        }

        const raw =
            fs.readFileSync(
                PREDICTION_FILE,
                "utf8"
            );

        const data =
            JSON.parse(raw);

        if (!Array.isArray(data)) {
            return [];
        }

        return data
            .sort(
                (a, b) =>
                    Number(a.phien) -
                    Number(b.phien)
            )
            .slice(
                -MAX_PREDICTION_HISTORY
            );
    } catch (error) {
        console.error(
            "LOAD ERROR:",
            error.message
        );

        return [];
    }
}

function savePredictions() {
    try {
        predictionHistory =
            predictionHistory
                .sort(
                    (a, b) =>
                        Number(a.phien) -
                        Number(b.phien)
                )
                .slice(
                    -MAX_PREDICTION_HISTORY
                );

        fs.writeFileSync(
            PREDICTION_FILE,
            JSON.stringify(
                predictionHistory,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "SAVE ERROR:",
            error.message
        );
    }
}

/* =========================================================
   FETCH API GỐC
========================================================= */

async function fetchHistory() {
    const response =
        await fetch(
            SOURCE_API,
            {
                headers: {
                    Accept:
                        "application/json",

                    "User-Agent":
                        "Mozilla/5.0"
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `SOURCE HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    if (
        !data ||
        !Array.isArray(data.list)
    ) {
        throw new Error(
            "API nguồn không có list"
        );
    }

    return data.list
        .map(item => {
            const dices =
                safeArray(
                    item.dices
                )
                    .map(Number);

            return {
                phien:
                    Number(item.id),

                xuc_xac:
                    dices,

                tong:
                    Number(item.point),

                ket_qua:
                    String(
                        item.resultTruyenThong ||
                            ""
                    ).toUpperCase() ===
                    "TAI"
                        ? "Tài"
                        : "Xỉu"
            };
        })
        .filter(item =>
            Number.isFinite(
                item.phien
            ) &&
            item.xuc_xac.length ===
                3 &&
            item.xuc_xac.every(
                Number.isFinite
            ) &&
            Number.isFinite(
                item.tong
            )
        )
        .sort(
            (a, b) =>
                a.phien - b.phien
        )
        .slice(
            -MAX_SOURCE_HISTORY
        );
}

/* =========================================================
   HISTORY / PATTERN
========================================================= */

function getSides(history) {
    return history.map(item =>
        tx(item.ket_qua)
    );
}

function buildPattern(history) {
    return getSides(history)
        .slice(
            -MAX_PATTERN_HISTORY
        )
        .join("");
}

/* =========================================================
   BAYES
========================================================= */

function bayesianRate(
    success,
    total
) {
    const alpha = 2;
    const beta = 2;

    return (
        (success + alpha) /
        (total + alpha + beta)
    );
}

function distributionConfidence(
    tai,
    xiu
) {
    const total =
        tai + xiu;

    if (total <= 0) {
        return 50;
    }

    const pT =
        bayesianRate(
            tai,
            total
        );

    const pX =
        bayesianRate(
            xiu,
            total
        );

    return round(
        clamp(
            Math.max(
                pT,
                pX
            ) * 100,
            50,
            97
        )
    );
}

/* =========================================================
   EXACT PATTERN
========================================================= */

function getPatternStats(
    history,
    pattern
) {
    const values =
        getSides(history);

    let tai = 0;
    let xiu = 0;

    const matches = [];

    for (
        let i = 0;
        i + pattern.length <
        values.length;
        i++
    ) {
        const current =
            values
                .slice(
                    i,
                    i + pattern.length
                )
                .join("");

        if (
            current !== pattern
        ) {
            continue;
        }

        const next =
            values[
                i + pattern.length
            ];

        if (next === "T") {
            tai++;
        } else {
            xiu++;
        }

        matches.push({
            index: i,
            next
        });
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    const pT =
        bayesianRate(
            tai,
            total
        );

    const pX =
        bayesianRate(
            xiu,
            total
        );

    return {
        pattern,

        length:
            pattern.length,

        total,

        tai,

        xiu,

        raw_tai:
            round(
                tai /
                    total *
                    100
            ),

        raw_xiu:
            round(
                xiu /
                    total *
                    100
            ),

        bayes_tai:
            round(
                pT * 100
            ),

        bayes_xiu:
            round(
                pX * 100
            ),

        pT,

        pX,

        prediction:
            pT >= pX
                ? "T"
                : "X",

        confidence:
            distributionConfidence(
                tai,
                xiu
            ),

        matches
    };
}

/* =========================================================
   DYNAMIC PATTERN MINER
========================================================= */

function minePatterns(history) {
    const values =
        getSides(history);

    const maxLength =
        Math.min(
            MAX_PATTERN_LENGTH,
            values.length - 1
        );

    const patterns = [];

    for (
        let length =
            MIN_PATTERN_LENGTH;
        length <= maxLength;
        length++
    ) {
        const pattern =
            values
                .slice(-length)
                .join("");

        const stats =
            getPatternStats(
                history,
                pattern
            );

        if (!stats) {
            continue;
        }

        if (
            stats.total <
            MIN_EXACT_SAMPLES
        ) {
            continue;
        }

        const sampleFactor =
            Math.min(
                1,
                stats.total / 10
            );

        const lengthFactor =
            1 +
            Math.min(
                0.9,
                length / 15
            );

        const confidenceFactor =
            stats.confidence /
            100;

        const strength =
            sampleFactor *
            lengthFactor *
            confidenceFactor;

        patterns.push({
            ...stats,

            strength:
                round(
                    strength,
                    4
                )
        });
    }

    return patterns.sort(
        (a, b) =>
            b.strength -
            a.strength
    );
}

/* =========================================================
   SIMILAR PATTERN
========================================================= */

function similarity(a, b) {
    if (
        a.length !==
        b.length
    ) {
        return 0;
    }

    let same = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        if (
            a[i] ===
            b[i]
        ) {
            same++;
        }
    }

    return (
        same /
        a.length
    );
}

function mineSimilarPatterns(
    history,
    currentPattern
) {
    const values =
        getSides(history);

    const length =
        currentPattern.length;

    if (
        length < 3 ||
        values.length <=
            length
    ) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    const matches = [];

    for (
        let i = 0;
        i + length <
        values.length;
        i++
    ) {
        const candidate =
            values
                .slice(
                    i,
                    i + length
                )
                .join("");

        if (
            candidate ===
            currentPattern
        ) {
            continue;
        }

        const score =
            similarity(
                currentPattern,
                candidate
            );

        if (
            score < 0.70
        ) {
            continue;
        }

        const next =
            values[
                i + length
            ];

        const weight =
            Math.pow(
                score,
                4
            );

        if (next === "T") {
            tai += weight;
        } else {
            xiu += weight;
        }

        matches.push({
            pattern:
                candidate,

            similarity:
                round(
                    score * 100
                ),

            next:
                result(next),

            weight:
                round(
                    weight,
                    4
                )
        });
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        current:
            currentPattern,

        matches:
            matches.length,

        examples:
            matches.slice(-20),

        pT:
            tai / total,

        pX:
            xiu / total,

        confidence:
            distributionConfidence(
                tai,
                xiu
            ),

        prediction:
            tai >= xiu
                ? "T"
                : "X"
    };
}

/* =========================================================
   PATTERN TRANSFORM
========================================================= */

function invertPattern(pattern) {
    return pattern
        .split("")
        .map(
            x =>
                x === "T"
                    ? "X"
                    : "T"
        )
        .join("");
}

function reversePattern(pattern) {
    return pattern
        .split("")
        .reverse()
        .join("");
}

function rotatePattern(pattern) {
    if (
        pattern.length < 2
    ) {
        return pattern;
    }

    return (
        pattern.slice(1) +
        pattern[0]
    );
}

function patternTransforms(pattern) {
    const set =
        new Set();

    set.add(pattern);

    set.add(
        invertPattern(
            pattern
        )
    );

    set.add(
        reversePattern(
            pattern
        )
    );

    set.add(
        invertPattern(
            reversePattern(
                pattern
            )
        )
    );

    if (
        pattern.length >= 3
    ) {
        set.add(
            rotatePattern(
                pattern
            )
        );
    }

    return [...set];
}

function analyzeTransformedPatterns(
    history,
    pattern
) {
    const output = [];

    for (
        const item
        of patternTransforms(
            pattern
        )
    ) {
        if (
            item === pattern
        ) {
            continue;
        }

        const stats =
            getPatternStats(
                history,
                item
            );

        if (
            !stats ||
            stats.total <
                MIN_EXACT_SAMPLES
        ) {
            continue;
        }

        output.push(
            stats
        );
    }

    return output;
}

/* =========================================================
   RUN PATTERN
========================================================= */

function getRuns(history) {
    const values =
        getSides(history);

    if (!values.length) {
        return [];
    }

    const runs = [];

    let side =
        values[0];

    let count = 1;

    for (
        let i = 1;
        i < values.length;
        i++
    ) {
        if (
            values[i] ===
            side
        ) {
            count++;
        } else {
            runs.push({
                side,
                count
            });

            side =
                values[i];

            count = 1;
        }
    }

    runs.push({
        side,
        count
    });

    return runs;
}

function getRunSignature(history) {
    return getRuns(history)
        .slice(-10)
        .map(
            item =>
                item.count
        )
        .join("-");
}

function analyzeRunPattern(history) {
    const runs =
        getRuns(history);

    if (
        runs.length < 2
    ) {
        return {
            signature: "",
            signals: []
        };
    }

    const lengths =
        runs.map(
            item =>
                item.count
        );

    const recent =
        runs.slice(-10);

    const last =
        recent[
            recent.length - 1
        ];

    const signals = [];

    function add(
        name,
        prediction,
        weight
    ) {
        signals.push({
            name,
            prediction,
            weight
        });
    }

    /*
     * BỆT
     */
    if (
        last.count >= 3
    ) {
        add(
            `bet-${last.count}`,
            last.side,
            clamp(
                0.55 +
                    last.count *
                        0.035,
                0.55,
                0.78
            )
        );
    }

    /*
     * GÃY BỆT
     */
    if (
        recent.length >= 2
    ) {
        const previous =
            recent[
                recent.length - 2
            ];

        if (
            previous.count >= 3 &&
            last.count === 1
        ) {
            add(
                "gay-bet",
                last.side,
                0.72
            );
        }
    }

    /*
     * NHIỀU CẦU ĐẶC BIỆT
     */
    const specialPatterns = [
        ["1-1", 0.82],
        ["2-2", 0.82],
        ["3-3", 0.80],
        ["4-4", 0.78],

        ["1-2", 0.76],
        ["2-1", 0.76],
        ["1-3", 0.75],
        ["3-1", 0.75],
        ["1-4", 0.74],
        ["4-1", 0.74],
        ["1-5", 0.73],
        ["5-1", 0.73],

        ["1-2-1", 0.82],
        ["2-1-2", 0.82],
        ["1-3-1", 0.81],
        ["3-1-3", 0.81],
        ["1-4-1", 0.79],
        ["4-1-4", 0.79],

        ["1-2-3", 0.79],
        ["2-3-4", 0.80],
        ["3-4-5", 0.81],

        ["3-2-1", 0.79],
        ["4-3-2", 0.80],
        ["5-4-3", 0.81],

        ["1-2-3-4", 0.84],
        ["2-3-4-5", 0.85],
        ["1-2-3-4-5", 0.87],

        ["4-3-2-1", 0.84],
        ["5-4-3-2", 0.85],
        ["5-4-3-2-1", 0.87],

        ["1-2-1-2", 0.83],
        ["2-1-2-1", 0.83],
        ["1-3-1-3", 0.82],
        ["3-1-3-1", 0.82],

        ["2-3-2-3", 0.82],
        ["3-2-3-2", 0.82],

        ["1-2-3-2-1", 0.87],
        ["2-3-4-3-2", 0.88],
        ["3-4-5-4-3", 0.88],

        ["1-2-3-4-3-2-1", 0.91],
        ["2-3-4-5-4-3-2", 0.91],

        ["1-2-3-4-5-4-3-2-1", 0.93],

        ["1-2-2-1", 0.80],
        ["2-1-1-2", 0.80],

        ["1-3-3-1", 0.79],
        ["3-1-1-3", 0.79],

        ["1-1-2-2", 0.80],
        ["2-2-1-1", 0.80],

        ["1-1-3-3", 0.79],
        ["3-3-1-1", 0.79],

        ["1-2-3-1-2-3", 0.85],
        ["2-3-4-2-3-4", 0.86],

        ["1-3-2-3-1", 0.83],
        ["2-4-3-4-2", 0.84],

        ["1-3-2-4", 0.78],
        ["4-2-3-1", 0.78],

        ["2-3-1-2", 0.78],
        ["1-2-4-2", 0.78],

        ["1-2-1-3-1-2-1", 0.87],
        ["2-1-2-3-2-1-2", 0.87],

        ["1-2-3-3-2-1", 0.87],
        ["2-3-4-4-3-2", 0.88],

        ["1-2-3-2-3-4", 0.84],
        ["2-3-2-3-4-3", 0.84],

        ["1-3-2-1-2-3", 0.82],
        ["3-1-2-3-2-1", 0.82]
    ];

    for (
        const [
            pattern,
            weight
        ]
        of specialPatterns
    ) {
        const current =
            lengths
                .slice(
                    -pattern
                        .split("-")
                        .length
                )
                .join("-");

        if (
            current === pattern
        ) {
            add(
                pattern,
                opposite(
                    last.side
                ),
                weight
            );
        }
    }

    /*
     * TĂNG
     */
    if (
        lengths.length >= 3
    ) {
        const r =
            lengths.slice(-5);

        let increasing = true;
        let decreasing = true;

        for (
            let i = 1;
            i < r.length;
            i++
        ) {
            if (
                r[i] <=
                r[i - 1]
            ) {
                increasing = false;
            }

            if (
                r[i] >=
                r[i - 1]
            ) {
                decreasing = false;
            }
        }

        if (
            increasing &&
            r.length >= 3
        ) {
            add(
                "dynamic-increase",
                opposite(
                    last.side
                ),
                0.80
            );
        }

        if (
            decreasing &&
            r.length >= 3
        ) {
            add(
                "dynamic-decrease",
                opposite(
                    last.side
                ),
                0.80
            );
        }
    }

    /*
     * ĐỐI XỨNG
     */
    for (
        let len = 3;
        len <= 7;
        len++
    ) {
        const part =
            lengths.slice(-len);

        const reverse =
            [...part].reverse();

        if (
            part.join(",") ===
            reverse.join(",")
        ) {
            add(
                `symmetric-${len}`,
                opposite(
                    last.side
                ),
                clamp(
                    0.72 +
                        len *
                            0.025,
                    0.72,
                    0.90
                )
            );
        }
    }

    /*
     * CHU KỲ RUN
     */
    for (
        let period = 2;
        period <= 4;
        period++
    ) {
        if (
            lengths.length <
            period * 2
        ) {
            continue;
        }

        const a =
            lengths.slice(
                -period
            );

        const b =
            lengths.slice(
                -period * 2,
                -period
            );

        if (
            a.join(",") ===
            b.join(",")
        ) {
            add(
                `run-cycle-${period}`,
                opposite(
                    last.side
                ),
                clamp(
                    0.76 +
                        period *
                            0.025,
                    0.76,
                    0.86
                )
            );
        }
    }

    return {
        signature:
            getRunSignature(
                history
            ),

        runs:
            recent,

        signals
    };
}

/* =========================================================
   MARKOV 1
========================================================= */

function analyzeMarkov1(history) {
    const values =
        getSides(history);

    if (
        values.length < 5
    ) {
        return null;
    }

    const key =
        values[
            values.length - 1
        ];

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i <
        values.length - 1;
        i++
    ) {
        if (
            values[i] !==
            key
        ) {
            continue;
        }

        if (
            values[i + 1] ===
            "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        key,
        total,
        tai,
        xiu,

        pT:
            bayesianRate(
                tai,
                total
            ),

        pX:
            bayesianRate(
                xiu,
                total
            )
    };
}

/* =========================================================
   MARKOV 2
========================================================= */

function analyzeMarkov2(history) {
    const values =
        getSides(history);

    if (
        values.length < 7
    ) {
        return null;
    }

    const key =
        values
            .slice(-2)
            .join("");

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i <
        values.length - 2;
        i++
    ) {
        const pair =
            values
                .slice(
                    i,
                    i + 2
                )
                .join("");

        if (
            pair !== key
        ) {
            continue;
        }

        if (
            values[i + 2] ===
            "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        key,
        total,
        tai,
        xiu,

        pT:
            bayesianRate(
                tai,
                total
            ),

        pX:
            bayesianRate(
                xiu,
                total
            )
    };
}

/* =========================================================
   MARKOV 3
========================================================= */

function analyzeMarkov3(history) {
    const values =
        getSides(history);

    if (
        values.length < 9
    ) {
        return null;
    }

    const key =
        values
            .slice(-3)
            .join("");

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i <
        values.length - 3;
        i++
    ) {
        const part =
            values
                .slice(
                    i,
                    i + 3
                )
                .join("");

        if (
            part !== key
        ) {
            continue;
        }

        if (
            values[i + 3] ===
            "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        key,
        total,
        tai,
        xiu,

        pT:
            bayesianRate(
                tai,
                total
            ),

        pX:
            bayesianRate(
                xiu,
                total
            )
    };
}

/* =========================================================
   CYCLE
========================================================= */

function analyzeCycles(history) {
    const values =
        getSides(history);

    const signals = [];

    for (
        let period = 2;
        period <= 8;
        period++
    ) {
        if (
            values.length <
            period * 2 + 1
        ) {
            continue;
        }

        const current =
            values.slice(
                -period
            );

        let tai = 0;
        let xiu = 0;

        for (
            let i = period;
            i < values.length;
            i++
        ) {
            const previous =
                values.slice(
                    i - period,
                    i
                );

            if (
                previous.join("") !==
                current.join("")
            ) {
                continue;
            }

            if (
                values[i] ===
                "T"
            ) {
                tai++;
            } else {
                xiu++;
            }
        }

        const total =
            tai + xiu;

        if (
            total <
            MIN_EXACT_SAMPLES
        ) {
            continue;
        }

        const pT =
            bayesianRate(
                tai,
                total
            );

        const pX =
            bayesianRate(
                xiu,
                total
            );

        signals.push({
            period,
            total,
            tai,
            xiu,
            pT,
            pX,

            prediction:
                pT >= pX
                    ? "T"
                    : "X",

            confidence:
                distributionConfidence(
                    tai,
                    xiu
                )
        });
    }

    return signals;
}

/* =========================================================
   STREAK
========================================================= */

function analyzeStreak(history) {
    const values =
        getSides(history);

    if (!values.length) {
        return null;
    }

    const last =
        values[
            values.length - 1
        ];

    let count = 0;

    for (
        let i =
            values.length - 1;
        i >= 0;
        i--
    ) {
        if (
            values[i] ===
            last
        ) {
            count++;
        } else {
            break;
        }
    }

    return {
        side: last,

        count,

        prediction:
            count >= 3
                ? opposite(last)
                : last,

        weight:
            clamp(
                0.55 +
                    count *
                        0.04,
                0.55,
                0.82
            )
    };
}

/* =========================================================
   ALTERNATING
========================================================= */

function analyzeAlternating(history) {
    const values =
        getSides(history);

    if (
        values.length < 4
    ) {
        return null;
    }

    const recent =
        values.slice(-8);

    let alternating = true;

    for (
        let i = 1;
        i < recent.length;
        i++
    ) {
        if (
            recent[i] ===
            recent[i - 1]
        ) {
            alternating = false;
            break;
        }
    }

    if (!alternating) {
        return null;
    }

    return {
        pattern:
            recent.join(""),

        prediction:
            opposite(
                recent[
                    recent.length - 1
                ]
            ),

        weight:
            0.88
    };
}

/* =========================================================
   SELF LEARNING
========================================================= */

function rebuildLearning() {
    learnedPatterns =
        new Map();

    for (
        const item
        of predictionHistory
    ) {
        if (
            item.danh_gia !==
                "✅ Thắng" &&
            item.danh_gia !==
                "❌ Thua"
        ) {
            continue;
        }

        if (!item.pattern) {
            continue;
        }

        if (
            !learnedPatterns.has(
                item.pattern
            )
        ) {
            learnedPatterns.set(
                item.pattern,
                {
                    total: 0,
                    win: 0,
                    lose: 0
                }
            );
        }

        const data =
            learnedPatterns.get(
                item.pattern
            );

        data.total++;

        if (
            item.danh_gia ===
            "✅ Thắng"
        ) {
            data.win++;
        } else {
            data.lose++;
        }
    }
}

function getLearningScore(pattern) {
    const data =
        learnedPatterns.get(
            pattern
        );

    if (!data) {
        return null;
    }

    return {
        ...data,

        win_rate:
            data.total
                ? round(
                      data.win /
                          data.total *
                          100
                  )
                : 0
    };
}

/* =========================================================
   PATTERN QUALITY (TÍN HIỆU BÁO TOOL)
========================================================= */

function isPatternGood(prediction) {
    const pattern = prediction.pattern_chinh;
    if (!pattern) return false;

    const conf = pattern.do_tin_cay ? parseFloat(pattern.do_tin_cay) : 0;
    const samples = pattern.so_lan_gap || 0;
    const agree = prediction.agreement || 0;

    // Ngưỡng: pattern có độ tin cậy >= 65%, số mẫu >= 5, agreement >= 70%
    return conf >= 65 && samples >= 5 && agree >= 70;
}

function getRecommendation(prediction) {
    const du_doan = prediction.du_doan;      // "Tài" hoặc "Xỉu"
    const do_tin_cay = prediction.confidence || 50; // %
    const side = prediction.side;            // "T" hoặc "X"

    // 1. Nếu độ tin cậy >= 65% → THEO
    if (do_tin_cay >= 65) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% >= 65%, theo dự đoán ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    }

    // 2. Độ tin cậy < 65% → xét pattern
    const good = isPatternGood(prediction);
    if (good) {
        return {
            khuyen_nghi: "THEO",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 65%, nhưng pattern đẹp → theo dự đoán ${du_doan}`,
            side_theo: side,
            side_bo: side === "T" ? "X" : "T"
        };
    } else {
        // pattern xấu → BẺ (đánh ngược)
        const side_bo = side === "T" ? "X" : "T";
        const du_doan_bo = side_bo === "T" ? "Tài" : "Xỉu";
        return {
            khuyen_nghi: "BẺ",
            giai_thich: `Độ tin cậy ${do_tin_cay}% < 65% và pattern xấu → bẻ sang ${du_doan_bo}`,
            side_theo: side_bo,
            side_bo: side
        };
    }
}

/* =========================================================
   MAIN PREDICTION
========================================================= */

function calculatePrediction(history) {
    const values =
        getSides(history);

    if (
        values.length < 5
    ) {
        const randomSide =
            lightRandomPrediction(
                0,
                0
            );

        const resultObj = {
            du_doan:
                result(randomSide),

            side:
                randomSide,

            do_tin_cay:
                "50.00%",

            confidence:
                50,

            trang_thai:
                "Chưa đủ dữ liệu - Random nhẹ",

            random:
                true,

            pattern_chinh:
                null,

            score: {
                tai: 0,
                xiu: 0
            },

            evidence: []
        };

        // Tích hợp tín hiệu
        resultObj.recommendation = getRecommendation({
            du_doan: resultObj.du_doan,
            side: resultObj.side,
            confidence: resultObj.confidence,
            pattern_chinh: null,
            agreement: 0
        });

        return resultObj;
    }

    const mined =
        minePatterns(
            history
        );

    const main =
        mined.length
            ? mined[0]
            : null;

    const currentPattern =
        values
            .slice(-6)
            .join("");

    const patternForAnalysis =
        main
            ? main.pattern
            : currentPattern;

    const similar =
        mineSimilarPatterns(
            history,
            patternForAnalysis
        );

    const transformed =
        analyzeTransformedPatterns(
            history,
            patternForAnalysis
        );

    const markov1 =
        analyzeMarkov1(
            history
        );

    const markov2 =
        analyzeMarkov2(
            history
        );

    const markov3 =
        analyzeMarkov3(
            history
        );

    const cycles =
        analyzeCycles(
            history
        );

    const run =
        analyzeRunPattern(
            history
        );

    const streak =
        analyzeStreak(
            history
        );

    const alternating =
        analyzeAlternating(
            history
        );

    const score = {
        T: 0,
        X: 0
    };

    const evidence = [];

    /* -----------------------------------------------------
       PATTERN CHÍNH
    ----------------------------------------------------- */

    if (main) {
        const weight =
            clamp(
                4 +
                    main.length *
                        0.45 +
                    Math.log2(
                        main.total + 1
                    ),
                4,
                10
            );

        score.T +=
            main.pT *
            weight;

        score.X +=
            main.pX *
            weight;

        evidence.push({
            type:
                "pattern_chinh",

            pattern:
                main.pattern,

            length:
                main.length,

            samples:
                main.total,

            tai:
                main.tai,

            xiu:
                main.xiu,

            ty_le_tai:
                main.raw_tai,

            ty_le_xiu:
                main.raw_xiu,

            bayes_tai:
                main.bayes_tai,

            bayes_xiu:
                main.bayes_xiu,

            confidence:
                main.confidence,

            weight:
                round(weight)
        });
    }

    /* -----------------------------------------------------
       PATTERN TƯƠNG TỰ
    ----------------------------------------------------- */

    if (
        similar &&
        similar.matches >=
            MIN_EXACT_SAMPLES
    ) {
        const weight =
            clamp(
                1.5 +
                    similar.matches *
                        0.05,
                1.5,
                3
            );

        score.T +=
            similar.pT *
            weight;

        score.X +=
            similar.pX *
            weight;

        evidence.push({
            type:
                "pattern_tuong_tu",

            matches:
                similar.matches,

            confidence:
                similar.confidence,

            prediction:
                result(
                    similar.prediction
                ),

            weight:
                round(weight)
        });
    }

    /* -----------------------------------------------------
       PATTERN ĐẢO / GƯƠNG
    ----------------------------------------------------- */

    for (
        const item
        of transformed
    ) {
        const weight =
            clamp(
                0.5 +
                    item.length *
                        0.08,
                0.5,
                1.5
            );

        score.T +=
            item.pT *
            weight;

        score.X +=
            item.pX *
            weight;

        evidence.push({
            type:
                "pattern_transform",

            pattern:
                item.pattern,

            samples:
                item.total,

            prediction:
                result(
                    item.prediction
                ),

            confidence:
                item.confidence,

            weight:
                round(weight)
        });
    }

    /* -----------------------------------------------------
       MARKOV 1
    ----------------------------------------------------- */

    if (markov1) {
        const weight = 1.8;

        score.T +=
            markov1.pT *
            weight;

        score.X +=
            markov1.pX *
            weight;

        evidence.push({
            type:
                "markov_1",

            key:
                markov1.key,

            samples:
                markov1.total,

            prediction:
                result(
                    markov1.pT >=
                        markov1.pX
                        ? "T"
                        : "X"
                ),

            weight
        });
    }

    /* -----------------------------------------------------
       MARKOV 2
    ----------------------------------------------------- */

    if (markov2) {
        const weight = 2.2;

        score.T +=
            markov2.pT *
            weight;

        score.X +=
            markov2.pX *
            weight;

        evidence.push({
            type:
                "markov_2",

            key:
                markov2.key,

            samples:
                markov2.total,

            prediction:
                result(
                    markov2.pT >=
                        markov2.pX
                        ? "T"
                        : "X"
                ),

            weight
        });
    }

    /* -----------------------------------------------------
       MARKOV 3
    ----------------------------------------------------- */

    if (markov3) {
        const weight = 2.5;

        score.T +=
            markov3.pT *
            weight;

        score.X +=
            markov3.pX *
            weight;

        evidence.push({
            type:
                "markov_3",

            key:
                markov3.key,

            samples:
                markov3.total,

            prediction:
                result(
                    markov3.pT >=
                        markov3.pX
                        ? "T"
                        : "X"
                ),

            weight
        });
    }

    /* -----------------------------------------------------
       RUN / CẦU ĐẶC BIỆT
    ----------------------------------------------------- */

    if (
        run &&
        run.signals.length
    ) {
        for (
            const signal
            of run.signals
        ) {
            score[
                signal.prediction
            ] +=
                signal.weight *
                1.6;

            evidence.push({
                type:
                    "run",

                pattern:
                    signal.name,

                prediction:
                    result(
                        signal.prediction
                    ),

                weight:
                    signal.weight
            });
        }
    }

    /* -----------------------------------------------------
       STREAK
    ----------------------------------------------------- */

    if (streak) {
        score[
            streak.prediction
        ] +=
            streak.weight;

        evidence.push({
            type:
                "streak",

            count:
                streak.count,

            prediction:
                result(
                    streak.prediction
                ),

            weight:
                streak.weight
        });
    }

    /* -----------------------------------------------------
       ALTERNATING
    ----------------------------------------------------- */

    if (alternating) {
        score[
            alternating.prediction
        ] +=
            alternating.weight;

        evidence.push({
            type:
                "alternating",

            pattern:
                alternating.pattern,

            prediction:
                result(
                    alternating.prediction
                ),

            weight:
                alternating.weight
        });
    }

    /* -----------------------------------------------------
       CYCLE
    ----------------------------------------------------- */

    for (
        const cycle
        of cycles
    ) {
        const weight =
            clamp(
                0.7 +
                    cycle.total *
                        0.08,
                0.7,
                1.8
            );

        score[
            cycle.prediction
        ] += weight;

        evidence.push({
            type:
                "cycle",

            period:
                cycle.period,

            samples:
                cycle.total,

            prediction:
                result(
                    cycle.prediction
                ),

            confidence:
                cycle.confidence,

            weight:
                round(weight)
        });
    }

    /* -----------------------------------------------------
       SELF LEARNING
    ----------------------------------------------------- */

    const learning =
        getLearningScore(
            patternForAnalysis
        );

    if (learning) {
        const weight =
            clamp(
                0.5 +
                    learning.total *
                        0.12,
                0.5,
                2
            );

        const prediction =
            main
                ? main.prediction
                : (
                      score.T >=
                      score.X
                          ? "T"
                          : "X"
                  );

        score[
            prediction
        ] += weight;

        evidence.push({
            type:
                "self_learning",

            pattern:
                patternForAnalysis,

            total:
                learning.total,

            win:
                learning.win,

            lose:
                learning.lose,

            win_rate:
                learning.win_rate,

            prediction:
                result(
                    prediction
                ),

            weight:
                round(weight)
        });
    }

    /* -----------------------------------------------------
       TOTAL SCORE
    ----------------------------------------------------- */

    const total =
        score.T +
        score.X;

    /*
     * KHÔNG CÓ TÍN HIỆU
     */
    if (!total) {
        const randomSide =
            lightRandomPrediction(
                score.T,
                score.X
            );

        const resultObj = {
            du_doan:
                result(randomSide),

            side:
                randomSide,

            do_tin_cay:
                "50.00%",

            confidence:
                50,

            trang_thai:
                "Không rõ cầu - Random nhẹ",

            random:
                true,

            pattern_chinh:
                main,

            score: {
                tai:
                    round(score.T, 4),

                xiu:
                    round(score.X, 4)
            },

            evidence
        };

        resultObj.recommendation = getRecommendation({
            du_doan: resultObj.du_doan,
            side: resultObj.side,
            confidence: resultObj.confidence,
            pattern_chinh: main,
            agreement: 0
        });

        return resultObj;
    }

    /* -----------------------------------------------------
       MARGIN
    ----------------------------------------------------- */

    const margin =
        Math.abs(
            score.T -
                score.X
        ) / total;

    /*
     * DỰ ĐOÁN
     *
     * Nếu hai bên quá cân bằng:
     * random nhẹ
     */
    let side;
    let random = false;

    if (
        margin < 0.05
    ) {
        side =
            lightRandomPrediction(
                score.T,
                score.X
            );

        random = true;
    } else {
        side =
            score.T >= score.X
                ? "T"
                : "X";
    }

    /* -----------------------------------------------------
       PROBABILITY
    ----------------------------------------------------- */

    const probability =
        Math.max(
            score.T,
            score.X
        ) / total;

    /* -----------------------------------------------------
       VOTES
    ----------------------------------------------------- */

    const votes = {
        T: 0,
        X: 0
    };

    for (
        const item
        of evidence
    ) {
        if (
            item.prediction ===
            "Tài"
        ) {
            votes.T++;
        }

        if (
            item.prediction ===
            "Xỉu"
        ) {
            votes.X++;
        }
    }

    const voteTotal =
        votes.T +
        votes.X;

    const agreement =
        voteTotal
            ? Math.max(
                  votes.T,
                  votes.X
              ) /
              voteTotal
            : 0.5;

    /* -----------------------------------------------------
       MAIN CONFIDENCE
    ----------------------------------------------------- */

    const mainConfidence =
        main
            ? Math.max(
                  main.pT,
                  main.pX
              )
            : 0.5;

    const scoreConfidence =
        probability;

    let confidence =
        (
            scoreConfidence *
                0.50 +
            mainConfidence *
                0.30 +
            agreement *
                0.20
        ) *
        100;

    /*
     * GIỚI HẠN THEO SỐ MẪU
     */

    if (!main) {
        confidence =
            Math.min(
                confidence,
                65
            );
    } else if (
        main.total < 3
    ) {
        confidence =
            Math.min(
                confidence,
                68
            );
    } else if (
        main.total < 5
    ) {
        confidence =
            Math.min(
                confidence,
                76
            );
    } else if (
        main.total < 8
    ) {
        confidence =
            Math.min(
                confidence,
                85
            );
    }

    /*
     * MARGIN THẤP
     */

    if (
        margin < 0.05
    ) {
        confidence -= 10;
    } else if (
        margin < 0.10
    ) {
        confidence -= 7;
    } else if (
        margin < 0.15
    ) {
        confidence -= 4;
    }

    /*
     * AGREEMENT THẤP
     */

    if (
        agreement < 0.55
    ) {
        confidence -= 7;
    }

    confidence =
        clamp(
            confidence,
            50,
            97
        );

    confidence =
        round(
            confidence
        );

    /*
     * Nếu random:
     * Không cho confidence giả quá cao
     */
    if (random) {
        confidence =
            Math.min(
                confidence,
                60
            );
    }

    const resultObj = {
        du_doan:
            result(side),

        side,

        do_tin_cay:
            `${confidence.toFixed(2)}%`,

        confidence,

        trang_thai:
            random
                ? "Tín hiệu yếu - Random nhẹ"
                : "Phân tích Pattern",

        random,

        margin:
            round(
                margin * 100
            ),

        score: {
            tai:
                round(
                    score.T,
                    4
                ),

            xiu:
                round(
                    score.X,
                    4
                )
        },

        probability: {
            tai:
                round(
                    score.T /
                        total *
                        100
                ),

            xiu:
                round(
                    score.X /
                        total *
                        100
                )
        },

        agreement:
            round(
                agreement *
                    100
            ),

        votes,

        pattern_chinh:
            main
                ? {
                      pattern:
                          main.pattern,

                      length:
                          main.length,

                      so_lan_gap:
                          main.total,

                      tai_sau_pattern:
                          main.tai,

                      xiu_sau_pattern:
                          main.xiu,

                      ty_le_tai:
                          main.raw_tai,

                      ty_le_xiu:
                          main.raw_xiu,

                      bayes_tai:
                          main.bayes_tai,

                      bayes_xiu:
                          main.bayes_xiu,

                      du_doan:
                          result(
                              main.prediction
                          ),

                      do_tin_cay:
                          `${main.confidence.toFixed(
                              2
                          )}%`
                  }
                : null,

        pattern_candidates:
            mined
                .slice(0, 20)
                .map(item => ({
                    pattern:
                        item.pattern,

                    length:
                        item.length,

                    samples:
                        item.total,

                    tai:
                        item.tai,

                    xiu:
                        item.xiu,

                    confidence:
                        item.confidence,

                    prediction:
                        result(
                            item.prediction
                        ),

                    strength:
                        item.strength
                })),

        evidence
    };

    // Tích hợp tín hiệu
    resultObj.recommendation = getRecommendation({
        du_doan: resultObj.du_doan,
        side: resultObj.side,
        confidence: resultObj.confidence,
        pattern_chinh: main,
        agreement: resultObj.agreement
    });

    return resultObj;
}

/* =========================================================
   UPDATE RESULT
========================================================= */

function updatePredictionResults(
    history
) {
    let changed = false;

    for (
        const prediction
        of predictionHistory
    ) {
        if (
            prediction.ket_qua !==
            "⌛ Chờ Kết Quả"
        ) {
            continue;
        }

        const actual =
            history.find(
                item =>
                    Number(
                        item.phien
                    ) ===
                    Number(
                        prediction.phien
                    )
            );

        if (!actual) {
            continue;
        }

        prediction.ket_qua =
            actual.ket_qua;

        prediction.xuc_xac =
            actual.xuc_xac;

        prediction.tong =
            actual.tong;

        prediction.danh_gia =
            prediction.du_doan ===
            actual.ket_qua
                ? "✅ Thắng"
                : "❌ Thua";

        changed = true;
    }

    if (changed) {
        savePredictions();
    }

    rebuildLearning();
}

/* =========================================================
   NEXT PREDICTION
========================================================= */

function createNextPrediction(
    history,
    analysis,
    pattern
) {
    const latest =
        history[
            history.length - 1
        ];

    if (!latest) {
        return null;
    }

    const nextPhien =
        Number(
            latest.phien
        ) + 1;

    let record =
        predictionHistory.find(
            item =>
                Number(
                    item.phien
                ) ===
                nextPhien
        );

    if (!record) {
        record = {
            phien:
                nextPhien,

            du_doan:
                analysis.du_doan,

            do_tin_cay:
                analysis.do_tin_cay,

            ket_qua:
                "⌛ Chờ Kết Quả",

            danh_gia:
                "⌛ Chờ",

            xuc_xac: [],

            tong:
                "⌛ Chờ",

            pattern,

            random:
                analysis.random,

            trang_thai:
                analysis.trang_thai,

            created_at:
                new Date().toISOString()
        };

        predictionHistory.push(
            record
        );
    } else {
        record.du_doan =
            analysis.du_doan;

        record.do_tin_cay =
            analysis.do_tin_cay;

        record.pattern =
            pattern;

        record.random =
            analysis.random;

        record.trang_thai =
            analysis.trang_thai;
    }

    savePredictions();

    return record;
}

/* =========================================================
   MAIN DATA
========================================================= */

async function getData() {
    const now =
        Date.now();

    if (
        cache.prediction &&
        now -
            cache.time <
            CACHE_MS
    ) {
        return cache;
    }

    const history =
        await fetchHistory();

    updatePredictionResults(
        history
    );

    const pattern =
        buildPattern(
            history
        );

    const prediction =
        calculatePrediction(
            history
        );

    const next =
        createNextPrediction(
            history,
            prediction,
            pattern
        );

    cache = {
        time: now,

        history,

        pattern,

        prediction,

        next
    };

    return cache;
}

/* =========================================================
   /api/taixiumd5
========================================================= */

app.get(
    "/api/taixiumd5",
    async (req, res) => {
        try {
            const data =
                await getData();

            const latest =
                data.history[
                    data.history.length - 1
                ];

            if (!latest) {
                return res.status(
                    503
                ).json({
                    error:
                        "Chưa có dữ liệu"
                });
            }

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
                    data.next
                        ? data.next.phien
                        : latest.phien + 1,

                pattern:
                    data.pattern,

                pattern_direction:
                    "Cũ bên trái - Mới bên phải",

                du_doan:
                    data.prediction.du_doan,

                do_tin_cay:
                    data.prediction.do_tin_cay,

                trang_thai:
                    data.prediction
                        .trang_thai,

                random:
                    data.prediction
                        .random
            });
        } catch (error) {
            console.error(
                "TAIXIUMD5:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   /api/taixiumd5/detail
========================================================= */

app.get(
    "/api/taixiumd5/detail",
    async (req, res) => {
        try {
            const data =
                await getData();

            const latest =
                data.history[
                    data.history.length - 1
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
                    data.next
                        ? data.next.phien
                        : latest.phien + 1,

                pattern:
                    data.pattern,

                pattern_length:
                    data.pattern.length,

                pattern_direction:
                    "Cũ bên trái - Mới bên phải",

                du_doan:
                    data.prediction
                        .du_doan,

                do_tin_cay:
                    data.prediction
                        .do_tin_cay,

                trang_thai:
                    data.prediction
                        .trang_thai,

                random:
                    data.prediction
                        .random,

                margin:
                    data.prediction
                        .margin,

                pattern_chinh:
                    data.prediction
                        .pattern_chinh,

                pattern_candidates:
                    data.prediction
                        .pattern_candidates,

                score:
                    data.prediction
                        .score,

                probability:
                    data.prediction
                        .probability,

                agreement:
                    data.prediction
                        .agreement,

                votes:
                    data.prediction
                        .votes,

                evidence:
                    data.prediction
                        .evidence,

                tin_hieu:
                    data.prediction
                        .recommendation,

                next_prediction:
                    data.next,

                history:
                    data.history.slice(
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

/* =========================================================
   /api/txmd5/history
========================================================= */

app.get(
    "/api/txmd5/history",
    async (req, res) => {
        try {
            const data =
                await getData();

            updatePredictionResults(
                data.history
            );

            const output =
                predictionHistory
                    .slice()
                    .sort(
                        (a, b) =>
                            Number(b.phien) -
                            Number(a.phien)
                    )
                    .slice(
                        0,
                        MAX_PREDICTION_HISTORY
                    )
                    .map(item => ({
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
                    }));

            if (
                data.next &&
                !output.some(
                    item =>
                        Number(
                            item.phien
                        ) ===
                        Number(
                            data.next.phien
                        )
                )
            ) {
                output.unshift({
                    phien:
                        data.next.phien,

                    du_doan:
                        data.next.du_doan,

                    ket_qua:
                        "⌛ Chờ Kết Quả",

                    danh_gia:
                        "⌛ Chờ",

                    xuc_xac: [],

                    tong:
                        "⌛ Chờ"
                });
            }

            res.json(
                output.slice(
                    0,
                    MAX_PREDICTION_HISTORY
                )
            );
        } catch (error) {
            console.error(
                "HISTORY:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   /api/txmd5/pattern
========================================================= */

app.get(
    "/api/txmd5/pattern",
    async (req, res) => {
        try {
            const data =
                await getData();

            res.json({
                pattern:
                    data.pattern,

                length:
                    data.pattern.length,

                direction:
                    "Cũ bên trái - Mới bên phải",

                pattern_chinh:
                    data.prediction
                        .pattern_chinh,

                candidates:
                    data.prediction
                        .pattern_candidates,

                du_doan:
                    data.prediction
                        .du_doan,

                do_tin_cay:
                    data.prediction
                        .do_tin_cay,

                trang_thai:
                    data.prediction
                        .trang_thai,

                random:
                    data.prediction
                        .random
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   /api/txmd5/analyze
========================================================= */

app.get(
    "/api/txmd5/analyze",
    async (req, res) => {
        try {
            const data =
                await getData();

            res.json({
                phien:
                    data.history[
                        data.history.length - 1
                    ].phien,

                phien_hien_tai:
                    data.next
                        ? data.next.phien
                        : null,

                pattern:
                    data.pattern,

                du_doan:
                    data.prediction
                        .du_doan,

                do_tin_cay:
                    data.prediction
                        .do_tin_cay,

                trang_thai:
                    data.prediction
                        .trang_thai,

                random:
                    data.prediction
                        .random,

                margin:
                    data.prediction
                        .margin,

                pattern_chinh:
                    data.prediction
                        .pattern_chinh,

                pattern_candidates:
                    data.prediction
                        .pattern_candidates,

                score:
                    data.prediction
                        .score,

                probability:
                    data.prediction
                        .probability,

                agreement:
                    data.prediction
                        .agreement,

                votes:
                    data.prediction
                        .votes,

                evidence:
                    data.prediction
                        .evidence,

                tin_hieu:
                    data.prediction
                        .recommendation
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   /api/txmd5/signal (Tín hiệu riêng)
========================================================= */

app.get(
    "/api/txmd5/signal",
    async (req, res) => {
        try {
            const data =
                await getData();

            res.json({
                du_doan: data.prediction.du_doan,
                do_tin_cay: data.prediction.do_tin_cay,
                pattern_chinh: data.prediction.pattern_chinh,
                agreement: data.prediction.agreement,
                tin_hieu: data.prediction.recommendation
            });
        } catch (error) {
            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* =========================================================
   /api/txmd5/learning
========================================================= */

app.get(
    "/api/txmd5/learning",
    (req, res) => {
        rebuildLearning();

        const patterns = {};

        for (
            const [
                pattern,
                data
            ]
            of learnedPatterns
        ) {
            patterns[
                pattern
            ] = {
                total:
                    data.total,

                win:
                    data.win,

                lose:
                    data.lose,

                win_rate:
                    data.total
                        ? round(
                              data.win /
                                  data.total *
                                  100
                          )
                        : 0
            };
        }

        const finished =
            predictionHistory.filter(
                item =>
                    item.danh_gia ===
                        "✅ Thắng" ||
                    item.danh_gia ===
                        "❌ Thua"
            );

        const wins =
            finished.filter(
                item =>
                    item.danh_gia ===
                    "✅ Thắng"
            ).length;

        const loses =
            finished.filter(
                item =>
                    item.danh_gia ===
                    "❌ Thua"
            ).length;

        res.json({
            total_predictions:
                finished.length,

            wins,

            loses,

            win_rate:
                finished.length
                    ? round(
                          wins /
                              finished.length *
                              100
                      )
                    : 0,

            total_patterns:
                Object.keys(
                    patterns
                ).length,

            patterns
        });
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "TAI XIU MD5",

            source:
                SOURCE_API,

            pattern:
                "20 phiên - cũ bên trái - mới bên phải",

            random:
                "Random nhẹ khi tín hiệu yếu",

            algorithm: [
                "Dynamic Pattern Miner",
                "Exact Pattern",
                "Similar Pattern",
                "Pattern Transform",
                "Markov 1",
                "Markov 2",
                "Markov 3",
                "Run Pattern",
                "Cầu 1-1",
                "Cầu 1-2",
                "Cầu 1-2-1",
                "Cầu 1-2-3",
                "Cầu 1-2-3-4",
                "Cầu 1-2-3-4-5",
                "Cầu tăng",
                "Cầu giảm",
                "Cầu đối xứng",
                "Cầu kim tự tháp",
                "Cầu răng cưa",
                "Cầu kép",
                "Cầu gương",
                "Cycle",
                "Streak",
                "Alternating",
                "Bayesian",
                "Self Learning",
                "Light Random",
                "Tín hiệu báo tool (THEO/BẺ)"
            ],

            endpoints: [
                "/api/taixiumd5",
                "/api/taixiumd5/detail",
                "/api/txmd5/history",
                "/api/txmd5/pattern",
                "/api/txmd5/analyze",
                "/api/txmd5/signal",
                "/api/txmd5/learning"
            ]
        });
    }
);

/* =========================================================
   AUTO UPDATE
========================================================= */

setInterval(
    async () => {
        try {
            await getData();
        } catch (error) {
            console.error(
                "AUTO UPDATE:",
                error.message
            );
        }
    },
    CACHE_MS
);

/* =========================================================
   START
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            "======================================"
        );

        console.log(
            "      TAI XIU MD5 API ONLINE"
        );

        console.log(
            `      PORT: ${PORT}`
        );

        console.log(
            `      SOURCE: ${SOURCE_API}`
        );

        console.log(
            "      PATTERN: 20 PHIEN"
        );

        console.log(
            "      OLD -> LEFT | NEW -> RIGHT"
        );

        console.log(
            "      LIGHT RANDOM: ENABLED"
        );

        console.log(
            "      TÍN HIỆU BÁO TOOL: ENABLED"
        );

        console.log(
            "======================================"
        );
    }
);
