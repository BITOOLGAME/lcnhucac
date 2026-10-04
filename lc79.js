
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const STATE_FILE = path.join(__dirname, "stats.json");

let cache = null;
let lastFetch = 0;
let busy = false;

const CACHE_TIME = 3000;

function normalize(value) {
    const v = String(value || "").toUpperCase().trim();

    if (["TAI", "TÀI", "T"].includes(v)) return "T";
    if (["XIU", "XỈU", "X"].includes(v)) return "X";

    return null;
}

function vietnamese(value) {
    return value === "T" ? "Tài" : "Xỉu";
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {
                thang: 0,
                thua: 0,
                pending: null
            };
        }

        return JSON.parse(
            fs.readFileSync(STATE_FILE, "utf8")
        );
    } catch {
        return {
            thang: 0,
            thua: 0,
            pending: null
        };
    }
}

function saveState(state) {
    const temp = STATE_FILE + ".tmp";

    fs.writeFileSync(
        temp,
        JSON.stringify(state, null, 2),
        "utf8"
    );

    fs.renameSync(temp, STATE_FILE);
}

function analyze(history) {
    history = history.filter(
        x => x === "T" || x === "X"
    );

    if (!history.length) {
        return {
            prediction: "X",
            confidence: 50,
            pattern: ""
        };
    }

    const pattern = history.slice(-30).join("");

    const scores = {
        T: 0,
        X: 0
    };

    const weights = {
        frequency: 1,
        pattern: 2,
        transition: 1.5,
        streak: 1.2,
        alternation: 1,
        recency: 1.5
    };

    // CORE 1: Tần suất
    const recent = history.slice(-30);

    for (const side of ["T", "X"]) {
        const count = recent.filter(
            x => x === side
        ).length;

        const probability =
            (count + 1) / (recent.length + 2);

        scores[side] +=
            (probability - 0.5) * weights.frequency;
    }

    // CORE 2: Pattern 2-6 ký tự
    for (let size = 2; size <= 6; size++) {
        if (history.length <= size) continue;

        const key = history.slice(-size).join("");

        let countT = 0;
        let countX = 0;

        for (let i = 0; i < history.length - size; i++) {
            const segment = history
                .slice(i, i + size)
                .join("");

            if (segment === key) {
                if (history[i + size] === "T") {
                    countT++;
                } else {
                    countX++;
                }
            }
        }

        const total = countT + countX;

        if (total > 0) {
            const difference =
                (countT - countX) / (total + 2);

            const factor =
                weights.pattern * size / 6;

            scores.T += difference * factor;
            scores.X -= difference * factor;
        }
    }

    // CORE 3: Chuỗi bệt
    let streak = 1;

    for (let i = history.length - 1; i > 0; i--) {
        if (history[i] === history[i - 1]) {
            streak++;
        } else {
            break;
        }
    }

    const last = history[history.length - 1];
    const opposite = last === "T" ? "X" : "T";

    if (streak >= 3) {
        scores[opposite] +=
            Math.min(0.8, (streak - 2) * 0.12) *
            weights.streak;
    }

    // CORE 4: Chuyển tiếp
    const transitions = {
        T: { T: 0, X: 0 },
        X: { T: 0, X: 0 }
    };

    for (let i = 0; i < history.length - 1; i++) {
        transitions[history[i]][history[i + 1]]++;
    }

    const row = transitions[last];
    const rowTotal = row.T + row.X;

    if (rowTotal > 0) {
        for (const side of ["T", "X"]) {
            const probability =
                (row[side] + 1) / (rowTotal + 2);

            scores[side] +=
                (probability - 0.5) *
                weights.transition;
        }
    }

    // CORE 5: Nhịp luân phiên
    let alternating = 0;

    for (let i = history.length - 1; i > 0; i--) {
        if (history[i] !== history[i - 1]) {
            alternating++;
        } else {
            break;
        }
    }

    if (alternating >= 3) {
        const factor = Math.min(alternating, 6) / 6;

        scores[last] +=
            factor * weights.alternation * 0.25;

        scores[opposite] +=
            factor * weights.alternation * 0.25;
    }

    // CORE 6: Xu hướng gần nhất
    const window = history.slice(-8);

    const diff =
        (window.filter(x => x === "T").length -
         window.filter(x => x === "X").length) /
        window.length;

    scores.T += diff * weights.recency;
    scores.X -= diff * weights.recency;

    // Tổng hợp
    const difference = scores.T - scores.X;

    let prediction;

    if (difference > 0) {
        prediction = "T";
    } else if (difference < 0) {
        prediction = "X";
    } else {
        prediction = opposite;
    }

    const confidence = Number(
        Math.max(
            50,
            Math.min(90, 50 + Math.abs(difference) * 12)
        ).toFixed(2)
    );

    return {
        prediction,
        confidence,
        pattern
    };
}

async function fetchSource() {
    const response = await fetch(SOURCE_API, {
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json"
        },
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(`Source HTTP ${response.status}`);
    }

    return response.json();
}

function updateStats(records, prediction, currentId) {
    const state = loadState();

    if (state.pending) {
        const settled = records.find(
            x => Number(x.id) === Number(state.pending.phien)
        );

        if (settled) {
            const actual = normalize(
                settled.resultTruyenThong
            );

            if (actual) {
                if (actual === state.pending.du_doan) {
                    state.thang++;
                } else {
                    state.thua++;
                }

                state.pending = null;
            }
        }
    }

    if (
        !state.pending ||
        Number(state.pending.phien) !== currentId
    ) {
        state.pending = {
            phien: currentId,
            du_doan: prediction
        };
    }

    saveState(state);

    return state;
}

async function getPrediction() {
    if (cache && Date.now() - lastFetch < CACHE_TIME) {
        return cache;
    }

    if (busy) {
        if (cache) return cache;
        throw new Error("API đang xử lý");
    }

    busy = true;

    try {
        const payload = await fetchSource();

        const records = (payload.list || [])
            .filter(x => normalize(x.resultTruyenThong))
            .sort((a, b) => Number(a.id) - Number(b.id));

        if (!records.length) {
            throw new Error("Không có dữ liệu lịch sử");
        }

        const history = records.map(
            x => normalize(x.resultTruyenThong)
        );

        const latest = records[records.length - 1];

        const previousId = Number(latest.id);
        const currentId = previousId + 1;

        const dice = Array.isArray(latest.dices)
            ? latest.dices.map(Number)
            : [];

        const totalDice = dice.reduce(
            (sum, value) => sum + value,
            0
        );

        const actual = normalize(
            latest.resultTruyenThong
        );

        const result = analyze(history);

        const state = updateStats(
            records,
            result.prediction,
            currentId
        );

        const output = {
            phien_truoc: previousId,
            xuc_xac: dice,
            tong: totalDice,
            ket_qua: vietnamese(actual),
            phien_hien_tai: currentId,
            du_doan: vietnamese(result.prediction),
            tin_cay: result.confidence,
            pattern: result.pattern,
            thong_ke: {
                tai: history.filter(x => x === "T").length,
                xiu: history.filter(x => x === "X").length,
                tong_phien: history.length,
                xu_huong: "Cân bằng"
            },
            thang: state.thang,
            thua: state.thua,
            tong_du_doan: state.thang + state.thua
        };

        cache = output;
        lastFetch = Date.now();

        return output;
    } finally {
        busy = false;
    }
}

app.get("/", (req, res) => {
    res.json({
        name: "TX MD5 API",
        status: "online",
        endpoint: "/api/lc/md5",
        health: "/health"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        uptime: process.uptime()
    });
});

app.get("/api/lc/md5", async (req, res) => {
    try {
        const data = await getPrediction();
        res.json(data);
    } catch (error) {
        res.status(502).json({
            error: "Không thể lấy dữ liệu",
            detail: error.message
        });
    }
});

// Ping giữ service
setInterval(async () => {
    try {
        const response = await fetch(
            `http://127.0.0.1:${PORT}/health`,
            { signal: AbortSignal.timeout(5000) }
        );

        console.log(
            response.ok ? "PING 200 OK" : "PING FAILED"
        );
    } catch (error) {
        console.log("PING ERROR:", error.message);
    }
}, 5 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
    console.log(`TX MD5 API running on port ${PORT}`);
});
