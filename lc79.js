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

// ======================================================
// STATE
// ======================================================

const state = {
    tx: {
        history: [],
        predictions: [],
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

function normalizeResult(value) {

    if (!value) return null;

    const v =
        String(value)
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

// ======================================================
// PARSER
// ======================================================

function parseAPI(data) {

    const list =
        Array.isArray(data?.list)
            ? data.list
            : [];

    return list
        .map(item => {

            const dices =
                Array.isArray(item.dices)
                    ? item.dices
                    : [];

            const point =
                Number(
                    item.point
                );

            return {
                id: item.id,

                _id: item._id,

                result:
                    normalizeResult(
                        item.resultTruyenThong
                    ),

                dices,

                point:
                    Number.isFinite(point)
                        ? point
                        : dices.reduce(
                            (a, b) =>
                                a + Number(b),
                            0
                        )
            };
        })
        .filter(
            item => item.result
        );
}

// ======================================================
// SAME ALGORITHM FOR BOTH API
// ======================================================

function algorithm(history) {

    if (
        !Array.isArray(history) ||
        history.length < 5
    ) {

        return {
            prediction: null,
            confidence: 0,
            scoreT: 0,
            scoreX: 0,
            pattern: "",
            reason: "Chưa đủ dữ liệu"
        };
    }

    const data =
        history
            .slice(0, MAX_HISTORY);

    const results =
        data.map(
            x => x.result
        );

    let T = 0;
    let X = 0;

    // ==================================================
    // 1. WEIGHTED RECENT
    // ==================================================

    for (
        let i = 0;
        i < results.length;
        i++
    ) {

        const weight =
            Math.max(
                1,
                20 - i
            );

        if (
            results[i] ===
            "TAI"
        ) {
            T += weight;
        }

        if (
            results[i] ===
            "XIU"
        ) {
            X += weight;
        }
    }

    // ==================================================
    // 2. RUN ANALYSIS
    // ==================================================

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

        if (
            results[0] ===
            "TAI"
        ) {

            X +=
                run * 5;

        } else {

            T +=
                run * 5;
        }
    }

    // ==================================================
    // 3. PAIR FREQUENCY
    // ==================================================

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

        if (
            pairs.TT >
            pairs.TX
        ) {

            T += 12;

        } else {

            X += 12;
        }

    } else {

        if (
            pairs.XX >
            pairs.XT
        ) {

            X += 12;

        } else {

            T += 12;
        }
    }

    // ==================================================
    // 4. PATTERN 3
    // ==================================================

    const pattern =
        results
            .map(
                x =>
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

        // TTT -> next
        if (p === "TTT") {

            if (next === "T") {

                T += 4;

            } else {

                X += 4;
            }
        }

        // XXX -> next
        if (p === "XXX") {

            if (next === "X") {

                X += 4;

            } else {

                T += 4;
            }
        }

        // TXT
        if (p === "TXT") {
            T += 4;
        }

        // XTX
        if (p === "XTX") {
            X += 4;
        }
    }

    // ==================================================
    // 5. POINT
    // ==================================================

    const latest =
        data[0];

    if (latest) {

        const point =
            Number(
                latest.point
            );

        if (
            Number.isFinite(point)
        ) {

            if (point >= 11) {

                T += 7;

            } else {

                X += 7;
            }
        }
    }

    // ==================================================
    // 6. DICE
    // ==================================================

    if (
        latest &&
        Array.isArray(
            latest.dices
        ) &&
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

    // ==================================================
    // 7. FINAL
    // ==================================================

    const total =
        T + X;

    if (total <= 0) {

        return {
            prediction: null,
            confidence: 0,
            scoreT: T,
            scoreX: X,
            pattern:
                pattern.slice(
                    0,
                    20
                ),
            reason:
                "Không có tín hiệu"
        };
    }

    const prediction =
        T >= X
            ? "TAI"
            : "XIU";

    const confidence =
        Math.round(
            (
                Math.max(T, X) /
                total
            ) * 100
        );

    return {
        prediction,

        confidence,

        scoreT: T,

        scoreX: X,

        pattern:
            pattern.slice(
                0,
                20
            ),

        run,

        pairs,

        reason:
            prediction === "TAI"
                ? `T=${T} > X=${X}`
                : `X=${X} > T=${T}`
    };
}

// ======================================================
// PROCESS OLD PREDICTION
// ======================================================

function processResult(
    type,
    latest
) {

    const s =
        state[type];

    if (
        !s.current
    ) {
        return;
    }

    if (
        s.current.id ===
        latest.id
    ) {
        return;
    }

    const prediction =
        s.current.prediction;

    if (!prediction) {
        return;
    }

    const actual =
        latest.result;

    const win =
        prediction === actual;

    if (win) {

        s.wins++;

    } else {

        s.losses++;
    }

    s.predictions.unshift({

        id:
            s.current.id,

        prediction,

        confidence:
            s.current.confidence,

        actual,

        status:
            win
                ? "WIN"
                : "LOSS",

        scoreT:
            s.current.scoreT,

        scoreX:
            s.current.scoreX,

        pattern:
            s.current.pattern,

        time:
            s.current.time
    });

    s.predictions =
        s.predictions.slice(
            0,
            MAX_HISTORY
        );
}

// ======================================================
// UPDATE API
// ======================================================

async function updateAPI(
    type,
    url
) {

    try {

        const response =
            await fetch(url);

        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const json =
            await response.json();

        const list =
            parseAPI(json);

        if (
            !list.length
        ) {
            return;
        }

        const latest =
            list[0];

        const s =
            state[type];

        // Không có phiên mới
        if (
            s.lastId ===
            latest.id
        ) {
            return;
        }

        // Chấm phiên dự đoán trước
        processResult(
            type,
            latest
        );

        // Update history
        s.lastId =
            latest.id;

        s.history =
            list.slice(
                0,
                MAX_HISTORY
            );

        // Cùng 1 thuật toán
        const result =
            algorithm(
                s.history
            );

        s.current = {

            id:
                latest.id,

            prediction:
                result.prediction,

            confidence:
                result.confidence,

            scoreT:
                result.scoreT,

            scoreX:
                result.scoreX,

            pattern:
                result.pattern,

            run:
                result.run,

            pairs:
                result.pairs,

            reason:
                result.reason,

            time:
                new Date()
                    .toISOString()
        };

        console.log(
            `[${type.toUpperCase()}]`,
            `#${latest.id}`,
            "→",
            result.prediction,
            `${result.confidence}%`,
            `T=${result.scoreT}`,
            `X=${result.scoreX}`,
            `WIN=${s.wins}`,
            `LOSS=${s.losses}`
        );

    } catch (error) {

        console.error(
            `[${type.toUpperCase()} ERROR]`,
            error.message
        );
    }
}

// ======================================================
// LOOP TX
// ======================================================

async function loopTX() {

    while (true) {

        await updateAPI(
            "tx",
            API_TX
        );

        await sleep(
            INTERVAL
        );
    }
}

// ======================================================
// LOOP TXMD5
// ======================================================

async function loopTXMD5() {

    while (true) {

        await updateAPI(
            "txmd5",
            API_TXMD5
        );

        await sleep(
            INTERVAL
        );
    }
}

// ======================================================
// WINRATE
// ======================================================

function getStats(type) {

    const s =
        state[type];

    const total =
        s.wins +
        s.losses;

    const winrate =
        total > 0
            ? Number(
                (
                    s.wins /
                    total *
                    100
                ).toFixed(2)
            )
            : 0;

    return {

        wins:
            s.wins,

        losses:
            s.losses,

        total,

        winrate
    };
}

// ======================================================
// HOME
// ======================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            status:
                "online",

            message:
                "2 API - SAME ALGORITHM",

            interval:
                INTERVAL,

            history:
                MAX_HISTORY,

            algorithms: {

                tx:
                    "SAME",

                txmd5:
                    "SAME"
            }
        });
    }
);

// ======================================================
// STATUS
// ======================================================

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            tx: {

                api:
                    API_TX,

                lastId:
                    state.tx.lastId,

                prediction:
                    state.tx.current
                        ?.prediction ??
                    null,

                confidence:
                    state.tx.current
                        ?.confidence ??
                    0,

                scoreT:
                    state.tx.current
                        ?.scoreT ??
                    0,

                scoreX:
                    state.tx.current
                        ?.scoreX ??
                    0,

                pattern:
                    state.tx.current
                        ?.pattern ??
                    "",

                ...getStats(
                    "tx"
                )
            },

            txmd5: {

                api:
                    API_TXMD5,

                lastId:
                    state.txmd5.lastId,

                prediction:
                    state.txmd5.current
                        ?.prediction ??
                    null,

                confidence:
                    state.txmd5.current
                        ?.confidence ??
                    0,

                scoreT:
                    state.txmd5.current
                        ?.scoreT ??
                    0,

                scoreX:
                    state.txmd5.current
                        ?.scoreX ??
                    0,

                pattern:
                    state.txmd5.current
                        ?.pattern ??
                    "",

                ...getStats(
                    "txmd5"
                )
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

            api:
                API_TX,

            current:
                state.tx.current,

            stats:
                getStats(
                    "tx"
                ),

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

            api:
                API_TXMD5,

            current:
                state.txmd5.current,

            stats:
                getStats(
                    "txmd5"
                ),

            history:
                state.txmd5.history,

            predictions:
                state.txmd5.predictions
        });
    }
);

// ======================================================
// HISTORY
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
// START SERVER
// ======================================================

app.listen(
    PORT,
    () => {

        console.log(
            "===================================="
        );

        console.log(
            "  2 API SAME ALGORITHM"
        );

        console.log(
            "===================================="
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `INTERVAL: ${INTERVAL}ms`
        );

        console.log(
            `HISTORY: ${MAX_HISTORY}`
        );

        console.log(
            "TX:",
            API_TX
        );

        console.log(
            "TXMD5:",
            API_TXMD5
        );

        console.log(
            "===================================="
        );

        loopTX();

        loopTXMD5();
    }
);
