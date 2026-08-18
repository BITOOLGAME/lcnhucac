"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3001);
const POLL_MS = 3000;

const PATTERN_LENGTH = 20;
const TOP_PATTERN_SAMPLES = 10;

const MAX_SOURCE_HISTORY = 500;
const MAX_HISTORY = 100;
const MAX_PATTERN_MEMORY = 30000;

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SOURCES = {
    hu: "https://wtx.tele68.com/v1/tx/sessions",
    md5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

// ============================================================
// DATA PATH — TÁCH HOÀN TOÀN HU / MD5
// ============================================================

const PATHS = {
    hu: {
        model: path.join(DATA_DIR, "hu-model.json"),
        pattern: path.join(DATA_DIR, "hu-patterns.json"),
        history: path.join(DATA_DIR, "hu-history.json")
    },

    md5: {
        model: path.join(DATA_DIR, "md5-model.json"),
        pattern: path.join(DATA_DIR, "md5-patterns.json"),
        history: path.join(DATA_DIR, "md5-history.json")
    }
};

// ============================================================
// UTIL
// ============================================================

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;

        const data = fs.readFileSync(file, "utf8");
        return JSON.parse(data);
    } catch {
        return fallback;
    }
}

function saveJSON(file, data) {
    try {
        const tmp = `${file}.tmp`;

        fs.writeFileSync(
            tmp,
            JSON.stringify(data, null, 2),
            "utf8"
        );

        fs.renameSync(tmp, file);
    } catch (error) {
        console.error("[SAVE]", error.message);
    }
}

function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeResult(value) {
    const v = String(value || "")
        .trim()
        .toUpperCase();

    if (v === "TAI" || v === "TÀI") return "TAI";
    if (v === "XIU" || v === "XỈU") return "XIU";

    return null;
}

function displayResult(value) {
    const result = normalizeResult(value);

    if (result === "TAI") return "Tài";
    if (result === "XIU") return "Xỉu";

    return "Không rõ";
}

function toTX(value) {
    return normalizeResult(value) === "TAI"
        ? "T"
        : "X";
}

function txResult(value) {
    return value === "T" ? "TAI" : "XIU";
}

function opposite(value) {
    return value === "T" ? "X" : "T";
}

function validPattern(pattern) {
    return (
        typeof pattern === "string" &&
        pattern.length === PATTERN_LENGTH &&
        /^[TX]+$/.test(pattern)
    );
}

// ============================================================
// ENGINE RIÊNG
// ============================================================

function createEngine(type) {
    return {
        type,

        patternMemory: {},

        followUp: {},

        markov1: {
            TT: 1,
            TX: 1,
            XT: 1,
            XX: 1
        },

        markov2: {},

        dice: {
            face: {
                1: 1,
                2: 1,
                3: 1,
                4: 1,
                5: 1,
                6: 1
            },

            total: {},

            totalResult: {},

            triple: {},

            pair: {},

            sequence: {}
        },

        performance: {},

        global: {
            correct: 0,
            wrong: 0,
            total: 0
        },

        learnedUntil: 0
    };
}

function createPerformance() {
    const performance = {};

    for (let i = 1; i <= 11; i++) {
        performance[`model${i}`] = {
            correct: 0,
            wrong: 0,
            total: 0,
            weight: 1
        };
    }

    return performance;
}

function ensureEngine(engine, type) {
    if (!engine) {
        engine = createEngine(type);
    }

    const fresh = createEngine(type);

    engine.type = type;

    engine.patternMemory =
        engine.patternMemory || {};

    engine.followUp =
        engine.followUp || {};

    engine.markov1 =
        engine.markov1 || fresh.markov1;

    engine.markov2 =
        engine.markov2 || {};

    engine.dice =
        engine.dice || fresh.dice;

    engine.dice.face =
        engine.dice.face || fresh.dice.face;

    engine.dice.total =
        engine.dice.total || {};

    engine.dice.totalResult =
        engine.dice.totalResult || {};

    engine.dice.triple =
        engine.dice.triple || {};

    engine.dice.pair =
        engine.dice.pair || {};

    engine.dice.sequence =
        engine.dice.sequence || {};

    engine.performance =
        engine.performance || createPerformance();

    for (let i = 1; i <= 11; i++) {
        const key = `model${i}`;

        if (!engine.performance[key]) {
            engine.performance[key] = {
                correct: 0,
                wrong: 0,
                total: 0,
                weight: 1
            };
        }
    }

    engine.global =
        engine.global || {
            correct: 0,
            wrong: 0,
            total: 0
        };

    engine.learnedUntil =
        number(engine.learnedUntil);

    return engine;
}

// ============================================================
// LOAD 2 ENGINE ĐỘC LẬP
// ============================================================

const engines = {
    hu: ensureEngine(
        loadJSON(
            PATHS.hu.model,
            null
        ),
        "hu"
    ),

    md5: ensureEngine(
        loadJSON(
            PATHS.md5.model,
            null
        ),
        "md5"
    )
};

const histories = {
    hu: loadJSON(
        PATHS.hu.history,
        []
    ),

    md5: loadJSON(
        PATHS.md5.history,
        []
    )
};

if (!Array.isArray(histories.hu)) histories.hu = [];
if (!Array.isArray(histories.md5)) histories.md5 = [];

// ============================================================
// SOURCE CACHE
// ============================================================

const sourceHistory = {
    hu: [],
    md5: []
};

const lastSourceId = {
    hu: null,
    md5: null
};

const pending = {
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

function sendSSE(type, event, data) {
    const message =
        `event: ${event}\n` +
        `data: ${JSON.stringify(data)}\n\n`;

    for (const client of clients[type]) {
        try {
            client.write(message);
        } catch {
            clients[type].delete(client);
        }
    }
}

// ============================================================
// NORMALIZE SOURCE
// ============================================================

function normalizeSessions(json) {
    if (!json || !Array.isArray(json.list)) {
        return [];
    }

    return json.list
        .map(item => {
            const dices = Array.isArray(item.dices)
                ? item.dices
                    .map(Number)
                    .filter(
                        n =>
                            n >= 1 &&
                            n <= 6
                    )
                : [];

            let total = number(item.point);

            if (!total && dices.length === 3) {
                total =
                    dices[0] +
                    dices[1] +
                    dices[2];
            }

            return {
                phien: number(item.id),

                xuc_xac: dices,

                tong: total,

                ket_qua:
                    normalizeResult(
                        item.resultTruyenThong
                    )
            };
        })
        .filter(
            x =>
                x.phien > 0 &&
                x.xuc_xac.length === 3 &&
                x.ket_qua
        )
        .sort(
            (a, b) =>
                a.phien - b.phien
        );
}

// ============================================================
// FETCH
// ============================================================

async function fetchSource(type) {
    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        10000
    );

    try {
        const response = await fetch(
            SOURCES[type],
            {
                headers: {
                    Accept:
                        "application/json",
                    "User-Agent":
                        "LC79-ULTRA-V23"
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

// ============================================================
// PATTERN 20
// ============================================================

function buildPattern(
    sessions,
    length = PATTERN_LENGTH
) {
    return sessions
        .slice(-length)
        .map(
            x =>
                toTX(
                    x.ket_qua
                )
        )
        .join("");
}

function getPatternAt(
    sessions,
    endIndex,
    length = PATTERN_LENGTH
) {
    const start =
        endIndex - length;

    if (start < 0) return null;

    return sessions
        .slice(start, endIndex)
        .map(
            x =>
                toTX(
                    x.ket_qua
                )
        )
        .join("");
}

// ============================================================
// PATTERN SIMILARITY
// ============================================================

function similarity(a, b) {
    if (
        !validPattern(a) ||
        !validPattern(b)
    ) {
        return 0;
    }

    let score = 0;

    for (let i = 0; i < PATTERN_LENGTH; i++) {
        if (a[i] === b[i]) {
            const weight =
                1 +
                i /
                    PATTERN_LENGTH;

            score += weight;
        }
    }

    let max = 0;

    for (
        let i = 0;
        i < PATTERN_LENGTH;
        i++
    ) {
        max +=
            1 +
            i /
                PATTERN_LENGTH;
    }

    return score / max;
}

// ============================================================
// GENERATE PATTERN SAMPLE
// ============================================================

function generatePatternSamples() {
    const set = new Set();

    function add(pattern) {
        if (validPattern(pattern)) {
            set.add(pattern);
        }
    }

    // 1-1
    add("TX".repeat(10));
    add("XT".repeat(10));

    // 2-2
    add("TTXX".repeat(5));
    add("XXTT".repeat(5));

    // 3-3
    add("TTTXXXTTTXXXTTTXXXTT");
    add("XXXTTTXXXTTTXXXTTTXX");

    // 4-4
    add("TTTTXXXXTTTTXXXXTTTT");
    add("XXXXTTTTXXXXTTTTXXXX");

    // 5-5
    add("TTTTTXXXXXT TTTTTXXXX".replace(/\s/g, "").slice(0, 20));
    add("XXXX XTTTTTXXXXXT TTT".replace(/\s/g, "").slice(0, 20));

    // Chẵn / lẻ
    add("TTXTTXXTTXTTXXTTXTTX");
    add("XXTXXTTXXTXXTTXXTXXT");

    // Bậc thang
    add("TXXTTXXXTTTTXXXXXXTT");
    add("XTTXXXTTTTXXXXXXTTXX");

    // Cầu ngắn
    add("TTXTXTTXTXTTXTTXTTXX");
    add("XXTXTXXTXTXXTXXTXXTT");

    // Đảo
    add("TXTTXXTTXTTXXTTXTXTX");
    add("X TXXTTXXTXXTTXXTXT X".replace(/\s/g, ""));

    // Long runs
    add("TTTTTTTTTTTTTTTTTTTX");
    add("XXXXXXXXXXXXXXXXXXXT");

    add("TTTTTTTTTTTTTTTTTTXX");
    add("XXXXXXXXXXXXXXXXXXTT");

    // 1-2-1
    add("TXXTXXTXXTXXTXXTXXTT");
    add("XTTXTTXTTXTTXTTXTTXX");

    // 2-1-2
    add("TTXTTXTTXTTXTTXTTXTT");
    add("XXTXXTXXTXXTXXTXXTXX");

    // 2-3-2
    add("TTXXXTTXXXT TTX TT".replace(/\s/g, "").slice(0, 20));
    add("XXTTTXXTTTXXTTTXXTTT");

    // Complex
    const complex = [
        "TTXTTXXTTTXTTXXTTXTX",
        "XXTXXTTXXXTXTTXXTTXT",
        "TXXTTXXTXXTTTXTTXXTT",
        "XTTXXTTXTTXXXTTXXTXX",
        "TTTTXXTTXTTXXTTTTXXT",
        "XXXXTTXXTXXTTXXXXTTX",
        "TTXXTTTTXXTTXTTXXTTX",
        "XXTTXXXXTTXXTXXTTXXT",
        "TXXTTTTXXTXXTTTXXTTX",
        "XTTXXXXTTXTTXXXTTXXT",
        "TTXTXTTXXTTXTTXXTTTX",
        "XXTXTXTTXXTXTTXXTTTX",
        "TTXXTXXTTTXXTTXTTXTT",
        "XXTTXTTXXXTTXXTXXTXX",
        "TXTTTTXXTTXTTTXXTTXX",
        "XTTTTTXXTTXTTTXXTTXX",
        "TTXXTTXXTTXXTTTTXXTX",
        "XXTTXXTTXXTTXXXXTTXT",
        "TXXTXXTTXXTXXTTXXTTT",
        "XTTXTTXXTTXTTXXTTXXX",
        "TTTXXTTXXXTTTXXTTXXX",
        "XXXTTXXXTTTXXXTTTXXX",
        "TTXXTTXTXTTXTXTTXTTX",
        "XXTTXXTXTXXTXTTXTXXT"
    ];

    for (const pattern of complex) {
        add(pattern);
    }

    return [...set].filter(
        validPattern
    );
}

function loadPatternLibrary(type) {
    const saved =
        loadJSON(
            PATHS[type].pattern,
            null
        );

    if (
        saved &&
        Array.isArray(
            saved.patterns
        )
    ) {
        return saved.patterns.filter(
            validPattern
        );
    }

    const patterns =
        generatePatternSamples();

    saveJSON(
        PATHS[type].pattern,
        {
            version:
                "LC79-V23",

            length:
                PATTERN_LENGTH,

            patterns
        }
    );

    return patterns;
}

const patternLibraries = {
    hu: loadPatternLibrary("hu"),
    md5: loadPatternLibrary("md5")
};

// ============================================================
// TOP 10 PATTERN MẪU
// ============================================================

function getTop10Patterns(
    type,
    currentPattern
) {
    if (
        !validPattern(
            currentPattern
        )
    ) {
        return [];
    }

    return patternLibraries[type]
        .map(pattern => ({
            pattern,

            similarity:
                Number(
                    (
                        similarity(
                            currentPattern,
                            pattern
                        ) * 100
                    ).toFixed(2)
                )
        }))
        .sort(
            (a, b) =>
                b.similarity -
                a.similarity
        )
        .slice(
            0,
            TOP_PATTERN_SAMPLES
        );
}

// ============================================================
// LEARN PATTERN FOLLOW-UP
// ============================================================

function learnPattern(type, sessions) {
    const engine =
        engines[type];

    if (
        sessions.length <=
        PATTERN_LENGTH
    ) {
        return;
    }

    for (
        let i = PATTERN_LENGTH;
        i < sessions.length;
        i++
    ) {
        const pattern =
            getPatternAt(
                sessions,
                i
            );

        if (!validPattern(pattern)) {
            continue;
        }

        const actual =
            toTX(
                sessions[i]
                    .ket_qua
            );

        if (
            !engine.patternMemory[
                pattern
            ]
        ) {
            engine.patternMemory[
                pattern
            ] = {
                T: 0,
                X: 0,
                total: 0
            };
        }

        engine.patternMemory[
            pattern
        ][actual]++;

        engine.patternMemory[
            pattern
        ].total++;
    }

    const patterns =
        Object.keys(
            engine.patternMemory
        );

    if (
        patterns.length >
        MAX_PATTERN_MEMORY
    ) {
        patterns.sort(
            (a, b) =>
                number(
                    engine.patternMemory[a]
                        .total
                ) -
                number(
                    engine.patternMemory[b]
                        .total
                )
        );

        const remove =
            patterns.length -
            MAX_PATTERN_MEMORY;

        for (
            let i = 0;
            i < remove;
            i++
        ) {
            delete engine
                .patternMemory[
                    patterns[i]
                ];
        }
    }
}

// ============================================================
// LEARN FOLLOW UP
// ============================================================

function learnFollowUp(
    type,
    sessions
) {
    const engine =
        engines[type];

    for (
        let i = PATTERN_LENGTH;
        i < sessions.length;
        i++
    ) {
        const pattern =
            getPatternAt(
                sessions,
                i
            );

        if (!validPattern(pattern)) {
            continue;
        }

        const actual =
            toTX(
                sessions[i]
                    .ket_qua
            );

        if (
            !engine.followUp[
                pattern
            ]
        ) {
            engine.followUp[
                pattern
            ] = {
                T: 0,
                X: 0,
                total: 0
            };
        }

        engine.followUp[
            pattern
        ][actual]++;

        engine.followUp[
            pattern
        ].total++;
    }
}

// ============================================================
// LEARN MARKOV
// ============================================================

function learnMarkov(
    type,
    sessions
) {
    const engine =
        engines[type];

    for (
        let i = 1;
        i < sessions.length;
        i++
    ) {
        const prev =
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
            prev + current;

        engine.markov1[key] =
            number(
                engine.markov1[key]
            ) + 1;
    }

    for (
        let i = 2;
        i < sessions.length;
        i++
    ) {
        const key =
            sessions
                .slice(i - 2, i)
                .map(
                    x =>
                        toTX(
                            x.ket_qua
                        )
                )
                .join("");

        const current =
            toTX(
                sessions[i]
                    .ket_qua
            );

        if (
            !engine.markov2[
                key
            ]
        ) {
            engine.markov2[
                key
            ] = {
                T: 1,
                X: 1
            };
        }

        engine.markov2[
            key
        ][current]++;
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
        engines[type].dice;

    for (const session of sessions) {
        const d =
            session.xuc_xac;

        if (d.length !== 3) {
            continue;
        }

        for (const face of d) {
            dice.face[face] =
                number(
                    dice.face[face]
                ) + 1;
        }

        const total =
            number(
                session.tong
            );

        dice.total[total] =
            number(
                dice.total[total]
            ) + 1;

        if (
            !dice.totalResult[
                total
            ]
        ) {
            dice.totalResult[
                total
            ] = {
                T: 0,
                X: 0
            };
        }

        const result =
            toTX(
                session.ket_qua
            );

        dice.totalResult[
            total
        ][result]++;

        const triple =
            d.join("-");

        dice.triple[triple] =
            number(
                dice.triple[triple]
            ) + 1;

        const pairs = [
            [d[0], d[1]],
            [d[0], d[2]],
            [d[1], d[2]]
        ];

        for (const pair of pairs) {
            const key =
                pair
                    .slice()
                    .sort(
                        (a, b) =>
                            a - b
                    )
                    .join("-");

            dice.pair[key] =
                number(
                    dice.pair[key]
                ) + 1;
        }

        const sequence =
            d.join("");

        dice.sequence[
            sequence
        ] =
            number(
                dice.sequence[
                    sequence
                ]
            ) + 1;
    }
}

// ============================================================
// SELF LEARNING
// ============================================================

function learnAll(
    type,
    sessions
) {
    const engine =
        engines[type];

    if (!sessions.length) {
        return;
    }

    const latest =
        sessions[
            sessions.length - 1
        ].phien;

    if (
        engine.learnedUntil ===
        latest
    ) {
        return;
    }

    learnPattern(
        type,
        sessions
    );

    learnFollowUp(
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

    engine.learnedUntil =
        latest;

    saveJSON(
        PATHS[type].model,
        engine
    );
}

// ============================================================
// MODEL 1 — EXACT PATTERN
// ============================================================

function modelExact(
    type,
    pattern
) {
    const memory =
        engines[type]
            .patternMemory[
                pattern
            ];

    if (!memory) {
        return null;
    }

    const t =
        number(memory.T);

    const x =
        number(memory.X);

    const total =
        t + x;

    if (!total) {
        return null;
    }

    const prediction =
        t >= x
            ? "TAI"
            : "XIU";

    const probability =
        Math.max(t, x) /
        total;

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        probability -
                        0.5
                    ) *
                        100,

                50,
                95
            ),

        samples: total
    };
}

// ============================================================
// MODEL 2 — TOP 10 SIMILAR PATTERN
// ============================================================

function modelSimilar(
    type,
    currentPattern
) {
    const top =
        getTop10Patterns(
            type,
            currentPattern
        );

    if (!top.length) {
        return null;
    }

    const memory =
        engines[type]
            .patternMemory;

    let T = 0;
    let X = 0;

    let totalWeight = 0;

    for (const item of top) {
        const data =
            memory[
                item.pattern
            ];

        if (!data) {
            continue;
        }

        const similarityWeight =
            Math.pow(
                item.similarity / 100,
                4
            );

        const sampleWeight =
            Math.log1p(
                number(
                    data.total
                )
            );

        const weight =
            similarityWeight *
            Math.max(
                1,
                sampleWeight
            );

        T +=
            number(data.T) *
            weight;

        X +=
            number(data.X) *
            weight;

        totalWeight +=
            (
                number(data.T) +
                number(data.X)
            ) *
            weight;
    }

    if (!totalWeight) {
        return null;
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            totalWeight -
                        0.5
                    ) *
                        100,

                50,
                94
            ),

        samples:
            Math.round(
                totalWeight
            ),

        top
    };
}

// ============================================================
// MODEL 3 — FOLLOW-UP
// ============================================================

function modelFollowUp(
    type,
    pattern
) {
    const data =
        engines[type]
            .followUp[
                pattern
            ];

    if (!data) {
        return null;
    }

    const T =
        number(data.T);

    const X =
        number(data.X);

    const total =
        T + X;

    if (!total) {
        return null;
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            total -
                        0.5
                    ) *
                        100,

                50,
                97
            ),

        samples: total
    };
}

// ============================================================
// MODEL 4 — MARKOV 1
// ============================================================

function modelMarkov1(
    type,
    sessions
) {
    if (sessions.length < 2) {
        return null;
    }

    const last =
        toTX(
            sessions[
                sessions.length - 1
            ].ket_qua
        );

    const T =
        number(
            engines[type]
                .markov1[
                    last + "T"
                ]
        );

    const X =
        number(
            engines[type]
                .markov1[
                    last + "X"
                ]
        );

    const total =
        T + X;

    if (!total) {
        return null;
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            total -
                        0.5
                    ) *
                        100,

                50,
                92
            ),

        samples: total
    };
}

// ============================================================
// MODEL 5 — MARKOV 2
// ============================================================

function modelMarkov2(
    type,
    sessions
) {
    if (sessions.length < 3) {
        return null;
    }

    const key =
        sessions
            .slice(-2)
            .map(
                x =>
                    toTX(
                        x.ket_qua
                    )
            )
            .join("");

    const data =
        engines[type]
            .markov2[
                key
            ];

    if (!data) {
        return null;
    }

    const T =
        number(data.T);

    const X =
        number(data.X);

    const total =
        T + X;

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            total -
                        0.5
                    ) *
                        100,

                50,
                94
            ),

        samples: total
    };
}

// ============================================================
// MODEL 6 — RUN
// ============================================================

function modelRun(
    pattern
) {
    if (!pattern) {
        return null;
    }

    const last =
        pattern[
            pattern.length - 1
        ];

    let run = 0;

    for (
        let i =
            pattern.length - 1;
        i >= 0;
        i--
    ) {
        if (pattern[i] === last) {
            run++;
        } else {
            break;
        }
    }

    let prediction =
        last;

    let confidence = 54;

    if (run >= 4) {
        prediction =
            opposite(last);

        confidence =
            clamp(
                64 +
                    (run - 4) * 2,
                64,
                76
            );
    } else if (run === 3) {
        confidence = 59;
    } else if (run === 2) {
        confidence = 55;
    }

    return {
        prediction:
            txResult(prediction),

        confidence
    };
}

// ============================================================
// MODEL 7 — ALTERNATING
// ============================================================

function modelAlternating(
    pattern
) {
    if (
        !pattern ||
        pattern.length < 6
    ) {
        return null;
    }

    let alternating = 0;

    for (
        let i = 1;
        i < pattern.length;
        i++
    ) {
        if (
            pattern[i] !==
            pattern[i - 1]
        ) {
            alternating++;
        }
    }

    const rate =
        alternating /
        (pattern.length - 1);

    if (rate < 0.65) {
        return null;
    }

    const prediction =
        opposite(
            pattern[
                pattern.length - 1
            ]
        );

    return {
        prediction:
            txResult(prediction),

        confidence:
            clamp(
                55 +
                    rate * 25,

                55,
                80
            )
    };
}

// ============================================================
// MODEL 8 — RECENT REGIME
// ============================================================

function modelRecent(
    sessions
) {
    const data =
        sessions.slice(-8);

    if (data.length < 5) {
        return null;
    }

    let T = 0;
    let X = 0;

    data.forEach(
        (item, index) => {
            const weight =
                index + 1;

            if (
                item.ket_qua ===
                "TAI"
            ) {
                T += weight;
            } else {
                X += weight;
            }
        }
    );

    const total =
        T + X;

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            total -
                        0.5
                    ) *
                        70,

                50,
                86
            )
    };
}

// ============================================================
// MODEL 9 — DICE/TOTAL
// ============================================================

function modelDice(
    type,
    sessions
) {
    const dice =
        engines[type].dice;

    if (sessions.length < 10) {
        return null;
    }

    let T = 0;
    let X = 0;

    for (
        const session
        of sessions.slice(-50)
    ) {
        const total =
            number(
                session.tong
            );

        const data =
            dice.totalResult[
                total
            ];

        if (!data) {
            continue;
        }

        const t =
            number(data.T);

        const x =
            number(data.X);

        const count =
            t + x;

        if (!count) {
            continue;
        }

        const weight =
            Math.log1p(count);

        T +=
            (
                t /
                count
            ) *
            weight;

        X +=
            (
                x /
                count
            ) *
            weight;
    }

    if (T + X <= 0) {
        return null;
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            (T + X) -
                        0.5
                    ) *
                        80,

                50,
                90
            )
    };
}

// ============================================================
// MODEL 10 — SIMILAR HISTORICAL WINDOWS
// ============================================================

function modelHistoricalSimilarity(
    type,
    sessions
) {
    if (
        sessions.length <
        PATTERN_LENGTH + 2
    ) {
        return null;
    }

    const current =
        buildPattern(
            sessions
        );

    let T = 0;
    let X = 0;

    let weightTotal = 0;

    for (
        let i =
            PATTERN_LENGTH;
        i < sessions.length;
        i++
    ) {
        const old =
            getPatternAt(
                sessions,
                i
            );

        if (!validPattern(old)) {
            continue;
        }

        const sim =
            similarity(
                current,
                old
            );

        if (sim < 0.60) {
            continue;
        }

        const result =
            toTX(
                sessions[i]
                    .ket_qua
            );

        const weight =
            Math.pow(
                sim,
                5
            );

        if (result === "T") {
            T += weight;
        } else {
            X += weight;
        }

        weightTotal += weight;
    }

    if (!weightTotal) {
        return null;
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    (
                        Math.max(T, X) /
                            weightTotal -
                        0.5
                    ) *
                        100,

                50,
                95
            ),

        samples:
            Number(
                weightTotal.toFixed(2)
            )
    };
}

// ============================================================
// MODEL 11 — CONSENSUS
// ============================================================

function finalConsensus(
    type,
    results
) {
    let T = 0;
    let X = 0;

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

        const perf =
            engines[type]
                .performance[
                    `model${i + 1}`
                ];

        const weight =
            clamp(
                number(
                    perf.weight
                ) || 1,

                0.15,
                3
            );

        const confidence =
            clamp(
                number(
                    result.confidence
                ) || 50,

                50,
                98
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
            T += vote;
        } else {
            X += vote;
        }
    }

    const total =
        T + X;

    if (!total) {
        return {
            prediction: null,
            confidence: 50
        };
    }

    const edge =
        Math.abs(T - X) /
        total;

    // Không ép dự đoán khi tín hiệu quá yếu
    if (edge < 0.055) {
        return {
            prediction: null,

            confidence:
                Number(
                    (
                        50 +
                        edge * 100
                    ).toFixed(2)
                )
        };
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    return {
        prediction,

        confidence:
            clamp(
                50 +
                    edge * 100,

                50,
                97
            )
    };
}

// ============================================================
// RUN ENGINE
// ============================================================

function analyze(
    type,
    sessions
) {
    const pattern =
        buildPattern(
            sessions
        );

    const top10 =
        getTop10Patterns(
            type,
            pattern
        );

    const results = [
        modelExact(
            type,
            pattern
        ),

        modelSimilar(
            type,
            pattern
        ),

        modelFollowUp(
            type,
            pattern
        ),

        modelMarkov1(
            type,
            sessions
        ),

        modelMarkov2(
            type,
            sessions
        ),

        modelRun(
            pattern
        ),

        modelAlternating(
            pattern
        ),

        modelRecent(
            sessions
        ),

        modelDice(
            type,
            sessions
        ),

        modelHistoricalSimilarity(
            type,
            sessions
        )
    ];

    const final =
        finalConsensus(
            type,
            results
        );

    return {
        pattern,

        top10,

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

        model11: final,

        final
    };
}

// ============================================================
// PENDING HISTORY
// ============================================================

function addPending(
    type,
    phien,
    prediction
) {
    if (
        histories[type].some(
            x =>
                x.phien === phien
        )
    ) {
        return false;
    }

    histories[type].unshift({
        phien,

        du_doan:
            prediction
                ? displayResult(
                    prediction
                )
                : "Không rõ",

        ket_qua:
            "⌛ Chờ Kết Quả",

        danh_gia:
            "⌛ Chờ Kết Quả",

        xuc_xac:
            "⌛ Chờ",

        tong:
            "⌛ Chờ"
    });

    histories[type] =
        histories[type].slice(
            0,
            MAX_HISTORY
        );

    saveJSON(
        PATHS[type].history,
        histories[type]
    );

    return true;
}

// ============================================================
// SETTLE
// ============================================================

function settle(
    type,
    session
) {
    const item =
        histories[type].find(
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

    if (
        prediction &&
        prediction ===
            session.ket_qua
    ) {
        item.danh_gia =
            "✅ Thắng";
    } else if (
        prediction
    ) {
        item.danh_gia =
            "❌ Thua";
    } else {
        item.danh_gia =
            "⚪ Không rõ";
    }

    updatePerformance(
        type,
        session.phien,
        session.ket_qua
    );

    saveJSON(
        PATHS[type].history,
        histories[type]
    );

    return true;
}

// ============================================================
// PERFORMANCE
// ============================================================

function updatePerformance(
    type,
    phien,
    actual
) {
    const prediction =
        pending[type].get(
            phien
        );

    if (!prediction) {
        return;
    }

    const results = [
        prediction.model1,
        prediction.model2,
        prediction.model3,
        prediction.model4,
        prediction.model5,
        prediction.model6,
        prediction.model7,
        prediction.model8,
        prediction.model9,
        prediction.model10,
        prediction.model11
    ];

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

        const perf =
            engines[type]
                .performance[
                    `model${i + 1}`
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
                        0.05,

                    0.15,
                    3
                );
        } else {
            perf.wrong++;

            perf.weight =
                clamp(
                    perf.weight -
                        0.035,

                    0.15,
                    3
                );
        }
    }

    engines[type]
        .global.total++;

    if (
        prediction.final &&
        prediction.final.prediction ===
            actual
    ) {
        engines[type]
            .global.correct++;
    } else {
        engines[type]
            .global.wrong++;
    }

    pending[type].delete(
        phien
    );

    saveJSON(
        PATHS[type].model,
        engines[type]
    );
}

// ============================================================
// PROCESS HU / MD5
// ============================================================

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
                "API không trả session"
            );
        }

        sourceHistory[type] =
            sessions.slice(
                -MAX_SOURCE_HISTORY
            );

        // học RIÊNG
        learnAll(
            type,
            sourceHistory[type]
        );

        let changed = false;

        // chốt kết quả
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
            analyze(
                type,
                sourceHistory[type]
            );

        const final =
            analysis.final;

        const prediction =
            final.prediction;

        pending[type].set(
            nextPhien,
            analysis
        );

        if (
            addPending(
                type,
                nextPhien,
                prediction
            )
        ) {
            changed = true;
        }

        const newSession =
            lastSourceId[type] ===
                null ||
            lastSourceId[type] !==
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
                histories[type]
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
                prediction
                    ? displayResult(
                        prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                `${final.confidence.toFixed(
                    2
                )}%`
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
// API PREDICTION
// ============================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {
        const result =
            await processType(
                "hu"
            );

        if (!result) {
            return res.status(502).json({
                error: true,
                message:
                    "Không lấy được HU"
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
            return res.status(502).json({
                error: true,
                message:
                    "Không lấy được MD5"
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
            histories.hu
        );
    }
);

app.get(
    "/api/lc79/md5/history",
    (req, res) => {
        res.json(
            histories.md5
        );
    }
);

// ============================================================
// SSE
// ============================================================

function stream(
    type,
    req,
    res
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

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    clients[type].add(res);

    res.write(
        "event: history\n"
    );

    res.write(
        `data: ${JSON.stringify(
            histories[type]
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

            clients[type].delete(
                res
            );
        }
    );
}

app.get(
    "/api/lc79/hu/history/stream",
    (req, res) =>
        stream(
            "hu",
            req,
            res
        )
);

app.get(
    "/api/lc79/md5/history/stream",
    (req, res) =>
        stream(
            "md5",
            req,
            res
        )
);

// ============================================================
// PATTERN API — TÁCH RIÊNG
// ============================================================

app.get(
    "/api/lc79/hu/pattern",
    (req, res) => {
        const pattern =
            buildPattern(
                sourceHistory.hu
            );

        res.json({
            ban:
                "HU",

            pattern,

            length:
                pattern.length,

            top10:
                getTop10Patterns(
                    "hu",
                    pattern
                )
        });
    }
);

app.get(
    "/api/lc79/md5/pattern",
    (req, res) => {
        const pattern =
            buildPattern(
                sourceHistory.md5
            );

        res.json({
            ban:
                "MD5",

            pattern,

            length:
                pattern.length,

            top10:
                getTop10Patterns(
                    "md5",
                    pattern
                )
        });
    }
);

// ============================================================
// MODEL STATUS
// ============================================================

app.get(
    "/api/lc79/hu/models",
    (req, res) => {
        res.json({
            ban: "HU",
            patternLength:
                PATTERN_LENGTH,
            compare:
                TOP_PATTERN_SAMPLES,
            library:
                patternLibraries.hu.length,
            learned:
                Object.keys(
                    engines.hu
                        .patternMemory
                ).length,
            performance:
                engines.hu
                    .performance,
            global:
                engines.hu.global
        });
    }
);

app.get(
    "/api/lc79/md5/models",
    (req, res) => {
        res.json({
            ban: "MD5",
            patternLength:
                PATTERN_LENGTH,
            compare:
                TOP_PATTERN_SAMPLES,
            library:
                patternLibraries.md5.length,
            learned:
                Object.keys(
                    engines.md5
                        .patternMemory
                ).length,
            performance:
                engines.md5
                    .performance,
            global:
                engines.md5.global
        });
    }
);

// ============================================================
// FULL ANALYZE
// ============================================================

app.get(
    "/api/lc79/hu/analyze",
    (req, res) => {
        if (
            sourceHistory.hu.length <
            PATTERN_LENGTH
        ) {
            return res.status(400).json({
                error: true,
                message:
                    "Chưa đủ 20 phiên"
            });
        }

        res.json(
            analyze(
                "hu",
                sourceHistory.hu
            )
        );
    }
);

app.get(
    "/api/lc79/md5/analyze",
    (req, res) => {
        if (
            sourceHistory.md5.length <
            PATTERN_LENGTH
        ) {
            return res.status(400).json({
                error: true,
                message:
                    "Chưa đủ 20 phiên"
            });
        }

        res.json(
            analyze(
                "md5",
                sourceHistory.md5
            )
        );
    }
);

// ============================================================
// LEARNING
// ============================================================

app.get(
    "/api/lc79/hu/learning",
    (req, res) => {
        res.json({
            ban: "HU",

            patternLength:
                PATTERN_LENGTH,

            patternSamples:
                TOP_PATTERN_SAMPLES,

            learnedPatterns:
                Object.keys(
                    engines.hu
                        .patternMemory
                ).length,

            followUp:
                Object.keys(
                    engines.hu.followUp
                ).length,

            markov1:
                engines.hu.markov1,

            markov2:
                engines.hu.markov2,

            dice:
                engines.hu.dice
        });
    }
);

app.get(
    "/api/lc79/md5/learning",
    (req, res) => {
        res.json({
            ban: "MD5",

            patternLength:
                PATTERN_LENGTH,

            patternSamples:
                TOP_PATTERN_SAMPLES,

            learnedPatterns:
                Object.keys(
                    engines.md5
                        .patternMemory
                ).length,

            followUp:
                Object.keys(
                    engines.md5.followUp
                ).length,

            markov1:
                engines.md5.markov1,

            markov2:
                engines.md5.markov2,

            dice:
                engines.md5.dice
        });
    }
);

// ============================================================
// PATTERN LIBRARY
// ============================================================

app.get(
    "/api/lc79/hu/patterns",
    (req, res) => {
        res.json({
            ban: "HU",
            length:
                PATTERN_LENGTH,
            total:
                patternLibraries.hu.length,
            patterns:
                patternLibraries.hu
        });
    }
);

app.get(
    "/api/lc79/md5/patterns",
    (req, res) => {
        res.json({
            ban: "MD5",
            length:
                PATTERN_LENGTH,
            total:
                patternLibraries.md5.length,
            patterns:
                patternLibraries.md5
        });
    }
);

// ============================================================
// RESET RIÊNG
// ============================================================

app.post(
    "/api/lc79/hu/reset",
    (req, res) => {
        engines.hu =
            createEngine("hu");

        engines.hu.performance =
            createPerformance();

        saveJSON(
            PATHS.hu.model,
            engines.hu
        );

        res.json({
            success: true,
            ban: "HU"
        });
    }
);

app.post(
    "/api/lc79/md5/reset",
    (req, res) => {
        engines.md5 =
            createEngine("md5");

        engines.md5.performance =
            createPerformance();

        saveJSON(
            PATHS.md5.model,
            engines.md5
        );

        res.json({
            success: true,
            ban: "MD5"
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
            status: "online",

            engine:
                "LC79 ULTRA V23",

            pattern:
                PATTERN_LENGTH,

            compare:
                TOP_PATTERN_SAMPLES,

            hu: {
                isolated: true,
                source:
                    SOURCES.hu
            },

            md5: {
                isolated: true,
                source:
                    SOURCES.md5
            },

            learning:
                true,

            realtime:
                "SSE",

            polling:
                `${POLL_MS}ms`
        });
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {
        res.status(404).json({
            error: true,
            message:
                "Endpoint không tồn tại"
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
╔══════════════════════════════════════════════════╗
║              LC79 ULTRA V23                     ║
╠══════════════════════════════════════════════════╣
║ Pattern chính       : 20 phiên                  ║
║ Pattern so sánh     : TOP 10                    ║
║ HU Engine           : RIÊNG                     ║
║ MD5 Engine          : RIÊNG                     ║
║ Pattern Memory      : RIÊNG                     ║
║ Follow-up Memory    : RIÊNG                     ║
║ Markov              : RIÊNG                     ║
║ Dice Learning       : RIÊNG                     ║
║ Model Weight        : RIÊNG                     ║
║ Backtest Memory     : RIÊNG                     ║
║ Self Learning       : ON                        ║
║ SSE Realtime        : ON                        ║
║ Auto Update         : 3 giây                    ║
║ PORT                : ${String(PORT).padEnd(25)}║
╚══════════════════════════════════════════════════╝
`);
    }
);

// ============================================================
// AUTO UPDATE
// ============================================================

let updating = false;

async function autoUpdate() {
    if (updating) return;

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

autoUpdate();

setInterval(
    autoUpdate,
    POLL_MS
);
