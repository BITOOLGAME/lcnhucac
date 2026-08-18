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
const COMPARE_MIN = 10;

const MAX_SOURCE_HISTORY = 200;
const MAX_PATTERN_MEMORY = 5000;
const MAX_HISTORY = 100;

// =====================================================
// DATA
// =====================================================

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

const AI_FILE =
    path.join(DATA_DIR, "pattern-ai.json");

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
        console.error("[JSON LOAD]", error.message);
        return fallback;
    }
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(data, null, 2),
            "utf8"
        );
    } catch (error) {
        console.error("[JSON SAVE]", error.message);
    }
}

const savedAI =
    loadJSON(AI_FILE, {
        hu: {},
        md5: {}
    });

const savedHistory =
    loadJSON(HISTORY_FILE, {
        hu: [],
        md5: []
    });

const patternMemory = {
    hu: savedAI.hu || {},
    md5: savedAI.md5 || {}
};

const evaluationHistory = {
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

const pendingPredictions = {
    hu: new Map(),
    md5: new Map()
};

const sseClients = {
    hu: new Set(),
    md5: new Set()
};

// =====================================================
// RESULT
// =====================================================

function normalizeResult(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const v = String(value)
        .trim()
        .toUpperCase();

    if (v === "TAI" || v === "TÀI") {
        return "TAI";
    }

    if (v === "XIU" || v === "XỈU") {
        return "XIU";
    }

    return null;
}

function displayResult(value) {
    const result = normalizeResult(value);

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

// =====================================================
// UTILITY
// =====================================================

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function validPattern(pattern) {
    return (
        typeof pattern === "string" &&
        pattern.length === PATTERN_LENGTH &&
        /^[TX]+$/.test(pattern)
    );
}

// =====================================================
// FETCH SOURCE
// =====================================================

async function fetchSource(type) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 10000);

    try {
        const response = await fetch(
            SOURCE_API[type],
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    "User-Agent":
                        "LC79-Pattern-AI/1.0"
                },
                signal: controller.signal
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

// =====================================================
// NORMALIZE API
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

            let point = Number(item.point);

            if (!Number.isFinite(point)) {
                point = dices.reduce(
                    (a, b) => a + b,
                    0
                );
            }

            return {
                phien: Number(item.id),
                xuc_xac: dices,
                tong: point,
                ket_qua:
                    normalizeResult(
                        item.resultTruyenThong
                    )
            };
        })
        .filter(item => {

            return (
                Number.isFinite(item.phien) &&
                item.xuc_xac.length === 3 &&
                item.ket_qua
            );
        })
        .sort(
            (a, b) =>
                a.phien - b.phien
        );
}

// =====================================================
// PATTERN
// =====================================================

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

function comparePattern(main, sample) {
    if (
        !validPattern(main) ||
        !validPattern(sample)
    ) {
        return {
            same: 0,
            similarity: 0
        };
    }

    let same = 0;

    for (
        let i = 0;
        i < PATTERN_LENGTH;
        i++
    ) {
        if (main[i] === sample[i]) {
            same++;
        }
    }

    return {
        same,
        similarity:
            (same / PATTERN_LENGTH) * 100
    };
}

function positionWeight(index) {
    return (
        0.75 +
        (
            index /
            (PATTERN_LENGTH - 1)
        ) * 0.75
    );
}

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
        if (main[i] === sample[i]) {
            score += positionWeight(i);
        }
    }

    return score;
}

// =====================================================
// PATTERN MẪU
// =====================================================

function generateRunPattern(
    a,
    b,
    first
) {
    let pattern = "";
    let current = first;

    while (
        pattern.length <
        PATTERN_LENGTH
    ) {
        const count =
            current === first
                ? a
                : b;

        pattern +=
            current.repeat(count);

        current =
            current === "T"
                ? "X"
                : "T";
    }

    return pattern.slice(
        0,
        PATTERN_LENGTH
    );
}

function generatePatternSamples() {

    const samples = new Set();

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

    const predefined = [
        "TXTXTXTXTXTXTXT",
        "XTXTXTXTXTXTXTX",

        "TTXXTTXXTTXXTTX",
        "XXTTXXTTXXTTXXT",

        "TXXTTXXTTXXTTXX",
        "XTTXXTTXXTTXXTT",

        "TTXTTXTTXTTXTTX",
        "XXTXXTXXTXXTXXT",

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

        "TTXXTTTXXTTXXTX",
        "XXTTXXXTTXXTTXT",

        "TTTXXXTTTXXXTTT",
        "XXXTTTXXXTTTXXX",

        "TTTTXXXXTTTTXXX",
        "XXXXTTTTXXXXTTT",

        "TTXXXXTTTTXXTTT",
        "XXTTTTXXXXTTXXX",

        "TXTTXTTXTTXTTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTXTTXTXTTXTX",
        "XXTXTXTXTXTXTXT",

        "TXXTXXTXXTXXTXX",
        "XTTXTTXTTXTTXTT",

        "TTXTTXXXTTXTTXX",
        "XXTXXTTTXTTXXTT",

        "TTTTTTTTTTTTTTX",
        "XXXXXXXXXXXXXXT"
    ];

    for (const pattern of predefined) {
        if (validPattern(pattern)) {
            samples.add(pattern);
        }
    }

    return [...samples];
}

const PATTERN_SAMPLES =
    generatePatternSamples();

// =====================================================
// STATIC SAMPLE PREDICTION
// =====================================================

function oppositeTX(value) {
    return value === "T"
        ? "X"
        : "T";
}

function getStaticPrediction(pattern) {

    const last =
        pattern[
            pattern.length - 1
        ];

    const last3 =
        pattern.slice(-3);

    if (
        last3 === "TTT" ||
        last3 === "XXX"
    ) {
        return oppositeTX(last);
    }

    return oppositeTX(last);
}

const STATIC_SAMPLES =
    PATTERN_SAMPLES.map(
        pattern => ({
            pattern,
            prediction:
                getStaticPrediction(
                    pattern
                ) === "T"
                    ? "TAI"
                    : "XIU"
        })
    );

// =====================================================
// AI MEMORY
// =====================================================

function getMemory(
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

function trimMemory(type) {

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
        (a, b) =>
            (
                patternMemory[type][a]
                    .total || 0
            ) -
            (
                patternMemory[type][b]
                    .total || 0
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
        delete patternMemory[type][
            keys[i]
        ];
    }
}

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
        let i = PATTERN_LENGTH;
        i < history.length;
        i++
    ) {

        const window =
            history.slice(
                i - PATTERN_LENGTH,
                i
            );

        const pattern =
            buildPattern(window);

        const next =
            history[i].ket_qua;

        if (
            !validPattern(pattern) ||
            !next
        ) {
            continue;
        }

        const memory =
            getMemory(
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

        const rate =
            Math.max(
                memory.tai,
                memory.xiu
            ) /
            memory.total;

        memory.weight =
            clamp(
                0.5 + rate,
                0.5,
                1.8
            );
    }

    trimMemory(type);

    saveJSON(
        AI_FILE,
        patternMemory
    );
}

// =====================================================
// FIND MATCHES
// =====================================================

function findMatches(
    type,
    mainPattern
) {

    const matches = [];

    // Learned patterns
    for (
        const item of Object.values(
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

        let prediction = null;

        if (item.tai > item.xiu) {
            prediction = "TAI";
        }

        if (item.xiu > item.tai) {
            prediction = "XIU";
        }

        if (!prediction) {
            continue;
        }

        const baseScore =
            calculatePatternScore(
                mainPattern,
                item.pattern
            );

        const rate =
            item.total > 0
                ? Math.max(
                    item.tai,
                    item.xiu
                ) / item.total
                : 0.5;

        const score =
            baseScore *
            (Number(item.weight) || 1) *
            (0.75 + rate * 0.5);

        matches.push({
            source: "ai",
            pattern: item.pattern,
            prediction,
            same: compare.same,
            similarity:
                Number(
                    compare.similarity
                        .toFixed(2)
                ),
            score:
                Number(
                    score.toFixed(4)
                ),
            weight:
                Number(item.weight) || 1,
            occurrences:
                item.total || 0,
            wins:
                item.wins || 0,
            losses:
                item.losses || 0
        });
    }

    // Static patterns
    for (
        const item of STATIC_SAMPLES
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

        matches.push({
            source: "sample",
            pattern: item.pattern,
            prediction: item.prediction,
            same: compare.same,
            similarity:
                Number(
                    compare.similarity
                        .toFixed(2)
                ),
            score:
                Number(
                    (
                        baseScore *
                        0.65
                    ).toFixed(4)
                ),
            weight: 0.65,
            occurrences: 0,
            wins: 0,
            losses: 0
        });
    }

    matches.sort(
        (a, b) =>
            b.score -
            a.score
    );

    return matches;
}

// =====================================================
// PREDICTION
// =====================================================

function predict(
    type,
    pattern
) {

    const matches =
        findMatches(
            type,
            pattern
        );

    if (!matches.length) {
        return {
            prediction: null,
            confidence: 50,
            taiScore: 0,
            xiuScore: 0,
            matches: []
        };
    }

    const best =
        matches.slice(0, 100);

    let taiScore = 0;
    let xiuScore = 0;

    for (const item of best) {

        if (
            item.prediction ===
            "TAI"
        ) {
            taiScore += item.score;
        } else {
            xiuScore += item.score;
        }
    }

    const total =
        taiScore +
        xiuScore;

    if (!total) {
        return {
            prediction: null,
            confidence: 50,
            taiScore,
            xiuScore,
            matches: best
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

    const difference =
        (winner - loser) /
        total;

    const bestSimilarity =
        best[0]?.similarity || 0;

    let confidence =
        50 +
        difference * 35 +
        (bestSimilarity / 100) * 12;

    const consensus =
        best.filter(
            item =>
                item.prediction ===
                prediction
        ).length;

    if (consensus >= 5) {
        confidence += 2;
    }

    if (consensus >= 10) {
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
        taiScore:
            Number(
                taiScore.toFixed(4)
            ),
        xiuScore:
            Number(
                xiuScore.toFixed(4)
            ),
        matches: best
    };
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
            displayResult(prediction),
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

    if (
        evaluationHistory[type]
            .some(
                item =>
                    item.phien ===
                    phien
            )
    ) {
        return false;
    }

    evaluationHistory[type]
        .unshift(
            createPending(
                phien,
                prediction
            )
        );

    if (
        evaluationHistory[type]
            .length >
        MAX_HISTORY
    ) {
        evaluationHistory[type]
            .splice(
                MAX_HISTORY
            );
    }

    saveJSON(
        HISTORY_FILE,
        evaluationHistory
    );

    return true;
}

// =====================================================
// SETTLE
// =====================================================

function settle(
    type,
    session
) {

    const item =
        evaluationHistory[type]
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

    const win =
        prediction ===
        session.ket_qua;

    item.danh_gia =
        win
            ? "✅ Thắng"
            : "❌ Thua";

    const pending =
        pendingPredictions[type]
            .get(
                session.phien
            );

    if (pending) {

        for (
            const match
            of pending.matches
        ) {

            if (
                match.source !==
                "ai"
            ) {
                continue;
            }

            const memory =
                patternMemory[type][
                    match.pattern
                ];

            if (!memory) {
                continue;
            }

            memory.total++;

            if (
                match.prediction ===
                session.ket_qua
            ) {

                memory.wins++;

                memory.weight =
                    clamp(
                        memory.weight +
                        0.08,
                        0.2,
                        3
                    );

            } else {

                memory.losses++;

                memory.weight =
                    clamp(
                        memory.weight -
                        0.05,
                        0.2,
                        3
                    );
            }
        }

        pendingPredictions[type]
            .delete(
                session.phien
            );

        saveJSON(
            AI_FILE,
            patternMemory
        );
    }

    saveJSON(
        HISTORY_FILE,
        evaluationHistory
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
        `data: ${JSON.stringify(data)}\n\n`;

    for (
        const client
        of sseClients[type]
    ) {

        try {
            client.write(message);
        } catch {
            sseClients[type]
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

    sseClients[type]
        .add(res);

    // Gửi history ngay lập tức
    res.write(
        "event: history\n"
    );

    res.write(
        `data: ${JSON.stringify(
            evaluationHistory[type]
        )}\n\n`
    );

    const heartbeat =
        setInterval(() => {

            try {
                res.write(
                    ": heartbeat\n\n"
                );
            } catch {
                clearInterval(
                    heartbeat
                );
            }

        }, 15000);

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

// =====================================================
// PROCESS
// =====================================================

async function processType(type) {

    try {

        const json =
            await fetchSource(type);

        const sessions =
            normalizeSessions(json);

        if (!sessions.length) {
            throw new Error(
                "API gốc không trả dữ liệu"
            );
        }

        const oldHistory =
            sourceHistory[type];

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

        // ---------------------------------------------
        // Đánh giá các phiên đã có kết quả
        // ---------------------------------------------

        let historyChanged = false;

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
                historyChanged = true;
            }
        }

        // ---------------------------------------------
        // AI học dữ liệu lịch sử
        // ---------------------------------------------

        learnHistoricalPatterns(
            type,
            sourceHistory[type]
        );

        // ---------------------------------------------
        // Cần đủ 15 phiên
        // ---------------------------------------------

        if (
            sourceHistory[type].length <
            PATTERN_LENGTH
        ) {
            return null;
        }

        const latest =
            sourceHistory[type][
                sourceHistory[type].length - 1
            ];

        const pattern =
            buildPattern(
                sourceHistory[type]
            );

        const result =
            predict(
                type,
                pattern
            );

        const nextPhien =
            latest.phien + 1;

        // ---------------------------------------------
        // Tạo prediction mới
        // ---------------------------------------------

        if (
            result.prediction
        ) {

            if (
                !pendingPredictions[type]
                    .has(nextPhien)
            ) {

                pendingPredictions[type]
                    .set(
                        nextPhien,
                        {
                            pattern,
                            prediction:
                                result.prediction,
                            matches:
                                result.matches
                        }
                    );
            }

            if (
                addHistory(
                    type,
                    nextPhien,
                    result.prediction
                )
            ) {

                historyChanged = true;
            }
        }

        // ---------------------------------------------
        // Nếu phiên mới xuất hiện
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

            historyChanged = true;
        }

        // ---------------------------------------------
        // Gửi toàn bộ history realtime
        // ---------------------------------------------

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
                result.prediction
                    ? displayResult(
                        result.prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                `${result.confidence.toFixed(2)}%`
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
// MAIN API
// =====================================================

app.get(
    "/lc79/tx/hu",
    async (req, res) => {

        const result =
            await processType("hu");

        if (!result) {

            return res.status(502).json({
                error: true,
                message:
                    "Không lấy được dữ liệu API gốc"
            });
        }

        res.json(result);
    }
);

app.get(
    "/lc79/tx/md5",
    async (req, res) => {

        const result =
            await processType("md5");

        if (!result) {

            return res.status(502).json({
                error: true,
                message:
                    "Không lấy được dữ liệu API gốc"
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
            evaluationHistory.hu
        );
    }
);

app.get(
    "/api/lc79/md5/history",
    (req, res) => {

        res.json(
            evaluationHistory.md5
        );
    }
);

// =====================================================
// REALTIME HISTORY SSE
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
// PATTERN SAMPLE
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
// PATTERN MEMORY
// =====================================================

app.get(
    "/api/lc79/pattern-memory",
    (req, res) => {

        res.json({
            hu:
                Object.values(
                    patternMemory.hu
                ),

            md5:
                Object.values(
                    patternMemory.md5
                )
        });
    }
);

// =====================================================
// ANALYZE
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

            return res.status(400).json({
                error: true,
                message:
                    `Pattern phải đúng ${PATTERN_LENGTH} ký tự T/X`,
                example:
                    "TTXTTXXTXTTXXTX"
            });
        }

        const result =
            predict(
                type,
                pattern
            );

        res.json({

            pattern,

            du_doan:
                result.prediction
                    ? displayResult(
                        result.prediction
                    )
                    : "Không rõ",

            do_tin_cay:
                `${result.confidence.toFixed(2)}%`,

            tai_score:
                result.taiScore,

            xiu_score:
                result.xiuScore,

            matches:
                result.matches.slice(
                    0,
                    50
                )
        });
    }
);

// =====================================================
// RESET AI
// =====================================================

app.post(
    "/api/lc79/pattern-memory/reset",
    (req, res) => {

        patternMemory.hu = {};
        patternMemory.md5 = {};

        saveJSON(
            AI_FILE,
            patternMemory
        );

        res.json({
            success: true,
            message:
                "Đã reset toàn bộ AI Pattern"
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

            status: "online",

            version:
                "LC79 Pattern AI 6.0",

            algorithm:
                "MAIN PATTERN 15",

            pattern_length:
                PATTERN_LENGTH,

            compare_min:
                COMPARE_MIN,

            pattern_samples:
                PATTERN_SAMPLES.length,

            realtime:
                "SSE",

            poll:
                "3000ms",

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

                memory:
                    "/api/lc79/pattern-memory",

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

        res.status(404).json({
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
╔════════════════════════════════════════════════════╗
║              LC79 PATTERN AI 6.0                  ║
╠════════════════════════════════════════════════════╣
║ Pattern chính : 15 phiên                          ║
║ Pattern mẫu   : ${PATTERN_SAMPLES.length}                             ║
║ So sánh       : >= ${COMPARE_MIN}/15                           ║
║ AI Learning   : ON                                ║
║ SSE History   : ON                                ║
║ Polling       : 3 giây                            ║
║ Realtime      : KHÔNG CẦN F5                     ║
╚════════════════════════════════════════════════════╝
`);
    }
);

// =====================================================
// AUTO POLLING
// =====================================================

let polling = false;

async function autoUpdate() {

    if (polling) {
        return;
    }

    polling = true;

    try {

        await Promise.allSettled([
            processType("hu"),
            processType("md5")
        ]);

    } catch (error) {

        console.error(
            "[AUTO UPDATE]",
            error.message
        );

    } finally {

        polling = false;
    }
}

// Chạy ngay khi server khởi động
autoUpdate();

// Sau đó tự cập nhật mỗi 3 giây
setInterval(
    autoUpdate,
    POLL_INTERVAL
);
