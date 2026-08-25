const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_TX =
    "https://wtx.tele68.com/v1/tx/sessions";

const API_TXMD5 =
    "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const INTERVAL = 3000;
const MAX_HISTORY = 50;
const MAX_LEARNING = 200;

// ======================================================
// STATE
// ======================================================

const state = {
    tx: {
        history: [],
        predictions: [],
        learning: [],
        lastId: null,
        current: null,
        wins: 0,
        losses: 0
    },

    txmd5: {
        history: [],
        predictions: [],
        lastId: null,
        current: null,
        wins: 0,
        losses: 0
    }
};

// ======================================================
// UTILS
// ======================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

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
        return "TAI";
    }

    if (
        v === "XIU" ||
        v === "XỈU" ||
        v === "X" ||
        v === "XỈU"
    ) {
        return "XIU";
    }

    return null;
}

function opposite(result) {
    return result === "TAI"
        ? "XIU"
        : "TAI";
}

// ======================================================
// PARSER
// ======================================================

function parseTX(data) {
    const list =
        Array.isArray(data?.list)
            ? data.list
            : [];

    return list
        .map(item => ({
            id: item.id,

            result:
                normalizeResult(
                    item.resultTruyenThong ??
                    item.result ??
                    item.ket_qua
                ),

            dices:
                Array.isArray(item.dices)
                    ? item.dices
                    : Array.isArray(item.xuc_xac)
                        ? item.xuc_xac
                        : [],

            point:
                Number(
                    item.point ??
                    item.tong ??
                    0
                )
        }))
        .filter(x => x.result);
}

// ======================================================
// BAYESIAN PROBABILITY
// ======================================================

function bayesianProbability(
    wins,
    losses,
    alpha = 2,
    beta = 2
) {
    return (
        (wins + alpha) /
        (wins + losses + alpha + beta)
    );
}

// ======================================================
// PATTERN PROBABILITY
// ======================================================

function patternProbability(
    results,
    patternLength
) {
    if (
        results.length <=
        patternLength + 2
    ) {
        return null;
    }

    const pattern =
        results
            .map(x =>
                x === "TAI"
                    ? "T"
                    : "X"
            )
            .join("");

    const target =
        pattern.slice(
            0,
            patternLength
        );

    let tai = 0;
    let xiu = 0;

    for (
        let i = patternLength;
        i < pattern.length;
        i++
    ) {
        const before =
            pattern.slice(
                i - patternLength,
                i
            );

        if (before !== target) {
            continue;
        }

        if (pattern[i] === "T") {
            tai++;
        } else {
            xiu++;
        }
    }

    const samples =
        tai + xiu;

    if (samples < 3) {
        return null;
    }

    const pTai =
        bayesianProbability(
            tai,
            xiu
        );

    return {
        probability: pTai,
        samples,
        tai,
        xiu
    };
}

// ======================================================
// MARKOV PROBABILITY
// ======================================================

function markovProbability(results) {

    if (results.length < 6) {
        return null;
    }

    let tt = 0;
    let tx = 0;
    let xt = 0;
    let xx = 0;

    for (
        let i = 0;
        i < results.length - 1;
        i++
    ) {
        const a = results[i];
        const b = results[i + 1];

        if (a === "TAI" && b === "TAI") tt++;
        if (a === "TAI" && b === "XIU") tx++;
        if (a === "XIU" && b === "TAI") xt++;
        if (a === "XIU" && b === "XIU") xx++;
    }

    if (results[0] === "TAI") {

        const samples = tt + tx;

        if (samples < 3) {
            return null;
        }

        return {
            probability:
                bayesianProbability(
                    tt,
                    tx
                ),

            samples
        };
    }

    const samples = xt + xx;

    if (samples < 3) {
        return null;
    }

    return {
        probability:
            bayesianProbability(
                xt,
                xx
            ),

        samples
    };
}

// ======================================================
// STREAK PROBABILITY
// ======================================================

function streakProbability(results) {

    if (results.length < 6) {
        return null;
    }

    let streak = 1;

    for (
        let i = 1;
        i < results.length;
        i++
    ) {
        if (
            results[i] ===
            results[0]
        ) {
            streak++;
        } else {
            break;
        }
    }

    if (streak < 2) {
        return null;
    }

    let continueWins = 0;
    let reverseWins = 0;

    for (
        let i = 0;
        i < results.length - streak;
        i++
    ) {
        let same = true;

        for (
            let j = 0;
            j < streak;
            j++
        ) {
            if (
                results[i + j] !==
                results[0]
            ) {
                same = false;
                break;
            }
        }

        if (!same) continue;

        const next =
            results[i + streak];

        if (
            next === results[0]
        ) {
            continueWins++;
        } else {
            reverseWins++;
        }
    }

    const samples =
        continueWins +
        reverseWins;

    if (samples < 3) {
        return null;
    }

    const pContinue =
        bayesianProbability(
            continueWins,
            reverseWins
        );

    return {
        probability:
            results[0] === "TAI"
                ? pContinue
                : 1 - pContinue,

        samples,
        streak
    };
}

// ======================================================
// RECENT PROBABILITY
// ======================================================

function recentProbability(
    results,
    size
) {
    if (results.length < size) {
        return null;
    }

    const arr =
        results.slice(0, size);

    let tai = 0;
    let xiu = 0;

    for (const r of arr) {
        if (r === "TAI") tai++;
        else xiu++;
    }

    return {
        probability:
            bayesianProbability(
                tai,
                xiu
            ),

        samples: size
    };
}

// ======================================================
// ALTERNATING PROBABILITY
// ======================================================

function alternatingProbability(results) {

    if (results.length < 8) {
        return null;
    }

    const current =
        results
            .slice(0, 6)
            .map(x =>
                x === "TAI"
                    ? "T"
                    : "X"
            )
            .join("");

    let tai = 0;
    let xiu = 0;

    const pattern =
        results
            .map(x =>
                x === "TAI"
                    ? "T"
                    : "X"
            )
            .join("");

    for (
        let i = 6;
        i < pattern.length;
        i++
    ) {
        const before =
            pattern.slice(
                i - 6,
                i
            );

        if (before !== current) {
            continue;
        }

        if (pattern[i] === "T") {
            tai++;
        } else {
            xiu++;
        }
    }

    const samples =
        tai + xiu;

    if (samples < 3) {
        return null;
    }

    return {
        probability:
            bayesianProbability(
                tai,
                xiu
            ),

        samples
    };
}

// ======================================================
// POINT PROBABILITY
// ======================================================

function pointProbability(history) {

    if (history.length < 8) {
        return null;
    }

    let tai = 0;
    let xiu = 0;

    const recent =
        history.slice(0, 20);

    for (const item of recent) {

        const point =
            Number(item.point);

        if (!Number.isFinite(point)) {
            continue;
        }

        if (point >= 11) {
            tai++;
        } else {
            xiu++;
        }
    }

    const samples =
        tai + xiu;

    if (samples < 5) {
        return null;
    }

    return {
        probability:
            bayesianProbability(
                tai,
                xiu
            ),

        samples
    };
}

// ======================================================
// WEIGHTED PROBABILITY COMBINATION
// ======================================================

function combineProbabilities(signals) {

    if (!signals.length) {
        return null;
    }

    let weightedLogOdds = 0;
    let totalWeight = 0;

    for (const signal of signals) {

        let p =
            clamp(
                signal.probability,
                0.05,
                0.95
            );

        // độ tin cậy của signal
        const sampleWeight =
            Math.min(
                1.5,
                Math.log2(
                    signal.samples + 1
                ) / 3
            );

        const weight =
            signal.weight *
            sampleWeight;

        const logOdds =
            Math.log(
                p / (1 - p)
            );

        weightedLogOdds +=
            logOdds * weight;

        totalWeight += weight;
    }

    if (!totalWeight) {
        return null;
    }

    const finalLogOdds =
        weightedLogOdds /
        totalWeight;

    const probability =
        1 /
        (
            1 +
            Math.exp(
                -finalLogOdds
            )
        );

    return clamp(
        probability,
        0.01,
        0.99
    );
}

// ======================================================
// CALIBRATION FROM REAL RESULTS
// ======================================================

function calibrateProbability(
    probability,
    learning
) {

    if (
        !Array.isArray(learning) ||
        learning.length < 10
    ) {
        return probability;
    }

    // tìm các dự đoán gần xác suất hiện tại
    const tolerance = 0.10;

    const matched =
        learning.filter(item =>
            Math.abs(
                item.probability -
                probability
            ) <= tolerance
        );

    if (matched.length < 8) {
        return probability;
    }

    let wins = 0;

    for (const item of matched) {
        if (item.win) {
            wins++;
        }
    }

    const empirical =
        bayesianProbability(
            wins,
            matched.length - wins,
            2,
            2
        );

    // Không để calibration phá quá mạnh
    return (
        probability * 0.55 +
        empirical * 0.45
    );
}

// ======================================================
// TX V2 — PROBABILITY + SELF LEARNING
// ======================================================

function algorithmTX(
    history,
    learning = []
) {

    if (
        !Array.isArray(history) ||
        history.length < 10
    ) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Chưa đủ dữ liệu"
        };
    }

    const data =
        history
            .slice(0, MAX_HISTORY)
            .filter(
                x =>
                    x.result === "TAI" ||
                    x.result === "XIU"
            );

    if (data.length < 10) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Chưa đủ dữ liệu"
        };
    }

    const results =
        data.map(x => x.result);

    const signals = [];

    function add(
        name,
        probability,
        samples,
        weight
    ) {
        if (
            !Number.isFinite(probability) ||
            !Number.isFinite(samples)
        ) {
            return;
        }

        signals.push({
            name,
            probability:
                clamp(
                    probability,
                    0.05,
                    0.95
                ),
            samples,
            weight
        });
    }

    // --------------------------------------------------
    // RECENT 10
    // --------------------------------------------------

    const r10 =
        recentProbability(
            results,
            10
        );

    if (r10) {
        add(
            "Recent10",
            r10.probability,
            r10.samples,
            1.0
        );
    }

    // --------------------------------------------------
    // RECENT 20
    // --------------------------------------------------

    const r20 =
        recentProbability(
            results,
            20
        );

    if (r20) {
        add(
            "Recent20",
            r20.probability,
            r20.samples,
            0.75
        );
    }

    // --------------------------------------------------
    // RECENT 50
    // --------------------------------------------------

    const r50 =
        recentProbability(
            results,
            50
        );

    if (r50) {
        add(
            "Recent50",
            r50.probability,
            r50.samples,
            0.45
        );
    }

    // --------------------------------------------------
    // PATTERN 2 → 10
    // --------------------------------------------------

    for (
        let len = 2;
        len <= 10;
        len++
    ) {

        const result =
            patternProbability(
                results,
                len
            );

        if (!result) {
            continue;
        }

        const weight =
            len >= 6
                ? 1.20
                : 0.85;

        add(
            `Pattern${len}`,
            result.probability,
            result.samples,
            weight
        );
    }

    // --------------------------------------------------
    // MARKOV
    // --------------------------------------------------

    const markov =
        markovProbability(
            results
        );

    if (markov) {
        add(
            "Markov",
            markov.probability,
            markov.samples,
            1.15
        );
    }

    // --------------------------------------------------
    // STREAK
    // --------------------------------------------------

    const streak =
        streakProbability(
            results
        );

    if (streak) {
        add(
            "Streak",
            streak.probability,
            streak.samples,
            0.85
        );
    }

    // --------------------------------------------------
    // ALTERNATING
    // --------------------------------------------------

    const alternating =
        alternatingProbability(
            results
        );

    if (alternating) {
        add(
            "Alternating",
            alternating.probability,
            alternating.samples,
            0.80
        );
    }

    // --------------------------------------------------
    // POINT
    // --------------------------------------------------

    const point =
        pointProbability(
            data
        );

    if (point) {
        add(
            "Point",
            point.probability,
            point.samples,
            0.30
        );
    }

    // --------------------------------------------------
    // COMBINE
    // --------------------------------------------------

    const rawProbability =
        combineProbabilities(
            signals
        );

    if (
        rawProbability === null
    ) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Không đủ tín hiệu"
        };
    }

    // --------------------------------------------------
    // SELF LEARNING CALIBRATION
    // --------------------------------------------------

    const calibrated =
        calibrateProbability(
            rawProbability,
            learning
        );

    const prediction =
        calibrated >= 0.5
            ? "TAI"
            : "XIU";

    const confidence =
        Math.round(
            Math.max(
                calibrated,
                1 - calibrated
            ) * 10000
        ) / 100;

    // --------------------------------------------------
    // SIGNAL SUMMARY
    // --------------------------------------------------

    const signalTai =
        signals.filter(
            s =>
                s.probability >= 0.5
        ).length;

    const signalXiu =
        signals.filter(
            s =>
                s.probability < 0.5
        ).length;

    return {
        prediction,

        confidence,

        probability: {
            tai:
                Math.round(
                    calibrated * 10000
                ) / 100,

            xiu:
                Math.round(
                    (1 - calibrated) *
                    10000
                ) / 100
        },

        rawProbability:
            Math.round(
                rawProbability * 10000
            ) / 100,

        signals: signals.map(s => ({
            name: s.name,

            probability:
                Math.round(
                    s.probability *
                    10000
                ) / 100,

            samples: s.samples,

            weight: s.weight
        })),

        consensus: {
            tai: signalTai,
            xiu: signalXiu
        },

        pattern:
            results
                .map(x =>
                    x === "TAI"
                        ? "T"
                        : "X"
                )
                .join("")
                .slice(0, 20)
    };
}

// ======================================================
// PREDICTION RESULT / SELF LEARNING
// ======================================================

function processOldPrediction(
    type,
    latest
) {

    const s = state[type];

    if (
        !s.current ||
        s.current.id === latest.id
    ) {
        return;
    }

    const actual =
        latest.result;

    const prediction =
        s.current.prediction;

    if (!prediction) {
        return;
    }

    const win =
        prediction === actual;

    if (win) {
        s.wins++;
    } else {
        s.losses++;
    }

    s.predictions.unshift({
        ...s.current,

        actual,

        status:
            win
                ? "WIN"
                : "LOSS"
    });

    s.predictions =
        s.predictions.slice(
            0,
            MAX_HISTORY
        );

    // Chỉ TX có self-learning
    if (type === "tx") {

        s.learning.unshift({

            probability:
                s.current
                    .probability
                    ?.tai !== undefined

                    ? s.current.probability.tai / 100

                    : s.current.confidence / 100,

            prediction,

            actual,

            win,

            timestamp:
                Date.now()
        });

        s.learning =
            s.learning.slice(
                0,
                MAX_LEARNING
            );
    }
}

// ======================================================
// UPDATE TX
// ======================================================

async function updateTX() {

    try {

        const response =
            await fetch(API_TX);

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const json =
            await response.json();

        const list =
            parseTX(json);

        if (!list.length) {
            return;
        }

        const latest =
            list[0];

        if (
            state.tx.lastId ===
            latest.id
        ) {
            return;
        }

        // Chấm dự đoán phiên trước
        processOldPrediction(
            "tx",
            latest
        );

        state.tx.lastId =
            latest.id;

        state.tx.history =
            list.slice(
                0,
                MAX_HISTORY
            );

        const result =
            algorithmTX(
                state.tx.history,
                state.tx.learning
            );

        state.tx.current = {
            id: latest.id,

            prediction:
                result.prediction,

            confidence:
                result.confidence,

            probability:
                result.probability,

            analysis:
                result,

            createdAt:
                new Date().toISOString()
        };

        console.log(
            `[TX] #${latest.id}`,
            `=>`,
            result.prediction,
            `${result.confidence}%`,
            `WIN=${state.tx.wins}`,
            `LOSS=${state.tx.losses}`
        );

    } catch (error) {

        console.error(
            "[TX ERROR]",
            error.message
        );
    }
}

// ======================================================
// TXMD5 PARSER
// ======================================================

function parseTXMD5(data) {

    const list =
        Array.isArray(data?.list)
            ? data.list
            : [];

    return list
        .map(item => ({
            id:
                item.id ??
                item._id ??
                item.phien,

            result:
                normalizeResult(
                    item.resultTruyenThong ??
                    item.result ??
                    item.ket_qua
                ),

            dices:
                Array.isArray(item.dices)
                    ? item.dices
                    : Array.isArray(item.xuc_xac)
                        ? item.xuc_xac
                        : [],

            point:
                Number(
                    item.point ??
                    item.tong ??
                    0
                )
        }))
        .filter(x => x.result);
}

// ======================================================
// TXMD5 — GIỮ NGUYÊN
// ======================================================

function algorithmTXMD5(history) {

    if (history.length < 5) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Chưa đủ dữ liệu"
        };
    }

    const data =
        history.slice(0, 50);

    const results =
        data.map(x => x.result);

    let T = 0;
    let X = 0;

    // Weighted Recent
    for (
        let i = 0;
        i < results.length;
        i++
    ) {

        const weight =
            Math.max(1, 20 - i);

        if (results[i] === "TAI") {
            T += weight;
        }

        if (results[i] === "XIU") {
            X += weight;
        }
    }

    // Run Analysis
    let run = 1;

    for (
        let i = 1;
        i < results.length;
        i++
    ) {

        if (
            results[i] ===
            results[0]
        ) {
            run++;
        } else {
            break;
        }
    }

    if (run >= 2) {

        if (results[0] === "TAI") {
            X += run * 5;
        } else {
            T += run * 5;
        }
    }

    // Pair Frequency
    const pairs = {
        TT: 0,
        TX: 0,
        XT: 0,
        XX: 0
    };

    for (
        let i = 0;
        i < results.length - 1;
        i++
    ) {

        const a =
            results[i] === "TAI"
                ? "T"
                : "X";

        const b =
            results[i + 1] === "TAI"
                ? "T"
                : "X";

        pairs[a + b]++;
    }

    const first =
        results[0] === "TAI"
            ? "T"
            : "X";

    if (first === "T") {

        if (pairs.TT > pairs.TX) {
            T += 12;
        } else {
            X += 12;
        }

    } else {

        if (pairs.XX > pairs.XT) {
            X += 12;
        } else {
            T += 12;
        }
    }

    // Pattern 3
    const pattern =
        results
            .map(x =>
                x === "TAI"
                    ? "T"
                    : "X"
            )
            .join("");

    for (
        let i = 0;
        i <= pattern.length - 4;
        i++
    ) {

        const p =
            pattern.slice(
                i,
                i + 3
            );

        const next =
            pattern[i + 3];

        if (p === "TTT") {
            next === "T"
                ? T += 4
                : X += 4;
        }

        if (p === "XXX") {
            next === "X"
                ? X += 4
                : T += 4;
        }

        if (p === "TXT") {
            T += 4;
        }

        if (p === "XTX") {
            X += 4;
        }
    }

    // Point / Dice
    const latest =
        data[0];

    if (latest) {

        const point =
            Number(latest.point);

        if (point >= 11) {
            T += 7;
        }

        if (point <= 10) {
            X += 7;
        }

        if (
            Array.isArray(latest.dices) &&
            latest.dices.length === 3
        ) {

            const sum =
                latest.dices.reduce(
                    (a, b) =>
                        a + Number(b),
                    0
                );

            if (sum >= 11) {
                T += 5;
            } else {
                X += 5;
            }
        }
    }

    const total =
        T + X;

    if (!total) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Không có tín hiệu"
        };
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    const confidence =
        Math.round(
            Math.max(T, X) /
            total *
            100
        );

    return {
        prediction,
        confidence: clamp(
            confidence,
            50,
            97
        ),
        scoreT: T,
        scoreX: X,
        pattern:
            pattern.slice(0, 20)
    };
}

// ======================================================
// UPDATE TXMD5
// ======================================================

async function updateTXMD5() {

    try {

        const response =
            await fetch(API_TXMD5);

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const json =
            await response.json();

        const list =
            parseTXMD5(json);

        if (!list.length) {
            return;
        }

        const latest =
            list[0];

        if (
            state.txmd5.lastId ===
            latest.id
        ) {
            return;
        }

        processOldPrediction(
            "txmd5",
            latest
        );

        state.txmd5.lastId =
            latest.id;

        state.txmd5.history =
            list.slice(
                0,
                MAX_HISTORY
            );

        const result =
            algorithmTXMD5(
                state.txmd5.history
            );

        state.txmd5.current = {
            id: latest.id,

            prediction:
                result.prediction,

            confidence:
                result.confidence,

            analysis:
                result,

            createdAt:
                new Date().toISOString()
        };

        console.log(
            `[TXMD5] #${latest.id}`,
            `=>`,
            result.prediction,
            `${result.confidence}%`,
            `WIN=${state.txmd5.wins}`,
            `LOSS=${state.txmd5.losses}`
        );

    } catch (error) {

        console.error(
            "[TXMD5 ERROR]",
            error.message
        );
    }
}

// ======================================================
// LOOP
// ======================================================

async function loopTX() {

    while (true) {

        await updateTX();

        await sleep(
            INTERVAL
        );
    }
}

async function loopTXMD5() {

    while (true) {

        await updateTXMD5();

        await sleep(
            INTERVAL
        );
    }
}

// ======================================================
// API
// ======================================================

app.get("/", (req, res) => {

    res.json({
        status: "online",

        apis: {
            tx: API_TX,
            txmd5: API_TXMD5
        },

        algorithm: {
            tx:
                "Probability + Bayesian + Self Learning",
            txmd5:
                "Original"
        }
    });
});

// ------------------------------------------------------
// TX
// ------------------------------------------------------

app.get("/api/tx", (req, res) => {

    res.json({
        api: API_TX,

        current:
            state.tx.current,

        wins:
            state.tx.wins,

        losses:
            state.tx.losses,

        total:
            state.tx.wins +
            state.tx.losses,

        winrate:
            (
                state.tx.wins +
                state.tx.losses
            )
                ? Number(
                    (
                        state.tx.wins /
                        (
                            state.tx.wins +
                            state.tx.losses
                        )
                    ) * 100
                ).toFixed(2)
                : "0.00",

        learningSamples:
            state.tx.learning.length,

        history:
            state.tx.history,

        predictions:
            state.tx.predictions
    });
});

// ------------------------------------------------------
// TXMD5
// ------------------------------------------------------

app.get(
    "/api/txmd5",
    (req, res) => {

        res.json({

            api:
                API_TXMD5,

            current:
                state.txmd5.current,

            wins:
                state.txmd5.wins,

            losses:
                state.txmd5.losses,

            total:
                state.txmd5.wins +
                state.txmd5.losses,

            winrate:
                (
                    state.txmd5.wins +
                    state.txmd5.losses
                )
                    ? Number(
                        (
                            state.txmd5.wins /
                            (
                                state.txmd5.wins +
                                state.txmd5.losses
                            )
                        ) * 100
                    ).toFixed(2)
                    : "0.00",

            history:
                state.txmd5.history,

            predictions:
                state.txmd5.predictions
        });
    }
);

// ------------------------------------------------------
// STATUS
// ------------------------------------------------------

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            tx: {

                lastId:
                    state.tx.lastId,

                prediction:
                    state.tx.current
                        ?.prediction,

                confidence:
                    state.tx.current
                        ?.confidence,

                probability:
                    state.tx.current
                        ?.probability,

                wins:
                    state.tx.wins,

                losses:
                    state.tx.losses,

                learning:
                    state.tx.learning.length
            },

            txmd5: {

                lastId:
                    state.txmd5.lastId,

                prediction:
                    state.txmd5.current
                        ?.prediction,

                confidence:
                    state.txmd5.current
                        ?.confidence,

                wins:
                    state.txmd5.wins,

                losses:
                    state.txmd5.losses
            }
        });
    }
);

// ======================================================
// START
// ======================================================

app.listen(
    PORT,
    () => {

        console.log(
            `Server running: ${PORT}`
        );

        console.log(
            "TX: Probability + Bayesian + Self Learning"
        );

        console.log(
            "TXMD5: Original Algorithm"
        );

        loopTX();
        loopTXMD5();
    }
);
