const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SOURCES = {
    tx: "https://wtx.tele68.com/v1/tx/sessions",
    txmd5: "https://wtxmd52.tele68.com/v1/txmd5/sessions"
};

const INTERVAL = 3000;
const HISTORY_SIZE = 50;
const LEARNING_SIZE = 300;

// ======================================================
// STATE
// ======================================================

const state = {
    tx: createState(),
    txmd5: createState()
};

function createState() {
    return {
        history: [],
        learning: [],
        predictions: [],
        lastId: null,
        current: null,
        wins: 0,
        losses: 0
    };
}

// ======================================================
// UTILS
// ======================================================

function normalizeResult(value) {
    if (!value) return null;

    const v = String(value)
        .toUpperCase()
        .trim();

    if (
        v === "TAI" ||
        v === "TÀI" ||
        v === "T"
    ) {
        return "Tài";
    }

    if (
        v === "XIU" ||
        v === "XỈU" ||
        v === "X"
    ) {
        return "Xỉu";
    }

    return null;
}

function internal(result) {
    return result === "Tài" ? "T" : "X";
}

function opposite(result) {
    return result === "Tài"
        ? "Xỉu"
        : "Tài";
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function round(n) {
    return Math.round(n * 100) / 100;
}

// ======================================================
// PARSE API
// ======================================================

function parseAPI(json) {

    const list =
        Array.isArray(json?.list)
            ? json.list
            : [];

    return list
        .map(item => {

            const dices =
                Array.isArray(item.dices)
                    ? item.dices.map(Number)
                    : [];

            let point =
                Number(item.point);

            if (
                !Number.isFinite(point) &&
                dices.length
            ) {
                point =
                    dices.reduce(
                        (a, b) => a + b,
                        0
                    );
            }

            return {
                id: item.id,

                _id:
                    item._id ?? null,

                result:
                    normalizeResult(
                        item.resultTruyenThong ??
                        item.result ??
                        item.ket_qua
                    ),

                dices,

                point:
                    Number.isFinite(point)
                        ? point
                        : null
            };
        })
        .filter(x => x.result);
}

// ======================================================
// BAYESIAN
// ======================================================

function probability(
    wins,
    losses,
    alpha = 2,
    beta = 2
) {
    return (
        (wins + alpha) /
        (
            wins +
            losses +
            alpha +
            beta
        )
    );
}

// ======================================================
// RECENT SIGNAL
// ======================================================

function recentSignal(results) {

    if (results.length < 5) {
        return null;
    }

    const sizes = [
        5,
        10,
        20,
        50
    ];

    let total = 0;
    let weightTotal = 0;

    for (const size of sizes) {

        if (results.length < size) {
            continue;
        }

        const arr =
            results.slice(0, size);

        let tai = 0;
        let xiu = 0;

        for (const r of arr) {
            if (r === "Tài") tai++;
            else xiu++;
        }

        const p =
            probability(
                tai,
                xiu
            );

        const weight =
            size === 5
                ? 1.5
                : size === 10
                    ? 1.2
                    : size === 20
                        ? 0.8
                        : 0.5;

        total += p * weight;
        weightTotal += weight;
    }

    if (!weightTotal) {
        return null;
    }

    return {
        probability:
            total / weightTotal,

        samples:
            Math.min(
                results.length,
                50
            )
    };
}

// ======================================================
// MARKOV
// ======================================================

function markovSignal(results) {

    if (results.length < 8) {
        return null;
    }

    const current =
        results[0];

    let same = 0;
    let change = 0;

    for (
        let i = 0;
        i < results.length - 1;
        i++
    ) {

        if (
            results[i] !==
            current
        ) {
            continue;
        }

        if (
            results[i + 1] ===
            current
        ) {
            same++;
        } else {
            change++;
        }
    }

    const samples =
        same + change;

    if (samples < 3) {
        return null;
    }

    const pSame =
        probability(
            same,
            change
        );

    return {
        probability:
            current === "Tài"
                ? pSame
                : 1 - pSame,

        samples
    };
}

// ======================================================
// PATTERN MINING
// ======================================================

function patternSignal(results) {

    if (results.length < 8) {
        return null;
    }

    const source =
        results.map(internal);

    let predictions = [];

    for (
        let length = 2;
        length <= 8;
        length++
    ) {

        if (
            source.length <=
            length + 2
        ) {
            continue;
        }

        const target =
            source
                .slice(0, length)
                .join("");

        let tai = 0;
        let xiu = 0;

        for (
            let i = length;
            i < source.length;
            i++
        ) {

            const pattern =
                source
                    .slice(
                        i - length,
                        i
                    )
                    .join("");

            if (
                pattern !==
                target
            ) {
                continue;
            }

            if (
                source[i] === "T"
            ) {
                tai++;
            } else {
                xiu++;
            }
        }

        const samples =
            tai + xiu;

        if (samples < 3) {
            continue;
        }

        const p =
            probability(
                tai,
                xiu
            );

        predictions.push({
            length,
            probability: p,
            samples
        });
    }

    if (!predictions.length) {
        return null;
    }

    let total = 0;
    let weightTotal = 0;

    for (const p of predictions) {

        const weight =
            Math.min(
                2,
                0.5 +
                p.length * 0.15
            ) *
            Math.min(
                1.5,
                Math.log2(
                    p.samples + 1
                ) / 2
            );

        total +=
            p.probability *
            weight;

        weightTotal +=
            weight;
    }

    return {
        probability:
            total / weightTotal,

        samples:
            predictions.reduce(
                (a, b) =>
                    a + b.samples,
                0
            ),

        patterns:
            predictions
    };
}

// ======================================================
// STREAK
// ======================================================

function streakSignal(results) {

    if (results.length < 6) {
        return null;
    }

    const first =
        results[0];

    let run = 1;

    for (
        let i = 1;
        i < results.length;
        i++
    ) {

        if (
            results[i] ===
            first
        ) {
            run++;
        } else {
            break;
        }
    }

    if (run < 2) {
        return null;
    }

    let same = 0;
    let change = 0;

    for (
        let i = 0;
        i < results.length - run;
        i++
    ) {

        let match = true;

        for (
            let j = 0;
            j < run;
            j++
        ) {

            if (
                results[i + j] !==
                first
            ) {
                match = false;
                break;
            }
        }

        if (!match) {
            continue;
        }

        if (
            results[i + run] ===
            first
        ) {
            same++;
        } else {
            change++;
        }
    }

    const samples =
        same + change;

    if (samples < 3) {
        return null;
    }

    const p =
        probability(
            same,
            change
        );

    return {
        probability:
            first === "Tài"
                ? p
                : 1 - p,

        samples,
        run
    };
}

// ======================================================
// ALTERNATING
// ======================================================

function alternatingSignal(results) {

    if (results.length < 8) {
        return null;
    }

    let changes = 0;

    for (
        let i = 0;
        i < 6;
        i++
    ) {

        if (
            results[i] !==
            results[i + 1]
        ) {
            changes++;
        }
    }

    if (changes < 5) {
        return null;
    }

    const expected =
        opposite(
            results[0]
        );

    let correct = 0;
    let wrong = 0;

    for (
        let i = 0;
        i < results.length - 1;
        i++
    ) {

        if (
            results[i + 1] ===
            opposite(results[i])
        ) {
            correct++;
        } else {
            wrong++;
        }
    }

    const p =
        probability(
            correct,
            wrong
        );

    return {
        probability:
            expected === "Tài"
                ? p
                : 1 - p,

        samples:
            correct + wrong
    };
}

// ======================================================
// POINT SIGNAL
// ======================================================

function pointSignal(history) {

    const valid =
        history.filter(
            x =>
                Number.isFinite(
                    x.point
                )
        );

    if (valid.length < 5) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    for (
        const item of valid.slice(
            0,
            20
        )
    ) {

        if (
            item.point >= 11
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    return {
        probability:
            probability(
                tai,
                xiu
            ),

        samples:
            tai + xiu
    };
}

// ======================================================
// WEIGHTED COMBINATION
// ======================================================

function combineSignals(signals) {

    if (!signals.length) {
        return 0.5;
    }

    let weighted = 0;
    let weights = 0;

    for (const signal of signals) {

        let p =
            clamp(
                signal.probability,
                0.05,
                0.95
            );

        const sampleFactor =
            clamp(
                Math.log2(
                    signal.samples + 1
                ) / 4,
                0.5,
                1.5
            );

        const weight =
            signal.weight *
            sampleFactor;

        weighted +=
            p * weight;

        weights += weight;
    }

    return weights
        ? weighted / weights
        : 0.5;
}

// ======================================================
// SELF LEARNING CALIBRATION
// ======================================================

function calibrate(
    raw,
    learning
) {

    if (
        learning.length < 15
    ) {
        return raw;
    }

    const nearby =
        learning.filter(item =>
            Math.abs(
                item.rawProbability -
                raw
            ) <= 0.08
        );

    if (
        nearby.length < 8
    ) {
        return raw;
    }

    let wins = 0;

    for (const item of nearby) {
        if (item.win) {
            wins++;
        }
    }

    const learned =
        probability(
            wins,
            nearby.length - wins
        );

    return (
        raw * 0.65 +
        learned * 0.35
    );
}

// ======================================================
// MAIN ALGORITHM
// ======================================================

function predict(
    history,
    learning
) {

    if (history.length < 8) {

        return {
            prediction: null,
            confidence: 0,
            reason: "Chưa đủ dữ liệu"
        };
    }

    /*
     * RẤT QUAN TRỌNG:
     *
     * history[0] là phiên mới nhất đã có kết quả.
     *
     * Khi tạo dự đoán cho phiên tiếp theo,
     * phải bỏ history[0] ra để tránh
     * dùng chính kết quả vừa xảy ra.
     */

    const training =
        history.slice(1);

    const results =
        training.map(
            x => x.result
        );

    const signals = [];

    function add(
        name,
        result,
        weight
    ) {

        if (!result) {
            return;
        }

        signals.push({
            name,

            probability:
                result.probability,

            samples:
                result.samples,

            weight
        });
    }

    add(
        "Recent",
        recentSignal(results),
        1.0
    );

    add(
        "Markov",
        markovSignal(results),
        1.15
    );

    add(
        "Pattern",
        patternSignal(results),
        1.30
    );

    add(
        "Streak",
        streakSignal(results),
        0.85
    );

    add(
        "Alternating",
        alternatingSignal(results),
        0.75
    );

    add(
        "Point",
        pointSignal(training),
        0.35
    );

    if (!signals.length) {

        return {
            prediction: null,
            confidence: 0,
            reason: "Không đủ tín hiệu"
        };
    }

    const raw =
        combineSignals(
            signals
        );

    const calibrated =
        calibrate(
            raw,
            learning
        );

    const prediction =
        calibrated >= 0.5
            ? "Tài"
            : "Xỉu";

    const confidence =
        round(
            Math.max(
                calibrated,
                1 - calibrated
            ) * 100
        );

    return {

        prediction,

        confidence,

        probability: {
            "Tài":
                round(
                    calibrated * 100
                ),

            "Xỉu":
                round(
                    (1 - calibrated) *
                    100
                )
        },

        rawProbability:
            round(
                raw * 100
            ),

        signals:
            signals.map(s => ({
                name: s.name,

                probability:
                    round(
                        s.probability *
                        100
                    ),

                samples:
                    s.samples
            })),

        pattern:
            results
                .map(internal)
                .join("")
                .slice(
                    0,
                    20
                )
    };
}

// ======================================================
// LEARNING
// ======================================================

function learn(
    type,
    actual
) {

    const s =
        state[type];

    if (!s.current) {
        return;
    }

    if (
        s.current.id ===
        actual.id
    ) {
        return;
    }

    const prediction =
        s.current.prediction;

    if (!prediction) {
        return;
    }

    const win =
        prediction ===
        actual.result;

    if (win) {
        s.wins++;
    } else {
        s.losses++;
    }

    s.learning.unshift({

        id:
            s.current.id,

        prediction,

        actual:
            actual.result,

        win,

        rawProbability:
            s.current.rawProbability /
            100,

        confidence:
            s.current.confidence,

        time:
            Date.now()
    });

    s.learning =
        s.learning.slice(
            0,
            LEARNING_SIZE
        );

    s.predictions.unshift({

        id:
            s.current.id,

        prediction,

        confidence:
            s.current.confidence,

        actual:
            actual.result,

        status:
            win
                ? "WIN"
                : "LOSS",

        time:
            s.current.time
    });

    s.predictions =
        s.predictions.slice(
            0,
            HISTORY_SIZE
        );
}

// ======================================================
// UPDATE ONE SOURCE
// ======================================================

async function update(
    type
) {

    const s =
        state[type];

    try {

        const response =
            await fetch(
                SOURCES[type]
            );

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const json =
            await response.json();

        const history =
            parseAPI(json);

        if (!history.length) {
            return;
        }

        const latest =
            history[0];

        if (
            s.lastId ===
            latest.id
        ) {
            return;
        }

        /*
         * Chấm dự đoán phiên trước
         */
        learn(
            type,
            latest
        );

        /*
         * Update history
         */
        s.lastId =
            latest.id;

        s.history =
            history.slice(
                0,
                HISTORY_SIZE
            );

        /*
         * Tạo dự đoán mới
         */
        const result =
            predict(
                s.history,
                s.learning
            );

        s.current = {

            id:
                latest.id,

            prediction:
                result.prediction,

            confidence:
                result.confidence,

            probability:
                result.probability,

            rawProbability:
                result.rawProbability,

            signals:
                result.signals,

            pattern:
                result.pattern,

            time:
                new Date()
                    .toISOString()
        };

        console.log(
            `[${type}]`,
            `#${latest.id}`,
            "→",
            result.prediction,
            `${result.confidence}%`,
            `WIN=${s.wins}`,
            `LOSS=${s.losses}`
        );

    } catch (error) {

        console.error(
            `[${type}]`,
            error.message
        );
    }
}

// ======================================================
// LOOP
// ======================================================

async function worker(type) {

    while (true) {

        await update(type);

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    INTERVAL
                )
        );
    }
}

// ======================================================
// STATS
// ======================================================

function stats(type) {

    const s =
        state[type];

    const total =
        s.wins +
        s.losses;

    return {

        wins:
            s.wins,

        losses:
            s.losses,

        total,

        winrate:
            total
                ? round(
                    s.wins /
                    total *
                    100
                )
                : 0,

        learning:
            s.learning.length
    };
}

// ======================================================
// API STATUS
// ======================================================

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            tx: {

                source:
                    SOURCES.tx,

                lastId:
                    state.tx.lastId,

                current:
                    state.tx.current,

                stats:
                    stats("tx")
            },

            txmd5: {

                source:
                    SOURCES.txmd5,

                lastId:
                    state.txmd5.lastId,

                current:
                    state.txmd5.current,

                stats:
                    stats("txmd5")
            }
        });
    }
);

// ======================================================
// TX
// ======================================================

app.get(
    "/api/tx",
    (req, res) => {

        res.json({

            source:
                SOURCES.tx,

            current:
                state.tx.current,

            stats:
                stats("tx"),

            history:
                state.tx.history,

            predictions:
                state.tx.predictions
        });
    }
);

// ======================================================
// TXMD5
// ======================================================

app.get(
    "/api/txmd5",
    (req, res) => {

        res.json({

            source:
                SOURCES.txmd5,

            current:
                state.txmd5.current,

            stats:
                stats("txmd5"),

            history:
                state.txmd5.history,

            predictions:
                state.txmd5.predictions
        });
    }
);

// ======================================================
// PREDICTION HISTORY
// ======================================================

app.get(
    "/api/tx/history",
    (req, res) => {

        res.json(
            state.tx.predictions
        );
    }
);

app.get(
    "/api/txmd5/history",
    (req, res) => {

        res.json(
            state.txmd5.predictions
        );
    }
);

// ======================================================
// START
// ======================================================

app.listen(
    PORT,
    () => {

        console.log(
            "===================================="
        );

        console.log(
            " AI TX / TXMD5 ENGINE"
        );

        console.log(
            "===================================="
        );

        console.log(
            "TX:",
            SOURCES.tx
        );

        console.log(
            "TXMD5:",
            SOURCES.txmd5
        );

        console.log(
            "Interval:",
            INTERVAL,
            "ms"
        );

        console.log(
            "History:",
            HISTORY_SIZE
        );

        console.log(
            "Algorithm:",
            "Probability + Pattern + Markov + Learning"
        );

        console.log(
            "===================================="
        );

        worker("tx");

        worker("txmd5");
    }
);
