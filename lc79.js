const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const MAX_SOURCE_HISTORY = 50;
const MAX_PATTERN_HISTORY = 20;
const MAX_ANALYZE_PATTERN = 12;
const MAX_PREDICTION_HISTORY = 50;

const CACHE_MS = 3000;
const PREDICTION_FILE = path.join(__dirname, "predictions.json");

let cache = {
    time: 0,
    history: [],
    pattern: "",
    prediction: null
};

let predictionHistory = loadPredictions();

const learnedPatterns = new Map();

function loadPredictions() {
    try {
        if (!fs.existsSync(PREDICTION_FILE)) {
            fs.writeFileSync(
                PREDICTION_FILE,
                "[]",
                "utf8"
            );
            return [];
        }

        const data = fs.readFileSync(
            PREDICTION_FILE,
            "utf8"
        );

        const parsed = JSON.parse(data);

        return Array.isArray(parsed)
            ? parsed.slice(-MAX_PREDICTION_HISTORY)
            : [];
    } catch (error) {
        console.error(
            "LOAD PREDICTIONS ERROR:",
            error.message
        );

        return [];
    }
}

function savePredictions() {
    try {
        predictionHistory =
            predictionHistory.slice(
                -MAX_PREDICTION_HISTORY
            );

        fs.writeFileSync(
            PREDICTION_FILE,
            JSON.stringify(
                predictionHistory,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "SAVE PREDICTIONS ERROR:",
            error.message
        );
    }
}

function tx(value) {
    return value === "Tài" ? "T" : "X";
}

function result(value) {
    return value === "T"
        ? "Tài"
        : "Xỉu";
}

function opposite(value) {
    return value === "T"
        ? "X"
        : "T";
}

function invertPattern(pattern) {
    return pattern
        .split("")
        .map(value =>
            value === "T" ? "X" : "T"
        )
        .join("");
}

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function patternWeight(length) {
    if (length >= 12) return 3.2;
    if (length === 11) return 3.0;
    if (length === 10) return 2.8;
    if (length === 9) return 2.6;
    if (length === 8) return 2.4;
    if (length === 7) return 2.2;
    if (length === 6) return 2.0;
    if (length === 5) return 1.8;
    if (length === 4) return 1.5;
    if (length === 3) return 1.25;

    return 1;
}

async function fetchHistory() {
    const response = await fetch(
        SOURCE_API,
        {
            headers: {
                Accept: "application/json",
                "User-Agent": "Mozilla/5.0"
            }
        }
    );

    if (!response.ok) {
        throw new Error(
            `Source API HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    if (
        !data ||
        !Array.isArray(data.list)
    ) {
        throw new Error(
            "Source API không có list"
        );
    }

    return data.list
        .map(item => ({
            phien: Number(item.id),

            xuc_xac:
                Array.isArray(item.dices)
                    ? item.dices.map(Number)
                    : [],

            tong: Number(item.point),

            ket_qua:
                String(
                    item.resultTruyenThong
                ).toUpperCase() === "TAI"
                    ? "Tài"
                    : "Xỉu"
        }))
        .filter(item =>
            Number.isFinite(
                item.phien
            ) &&
            item.xuc_xac.length === 3 &&
            item.xuc_xac.every(
                Number.isFinite
            ) &&
            Number.isFinite(
                item.tong
            )
        )
        .sort(
            (a, b) =>
                a.phien - b.phien
        )
        .slice(
            -MAX_SOURCE_HISTORY
        );
}

function buildPattern(history) {
    return history
        .slice(
            -MAX_PATTERN_HISTORY
        )
        .map(item =>
            tx(item.ket_qua)
        )
        .join("");
}

function analyzePattern(
    history,
    pattern
) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i + pattern.length <
        values.length;
        i++
    ) {
        const current =
            values
                .slice(
                    i,
                    i + pattern.length
                )
                .join("");

        if (current !== pattern) {
            continue;
        }

        total++;

        if (
            values[
                i + pattern.length
            ] === "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    if (!total) {
        return null;
    }

    return {
        pattern,
        total,
        tai,
        xiu,
        pT: tai / total,
        pX: xiu / total
    };
}

function getCurrentPatterns(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    const output = [];

    const maxLength =
        Math.min(
            MAX_ANALYZE_PATTERN,
            values.length - 1
        );

    for (
        let length = 2;
        length <= maxLength;
        length++
    ) {
        const pattern =
            values
                .slice(-length)
                .join("");

        const reversed =
            invertPattern(pattern);

        const main =
            analyzePattern(
                history,
                pattern
            );

        if (
            main &&
            main.total >= 2
        ) {
            output.push({
                ...main,
                mode: "chinh"
            });
        }

        const reverse =
            analyzePattern(
                history,
                reversed
            );

        if (
            reverse &&
            reverse.total >= 2 &&
            reversed !== pattern
        ) {
            output.push({
                ...reverse,
                mode: "dao"
            });
        }
    }

    return output;
}

function analyzeMarkov(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    if (values.length < 5) {
        return null;
    }

    const current =
        values[
            values.length - 1
        ];

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < values.length - 1;
        i++
    ) {
        if (
            values[i] !== current
        ) {
            continue;
        }

        total++;

        if (
            values[i + 1] === "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    if (!total) {
        return null;
    }

    return {
        total,
        pT: tai / total,
        pX: xiu / total
    };
}

function analyzeMarkov2(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    if (values.length < 7) {
        return null;
    }

    const key =
        values
            .slice(-2)
            .join("");

    let total = 0;
    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < values.length - 2;
        i++
    ) {
        const pair =
            values
                .slice(i, i + 2)
                .join("");

        if (pair !== key) {
            continue;
        }

        total++;

        if (
            values[i + 2] === "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    if (!total) {
        return null;
    }

    return {
        key,
        total,
        pT: tai / total,
        pX: xiu / total
    };
}

function analyzeStreak(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    if (!values.length) {
        return null;
    }

    const side =
        values[
            values.length - 1
        ];

    let length = 1;

    for (
        let i = values.length - 2;
        i >= 0;
        i--
    ) {
        if (
            values[i] !== side
        ) {
            break;
        }

        length++;
    }

    return {
        side,
        length
    };
}

function getRunLengths(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    const runs = [];

    if (!values.length) {
        return runs;
    }

    let side = values[0];
    let count = 1;

    for (
        let i = 1;
        i < values.length;
        i++
    ) {
        if (values[i] === side) {
            count++;
        } else {
            runs.push({
                side,
                count
            });

            side = values[i];
            count = 1;
        }
    }

    runs.push({
        side,
        count
    });

    return runs;
}

function analyzeRunPattern(
    history
) {
    const runs =
        getRunLengths(history);

    if (runs.length < 3) {
        return null;
    }

    const recent =
        runs.slice(-5);

    const lengths =
        recent.map(run =>
            run.count
        );

    const last =
        runs[runs.length - 1];

    const previous =
        runs[runs.length - 2];

    return {
        runs: recent,
        lengths,
        last,
        previous
    };
}

function specialPatterns(history) {
    const values =
        history.map(item =>
            tx(item.ket_qua)
        );

    const output = [];

    if (values.length < 4) {
        return output;
    }

    const p4 =
        values.slice(-4).join("");

    const p5 =
        values.slice(-5).join("");

    const p6 =
        values.slice(-6).join("");

    const p7 =
        values.slice(-7).join("");

    const p8 =
        values.slice(-8).join("");

    const p10 =
        values.slice(-10).join("");

    const p12 =
        values.slice(-12).join("");

    const last =
        values[values.length - 1];

    const next =
        opposite(last);

    function add(
        type,
        prediction,
        strength
    ) {
        output.push({
            type,
            prediction,
            strength
        });
    }

    const patterns = [
        [
            "1-1",
            [
                "TXTXTX",
                "XTXTXT"
            ],
            0.89
        ],
        [
            "2-2",
            [
                "TTXXTTXX",
                "XXTTXXTT"
            ],
            0.86
        ],
        [
            "3-3",
            [
                "TTTXXX",
                "XXXTTT"
            ],
            0.84
        ],
        [
            "1-2-1",
            [
                "TXXT",
                "XTTX"
            ],
            0.82
        ],
        [
            "2-1-2",
            [
                "TTXTT",
                "XXTXX"
            ],
            0.82
        ],
        [
            "1-3-1",
            [
                "XTTTX",
                "TXXXT"
            ],
            0.80
        ],
        [
            "1-2",
            [
                "TXXTXX",
                "XTTXTT"
            ],
            0.81
        ],
        [
            "2-1",
            [
                "TTXTTX",
                "XXTXXT"
            ],
            0.81
        ],
        [
            "3-2",
            [
                "TTTXX",
                "XXXTT"
            ],
            0.77
        ],
        [
            "2-3",
            [
                "TTXXX",
                "XXTTT"
            ],
            0.77
        ],
        [
            "4-1",
            [
                "TTTTX",
                "XXXXT"
            ],
            0.76
        ],
        [
            "1-4",
            [
                "XTTTT",
                "TXXXX"
            ],
            0.76
        ],
        [
            "4-2",
            [
                "TTTTXX",
                "XXXXTT"
            ],
            0.75
        ],
        [
            "2-4",
            [
                "TTXXXX",
                "XXTTTT"
            ],
            0.75
        ],
        [
            "5-1",
            [
                "TTTTTX",
                "XXXXXT"
            ],
            0.72
        ],
        [
            "1-5",
            [
                "XTTTTT",
                "TXXXXX"
            ],
            0.72
        ],
        [
            "6-1",
            [
                "TTTTTTX",
                "XXXXXXT"
            ],
            0.70
        ],
        [
            "1-6",
            [
                "XTTTTTT",
                "TXXXXXX"
            ],
            0.70
        ],
        [
            "2-2-2",
            [
                "TTXXTT",
                "XXTTXX"
            ],
            0.82
        ],
        [
            "3-2-1",
            [
                "TTTXXT",
                "XXXTTX"
            ],
            0.73
        ],
        [
            "1-2-3",
            [
                "TXXTTT",
                "XTTXXX"
            ],
            0.73
        ]
    ];

    for (const [
        name,
        samples,
        strength
    ] of patterns) {
        if (
            samples.includes(p4) ||
            samples.includes(p5) ||
            samples.includes(p6) ||
            samples.includes(p7) ||
            samples.includes(p8)
        ) {
            add(
                name,
                next,
                strength
            );
        }
    }

    if (
        /^(TX)+T?$/.test(p8) ||
        /^(XT)+X?$/.test(p8)
    ) {
        add(
            "dao",
            next,
            0.85
        );
    }

    if (
        p6.slice(0, 3) ===
        p6.slice(3)
    ) {
        add(
            "chu-ky-3",
            next,
            0.78
        );
    }

    if (
        p8.slice(0, 4) ===
        p8.slice(4)
    ) {
        add(
            "chu-ky-4",
            next,
            0.79
        );
    }

    if (
        p8 ===
        p8.split("")
            .reverse()
            .join("")
    ) {
        add(
            "doi-xung",
            next,
            0.80
        );
    }

    if (
        p6 === "TTTXXT" ||
        p6 === "XXXTTX" ||
        p6 === "TTXXXT" ||
        p6 === "XXTTTX"
    ) {
        add(
            "cau-gay",
            last,
            0.70
        );
    }

    if (
        p10 === "TXXTTXXXTT"
    ) {
        add(
            "cau-tang",
            "T",
            0.72
        );
    }

    if (
        p10 === "TTTXXXTTXX"
    ) {
        add(
            "cau-giam",
            "X",
            0.72
        );
    }

    if (
        p12 === "TXTTXTXTTXTX"
    ) {
        add(
            "special-12-A",
            "T",
            0.90
        );
    }

    if (
        p12 === "XTTXTXTTXTTX"
    ) {
        add(
            "special-12-B",
            "X",
            0.90
        );
    }

    return output;
}

function getLearnData(pattern) {
    if (!learnedPatterns.has(pattern)) {
        learnedPatterns.set(
            pattern,
            {
                total: 0,
                win: 0,
                lose: 0
            }
        );
    }

    return learnedPatterns.get(
        pattern
    );
}

function getLearnRate(pattern) {
    const data =
        learnedPatterns.get(pattern);

    if (
        !data ||
        data.total === 0
    ) {
        return 50;
    }

    return (
        (
            (data.win + 1) /
            (data.total + 2)
        ) * 100
    );
}

function learnFromHistory(history) {
    for (
        const record
        of predictionHistory
    ) {
        if (
            record.danh_gia !==
            "✅ Thắng" &&
            record.danh_gia !==
            "❌ Thua"
        ) {
            continue;
        }

        if (
            !record.pattern
        ) {
            continue;
        }

        const data =
            getLearnData(
                record.pattern
            );

        const already =
            data._sessions || [];

        if (
            already.includes(
                record.phien
            )
        ) {
            continue;
        }

        already.push(
            record.phien
        );

        data._sessions =
            already.slice(-100);

        data.total++;

        if (
            record.danh_gia ===
            "✅ Thắng"
        ) {
            data.win++;
        } else {
            data.lose++;
        }
    }
}

function calculatePrediction(
    history
) {
    learnFromHistory(history);

    const score = {
        T: 0,
        X: 0
    };

    const evidence = [];

    const patterns =
        getCurrentPatterns(
            history
        );

    for (
        const item of patterns
    ) {
        const learnRate =
            getLearnRate(
                item.pattern
            );

        const lengthFactor =
            patternWeight(
                item.pattern.length
            );

        const occurrenceFactor =
            Math.min(
                2.5,
                Math.log2(
                    item.total + 1
                )
            );

        const learningFactor =
            0.5 +
            learnRate / 100;

        const modeFactor =
            item.mode === "chinh"
                ? 1
                : 0.85;

        const recencyFactor =
            item.pattern ===
            history
                .slice(
                    -item.pattern.length
                )
                .map(v =>
                    tx(v.ket_qua)
                )
                .join("")
                ? 1.25
                : 1;

        const weight =
            lengthFactor *
            occurrenceFactor *
            learningFactor *
            modeFactor *
            recencyFactor;

        score.T +=
            item.pT * weight;

        score.X +=
            item.pX * weight;

        evidence.push({
            type: "pattern",
            pattern:
                item.pattern,
            mode:
                item.mode,
            total:
                item.total,
            tai:
                Number(
                    (
                        item.pT * 100
                    ).toFixed(2)
                ),
            xiu:
                Number(
                    (
                        item.pX * 100
                    ).toFixed(2)
                ),
            hoc:
                Number(
                    learnRate.toFixed(2)
                ),
            weight:
                Number(
                    weight.toFixed(3)
                )
        });
    }

    const markov =
        analyzeMarkov(history);

    if (markov) {
        score.T +=
            markov.pT * 3.2;

        score.X +=
            markov.pX * 3.2;

        evidence.push({
            type: "markov",
            total:
                markov.total,
            tai:
                Number(
                    (
                        markov.pT * 100
                    ).toFixed(2)
                ),
            xiu:
                Number(
                    (
                        markov.pX * 100
                    ).toFixed(2)
                )
        });
    }

    const markov2 =
        analyzeMarkov2(history);

    if (markov2) {
        score.T +=
            markov2.pT * 4;

        score.X +=
            markov2.pX * 4;

        evidence.push({
            type: "markov2",
            pattern:
                markov2.key,
            total:
                markov2.total,
            tai:
                Number(
                    (
                        markov2.pT * 100
                    ).toFixed(2)
                ),
            xiu:
                Number(
                    (
                        markov2.pX * 100
                    ).toFixed(2)
                )
        });
    }

    const streak =
        analyzeStreak(history);

    if (streak) {
        let weight = 0.7;

        if (
            streak.length >= 3
        ) {
            weight = 1.5;
        }

        if (
            streak.length >= 4
        ) {
            weight = 2.0;
        }

        if (
            streak.length >= 5
        ) {
            weight = 2.4;
        }

        if (
            streak.length >= 6
        ) {
            weight = 2.8;
        }

        score[
            streak.side
        ] += weight;

        evidence.push({
            type: "streak",
            result:
                result(
                    streak.side
                ),
            length:
                streak.length,
            weight
        });
    }

    const run =
        analyzeRunPattern(
            history
        );

    if (run) {
        const last =
            run.last;

        const previous =
            run.previous;

        if (
            last.count ===
            previous.count
        ) {
            score[
                opposite(
                    last.side
                )
            ] += 1.6;

            evidence.push({
                type:
                    "run-repeat",
                prediction:
                    result(
                        opposite(
                            last.side
                        )
                    ),
                strength: 1.6
            });
        }

        if (
            last.count >
            previous.count
        ) {
            score[
                opposite(
                    last.side
                )
            ] += 1.2;

            evidence.push({
                type:
                    "run-increase",
                prediction:
                    result(
                        opposite(
                            last.side
                        )
                    ),
                strength: 1.2
            });
        }
    }

    const special =
        specialPatterns(
            history
        );

    for (
        const item
        of special
    ) {
        score[
            item.prediction
        ] +=
            item.strength * 3;

        evidence.push({
            type:
                item.type,
            prediction:
                result(
                    item.prediction
                ),
            strength:
                item.strength
        });
    }

    const total =
        score.T + score.X;

    if (total <= 0) {
        return {
            du_doan:
                "Không rõ cầu",
            do_tin_cay:
                "0.00%",
            score,
            evidence
        };
    }

    const prediction =
        score.T >= score.X
            ? "T"
            : "X";

    const raw =
        (
            Math.max(
                score.T,
                score.X
            ) / total
        ) * 100;

    const margin =
        Math.abs(
            score.T - score.X
        ) / total;

    let confidence =
        50 + margin * 50;

    confidence =
        clamp(
            confidence,
            50,
            98
        );

    confidence =
        Number(
            confidence.toFixed(2)
        );

    return {
        du_doan:
            result(prediction),

        side:
            prediction,

        do_tin_cay:
            `${confidence.toFixed(2)}%`,

        confidence,

        raw:
            Number(
                raw.toFixed(2)
            ),

        score: {
            tai:
                Number(
                    score.T.toFixed(4)
                ),
            xiu:
                Number(
                    score.X.toFixed(4)
                )
        },

        evidence
    };
}

function findPrediction(
    phien
) {
    return predictionHistory.find(
        item =>
            Number(item.phien) ===
            Number(phien)
    );
}

function createPrediction(
    history,
    prediction,
    pattern
) {
    const latest =
        history[
            history.length - 1
        ];

    const nextPhien =
        latest.phien + 1;

    const existing =
        findPrediction(
            nextPhien
        );

    if (existing) {
        if (
            existing.ket_qua ===
            "⌛ Chờ Kết Quả"
        ) {
            existing.du_doan =
                prediction.du_doan;

            existing.do_tin_cay =
                prediction.do_tin_cay;

            existing.pattern =
                pattern;

            savePredictions();
        }

        return existing;
    }

    const record = {
        phien:
            nextPhien,

        du_doan:
            prediction.du_doan,

        do_tin_cay:
            prediction.do_tin_cay,

        ket_qua:
            "⌛ Chờ Kết Quả",

        danh_gia:
            "⌛ Chờ",

        xuc_xac: [],

        tong:
            "⌛ Chờ",

        pattern,
        created_at:
            new Date().toISOString()
    };

    predictionHistory.push(
        record
    );

    predictionHistory =
        predictionHistory.slice(
            -MAX_PREDICTION_HISTORY
        );

    savePredictions();

    return record;
}

function updatePredictionResults(
    sourceHistory
) {
    let changed = false;

    for (
        const record
        of predictionHistory
    ) {
        if (
            record.ket_qua !==
            "⌛ Chờ Kết Quả"
        ) {
            continue;
        }

        const actual =
            sourceHistory.find(
                item =>
                    Number(
                        item.phien
                    ) ===
                    Number(
                        record.phien
                    )
            );

        if (!actual) {
            continue;
        }

        record.ket_qua =
            actual.ket_qua;

        record.xuc_xac =
            actual.xuc_xac;

        record.tong =
            actual.tong;

        record.danh_gia =
            record.du_doan ===
            actual.ket_qua
                ? "✅ Thắng"
                : "❌ Thua";

        changed = true;
    }

    if (changed) {
        savePredictions();
    }
}

async function getData() {
    const now = Date.now();

    if (
        cache.prediction &&
        now - cache.time <
            CACHE_MS
    ) {
        return cache;
    }

    const history =
        await fetchHistory();

    updatePredictionResults(
        history
    );

    const pattern =
        buildPattern(
            history
        );

    const prediction =
        calculatePrediction(
            history
        );

    const next =
        createPrediction(
            history,
            prediction,
            pattern
        );

    cache = {
        time: now,
        history,
        pattern,
        prediction,
        next
    };

    return cache;
}

// ============================================================
// API: /api/taixiumd5
// ============================================================

app.get(
    "/api/taixiumd5",
    async (req, res) => {
        try {
            const {
                history,
                pattern,
                prediction,
                next
            } = await getData();

            const latest =
                history[
                    history.length - 1
                ];

            res.json({
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    latest.ket_qua,

                phien_hien_tai:
                    latest.phien + 1,

                pattern,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay
            });
        } catch (error) {
            console.error(
                "TAIXIUMD5 ERROR:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// API: /api/txmd5/history
// ============================================================

app.get(
    "/api/txmd5/history",
    async (req, res) => {
        try {
            const {
                history,
                next
            } = await getData();

            updatePredictionResults(
                history
            );

            const records =
                predictionHistory
                    .slice()
                    .sort(
                        (a, b) =>
                            b.phien -
                            a.phien
                    )
                    .slice(
                        0,
                        MAX_PREDICTION_HISTORY
                    )
                    .map(item => ({
                        phien:
                            item.phien,

                        du_doan:
                            item.du_doan,

                        ket_qua:
                            item.ket_qua,

                        danh_gia:
                            item.danh_gia,

                        xuc_xac:
                            item.xuc_xac,

                        tong:
                            item.tong
                    }));

            const hasNext =
                records.some(
                    item =>
                        Number(
                            item.phien
                        ) ===
                        Number(
                            next.phien
                        )
                );

            if (!hasNext) {
                records.unshift({
                    phien:
                        next.phien,

                    du_doan:
                        next.du_doan,

                    ket_qua:
                        "⌛ Chờ Kết Quả",

                    danh_gia:
                        "⌛ Chờ",

                    xuc_xac: [],

                    tong:
                        "⌛ Chờ"
                });
            }

            res.json(
                records.slice(
                    0,
                    MAX_PREDICTION_HISTORY
                )
            );
        } catch (error) {
            console.error(
                "HISTORY ERROR:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// API DETAIL
// ============================================================

app.get(
    "/api/taixiumd5/detail",
    async (req, res) => {
        try {
            const {
                history,
                pattern,
                prediction,
                next
            } = await getData();

            res.json({
                phien:
                    history[
                        history.length - 1
                    ].phien,

                phien_hien_tai:
                    next.phien,

                pattern,

                pattern_length:
                    pattern.length,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay,

                score:
                    prediction.score,

                evidence:
                    prediction.evidence,

                next_prediction:
                    next,

                history:
                    history.slice(
                        -MAX_PATTERN_HISTORY
                    )
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

// ============================================================
// API LEARNING
// ============================================================

app.get(
    "/api/txmd5/learning",
    (req, res) => {
        const data = {};

        for (
            const [
                pattern,
                value
            ]
            of learnedPatterns
        ) {
            data[pattern] = {
                total:
                    value.total,

                win:
                    value.win,

                lose:
                    value.lose,

                win_rate:
                    Number(
                        getLearnRate(
                            pattern
                        ).toFixed(2)
                    )
            };
        }

        res.json({
            total_patterns:
                Object.keys(data)
                    .length,

            patterns:
                data
        });
    }
);

// ============================================================
// API HEALTH
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "TAI XIU MD5 API",

            source:
                SOURCE_API,

            pattern:
                "20 phiên - cũ trái, mới phải",

            endpoints: [
                "/api/taixiumd5",
                "/api/taixiumd5/detail",
                "/api/txmd5/history",
                "/api/txmd5/learning"
            ]
        });
    }
);

// ============================================================
// AUTO REFRESH
// ============================================================

setInterval(
    async () => {
        try {
            await getData();
        } catch (error) {
            console.error(
                "AUTO UPDATE ERROR:",
                error.message
            );
        }
    },
    CACHE_MS
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `TAI XIU MD5 API running on port ${PORT}`
        );

        console.log(
            `Source: ${SOURCE_API}`
        );

        console.log(
            `Pattern: ${MAX_PATTERN_HISTORY} phiên`
        );
    }
);
