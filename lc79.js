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

const POLL_INTERVAL = 3000;

const PATTERN_LENGTH = 15;
const COMPARE_MIN = 10;

const MAX_SOURCE_HISTORY = 200;
const MAX_PATTERN_MEMORY = 5000;
const MAX_EVALUATION_HISTORY = 100;

// =========================================================
// DATA
// =========================================================

const DATA_DIR =
    path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

const AI_FILE =
    path.join(
        DATA_DIR,
        "pattern-ai.json"
    );

const HISTORY_FILE =
    path.join(
        DATA_DIR,
        "history.json"
    );

const savedAI =
    loadJSON(
        AI_FILE,
        {
            tx: {},
            md5: {}
        }
    );

const savedHistory =
    loadJSON(
        HISTORY_FILE,
        {
            tx: [],
            md5: []
        }
    );

const patternMemory = {
    tx:
        normalizePatternMemory(
            savedAI.tx
        ),

    md5:
        normalizePatternMemory(
            savedAI.md5
        )
};

const evaluationHistory = {
    tx:
        Array.isArray(savedHistory.tx)
            ? savedHistory.tx
            : [],

    md5:
        Array.isArray(savedHistory.md5)
            ? savedHistory.md5
            : []
};

const sourceHistory = {
    tx: [],
    md5: []
};

const pendingPredictions = {
    tx: new Map(),
    md5: new Map()
};

const clients = {
    tx: new Set(),
    md5: new Set()
};

// =========================================================
// JSON
// =========================================================

function loadJSON(file, fallback) {

    try {

        if (!fs.existsSync(file)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(
                file,
                "utf8"
            )
        );

    } catch (error) {

        console.error(
            "[JSON LOAD]",
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
            "[JSON SAVE]",
            error.message
        );
    }
}

// =========================================================
// NORMALIZE PATTERN MEMORY
// =========================================================

function normalizePatternMemory(data) {

    if (!data || typeof data !== "object") {
        return {};
    }

    const result = {};

    for (
        const [pattern, value]
        of Object.entries(data)
    ) {

        if (
            typeof pattern !== "string" ||
            pattern.length !== PATTERN_LENGTH ||
            !/^[TX]+$/.test(pattern)
        ) {
            continue;
        }

        result[pattern] = {

            pattern,

            tai:
                Number(value.tai) || 0,

            xiu:
                Number(value.xiu) || 0,

            wins:
                Number(value.wins) || 0,

            losses:
                Number(value.losses) || 0,

            weight:
                Number(value.weight) > 0
                    ? Number(value.weight)
                    : 1,

            total:
                Number(value.total) || 0
        };
    }

    return result;
}

// =========================================================
// RESULT
// =========================================================

function normalizeResult(value) {

    if (value === null || value === undefined) {
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

    return normalizeResult(value) ===
        "TAI"
        ? "T"
        : "X";
}

// =========================================================
// CLAMP
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

// =========================================================
// SOURCE API
// =========================================================

async function fetchSource(type) {

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
                SOURCE_API[type],
                {
                    method: "GET",

                    headers: {
                        Accept:
                            "application/json",

                        "User-Agent":
                            "LC79-Pattern-AI/1.0"
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
// NORMALIZE SESSIONS
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
                        (
                            total,
                            value
                        ) =>
                            total + value,
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
// BUILD MAIN PATTERN
// =========================================================

function buildPattern(
    history,
    length = PATTERN_LENGTH
) {

    return history
        .slice(-length)
        .map(
            item =>
                toTX(
                    item.ket_qua
                )
        )
        .join("");
}

// =========================================================
// VALID PATTERN
// =========================================================

function validPattern(pattern) {

    return (
        typeof pattern === "string" &&
        pattern.length === PATTERN_LENGTH &&
        /^[TX]+$/.test(pattern)
    );
}

// =========================================================
// PATTERN SIMILARITY
// =========================================================

function comparePattern(
    main,
    sample
) {

    if (
        !main ||
        !sample
    ) {
        return {
            same: 0,
            similarity: 0,
            distance: 15
        };
    }

    const length =
        Math.min(
            main.length,
            sample.length
        );

    let same = 0;

    for (
        let i = 0;
        i < length;
        i++
    ) {

        if (
            main[i] ===
            sample[i]
        ) {
            same++;
        }
    }

    const similarity =
        (
            same /
            PATTERN_LENGTH
        ) * 100;

    return {

        same,

        similarity,

        distance:
            PATTERN_LENGTH - same
    };
}

// =========================================================
// POSITION WEIGHT
// Phiên gần cuối quan trọng hơn
// =========================================================

function positionWeight(index) {

    const weight =
        0.75 +
        (
            index /
            (PATTERN_LENGTH - 1)
        ) * 0.75;

    return weight;
}

// =========================================================
// PATTERN SCORE
// =========================================================

function calculatePatternScore(
    main,
    sample
) {

    if (
        !validPattern(main) ||
        !validPattern(sample)
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
            main[i] ===
            sample[i]
        ) {

            score +=
                positionWeight(i);
        }
    }

    return score;
}

// =========================================================
// PATTERN SAMPLE GENERATOR
// =========================================================

function generateRunPattern(
    firstRun,
    secondRun,
    firstChar
) {

    let result = "";

    let current =
        firstChar;

    while (
        result.length <
        PATTERN_LENGTH
    ) {

        const count =
            current === firstChar
                ? firstRun
                : secondRun;

        result +=
            current.repeat(count);

        current =
            current === "T"
                ? "X"
                : "T";
    }

    return result.slice(
        0,
        PATTERN_LENGTH
    );
}

function generatePatternSamples() {

    const samples =
        new Set();

    // -----------------------------------------
    // 1-1 đến 10-10
    // -----------------------------------------

    for (
        let a = 1;
        a <= 10;
        a++
    ) {

        for (
            let b = 1;
            b <= 10;
            b++
        ) {

            if (
                a + b > 15
            ) {
                continue;
            }

            samples.add(
                generateRunPattern(
                    a,
                    b,
                    "T"
                )
            );

            samples.add(
                generateRunPattern(
                    a,
                    b,
                    "X"
                )
            );
        }
    }

    // -----------------------------------------
    // Alternating
    // -----------------------------------------

    samples.add(
        "TXTXTXTXTXTXTXT"
    );

    samples.add(
        "XTXTXTXTXTXTXTX"
    );

    // -----------------------------------------
    // Các pattern phổ biến
    // -----------------------------------------

    const predefined = [

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
        "XXXXXXXXXTXXXXXX",

        "TTTTTTTTTTXTTTT",
        "XXXXXXXXXXTXXXX",

        "TTXXTTXXTTXXTTX",
        "XXTTXXTTXXTTXXT",

        "TTTXXXTTTXXXTTT",
        "XXXTTTXXXTTTXXX",

        "TTTTXXXXTTTTXXX",
        "XXXXTTTTXXXXTTT",

        "TTXXXXTTTTXXTTT",
        "XXTTTTXXXXTTXXX",

        "TXTTXTTXTTXTTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTXTTXTXTTXTX",
        "XXTXTXXTXTXXTXT",

        "TXTTXXTTXTXTTXX",
        "XTTXXTXXTXTXXTT",

        "TTXTXTXTXTXTXTT",
        "XXTXT XTXTXTXTT".replace(
            / /g,
            ""
        ),

        "TTXXXTXXTTXXTXT",
        "XXTTTXTTXXTTXTX",

        "TTXXTTTXXTTXXTX",
        "XXTTXXXTTXXTTXT",

        "TXXTXXTXXTXXTXX",
        "XTTXTTXTTXTTXTT",

        "TTXXTXXXTTXXTTX",
        "XXTTXTTTXXTTXXT",

        "TTXTTXXXTTXTTXX",
        "XXTXXTTTX XTTXX".replace(
            / /g,
            ""
        ),

        "TTTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXXT",

        "TTTTTTTTTTTTTXT",
        "XXXXXXXXXXXXXXTX",

        "TTTTTTTTTTTTTXX",
        "XXXXXXXXXXXXXTT"
    ];

    for (
        const pattern
        of predefined
    ) {

        if (
            validPattern(pattern)
        ) {

            samples.add(
                pattern
            );
        }
    }

    return [
        ...samples
    ].filter(
        validPattern
    );
}

const PATTERN_SAMPLES =
    generatePatternSamples();

// =========================================================
// SAMPLE PREDICTION
// =========================================================
//
// Pattern mẫu phải có kết quả tiếp theo.
// Với mẫu sinh sẵn, kết quả tiếp theo
// được suy ra từ ký tự cuối theo dạng
// đảo cầu / tiếp cầu.
//

function oppositeTX(value) {

    return value === "T"
        ? "X"
        : "T";
}

function buildStaticSampleMemory() {

    const result = [];

    for (
        const pattern
        of PATTERN_SAMPLES
    ) {

        if (
            !validPattern(pattern)
        ) {
            continue;
        }

        // Không dùng random.
        // Dự đoán mẫu dựa trên cấu trúc:
        //
        // Nếu 3+ ký tự cuối giống nhau:
        // ưu tiên đảo.
        //
        // Nếu pattern xen kẽ:
        // tiếp tục đảo.
        //
        // Còn lại:
        // dùng ký tự cuối.

        const last =
            pattern[
                pattern.length - 1
            ];

        const last3 =
            pattern.slice(-3);

        let prediction;

        if (
            last3.length === 3 &&
            (
                last3 === "TTT" ||
                last3 === "XXX"
            )
        ) {

            prediction =
                oppositeTX(last);

        } else {

            prediction =
                oppositeTX(last);
        }

        result.push({

            pattern,

            prediction:
                prediction === "T"
                    ? "TAI"
                    : "XIU"
        });
    }

    return result;
}

const STATIC_SAMPLE_MEMORY =
    buildStaticSampleMemory();

// =========================================================
// LEARNING MEMORY
// =========================================================

function getPatternMemory(
    type,
    pattern
) {

    if (
        !patternMemory[type][pattern]
    ) {

        patternMemory[type][pattern] = {

            pattern,

            tai: 0,

            xiu: 0,

            wins: 0,

            losses: 0,

            weight: 1,

            total: 0
        };
    }

    return patternMemory[type][pattern];
}

// =========================================================
// BUILD HISTORICAL PATTERN SAMPLES
// =========================================================
//
// Từ dữ liệu thật:
// 15 phiên → phiên thứ 16
//

function learnHistoricalPatterns(
    type,
    history
) {

    if (
        history.length <
        PATTERN_LENGTH + 1
    ) {
        return;
    }

    for (
        let i =
            PATTERN_LENGTH;

        i < history.length;

        i++
    ) {

        const window =
            history.slice(
                i - PATTERN_LENGTH,
                i
            );

        const pattern =
            buildPattern(
                window
            );

        const next =
            history[i].ket_qua;

        if (
            !validPattern(pattern) ||
            !next
        ) {
            continue;
        }

        const memory =
            getPatternMemory(
                type,
                pattern
            );

        if (
            next === "TAI"
        ) {

            memory.tai++;

        } else {

            memory.xiu++;
        }

        memory.total =
            memory.tai +
            memory.xiu;

        const historicalRate =
            Math.max(
                memory.tai,
                memory.xiu
            ) /
            memory.total;

        memory.weight =
            clamp(
                0.5 +
                historicalRate,
                0.5,
                1.8
            );
    }

    trimPatternMemory(type);

    saveAI();
}

// =========================================================
// LIMIT MEMORY
// =========================================================

function trimPatternMemory(type) {

    const keys =
        Object.keys(
            patternMemory[type]
        );

    if (
        keys.length <=
        MAX_PATTERN_MEMORY
    ) {
        return;
    }

    keys.sort(
        (
            a,
            b
        ) => {

            return (
                patternMemory[type][a].total -
                patternMemory[type][b].total
            );
        }
    );

    const removeCount =
        keys.length -
        MAX_PATTERN_MEMORY;

    for (
        let i = 0;
        i < removeCount;
        i++
    ) {

        delete patternMemory[type][
            keys[i]
        ];
    }
}

// =========================================================
// SAVE AI
// =========================================================

function saveAI() {

    saveJSON(
        AI_FILE,
        patternMemory
    );
}

// =========================================================
// MATCH SAMPLE
// =========================================================

function findPatternMatches(
    type,
    mainPattern
) {

    const matches = [];

    // -----------------------------------------
    // Historical learned patterns
    // -----------------------------------------

    for (
        const item
        of Object.values(
            patternMemory[type]
        )
    ) {

        if (
            !validPattern(
                item.pattern
            )
        ) {
            continue;
        }

        const compare =
            comparePattern(
                mainPattern,
                item.pattern
            );

        if (
            compare.same <
            COMPARE_MIN
        ) {
            continue;
        }

        const baseScore =
            calculatePatternScore(
                mainPattern,
                item.pattern
            );

        const learnedWeight =
            Number(
                item.weight
            ) || 1;

        const historicalTotal =
            Number(
                item.total
            ) || 0;

        const historicalConfidence =
            historicalTotal > 0

                ? (
                    Math.max(
                        item.tai,
                        item.xiu
                    ) /
                    historicalTotal
                )

                : 0.5;

        const score =
            baseScore *
            learnedWeight *
            (
                0.75 +
                historicalConfidence *
                0.5
            );

        let prediction;

        if (
            item.tai >
            item.xiu
        ) {

            prediction =
                "TAI";

        } else if (
            item.xiu >
            item.tai
        ) {

            prediction =
                "XIU";

        } else {

            continue;
        }

        matches.push({

            source:
                "history",

            pattern:
                item.pattern,

            prediction,

            same:
                compare.same,

            similarity:
                Number(
                    compare.similarity.toFixed(2)
                ),

            score:
                Number(
                    score.toFixed(4)
                ),

            weight:
                learnedWeight,

            occurrences:
                historicalTotal,

            wins:
                item.wins,

            losses:
                item.losses
        });
    }

    // -----------------------------------------
    // Static pattern samples
    // -----------------------------------------

    for (
        const item
        of STATIC_SAMPLE_MEMORY
    ) {

        const compare =
            comparePattern(
                mainPattern,
                item.pattern
            );

        if (
            compare.same <
            COMPARE_MIN
        ) {
            continue;
        }

        const baseScore =
            calculatePatternScore(
                mainPattern,
                item.pattern
            );

        const score =
            baseScore *
            0.65;

        matches.push({

            source:
                "sample",

            pattern:
                item.pattern,

            prediction:
                item.prediction,

            same:
                compare.same,

            similarity:
                Number(
                    compare.similarity.toFixed(2)
                ),

            score:
                Number(
                    score.toFixed(4)
                ),

            weight:
                0.65,

            occurrences:
                0,

            wins:
                0,

            losses:
                0
        });
    }

    matches.sort(
        (
            a,
            b
        ) =>
            b.score -
            a.score
    );

    return matches;
}

// =========================================================
// PREDICT FROM MAIN PATTERN
// =========================================================

function predictFromPattern(
    type,
    mainPattern
) {

    if (
        !validPattern(mainPattern)
    ) {

        return {

            prediction:
                null,

            confidence:
                0,

            matches: [],

            taiScore: 0,

            xiuScore: 0
        };
    }

    const matches =
        findPatternMatches(
            type,
            mainPattern
        );

    // -----------------------------------------
    // Không có pattern đủ giống
    // -----------------------------------------

    if (!matches.length) {

        return {

            prediction:
                null,

            confidence:
                0,

            matches: [],

            taiScore: 0,

            xiuScore: 0
        };
    }

    // -----------------------------------------
    // Chỉ lấy các pattern tốt nhất
    // -----------------------------------------

    const bestMatches =
        matches.slice(
            0,
            100
        );

    let taiScore = 0;
    let xiuScore = 0;

    for (
        const item
        of bestMatches
    ) {

        if (
            item.prediction ===
            "TAI"
        ) {

            taiScore +=
                item.score;

        } else {

            xiuScore +=
                item.score;
        }
    }

    const total =
        taiScore +
        xiuScore;

    if (
        total <= 0
    ) {

        return {

            prediction:
                null,

            confidence:
                0,

            matches:
                bestMatches,

            taiScore: 0,

            xiuScore: 0
        };
    }

    const prediction =
        taiScore >= xiuScore
            ? "TAI"
            : "XIU";

    const winner =
        Math.max(
            taiScore,
            xiuScore
        );

    const loser =
        Math.min(
            taiScore,
            xiuScore
        );

    // -----------------------------------------
    // Độ tin cậy
    // -----------------------------------------

    const dominance =
        winner /
        total;

    const difference =
        (
            winner -
            loser
        ) /
        total;

    const bestSimilarity =
        bestMatches.length
            ? bestMatches[0].similarity
            : 0;

    let confidence =
        50 +
        difference * 35 +
        (
            bestSimilarity /
            100
        ) * 12;

    // Có nhiều pattern đồng thuận
    const samePredictionCount =
        bestMatches.filter(
            x =>
                x.prediction ===
                prediction
        ).length;

    if (
        samePredictionCount >= 5
    ) {

        confidence += 2;
    }

    if (
        samePredictionCount >= 10
    ) {

        confidence += 2;
    }

    confidence =
        clamp(
            confidence,
            50,
            98
        );

    return {

        prediction,

        confidence:
            Number(
                confidence.toFixed(2)
            ),

        matches:
            bestMatches,

        taiScore:
            Number(
                taiScore.toFixed(4)
            ),

        xiuScore:
            Number(
                xiuScore.toFixed(4)
            ),

        dominance:
            Number(
                dominance.toFixed(4)
            )
    };
}

// =========================================================
// CREATE EVALUATION
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
// SETTLE RESULT
// =========================================================

function settlePrediction(
    type,
    session
) {

    const evaluation =
        evaluationHistory[type]
            .find(
                x =>
                    x.phien ===
                    session.phien
            );

    if (!evaluation) {
        return false;
    }

    if (
        evaluation.ket_qua !==
        "⌛ Chờ Kết Quả"
    ) {
        return false;
    }

    evaluation.ket_qua =
        displayResult(
            session.ket_qua
        );

    evaluation.xuc_xac =
        session.xuc_xac;

    evaluation.tong =
        session.tong;

    const prediction =
        normalizeResult(
            evaluation.du_doan
        );

    const isWin =
        prediction ===
        session.ket_qua;

    evaluation.danh_gia =
        isWin
            ? "✅ Thắng"
            : "❌ Thua";

    // -----------------------------------------
    // AI tự học pattern đã sử dụng
    // -----------------------------------------

    const pending =
        pendingPredictions[type]
            .get(
                session.phien
            );

    if (pending) {

        learnPredictionResult(
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
// AI LEARNING AFTER RESULT
// =========================================================

function learnPredictionResult(
    type,
    pending,
    actual
) {

    if (
        !pending ||
        !Array.isArray(
            pending.matches
        )
    ) {
        return;
    }

    for (
        const match
        of pending.matches
    ) {

        if (
            match.source !==
            "history"
        ) {
            continue;
        }

        const item =
            patternMemory[type][
                match.pattern
            ];

        if (!item) {
            continue;
        }

        item.total++;

        if (
            match.prediction ===
            actual
        ) {

            item.wins++;

            item.weight =
                clamp(
                    item.weight +
                    0.08,
                    0.2,
                    3
                );

        } else {

            item.losses++;

            item.weight =
                clamp(
                    item.weight -
                    0.05,
                    0.2,
                    3
                );
        }

        // -------------------------------------
        // Tính lại xác suất lịch sử
        // -------------------------------------

        const total =
            item.tai +
            item.xiu;

        if (total > 0) {

            const rate =
                Math.max(
                    item.tai,
                    item.xiu
                ) /
                total;

            item.weight =
                clamp(
                    (
                        item.weight +
                        rate
                    ) / 2,
                    0.2,
                    3
                );
        }
    }

    saveAI();
}

// =========================================================
// UPDATE HISTORY
// =========================================================

function addEvaluation(
    type,
    phien,
    prediction
) {

    const exists =
        evaluationHistory[type]
            .some(
                x =>
                    x.phien ===
                    phien
            );

    if (exists) {
        return false;
    }

    evaluationHistory[type]
        .unshift(
            createEvaluation(
                phien,
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

    const payload =
        JSON.stringify(data);

    for (
        const res
        of clients[type]
    ) {

        try {

            res.write(
                `event: ${event}\n`
            );

            res.write(
                `data: ${payload}\n\n`
            );

        } catch {

            clients[type]
                .delete(res);
        }
    }
}

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
        typeof res.flushHeaders ===
        "function"
    ) {

        res.flushHeaders();
    }

    clients[type].add(res);

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
                        ": ping\n\n"
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

// =========================================================
// PROCESS
// =========================================================

async function processType(
    type
) {

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

    const previousLatest =
        previous.length
            ? previous[
                previous.length - 1
            ]
            : null;

    const latest =
        sessions[
            sessions.length - 1
        ];

    sourceHistory[type] =
        sessions.slice(
            -MAX_SOURCE_HISTORY
        );

    // =====================================================
    // SETTLE CÁC PHIÊN CŨ
    // =====================================================

    let changed = false;

    for (
        const session
        of sourceHistory[type]
    ) {

        if (
            settlePrediction(
                type,
                session
            )
        ) {

            changed = true;
        }
    }

    // =====================================================
    // HỌC PATTERN TỪ DỮ LIỆU THẬT
    // =====================================================

    learnHistoricalPatterns(
        type,
        sourceHistory[type]
    );

    // =====================================================
    // CHỈ PHÂN TÍCH KHI ĐỦ 15 PHIÊN
    // =====================================================

    if (
        sourceHistory[type].length <
        PATTERN_LENGTH
    ) {

        return null;
    }

    const mainPattern =
        buildPattern(
            sourceHistory[type]
        );

    if (
        !validPattern(mainPattern)
    ) {

        return null;
    }

    // =====================================================
    // SO SÁNH PATTERN CHÍNH
    // =====================================================

    const prediction =
        predictFromPattern(
            type,
            mainPattern
        );

    const currentPhien =
        latest.phien;

    const nextPhien =
        currentPhien + 1;

    // =====================================================
    // KHÔNG CÓ PATTERN ĐỦ ĐIỂM
    // =====================================================

    if (
        !prediction.prediction
    ) {

        return {

            phien:
                currentPhien,

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
                mainPattern,

            du_doan:
                "Không rõ",

            do_tin_cay:
                "50.00%"
        };
    }

    // =====================================================
    // LƯU PREDICTION CHO PHIÊN KẾ
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
                        prediction.prediction,

                    mainPattern,

                    matches:
                        prediction.matches,

                    confidence:
                        prediction.confidence
                }
            );
    }

    // =====================================================
    // HISTORY PENDING
    // =====================================================

    if (
        addEvaluation(
            type,
            nextPhien,
            prediction.prediction
        )
    ) {

        changed = true;
    }

    // =====================================================
    // REALTIME
    // =====================================================

    const newSession =
        !previousLatest ||
        previousLatest.phien !==
        latest.phien;

    if (newSession) {

        sendSSE(
            type,
            "result",
            {

                phien:
                    currentPhien,

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
        changed
    ) {

        sendSSE(
            type,
            "history",
            evaluationHistory[type]
        );
    }

    // =====================================================
    // OUTPUT CHỈ 8 FIELD
    // =====================================================

    return {

        phien:
            currentPhien,

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
            mainPattern,

        du_doan:
            displayResult(
                prediction.prediction
            ),

        do_tin_cay:
            `${prediction.confidence.toFixed(2)}%`
    };
}

// =========================================================
// API HU
// =========================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        try {

            const data =
                await processType(
                    "tx"
                );

            res.json(
                data || {
                    phien: null,
                    xuc_xac: [],
                    tong: null,
                    ket_qua: "⌛ Chờ",
                    phien_hien_tai: null,
                    pattern: "",
                    du_doan: "Không rõ",
                    do_tin_cay: "50.00%"
                }
            );

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
// API MD5
// =========================================================

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        try {

            const data =
                await processType(
                    "md5"
                );

            res.json(
                data || {
                    phien: null,
                    xuc_xac: [],
                    tong: null,
                    ket_qua: "⌛ Chờ",
                    phien_hien_tai: null,
                    pattern: "",
                    du_doan: "Không rõ",
                    do_tin_cay: "50.00%"
                }
            );

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
// HU REALTIME HISTORY
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
// MD5 REALTIME HISTORY
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
// PATTERN SAMPLE API
// =========================================================

app.get(
    "/api/lc79/patterns",
    (req, res) => {

        res.json({

            total:
                PATTERN_SAMPLES.length,

            length:
                PATTERN_LENGTH,

            patterns:
                PATTERN_SAMPLES
        });
    }
);

// =========================================================
// PATTERN MEMORY API
// =========================================================

app.get(
    "/api/lc79/pattern-memory",
    (req, res) => {

        res.json({

            tx:
                Object.values(
                    patternMemory.tx
                ),

            md5:
                Object.values(
                    patternMemory.md5
                )
        });
    }
);

// =========================================================
// ANALYZE PATTERN
// =========================================================

app.get(
    "/api/lc79/pattern/analyze",
    async (req, res) => {

        const type =
            req.query.type === "md5"
                ? "md5"
                : "tx";

        const pattern =
            String(
                req.query.pattern || ""
            )
                .toUpperCase()
                .trim();

        if (
            !validPattern(pattern)
        ) {

            return res.status(400).json({

                error: true,

                message:
                    `pattern phải đúng ${PATTERN_LENGTH} ký tự T/X`,

                example:
                    "TTXTTXXTXTTXXTX"
            });
        }

        const prediction =
            predictFromPattern(
                type,
                pattern
            );

        res.json({

            pattern,

            du_doan:
                prediction.prediction
                    ? displayResult(
                        prediction.prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                `${(
                    prediction.confidence || 0
                ).toFixed(2)}%`,

            tai_score:
                prediction.taiScore,

            xiu_score:
                prediction.xiuScore,

            matches:
                prediction.matches
                    .slice(
                        0,
                        30
                    )
        });
    }
);

// =========================================================
// RESET AI
// =========================================================

app.post(
    "/api/lc79/pattern-memory/reset",
    (req, res) => {

        patternMemory.tx = {};
        patternMemory.md5 = {};

        saveAI();

        res.json({

            success: true,

            message:
                "Đã reset Pattern AI"
        });
    }
);

// =========================================================
// HEALTH
// =========================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status:
                "online",

            version:
                "LC79 Pattern AI 5.0",

            algorithm:
                "MAIN_PATTERN_15",

            old_algorithms:
                false,

            pattern_length:
                PATTERN_LENGTH,

            compare_min:
                COMPARE_MIN,

            sample_patterns:
                PATTERN_SAMPLES.length,

            ai_learning:
                true,

            realtime:
                true,

            poll:
                "3s",

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

                pattern_memory:
                    "/api/lc79/pattern-memory",

                analyze:
                    "/api/lc79/pattern/analyze",

                reset:
                    "/api/lc79/pattern-memory/reset"
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
// SERVER
// =========================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔════════════════════════════════════════════════════╗
║             LC79 PATTERN AI 5.0                   ║
╠════════════════════════════════════════════════════╣
║ Core Algorithm : MAIN PATTERN 15                  ║
║ Old Algorithms : OFF                              ║
║ Pattern Length : 15                               ║
║ Compare Min    : ${COMPARE_MIN}                              ║
║ Samples        : ${PATTERN_SAMPLES.length}                              ║
║ AI Learning    : ON                               ║
║ Realtime SSE   : ON                               ║
║ Poll           : 3 seconds                        ║
╠════════════════════════════════════════════════════╣
║ /lc79/tx/hu                                      ║
║ /lc79/tx/md5                                     ║
║ /api/lc79/hu/history                             ║
║ /api/lc79/md5/history                            ║
║ /api/lc79/hu/history/stream                     ║
║ /api/lc79/md5/history/stream                    ║
║ /api/lc79/patterns                               ║
║ /api/lc79/pattern-memory                        ║
║ /api/lc79/pattern/analyze                       ║
╚════════════════════════════════════════════════════╝
`);
    }
);
