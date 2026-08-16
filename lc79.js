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

const aiMemory = {

    tx: {
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
        }
    },

    md5: {
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
        }
    }
};

// =========================================================
// PATTERN MẪU CHI TIẾT
// =========================================================

const PATTERN_MODELS = {

    // =====================================================
    // MODEL 1 - CẦU BỆT
    // =====================================================

    streak: [
        "TT",
        "TTT",
        "TTTT",
        "TTTTT",
        "TTTTTT",
        "TTTTTTT",

        "XX",
        "XXX",
        "XXXX",
        "XXXXX",
        "XXXXXX",
        "XXXXXXX"
    ],

    // =====================================================
    // MODEL 2 - CẦU 1-1
    // =====================================================

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
        "XTXTXTXTXTXT"
    ],

    // =====================================================
    // MODEL 3 - CẦU 2-2
    // =====================================================

    twoTwo: [
        "TTXX",
        "XXTT",

        "TTXXTTXX",
        "XXTTXXTT",

        "TTXXTTXXTT",
        "XXTTXXTTXX",

        "TTXXTTXXTTXX",
        "XXTTXXTTXXTT"
    ],

    // =====================================================
    // MODEL 4 - CẦU 1-2-1
    // =====================================================

    oneTwoOne: [
        "TXXT",
        "XTTX",

        "TXXTTXXT",
        "XTTXXTTX",

        "TXXTTXXTTXXT",
        "XTTXXTTXXTTX"
    ],

    // =====================================================
    // MODEL 5 - CẦU 2-1-2
    // =====================================================

    twoOneTwo: [
        "TTXTT",
        "XXTXX",

        "TTXTTXTT",
        "XXTXXTXX",

        "TTXTTXTTXTT",
        "XXTXXTXXTXX"
    ],

    // =====================================================
    // MODEL 6 - CẦU 3-1
    // =====================================================

    threeOne: [
        "TTTX",
        "XXXT",

        "TTTXTTTX",
        "XXXTXXXT",

        "TTTXTTTXTTTX",
        "XXXTXXXTXXXT"
    ],

    // =====================================================
    // CẦU 1-3
    // =====================================================

    oneThree: [
        "TXXX",
        "XTTT",

        "TXXXTXXX",
        "XTTTXTTT",

        "TXXXTXXXTXXX",
        "XTTTXTTTXTTT"
    ],

    // =====================================================
    // CẦU 2-3
    // =====================================================

    twoThree: [
        "TTXXX",
        "XXTTT",

        "TTXXXTTXXX",
        "XXTTTXXTTT",

        "TTXXXTTXXXTTXXX",
        "XXTTTXXTTTXXTTT"
    ],

    // =====================================================
    // CẦU ĐỐI XỨNG
    // =====================================================

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

    // =====================================================
    // CẦU GÃY
    // =====================================================

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

    // =====================================================
    // CẦU ĐẢO
    // =====================================================

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

    // =====================================================
    // CẦU HỖN HỢP
    // =====================================================

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
// HIỂN THỊ
// =========================================================

function displayResult(value) {

    if (value === "TAI") {
        return "Tài";
    }

    if (value === "XIU") {
        return "Xỉu";
    }

    if (value === "KHONG_RO") {
        return "Không rõ";
    }

    return value;
}

// =========================================================
// NORMALIZE RESULT
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
// FETCH
// =========================================================

async function fetchSource(url) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(() => {
            controller.abort();
        }, 10000);

    try {

        const response =
            await fetch(url, {

                headers: {
                    "Accept":
                        "application/json",

                    "User-Agent":
                        "LC79-TX-API/2.0"
                },

                signal:
                    controller.signal
            });

        if (!response.ok) {

            throw new Error(
                `Source API HTTP ${response.status}`
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
                    ? item.dices.map(Number)
                    : [];

            const point =
                Number(item.point);

            return {

                phien:
                    Number(item.id),

                xuc_xac:
                    dices,

                tong:
                    Number.isFinite(point)
                        ? point
                        : dices.reduce(
                            (a, b) =>
                                a + b,
                            0
                        ),

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

            item.ket_qua &&

            item.xuc_xac.length === 3

        )

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
    length = PATTERN_LENGTH
) {

    return history
        .slice(-length)
        .map(item =>
            toTX(item.ket_qua)
        )
        .join("");
}

// =========================================================
// SO SÁNH 5 PHIÊN CUỐI
// =========================================================

function getComparePattern(
    pattern
) {

    return pattern.slice(
        -COMPARE_PATTERN_LENGTH
    );
}

// =========================================================
// CHECK SAMPLE PATTERN
// =========================================================

function findSamplePattern(
    pattern
) {

    let best = null;

    let bestScore = 0;

    for (
        const group of
        Object.entries(PATTERN_MODELS)
    ) {

        const modelName =
            group[0];

        const patterns =
            group[1];

        for (
            const sample of patterns
        ) {

            const target =
                sample.slice(
                    -COMPARE_PATTERN_LENGTH
                );

            const current =
                pattern.slice(
                    -COMPARE_PATTERN_LENGTH
                );

            let same = 0;

            const length =
                Math.min(
                    target.length,
                    current.length
                );

            for (
                let i = 0;
                i < length;
                i++
            ) {

                if (
                    target[i] ===
                    current[i]
                ) {
                    same++;
                }
            }

            if (!length) {
                continue;
            }

            const score =
                (
                    same /
                    length
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
// SAVE PATTERN MEMORY
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
                    i + PATTERN_LENGTH
                )
                .map(item =>
                    toTX(item.ket_qua)
                )
                .join("");

        const next =
            history[
                i + PATTERN_LENGTH
            ];

        if (!next) {
            continue;
        }

        const record = {

            pattern,

            next:
                next.ket_qua,

            phien:
                next.phien
        };

        const duplicate =
            memory.some(item =>

                item.pattern ===
                    record.pattern &&

                item.next ===
                    record.next &&

                item.phien ===
                    record.phien
            );

        if (!duplicate) {

            memory.push(record);
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

    let count = 0;

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

            count++;

        } else {

            break;
        }
    }

    let confidence =
        55 +
        Math.min(
            count * 4,
            25
        );

    return {

        prediction:
            last,

        confidence:
            Number(
                confidence.toFixed(2)
            ),

        streak:
            count
    };
}

// =========================================================
// MODEL 2
// ALTERNATING
// =========================================================

function model2Alternating(
    pattern
) {

    const last6 =
        pattern.slice(-6);

    if (
        last6.length < 4
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    let alternating = true;

    for (
        let i = 1;
        i < last6.length;
        i++
    ) {

        if (
            last6[i] ===
            last6[i - 1]
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
        last6[
            last6.length - 1
        ];

    return {

        prediction:
            last === "T"
                ? "XIU"
                : "TAI",

        confidence:
            75
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
        history.length < 3
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
        i <
        history.length - 1;
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

    const taiRate =
        tai / total;

    return {

        prediction:
            taiRate >= 0.5
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                (
                    50 +
                    Math.abs(
                        taiRate -
                        0.5
                    ) *
                    100
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

    let count = 0;

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
                .map(item =>
                    toTX(item.ket_qua)
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

        count++;
    }

    if (!count) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const total =
        tai + xiu;

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
                        rate -
                        0.5
                    ) *
                    100
                ).toFixed(2)
            ),

        samples:
            count
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

    const current =
        pattern;

    let tai = 0;

    let xiu = 0;

    let totalWeight = 0;

    for (
        const record of memory
    ) {

        if (
            !record.pattern
        ) {
            continue;
        }

        let same = 0;

        for (
            let i = 0;
            i < PATTERN_LENGTH;
            i++
        ) {

            if (
                current[i] ===
                record.pattern[i]
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

        totalWeight += weight;
    }

    if (
        totalWeight <= 0
    ) {

        return {
            prediction: null,
            confidence: 50
        };
    }

    const taiRate =
        tai / totalWeight;

    return {

        prediction:
            taiRate >= 0.5
                ? "TAI"
                : "XIU",

        confidence:
            Number(
                (
                    50 +
                    Math.abs(
                        taiRate -
                        0.5
                    ) *
                    100
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

    let prediction =
        null;

    /*
     * Pattern mẫu không trực tiếp đảm bảo
     * kết quả tiếp theo.
     *
     * Ở đây dùng hướng của pattern:
     * nếu mẫu kết thúc T -> ưu tiên X
     * nếu mẫu kết thúc X -> ưu tiên T.
     */

    const last =
        sample.pattern[
            sample.pattern.length - 1
        ];

    if (last === "T") {

        prediction = "XIU";

    } else {

        prediction = "TAI";
    }

    return {

        prediction,

        confidence:
            Math.max(
                50,
                sample.score
            )
    };
}

// =========================================================
// CHẠY 6 MODEL
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
            )
    };
}

// =========================================================
// AI TỰ HỌC TRỌNG SỐ
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
// TỔNG HỢP 6 MODEL
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

    let totalWeight = 0;

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

        const weight =
            memory[name].weight;

        const confidence =
            model.confidence || 50;

        const score =
            weight *
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

        totalWeight +=
            weight;
    }

    if (
        totalWeight <= 0
    ) {

        return {

            prediction:
                "KHONG_RO",

            confidence:
                50,

            scores: {
                TAI: 50,
                XIU: 50
            }
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
            (
                maxScore +
                minScore
            )
        ) *
        45;

    if (
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
            ),

        scores: {

            TAI:
                Number(
                    taiScore.toFixed(2)
                ),

            XIU:
                Number(
                    xiuScore.toFixed(2)
                )
        }
    };
}

// =========================================================
// PHÂN TÍCH TOÀN BỘ
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
            patternSoSanh
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

    if (
        !sessions.length
    ) {

        throw new Error(
            "API gốc không trả về dữ liệu hợp lệ"
        );
    }

    histories[type] =
        sessions.slice(
            -MAX_HISTORY
        );

    const history =
        histories[type];

    // =====================================================
    // HỌC PATTERN
    // =====================================================

    savePatternMemory(
        type,
        history
    );

    // =====================================================
    // LATEST
    // =====================================================

    const latest =
        history[
            history.length - 1
        ];

    // =====================================================
    // PHÂN TÍCH
    // =====================================================

    const analysis =
        analyze(
            history,
            type
        );

    // =====================================================
    // JSON
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
            latest.phien + 1,

        // 15 phiên
        pattern:
            analysis.pattern,

        // 5 phiên cuối
        pattern_so_sanh:
            analysis.patternSoSanh,

        // Pattern mẫu
        pattern_mau:
            analysis.sample
                ? analysis.sample.pattern
                : null,

        pattern_model:
            analysis.sample
                ? analysis.sample.model
                : null,

        do_khop_pattern:
            `${
                analysis.sample
                    ? analysis.sample.score
                    : 0
            }%`,

        // =================================================
        // 6 MODEL
        // =================================================

        model_1:
            displayResult(
                analysis.models
                    .model1
                    .prediction
            ),

        model_2:
            displayResult(
                analysis.models
                    .model2
                    .prediction
            ),

        model_3:
            displayResult(
                analysis.models
                    .model3
                    .prediction
            ),

        model_4:
            displayResult(
                analysis.models
                    .model4
                    .prediction
            ),

        model_5:
            displayResult(
                analysis.models
                    .model5
                    .prediction
            ),

        model_6:
            displayResult(
                analysis.models
                    .model6
                    .prediction
            ),

        // =================================================
        // KẾT QUẢ
        // =================================================

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
// TX
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
                "[TX ERROR]",
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
// MD5
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
                "[MD5 ERROR]",
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
// XEM PATTERN MEMORY
// =========================================================

app.get(
    "/lc79/tx/patterns",
    (req, res) => {

        res.json({

            tx:
                patternMemory.tx,

            md5:
                patternMemory.md5,

            max:
                MAX_PATTERN_MEMORY,

            pattern_length:
                PATTERN_LENGTH,

            compare_length:
                COMPARE_PATTERN_LENGTH
        });
    }
);

// =========================================================
// XEM AI MODEL WEIGHT
// =========================================================

app.get(
    "/lc79/tx/models",
    (req, res) => {

        res.json({

            tx:
                aiMemory.tx,

            md5:
                aiMemory.md5,

            models: {

                model_1:
                    "Streak",

                model_2:
                    "Alternating",

                model_3:
                    "Markov",

                model_4:
                    "Pattern 5",

                model_5:
                    "Pattern 15",

                model_6:
                    "Similarity"
            }
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

            service:
                "LC79 TX AI API",

            endpoints: [

                "/lc79/tx/hu",

                "/lc79/tx/md5",

                "/lc79/tx/patterns",

                "/lc79/tx/models"
            ],

            pattern:
                "15 phiên",

            compare:
                "5 phiên",

            memory:
                "15 pattern",

            models:
                6,

            ai_learning:
                true
        });
    }
);

// =========================================================
// START
// =========================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(`
╔══════════════════════════════════════════╗
║          LC79 TX AI API ONLINE           ║
╠══════════════════════════════════════════╣
║ PORT          : ${PORT}
║ TX            : /lc79/tx/hu
║ MD5           : /lc79/tx/md5
║ PATTERN       : 15 phiên
║ SO SÁNH       : 5 phiên cuối
║ MEMORY        : 15 pattern
║ MODELS        : 1 → 6
║ AI LEARNING   : ON
║ HISTORY       : ${MAX_HISTORY}
╚══════════════════════════════════════════╝
`);
    }
);
