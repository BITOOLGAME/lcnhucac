
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.disable("x-powered-by");
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_URL =
  process.env.API_URL ||
  "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const DATA_FILE = path.join(__dirname, "stats.json");

const MIN_HISTORY = 6;
const MAX_PATTERN = 15;
const MAX_HISTORY = 500;
const MAX_BACKTEST = 250;

const REQUEST_TIMEOUT = 10000;

const LABEL = {
  T: "Tài",
  X: "Xỉu"
};

// =====================================================
// STATE
// =====================================================

function defaultState() {
  return {
    thang: 0,
    thua: 0,
    tong_du_doan: 0,
    pending: null,
    last_settled_id: null,
    updated_at: null
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return defaultState();
    }

    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      ...defaultState(),
      ...data
    };
  } catch (error) {
    console.error("Lỗi đọc stats.json:", error.message);
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  try {
    state.updated_at = new Date().toISOString();

    const tempFile = DATA_FILE + ".tmp";

    fs.writeFileSync(
      tempFile,
      JSON.stringify(state, null, 2),
      "utf8"
    );

    fs.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    console.error("Lỗi lưu thống kê:", error.message);
  }
}

// =====================================================
// NORMALIZE DATA
// =====================================================

function normalizeResult(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim().toUpperCase();

  if (
    text === "TAI" ||
    text === "TÀI" ||
    text === "T"
  ) {
    return "T";
  }

  if (
    text === "XIU" ||
    text === "XỈU" ||
    text === "X"
  ) {
    return "X";
  }

  return null;
}

function normalizeSessions(payload) {
  let list = [];

  if (Array.isArray(payload)) {
    list = payload;
  } else if (Array.isArray(payload?.list)) {
    list = payload.list;
  } else if (Array.isArray(payload?.data)) {
    list = payload.data;
  } else if (Array.isArray(payload?.data?.list)) {
    list = payload.data.list;
  }

  const sessions = [];

  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = Number(
      item.id ??
      item.session ??
      item.phien ??
      item.issue
    );

    const result = normalizeResult(
      item.resultTruyenThong ??
      item.result ??
      item.ket_qua ??
      item.outcome
    );

    const dices = Array.isArray(item.dices)
      ? item.dices.map(Number)
      : [];

    const validDices =
      dices.length === 3 &&
      dices.every(
        n => Number.isInteger(n) && n >= 1 && n <= 6
      );

    const point = Number(
      item.point ??
      item.total ??
      (validDices
        ? dices.reduce((a, b) => a + b, 0)
        : NaN)
    );

    if (!Number.isFinite(id) || !result) {
      continue;
    }

    sessions.push({
      id,
      result,
      dices: validDices ? dices : [],
      point: Number.isFinite(point) ? point : null
    });
  }

  const unique = new Map();

  for (const item of sessions) {
    unique.set(item.id, item);
  }

  // API thường trả phiên mới nhất trước.
  // Đưa về thứ tự cũ -> mới để phân tích.
  return Array.from(unique.values())
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_HISTORY);
}

// =====================================================
// FETCH API
// =====================================================

async function fetchSessions() {
  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Vertex-TX-API/2.0"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(
      `API nguồn trả HTTP ${response.status}`
    );
  }

  const payload = await response.json();
  const sessions = normalizeSessions(payload);

  if (!sessions.length) {
    throw new Error("API nguồn không có dữ liệu hợp lệ");
  }

  return sessions;
}

// =====================================================
// BASIC HELPERS
// =====================================================

function opposite(value) {
  return value === "T" ? "X" : "T";
}

function countSide(history, side) {
  return history.filter(x => x === side).length;
}

function ratio(history, side) {
  if (!history.length) return 0;

  return countSide(history, side) / history.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function majority(scoreT, scoreX) {
  if (scoreT > scoreX) return "T";
  if (scoreX > scoreT) return "X";
  return null;
}

function patternString(history) {
  return history
    .slice(-MAX_PATTERN)
    .join("");
}

// =====================================================
// CORE 1: FREQUENCY 10
// =====================================================

function coreFrequency(history, windowSize) {
  const sample = history.slice(-windowSize);

  if (sample.length < 3) return null;

  const t = countSide(sample, "T");
  const x = countSide(sample, "X");

  if (t === x) return null;

  return t > x ? "T" : "X";
}

// =====================================================
// CORE 2: PATTERN MATCHING
// =====================================================

function corePattern(history, length) {
  if (history.length < length + 2) {
    return null;
  }

  const target = history.slice(-length).join("");

  let tai = 0;
  let xiu = 0;

  for (
    let i = 0;
    i <= history.length - length - 1;
    i++
  ) {
    const candidate = history
      .slice(i, i + length)
      .join("");

    if (candidate !== target) {
      continue;
    }

    const next = history[i + length];

    if (next === "T") tai++;
    if (next === "X") xiu++;
  }

  if (tai === xiu) return null;

  return tai > xiu ? "T" : "X";
}

// =====================================================
// CORE 3: TRANSITION
// =====================================================

function coreTransition(history) {
  if (history.length < 4) return null;

  const last = history[history.length - 1];

  let tai = 0;
  let xiu = 0;

  for (let i = 0; i < history.length - 1; i++) {
    if (history[i] !== last) continue;

    if (history[i + 1] === "T") tai++;
    if (history[i + 1] === "X") xiu++;
  }

  if (tai === xiu) return null;

  return tai > xiu ? "T" : "X";
}

// =====================================================
// CORE 4: STREAK
// =====================================================

function coreStreak(history) {
  if (history.length < 3) return null;

  const last = history[history.length - 1];

  let streak = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] !== last) break;
    streak++;
  }

  if (streak >= 3) {
    return last;
  }

  if (streak === 1) {
    return opposite(last);
  }

  return null;
}

// =====================================================
// CORE 5: ALTERNATION
// =====================================================

function coreAlternation(history) {
  if (history.length < 4) return null;

  const last4 = history.slice(-4);

  const alternating =
    last4[0] !== last4[1] &&
    last4[1] !== last4[2] &&
    last4[2] !== last4[3];

  if (!alternating) return null;

  return opposite(last4[3]);
}

// =====================================================
// CORE 6: RECENT 5
// =====================================================

function coreRecent5(history) {
  return coreFrequency(history, 5);
}

// =====================================================
// CORE 7: RECENT 15
// =====================================================

function coreRecent15(history) {
  return coreFrequency(history, 15);
}

// =====================================================
// CORE 8: GLOBAL BALANCE
// =====================================================

function coreBalance(history) {
  if (history.length < 6) return null;

  const t = countSide(history, "T");
  const x = countSide(history, "X");

  const difference = Math.abs(t - x);

  if (difference < 2) return null;

  return t > x ? "X" : "T";
}

// =====================================================
// CORE 9: PAIR PATTERN
// =====================================================

function corePair(history) {
  if (history.length < 5) return null;

  const lastPair = history.slice(-2).join("");

  let tai = 0;
  let xiu = 0;

  for (let i = 0; i < history.length - 2; i++) {
    const pair = history.slice(i, i + 2).join("");

    if (pair !== lastPair) continue;

    if (history[i + 2] === "T") tai++;
    if (history[i + 2] === "X") xiu++;
  }

  if (tai === xiu) return null;

  return tai > xiu ? "T" : "X";
}

// =====================================================
// CORE 10: TRIPLE PATTERN
// =====================================================

function coreTriple(history) {
  return corePattern(history, 3);
}

// =====================================================
// CORE 11: MOMENTUM
// =====================================================

function coreMomentum(history) {
  if (history.length < 6) return null;

  const recent = history.slice(-6);

  const first = recent.slice(0, 3);
  const last = recent.slice(3, 6);

  const firstT = countSide(first, "T");
  const lastT = countSide(last, "T");

  if (lastT > firstT) return "T";
  if (lastT < firstT) return "X";

  return null;
}

// =====================================================
// CORE 12: RECENT WEIGHTED
// =====================================================

function coreWeighted(history) {
  const sample = history.slice(-10);

  if (sample.length < 5) return null;

  let scoreT = 0;
  let scoreX = 0;

  sample.forEach((side, index) => {
    const weight = index + 1;

    if (side === "T") scoreT += weight;
    if (side === "X") scoreX += weight;
  });

  if (scoreT === scoreX) return null;

  return scoreT > scoreX ? "T" : "X";
}

// =====================================================
// CORE ENGINE
// =====================================================

const CORE_LIST = [
  {
    name: "frequency_10",
    weight: 1.0,
    run: h => coreFrequency(h, 10)
  },
  {
    name: "frequency_30",
    weight: 0.9,
    run: h => coreFrequency(h, 30)
  },
  {
    name: "frequency_50",
    weight: 0.7,
    run: h => coreFrequency(h, 50)
  },
  {
    name: "pattern_2",
    weight: 0.9,
    run: h => corePattern(h, 2)
  },
  {
    name: "pattern_3",
    weight: 1.1,
    run: h => corePattern(h, 3)
  },
  {
    name: "pattern_4",
    weight: 1.1,
    run: h => corePattern(h, 4)
  },
  {
    name: "transition",
    weight: 1.0,
    run: coreTransition
  },
  {
    name: "streak",
    weight: 0.8,
    run: coreStreak
  },
  {
    name: "alternation",
    weight: 0.8,
    run: coreAlternation
  },
  {
    name: "recent_5",
    weight: 1.0,
    run: coreRecent5
  },
  {
    name: "recent_15",
    weight: 0.9,
    run: coreRecent15
  },
  {
    name: "balance",
    weight: 0.7,
    run: coreBalance
  }
];

function analyzeCores(history) {
  let scoreT = 0;
  let scoreX = 0;

  const details = [];

  for (const core of CORE_LIST) {
    let prediction = null;

    try {
      prediction = core.run(history);
    } catch {
      prediction = null;
    }

    if (prediction === "T") {
      scoreT += core.weight;
    } else if (prediction === "X") {
      scoreX += core.weight;
    }

    details.push({
      ten: core.name,
      du_doan: prediction ? LABEL[prediction] : null,
      trong_so: core.weight
    });
  }

  const active = details.filter(
    item => item.du_doan !== null
  ).length;

  const total = scoreT + scoreX;

  const prediction = majority(scoreT, scoreX);

  const agreement = total > 0
    ? Math.max(scoreT, scoreX) / total
    : 0;

  const margin = total > 0
    ? Math.abs(scoreT - scoreX) / total
    : 0;

  // Confidence is a heuristic score, not a calibrated probability.
  let confidence = 50 + agreement * 12 + margin * 6;

  confidence = clamp(confidence, 50, 68);

  if (!prediction || active < 3) {
    confidence = 0;
  }

  return {
    prediction,
    scoreT: Number(scoreT.toFixed(3)),
    scoreX: Number(scoreX.toFixed(3)),
    active,
    agreement: Number((agreement * 100).toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    details
  };
}

// =====================================================
// WALK-FORWARD BACKTEST
// =====================================================

function walkForward(history) {
  const start = Math.max(MIN_HISTORY, history.length - MAX_BACKTEST);

  let correct = 0;
  let wrong = 0;
  let tested = 0;

  for (let i = start; i < history.length; i++) {
    const training = history.slice(0, i);

    if (training.length < MIN_HISTORY) {
      continue;
    }

    const result = analyzeCores(training);

    if (!result.prediction) {
      continue;
    }

    tested++;

    if (result.prediction === history[i]) {
      correct++;
    } else {
      wrong++;
    }
  }

  const accuracy = tested
    ? (correct / tested) * 100
    : 0;

  return {
    tested,
    correct,
    wrong,
    accuracy: Number(accuracy.toFixed(2))
  };
}

// =====================================================
// MAIN ANALYSIS
// =====================================================

function analyze(history) {
  const clean = history
    .filter(x => x === "T" || x === "X")
    .slice(-MAX_HISTORY);

  const pattern = patternString(clean);

  if (clean.length < MIN_HISTORY) {
    return {
      ready: false,
      remaining: MIN_HISTORY - clean.length,
      prediction: null,
      confidence: 0,
      pattern,
      cores_active: 0,
      thong_ke: {
        tai: countSide(clean, "T"),
        xiu: countSide(clean, "X"),
        backtest: null
      }
    };
  }

  const result = analyzeCores(clean);
  const backtest = walkForward(clean);

  return {
    ready: Boolean(result.prediction),
    remaining: 0,
    prediction: result.prediction,
    confidence: result.confidence,
    pattern,
    cores_active: result.active,
    score_tai: result.scoreT,
    score_xiu: result.scoreX,
    agreement: result.agreement,
    cores: result.details,
    thong_ke: {
      tai: countSide(clean, "T"),
      xiu: countSide(clean, "X"),
      backtest
    }
  };
}

// =====================================================
// SETTLE PREVIOUS PREDICTION
// =====================================================

function settlePrediction(latest) {
  if (!state.pending) return;

  if (latest.id < state.pending.target_id) {
    return;
  }

  if (latest.id > state.pending.target_id) {
    // Missed target session. Do not falsely count it.
    state.pending = null;
    saveState();
    return;
  }

  if (
    state.last_settled_id === latest.id
  ) {
    return;
  }

  state.tong_du_doan++;

  if (state.pending.prediction === latest.result) {
    state.thang++;
  } else {
    state.thua++;
  }

  state.last_settled_id = latest.id;
  state.pending = null;

  saveState();
}

// =====================================================
// RESPONSE BUILDER
// =====================================================

function buildResponse(sessions) {
  const latest = sessions[sessions.length - 1];

  settlePrediction(latest);

  const history = sessions.map(x => x.result);
  const result = analyze(history);

  const nextId = latest.id + 1;

  let prediction = null;
  let status = "Đang thu thập";

  if (result.ready && result.prediction) {
    prediction = result.prediction;
    status = "Đã phân tích";

    if (
      !state.pending ||
      state.pending.target_id !== nextId
    ) {
      state.pending = {
        target_id: nextId,
        prediction,
        created_at: new Date().toISOString()
      };

      saveState();
    } else {
      prediction = state.pending.prediction;
    }
  }

  const total = state.thang + state.thua;

  const winRate = total > 0
    ? (state.thang / total) * 100
    : 0;

  const previous = sessions.length > 1
    ? sessions[sessions.length - 2]
    : null;

  return {
    success: true,
    source: "Vertex TX Engine",
    phien_truoc: latest.id,
    xuc_xac: latest.dices,
    tong: latest.point,
    ket_qua: LABEL[latest.result],
    phien_hien_tai: nextId,

    trang_thai: status,

    du_doan: prediction
      ? LABEL[prediction]
      : null,

    tin_cay: `${result.confidence.toFixed(2)}%`,

    pattern: result.pattern,

    thong_ke: {
      tai: result.thong_ke.tai,
      xiu: result.thong_ke.xiu,
      so_loi_hoat_dong: result.cores_active,
      tong_loi: CORE_LIST.length,

      diem_tai: result.score_tai ?? 0,
      diem_xiu: result.score_xiu ?? 0,

      do_dong_thuan: result.agreement ?? 0,

      backtest: result.thong_ke.backtest,

      thang: state.thang,
      thua: state.thua,
      tong_du_doan: state.tong_du_doan,
      ty_le_thang: `${winRate.toFixed(2)}%`
    },

    cores: result.cores ?? [],

    du_lieu: {
      so_phien: history.length,
      so_phien_can_thu_thap: result.remaining,
      phien_cu: previous?.id ?? null
    },

    cap_nhat: new Date().toISOString()
  };
}

// =====================================================
// ROUTES
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "VERTEX PREMIUM TX API",
    version: "2.0.0",
    status: "online",
    endpoints: [
      "/health",
      "/api/lc/md5"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/lc/md5", async (req, res) => {
  try {
    const sessions = await fetchSessions();

    const response = buildResponse(sessions);

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.json(response);

  } catch (error) {
    console.error("API ERROR:", error.message);

    return res.status(502).json({
      success: false,
      error: "Không thể lấy dữ liệu phiên",
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =====================================================
// STATS
// =====================================================

app.get("/api/stats", (req, res) => {
  const total = state.thang + state.thua;

  const winRate = total > 0
    ? (state.thang / total) * 100
    : 0;

  res.json({
    success: true,
    thang: state.thang,
    thua: state.thua,
    tong_du_doan: state.tong_du_doan,
    ty_le_thang: `${winRate.toFixed(2)}%`,
    pending: state.pending,
    updated_at: state.updated_at
  });
});

// =====================================================
// RESET STATS
// =====================================================

app.post("/api/reset", (req, res) => {
  const token = process.env.ADMIN_TOKEN;

  if (!token) {
    return res.status(403).json({
      success: false,
      error: "ADMIN_TOKEN chưa được cấu hình"
    });
  }

  const supplied =
    req.headers["x-admin-token"] ||
    req.query.token;

  if (supplied !== token) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  state = defaultState();
  saveState();

  res.json({
    success: true,
    message: "Đã reset thống kê"
  });
});

// =====================================================
// SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" VERTEX PREMIUM TX API");
  console.log("==================================");
  console.log(`PORT: ${PORT}`);
  console.log(`API: /api/lc/md5`);
  console.log(`HEALTH: /health`);
  console.log(`MIN_HISTORY: ${MIN_HISTORY}`);
  console.log(`MAX_PATTERN: ${MAX_PATTERN}`);
  console.log("SERVER READY");
});
