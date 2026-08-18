"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));

// ============================================================
// LC79 ULTRA V22
// ============================================================

const PORT = Number(process.env.PORT || 3001);

const SOURCE_API = {
    hu: "https://wtx.tele68.com/v1/tx/sessions",
    md5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

const POLL_MS = 3000;

const PATTERN_LENGTH = 15;

const MAX_SOURCE_HISTORY = 500;
const MAX_API_HISTORY = 100;
const MAX_PATTERN_MEMORY = 20000;

const DATA_DIR =
    path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

// ============================================================
// FILE
// ============================================================

const MODEL_FILE =
    path.join(DATA_DIR, "ultra-v22-models.json");

const HISTORY_FILE =
    path.join(DATA_DIR, "ultra-v22-history.json");

const PATTERN_FILE =
    path.join(DATA_DIR, "ultra-v22-patterns.json");

// ============================================================
// JSON
// ============================================================

function loadJSON(file, fallback) {

    try {

        if (!fs.existsSync(file)) {
            return fallback;
        }

        const raw =
            fs.readFileSync(
                file,
                "utf8"
            );

        return JSON.parse(raw);

    } catch (error) {

        console.error(
            "[JSON LOAD]",
            file,
            error.message
        );

        return fallback;
    }
}

function saveJSON(file, data) {

    try {

        const temp =
            `${file}.tmp`;

        fs.writeFileSync(
            temp,
            JSON.stringify(
                data,
                null,
                2
            ),
            "utf8"
        );

        fs.renameSync(
            temp,
            file
        );

    } catch (error) {

        console.error(
            "[JSON SAVE]",
            file,
            error.message
        );
    }
}

// ============================================================
// DEFAULT MODEL
// ============================================================

function createModel() {

    return {

        patternMemory: {},

        markov: {
            TT: 1,
            TX: 1,
            XT: 1,
            XX: 1
        },

        transition3: {},

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
                "1": {},
                "2": {},
                "3": {}
            },

            total: {},

            totalResult: {},

            triple: {},

            pair: {},

            conditional: {}
        },

        performance: {},

        global: {
            correct: 0,
            wrong: 0,
            total: 0
        }
    };
}

function createPerformance() {

    const result = {};

    for (
        let i = 1;
        i <= 12;
        i++
    ) {

        result[`model${i}`] = {
            correct: 0,
            wrong: 0,
            total: 0,
            weight: 1
        };
    }

    return result;
}

function ensureModel(model) {

    if (!model) {
        model = createModel();
    }

    const fresh =
        createModel();

    model.patternMemory =
        model.patternMemory ||
        {};

    model.markov =
        model.markov ||
        fresh.markov;

    model.transition3 =
        model.transition3 ||
        {};

    model.dice =
        model.dice ||
        fresh.dice;

    model.dice.face =
        model.dice.face ||
        fresh.dice.face;

    model.dice.position =
        model.dice.position ||
        fresh.dice.position;

    model.dice.total =
        model.dice.total ||
        {};

    model.dice.totalResult =
        model.dice.totalResult ||
        {};

    model.dice.triple =
        model.dice.triple ||
        {};

    model.dice.pair =
        model.dice.pair ||
        {};

    model.dice.conditional =
        model.dice.conditional ||
        {};

    model.performance =
        model.performance ||
        createPerformance();

    for (
        let i = 1;
        i <= 12;
        i++
    ) {

        const key =
            `model${i}`;

        if (
            !model.performance[key]
        ) {

            model.performance[key] = {
                correct: 0,
                wrong: 0,
                total: 0,
                weight: 1
            };
        }
    }

    model.global =
        model.global || {
            correct: 0,
            wrong: 0,
            total: 0
        };

    return model;
}

const models = {

    hu:
        ensureModel(
            loadJSON(
                MODEL_FILE,
                {}
            ).hu
        ),

    md5:
        ensureModel(
            loadJSON(
                MODEL_FILE,
                {}
            ).md5
        )
};

// ============================================================
// HISTORY
// ============================================================

const savedHistory =
    loadJSON(
        HISTORY_FILE,
        {}
    );

const history = {

    hu:
        Array.isArray(
            savedHistory.hu
        )
            ? savedHistory.hu
            : [],

    md5:
        Array.isArray(
            savedHistory.md5
        )
            ? savedHistory.md5
            : []
};

// ============================================================
// SOURCE
// ============================================================

const sourceHistory = {
    hu: [],
    md5: []
};

const lastSourceId = {
    hu: null,
    md5: null
};

const pendingPredictions = {
    hu: new Map(),
    md5: new Map()
};

// ============================================================
// SSE
// ============================================================

const clients = {
    hu: new Set(),
    md5: new Set()
};

// ============================================================
// UTIL
// ============================================================

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

function number(value) {

    const n =
        Number(value);

    return Number.isFinite(n)
        ? n
        : 0;
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

function safeArray(value) {

    return Array.isArray(value)
        ? value
        : [];
}

function validPattern(pattern) {

    return (
        typeof pattern === "string" &&
        pattern.length ===
            PATTERN_LENGTH &&
        /^[TX]+$/.test(pattern)
    );
}

// ============================================================
// NORMALIZE API
// ============================================================

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
                safeArray(item.dices)
                    .map(Number)
                    .filter(
                        n =>
                            n >= 1 &&
                            n <= 6
                    );

            let total =
                number(
                    item.point
                );

            if (
                !total &&
                dices.length
            ) {

                total =
                    dices.reduce(
                        (a, b) =>
                            a + b,
                        0
                    );
            }

            return {

                phien:
                    number(item.id),

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

            item.phien > 0 &&

            item.xuc_xac.length === 3 &&

            item.ket_qua
        )
        .sort(
            (a, b) =>
                a.phien -
                b.phien
        );
}

// ============================================================
// FETCH
// ============================================================

async function fetchSource(type) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () =>
                controller.abort(),
            10000
        );

    try {

        const response =
            await fetch(
                SOURCE_API[type],
                {
                    method: "GET",

                    headers: {
                        Accept:
                            "application/json",
                        "User-Agent":
                            "LC79-ULTRA-V22"
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

// ============================================================
// PATTERN
// ============================================================

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

function patternAt(
    sessions,
    endIndex,
    length = PATTERN_LENGTH
) {

    const start =
        endIndex -
        length;

    if (start < 0) {
        return null;
    }

    return sessions
        .slice(
            start,
            endIndex
        )
        .map(
            item =>
                toTX(
                    item.ket_qua
                )
        )
        .join("");
}

// ============================================================
// PATTERN GENERATOR
// ============================================================

function generatePatternSamples() {

    const set =
        new Set();

    function add(pattern) {

        if (
            validPattern(pattern)
        ) {
            set.add(pattern);
        }
    }

    // Alternating
    add(
        "TXTXTXTXTXTXTXT"
    );

    add(
        "XTXTXTXTXTXTXTX"
    );

    // Run templates
    for (
        let a = 1;
        a <= 7;
        a++
    ) {

        for (
            let b = 1;
            b <= 7;
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

                add(
                    pattern.slice(
                        0,
                        PATTERN_LENGTH
                    )
                );
            }
        }
    }

    // Manual complex patterns
    const manual = [

        "TTTXTTXTTTXTTXX",
        "XXXTXXTXXXTXTTX",

        "TTXXTTTXXTTXXTX",
        "XXTTXXXTTXXTTXT",

        "TXXTTXXTTTXXTTX",
        "XTTXXTTXXXTTXXT",

        "TTTXXTTXXTTTXXT",
        "XXXTTXXTTXXXTTX",

        "TTXXTXXTTXXTTTX",
        "XXTTXTTXXTTXXXT",

        "TXXTXXXTTXXTTXT",
        "XTTXTTTXXTTXXTX",

        "TTTTXTTXXTTTTXX",
        "XXXXTXXTTXXXXTT",

        "TTXXTTTTXXTTXXT",
        "XXTTXXXXTTXXTTX",

        "TTTXXXTTXTTTXXX",
        "XXXTTTXXTXXXTTT",

        "TXXTTTXTTXXTTTX",
        "XTTXXXTXTTXXTTT",

        "TTXXTTXXTXXXTTX",
        "XXTTXXTTXTTTXXT",

        "TTTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXXT",

        "TTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXT",

        "TTTTTTTTTTTTXX",
        "XXXXXXXXXXXXTT",

        "TTTTTXXTTTTTXX",
        "XXXXXTTXXXXXTT",

        "TTXXXTTXXXTTXXX",
        "XXTTTXXTTTXXTTT",

        "TTXTTXXTXTTXXTX",
        "XXTXXTTXTXTTXTT",

        "TXTTXTTXXTTXTTX",
        "XTTXTTXXTTXTTXT",

        "TTXTXTTXTXTTXTX",
        "XXTXTXTTXTTXTXT",

        "TXXTTXTTXXTXXTT",
        "XTTXXTTXXTXTTXX",

        "TTXXTTTXXXTTXXT",
        "XXTTXXXTTTXXTTX",

        "TTTXXTTTTXXTTXX",
        "XXXTTXXXXXTTXXT",

        "TXTXTTXTXTTXTTX",
        "XTXTTXTXTTXTTXT",

        "TTTTXXTTXXXTTTX",
        "XXXXTTXXXXTTTTX",

        "TTXXXTTTTXXTTTX",
        "XXTTTXXXXTTXXTT",

        "TTXXTTXXTTXXTTX",
        "XXTTXXTTXXTTXXT",

        "TXXTXXTXXTXXTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTTXTTXTTXTTX",
        "XXTXXTXXTXXTXXT"
    ];

    for (
        const pattern of manual
    ) {
        add(pattern);
    }

    return [
        ...set
    ];
}

const PATTERN_SAMPLES =
    generatePatternSamples();

// ============================================================
// SAVE PATTERN LIBRARY
// ============================================================

const savedPatterns =
    loadJSON(
        PATTERN_FILE,
        null
    );

if (
    !savedPatterns ||
    !Array.isArray(
        savedPatterns.patterns
    )
) {

    saveJSON(
        PATTERN_FILE,
        {
            version:
                "ULTRA-V22",

            length:
                PATTERN_LENGTH,

            patterns:
                PATTERN_SAMPLES
        }
    );
}

// ============================================================
// SIMILARITY
// ============================================================

function patternSimilarity(
    a,
    b
) {

    if (
        !validPattern(a) ||
        !validPattern(b)
    ) {
        return 0;
    }

    let score = 0;

    for (
        let i = 0;
        i < PATTERN_LENGTH;
        i++
    ) {

        if (
            a[i] === b[i]
        ) {

            const positionWeight =
                1 +
                (
                    i /
                    PATTERN_LENGTH
                );

            score +=
                positionWeight;
        }
    }

    const max =
        PATTERN_LENGTH +
        (
            (
                PATTERN_LENGTH - 1
            ) /
            2
        );

    return clamp(
        score / max,
        0,
        1
    );
}

// ============================================================
// MODEL 1
// EXACT PATTERN
// ============================================================

function model1Exact(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    if (
        !validPattern(pattern)
    ) {

        return null;
    }

    const memory =
        models[type]
            .patternMemory[
                pattern
            ];

    if (!memory) {

        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const total =
        memory.tai +
        memory.xiu;

    if (!total) {

        return {
            prediction: null,
            confidence: 50,
            score: 0
        };
    }

    const tai =
        memory.tai;

    const xiu =
        memory.xiu;

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const accuracy =
        Math.max(
            tai,
            xiu
        ) /
        total;

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    accuracy -
                    0.5
                ) * 90,

                50,
                97
            ),

        score:
            total *
            (
                memory.weight ||
                1
            )
    };
}

// ============================================================
// MODEL 2
// TEMPLATE SIMILARITY
// ============================================================

function model2Template(
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    if (
        !validPattern(pattern)
    ) {
        return null;
    }

    let tai = 0;
    let xiu = 0;
    let weightTotal = 0;

    for (
        const sample
        of PATTERN_SAMPLES
    ) {

        const similarity =
            patternSimilarity(
                pattern,
                sample
            );

        if (
            similarity <
            0.55
        ) {
            continue;
        }

        const weight =
            Math.pow(
                similarity,
                4
            );

        const next =
            opposite(
                sample[
                    PATTERN_LENGTH - 1
                ]
            );

        if (next === "T") {
            tai += weight;
        } else {
            xiu += weight;
        }

        weightTotal +=
            weight;
    }

    if (!weightTotal) {
        return null;
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
            weightTotal -
            0.5
        ) * 90;

    return {

        prediction,

        confidence:
            clamp(
                confidence,
                50,
                96
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 3
// STREAK
// ============================================================

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

    let length = 0;

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

            length++;

        } else {

            break;
        }
    }

    return {
        value: last,
        length
    };
}

function model3Streak(
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    const run =
        getRun(pattern);

    if (!run.value) {
        return null;
    }

    let prediction =
        run.value;

    let confidence =
        55;

    if (
        run.length === 1
    ) {

        prediction =
            opposite(
                run.value
            );

        confidence = 56;
    }

    if (
        run.length === 2
    ) {

        confidence = 58;
    }

    if (
        run.length === 3
    ) {

        confidence = 60;
    }

    if (
        run.length >= 4
    ) {

        prediction =
            opposite(
                run.value
            );

        confidence =
            63 +
            Math.min(
                run.length - 4,
                5
            ) * 2;
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
                78
            ),

        score:
            confidence
    };
}

// ============================================================
// MODEL 4
// MARKOV 1
// ============================================================

function model4Markov(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions,
            100
        );

    if (
        pattern.length < 2
    ) {
        return null;
    }

    const last =
        pattern[
            pattern.length - 1
        ];

    const markov =
        models[type].markov;

    const t =
        number(
            markov[
                last + "T"
            ]
        ) || 1;

    const x =
        number(
            markov[
                last + "X"
            ]
        ) || 1;

    const total =
        t + x;

    const prediction =
        t >= x
            ? "TAI"
            : "XIU";

    const probability =
        Math.max(
            t,
            x
        ) /
        total;

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    probability -
                    0.5
                ) * 100,

                50,
                94
            ),

        score:
            Math.max(
                t,
                x
            )
    };
}

// ============================================================
// MODEL 5
// TRANSITION 3
// ============================================================

function model5Transition3(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions,
            100
        );

    if (
        pattern.length < 4
    ) {
        return null;
    }

    const key =
        pattern.slice(-3);

    const memory =
        models[type]
            .transition3[key];

    if (!memory) {
        return null;
    }

    const tai =
        number(memory.T);

    const xiu =
        number(memory.X);

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    Math.max(
                        tai,
                        xiu
                    ) /
                    total -
                    0.5
                ) * 100,

                50,
                96
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 6
// FREQUENCY
// ============================================================

function model6Frequency(
    sessions
) {

    if (
        sessions.length < 5
    ) {
        return null;
    }

    const windows = [
        10,
        20,
        50,
        100
    ];

    let tai = 0;
    let xiu = 0;
    let totalWeight = 0;

    for (
        const window of windows
    ) {

        const data =
            sessions.slice(
                -window
            );

        if (!data.length) {
            continue;
        }

        let t = 0;
        let x = 0;

        for (
            const item
            of data
        ) {

            if (
                item.ket_qua ===
                "TAI"
            ) {

                t++;

            } else {

                x++;
            }
        }

        const weight =
            1 /
            Math.sqrt(window);

        tai +=
            t * weight;

        xiu +=
            x * weight;

        totalWeight +=
            (
                t + x
            ) * weight;
    }

    if (!totalWeight) {
        return null;
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
            totalWeight -
            0.5
        ) * 70;

    return {

        prediction,

        confidence:
            clamp(
                confidence,
                50,
                88
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 7
// DICE DISTRIBUTION
// ============================================================

function model7Dice(
    type,
    sessions
) {

    if (
        sessions.length < 10
    ) {
        return null;
    }

    const dice =
        models[type].dice;

    const recent =
        sessions.slice(-100);

    let tai = 0;
    let xiu = 0;

    for (
        const item
        of recent
    ) {

        const dices =
            item.xuc_xac;

        if (
            dices.length !== 3
        ) {
            continue;
        }

        const sum =
            dices[0] +
            dices[1] +
            dices[2];

        const triple =
            dices.join("-");

        const pair =
            [
                dices[0],
                dices[1]
            ].sort()
                .join("-");

        const tripleCount =
            number(
                dice.triple[
                    triple
                ]
            );

        const pairCount =
            number(
                dice.pair[
                    pair
                ]
            );

        const weight =
            1 +
            Math.log1p(
                tripleCount
            ) * 0.1 +
            Math.log1p(
                pairCount
            ) * 0.05;

        if (
            item.ket_qua ===
            "TAI"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }

        // Giảm bias theo tổng
        if (sum >= 11) {
            tai += 0.15;
        } else {
            xiu += 0.15;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    Math.max(
                        tai,
                        xiu
                    ) /
                    total -
                    0.5
                ) * 65,

                50,
                88
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 8
// TOTAL
// ============================================================

function model8Total(
    type,
    sessions
) {

    const dice =
        models[type].dice;

    let tai = 0;
    let xiu = 0;

    for (
        const [total, data]
        of Object.entries(
            dice.totalResult
        )
    ) {

        const t =
            number(data.tai);

        const x =
            number(data.xiu);

        const count =
            t + x;

        if (!count) {
            continue;
        }

        const probability =
            Math.max(
                t,
                x
            ) / count;

        const weight =
            Math.log1p(count);

        if (t >= x) {
            tai +=
                probability *
                weight;
        } else {
            xiu +=
                probability *
                weight;
        }
    }

    if (
        tai + xiu <= 0
    ) {
        return null;
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
            (
                tai + xiu
            ) -
            0.5
        ) * 70;

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
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 9
// MEMORY
// ============================================================

function model9Memory(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    const memory =
        models[type]
            .patternMemory[
                pattern
            ];

    if (!memory) {
        return null;
    }

    const tai =
        number(memory.tai);

    const xiu =
        number(memory.xiu);

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const accuracy =
        Math.max(
            tai,
            xiu
        ) /
        total;

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    accuracy -
                    0.5
                ) * 95,

                50,
                98
            ),

        score:
            total *
            (
                number(
                    memory.weight
                ) || 1
            )
    };
}

// ============================================================
// MODEL 10
// RECENT WINDOW
// ============================================================

function model10Recent(
    sessions
) {

    const data =
        sessions.slice(-7);

    if (
        data.length < 3
    ) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    data.forEach(
        (
            item,
            index
        ) => {

            const weight =
                index + 1;

            if (
                item.ket_qua ===
                "TAI"
            ) {

                tai += weight;

            } else {

                xiu += weight;
            }
        }
    );

    const total =
        tai + xiu;

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    return {

        prediction,

        confidence:
            clamp(
                50 +
                (
                    Math.max(
                        tai,
                        xiu
                    ) /
                    total -
                    0.5
                ) * 80,

                50,
                91
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// MODEL 11
// ANTI PATTERN
// ============================================================

function model11AntiPattern(
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    const run =
        getRun(pattern);

    if (!run.value) {
        return null;
    }

    let prediction;

    if (
        run.length >= 4
    ) {

        prediction =
            opposite(
                run.value
            );

    } else {

        prediction =
            run.value;
    }

    const confidence =
        run.length >= 4
            ? 70
            : 55;

    return {

        prediction:
            txToResult(
                prediction
            ),

        confidence,

        score:
            confidence
    };
}

// ============================================================
// MODEL 12
// META ENSEMBLE
// ============================================================

function model12Ensemble(
    type,
    results
) {

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < results.length;
        i++
    ) {

        const result =
            results[i];

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

        const weight =
            clamp(
                number(
                    model.weight
                ) || 1,

                0.15,
                4
            );

        const confidence =
            clamp(
                number(
                    result.confidence
                ) || 50,

                50,
                99
            );

        const vote =
            weight *
            (
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
        ) * 100;

    return {

        prediction,

        confidence:
            clamp(
                confidence,
                50,
                98.5
            ),

        score:
            Math.max(
                tai,
                xiu
            )
    };
}

// ============================================================
// RUN ALL
// ============================================================

function runUltra(
    type,
    sessions
) {

    const pattern =
        buildPattern(
            sessions
        );

    const results = [

        model1Exact(
            type,
            sessions
        ),

        model2Template(
            sessions
        ),

        model3Streak(
            sessions
        ),

        model4Markov(
            type,
            sessions
        ),

        model5Transition3(
            type,
            sessions
        ),

        model6Frequency(
            sessions
        ),

        model7Dice(
            type,
            sessions
        ),

        model8Total(
            type,
            sessions
        ),

        model9Memory(
            type,
            sessions
        ),

        model10Recent(
            sessions
        ),

        model11AntiPattern(
            sessions
        )
    ];

    const final =
        model12Ensemble(
            type,
            results
        );

    return {
        pattern,

        model1: results[0],
        model2: results[1],
        model3: results[2],
        model4: results[3],
        model5: results[4],
        model6: results[5],
        model7: results[6],
        model8: results[7],
        model9: results[8],
        model10: results[9],
        model11: results[10],

        model12: final,

        final
    };
}

// ============================================================
// LEARN PATTERN
// ============================================================

function learnPattern(
    type,
    sessions
) {

    const model =
        models[type];

    if (
        sessions.length <=
        PATTERN_LENGTH
    ) {
        return;
    }

    for (
        let i =
            PATTERN_LENGTH;
        i < sessions.length;
        i++
    ) {

        const pattern =
            patternAt(
                sessions,
                i
            );

        if (
            !validPattern(pattern)
        ) {
            continue;
        }

        const result =
            sessions[i]
                .ket_qua;

        if (
            !model.patternMemory[
                pattern
            ]
        ) {

            model.patternMemory[
                pattern
            ] = {

                tai: 0,
                xiu: 0,

                correct: 0,
                wrong: 0,

                weight: 1,

                total: 0,

                lastSeen:
                    sessions[i]
                        .phien
            };
        }

        const memory =
            model.patternMemory[
                pattern
            ];

        if (
            result ===
            "TAI"
        ) {

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
            Math.max(
                1,
                memory.total
            );

        memory.weight =
            clamp(
                0.5 +
                accuracy,

                0.5,
                2
            );

        memory.lastSeen =
            sessions[i]
                .phien;
    }

    const keys =
        Object.keys(
            model.patternMemory
        );

    if (
        keys.length >
        MAX_PATTERN_MEMORY
    ) {

        keys.sort(
            (a, b) =>
                number(
                    model
                        .patternMemory[a]
                        .total
                ) -
                number(
                    model
                        .patternMemory[b]
                        .total
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

            delete model
                .patternMemory[
                    keys[i]
                ];
        }
    }
}

// ============================================================
// LEARN MARKOV
// ============================================================

function learnMarkov(
    type,
    sessions
) {

    const model =
        models[type];

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
            previous +
            current;

        model.markov[key] =
            number(
                model.markov[key]
            ) + 1;
    }

    for (
        let i = 3;
        i < sessions.length;
        i++
    ) {

        const key =
            sessions
                .slice(
                    i - 3,
                    i
                )
                .map(
                    x =>
                        toTX(
                            x.ket_qua
                        )
                )
                .join("");

        const result =
            toTX(
                sessions[i]
                    .ket_qua
            );

        if (
            !model.transition3[
                key
            ]
        ) {

            model.transition3[
                key
            ] = {
                T: 1,
                X: 1
            };
        }

        model.transition3[
            key
        ][result]++;
    }
}

// ============================================================
// LEARN DICE
// ============================================================

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

        const d =
            session.xuc_xac;

        if (
            d.length !== 3
        ) {
            continue;
        }

        // Face
        for (
            const face of d
        ) {

            dice.face[face] =
                number(
                    dice.face[face]
                ) + 1;
        }

        // Position
        d.forEach(
            (
                face,
                index
            ) => {

                const position =
                    String(
                        index + 1
                    );

                if (
                    !dice.position[
                        position
                    ]
                ) {

                    dice.position[
                        position
                    ] = {};
                }

                dice.position[
                    position
                ][face] =
                    number(
                        dice.position[
                            position
                        ][face]
                    ) + 1;
            }
        );

        // Total
        const total =
            number(
                session.tong
            );

        dice.total[
            total
        ] =
            number(
                dice.total[
                    total
                ]
            ) + 1;

        // Total result
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
            d.join("-");

        dice.triple[
            triple
        ] =
            number(
                dice.triple[
                    triple
                ]
            ) + 1;

        // Pair
        const pairs = [
            [
                d[0],
                d[1]
            ],
            [
                d[0],
                d[2]
            ],
            [
                d[1],
                d[2]
            ]
        ];

        for (
            const pair of pairs
        ) {

            const key =
                pair
                    .slice()
                    .sort(
                        (a, b) =>
                            a - b
                    )
                    .join("-");

            dice.pair[
                key
            ] =
                number(
                    dice.pair[
                        key
                    ]
                ) + 1;
        }
    }
}

// ============================================================
// LEARN
// ============================================================

const learnedFingerprint = {
    hu: 0,
    md5: 0
};

function learnAll(
    type,
    sessions
) {

    if (!sessions.length) {
        return;
    }

    const newest =
        sessions[
            sessions.length - 1
        ].phien;

    if (
        learnedFingerprint[type] ===
        newest
    ) {
        return;
    }

    learnPattern(
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

    learnedFingerprint[type] =
        newest;

    saveJSON(
        MODEL_FILE,
        models
    );
}

// ============================================================
// MODEL FEEDBACK
// ============================================================

function updatePerformance(
    type,
    phien,
    actual
) {

    const prediction =
        pendingPredictions[type]
            .get(phien);

    if (!prediction) {
        return;
    }

    for (
        let i = 1;
        i <= 12;
        i++
    ) {

        const result =
            prediction[
                `model${i}`
            ];

        if (
            !result ||
            !result.prediction
        ) {
            continue;
        }

        const perf =
            models[type]
                .performance[
                    `model${i}`
                ];

        perf.total++;

        if (
            result.prediction ===
            actual
        ) {

            perf.correct++;

            perf.weight =
                clamp(
                    perf.weight +
                    0.04,

                    0.2,
                    4
                );

        } else {

            perf.wrong++;

            perf.weight =
                clamp(
                    perf.weight -
                    0.025,

                    0.2,
                    4
                );
        }
    }

    const final =
        prediction.final;

    if (
        final &&
        final.prediction
    ) {

        models[type]
            .global.total++;

        if (
            final.prediction ===
            actual
        ) {

            models[type]
                .global.correct++;

        } else {

            models[type]
                .global.wrong++;
        }
    }

    pendingPredictions[type]
        .delete(phien);

    saveJSON(
        MODEL_FILE,
        models
    );
}

// ============================================================
// HISTORY
// ============================================================

function addPendingHistory(
    type,
    phien,
    prediction
) {

    if (
        history[type]
            .some(
                x =>
                    x.phien ===
                    phien
            )
    ) {
        return false;
    }

    history[type]
        .unshift({

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
        });

    history[type] =
        history[type]
            .slice(
                0,
                MAX_API_HISTORY
            );

    saveJSON(
        HISTORY_FILE,
        history
    );

    return true;
}

function settleHistory(
    type,
    session
) {

    const item =
        history[type]
            .find(
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

    const prediction =
        normalizeResult(
            item.du_doan
        );

    item.danh_gia =
        prediction ===
        session.ket_qua

            ? "✅ Thắng"

            : "❌ Thua";

    updatePerformance(
        type,
        session.phien,
        session.ket_qua
    );

    saveJSON(
        HISTORY_FILE,
        history
    );

    return true;
}

// ============================================================
// SSE
// ============================================================

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

function streamHistory(
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

// ============================================================
// PROCESS
// ============================================================

async function processType(
    type
) {

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
                "Không có session"
            );
        }

        const previousLatest =
            lastSourceId[type];

        sourceHistory[type] =
            sessions.slice(
                -MAX_SOURCE_HISTORY
            );

        // Học dữ liệu mới
        learnAll(
            type,
            sourceHistory[type]
        );

        // Chốt các phiên chờ
        let changed = false;

        for (
            const session
            of sourceHistory[type]
        ) {

            if (
                settleHistory(
                    type,
                    session
                )
            ) {

                changed = true;
            }
        }

        if (
            sourceHistory[type]
                .length <
            PATTERN_LENGTH
        ) {

            return null;
        }

        const latest =
            sourceHistory[type][
                sourceHistory[type]
                    .length - 1
            ];

        const nextPhien =
            latest.phien + 1;

        const analysis =
            runUltra(
                type,
                sourceHistory[type]
            );

        const final =
            analysis.final;

        if (
            final &&
            final.prediction
        ) {

            pendingPredictions[type]
                .set(
                    nextPhien,
                    analysis
                );

            if (
                addPendingHistory(
                    type,
                    nextPhien,
                    final.prediction
                )
            ) {

                changed = true;
            }
        }

        const newSession =
            previousLatest === null ||
            previousLatest !==
                latest.phien;

        lastSourceId[type] =
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

            pattern:
                analysis.pattern,

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

// ============================================================
// API
// ============================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        const result =
            await processType(
                "hu"
            );

        if (!result) {

            return res
                .status(502)
                .json({
                    error: true,
                    message:
                        "Không lấy được API HU"
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

            return res
                .status(502)
                .json({
                    error: true,
                    message:
                        "Không lấy được API MD5"
                });
        }

        res.json(result);
    }
);

// ============================================================
// HISTORY
// ============================================================

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

// ============================================================
// SSE
// ============================================================

app.get(
    "/api/lc79/hu/history/stream",
    (req, res) => {

        streamHistory(
            req,
            res,
            "hu"
        );
    }
);

app.get(
    "/api/lc79/md5/history/stream",
    (req, res) => {

        streamHistory(
            req,
            res,
            "md5"
        );
    }
);

// ============================================================
// PATTERNS
// ============================================================

app.get(
    "/api/lc79/patterns",
    (req, res) => {

        res.json({

            version:
                "ULTRA-V22",

            length:
                PATTERN_LENGTH,

            total:
                PATTERN_SAMPLES.length,

            patterns:
                PATTERN_SAMPLES
        });
    }
);

// ============================================================
// MODEL STATUS
// ============================================================

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

            const model =
                models[type];

            const performance = {};

            for (
                let i = 1;
                i <= 12;
                i++
            ) {

                performance[
                    `model${i}`
                ] =
                    model.performance[
                        `model${i}`
                    ];
            }

            result[type] = {

                version:
                    "ULTRA-V22",

                models: 12,

                patternLength:
                    PATTERN_LENGTH,

                patternSamples:
                    PATTERN_SAMPLES.length,

                learnedPatterns:
                    Object.keys(
                        model.patternMemory
                    ).length,

                performance,

                global:
                    model.global
            };
        }

        res.json(result);
    }
);

// ============================================================
// DICE
// ============================================================

app.get(
    "/api/lc79/dice-ai",
    (req, res) => {

        const type =
            req.query.type ===
            "md5"
                ? "md5"
                : "hu";

        res.json(
            models[type].dice
        );
    }
);

// ============================================================
// ANALYZE PATTERN
// ============================================================

app.get(
    "/api/lc79/pattern/analyze",
    async (req, res) => {

        const type =
            req.query.type ===
            "md5"
                ? "md5"
                : "hu";

        const pattern =
            String(
                req.query.pattern ||
                ""
            )
                .trim()
                .toUpperCase();

        if (
            !validPattern(pattern)
        ) {

            return res
                .status(400)
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

        const fakeSessions =
            sessions.length
                ? sessions
                : [];

        const result =
            runUltra(
                type,
                fakeSessions
            );

        const similarity = [];

        for (
            const sample
            of PATTERN_SAMPLES
        ) {

            similarity.push({

                pattern:
                    sample,

                similarity:
                    Number(
                        (
                            patternSimilarity(
                                pattern,
                                sample
                            ) * 100
                        ).toFixed(2)
                    )
            });
        }

        similarity.sort(
            (a, b) =>
                b.similarity -
                a.similarity
        );

        res.json({

            pattern,

            topPatterns:
                similarity.slice(
                    0,
                    20
                ),

            model1:
                model1Exact(
                    type,
                    fakeSessions
                ),

            model2:
                model2Template(
                    fakeSessions
                ),

            model12:
                result.final
        });
    }
);

// ============================================================
// LEARNING MEMORY
// ============================================================

app.get(
    "/api/lc79/learning",
    (req, res) => {

        const type =
            req.query.type ===
            "md5"
                ? "md5"
                : "hu";

        const model =
            models[type];

        res.json({

            version:
                "ULTRA-V22",

            type,

            patternMemory:
                Object.keys(
                    model.patternMemory
                ).length,

            markov:
                model.markov,

            transition3:
                model.transition3,

            diceFaces:
                model.dice.face,

            totalMemory:
                model.dice.total,

            performance:
                model.performance,

            global:
                model.global
        });
    }
);

// ============================================================
// RESET
// ============================================================

app.post(
    "/api/lc79/models/reset",
    (req, res) => {

        models.hu =
            createModel();

        models.hu.performance =
            createPerformance();

        models.md5 =
            createModel();

        models.md5.performance =
            createPerformance();

        learnedFingerprint.hu = 0;
        learnedFingerprint.md5 = 0;

        saveJSON(
            MODEL_FILE,
            models
        );

        res.json({

            success: true,

            message:
                "Đã reset ULTRA V22"
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

            engine:
                "LC79 ULTRA V22",

            pattern:
                PATTERN_LENGTH,

            patternSamples:
                PATTERN_SAMPLES.length,

            models: 12,

            selfLearning:
                true,

            diceLearning:
                true,

            patternMemory:
                true,

            rollingAnalysis:
                true,

            realtime:
                "SSE",

            update:
                "3 seconds",

            sources: {
                hu:
                    SOURCE_API.hu,

                md5:
                    SOURCE_API.md5
            }
        });
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res
            .status(404)
            .json({

                error: true,

                message:
                    "Endpoint không tồn tại",

                path:
                    req.path
            });
    }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔════════════════════════════════════════════════════════╗
║                 LC79 ULTRA V22                         ║
╠════════════════════════════════════════════════════════╣
║ Engine              : ULTRA V22                       ║
║ Pattern             : 15 phiên                        ║
║ Pattern Samples     : ${String(PATTERN_SAMPLES.length).padEnd(29)}║
║ Models              : 12                              ║
║ Pattern Memory      : ON                              ║
║ Markov              : ON                              ║
║ Transition-3        : ON                              ║
║ Dice Learning       : ON                              ║
║ Total Learning      : ON                              ║
║ Self Learning       : ON                              ║
║ Model Weight        : ON                              ║
║ Ensemble            : ON                              ║
║ SSE Realtime        : ON                              ║
║ Auto Update         : 3 seconds                       ║
║ Port                : ${String(PORT).padEnd(29)}║
╚════════════════════════════════════════════════════════╝
`);
    }
);

// ============================================================
// AUTO UPDATE
// ============================================================

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

// Mỗi 3 giây
setInterval(
    autoUpdate,
    POLL_MS
);
