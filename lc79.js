const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3001;

// =========================================================
// API GỐC
// =========================================================

const SOURCE_TX =
    "https://wtx.tele68.com/v1/tx/sessions";

const SOURCE_MD5 =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// =========================================================
// CONFIG
// =========================================================

const MAX_HISTORY = 100;

const PATTERN_LENGTH = 15;

const COMPARE_PATTERN_LENGTH = 5;

const MAX_PATTERN_MEMORY = 15;

const MIN_HISTORY = 15;

// =========================================================
// HISTORY
// =========================================================

const histories = {
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

const aiMemory = {
    tx: createModelMemory(),
    md5: createModelMemory()
};

// =========================================================
// PATTERN MẪU
// =========================================================

const PATTERN_MODELS = {

    // -----------------------------------------------------
    // 1. CẦU BỆT
    // -----------------------------------------------------

    streak: [
        "TT",
        "TTT",
        "TTTT",
        "TTTTT",
        "TTTTTT",
        "TTTTTTT",
        "TTTTTTTT",

        "XX",
        "XXX",
        "XXXX",
        "XXXXX",
        "XXXXXX",
        "XXXXXXX",
        "XXXXXXXX"
    ],

    // -----------------------------------------------------
    // 2. CẦU 1-1
    // -----------------------------------------------------

    alternating: [
        "TX",
        "XT",

        "TXTX",
        "XTXT",

        "TXTXTX",
        "XTXTXT",

        "TXTXTXTX",
        "XTXTXTXT",

        "TXTXTXTXTX",
        "XTXTXTXTXT",

        "TXTXTXTXTXTX",
        "XTXTXTXTXTXT",

        "TXTXTXTXTXTXTX",
        "XTXTXTXTXTXTXT"
    ],

    // -----------------------------------------------------
    // 3. CẦU 2-2
    // -----------------------------------------------------

    twoTwo: [
        "TTXX",
        "XXTT",

        "TTXXTTXX",
        "XXTTXXTT",

        "TTXXTTXXTT",
        "XXTTXXTTXX",

        "TTXXTTXXTTXX",
        "XXTTXXTTXXTT",

        "TTXXTTXXTTXXTT",
        "XXTTXXTTXXTTXX"
    ],

    // -----------------------------------------------------
    // 4. CẦU 1-2-1
    // -----------------------------------------------------

    oneTwoOne: [
        "TXXT",
        "XTTX",

        "TXXTTXXT",
        "XTTXXTTX",

        "TXXTTXXTTXXT",
        "XTTXXTTXXTTX",

        "TXXTTXXTTXXTTXX",
        "XTTXXTTXXTTXXTT"
    ],

    // -----------------------------------------------------
    // 5. CẦU 2-1-2
    // -----------------------------------------------------

    twoOneTwo: [
        "TTXTT",
        "XXTXX",

        "TTXTTXTT",
        "XXTXXTXX",

        "TTXTTXTTXTT",
        "XXTXXTXXTXX",

        "TTXTTXTTXTTXTT",
        "XXTXXTXXTXXTXX"
    ],

    // -----------------------------------------------------
    // 6. CẦU 3-1
    // -----------------------------------------------------

    threeOne: [
        "TTTX",
        "XXXT",

        "TTTXTTTX",
        "XXXTXXXT",

        "TTTXTTTXTTTX",
        "XXXTXXXTXXXT",

        "TTTXTTTXTTTXTTTX",
        "XXXTXXXTXXXTXXXT"
    ],

    // -----------------------------------------------------
    // 7. CẦU 1-3
    // -----------------------------------------------------

    oneThree: [
        "TXXX",
        "XTTT",

        "TXXXTXXX",
        "XTTTXTTT",

        "TXXXTXXXTXXX",
        "XTTTXTTTXTTT",

        "TXXXTXXXTXXXTXXX",
        "XTTTXTTTXTTTXTTT"
    ],

    // -----------------------------------------------------
    // 8. CẦU 2-3
    // -----------------------------------------------------

    twoThree: [
        "TTXXX",
        "XXTTT",

        "TTXXXTTXXX",
        "XXTTTXXTTT",

        "TTXXXTTXXXTTXXX",
        "XXTTTXXTTTXXTTT"
    ],

    // -----------------------------------------------------
    // 9. CẦU 3-2
    // -----------------------------------------------------

    threeTwo: [
        "TTTXX",
        "XXXTT",

        "TTTXXTTTXX",
        "XXXTTXXXTT",

        "TTTXXTTTXXTTTXX",
        "XXXTTXXXTTXXXTT"
    ],

    // -----------------------------------------------------
    // 10. CẦU 2-3-2
    // -----------------------------------------------------

    twoThreeTwo: [
        "TTXXXTT",
        "XXTTTXX",

        "TTXXXTTTTXXXTT",
        "XXTTTXXXXTTTXX"
    ],

    // -----------------------------------------------------
    // 11. CẦU 1-1-2
    // -----------------------------------------------------

    oneOneTwo: [
        "TXTT",
        "XTXX",

        "TXTTXTT",
        "XTXXTXX",

        "TXTTXTTXTT",
        "XTXXTXXTXX"
    ],

    // -----------------------------------------------------
    // 12. CẦU 1-2-2
    // -----------------------------------------------------

    oneTwoTwo: [
        "TXXTT",
        "XTTXX",

        "TXXTTXXTT",
        "XTTXXTTXX",

        "TXXTTXXTTXX",
        "XTTXXTTXXTT"
    ],

    // -----------------------------------------------------
    // 13. CẦU 4-1
    // -----------------------------------------------------

    fourOne: [
        "TTTTX",
        "XXXXT",

        "TTTTXTTTTX",
        "XXXXTXXXXT",

        "TTTTXTTTTXTTTTX",
        "XXXXTXXXXTXXXXT"
    ],

    // -----------------------------------------------------
    // 14. CẦU 4-2
    // -----------------------------------------------------

    fourTwo: [
        "TTTTXX",
        "XXXXTT",

        "TTTTXXTTTTXX",
        "XXXXTTXXXXTT"
    ],

    // -----------------------------------------------------
    // 15. CẦU 5-1
    // -----------------------------------------------------

    fiveOne: [
        "TTTTTX",
        "XXXXXT",

        "TTTTTXTTTTTX",
        "XXXXXTXXXXXT"
    ],

    // -----------------------------------------------------
    // 16. CẦU ĐỐI XỨNG
    // -----------------------------------------------------

    symmetry: [
        "TTXTT",
        "XXTXX",

        "TXXTX",
        "XTTXT",

        "TTXXTT",
        "XXTTXX",

        "TTXTTXT",
        "XXTXXTX"
    ],

    // -----------------------------------------------------
    // 17. CẦU GÃY
    // -----------------------------------------------------

    breakPattern: [
        "TTTX",
        "XXXT",

        "TTTTX",
        "XXXXT",

        "TTTTTX",
        "XXXXXT",

        "TTTTTTX",
        "XXXXXXT",

        "TTTTTTTX",
        "XXXXXXXT"
    ],

    // -----------------------------------------------------
    // 18. CẦU ĐẢO
    // -----------------------------------------------------

    reverse: [
        "TTX",
        "XXT",

        "TXTT",
        "XTXX",

        "TTXTTX",
        "XXTXXT",

        "TTXXTTX",
        "XXTTXXT"
    ],

    // -----------------------------------------------------
    // 19. CẦU ZIGZAG
    // -----------------------------------------------------

    zigzag: [
        "TXTTX",
        "XTXTT",

        "TXTTXTX",
        "XTXTTXT",

        "TXTTXTXTTX",
        "XTXTTXTXTT"
    ],

    // -----------------------------------------------------
    // 20. CẦU HỖN HỢP
    // -----------------------------------------------------

    mixed: [
        "TTXTX",
        "XXTXT",

        "TXTTX",
        "XTTXX",

        "TTXXT",
        "XXTTX",

        "TXTXX",
        "XTXTT",

        "TXXTX",
        "XTTXT"
    ]
};

// =========================================================
// HIỂN THỊ TÀI / XỈU
// =========================================================

function displayResult(value) {

    if (value === "TAI") {
        return "Tài";
    }

    if (value === "XIU") {
        return "Xỉu";
    }

    return value;
}

// =========================================================
// NORMALIZE
// =========================================================

function normalizeResult(value) {

    if (!value) {
        return null;
    }

    const v =
        String(value)
            .toUpperCase()
            .trim();

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

// =========================================================
// T/X
// =========================================================

function toTX(value) {

    return normalizeResult(value) === "TAI"
        ? "T"
        : "X";
}

// =========================================================
// FETCH API GỐC
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
                            "LC79-TX-AI/1.0"
                    },

                    signal:
                        controller.signal
                }
            );

        if (!response.ok) {

            throw new Error(
                `API gốc HTTP ${response.status}`
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

            const point =
                Number(item.point);

            const tong =
                Number.isFinite(point)
                    ? point
                    : dices.reduce(
                        (a, b) => a + b,
                        0
                    );

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
// BUILD PATTERN 15
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
// PATTERN SO SÁNH 5
// =========================================================

function getComparePattern(
    pattern
) {

    return pattern.slice(
        -COMPARE_PATTERN_LENGTH
    );
}

// =========================================================
// SO SÁNH PATTERN MẪU
// =========================================================

function findSamplePattern(
    pattern
) {

    const current =
        pattern.slice(
            -COMPARE_PATTERN_LENGTH
        );

    let best = null;

    let bestScore = 0;

    for (
        const [modelName, samples]
        of Object.entries(
            PATTERN_MODELS
        )
    ) {

        for (
            const sample
            of samples
        ) {

            const target =
                sample.slice(
                    -COMPARE_PATTERN_LENGTH
                );

            const length =
                Math.min(
                    current.length,
                    target.length
                );

            if (!length) {
                continue;
            }

            let same = 0;

            for (
                let i = 0;
                i < length;
                i++
            ) {

                if (
                    current[i] ===
                    target[i]
                ) {
                    same++;
                }
            }

            const score =
                (
                    same / length
                ) * 100;

            if (
                score > bestScore
            ) {

                bestScore =
                    score;

                best = {

                    model:
                        modelName,

                    pattern:
                        sample,

                    score:
                        Number(
                            score.toFixed(2)
                        )
                };
            }
        }
    }

    return best;
}

// =========================================================
// LƯU PATTERN LỊCH SỬ
// =========================================================

function savePatternMemory(
    type,
    history
) {

    const memory =
        patternMemory[type];

    if (
        history.length <
        PATTERN_LENGTH + 1
    ) {
        return;
    }

    for (
        let i = 0;

        i <=
        history.length -
        PATTERN_LENGTH -
        1;

        i++
    ) {

        const pattern =
            history
                .slice(
                    i,
                    i +
                    PATTERN_LENGTH
                )
                .map(
                    item =>
                        toTX(
                            item.ket_qua
                        )
                )
                .join("");

        const next =
            history[
                i +
                PATTERN_LENGTH
            ];

        if (!next) {
            continue;
        }

        const exists =
            memory.some(
                item =>
                    item.pattern ===
                        pattern &&
                    item.phien ===
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
    }

    if (
        memory.length >
        MAX_PATTERN_MEMORY
    ) {

        memory.splice(
            0,
            memory.length -
            MAX_PATTERN_MEMORY
        );
    }
}

// =========================================================
// MODEL 1
// STREAK
// =========================================================

function model1Streak(
    history
) {

    if (!history.length) {

        return {
            prediction: null,
            confidence: 50
        };
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

    if (streak >= 4) {

        prediction =
            last === "TAI"
                ? "XIU"
                : "TAI";

    } else {

        prediction =
            last;
    }

    const confidence =
        Math.min(
            90,
            55 +
            streak * 5
        );

    return {

        prediction,

        confidence:
            Number(
                confidence.toFixed(2)
            )
    };
}

// =========================================================
// MODEL 2
// ALTERNATING
// =========================================================

function model2Alternating(
    pattern
) {

    const recent =
        pattern.slice(-8);

    if (
        recent.length < 4
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

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

        return {
            prediction: null,
            confidence: 50
        };
    }

    const last =
        recent[
            recent.length - 1
        ];

    return {

        prediction:
            last === "T"
                ? "XIU"
                : "TAI",

        confidence: 80
    };
}

// =========================================================
// MODEL 3
// MARKOV
// =========================================================

function model3Markov(
    history
) {

    if (
        history.length < 4
    ) {

        return {
            prediction: null,
            confidence: 50
        };
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
            history[i + 1]
                .ket_qua ===
            "TAI"
        ) {
            tai++;
        }

        if (
            history[i + 1]
                .ket_qua ===
            "XIU"
        ) {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const rate =
        tai / total;

    return {

        prediction:
            rate >= 0.5
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                (
                    50 +
                    Math.abs(
                        rate - 0.5
                    ) *
                    90
                ).toFixed(2)
            )
    };
}

// =========================================================
// MODEL 4
// PATTERN 5
// =========================================================

function model4Pattern5(
    history
) {

    if (
        history.length <
        COMPARE_PATTERN_LENGTH + 1
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const current =
        buildPattern(
            history,
            COMPARE_PATTERN_LENGTH
        );

    let tai = 0;

    let xiu = 0;

    for (
        let i = 0;

        i <=
        history.length -
        COMPARE_PATTERN_LENGTH -
        1;

        i++
    ) {

        const sample =
            history
                .slice(
                    i,
                    i +
                    COMPARE_PATTERN_LENGTH
                )
                .map(
                    item =>
                        toTX(
                            item.ket_qua
                        )
                )
                .join("");

        if (
            sample !== current
        ) {
            continue;
        }

        const next =
            history[
                i +
                COMPARE_PATTERN_LENGTH
            ];

        if (!next) {
            continue;
        }

        if (
            next.ket_qua ===
            "TAI"
        ) {
            tai++;
        }

        if (
            next.ket_qua ===
            "XIU"
        ) {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const rate =
        tai / total;

    return {

        prediction:
            rate >= 0.5
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                (
                    50 +
                    Math.abs(
                        rate - 0.5
                    ) *
                    90
                ).toFixed(2)
            )
    };
}

// =========================================================
// MODEL 5
// PATTERN 15
// =========================================================

function model5Pattern15(
    pattern,
    type
) {

    const memory =
        patternMemory[type];

    if (!memory.length) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    let tai = 0;

    let xiu = 0;

    let totalWeight = 0;

    for (
        const record of memory
    ) {

        const sample =
            record.pattern;

        let same = 0;

        for (
            let i = 0;
            i < PATTERN_LENGTH;
            i++
        ) {

            if (
                pattern[i] ===
                sample[i]
            ) {

                same++;
            }
        }

        const similarity =
            same /
            PATTERN_LENGTH;

        if (
            similarity < 0.5
        ) {
            continue;
        }

        const weight =
            similarity *
            similarity;

        if (
            record.next ===
            "TAI"
        ) {

            tai += weight;
        }

        if (
            record.next ===
            "XIU"
        ) {

            xiu += weight;
        }

        totalWeight +=
            weight;
    }

    if (
        totalWeight <= 0
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const rate =
        tai /
        totalWeight;

    return {

        prediction:
            rate >= 0.5
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                (
                    50 +
                    Math.abs(
                        rate - 0.5
                    ) *
                    90
                ).toFixed(2)
            )
    };
}

// =========================================================
// MODEL 6
// SIMILARITY
// =========================================================

function model6Similarity(
    pattern
) {

    const sample =
        findSamplePattern(
            pattern
        );

    if (!sample) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const last =
        sample.pattern[
            sample.pattern.length - 1
        ];

    return {

        prediction:
            last === "T"
                ? "XIU"
                : "TAI",

        confidence:
            Math.max(
                50,
                sample.score
            )
    };
}

// =========================================================
// MODEL 7
// RUN LENGTH
// =========================================================

function model7RunLength(
    history
) {

    if (
        history.length < 5
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const arr =
        history.map(
            item =>
                toTX(
                    item.ket_qua
                )
        );

    const last =
        arr[
            arr.length - 1
        ];

    let run = 0;

    for (
        let i = arr.length - 1;
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

    let samples = 0;

    for (
        let i = 0;
        i < arr.length - 1;
        i++
    ) {

        let length = 1;

        for (
            let j = i - 1;
            j >= 0;
            j--
        ) {

            if (
                arr[j] ===
                arr[i]
            ) {

                length++;

            } else {

                break;
            }
        }

        if (
            length !== run
        ) {
            continue;
        }

        const next =
            arr[i + 1];

        if (next === "T") {
            tai++;
        }

        if (next === "X") {
            xiu++;
        }

        samples++;
    }

    if (!samples) {

        return {

            prediction:
                last === "T"
                    ? "XIU"
                    : "TAI",

            confidence: 55
        };
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.abs(
                tai - xiu
            ) /
            samples
        ) * 45;

    return {

        prediction,

        confidence:
            Number(
                Math.min(
                    95,
                    confidence
                ).toFixed(2)
            )
    };
}

// =========================================================
// MODEL 8
// TRANSITION MATRIX
// =========================================================

function model8Transition(
    history
) {

    if (
        history.length < 5
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const arr =
        history.map(
            item =>
                toTX(
                    item.ket_qua
                )
        );

    let TT = 0;
    let TX = 0;
    let XT = 0;
    let XX = 0;

    for (
        let i = 1;
        i < arr.length;
        i++
    ) {

        const pair =
            arr[i - 1] +
            arr[i];

        if (pair === "TT") TT++;
        if (pair === "TX") TX++;
        if (pair === "XT") XT++;
        if (pair === "XX") XX++;
    }

    const last =
        arr[arr.length - 1];

    let tai;
    let xiu;

    if (last === "T") {

        tai = TT;
        xiu = TX;

    } else {

        tai = XT;
        xiu = XX;
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.abs(
                tai - xiu
            ) /
            total
        ) * 45;

    return {

        prediction,

        confidence:
            Number(
                Math.min(
                    95,
                    confidence
                ).toFixed(2)
            )
    };
}

// =========================================================
// MODEL 9
// WEIGHTED RECENCY
// =========================================================

function model9WeightedRecency(
    history
) {

    if (
        history.length < 5
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const recent =
        history.slice(-10);

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
        }

        if (
            recent[i].ket_qua ===
            "XIU"
        ) {

            xiu += weight;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    const confidence =
        50 +
        (
            Math.abs(
                tai - xiu
            ) /
            total
        ) * 45;

    return {

        prediction,

        confidence:
            Number(
                Math.min(
                    95,
                    confidence
                ).toFixed(2)
            )
    };
}

// =========================================================
// CHẠY 9 MODEL
// =========================================================

function runModels(
    history,
    pattern,
    type
) {

    return {

        model1:
            model1Streak(
                history
            ),

        model2:
            model2Alternating(
                pattern
            ),

        model3:
            model3Markov(
                history
            ),

        model4:
            model4Pattern5(
                history
            ),

        model5:
            model5Pattern15(
                pattern,
                type
            ),

        model6:
            model6Similarity(
                pattern
            ),

        model7:
            model7RunLength(
                history
            ),

        model8:
            model8Transition(
                history
            ),

        model9:
            model9WeightedRecency(
                history
            )
    };
}

// =========================================================
// AI TỰ HỌC
// =========================================================

function updateAI(
    type,
    models,
    actualResult
) {

    const memory =
        aiMemory[type];

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

        if (
            model.prediction ===
            actualResult
        ) {

            ai.win++;

            ai.weight += 0.05;

        } else {

            ai.loss++;

            ai.weight -= 0.03;
        }

        ai.weight =
            Math.max(
                0.2,
                Math.min(
                    5,
                    ai.weight
                )
            );
    }
}

// =========================================================
// TỔNG HỢP 9 MODEL
// =========================================================

function combineModels(
    models,
    type,
    patternMatch
) {

    const memory =
        aiMemory[type];

    let taiScore = 0;

    let xiuScore = 0;

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

            taiScore += score;

        } else if (
            model.prediction ===
            "XIU"
        ) {

            xiuScore += score;
        }
    }

    const total =
        taiScore + xiuScore;

    if (!total) {

        return {

            prediction:
                "TAI",

            confidence:
                50
        };
    }

    const prediction =
        taiScore >= xiuScore
            ? "TAI"
            : "XIU";

    const maxScore =
        Math.max(
            taiScore,
            xiuScore
        );

    const minScore =
        Math.min(
            taiScore,
            xiuScore
        );

    let confidence =
        50 +
        (
            (
                maxScore -
                minScore
            ) /
            total
        ) *
        45;

    // Pattern mẫu hỗ trợ
    if (
        patternMatch >= 90
    ) {

        confidence += 4;

    } else if (
        patternMatch >= 80
    ) {

        confidence += 3;

    } else if (
        patternMatch >= 60
    ) {

        confidence += 1.5;
    }

    confidence =
        Math.max(
            50,
            Math.min(
                97,
                confidence
            )
        );

    return {

        prediction,

        confidence:
            Number(
                confidence.toFixed(2)
            )
    };
}

// =========================================================
// PHÂN TÍCH
// =========================================================

function analyze(
    history,
    type
) {

    const pattern =
        buildPattern(
            history,
            PATTERN_LENGTH
        );

    const patternSoSanh =
        getComparePattern(
            pattern
        );

    const sample =
        findSamplePattern(
            pattern
        );

    const models =
        runModels(
            history,
            pattern,
            type
        );

    const result =
        combineModels(
            models,
            type,
            sample
                ? sample.score
                : 0
        );

    return {

        pattern,

        patternSoSanh,

        sample,

        models,

        result
    };
}

// =========================================================
// PROCESS API
// =========================================================

async function processAPI(
    sourceUrl,
    type
) {

    const json =
        await fetchSource(
            sourceUrl
        );

    const sessions =
        normalizeSessions(
            json
        );

    if (!sessions.length) {

        throw new Error(
            "API gốc không có dữ liệu hợp lệ"
        );
    }

    histories[type] =
        sessions.slice(
            -MAX_HISTORY
        );

    const history =
        histories[type];

    // -----------------------------------------------------
    // LƯU PATTERN
    // -----------------------------------------------------

    savePatternMemory(
        type,
        history
    );

    // -----------------------------------------------------
    // CẦN ĐỦ 15 PHIÊN
    // -----------------------------------------------------

    if (
        history.length <
        MIN_HISTORY
    ) {

        const latest =
            history[
                history.length - 1
            ];

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
                    history,
                    PATTERN_LENGTH
                ),

            du_doan:
                "Không rõ",

            do_tin_cay:
                "50%"
        };
    }

    // -----------------------------------------------------
    // LATEST
    // -----------------------------------------------------

    const latest =
        history[
            history.length - 1
        ];

    // -----------------------------------------------------
    // ANALYZE
    // -----------------------------------------------------

    const analysis =
        analyze(
            history,
            type
        );

    // -----------------------------------------------------
    // JSON PUBLIC CHỈ 8 FIELD
    // -----------------------------------------------------

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
            analysis.pattern,

        du_doan:
            displayResult(
                analysis.result
                    .prediction
            ),

        do_tin_cay:
            `${analysis.result.confidence}%`
    };
}

// =========================================================
// ENDPOINT TX
// =========================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    SOURCE_TX,
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
// ENDPOINT MD5
// =========================================================

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        try {

            const data =
                await processAPI(
                    SOURCE_MD5,
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
// HEALTH
// =========================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status:
                "online",

            service:
                "LC79 TX AI API",

            pattern:
                "15",

            compare:
                "5",

            models:
                9
        });
    }
);

// =========================================================
// START SERVER
// =========================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔══════════════════════════════════════════╗
║          LC79 TX AI API ONLINE           ║
╠══════════════════════════════════════════╣
║ PORT       : ${PORT}
║ TX         : /lc79/tx/hu
║ MD5        : /lc79/tx/md5
║ PATTERN    : 15 phiên
║ SO SÁNH    : 5 phiên cuối
║ MODELS     : 9
║ AI LEARN   : ON
╚══════════════════════════════════════════╝
`);
    }
);
