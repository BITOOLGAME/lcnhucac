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

const MAX_SOURCE_HISTORY = 100;
const PATTERN_LENGTH = 15;
const COMPARE_PATTERN_LENGTH = 5;
const MAX_EVALUATION_HISTORY = 50;

const POLL_INTERVAL = 3000;

const MIN_HISTORY = 15;

// =========================================================
// DATA DIR
// =========================================================

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

// =========================================================
// DEFAULT HISTORY
// =========================================================

let evaluationHistory = {
    tx: [],
    md5: []
};

let aiMemory = {
    tx: null,
    md5: null
};

// =========================================================
// LOAD JSON
// =========================================================

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
            "[LOAD JSON]",
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
            "[SAVE JSON]",
            file,
            error.message
        );
    }
}

// =========================================================
// AI MEMORY
// =========================================================

function createModelMemory() {

    return {

        model1: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model2: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model3: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model4: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model5: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model6: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model7: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model8: {
            weight: 1,
            win: 0,
            loss: 0
        },

        model9: {
            weight: 1,
            win: 0,
            loss: 0
        }
    };
}

function normalizeAIMemory(memory) {

    const base =
        createModelMemory();

    if (!memory) {
        return base;
    }

    for (
        const key of Object.keys(base)
    ) {

        if (!memory[key]) {
            continue;
        }

        base[key] = {

            weight:
                Number(
                    memory[key].weight
                ) || 1,

            win:
                Number(
                    memory[key].win
                ) || 0,

            loss:
                Number(
                    memory[key].loss
                ) || 0
        };
    }

    return base;
}

const savedAI =
    loadJSON(
        AI_FILE,
        {}
    );

aiMemory.tx =
    normalizeAIMemory(
        savedAI.tx
    );

aiMemory.md5 =
    normalizeAIMemory(
        savedAI.md5
    );

evaluationHistory =
    loadJSON(
        HISTORY_FILE,
        evaluationHistory
    );

// =========================================================
// SOURCE HISTORY
// =========================================================

const sourceHistory = {
    tx: [],
    md5: []
};

// =========================================================
// PATTERN MEMORY
// =========================================================

const patternMemory = {
    tx: [],
    md5: []
};

// =========================================================
// SSE CLIENTS
// =========================================================

const sseClients = {
    tx: new Set(),
    md5: new Set()
};

// =========================================================
// PATTERN MẪU
// =========================================================

const SAMPLE_PATTERNS = [

    // 1-1
    "TXTXTXTXTXTXTXT",
    "XTXTXTXTXTXTXTX",

    // 2-2
    "TTXXTTXXTTXXTTX",
    "XXTTXXTTXXTTXXT",

    // 1-2-1
    "TXXTTXXTTXXTTXX",
    "XTTXXTTXXTTXXTT",

    // 2-1-2
    "TTXTTXTTXTTXTTX",
    "XXTXXTXXTXXTXXT",

    // 3-1
    "TTTXTTTXTTTXTTT",
    "XXXTXXXTXXXTXXX",

    // 1-3
    "TXXXTXXXTXXXTXXX",
    "XTTTXTTTXTTTXTTT",

    // 3-2
    "TTTXXTTTXXTTTXX",
    "XXXTTXXXTTXXXTT",

    // 2-3
    "TTXXXTTXXXTTXXX",
    "XXTTTXXTTTXXTTT",

    // 4-1
    "TTTTXTTTTXTTTTX",
    "XXXXTXXXXTXXXXT",

    // 1-4
    "TXXXXTXXXXTXXXXT",
    "XTTTTXTTTTXTTTTX",

    // 4-2
    "TTTTXXTTTTXXTTT",
    "XXXXTTXXXXTTXXX",

    // 2-4
    "TTXXXXTTXXXXTTX",
    "XXTTTTXXTTTTXXT",

    // 5-1
    "TTTTTXTTTTTXTTT",
    "XXXXXTXXXXXTXXX",

    // 1-5
    "TXXXXXTXXXXXTXXX",
    "XTTTTTXTTTTTXTTT",

    // 5-2
    "TTTTTXXTTTTTXXT",
    "XXXXXT TXXXXXTXX".replace(/ /g, ""),

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
    "TTXXXXXXTTXXXX",
    "XXTTTTTTXXTTTT",

    // 7-1
    "TTTTTTTXTTTTTTX",
    "XXXXXXXTXXXXXXX",

    // 1-7
    "TXXXXXXXTXXXXXX",
    "XTTTTTTTXTTTTTT",

    // 8-1
    "TTTTTTTTXTTTTTT",
    "XXXXXXXXTXXXXXXX",

    // 1-8
    "TXXXXXXXXTXXXXXX",
    "XTTTTTTTTXTTTTTT",

    // phá cầu
    "TTTTTTTTTTTTTTX",
    "XXXXXXXXXXXXXXT",

    // đảo cầu
    "TTTTTTTTTTTTTXT",
    "XXXXXXXXXXXXXXTX",

    // zigzag
    "TXTTXTXTTXTXTTX",
    "XTXTXT XTXTXTXT".replace(/ /g, ""),

    // mixed
    "TTXTXTTXTXTTXTX",
    "XXTXTXXTXTXXTXT",

    "TXTTXXTTXTXTTXX",
    "XTTXXT TXTXTXXT".replace(/ /g, ""),

    // đối xứng
    "TTXTXTXT XTXTTX".replace(/ /g, ""),
    "XXTXT TXTXTXTXX".replace(/ /g, ""),

    // cụm
    "TTXXXT TXXTTXXT".replace(/ /g, ""),
    "XXTTTX TXXTTXXT".replace(/ /g, ""),

    // nhịp
    "TXXTXXTXXTXXTXX",
    "XTTXTTXTTXTTXTT"
];

// =========================================================
// UTILITY
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

    return value;
}

function toTX(value) {

    return normalizeResult(value) ===
        "TAI"
        ? "T"
        : "X";
}

// =========================================================
// FETCH
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
                            "LC79-AI/2.0"
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
// NORMALIZE API
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

            let tong =
                Number(item.point);

            if (
                !Number.isFinite(tong)
            ) {

                tong =
                    dices.reduce(
                        (sum, n) =>
                            sum + n,
                        0
                    );
            }

            return {

                phien:
                    Number(item.id),

                xuc_xac:
                    dices,

                tong,

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

// =========================================================
// PATTERN 15
// =========================================================

function buildPattern(
    history
) {

    return history
        .slice(-PATTERN_LENGTH)
        .map(
            item =>
                toTX(
                    item.ket_qua
                )
        )
        .join("");
}

// =========================================================
// SIMILARITY
// =========================================================

function similarity(a, b) {

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
            a[i] === b[i]
        ) {

            same++;
        }
    }

    return (
        same / length
    ) * 100;
}

// =========================================================
// PATTERN MẪU CHI TIẾT
// =========================================================

function compareSamplePatterns(
    pattern
) {

    let best = null;

    for (
        const sample of SAMPLE_PATTERNS
    ) {

        const score =
            similarity(
                pattern.slice(
                    -COMPARE_PATTERN_LENGTH
                ),
                sample.slice(
                    -COMPARE_PATTERN_LENGTH
                )
            );

        if (
            !best ||
            score > best.score
        ) {

            best = {

                pattern:
                    sample,

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
// MODEL 1
// STREAK
// =========================================================

function model1(history) {

    if (!history.length) {
        return null;
    }

    const last =
        history[
            history.length - 1
        ].ket_qua;

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
            last === "TAI"
                ? "XIU"
                : "TAI";

    } else {

        prediction =
            last;
    }

    return {

        prediction,

        confidence:
            Math.min(
                92,
                55 +
                streak * 6
            )
    };
}

// =========================================================
// MODEL 2
// ALTERNATING
// =========================================================

function model2(pattern) {

    const p =
        pattern.slice(-8);

    if (
        p.length < 6
    ) {
        return null;
    }

    let ok = true;

    for (
        let i = 1;
        i < p.length;
        i++
    ) {

        if (
            p[i] ===
            p[i - 1]
        ) {

            ok = false;

            break;
        }
    }

    if (!ok) {
        return null;
    }

    return {

        prediction:
            p[p.length - 1] === "T"
                ? "XIU"
                : "TAI",

        confidence: 82
    };
}

// =========================================================
// MODEL 3
// MARKOV 1
// =========================================================

function model3(history) {

    if (
        history.length < 8
    ) {
        return null;
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
            history[i].ket_qua !==
            last
        ) {
            continue;
        }

        if (
            history[i + 1].ket_qua ===
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

    const rate =
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
            50 +
            rate * 45
    };
}

// =========================================================
// MODEL 4
// MARKOV 2
// =========================================================

function model4(history) {

    if (
        history.length < 10
    ) {
        return null;
    }

    const arr =
        history.map(
            x =>
                toTX(
                    x.ket_qua
                )
        );

    const key =
        arr
            .slice(-2)
            .join("");

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < arr.length - 2;
        i++
    ) {

        if (
            arr
                .slice(
                    i,
                    i + 2
                )
                .join("") !== key
        ) {
            continue;
        }

        if (
            arr[i + 2] === "T"
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

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            50 +
            (
                Math.max(
                    tai,
                    xiu
                ) /
                total
            ) * 45
    };
}

// =========================================================
// MODEL 5
// PATTERN 5
// =========================================================

function model5(history) {

    if (
        history.length < 10
    ) {
        return null;
    }

    const current =
        buildPattern(
            history
        ).slice(-5);

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i <= history.length - 6;
        i++
    ) {

        const sample =
            history
                .slice(i, i + 5)
                .map(
                    x =>
                        toTX(
                            x.ket_qua
                        )
                )
                .join("");

        if (
            sample !== current
        ) {
            continue;
        }

        const next =
            history[i + 5];

        if (
            next.ket_qua ===
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

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            50 +
            (
                Math.max(
                    tai,
                    xiu
                ) /
                total
            ) * 45
    };
}

// =========================================================
// MODEL 6
// PATTERN 15
// =========================================================

function model6(
    history,
    type
) {

    if (
        history.length <
        PATTERN_LENGTH
    ) {
        return null;
    }

    const current =
        buildPattern(
            history
        );

    let tai = 0;
    let xiu = 0;
    let weightTotal = 0;

    const memory =
        patternMemory[type];

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
                3
            );

        if (
            item.next ===
            "TAI"
        ) {

            tai += weight;

        } else {

            xiu += weight;
        }

        weightTotal +=
            weight;
    }

    if (
        weightTotal <= 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            50 +
            (
                Math.max(
                    tai,
                    xiu
                ) /
                weightTotal
            ) * 45
    };
}

// =========================================================
// MODEL 7
// RUN LENGTH
// =========================================================

function model7(history) {

    if (
        history.length < 8
    ) {
        return null;
    }

    const arr =
        history.map(
            x =>
                toTX(
                    x.ket_qua
                )
        );

    const last =
        arr[arr.length - 1];

    let run = 1;

    for (
        let i = arr.length - 2;
        i >= 0;
        i--
    ) {

        if (
            arr[i] === last
        ) {

            run++;

        } else {

            break;
        }
    }

    let tai = 0;
    let xiu = 0;

    for (
        let i = 1;
        i < arr.length - 1;
        i++
    ) {

        let r = 1;

        for (
            let j = i - 1;
            j >= 0;
            j--
        ) {

            if (
                arr[j] ===
                arr[i]
            ) {

                r++;

            } else {

                break;
            }
        }

        if (
            r !== run
        ) {
            continue;
        }

        if (
            arr[i + 1] ===
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

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            50 +
            (
                Math.max(
                    tai,
                    xiu
                ) /
                total
            ) * 45
    };
}

// =========================================================
// MODEL 8
// RECENCY + DISTRIBUTION
// =========================================================

function model8(history) {

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

    const total =
        tai + xiu;

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            50 +
            (
                Math.max(
                    tai,
                    xiu
                ) /
                total
            ) * 45
    };
}

// =========================================================
// MODEL 9
// ENSEMBLE PATTERN MẪU
// =========================================================

function model9(pattern) {

    const recent =
        pattern.slice(-5);

    let tai = 0;
    let xiu = 0;

    let bestScore = 0;

    for (
        const sample
        of SAMPLE_PATTERNS
    ) {

        const sample5 =
            sample.slice(-5);

        const score =
            similarity(
                recent,
                sample5
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

        if (
            next === "T"
        ) {

            tai += score;

        } else {

            xiu += score;
        }

        bestScore =
            Math.max(
                bestScore,
                score
            );
    }

    if (
        tai === 0 &&
        xiu === 0
    ) {
        return null;
    }

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            Math.min(
                95,
                50 +
                bestScore * 0.45
            )
    };
}

// =========================================================
// RUN ALL MODELS
// =========================================================

function runModels(
    history,
    pattern,
    type
) {

    return {

        model1:
            model1(history),

        model2:
            model2(pattern),

        model3:
            model3(history),

        model4:
            model4(history),

        model5:
            model5(history),

        model6:
            model6(
                history,
                type
            ),

        model7:
            model7(history),

        model8:
            model8(history),

        model9:
            model9(pattern)
    };
}

// =========================================================
// ENSEMBLE
// =========================================================

function combineModels(
    models,
    type,
    sampleScore
) {

    const memory =
        aiMemory[type];

    let tai = 0;
    let xiu = 0;

    for (
        const [name, model]
        of Object.entries(models)
    ) {

        if (
            !model ||
            !model.prediction
        ) {
            continue;
        }

        const ai =
            memory[name];

        const confidence =
            Number(
                model.confidence
            ) || 50;

        const score =
            ai.weight *
            confidence;

        if (
            model.prediction ===
            "TAI"
        ) {

            tai += score;

        } else {

            xiu += score;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {

            prediction:
                "TAI",

            confidence:
                50
        };
    }

    let confidence =
        50 +
        (
            Math.abs(
                tai - xiu
            ) /
            total
        ) * 45;

    if (
        sampleScore >= 90
    ) {

        confidence += 4;

    } else if (
        sampleScore >= 80
    ) {

        confidence += 3;

    } else if (
        sampleScore >= 70
    ) {

        confidence += 1;
    }

    confidence =
        Math.min(
            97,
            Math.max(
                50,
                confidence
            )
        );

    return {

        prediction:
            tai >= xiu
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                confidence.toFixed(2)
            )
    };
}

// =========================================================
// BUILD PATTERN MEMORY
// =========================================================

function updatePatternMemory(
    type,
    history
) {

    if (
        history.length <
        PATTERN_LENGTH + 1
    ) {
        return;
    }

    const memory =
        patternMemory[type];

    const pattern =
        buildPattern(
            history.slice(
                0,
                history.length - 1
            )
        );

    const next =
        history[
            history.length - 1
        ];

    const exists =
        memory.some(
            x =>
                x.pattern ===
                pattern &&
                x.phien ===
                next.phien
        );

    if (!exists) {

        memory.push({

            pattern,

            next:
                next.ket_qua,

            phien:
                next.phien
        });
    }

    while (
        memory.length >
        15
    ) {

        memory.shift();
    }
}

// =========================================================
// UPDATE AI
// =========================================================

function updateAI(
    type,
    predictionRecord,
    actual
) {

    if (!predictionRecord) {
        return;
    }

    const memory =
        aiMemory[type];

    for (
        const [name, prediction]
        of Object.entries(
            predictionRecord.models || {}
        )
    ) {

        if (
            !prediction ||
            !prediction.prediction
        ) {
            continue;
        }

        const model =
            memory[name];

        if (!model) {
            continue;
        }

        if (
            prediction.prediction ===
            actual
        ) {

            model.win++;

            model.weight +=
                0.08;

        } else {

            model.loss++;

            model.weight -=
                0.04;
        }

        model.weight =
            Math.max(
                0.2,
                Math.min(
                    4,
                    model.weight
                )
            );
    }

    saveJSON(
        AI_FILE,
        aiMemory
    );
}

// =========================================================
// PENDING PREDICTIONS
// =========================================================

const pendingPredictions = {
    tx: new Map(),
    md5: new Map()
};

// =========================================================
// EVALUATION
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
// PROCESS RESULT
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

        updateAI(
            type,
            pending,
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
// SSE PUSH
// =========================================================

function pushSSE(
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
            "Không có dữ liệu hợp lệ"
        );
    }

    const old =
        sourceHistory[type];

    const latest =
        sessions[
            sessions.length - 1
        ];

    const oldLatest =
        old.length
            ? old[
                old.length - 1
            ]
            : null;

    sourceHistory[type] =
        sessions.slice(
            -MAX_SOURCE_HISTORY
        );

    // =====================================================
    // SETTLE ALL PENDING
    // =====================================================

    let changed = false;

    for (
        const session of
        sourceHistory[type]
    ) {

        const result =
            settleEvaluation(
                type,
                session
            );

        if (result) {
            changed = true;
        }
    }

    // =====================================================
    // NEW SESSION
    // =====================================================

    const isNewSession =
        !oldLatest ||
        oldLatest.phien !==
        latest.phien;

    if (
        isNewSession
    ) {

        pushSSE(
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

    // =====================================================
    // CHƯA ĐỦ 15
    // =====================================================

    if (
        sourceHistory[type]
            .length <
        MIN_HISTORY
    ) {

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
                buildPattern(
                    sourceHistory[type]
                ),

            du_doan:
                "Không rõ",

            do_tin_cay:
                "50%"
        };
    }

    // =====================================================
    // BUILD PATTERN
    // =====================================================

    const history =
        sourceHistory[type];

    const pattern =
        buildPattern(
            history
        );

    const sample =
        compareSamplePatterns(
            pattern
        );

    // =====================================================
    // AI PATTERN MEMORY
    // =====================================================

    updatePatternMemory(
        type,
        history
    );

    // =====================================================
    // MODELS
    // =====================================================

    const models =
        runModels(
            history,
            pattern,
            type
        );

    // =====================================================
    // FINAL
    // =====================================================

    const result =
        combineModels(
            models,
            type,
            sample
                ? sample.score
                : 0
        );

    const nextPhien =
        latest.phien + 1;

    // =====================================================
    // CHỈ TẠO PREDICTION MỘT LẦN
    // =====================================================

    if (
        !pendingPredictions[type]
            .has(nextPhien)
    ) {

        pendingPredictions[type]
            .set(
                nextPhien,
                {
                    prediction:
                        result.prediction,

                    models
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
                        result.prediction
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
        }
    }

    // =====================================================
    // HISTORY ĐÃ THAY ĐỔI
    // =====================================================

    if (
        changed ||
        isNewSession
    ) {

        pushSSE(
            type,
            "history",
            evaluationHistory[type]
        );
    }

    // =====================================================
    // PUBLIC JSON
    // =====================================================

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
            displayResult(
                result.prediction
            ),

        do_tin_cay:
            `${result.confidence}%`
    };
}

// =========================================================
// MAIN ENDPOINT TX
// =========================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    "tx"
                );

            res.json(data);

        } catch (error) {

            console.error(
                "[TX]",
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
// MAIN ENDPOINT MD5
// =========================================================

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    "md5"
                );

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
// HISTORY TX
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
// HISTORY MD5
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
// SSE TX
// =========================================================

app.get(
    "/api/lc79/hu/history/stream",
    (req, res) => {

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

        if (res.flushHeaders) {
            res.flushHeaders();
        }

        sseClients.tx.add(res);

        res.write(
            "retry: 3000\n\n"
        );

        res.write(
            `event: history\n`
        );

        res.write(
            `data: ${JSON.stringify(
                evaluationHistory.tx
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

                sseClients.tx.delete(
                    res
                );
            }
        );
    }
);

// =========================================================
// SSE MD5
// =========================================================

app.get(
    "/api/lc79/md5/history/stream",
    (req, res) => {

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

        if (res.flushHeaders) {
            res.flushHeaders();
        }

        sseClients.md5.add(res);

        res.write(
            "retry: 3000\n\n"
        );

        res.write(
            `event: history\n`
        );

        res.write(
            `data: ${JSON.stringify(
                evaluationHistory.md5
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

                sseClients.md5.delete(
                    res
                );
            }
        );
    }
);

// =========================================================
// REALTIME POLLER
// =========================================================

let polling = false;

async function realtimePoll() {

    if (polling) {
        return;
    }

    polling = true;

    try {

        await Promise.allSettled([

            processAPI("tx"),

            processAPI("md5")

        ]);

    } catch (error) {

        console.error(
            "[REALTIME]",
            error.message
        );

    } finally {

        polling = false;
    }
}

// =========================================================
// START REALTIME
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
                "LC79 AI 3.0",

            realtime:
                true,

            poll:
                "3s",

            pattern:
                "15",

            compare:
                "5",

            models:
                9,

            endpoints: {

                tx:
                    "/lc79/tx/hu",

                md5:
                    "/lc79/tx/md5",

                tx_history:
                    "/api/lc79/hu/history",

                md5_history:
                    "/api/lc79/md5/history",

                tx_stream:
                    "/api/lc79/hu/history/stream",

                md5_stream:
                    "/api/lc79/md5/history/stream"
            }
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
╔════════════════════════════════════════════════╗
║              LC79 AI API 3.0                  ║
╠════════════════════════════════════════════════╣
║ PORT        : ${PORT}
║ POLLING     : 3 giây
║ PATTERN     : 15 phiên
║ COMPARE     : 5 phiên
║ MODELS      : 9
║ AI LEARNING : ON
║ SSE         : ON
║ PERSIST     : ON
╠════════════════════════════════════════════════╣
║ TX          : /lc79/tx/hu
║ MD5         : /lc79/tx/md5
║ TX HISTORY  : /api/lc79/hu/history
║ MD5 HISTORY : /api/lc79/md5/history
║ TX STREAM   : /api/lc79/hu/history/stream
║ MD5 STREAM  : /api/lc79/md5/history/stream
╚════════════════════════════════════════════════╝
`);
    }
);
