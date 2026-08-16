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

const PATTERN_LENGTH = 5;

const MAX_PATTERN_HISTORY = 15;

const MIN_HISTORY = 5;

// =========================================================
// HISTORY
// =========================================================

const histories = {
    tx: [],
    md5: []
};

// =========================================================
// AI PATTERN MEMORY
//
// Mỗi pattern:
//
// {
//     pattern: "TTTXT",
//     next: "TAI",
//     phien: 123456
// }
//
// Pattern 5 phiên -> kết quả phiên tiếp theo
// =========================================================

const patternHistories = {
    tx: [],
    md5: []
};

// =========================================================
// 60 PATTERN MẪU
// =========================================================

const PATTERN_MAU = [

    "T",
    "X",

    "TT",
    "TX",
    "XT",
    "XX",

    "TTT",
    "TTX",
    "TXT",
    "TXX",
    "XTT",
    "XTX",
    "XXT",
    "XXX",

    "TTTT",
    "TTTX",
    "TTXT",
    "TTXX",
    "TXTT",
    "TXTX",
    "TXXT",
    "TXXX",
    "XTTT",
    "XTTX",
    "XTXT",
    "XTXX",
    "XXTT",
    "XXTX",
    "XXXT",
    "XXXX",

    "TTTTT",
    "TTTTX",
    "TTTXT",
    "TTTXX",
    "TTXTT",
    "TTXTX",
    "TTXXT",
    "TTXXX",
    "TXTTT",
    "TXTTX",
    "TXTXT",
    "TXTXX",
    "TXXTT",
    "TXXTX",
    "TXXXT",
    "TXXXX",

    "XTTTT",
    "XTTTX",
    "XTTXT",
    "XTTXX",
    "XTXTT",
    "XTXTX",
    "XTXXT",
    "XTXXX",
    "XXTTT",
    "XXTTX",
    "XXTXT",
    "XXXTT"
];

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

    if (value === "KHONG_RO") {
        return "Không rõ";
    }

    return value;
}

// =========================================================
// FETCH API GỐC
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

                method: "GET",

                headers: {
                    "Accept":
                        "application/json",

                    "User-Agent":
                        "LC79-TX-API/1.0"
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
// CHUẨN HÓA KẾT QUẢ
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
// TÀI/XỈU -> T/X
// =========================================================

function toTX(value) {

    return normalizeResult(value) === "TAI"
        ? "T"
        : "X";
}

// =========================================================
// API GỐC -> FORMAT CHUẨN
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

            item.ket_qua &&

            Array.isArray(
                item.xuc_xac
            )

        )

        .sort(
            (a, b) =>
                a.phien - b.phien
        );
}

// =========================================================
// BUILD PATTERN
//
// Chỉ lấy 5 phiên gần nhất
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
// LƯU PATTERN 5 PHIÊN -> KẾT QUẢ PHIÊN SAU
// =========================================================

function learnPatternHistory(
    type,
    history
) {

    const memory =
        patternHistories[type];

    if (
        history.length <
        PATTERN_LENGTH + 1
    ) {
        return;
    }

    /*
     * Duyệt toàn bộ lịch sử.
     *
     * Ví dụ:
     *
     * T T X X T -> X
     *
     * Pattern = TTXTX
     * Next    = Xỉu
     */

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

        const nextResult =
            normalizeResult(
                next.ket_qua
            );

        if (!nextResult) {
            continue;
        }

        const record = {

            pattern,

            next:
                nextResult,

            phien:
                next.phien
        };

        /*
         * Không lưu trùng cùng pattern
         * + kết quả liên tiếp.
         */

        const duplicate =
            memory.some(item =>
                item.pattern ===
                    record.pattern &&
                item.next ===
                    record.next &&
                item.phien ===
                    record.phien
            );

        if (duplicate) {
            continue;
        }

        memory.push(record);
    }

    // =====================================================
    // CHỈ GIỮ 15 PATTERN GẦN NHẤT
    // =====================================================

    if (
        memory.length >
        MAX_PATTERN_HISTORY
    ) {

        memory.splice(
            0,
            memory.length -
                MAX_PATTERN_HISTORY
        );
    }
}

// =========================================================
// SO SÁNH PATTERN HIỆN TẠI VỚI 15 PATTERN ĐÃ LƯU
// =========================================================

function comparePatternHistory(
    currentPattern,
    type
) {

    const memory =
        patternHistories[type];

    if (!memory.length) {

        return {

            pattern_mau:
                null,

            do_khop:
                0,

            du_doan_mau:
                null,

            mau_count:
                0
        };
    }

    let bestPattern = null;

    let bestScore = 0;

    let bestPrediction = null;

    let bestCount = 0;

    // =====================================================
    // SO SÁNH 15 PATTERN
    // =====================================================

    for (
        const record of memory
    ) {

        if (
            !record.pattern ||
            record.pattern.length !==
                PATTERN_LENGTH
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
                currentPattern[i] ===
                record.pattern[i]
            ) {

                same++;
            }
        }

        const score =
            (
                same /
                PATTERN_LENGTH
            ) * 100;

        if (
            score > bestScore
        ) {

            bestScore =
                score;

            bestPattern =
                record.pattern;

            bestPrediction =
                record.next;

            bestCount = 1;

        } else if (
            score === bestScore
        ) {

            bestCount++;

        }
    }

    return {

        pattern_mau:
            bestPattern,

        do_khop:
            Number(
                bestScore.toFixed(2)
            ),

        du_doan_mau:
            bestPrediction,

        mau_count:
            bestCount
    };
}

// =========================================================
// AI HỌC 15 PATTERN
// =========================================================

function learnedPatternScore(
    currentPattern,
    type
) {

    const memory =
        patternHistories[type];

    let tai = 0;

    let xiu = 0;

    let matched = 0;

    // =====================================================
    // ƯU TIÊN PATTERN KHỚP HOÀN TOÀN
    // =====================================================

    for (
        const record of memory
    ) {

        if (
            record.pattern ===
            currentPattern
        ) {

            matched++;

            if (
                record.next ===
                "TAI"
            ) {

                tai++;
            }

            if (
                record.next ===
                "XIU"
            ) {

                xiu++;
            }
        }
    }

    if (matched > 0) {

        const total =
            tai + xiu;

        return {

            tai:
                (tai / total) *
                100,

            xiu:
                (xiu / total) *
                100,

            matched,

            exact: true
        };
    }

    // =====================================================
    // KHÔNG CÓ EXACT MATCH
    // -> DÙNG PATTERN GẦN NHẤT
    // =====================================================

    let weightedTai = 0;

    let weightedXiu = 0;

    let weightTotal = 0;

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
                currentPattern[i] ===
                record.pattern[i]
            ) {

                same++;
            }
        }

        const similarity =
            same /
            PATTERN_LENGTH;

        if (
            similarity < 0.4
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

            weightedTai +=
                weight;
        }

        if (
            record.next ===
            "XIU"
        ) {

            weightedXiu +=
                weight;
        }

        weightTotal +=
            weight;
    }

    if (
        weightTotal <= 0
    ) {

        return {

            tai: 50,

            xiu: 50,

            matched: 0,

            exact: false
        };
    }

    return {

        tai:
            (
                weightedTai /
                weightTotal
            ) * 100,

        xiu:
            (
                weightedXiu /
                weightTotal
            ) * 100,

        matched:
            memory.length,

        exact: false
    };
}

// =========================================================
// PHÂN PHỐI TÀI/XỈU
// =========================================================

function distributionScore(
    history
) {

    if (!history.length) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    let tai = 0;

    let xiu = 0;

    for (
        const item of
        history.slice(-20)
    ) {

        if (
            item.ket_qua ===
            "TAI"
        ) {

            tai++;
        }

        if (
            item.ket_qua ===
            "XIU"
        ) {

            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {

        return {
            tai: 50,
            xiu: 50
        };
    }

    return {

        tai:
            (
                tai /
                total
            ) * 100,

        xiu:
            (
                xiu /
                total
            ) * 100
    };
}

// =========================================================
// MARKOV
// =========================================================

function markovScore(
    history
) {

    if (
        history.length < 2
    ) {

        return {
            tai: 50,
            xiu: 50
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
            tai: 50,
            xiu: 50
        };
    }

    return {

        tai:
            (
                tai /
                total
            ) * 100,

        xiu:
            (
                xiu /
                total
            ) * 100
    };
}

// =========================================================
// PHÂN TÍCH STREAK
// =========================================================

function analyzeStreak(
    history
) {

    if (!history.length) {

        return {
            tai: 50,
            xiu: 50
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

    let tai = 50;

    let xiu = 50;

    if (
        last === "TAI"
    ) {

        tai +=
            Math.min(
                streak * 3,
                12
            );

        xiu -=
            Math.min(
                streak * 3,
                12
            );

    } else {

        xiu +=
            Math.min(
                streak * 3,
                12
            );

        tai -=
            Math.min(
                streak * 3,
                12
            );
    }

    return {

        tai,

        xiu
    };
}

// =========================================================
// ĐỘ TIN CẬY
// =========================================================

function calculateConfidence(
    tai,
    xiu,
    patternMatch
) {

    const difference =
        Math.abs(
            tai - xiu
        );

    let confidence =
        50 +
        difference * 0.65;

    // =====================================================
    // BONUS KHI PATTERN KHỚP CAO
    // =====================================================

    if (
        patternMatch >= 80
    ) {

        confidence += 5;

    } else if (
        patternMatch >= 60
    ) {

        confidence += 3;
    }

    confidence =
        Math.max(
            50,
            Math.min(
                97,
                confidence
            )
        );

    return Number(
        confidence.toFixed(2)
    );
}

// =========================================================
// AI PHÂN TÍCH
// =========================================================

function analyzeAI(
    history,
    type
) {

    if (
        history.length <
        MIN_HISTORY
    ) {

        return {

            prediction:
                "KHONG_RO",

            confidence:
                50,

            pattern:
                buildPattern(
                    history
                ),

            pattern_mau:
                null,

            do_khop:
                0,

            learned:
                {
                    tai: 50,
                    xiu: 50
                }
        };
    }

    // =====================================================
    // PATTERN 5 PHIÊN
    // =====================================================

    const pattern =
        buildPattern(
            history,
            PATTERN_LENGTH
        );

    // =====================================================
    // SO SÁNH PATTERN 15
    // =====================================================

    const patternAnalysis =
        comparePatternHistory(
            pattern,
            type
        );

    // =====================================================
    // AI HỌC PATTERN
    // =====================================================

    const learned =
        learnedPatternScore(
            pattern,
            type
        );

    // =====================================================
    // THỐNG KÊ
    // =====================================================

    const distribution =
        distributionScore(
            history
        );

    const markov =
        markovScore(
            history
        );

    const streak =
        analyzeStreak(
            history
        );

    // =====================================================
    // TRỌNG SỐ
    //
    // Pattern AI : 40%
    // Markov     : 25%
    // Phân phối  : 20%
    // Streak     : 15%
    // =====================================================

    const tai =

        learned.tai * 0.40 +

        markov.tai * 0.25 +

        distribution.tai * 0.20 +

        streak.tai * 0.15;

    const xiu =

        learned.xiu * 0.40 +

        markov.xiu * 0.25 +

        distribution.xiu * 0.20 +

        streak.xiu * 0.15;

    // =====================================================
    // DỰ ĐOÁN
    // =====================================================

    const prediction =
        tai >= xiu
            ? "TAI"
            : "XIU";

    // =====================================================
    // CONFIDENCE
    // =====================================================

    const confidence =
        calculateConfidence(
            tai,
            xiu,
            patternAnalysis.do_khop
        );

    return {

        prediction,

        confidence,

        pattern,

        pattern_mau:
            patternAnalysis.pattern_mau,

        do_khop:
            patternAnalysis.do_khop,

        du_doan_mau:
            patternAnalysis.du_doan_mau,

        mau_count:
            patternAnalysis.mau_count,

        learned,

        scores: {

            TAI:
                Number(
                    tai.toFixed(2)
                ),

            XIU:
                Number(
                    xiu.toFixed(2)
                )
        }
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

    // =====================================================
    // LƯU 100 PHIÊN
    // =====================================================

    histories[type] =
        sessions.slice(
            -MAX_HISTORY
        );

    const history =
        histories[type];

    // =====================================================
    // HỌC PATTERN
    // =====================================================

    learnPatternHistory(
        type,
        history
    );

    // =====================================================
    // PHIÊN MỚI NHẤT
    // =====================================================

    const latest =
        history[
            history.length - 1
        ];

    // =====================================================
    // AI
    // =====================================================

    const analysis =
        analyzeAI(
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

        // 5 phiên gần nhất
        pattern:
            analysis.pattern,

        // Pattern mẫu khớp nhất
        pattern_mau:
            analysis.pattern_mau,

        // Độ khớp pattern
        do_khop_pattern:
            `${analysis.do_khop}%`,

        // Dự đoán
        du_doan:
            displayResult(
                analysis.prediction
            ),

        // Độ tin cậy
        do_tin_cay:
            `${analysis.confidence.toFixed(2)}%`
    };
}

// =========================================================
// API TX
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
// API MD5
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
// XEM PATTERN ĐÃ HỌC
// =========================================================

app.get(
    "/lc79/tx/patterns",
    (req, res) => {

        res.json({

            tx:
                patternHistories.tx,

            md5:
                patternHistories.md5,

            max:
                MAX_PATTERN_HISTORY,

            length:
                PATTERN_LENGTH
        });
    }
);

// =========================================================
// HEALTH CHECK
// =========================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status:
                "online",

            service:
                "LC79 TX API",

            endpoints: [

                "/lc79/tx/hu",

                "/lc79/tx/md5",

                "/lc79/tx/patterns"
            ],

            pattern_length:
                PATTERN_LENGTH,

            pattern_memory:
                MAX_PATTERN_HISTORY,

            pattern_samples:
                PATTERN_MAU.length,

            history:
                MAX_HISTORY,

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
║            LC79 TX API ONLINE            ║
╠══════════════════════════════════════════╣
║ PORT          : ${PORT}
║ TX            : /lc79/tx/hu
║ MD5           : /lc79/tx/md5
║ PATTERN       : 5 phiên
║ MEMORY        : 15 pattern
║ SAMPLE        : ${PATTERN_MAU.length} pattern mẫu
║ AI LEARNING   : ON
║ HISTORY       : ${MAX_HISTORY} phiên
╚══════════════════════════════════════════╝
`);
    }
);
