const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3001;

// =========================================================
// CONFIG
// =========================================================

const SOURCE_API = {
    tx: "https://wtx.tele68.com/v1/tx/sessions",
    md5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

const DATA_DIR = path.join(__dirname, "data");

const HISTORY_FILE =
    path.join(DATA_DIR, "evaluation-history.json");

const AI_FILE =
    path.join(DATA_DIR, "ai-memory.json");

const PATTERN_FILE =
    path.join(DATA_DIR, "pattern-memory.json");

const POLL_INTERVAL = 3000;

const MAX_SOURCE_HISTORY = 200;
const MAX_PATTERN_HISTORY = 15;
const MAX_EVALUATION_HISTORY = 100;

const COMPARE_LENGTH = 5;

const MIN_ANALYSIS_HISTORY = 15;

// =========================================================
// INIT DATA
// =========================================================

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

// =========================================================
// JSON STORAGE
// =========================================================

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        const data =
            fs.readFileSync(
                file,
                "utf8"
            );

        return JSON.parse(data);

    } catch (error) {

        console.error(
            "[LOAD]",
            file,
            error.message
        );

        return fallback;
    }
}

function saveJSON(file, data) {
    try {

        fs.writeFileSync(
            file,
            JSON.stringify(
                data,
                null,
                2
            ),
            "utf8"
        );

    } catch (error) {

        console.error(
            "[SAVE]",
            file,
            error.message
        );
    }
}

// =========================================================
// MEMORY
// =========================================================

const sourceHistory = {
    tx: [],
    md5: []
};

let evaluationHistory =
    loadJSON(
        HISTORY_FILE,
        {
            tx: [],
            md5: []
        }
    );

const pendingPredictions = {
    tx: new Map(),
    md5: new Map()
};

const sseClients = {
    tx: new Set(),
    md5: new Set()
};

// =========================================================
// MODEL MEMORY
// =========================================================

const MODEL_NAMES = [
    "streak",
    "alternating",
    "markov1",
    "markov2",
    "markov3",
    "ngram3",
    "ngram4",
    "ngram5",
    "ngram6",
    "pattern15",
    "similarity",
    "transform",
    "runLength",
    "transition",
    "recency",
    "balance",
    "momentum",
    "reversal",
    "cycle",
    "template",
    "weightedPattern",
    "ensemble",
    "calibration",
    "consensus"
];

function createModelMemory() {

    const memory = {};

    for (
        const name of MODEL_NAMES
    ) {

        memory[name] = {
            weight: 1,
            wins: 0,
            losses: 0,
            total: 0
        };
    }

    return memory;
}

function normalizeModelMemory(memory) {

    const result =
        createModelMemory();

    if (!memory) {
        return result;
    }

    for (
        const name of MODEL_NAMES
    ) {

        if (!memory[name]) {
            continue;
        }

        result[name] = {

            weight:
                Number(
                    memory[name].weight
                ) || 1,

            wins:
                Number(
                    memory[name].wins
                ) || 0,

            losses:
                Number(
                    memory[name].losses
                ) || 0,

            total:
                Number(
                    memory[name].total
                ) || 0
        };
    }

    return result;
}

const savedAI =
    loadJSON(
        AI_FILE,
        {}
    );

const aiMemory = {
    tx:
        normalizeModelMemory(
            savedAI.tx
        ),

    md5:
        normalizeModelMemory(
            savedAI.md5
        )
};

// =========================================================
// PATTERN MEMORY
// =========================================================

const savedPatterns =
    loadJSON(
        PATTERN_FILE,
        {}
    );

const patternMemory = {
    tx:
        Array.isArray(
            savedPatterns.tx
        )
            ? savedPatterns.tx
            : [],

    md5:
        Array.isArray(
            savedPatterns.md5
        )
            ? savedPatterns.md5
            : []
};

// =========================================================
// RESULT NORMALIZATION
// =========================================================

function normalizeResult(value) {

    if (!value) {
        return null;
    }

    const v =
        String(value)
            .trim()
            .toUpperCase();

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

function displayResult(value) {

    const result =
        normalizeResult(value);

    if (result === "TAI") {
        return "Tài";
    }

    if (result === "XIU") {
        return "Xỉu";
    }

    return "Không rõ";
}

function txValue(value) {

    return normalizeResult(value) ===
        "TAI"
        ? "T"
        : "X";
}

// =========================================================
// SOURCE FETCH
// =========================================================

async function fetchSource(url) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            10000
        );

    try {

        const response =
            await fetch(
                url,
                {
                    method: "GET",

                    headers: {
                        Accept:
                            "application/json",

                        "User-Agent":
                            "Mozilla/5.0 LC79-AI"
                    },

                    signal:
                        controller.signal
                }
            );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        return await response.json();

    } finally {

        clearTimeout(timeout);
    }
}

// =========================================================
// NORMALIZE SOURCE
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
                    ? item.dices
                        .map(Number)
                        .filter(
                            Number.isFinite
                        )
                    : [];

            let point =
                Number(item.point);

            if (
                !Number.isFinite(point)
            ) {

                point =
                    dices.reduce(
                        (a, b) =>
                            a + b,
                        0
                    );
            }

            return {

                phien:
                    Number(item.id),

                xuc_xac:
                    dices,

                tong:
                    point,

                ket_qua:
                    normalizeResult(
                        item.resultTruyenThong
                    )
            };
        })

        .filter(item => {

            return (

                Number.isFinite(
                    item.phien
                ) &&

                item.xuc_xac.length === 3 &&

                item.ket_qua
            );
        })

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
    length = MAX_PATTERN_HISTORY
) {

    return history
        .slice(-length)
        .map(
            item =>
                txValue(
                    item.ket_qua
                )
        )
        .join("");
}

// =========================================================
// LAST RESULT
// =========================================================

function lastResult(history) {

    if (!history.length) {
        return null;
    }

    return history[
        history.length - 1
    ].ket_qua;
}

// =========================================================
// OPPOSITE
// =========================================================

function opposite(result) {

    return result === "TAI"
        ? "XIU"
        : "TAI";
}

// =========================================================
// SCORE NORMALIZATION
// =========================================================

function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );
}

function confidenceFromCounts(
    a,
    b
) {

    const total =
        a + b;

    if (!total) {
        return 50;
    }

    return clamp(
        50 +
        (
            Math.max(a, b) /
            total
        ) * 45,
        50,
        95
    );
}

// =========================================================
// 1. STREAK
// =========================================================

function algorithmStreak(
    history
) {

    if (!history.length) {
        return null;
    }

    const last =
        lastResult(history);

    let streak = 0;

    for (
        let i =
            history.length - 1;

        i >= 0;

        i--
    ) {

        if (
            history[i].ket_qua ===
            last
        ) {

            streak++;

        } else {

            break;
        }
    }

    let prediction;

    if (
        streak >= 4
    ) {

        prediction =
            opposite(last);

    } else {

        prediction =
            last;
    }

    return {

        prediction,

        confidence:
            clamp(
                55 +
                streak * 6,
                50,
                94
            )
    };
}

// =========================================================
// 2. ALTERNATING
// =========================================================

function algorithmAlternating(
    pattern
) {

    const p =
        pattern.slice(-8);

    if (
        p.length < 6
    ) {
        return null;
    }

    let alternating = true;

    for (
        let i = 1;
        i < p.length;
        i++
    ) {

        if (
            p[i] ===
            p[i - 1]
        ) {

            alternating = false;

            break;
        }
    }

    if (!alternating) {
        return null;
    }

    return {

        prediction:
            p[p.length - 1] === "T"
                ? "XIU"
                : "TAI",

        confidence: 86
    };
}

// =========================================================
// GENERIC N-GRAM
// =========================================================

function ngramAlgorithm(
    history,
    size
) {

    if (
        history.length <
        size + 5
    ) {
        return null;
    }

    const arr =
        history.map(
            x =>
                txValue(
                    x.ket_qua
                )
        );

    const current =
        arr.slice(-size)
            .join("");

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i <= arr.length - size - 1;
        i++
    ) {

        const sample =
            arr
                .slice(
                    i,
                    i + size
                )
                .join("");

        if (
            sample !== current
        ) {
            continue;
        }

        const next =
            arr[i + size];

        if (
            next === "T"
        ) {

            tai++;

        } else {

            xiu++;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 3. MARKOV 1
// =========================================================

function algorithmMarkov1(
    history
) {

    return ngramAlgorithm(
        history,
        1
    );
}

// =========================================================
// 4. MARKOV 2
// =========================================================

function algorithmMarkov2(
    history
) {

    return ngramAlgorithm(
        history,
        2
    );
}

// =========================================================
// 5. MARKOV 3
// =========================================================

function algorithmMarkov3(
    history
) {

    return ngramAlgorithm(
        history,
        3
    );
}

// =========================================================
// 6. NGRAM 3
// =========================================================

function algorithmNgram3(
    history
) {

    return ngramAlgorithm(
        history,
        3
    );
}

// =========================================================
// 7. NGRAM 4
// =========================================================

function algorithmNgram4(
    history
) {

    return ngramAlgorithm(
        history,
        4
    );
}

// =========================================================
// 8. NGRAM 5
// =========================================================

function algorithmNgram5(
    history
) {

    return ngramAlgorithm(
        history,
        5
    );
}

// =========================================================
// 9. NGRAM 6
// =========================================================

function algorithmNgram6(
    history
) {

    return ngramAlgorithm(
        history,
        6
    );
}

// =========================================================
// 10. PATTERN 15
// =========================================================

function algorithmPattern15(
    history,
    type
) {

    if (
        history.length <
        MAX_PATTERN_HISTORY + 1
    ) {
        return null;
    }

    const current =
        buildPattern(
            history.slice(
                0,
                history.length - 1
            ),
            MAX_PATTERN_HISTORY
        );

    const memory =
        patternMemory[type];

    let tai = 0;
    let xiu = 0;

    for (
        const item of memory
    ) {

        if (
            item.pattern !==
            current
        ) {
            continue;
        }

        if (
            item.next ===
            "TAI"
        ) {

            tai++;

        } else {

            xiu++;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// SIMILARITY
// =========================================================

function similarity(
    a,
    b
) {

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

        if (
            a[i] ===
            b[i]
        ) {
            same++;
        }
    }

    return (
        same / length
    ) * 100;
}

// =========================================================
// 11. SIMILARITY
// =========================================================

function algorithmSimilarity(
    history,
    type
) {

    if (
        history.length <
        MAX_PATTERN_HISTORY
    ) {
        return null;
    }

    const current =
        buildPattern(
            history
        );

    const memory =
        patternMemory[type];

    let tai = 0;
    let xiu = 0;

    let best = 0;

    for (
        const item of memory
    ) {

        const score =
            similarity(
                current,
                item.pattern
            );

        if (
            score < 60
        ) {
            continue;
        }

        const weight =
            Math.pow(
                score / 100,
                4
            );

        if (
            item.next ===
            "TAI"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }

        best =
            Math.max(
                best,
                score
            );
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            clamp(
                50 +
                (
                    Math.max(
                        tai,
                        xiu
                    ) /
                    (
                        tai + xiu
                    )
                ) * 45 +
                best * 0.03,
                50,
                97
            )
    };
}

// =========================================================
// 12. TRANSFORM
// =========================================================

function transformPattern(
    pattern
) {

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

function algorithmTransform(
    history,
    type
) {

    const current =
        buildPattern(
            history
        );

    const transformed =
        transformPattern(
            current
        );

    const memory =
        patternMemory[type];

    let tai = 0;
    let xiu = 0;

    for (
        const item of memory
    ) {

        const score =
            similarity(
                transformed,
                item.pattern
            );

        if (
            score < 70
        ) {
            continue;
        }

        if (
            item.next ===
            "TAI"
        ) {

            tai += score;

        } else {

            xiu += score;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// RUN LENGTH
// =========================================================

function getCurrentRun(
    pattern
) {

    if (!pattern.length) {
        return null;
    }

    const last =
        pattern[
            pattern.length - 1
        ];

    let count = 0;

    for (
        let i =
            pattern.length - 1;

        i >= 0;

        i--
    ) {

        if (
            pattern[i] ===
            last
        ) {

            count++;

        } else {

            break;
        }
    }

    return {

        value: last,

        length: count
    };
}

// =========================================================
// 13. RUN LENGTH
// =========================================================

function algorithmRunLength(
    history
) {

    if (
        history.length < 10
    ) {
        return null;
    }

    const pattern =
        buildPattern(
            history
        );

    const current =
        getCurrentRun(
            pattern
        );

    if (!current) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    for (
        let i = 1;
        i < pattern.length - 1;
        i++
    ) {

        let run = 1;

        for (
            let j = i - 1;
            j >= 0;
            j--
        ) {

            if (
                pattern[j] ===
                pattern[i]
            ) {

                run++;

            } else {

                break;
            }
        }

        if (
            run !==
            current.length
        ) {
            continue;
        }

        if (
            pattern[i + 1] ===
            "T"
        ) {

            tai++;

        } else {

            xiu++;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 14. TRANSITION MATRIX
// =========================================================

function algorithmTransition(
    history
) {

    if (
        history.length < 10
    ) {
        return null;
    }

    const matrix = {
        T: {
            T: 0,
            X: 0
        },
        X: {
            T: 0,
            X: 0
        }
    };

    const arr =
        history.map(
            x =>
                txValue(
                    x.ket_qua
                )
        );

    for (
        let i = 0;
        i < arr.length - 1;
        i++
    ) {

        matrix[
            arr[i]
        ][
            arr[i + 1]
        ]++;
    }

    const last =
        arr[arr.length - 1];

    const tai =
        matrix[last].T;

    const xiu =
        matrix[last].X;

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 15. RECENCY
// =========================================================

function algorithmRecency(
    history
) {

    const recent =
        history.slice(-15);

    if (
        recent.length < 8
    ) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < recent.length;
        i++
    ) {

        const weight =
            i + 1;

        if (
            recent[i].ket_qua ===
            "TAI"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 16. BALANCE
// =========================================================

function algorithmBalance(
    history
) {

    const recent =
        history.slice(-15);

    if (
        recent.length < 8
    ) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    for (
        const item of recent
    ) {

        if (
            item.ket_qua ===
            "TAI"
        ) {

            tai++;

        } else {

            xiu++;
        }
    }

    if (
        tai === xiu
    ) {
        return null;
    }

    return {

        prediction:
            tai > xiu
                ? "XIU"
                : "TAI",

        confidence:
            clamp(
                55 +
                Math.abs(
                    tai - xiu
                ) * 3,
                50,
                82
            )
    };
}

// =========================================================
// 17. MOMENTUM
// =========================================================

function algorithmMomentum(
    history
) {

    if (
        history.length < 10
    ) {
        return null;
    }

    const arr =
        history
            .slice(-10)
            .map(
                x =>
                    txValue(
                        x.ket_qua
                    )
            );

    let score = 0;

    for (
        let i = 0;
        i < arr.length;
        i++
    ) {

        const weight =
            i + 1;

        score +=
            arr[i] === "T"
                ? weight
                : -weight;
    }

    if (
        score === 0
    ) {
        return null;
    }

    return {

        prediction:
            score > 0
                ? "TAI"
                : "XIU",

        confidence:
            clamp(
                50 +
                Math.abs(score) /
                3,
                50,
                90
            )
    };
}

// =========================================================
// 18. REVERSAL
// =========================================================

function algorithmReversal(
    history
) {

    const pattern =
        buildPattern(
            history
        );

    if (
        pattern.length < 10
    ) {
        return null;
    }

    const last =
        pattern[
            pattern.length - 1
        ];

    let same = 0;
    let oppositeCount = 0;

    for (
        let i = 0;
        i < pattern.length - 1;
        i++
    ) {

        if (
            pattern[i] ===
            last
        ) {

            same++;

            if (
                pattern[i + 1] &&
                pattern[i + 1] !==
                last
            ) {

                oppositeCount++;
            }
        }
    }

    if (!same) {
        return null;
    }

    return {

        prediction:
            oppositeCount >=
            same / 2
                ? opposite(
                    last === "T"
                        ? "TAI"
                        : "XIU"
                )
                : last === "T"
                    ? "TAI"
                    : "XIU",

        confidence:
            clamp(
                50 +
                (
                    oppositeCount /
                    same
                ) * 40,
                50,
                90
            )
    };
}

// =========================================================
// 19. CYCLE DETECTOR
// =========================================================

function algorithmCycle(
    history
) {

    const pattern =
        buildPattern(
            history
        );

    if (
        pattern.length < 12
    ) {
        return null;
    }

    let best = null;

    for (
        let size = 2;
        size <= 6;
        size++
    ) {

        const unit =
            pattern.slice(-size);

        let matches = 0;

        for (
            let i = 0;
            i <=
            pattern.length -
            size * 2;
            i++
        ) {

            const sample =
                pattern.slice(
                    i,
                    i + size
                );

            if (
                sample === unit
            ) {

                matches++;
            }
        }

        if (
            matches >= 2
        ) {

            const next =
                unit[
                    unit.length - 1
                ];

            best = {

                prediction:
                    next === "T"
                        ? "TAI"
                        : "XIU",

                confidence:
                    clamp(
                        55 +
                        matches * 7,
                        50,
                        91
                    )
            };
        }
    }

    return best;
}

// =========================================================
// SAMPLE PATTERN GENERATOR
// =========================================================

function generateRunPatterns(
    maxRun = 10
) {

    const patterns = [];

    for (
        let a = 1;
        a <= maxRun;
        a++
    ) {

        for (
            let b = 1;
            b <= maxRun;
            b++
        ) {

            if (
                a + b > 15
            ) {
                continue;
            }

            let pattern = "";

            while (
                pattern.length < 15
            ) {

                pattern +=
                    "T".repeat(a);

                if (
                    pattern.length >=
                    15
                ) {
                    break;
                }

                pattern +=
                    "X".repeat(b);
            }

            patterns.push(
                pattern.slice(0, 15)
            );

            let reverse = "";

            while (
                reverse.length < 15
            ) {

                reverse +=
                    "X".repeat(a);

                if (
                    reverse.length >=
                    15
                ) {
                    break;
                }

                reverse +=
                    "T".repeat(b);
            }

            patterns.push(
                reverse.slice(0, 15)
            );
        }
    }

    return patterns;
}

// =========================================================
// STATIC PATTERNS
// =========================================================

const STATIC_PATTERNS = [

    "TXTXTXTXTXTXTXT",
    "XTXTXTXTXTXTXTX",

    "TTXXTTXXTTXXTTX",
    "XXTTXXTTXXTTXXT",

    "TXXTTXXTTXXTTXX",
    "XTTXXTTXXTTXXTT",

    "TTXTTXTTXTTXTTX",
    "XXTXXTXXTXXTXXT",

    "TTTXTTTXTTTXTTT",
    "XXXTXXXTXXXTXXX",

    "TXXXTXXXTXXXTXXX",
    "XTTTXTTTXTTTXTT",

    "TTTXXTTTXXTTTXX",
    "XXXTTXXXTTXXXTT",

    "TTXXXTTXXXTTXXX",
    "XXTTTXXTTTXXTTT",

    "TTTTXTTTTXTTTTX",
    "XXXXTXXXXTXXXXT",

    "TXXXXTXXXXTXXXXT",
    "XTTTTXTTTTXTTTTX",

    "TTTTXXTTTTXXTTT",
    "XXXXTTXXXXTTXXX",

    "TTXXXXTTXXXXTTX",
    "XXTTTTXXTTTTXXT",

    "TTTTTXTTTTTXTTT",
    "XXXXXTXXXXXTXXX",

    "TXXXXXTXXXXXTXXX",
    "XTTTTTXTTTTTXTT",

    "TTTTTTXTTTTTTXT",
    "XXXXXXTXXXXXXTX",

    "TXXXXXXTXXXXXXT",
    "XTTTTTTXTTTTTTX",

    "TTTTTTTXTTTTTTX",
    "XXXXXXXTXXXXXXX",

    "TXXXXXXXTXXXXXX",
    "XTTTTTTTXTTTTTT",

    "TTTTTTTTXTTTTTT",
    "XXXXXXXXTXXXXXXX",

    "TXXXXXXXXTXXXXXX",
    "XTTTTTTTTXTTTTTT",

    "TTTTTTTTTXTTTTT",
    "XXXXXXX XTXXXXXX".replace(
        / /g,
        ""
    ),

    "TTTTTTTTTTXTTTT",
    "XXXXXXXXXXTXXXX",

    "TXTTXTTXTTXTTXX",
    "XTTXTTXTTXTTXTT",

    "TTXTXTTXTXTTXTX",
    "XXTXTXXTXTXXTXT",

    "TXTTXXTTXTXTTXX",
    "XTTXXTXXTXTXXTT",

    "TTXTXTXTXTXTXTT",
    "XXTXT TXTXTXTXTT".replace(
        / /g,
        ""
    ),

    "TTXXXTXXTTXXTXT",
    "XXTTTXTTXXTTXTX",

    "TTXXTTTXXTTXXTX",
    "XXTTXXXTTXXTTXT",

    "TXXTXXTXXTXXTXX",
    "XTTXTTXTTXTTXTT",

    "TTTTTTTTTTTTTTX",
    "XXXXXXXXXXXXXXT",

    "TTTTTTTTTTTTTXT",
    "XXXXXXXXXXXXXXTX",

    "TTXXTTXXTTXXTTX",
    "XXTTXXTTXXTTXXT",

    "TTTXXXTTTXXXTTT",
    "XXXTTTXXXTTTXXX",

    "TTTTXXXXTTTTXXX",
    "XXXXTTTTXXXXTTT",

    "TTXXXXTTTTXXTTT",
    "XXTTTTXXXXTTXXX"
];

// =========================================================
// BUILD 200+ PATTERNS
// =========================================================

const SAMPLE_PATTERNS = [
    ...new Set(
        [
            ...STATIC_PATTERNS,
            ...generateRunPatterns(10)
        ]
        .filter(
            p =>
                typeof p === "string" &&
                p.length === 15 &&
                /^[TX]+$/.test(p)
        )
    )
];

// =========================================================
// 20. TEMPLATE MATCHER
// =========================================================

function algorithmTemplate(
    history
) {

    const current =
        buildPattern(
            history
        );

    if (
        current.length <
        MAX_PATTERN_HISTORY
    ) {
        return null;
    }

    const recent =
        current.slice(
            -COMPARE_LENGTH
        );

    let tai = 0;
    let xiu = 0;

    for (
        const sample
        of SAMPLE_PATTERNS
    ) {

        const sampleRecent =
            sample.slice(
                -COMPARE_LENGTH
            );

        const score =
            similarity(
                recent,
                sampleRecent
            );

        if (
            score < 60
        ) {
            continue;
        }

        const next =
            sample[
                sample.length - 1
            ];

        const weight =
            Math.pow(
                score / 100,
                3
            );

        if (
            next === "T"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 21. WEIGHTED PATTERN
// =========================================================

function algorithmWeightedPattern(
    history,
    type
) {

    const current =
        buildPattern(
            history
        );

    const memory =
        patternMemory[type];

    let tai = 0;
    let xiu = 0;

    for (
        const item of memory
    ) {

        const score =
            similarity(
                current,
                item.pattern
            );

        if (
            score < 55
        ) {
            continue;
        }

        const historicalWeight =
            Number(
                item.weight
            ) || 1;

        const winRate =
            Number(
                item.winRate
            ) || 50;

        const weight =
            (
                score / 100
            ) *
            historicalWeight *
            (
                winRate / 50
            );

        if (
            item.next ===
            "TAI"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }
    }

    if (
        tai + xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            confidenceFromCounts(
                tai,
                xiu
            )
    };
}

// =========================================================
// 22. ENSEMBLE
// =========================================================

function algorithmEnsemble(
    models,
    type
) {

    const memory =
        aiMemory[type];

    let tai = 0;
    let xiu = 0;

    let active = 0;

    for (
        const name
        of MODEL_NAMES
    ) {

        if (
            name === "ensemble" ||
            name === "calibration" ||
            name === "consensus"
        ) {
            continue;
        }

        const model =
            models[name];

        if (
            !model ||
            !model.prediction
        ) {
            continue;
        }

        const modelMemory =
            memory[name];

        const score =
            (
                Number(
                    model.confidence
                ) || 50
            ) *
            (
                Number(
                    modelMemory.weight
                ) || 1
            );

        if (
            model.prediction ===
            "TAI"
        ) {

            tai += score;

        } else {

            xiu += score;
        }

        active++;
    }

    if (!active) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            clamp(
                50 +
                (
                    Math.abs(
                        tai - xiu
                    ) /
                    (
                        tai + xiu
                    )
                ) * 47,
                50,
                97
            )
    };
}

// =========================================================
// 23. CALIBRATION
// =========================================================

function algorithmCalibration(
    models
) {

    let tai = 0;
    let xiu = 0;

    let confidenceTotal = 0;
    let count = 0;

    for (
        const model
        of Object.values(models)
    ) {

        if (
            !model ||
            !model.prediction
        ) {
            continue;
        }

        if (
            model.prediction ===
            "TAI"
        ) {

            tai++;

        } else {

            xiu++;
        }

        confidenceTotal +=
            Number(
                model.confidence
            ) || 50;

        count++;
    }

    if (!count) {
        return null;
    }

    const agreement =
        Math.max(
            tai,
            xiu
        ) / count;

    const avgConfidence =
        confidenceTotal /
        count;

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            clamp(
                avgConfidence *
                0.65 +
                agreement *
                35,
                50,
                97
            )
    };
}

// =========================================================
// 24. CONSENSUS
// =========================================================

function algorithmConsensus(
    models
) {

    let tai = 0;
    let xiu = 0;

    for (
        const model
        of Object.values(models)
    ) {

        if (
            !model ||
            !model.prediction
        ) {
            continue;
        }

        if (
            model.prediction ===
            "TAI"
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

    const agreement =
        Math.max(
            tai,
            xiu
        ) / total;

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            clamp(
                50 +
                agreement * 47,
                50,
                97
            )
    };
}

// =========================================================
// RUN ALL
// =========================================================

function runAllAlgorithms(
    history,
    type
) {

    const pattern =
        buildPattern(
            history
        );

    const models = {};

    models.streak =
        algorithmStreak(
            history
        );

    models.alternating =
        algorithmAlternating(
            pattern
        );

    models.markov1 =
        algorithmMarkov1(
            history
        );

    models.markov2 =
        algorithmMarkov2(
            history
        );

    models.markov3 =
        algorithmMarkov3(
            history
        );

    models.ngram3 =
        algorithmNgram3(
            history
        );

    models.ngram4 =
        algorithmNgram4(
            history
        );

    models.ngram5 =
        algorithmNgram5(
            history
        );

    models.ngram6 =
        algorithmNgram6(
            history
        );

    models.pattern15 =
        algorithmPattern15(
            history,
            type
        );

    models.similarity =
        algorithmSimilarity(
            history,
            type
        );

    models.transform =
        algorithmTransform(
            history,
            type
        );

    models.runLength =
        algorithmRunLength(
            history
        );

    models.transition =
        algorithmTransition(
            history
        );

    models.recency =
        algorithmRecency(
            history
        );

    models.balance =
        algorithmBalance(
            history
        );

    models.momentum =
        algorithmMomentum(
            history
        );

    models.reversal =
        algorithmReversal(
            history
        );

    models.cycle =
        algorithmCycle(
            history
        );

    models.template =
        algorithmTemplate(
            history
        );

    models.weightedPattern =
        algorithmWeightedPattern(
            history,
            type
        );

    models.ensemble =
        algorithmEnsemble(
            models,
            type
        );

    models.calibration =
        algorithmCalibration(
            models
        );

    models.consensus =
        algorithmConsensus(
            models
        );

    return models;
}

// =========================================================
// PATTERN MEMORY UPDATE
// =========================================================

function updatePatternMemory(
    type,
    history
) {

    if (
        history.length <
        MAX_PATTERN_HISTORY + 1
    ) {
        return;
    }

    const pattern =
        buildPattern(
            history.slice(
                0,
                history.length - 1
            )
        );

    const actual =
        history[
            history.length - 1
        ];

    let item =
        patternMemory[type]
            .find(
                x =>
                    x.pattern ===
                    pattern
            );

    if (!item) {

        item = {

            pattern,

            next:
                actual.ket_qua,

            occurrences: 1,

            wins: 0,

            losses: 0,

            weight: 1,

            winRate: 50
        };

        patternMemory[type]
            .push(item);

    } else {

        item.occurrences++;

        item.next =
            actual.ket_qua;
    }

    if (
        patternMemory[type]
            .length > 5000
    ) {

        patternMemory[type]
            .splice(
                0,
                patternMemory[type]
                    .length - 5000
            );
    }

    saveJSON(
        PATTERN_FILE,
        patternMemory
    );
}

// =========================================================
// UPDATE PATTERN RESULT
// =========================================================

function updatePatternLearning(
    type,
    prediction,
    actual
) {

    if (!prediction) {
        return;
    }

    const memory =
        patternMemory[type];

    for (
        const item of memory
    ) {

        if (
            item.next !==
            actual &&
            item.next !==
            prediction
        ) {
            continue;
        }

        if (
            item.next ===
            actual
        ) {

            item.wins++;

            item.weight =
                clamp(
                    (
                        Number(
                            item.weight
                        ) || 1
                    ) + 0.03,
                    0.2,
                    5
                );

        } else {

            item.losses++;

            item.weight =
                clamp(
                    (
                        Number(
                            item.weight
                        ) || 1
                    ) - 0.015,
                    0.2,
                    5
                );
        }

        const total =
            item.wins +
            item.losses;

        item.winRate =
            total
                ? Number(
                    (
                        item.wins /
                        total *
                        100
                    ).toFixed(2)
                )
                : 50;
    }

    saveJSON(
        PATTERN_FILE,
        patternMemory
    );
}

// =========================================================
// AI LEARNING
// =========================================================

function updateAILearning(
    type,
    pending,
    actual
) {

    if (
        !pending ||
        !pending.models
    ) {
        return;
    }

    const memory =
        aiMemory[type];

    for (
        const name
        of MODEL_NAMES
    ) {

        const model =
            pending.models[name];

        if (
            !model ||
            !model.prediction
        ) {
            continue;
        }

        const item =
            memory[name];

        if (!item) {
            continue;
        }

        item.total++;

        if (
            model.prediction ===
            actual
        ) {

            item.wins++;

            item.weight =
                clamp(
                    item.weight +
                    0.08,
                    0.2,
                    5
                );

        } else {

            item.losses++;

            item.weight =
                clamp(
                    item.weight -
                    0.04,
                    0.2,
                    5
                );
        }
    }

    saveJSON(
        AI_FILE,
        aiMemory
    );
}

// =========================================================
// EVALUATION OBJECT
// =========================================================

function createEvaluation(
    phien,
    prediction
) {

    return {

        phien,

        du_doan:
            displayResult(
                prediction
            ),

        ket_qua:
            "⌛ Chờ Kết Quả",

        danh_gia:
            "⌛ Chờ Kết Quả",

        xuc_xac:
            "⌛ Chờ",

        tong:
            "⌛ Chờ"
    };
}

// =========================================================
// SETTLE EVALUATION
// =========================================================

function settleEvaluation(
    type,
    session
) {

    const list =
        evaluationHistory[type];

    const item =
        list.find(
            x =>
                x.phien ===
                session.phien
        );

    if (!item) {
        return false;
    }

    if (
        item.ket_qua !==
        "⌛ Chờ Kết Quả"
    ) {
        return false;
    }

    item.ket_qua =
        displayResult(
            session.ket_qua
        );

    item.xuc_xac =
        session.xuc_xac;

    item.tong =
        session.tong;

    const predicted =
        normalizeResult(
            item.du_doan
        );

    if (
        predicted ===
        session.ket_qua
    ) {

        item.danh_gia =
            "✅ Thắng";

    } else {

        item.danh_gia =
            "❌ Thua";
    }

    const pending =
        pendingPredictions[type]
            .get(
                session.phien
            );

    if (pending) {

        updateAILearning(
            type,
            pending,
            session.ket_qua
        );

        updatePatternLearning(
            type,
            pending.prediction,
            session.ket_qua
        );

        pendingPredictions[type]
            .delete(
                session.phien
            );
    }

    saveJSON(
        HISTORY_FILE,
        evaluationHistory
    );

    return true;
}

// =========================================================
// SSE
// =========================================================

function sendSSE(
    type,
    event,
    data
) {

    const clients =
        sseClients[type];

    const payload =
        JSON.stringify(data);

    for (
        const client of clients
    ) {

        try {

            client.write(
                `event: ${event}\n`
            );

            client.write(
                `data: ${payload}\n\n`
            );

        } catch {

            clients.delete(
                client
            );
        }
    }
}

// =========================================================
// SSE STREAM
// =========================================================

function setupSSE(
    req,
    res,
    type
) {

    res.setHeader(
        "Content-Type",
        "text/event-stream"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache"
    );

    res.setHeader(
        "Connection",
        "keep-alive"
    );

    res.setHeader(
        "X-Accel-Buffering",
        "no"
    );

    if (
        res.flushHeaders
    ) {
        res.flushHeaders();
    }

    sseClients[type].add(res);

    res.write(
        "retry: 3000\n\n"
    );

    res.write(
        "event: history\n"
    );

    res.write(
        `data: ${JSON.stringify(
            evaluationHistory[type]
        )}\n\n`
    );

    const heartbeat =
        setInterval(
            () => {

                try {

                    res.write(
                        ": heartbeat\n\n"
                    );

                } catch {

                    clearInterval(
                        heartbeat
                    );
                }

            },
            15000
        );

    req.on(
        "close",
        () => {

            clearInterval(
                heartbeat
            );

            sseClients[type]
                .delete(res);
        }
    );
}

// =========================================================
// PROCESS API
// =========================================================

async function processAPI(
    type
) {

    const json =
        await fetchSource(
            SOURCE_API[type]
        );

    const sessions =
        normalizeSessions(
            json
        );

    if (!sessions.length) {

        throw new Error(
            "API không trả dữ liệu hợp lệ"
        );
    }

    const oldHistory =
        sourceHistory[type];

    const latest =
        sessions[
            sessions.length - 1
        ];

    const oldLatest =
        oldHistory.length
            ? oldHistory[
                oldHistory.length - 1
            ]
            : null;

    sourceHistory[type] =
        sessions.slice(
            -MAX_SOURCE_HISTORY
        );

    let historyChanged = false;

    // =====================================================
    // SETTLE
    // =====================================================

    for (
        const session
        of sourceHistory[type]
    ) {

        const changed =
            settleEvaluation(
                type,
                session
            );

        if (changed) {
            historyChanged = true;
        }
    }

    // =====================================================
    // NEW SESSION
    // =====================================================

    const newSession =
        !oldLatest ||
        oldLatest.phien !==
        latest.phien;

    // =====================================================
    // ENOUGH HISTORY
    // =====================================================

    let result = null;

    if (
        sourceHistory[type].length >=
        MIN_ANALYSIS_HISTORY
    ) {

        const history =
            sourceHistory[type];

        // Lưu pattern 15
        updatePatternMemory(
            type,
            history
        );

        const pattern =
            buildPattern(
                history
            );

        const models =
            runAllAlgorithms(
                history,
                type
            );

        // =================================================
        // FINAL WEIGHTED VOTE
        // =================================================

        let tai = 0;
        let xiu = 0;

        const memory =
            aiMemory[type];

        for (
            const name
            of MODEL_NAMES
        ) {

            const model =
                models[name];

            if (
                !model ||
                !model.prediction
            ) {
                continue;
            }

            const aiWeight =
                memory[name]
                    ? memory[name].weight
                    : 1;

            let confidence =
                Number(
                    model.confidence
                ) || 50;

            // ensemble/calibration/consensus
            // được dùng nhưng giảm trọng số
            if (
                name === "ensemble"
            ) {

                confidence *= 0.75;

            } else if (
                name === "calibration"
            ) {

                confidence *= 0.80;

            } else if (
                name === "consensus"
            ) {

                confidence *= 0.85;
            }

            const vote =
                confidence *
                aiWeight;

            if (
                model.prediction ===
                "TAI"
            ) {

                tai += vote;

            } else {

                xiu += vote;
            }
        }

        const total =
            tai + xiu;

        let prediction =
            tai >= xiu
                ? "TAI"
                : "XIU";

        let confidence =
            total
                ? 50 +
                (
                    Math.abs(
                        tai - xiu
                    ) /
                    total
                ) * 47
                : 50;

        // =================================================
        // CONSENSUS BONUS
        // =================================================

        let modelCount = 0;
        let predictionCount = 0;

        for (
            const name
            of MODEL_NAMES
        ) {

            const model =
                models[name];

            if (
                !model ||
                !model.prediction
            ) {
                continue;
            }

            modelCount++;

            if (
                model.prediction ===
                prediction
            ) {

                predictionCount++;
            }
        }

        if (
            modelCount > 0
        ) {

            const consensus =
                predictionCount /
                modelCount;

            confidence +=
                consensus * 8;
        }

        // =================================================
        // SAMPLE PATTERN 5
        // =================================================

        const current5 =
            pattern.slice(
                -COMPARE_LENGTH
            );

        let bestSample = 0;

        for (
            const sample
            of SAMPLE_PATTERNS
        ) {

            const score =
                similarity(
                    current5,
                    sample.slice(
                        -COMPARE_LENGTH
                    )
                );

            if (
                score >
                bestSample
            ) {

                bestSample =
                    score;
            }
        }

        if (
            bestSample >= 90
        ) {

            confidence += 4;

        } else if (
            bestSample >= 80
        ) {

            confidence += 2;
        }

        confidence =
            clamp(
                confidence,
                50,
                97
            );

        result = {

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

            pattern,

            du_doan:
                displayResult(
                    prediction
                ),

            do_tin_cay:
                `${confidence.toFixed(2)}%`
        };

        // =================================================
        // SAVE PREDICTION
        // =================================================

        const nextPhien =
            latest.phien + 1;

        if (
            !pendingPredictions[type]
                .has(nextPhien)
        ) {

            pendingPredictions[type]
                .set(
                    nextPhien,
                    {
                        prediction,

                        models,

                        pattern,

                        confidence
                    }
                );

            const exists =
                evaluationHistory[type]
                    .some(
                        x =>
                            x.phien ===
                            nextPhien
                    );

            if (!exists) {

                evaluationHistory[type]
                    .unshift(
                        createEvaluation(
                            nextPhien,
                            prediction
                        )
                    );

                if (
                    evaluationHistory[type]
                        .length >
                    MAX_EVALUATION_HISTORY
                ) {

                    evaluationHistory[type]
                        .splice(
                            MAX_EVALUATION_HISTORY
                        );
                }

                saveJSON(
                    HISTORY_FILE,
                    evaluationHistory
                );

                historyChanged = true;
            }
        }
    }

    // =====================================================
    // PUSH REALTIME
    // =====================================================

    if (newSession) {

        sendSSE(
            type,
            "result",
            {
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    displayResult(
                        latest.ket_qua
                    )
            }
        );
    }

    if (
        newSession ||
        historyChanged
    ) {

        sendSSE(
            type,
            "history",
            evaluationHistory[type]
        );
    }

    return result;
}

// =========================================================
// /lc79/tx/hu
// =========================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    "tx"
                );

            if (!data) {

                return res.json({
                    phien:
                        null,

                    xuc_xac:
                        [],

                    tong:
                        null,

                    ket_qua:
                        "⌛ Chờ",

                    phien_hien_tai:
                        null,

                    pattern:
                        "",

                    du_doan:
                        "Không rõ",

                    do_tin_cay:
                        "50%"
                });
            }

            res.json(data);

        } catch (error) {

            console.error(
                "[HU]",
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
// /lc79/tx/md5
// =========================================================

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    "md5"
                );

            if (!data) {

                return res.json({
                    phien:
                        null,

                    xuc_xac:
                        [],

                    tong:
                        null,

                    ket_qua:
                        "⌛ Chờ",

                    phien_hien_tai:
                        null,

                    pattern:
                        "",

                    du_doan:
                        "Không rõ",

                    do_tin_cay:
                        "50%"
                });
            }

            res.json(data);

        } catch (error) {

            console.error(
                "[MD5]",
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
// HU HISTORY
// =========================================================

app.get(
    "/api/lc79/hu/history",
    (req, res) => {

        res.json(
            evaluationHistory.tx
        );
    }
);

// =========================================================
// MD5 HISTORY
// =========================================================

app.get(
    "/api/lc79/md5/history",
    (req, res) => {

        res.json(
            evaluationHistory.md5
        );
    }
);

// =========================================================
// HU SSE
// =========================================================

app.get(
    "/api/lc79/hu/history/stream",
    (req, res) => {

        setupSSE(
            req,
            res,
            "tx"
        );
    }
);

// =========================================================
// MD5 SSE
// =========================================================

app.get(
    "/api/lc79/md5/history/stream",
    (req, res) => {

        setupSSE(
            req,
            res,
            "md5"
        );
    }
);

// =========================================================
// PATTERN INFO
// =========================================================

app.get(
    "/api/lc79/patterns",
    (req, res) => {

        res.json({

            total:
                SAMPLE_PATTERNS.length,

            length:
                15,

            patterns:
                SAMPLE_PATTERNS
        });
    }
);

// =========================================================
// AI INFO
// =========================================================

app.get(
    "/api/lc79/ai",
    (req, res) => {

        res.json({

            tx:
                aiMemory.tx,

            md5:
                aiMemory.md5,

            models:
                MODEL_NAMES.length,

            pattern_samples:
                SAMPLE_PATTERNS.length
        });
    }
);

// =========================================================
// REALTIME POLLING
// =========================================================

let polling = false;

async function realtimePoll() {

    if (polling) {
        return;
    }

    polling = true;

    try {

        await Promise.allSettled([

            processAPI(
                "tx"
            ),

            processAPI(
                "md5"
            )

        ]);

    } catch (error) {

        console.error(
            "[POLL]",
            error.message
        );

    } finally {

        polling = false;
    }
}

// =========================================================
// START POLLING
// =========================================================

setTimeout(
    () => {

        realtimePoll();

        setInterval(
            realtimePoll,
            POLL_INTERVAL
        );

    },
    500
);

// =========================================================
// ROOT
// =========================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status:
                "online",

            version:
                "LC79 AI 4.0",

            realtime:
                true,

            poll:
                "3s",

            pattern:
                "15",

            compare:
                "5",

            algorithms:
                MODEL_NAMES.length,

            pattern_samples:
                SAMPLE_PATTERNS.length,

            ai_learning:
                true,

            sse:
                true,

            endpoints: {

                hu:
                    "/lc79/tx/hu",

                md5:
                    "/lc79/tx/md5",

                hu_history:
                    "/api/lc79/hu/history",

                md5_history:
                    "/api/lc79/md5/history",

                hu_stream:
                    "/api/lc79/hu/history/stream",

                md5_stream:
                    "/api/lc79/md5/history/stream",

                patterns:
                    "/api/lc79/patterns",

                ai:
                    "/api/lc79/ai"
            }
        });
    }
);

// =========================================================
// 404
// =========================================================

app.use(
    (req, res) => {

        res.status(404).json({

            error: true,

            message:
                "Endpoint không tồn tại",

            path:
                req.path
        });
    }
);

// =========================================================
// ERROR HANDLER
// =========================================================

app.use(
    (err, req, res, next) => {

        console.error(
            "[SERVER ERROR]",
            err
        );

        if (
            res.headersSent
        ) {

            return next(err);
        }

        res.status(500).json({

            error: true,

            message:
                "Internal Server Error"
        });
    }
);

// =========================================================
// SERVER
// =========================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔══════════════════════════════════════════════════════╗
║                 LC79 AI 4.0                         ║
╠══════════════════════════════════════════════════════╣
║ PORT          : ${PORT}
║ POLL          : 3 giây
║ PATTERN       : 15 phiên
║ SO SÁNH       : 5 phiên
║ ALGORITHMS    : ${MODEL_NAMES.length}
║ PATTERNS      : ${SAMPLE_PATTERNS.length}+
║ AI LEARNING   : ON
║ SSE REALTIME  : ON
║ JSON MEMORY   : ON
╠══════════════════════════════════════════════════════╣
║ /lc79/tx/hu
║ /lc79/tx/md5
║ /api/lc79/hu/history
║ /api/lc79/md5/history
║ /api/lc79/hu/history/stream
║ /api/lc79/md5/history/stream
║ /api/lc79/patterns
║ /api/lc79/ai
╚══════════════════════════════════════════════════════╝
`);
    }
);
