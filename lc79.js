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

    const v = String(value).toUpperCase();

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
    return result === "TAI" ? "XIU" : "TAI";
}

function getPattern(history) {
    return history
        .map(x => normalizeResult(x.result))
        .filter(Boolean)
        .map(x => x === "TAI" ? "T" : "X")
        .join("");
}

function clamp(num, min, max) {
    return Math.max(min, Math.min(max, num));
}

// ======================================================
// API PARSER
// ======================================================

// API 1:
// {
//   id,
//   resultTruyenThong,
//   dices,
//   point
// }

function parseTX(data) {
    const list = Array.isArray(data?.list)
        ? data.list
        : [];

    return list
        .map(item => ({
            id: item.id,
            result: normalizeResult(item.resultTruyenThong),
            dices: Array.isArray(item.dices)
                ? item.dices
                : [],
            point: Number(item.point) || 0
        }))
        .filter(x => x.result);
}


// API 2
// Tự dò nhiều format phổ biến

function parseTXMD5(data) {
    const list = Array.isArray(data?.list)
        ? data.list
        : [];

    return list
        .map(item => {

            const result =
                normalizeResult(
                    item.resultTruyenThong ??
                    item.result ??
                    item.ket_qua ??
                    item.result_md5
                );

            const dices =
                Array.isArray(item.dices)
                    ? item.dices
                    : Array.isArray(item.xuc_xac)
                        ? item.xuc_xac
                        : [];

            const point =
                Number(
                    item.point ??
                    item.tong ??
                    0
                );

            return {
                id: item.id ?? item._id ?? item.phien,
                result,
                dices,
                point,
                raw: item
            };
        })
        .filter(x => x.result);
}

// ======================================================
// ALGORITHM #1
// API TX
// ======================================================

function algorithmTX(history) {

    if (history.length < 5) {
        return {
            prediction: null,
            confidence: 0,
            reason: "Chưa đủ dữ liệu"
        };
    }

    const recent = history.slice(0, 50);

    const results = recent.map(x => x.result);

    let scoreT = 0;
    let scoreX = 0;

    // --------------------------------------------------
    // 1. TẦN SUẤT
    // --------------------------------------------------

    const countT =
        results.filter(x => x === "TAI").length;

    const countX =
        results.filter(x => x === "XIU").length;

    if (countT > countX) {
        scoreX += 8;
    } else if (countX > countT) {
        scoreT += 8;
    }

    // --------------------------------------------------
    // 2. CẦU BỆT
    // --------------------------------------------------

    let streak = 1;
    let streakResult = results[0];

    for (let i = 1; i < results.length; i++) {
        if (results[i] === results[0]) {
            streak++;
        } else {
            break;
        }
    }

    if (streak >= 3) {
        scoreT += streakResult === "XIU"
            ? 12
            : 0;

        scoreX += streakResult === "TAI"
            ? 12
            : 0;
    }

    // --------------------------------------------------
    // 3. CẦU 1-1
    // --------------------------------------------------

    let alternating = true;

    for (let i = 1; i < Math.min(8, results.length); i++) {
        if (results[i] === results[i - 1]) {
            alternating = false;
            break;
        }
    }

    if (alternating) {
        scoreT += results[0] === "XIU" ? 15 : 0;
        scoreX += results[0] === "TAI" ? 15 : 0;
    }

    // --------------------------------------------------
    // 4. MARKOV
    // --------------------------------------------------

    let tt = 0;
    let tx = 0;
    let xt = 0;
    let xx = 0;

    for (let i = 0; i < results.length - 1; i++) {

        const a = results[i];
        const b = results[i + 1];

        if (a === "TAI" && b === "TAI") tt++;
        if (a === "TAI" && b === "XIU") tx++;
        if (a === "XIU" && b === "TAI") xt++;
        if (a === "XIU" && b === "XIU") xx++;
    }

    if (results[0] === "TAI") {

        if (tt > tx) scoreT += 15;
        else if (tx > tt) scoreX += 15;

    } else {

        if (xx > xt) scoreX += 15;
        else if (xt > xx) scoreT += 15;
    }

    // --------------------------------------------------
    // 5. PATTERN MATCH
    // --------------------------------------------------

    const pattern =
        results
            .map(x => x === "TAI" ? "T" : "X")
            .join("");

    for (let len = 2; len <= 8; len++) {

        if (pattern.length <= len) continue;

        const target =
            pattern.slice(0, len);

        let nextT = 0;
        let nextX = 0;

        for (
            let i = len;
            i < pattern.length;
            i++
        ) {

            const before =
                pattern.slice(i - len, i);

            if (before === target) {

                if (pattern[i] === "T") nextT++;
                if (pattern[i] === "X") nextX++;
            }
        }

        if (nextT + nextX >= 2) {

            if (nextT > nextX) {
                scoreT += 10;
            } else if (nextX > nextT) {
                scoreX += 10;
            }
        }
    }

    // --------------------------------------------------
    // 6. ĐIỂM XÚC XẮC
    // --------------------------------------------------

    const latest = recent[0];

    if (latest && latest.point) {

        if (latest.point >= 11) {
            scoreX += 5;
        } else if (latest.point <= 10) {
            scoreT += 5;
        }
    }

    // --------------------------------------------------
    // FINAL
    // --------------------------------------------------

    if (scoreT === 0 && scoreX === 0) {

        return {
            prediction: null,
            confidence: 0,
            reason: "Không rõ cầu"
        };
    }

    const prediction =
        scoreT >= scoreX
            ? "TAI"
            : "XIU";

    const total =
        scoreT + scoreX;

    const confidence =
        Math.round(
            (Math.max(scoreT, scoreX) / total) * 100
        );

    return {
        prediction,
        confidence: clamp(confidence, 50, 97),
        scoreT,
        scoreX,
        pattern: pattern.slice(0, 20)
    };
}

// ======================================================
// ALGORITHM #2
// API TXMD5
// HOÀN TOÀN ĐỘC LẬP
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

    // --------------------------------------------------
    // 1. WEIGHTED RECENT
    // --------------------------------------------------

    for (let i = 0; i < results.length; i++) {

        const weight =
            Math.max(1, 20 - i);

        if (results[i] === "TAI") {
            T += weight;
        }

        if (results[i] === "XIU") {
            X += weight;
        }
    }

    // --------------------------------------------------
    // 2. RUN ANALYSIS
    // --------------------------------------------------

    let run = 1;

    for (
        let i = 1;
        i < results.length;
        i++
    ) {

        if (results[i] === results[0]) {
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

    // --------------------------------------------------
    // 3. PAIR FREQUENCY
    // --------------------------------------------------

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

    // --------------------------------------------------
    // 4. PATTERN 3
    // --------------------------------------------------

    const pattern =
        results
            .map(x => x === "TAI" ? "T" : "X")
            .join("");

    for (let i = 0; i <= pattern.length - 4; i++) {

        const p =
            pattern.slice(i, i + 3);

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

    // --------------------------------------------------
    // 5. DICE / POINT
    // --------------------------------------------------

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
                    (a, b) => a + Number(b),
                    0
                );

            if (sum >= 11) {
                T += 5;
            } else {
                X += 5;
            }
        }
    }

    // --------------------------------------------------
    // FINAL
    // --------------------------------------------------

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
        confidence: clamp(confidence, 50, 97),
        scoreT: T,
        scoreX: X,
        pattern: pattern.slice(0, 20)
    };
}

// ======================================================
// UPDATE PREDICTION
// ======================================================

function processPrediction(type, latest) {

    const s = state[type];

    // Chấm dự đoán cũ bằng kết quả mới
    if (
        s.current &&
        s.current.id !== latest.id
    ) {

        if (
            s.current.prediction ===
            latest.result
        ) {
            s.wins++;
            s.current.status = "WIN";
        } else {
            s.losses++;
            s.current.status = "LOSS";
        }

        s.predictions.unshift({
            ...s.current
        });

        s.predictions =
            s.predictions.slice(
                0,
                MAX_HISTORY
            );
    }
}

// ======================================================
// FETCH TX
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

        const data =
            await response.json();

        const list =
            parseTX(data);

        if (!list.length) return;

        const latest =
            list[0];

        if (
            state.tx.lastId ===
            latest.id
        ) {
            return;
        }

        processPrediction(
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
                state.tx.history
            );

        state.tx.current = {
            id: latest.id,
            prediction:
                result.prediction,
            confidence:
                result.confidence,
            createdAt:
                new Date().toISOString(),
            analysis:
                result
        };

        console.log(
            `[TX] #${latest.id}`,
            `→`,
            result.prediction,
            `${result.confidence}%`,
            `WIN=${state.tx.wins}`,
            `LOSS=${state.tx.losses}`
        );

    } catch (err) {

        console.error(
            "[TX ERROR]",
            err.message
        );
    }
}

// ======================================================
// FETCH TXMD5
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

        const data =
            await response.json();

        const list =
            parseTXMD5(data);

        if (!list.length) return;

        const latest =
            list[0];

        if (
            state.txmd5.lastId ===
            latest.id
        ) {
            return;
        }

        processPrediction(
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
            createdAt:
                new Date().toISOString(),
            analysis:
                result
        };

        console.log(
            `[TXMD5] #${latest.id}`,
            `→`,
            result.prediction,
            `${result.confidence}%`,
            `WIN=${state.txmd5.wins}`,
            `LOSS=${state.txmd5.losses}`
        );

    } catch (err) {

        console.error(
            "[TXMD5 ERROR]",
            err.message
        );
    }
}

// ======================================================
// LOOP
// ======================================================

async function loopTX() {

    while (true) {

        await updateTX();

        await sleep(INTERVAL);
    }
}

async function loopTXMD5() {

    while (true) {

        await updateTXMD5();

        await sleep(INTERVAL);
    }
}

// ======================================================
// API SERVER
// ======================================================

app.get("/", (req, res) => {

    res.json({
        status: "online",
        service: "2 API Algorithm Tester",
        apis: {
            tx: API_TX,
            txmd5: API_TXMD5
        }
    });
});


app.get("/api/tx", (req, res) => {

    res.json({
        api: API_TX,
        current:
            state.tx.current,
        wins:
            state.tx.wins,
        losses:
            state.tx.losses,
        history:
            state.tx.history,
        predictions:
            state.tx.predictions
    });
});


app.get("/api/txmd5", (req, res) => {

    res.json({
        api: API_TXMD5,
        current:
            state.txmd5.current,
        wins:
            state.txmd5.wins,
        losses:
            state.txmd5.losses,
        history:
            state.txmd5.history,
        predictions:
            state.txmd5.predictions
    });
});


app.get("/api/status", (req, res) => {

    res.json({

        tx: {
            lastId:
                state.tx.lastId,
            prediction:
                state.tx.current?.prediction,
            confidence:
                state.tx.current?.confidence,
            wins:
                state.tx.wins,
            losses:
                state.tx.losses
        },

        txmd5: {
            lastId:
                state.txmd5.lastId,
            prediction:
                state.txmd5.current?.prediction,
            confidence:
                state.txmd5.current?.confidence,
            wins:
                state.txmd5.wins,
            losses:
                state.txmd5.losses
        }

    });
});

// ======================================================
// START
// ======================================================

app.listen(PORT, () => {

    console.log(
        `Server running on port ${PORT}`
    );

    console.log(
        "Starting TX algorithm..."
    );

    console.log(
        "Starting TXMD5 algorithm..."
    );

    loopTX();
    loopTXMD5();
});
