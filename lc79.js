const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3001;

const SOURCE_API = {
    hu: "https://wtx.tele68.com/v1/tx/sessions",
    md5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

const POLL_INTERVAL = 3000;

const PATTERN_LENGTH = 15;
const MAX_SOURCE_HISTORY = 500;
const MAX_HISTORY = 100;
const MAX_PATTERN_MEMORY = 10000;

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

// =====================================================
// FILE STORAGE
// =====================================================

const MODEL_FILE =
    path.join(DATA_DIR, "models.json");

const HISTORY_FILE =
    path.join(DATA_DIR, "history.json");

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );
    } catch (error) {
        console.error(
            "[LOAD JSON]",
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
            "[SAVE JSON]",
            error.message
        );
    }
}

// =====================================================
// MODEL STORAGE
// =====================================================

const defaultModels = {
    hu: {
        pattern: {},
        bridge: {},
        markov: {
            TT: 1,
            TX: 1,
            XT: 1,
            XX: 1
        },
        dice: {
            face: {
                1: 1,
                2: 1,
                3: 1,
                4: 1,
                5: 1,
                6: 1
            },
            position: {
                1: {},
                2: {},
                3: {}
            },
            total: {},
            totalResult: {},
            triples: {}
        },
        performance: {
            model1: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model2: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model3: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model4: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model5: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model6: {
                correct: 0,
                wrong: 0,
                weight: 1
            }
        }
    },

    md5: {
        pattern: {},
        bridge: {},
        markov: {
            TT: 1,
            TX: 1,
            XT: 1,
            XX: 1
        },
        dice: {
            face: {
                1: 1,
                2: 1,
                3: 1,
                4: 1,
                5: 1,
                6: 1
            },
            position: {
                1: {},
                2: {},
                3: {}
            },
            total: {},
            totalResult: {},
            triples: {}
        },
        performance: {
            model1: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model2: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model3: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model4: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model5: {
                correct: 0,
                wrong: 0,
                weight: 1
            },
            model6: {
                correct: 0,
                wrong: 0,
                weight: 1
            }
        }
    }
};

const models =
    loadJSON(
        MODEL_FILE,
        defaultModels
    );

const savedHistory =
    loadJSON(
        HISTORY_FILE,
        {
            hu: [],
            md5: []
        }
    );

const history = {
    hu: Array.isArray(savedHistory.hu)
        ? savedHistory.hu
        : [],

    md5: Array.isArray(savedHistory.md5)
        ? savedHistory.md5
        : []
};

const sourceHistory = {
    hu: [],
    md5: []
};

const pending = {
    hu: new Map(),
    md5: new Map()
};

const clients = {
    hu: new Set(),
    md5: new Set()
};

// =====================================================
// UTILS
// =====================================================

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

function normalizeResult(value) {

    if (
        value === null ||
        value === undefined
    ) {
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

function toTX(value) {
    return normalizeResult(value) === "TAI"
        ? "T"
        : "X";
}

function txToResult(value) {
    return value === "T"
        ? "TAI"
        : "XIU";
}

function opposite(value) {
    return value === "T"
        ? "X"
        : "T";
}

// =====================================================
// FETCH API
// =====================================================

async function fetchSource(type) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            10000
        );

    try {

        const response =
            await fetch(
                SOURCE_API[type],
                {
                    headers: {
                        Accept:
                            "application/json",
                        "User-Agent":
                            "LC79-AI/7.0"
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
        clearTimeout(timer);
    }
}

// =====================================================
// NORMALIZE
// =====================================================

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

            let total =
                Number(item.point);

            if (!Number.isFinite(total)) {
                total =
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
                    total,

                ket_qua:
                    normalizeResult(
                        item.resultTruyenThong
                    )
            };
        })
        .filter(item =>
            Number.isFinite(
                item.phien
            ) &&
            item.xuc_xac.length === 3 &&
            item.ket_qua
        )
        .sort(
            (a, b) =>
                a.phien - b.phien
        );
}

// =====================================================
// PATTERN
// =====================================================

function buildPattern(
    sessions,
    length = PATTERN_LENGTH
) {

    return sessions
        .slice(-length)
        .map(
            item =>
                toTX(
                    item.ket_qua
                )
        )
        .join("");
}

function validPattern(pattern) {

    return (
        typeof pattern === "string" &&
        pattern.length ===
            PATTERN_LENGTH &&
        /^[TX]+$/.test(pattern)
    );
}

// =====================================================
// PATTERN SAMPLE GENERATOR
// =====================================================

function addPattern(
    set,
    pattern
) {

    if (
        validPattern(pattern)
    ) {
        set.add(pattern);
    }
}

function generatePatterns() {

    const set = new Set();

    // -----------------------------------------------
    // 1-1
    // -----------------------------------------------

    addPattern(
        set,
        "TXTXTXTXTXTXTXT"
    );

    addPattern(
        set,
        "XTXTXTXTXTXTXTX"
    );

    // -----------------------------------------------
    // Run patterns
    // -----------------------------------------------

    for (
        let a = 1;
        a <= 8;
        a++
    ) {

        for (
            let b = 1;
            b <= 8;
            b++
        ) {

            for (
                const first of [
                    "T",
                    "X"
                ]
            ) {

                let pattern = "";
                let current =
                    first;

                while (
                    pattern.length <
                    PATTERN_LENGTH
                ) {

                    const count =
                        current === first
                            ? a
                            : b;

                    pattern +=
                        current.repeat(
                            count
                        );

                    current =
                        opposite(
                            current
                        );
                }

                addPattern(
                    set,
                    pattern.slice(
                        0,
                        PATTERN_LENGTH
                    )
                );
            }
        }
    }

    // -----------------------------------------------
    // Manual pattern library
    // -----------------------------------------------

    const manual = [

        // 1-2
        "TXXTXXTXXTXXTXX",
        "XTTXTTXTTXTTXTT",

        // 2-1
        "TTXTTXTTXTTXTTX",
        "XXTXXTXXTXXTXXT",

        // 1-2-1
        "TXXTTXXTTXXTTXX",
        "XTTXXTTXXTTXXTT",

        // 2-1-2
        "TTXTTXXTTXXTTXX",
        "XXTXXTTXXTTXXTT",

        // 1-3-1
        "TXXXTTXXXTTXXXT",
        "XTTTXTTTXTTTXTT",

        // 3-1-3
        "TTTXTTTXTTTXTTT",
        "XXXTXXXTXXXTXXX",

        // 2-2
        "TTXXTTXXTTXXTTX",
        "XXTTXXTTXXTTXXT",

        // 3-2
        "TTTXXTTTXXTTTXX",
        "XXXTTXXXTTXXXTT",

        // 2-3
        "TTXXXTTXXXTTXXX",
        "XXTTTXXTTTXXTTT",

        // 3-3
        "TTTXXXTTTXXXTTT",
        "XXXTTTXXXTTTXXX",

        // 4-1
        "TTTTXTTTTXTTTTX",
        "XXXXTXXXXTXXXXT",

        // 1-4
        "TXXXXTXXXXTXXXX",
        "XTTTTXTTTTXTTTT",

        // 4-2
        "TTTTXXTTTTXXTTT",
        "XXXXTTXXXXTTXXX",

        // 2-4
        "TTXXXXTTXXXXTTX",
        "XXTTTTXXTTTTXXT",

        // 4-3
        "TTTTXXXTTTTXXX",
        "XXXXTTTXXXXTTT",

        // 3-4
        "TTTXXXXTTTXXXX",
        "XXXTTTTXXXTTTT",

        // 5-1
        "TTTTTXTTTTTXTTT",
        "XXXXXTXXXXXTXXX",

        // 1-5
        "TXXXXXTXXXXXTXX",
        "XTTTTTXTTTTTXTT",

        // 5-2
        "TTTTTXXTTTTTXX",
        "XXXXXTTXXXXXTT",

        // 2-5
        "TTXXXXTTTTTXXX",
        "XXTTTTTXXXXTTT",

        // 5-3
        "TTTTTXXXTTTTTXX",
        "XXXXXTTTXXXXXT",

        // 3-5
        "TTTXXXXXTTTXXXX",
        "XXXTTTTTXXXTTTT",

        // 6-1
        "TTTTTTXTTTTTTXT",
        "XXXXXXTXXXXXXTX",

        // 1-6
        "TXXXXXXTXXXXXXT",
        "XTTTTTTXTTTTTTX",

        // 6-2
        "TTTTTTXXTTTTTTX",
        "XXXXXXTTXXXXXXT",

        // 2-6
        "TTXXXXXXTTTTT",
        "XXTTTTTTXXTTT",

        // Alternating variants
        "TXTTXTTXTTXTTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTXTTXTXTTXTX",
        "XXTXTXTXTXTXTXT",

        "TXXTXXTXXTXXTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTTXXXTTXTTXX",
        "XXTXXTTTXTTXXTT",

        // Broken patterns
        "TTTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXXT",

        "TTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXT",

        "TTTTTTTTTTTTXX",
        "XXXXXXXXXXXXTT",

        // Symmetry
        "TTXXTXTTXTTXTTX",
        "XXTTXTXTXTTXTTX",

        "TXTTXXTTXXTTXTT",
        "XTTXXTTXXTTXXTT",

        // Complex
        "TTXXTTTXXTTXXTX",
        "XXTTXXXTTXXTTXT",

        "TTTXXTTXXTTTXXT",
        "XXXTTXXTTXXXTTX",

        "TXXTTTXTTXXTTTX",
        "XTTXXXTXTTXXTTT"
    ];

    for (
        const pattern of manual
    ) {
        addPattern(
            set,
            pattern
        );
    }

    return [
        ...set
    ];
}

const PATTERN_SAMPLES =
    generatePatterns();

// =====================================================
// MODEL 1
// PATTERN 15
// =====================================================

function model1Pattern(
    type,
    pattern
) {

    if (
        !validPattern(pattern)
    ) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    let tai = 0;
    let xiu = 0;
    let totalScore = 0;

    for (
        const sample
        of PATTERN_SAMPLES
    ) {

        let score = 0;

        for (
            let i = 0;
            i < PATTERN_LENGTH;
            i++
        ) {

            if (
                pattern[i] ===
                sample[i]
            ) {

                score +=
                    0.5 +
                    (
                        i /
                        PATTERN_LENGTH
                    );
            }
        }

        if (score < 7) {
            continue;
        }

        const last =
            sample[
                PATTERN_LENGTH - 1
            ];

        const next =
            opposite(last);

        if (next === "T") {
            tai += score;
        } else {
            xiu += score;
        }

        totalScore += score;
    }

    if (!totalScore) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const winner =
        Math.max(
            tai,
            xiu
        );

    const confidence =
        50 +
        (
            winner /
            totalScore -
            0.5
        ) * 80;

    return {
        prediction,

        confidence:
            clamp(
                confidence,
                50,
                95
            ),

        score:
            winner
    };
}

// =====================================================
// MODEL 2
// CẦU
// =====================================================

function getRun(pattern) {

    if (!pattern) {
        return {
            value: null,
            length: 0
        };
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

function model2Bridge(
    type,
    sessions
) {

    const pattern =
        buildPattern(sessions);

    const run =
        getRun(pattern);

    if (!run.value) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    let prediction =
        opposite(
            run.value
        );

    let confidence = 55;

    // Bệt dài
    if (run.length >= 5) {
        prediction =
            opposite(
                run.value
            );

        confidence += 10;
    }

    // 1-1
    if (
        pattern.endsWith(
            "TX"
        ) ||
        pattern.endsWith(
            "XT"
        )
    ) {

        prediction =
            opposite(
                run.value
            );

        confidence += 6;
    }

    // 1-2-1
    if (
        pattern.endsWith(
            "TXXT"
        ) ||
        pattern.endsWith(
            "XTTX"
        )
    ) {

        prediction =
            run.value;

        confidence += 7;
    }

    return {
        prediction:
            txToResult(
                prediction
            ),

        confidence:
            clamp(
                confidence,
                50,
                90
            ),

        score:
            confidence
    };
}

// =====================================================
// MODEL 3
// MARKOV
// =====================================================

function model3Markov(
    type,
    sessions
) {

    if (
        sessions.length < 3
    ) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const markov =
        models[type].markov;

    const pattern =
        buildPattern(
            sessions,
            100
        );

    const last =
        pattern[
            pattern.length - 1
        ];

    const tKey =
        last + "T";

    const xKey =
        last + "X";

    const t =
        Number(
            markov[tKey] || 1
        );

    const x =
        Number(
            markov[xKey] || 1
        );

    const total =
        t + x;

    const prediction =
        t >= x
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.max(t, x) /
            total -
            0.5
        ) * 80;

    return {
        prediction,
        confidence:
            clamp(
                confidence,
                50,
                92
            ),
        score:
            Math.max(t, x)
    };
}

// =====================================================
// MODEL 4
// XÚC XẮC
// =====================================================

function model4Dice(
    type,
    sessions
) {

    if (
        sessions.length < 10
    ) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const dice =
        models[type].dice;

    const recent =
        sessions.slice(-100);

    const latest =
        recent[
            recent.length - 1
        ];

    let taiScore = 0;
    let xiuScore = 0;

    // -----------------------------------------------
    // Face frequency
    // -----------------------------------------------

    for (
        const face of
        Object.keys(
            dice.face
        )
    ) {

        const weight =
            Number(
                dice.face[face]
            ) || 1;

        const count =
            recent.filter(
                session =>
                    session.xuc_xac
                        .includes(
                            Number(face)
                        )
            ).length;

        if (
            count > 0
        ) {

            const tx =
                Number(face) >= 4
                    ? "TAI"
                    : "XIU";

            if (tx === "TAI") {
                taiScore +=
                    count * weight;
            } else {
                xiuScore +=
                    count * weight;
            }
        }
    }

    // -----------------------------------------------
    // Total frequency
    // -----------------------------------------------

    const totals = {};

    for (
        const session
        of recent
    ) {

        const total =
            Number(
                session.tong
            );

        totals[total] =
            (
                totals[total] || 0
            ) + 1;
    }

    for (
        const [total, count]
        of Object.entries(totals)
    ) {

        if (
            Number(total) >= 11
        ) {
            taiScore +=
                count * 1.2;
        } else {
            xiuScore +=
                count * 1.2;
        }
    }

    // -----------------------------------------------
    // Latest dice
    // -----------------------------------------------

    if (
        latest &&
        latest.xuc_xac.length === 3
    ) {

        const sum =
            latest.xuc_xac.reduce(
                (a, b) =>
                    a + b,
                0
            );

        if (sum >= 11) {
            xiuScore += 1;
        } else {
            taiScore += 1;
        }
    }

    const totalScore =
        taiScore +
        xiuScore;

    if (!totalScore) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const prediction =
        taiScore >= xiuScore
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.max(
                taiScore,
                xiuScore
            ) /
            totalScore -
            0.5
        ) * 60;

    return {
        prediction,
        confidence:
            clamp(
                confidence,
                50,
                90
            ),
        score:
            Math.max(
                taiScore,
                xiuScore
            )
    };
}

// =====================================================
// MODEL 5
// AI MEMORY
// =====================================================

function getPatternMemory(
    type,
    pattern
) {

    const store =
        models[type].pattern;

    if (!store[pattern]) {

        store[pattern] = {
            pattern,
            tai: 0,
            xiu: 0,
            correct: 0,
            wrong: 0,
            weight: 1,
            total: 0
        };
    }

    return store[pattern];
}

function learnPatternMemory(
    type,
    sessions
) {

    if (
        sessions.length <=
        PATTERN_LENGTH
    ) {
        return;
    }

    const store =
        models[type].pattern;

    for (
        let i = PATTERN_LENGTH;
        i < sessions.length;
        i++
    ) {

        const pattern =
            buildPattern(
                sessions.slice(
                    i - PATTERN_LENGTH,
                    i
                )
            );

        const next =
            sessions[i].ket_qua;

        if (
            !validPattern(pattern)
        ) {
            continue;
        }

        const memory =
            getPatternMemory(
                type,
                pattern
            );

        if (next === "TAI") {
            memory.tai++;
        } else {
            memory.xiu++;
        }

        memory.total =
            memory.tai +
            memory.xiu;

        const accuracy =
            Math.max(
                memory.tai,
                memory.xiu
            ) /
            memory.total;

        memory.weight =
            clamp(
                0.5 +
                accuracy,
                0.5,
                2
            );
    }

    const keys =
        Object.keys(store);

    if (
        keys.length >
        MAX_PATTERN_MEMORY
    ) {

        keys.sort(
            (a, b) =>
                (
                    store[a].total || 0
                ) -
                (
                    store[b].total || 0
                )
        );

        const remove =
            keys.length -
            MAX_PATTERN_MEMORY;

        for (
            let i = 0;
            i < remove;
            i++
        ) {
            delete store[
                keys[i]
            ];
        }
    }
}

function model5Memory(
    type,
    pattern
) {

    const memory =
        models[type]
            .pattern[pattern];

    if (!memory) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    if (
        memory.tai ===
        memory.xiu
    ) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const prediction =
        memory.tai >
        memory.xiu
            ? "TAI"
            : "XIU";

    const accuracy =
        Math.max(
            memory.tai,
            memory.xiu
        ) /
        Math.max(
            1,
            memory.total
        );

    const confidence =
        50 +
        (
            accuracy -
            0.5
        ) * 80;

    return {
        prediction,
        confidence:
            clamp(
                confidence,
                50,
                95
            ),
        score:
            (
                Math.max(
                    memory.tai,
                    memory.xiu
                ) *
                (
                    memory.weight ||
                    1
                )
            )
    };
}

// =====================================================
// MODEL 6
// ENSEMBLE
// =====================================================

function model6Ensemble(
    type,
    results
) {

    const performance =
        models[type]
            .performance;

    let tai = 0;
    let xiu = 0;

    for (
        const [index, result]
        of results.entries()
    ) {

        if (
            !result ||
            !result.prediction
        ) {
            continue;
        }

        const modelName =
            `model${index + 1}`;

        const weight =
            Number(
                performance[
                    modelName
                ]?.weight
            ) || 1;

        const confidence =
            Number(
                result.confidence
            ) || 50;

        const vote =
            weight *
            (
                0.5 +
                confidence / 100
            );

        if (
            result.prediction ===
            "TAI"
        ) {
            tai += vote;
        } else {
            xiu += vote;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.max(
                tai,
                xiu
            ) /
            total -
            0.5
        ) * 90;

    return {
        prediction,
        confidence:
            clamp(
                confidence,
                50,
                98
            ),
        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// =====================================================
// ALL MODELS
// =====================================================

function runModels(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    const m1 =
        model1Pattern(
            type,
            pattern
        );

    const m2 =
        model2Bridge(
            type,
            sessions
        );

    const m3 =
        model3Markov(
            type,
            sessions
        );

    const m4 =
        model4Dice(
            type,
            sessions
        );

    const m5 =
        model5Memory(
            type,
            pattern
        );

    const models12345 = [
        m1,
        m2,
        m3,
        m4,
        m5
    ];

    const m6 =
        model6Ensemble(
            type,
            models12345
        );

    return {
        pattern,

        models: {
            model1: m1,
            model2: m2,
            model3: m3,
            model4: m4,
            model5: m5,
            model6: m6
        },

        final:
            m6
    };
}

// =====================================================
// LEARN MARKOV
// =====================================================

function learnMarkov(
    type,
    sessions
) {

    const markov =
        models[type].markov;

    for (
        let i = 1;
        i < sessions.length;
        i++
    ) {

        const previous =
            toTX(
                sessions[i - 1]
                    .ket_qua
            );

        const current =
            toTX(
                sessions[i]
                    .ket_qua
            );

        const key =
            previous + current;

        markov[key] =
            Number(
                markov[key] || 1
            ) + 1;
    }
}

// =====================================================
// LEARN DICE
// =====================================================

function learnDice(
    type,
    sessions
) {

    const dice =
        models[type].dice;

    for (
        const session
        of sessions
    ) {

        if (
            !Array.isArray(
                session.xuc_xac
            ) ||
            session.xuc_xac.length !== 3
        ) {
            continue;
        }

        // Face
        for (
            const face
            of session.xuc_xac
        ) {

            if (
                face < 1 ||
                face > 6
            ) {
                continue;
            }

            dice.face[face] =
                Number(
                    dice.face[face] ||
                    1
                ) + 1;
        }

        // Position
        session.xuc_xac
            .forEach(
                (
                    face,
                    index
                ) => {

                    const position =
                        index + 1;

                    const store =
                        dice.position[
                            position
                        ];

                    store[face] =
                        Number(
                            store[face] ||
                            0
                        ) + 1;
                }
            );

        // Total
        const total =
            Number(
                session.tong
            );

        dice.total[total] =
            Number(
                dice.total[total] ||
                0
            ) + 1;

        // Total → Result
        if (
            !dice.totalResult[
                total
            ]
        ) {

            dice.totalResult[
                total
            ] = {
                tai: 0,
                xiu: 0
            };
        }

        if (
            session.ket_qua ===
            "TAI"
        ) {

            dice.totalResult[
                total
            ].tai++;

        } else {

            dice.totalResult[
                total
            ].xiu++;
        }

        // Triple
        const triple =
            session.xuc_xac
                .join("-");

        dice.triples[
            triple
        ] =
            Number(
                dice.triples[
                    triple
                ] || 0
            ) + 1;
    }
}

// =====================================================
// LEARN EVERYTHING
// =====================================================

function learnAll(
    type,
    sessions
) {

    learnPatternMemory(
        type,
        sessions
    );

    learnMarkov(
        type,
        sessions
    );

    learnDice(
        type,
        sessions
    );

    saveJSON(
        MODEL_FILE,
        models
    );
}

// =====================================================
// MODEL PERFORMANCE
// =====================================================

function updateModelPerformance(
    type,
    session
) {

    const prediction =
        pending[type]
            .get(
                session.phien
            );

    if (!prediction) {
        return;
    }

    const actual =
        session.ket_qua;

    for (
        let i = 0;
        i < 5;
        i++
    ) {

        const result =
            prediction.models[
                `model${i + 1}`
            ];

        if (
            !result ||
            !result.prediction
        ) {
            continue;
        }

        const model =
            models[type]
                .performance[
                    `model${i + 1}`
                ];

        const correct =
            result.prediction ===
            actual;

        if (correct) {

            model.correct++;

            model.weight =
                clamp(
                    model.weight +
                    0.03,
                    0.25,
                    3
                );

        } else {

            model.wrong++;

            model.weight =
                clamp(
                    model.weight -
                    0.02,
                    0.25,
                    3
                );
        }
    }

    // Model 6
    if (
        prediction.final &&
        prediction.final.prediction
    ) {

        const model =
            models[type]
                .performance
                .model6;

        if (
            prediction.final
                .prediction ===
            actual
        ) {

            model.correct++;

            model.weight =
                clamp(
                    model.weight +
                    0.05,
                    0.25,
                    3
                );

        } else {

            model.wrong++;

            model.weight =
                clamp(
                    model.weight -
                    0.03,
                    0.25,
                    3
                );
        }
    }

    saveJSON(
        MODEL_FILE,
        models
    );

    pending[type]
        .delete(
            session.phien
        );
}

// =====================================================
// HISTORY
// =====================================================

function createPending(
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

function addHistory(
    type,
    phien,
    prediction
) {

    const exists =
        history[type].some(
            item =>
                item.phien ===
                phien
        );

    if (exists) {
        return false;
    }

    history[type]
        .unshift(
            createPending(
                phien,
                prediction
            )
        );

    if (
        history[type].length >
        MAX_HISTORY
    ) {

        history[type]
            .splice(
                MAX_HISTORY
            );
    }

    saveJSON(
        HISTORY_FILE,
        history
    );

    return true;
}

// =====================================================
// SETTLE HISTORY
// =====================================================

function settle(
    type,
    session
) {

    const item =
        history[type].find(
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

    item.danh_gia =
        normalizeResult(
            item.du_doan
        ) ===
        session.ket_qua
            ? "✅ Thắng"
            : "❌ Thua";

    updateModelPerformance(
        type,
        session
    );

    saveJSON(
        HISTORY_FILE,
        history
    );

    return true;
}

// =====================================================
// SSE
// =====================================================

function sendSSE(
    type,
    event,
    data
) {

    const message =
        `event: ${event}\n` +
        `data: ${JSON.stringify(
            data
        )}\n\n`;

    for (
        const client
        of clients[type]
    ) {

        try {

            client.write(
                message
            );

        } catch {

            clients[type]
                .delete(client);
        }
    }
}

function historyStream(
    req,
    res,
    type
) {

    res.status(200);

    res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
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

    clients[type]
        .add(res);

    res.write(
        "event: history\n"
    );

    res.write(
        `data: ${JSON.stringify(
            history[type]
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

            clients[type]
                .delete(res);
        }
    );
}

// =====================================================
// PROCESS
// =====================================================

async function processType(type) {

    try {

        const json =
            await fetchSource(
                type
            );

        const sessions =
            normalizeSessions(
                json
            );

        if (!sessions.length) {
            throw new Error(
                "API không có dữ liệu"
            );
        }

        const previous =
            sourceHistory[type];

        const oldLatest =
            previous.length
                ? previous[
                    previous.length - 1
                ]
                : null;

        sourceHistory[type] =
            sessions.slice(
                -MAX_SOURCE_HISTORY
            );

        // ---------------------------------------------
        // Đánh giá phiên cũ
        // ---------------------------------------------

        let changed = false;

        for (
            const session
            of sourceHistory[type]
        ) {

            if (
                settle(
                    type,
                    session
                )
            ) {
                changed = true;
            }
        }

        // ---------------------------------------------
        // AI học
        // ---------------------------------------------

        learnAll(
            type,
            sourceHistory[type]
        );

        // ---------------------------------------------
        // Cần 15 phiên
        // ---------------------------------------------

        if (
            sourceHistory[type].length <
            PATTERN_LENGTH
        ) {
            return null;
        }

        const latest =
            sourceHistory[type][
                sourceHistory[type]
                    .length - 1
            ];

        const pattern =
            buildPattern(
                sourceHistory[type]
            );

        // ---------------------------------------------
        // Chạy 6 model
        // ---------------------------------------------

        const analysis =
            runModels(
                type,
                sourceHistory[type]
            );

        const final =
            analysis.final;

        const nextPhien =
            latest.phien + 1;

        // ---------------------------------------------
        // Lưu prediction
        // ---------------------------------------------

        if (
            final &&
            final.prediction
        ) {

            if (
                !pending[type]
                    .has(nextPhien)
            ) {

                pending[type]
                    .set(
                        nextPhien,
                        analysis
                    );
            }

            if (
                addHistory(
                    type,
                    nextPhien,
                    final.prediction
                )
            ) {
                changed = true;
            }
        }

        // ---------------------------------------------
        // Phiên mới
        // ---------------------------------------------

        const newSession =
            !oldLatest ||
            oldLatest.phien !==
            latest.phien;

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

            changed = true;
        }

        // ---------------------------------------------
        // Realtime history
        // ---------------------------------------------

        if (changed) {

            sendSSE(
                type,
                "history",
                history[type]
            );
        }

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
                nextPhien,

            pattern,

            du_doan:
                final &&
                final.prediction
                    ? displayResult(
                        final.prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                final
                    ? `${final.confidence.toFixed(2)}%`
                    : "50.00%"
        };

    } catch (error) {

        console.error(
            `[${type.toUpperCase()}]`,
            error.message
        );

        return null;
    }
}

// =====================================================
// MAIN ENDPOINTS
// =====================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        const result =
            await processType(
                "hu"
            );

        if (!result) {

            return res.status(502)
                .json({
                    error: true,
                    message:
                        "API HU không phản hồi"
                });
        }

        res.json(result);
    }
);

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        const result =
            await processType(
                "md5"
            );

        if (!result) {

            return res.status(502)
                .json({
                    error: true,
                    message:
                        "API MD5 không phản hồi"
                });
        }

        res.json(result);
    }
);

// =====================================================
// HISTORY
// =====================================================

app.get(
    "/api/lc79/hu/history",
    (req, res) => {

        res.json(
            history.hu
        );
    }
);

app.get(
    "/api/lc79/md5/history",
    (req, res) => {

        res.json(
            history.md5
        );
    }
);

// =====================================================
// HISTORY REALTIME
// =====================================================

app.get(
    "/api/lc79/hu/history/stream",
    (req, res) => {

        historyStream(
            req,
            res,
            "hu"
        );
    }
);

app.get(
    "/api/lc79/md5/history/stream",
    (req, res) => {

        historyStream(
            req,
            res,
            "md5"
        );
    }
);

// =====================================================
// PATTERN SAMPLES
// =====================================================

app.get(
    "/api/lc79/patterns",
    (req, res) => {

        res.json({
            length:
                PATTERN_LENGTH,

            total:
                PATTERN_SAMPLES.length,

            patterns:
                PATTERN_SAMPLES
        });
    }
);

// =====================================================
// MODELS STATUS
// =====================================================

app.get(
    "/api/lc79/models",
    (req, res) => {

        const result = {};

        for (
            const type of [
                "hu",
                "md5"
            ]
        ) {

            result[type] = {
                model1:
                    models[type]
                        .performance
                        .model1,

                model2:
                    models[type]
                        .performance
                        .model2,

                model3:
                    models[type]
                        .performance
                        .model3,

                model4:
                    models[type]
                        .performance
                        .model4,

                model5:
                    models[type]
                        .performance
                        .model5,

                model6:
                    models[type]
                        .performance
                        .model6,

                learnedPatterns:
                    Object.keys(
                        models[type]
                            .pattern
                    ).length
            };
        }

        res.json(result);
    }
);

// =====================================================
// DICE AI
// =====================================================

app.get(
    "/api/lc79/dice-ai",
    (req, res) => {

        const type =
            req.query.type === "md5"
                ? "md5"
                : "hu";

        res.json(
            models[type].dice
        );
    }
);

// =====================================================
// PATTERN ANALYZE
// =====================================================

app.get(
    "/api/lc79/pattern/analyze",
    (req, res) => {

        const type =
            req.query.type === "md5"
                ? "md5"
                : "hu";

        const pattern =
            String(
                req.query.pattern || ""
            )
                .trim()
                .toUpperCase();

        if (
            !validPattern(pattern)
        ) {

            return res.status(400)
                .json({
                    error: true,
                    message:
                        `Pattern phải đúng ${PATTERN_LENGTH} ký tự`,
                    example:
                        "TTTXTTXXTXTTXTX"
                });
        }

        const sessions =
            sourceHistory[type];

        const m1 =
            model1Pattern(
                type,
                pattern
            );

        const m5 =
            model5Memory(
                type,
                pattern
            );

        const result =
            runModels(
                type,
                sessions
            );

        res.json({
            pattern,

            model1:
                m1,

            model5:
                m5,

            model6:
                result.final,

            du_doan:
                result.final
                    ?.prediction
                    ? displayResult(
                        result.final
                            .prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                result.final
                    ? `${result.final.confidence.toFixed(2)}%`
                    : "50.00%"
        });
    }
);

// =====================================================
// RESET MODELS
// =====================================================

app.post(
    "/api/lc79/models/reset",
    (req, res) => {

        for (
            const type of [
                "hu",
                "md5"
            ]
        ) {

            models[type].pattern = {};

            models[type].markov = {
                TT: 1,
                TX: 1,
                XT: 1,
                XX: 1
            };

            models[type].dice = {
                face: {
                    1: 1,
                    2: 1,
                    3: 1,
                    4: 1,
                    5: 1,
                    6: 1
                },
                position: {
                    1: {},
                    2: {},
                    3: {}
                },
                total: {},
                totalResult: {},
                triples: {}
            };

            for (
                let i = 1;
                i <= 6;
                i++
            ) {

                models[type]
                    .performance[
                        `model${i}`
                    ] = {
                        correct: 0,
                        wrong: 0,
                        weight: 1
                    };
            }
        }

        saveJSON(
            MODEL_FILE,
            models
        );

        res.json({
            success: true,
            message:
                "Đã reset toàn bộ 6 model"
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

            version:
                "LC79 AI 7.0",

            pattern:
                PATTERN_LENGTH,

            patternSamples:
                PATTERN_SAMPLES.length,

            models: 6,

            autoLearning:
                true,

            diceLearning:
                true,

            bridgeLearning:
                true,

            realtime:
                "SSE",

            polling:
                "3 seconds",

            endpoints: {
                hu:
                    "/lc79/tx/hu",

                md5:
                    "/lc79/tx/md5",

                huHistory:
                    "/api/lc79/hu/history",

                md5History:
                    "/api/lc79/md5/history",

                huStream:
                    "/api/lc79/hu/history/stream",

                md5Stream:
                    "/api/lc79/md5/history/stream",

                patterns:
                    "/api/lc79/patterns",

                models:
                    "/api/lc79/models",

                dice:
                    "/api/lc79/dice-ai",

                analyze:
                    "/api/lc79/pattern/analyze"
            }
        });
    }
);

// =====================================================
// 404
// =====================================================

app.use(
    (req, res) => {

        res.status(404)
            .json({
                error: true,
                message:
                    "Endpoint không tồn tại",
                path:
                    req.path
            });
    }
);

// =====================================================
// SERVER
// =====================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔══════════════════════════════════════════════════════╗
║                LC79 AI ENGINE 7.0                  ║
╠══════════════════════════════════════════════════════╣
║ Pattern chính       : 15 phiên                      ║
║ Pattern mẫu         : ${PATTERN_SAMPLES.length}                       ║
║ Model               : 6                             ║
║ AI Pattern          : ON                            ║
║ AI Cầu              : ON                            ║
║ AI Markov           : ON                            ║
║ AI Xúc Xắc          : ON                            ║
║ AI Memory           : ON                            ║
║ Ensemble            : ON                            ║
║ Auto Learning       : ON                            ║
║ Realtime History    : SSE                           ║
║ Auto Update         : 3 giây                       ║
╚══════════════════════════════════════════════════════╝
`);
    }
);

// =====================================================
// AUTO UPDATE
// =====================================================

let updating = false;

async function autoUpdate() {

    if (updating) {
        return;
    }

    updating = true;

    try {

        await Promise.allSettled([
            processType("hu"),
            processType("md5")
        ]);

    } catch (error) {

        console.error(
            "[AUTO]",
            error.message
        );

    } finally {

        updating = false;
    }
}

// Chạy ngay
autoUpdate();

// Sau đó mỗi 3 giây
setInterval(
    autoUpdate,
    POLL_INTERVAL
);
