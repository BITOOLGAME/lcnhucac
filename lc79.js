
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
    console.error("Lỗi đọc stats:", error.message);
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  try {
    state.updated_at = new Date().toISOString();

    const temp = DATA_FILE + ".tmp";

    fs.writeFileSync(
      temp,
      JSON.stringify(state, null, 2),
      "utf8"
    );

    fs.renameSync(temp, DATA_FILE);
  } catch (error) {
    console.error("Lỗi lưu stats:", error.message);
  }
}

// =====================================================
// NORMALIZE
// =====================================================

function normalizeResult(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .trim()
    .toUpperCase();

  if (["TAI", "TÀI", "T"].includes(text)) {
    return "T";
  }

  if (["XIU", "XỈU", "X"].includes(text)) {
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

  const map = new Map();

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
      (
        validDices
          ? dices.reduce((a, b) => a + b, 0)
          : NaN
      )
    );

    if (!Number.isFinite(id) || !result) {
      continue;
    }

    map.set(id, {
      id,
      result,
      dices: validDices ? dices : [],
      point: Number.isFinite(point) ? point : null
    });
  }

  return Array.from(map.values())
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_HISTORY);
}

// =====================================================
// FETCH
// =====================================================

async function fetchSessions() {
  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Vertex-TX-API/3.0"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(
      `Nguồn dữ liệu HTTP ${response.status}`
    );
  }

  const payload = await response.json();
  const sessions = normalizeSessions(payload);

  if (!sessions.length) {
    throw new Error("Không có dữ liệu phiên hợp lệ");
  }

  return sessions;
}

// =====================================================
// HELPERS
// =====================================================

function opposite(value) {
  return value === "T" ? "X" : "T";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function patternString(history) {
  return history.slice(-MAX_PATTERN).join("");
}

function getStreak(history) {
  if (!history.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side = history[history.length - 1];

  let length = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] !== side) break;
    length++;
  }

  return { side, length };
}

function getTransitions(history) {
  const result = [];

  for (let i = 0; i < history.length - 1; i++) {
    result.push(history[i] + history[i + 1]);
  }

  return result;
}

// =====================================================
// PATTERN MATCHING
// Chỉ so khớp mẫu cục bộ, không dùng tổng Tài/Xỉu toàn bộ.
// =====================================================

function matchPattern(history, length) {
  if (history.length < length + 2) {
    return null;
  }

  const target = history
    .slice(-length)
    .join("");

  let tai = 0;
  let xiu = 0;
  let matches = 0;

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

    matches++;
  }

  if (matches < 1 || tai === xiu) {
    return null;
  }

  return {
    prediction: tai > xiu ? "T" : "X",
    support: Math.max(tai, xiu) / matches,
    matches
  };
}

// =====================================================
// CORE 1: PATTERN 2
// =====================================================

function core1(h) {
  return matchPattern(h, 2);
}

// =====================================================
// CORE 2: PATTERN 3
// =====================================================

function core2(h) {
  return matchPattern(h, 3);
}

// =====================================================
// CORE 3: PATTERN 4
// =====================================================

function core3(h) {
  return matchPattern(h, 4);
}

// =====================================================
// CORE 4: PATTERN 5
// =====================================================

function core4(h) {
  return matchPattern(h, 5);
}

// =====================================================
// CORE 5: PATTERN 6
// =====================================================

function core5(h) {
  return matchPattern(h, 6);
}

// =====================================================
// CORE 6: TRANSITION
// =====================================================

function core6(h) {
  if (h.length < 4) return null;

  const last = h[h.length - 1];

  let tai = 0;
  let xiu = 0;
  let matches = 0;

  for (let i = 0; i < h.length - 1; i++) {
    if (h[i] !== last) continue;

    matches++;

    if (h[i + 1] === "T") tai++;
    if (h[i + 1] === "X") xiu++;
  }

  if (matches < 2 || tai === xiu) {
    return null;
  }

  return {
    prediction: tai > xiu ? "T" : "X",
    support: Math.max(tai, xiu) / matches,
    matches
  };
}

// =====================================================
// CORE 7: STREAK STRUCTURE
// =====================================================

function core7(h) {
  const streak = getStreak(h);

  if (streak.length >= 3) {
    return {
      prediction: streak.side,
      support: 0.55 + Math.min(streak.length, 5) * 0.05,
      matches: streak.length
    };
  }

  if (streak.length === 1 && h.length >= 4) {
    return {
      prediction: opposite(streak.side),
      support: 0.55,
      matches: 1
    };
  }

  return null;
}

// =====================================================
// CORE 8: ALTERNATION
// =====================================================

function core8(h) {
  if (h.length < 4) return null;

  const last = h.slice(-4);

  const alternating =
    last[0] !== last[1] &&
    last[1] !== last[2] &&
    last[2] !== last[3];

  if (!alternating) return null;

  return {
    prediction: opposite(last[3]),
    support: 0.62,
    matches: 1
  };
}

// =====================================================
// CORE 9: PAIR TRANSITION
// =====================================================

function core9(h) {
  if (h.length < 5) return null;

  const pair = h.slice(-2).join("");

  let tai = 0;
  let xiu = 0;
  let matches = 0;

  for (let i = 0; i < h.length - 2; i++) {
    if (h[i] + h[i + 1] !== pair) {
      continue;
    }

    matches++;

    if (h[i + 2] === "T") tai++;
    if (h[i + 2] === "X") xiu++;
  }

  if (matches < 2 || tai === xiu) {
    return null;
  }

  return {
    prediction: tai > xiu ? "T" : "X",
    support: Math.max(tai, xiu) / matches,
    matches
  };
}

// =====================================================
// CORE 10: TRIPLE TRANSITION
// =====================================================

function core10(h) {
  if (h.length < 6) return null;

  const triple = h.slice(-3).join("");

  let tai = 0;
  let xiu = 0;
  let matches = 0;

  for (let i = 0; i < h.length - 3; i++) {
    if (h.slice(i, i + 3).join("") !== triple) {
      continue;
    }

    matches++;

    if (h[i + 3] === "T") tai++;
    if (h[i + 3] === "X") xiu++;
  }

  if (matches < 2 || tai === xiu) {
    return null;
  }

  return {
    prediction: tai > xiu ? "T" : "X",
    support: Math.max(tai, xiu) / matches,
    matches
  };
}

// =====================================================
// CORE 11: RHYTHM STRUCTURE
// =====================================================

function core11(h) {
  if (h.length < 6) return null;

  const last6 = h.slice(-6);

  const runs = [];

  let current = last6[0];
  let length = 1;

  for (let i = 1; i < last6.length; i++) {
    if (last6[i] === current) {
      length++;
    } else {
      runs.push({
        side: current,
        length
      });

      current = last6[i];
      length = 1;
    }
  }

  runs.push({
    side: current,
    length
  });

  if (runs.length < 2) return null;

  const lastRun = runs[runs.length - 1];

  if (lastRun.length >= 2) {
    return {
      prediction: lastRun.side,
      support: 0.58,
      matches: lastRun.length
    };
  }

  return {
    prediction: opposite(lastRun.side),
    support: 0.55,
    matches: 1
  };
}

// =====================================================
// CORE 12: TRANSITION SEQUENCE
// =====================================================

function core12(h) {
  if (h.length < 6) return null;

  const transitions = getTransitions(h);

  const lastTransition =
    transitions[transitions.length - 1];

  let same = 0;
  let reverse = 0;

  for (let i = 0; i < transitions.length - 1; i++) {
    if (transitions[i] === lastTransition) {
      same++;
    } else if (
      transitions[i] ===
      lastTransition.split("").reverse().join("")
    ) {
      reverse++;
    }
  }

  if (same === reverse) return null;

  const last = h[h.length - 1];

  return {
    prediction: same > reverse
      ? last
      : opposite(last),
    support:
      Math.max(same, reverse) /
      Math.max(1, same + reverse),
    matches: same + reverse
  };
}

// =====================================================
// 12 CORE ENGINE
// =====================================================

const CORES = [
  { name: "pattern_2", weight: 1.0, run: core1 },
  { name: "pattern_3", weight: 1.1, run: core2 },
  { name: "pattern_4", weight: 1.2, run: core3 },
  { name: "pattern_5", weight: 1.1, run: core4 },
  { name: "pattern_6", weight: 0.9, run: core5 },
  { name: "transition", weight: 1.0, run: core6 },
  { name: "streak", weight: 0.8, run: core7 },
  { name: "alternation", weight: 0.8, run: core8 },
  { name: "pair_transition", weight: 1.0, run: core9 },
  { name: "triple_transition", weight: 1.1, run: core10 },
  { name: "rhythm", weight: 0.9, run: core11 },
  { name: "transition_sequence", weight: 0.9, run: core12 }
];

// =====================================================
// ANALYZE CORES
// =====================================================

function analyzeCores(history) {
  let scoreT = 0;
  let scoreX = 0;

  const details = [];

  for (const core of CORES) {
    let result = null;

    try {
      result = core.run(history);
    } catch (error) {
      result = null;
    }

    if (
      !result ||
      !["T", "X"].includes(result.prediction)
    ) {
      details.push({
        ten: core.name,
        du_doan: null,
        trong_so: core.weight,
        ho_tro: 0,
        so_mau: 0
      });

      continue;
    }

    const support = clamp(
      Number(result.support) || 0.5,
      0.5,
      1
    );

    const effectiveWeight =
      core.weight * (0.75 + support * 0.5);

    if (result.prediction === "T") {
      scoreT += effectiveWeight;
    } else {
      scoreX += effectiveWeight;
    }

    details.push({
      ten: core.name,
      du_doan: LABEL[result.prediction],
      trong_so: core.weight,
      ho_tro: Number((support * 100).toFixed(2)),
      so_mau: result.matches || 0
    });
  }

  const active = details.filter(
    item => item.du_doan !== null
  ).length;

  const total = scoreT + scoreX;

  const prediction =
    scoreT > scoreX
      ? "T"
      : scoreX > scoreT
        ? "X"
        : null;

  const agreement = total
    ? Math.max(scoreT, scoreX) / total
    : 0;

  const margin = total
    ? Math.abs(scoreT - scoreX) / total
    : 0;

  let confidence =
    50 +
    agreement * 10 +
    margin * 8;

  confidence = clamp(confidence, 50, 68);

  // Không ép dự đoán nếu tín hiệu quá yếu.
  if (
    !prediction ||
    active < 4 ||
    agreement < 0.53
  ) {
    confidence = 0;
  }

  return {
    prediction:
      confidence > 0 ? prediction : null,

    scoreT: Number(scoreT.toFixed(3)),
    scoreX: Number(scoreX.toFixed(3)),

    active,

    agreement: Number(
      (agreement * 100).toFixed(2)
    ),

    confidence: Number(confidence.toFixed(2)),

    details
  };
}

// =====================================================
// WALK-FORWARD BACKTEST
// =====================================================

function walkForward(history) {
  const start = Math.max(
    MIN_HISTORY,
    history.length - MAX_BACKTEST
  );

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

  return {
    tested,
    correct,
    wrong,
    accuracy: tested
      ? Number(((correct / tested) * 100).toFixed(2))
      : 0
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
      backtest
    }
  };
}

// =====================================================
// SETTLE PREDICTION
// =====================================================

function settlePrediction(latest) {
  if (!state.pending) return;

  if (latest.id < state.pending.target_id) {
    return;
  }

  if (latest.id > state.pending.target_id) {
    // Không tự tính thắng/thua khi bỏ lỡ phiên mục tiêu.
    state.pending = null;
    saveState();
    return;
  }

  if (state.last_settled_id === latest.id) {
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
// RESPONSE
// =====================================================

function buildResponse(sessions) {
  const latest = sessions[sessions.length - 1];

  settlePrediction(latest);

  const history = sessions.map(
    item => item.result
  );

  const result = analyze(history);

  const nextId = latest.id + 1;

  let prediction = null;
  let status = "Đang thu thập";

  if (result.ready && result.prediction) {
    status = "Đã phân tích";

    if (
      state.pending &&
      state.pending.target_id === nextId
    ) {
      prediction = state.pending.prediction;
    } else {
      prediction = result.prediction;

      state.pending = {
        target_id: nextId,
        prediction,
        created_at: new Date().toISOString()
      };

      saveState();
    }
  } else if (history.length >= MIN_HISTORY) {
    status = "Tín hiệu chưa đủ mạnh";
  }

  const total = state.thang + state.thua;

  const winRate = total > 0
    ? (state.thang / total) * 100
    : 0;

  const previous =
    sessions.length > 1
      ? sessions[sessions.length - 2]
      : null;

  return {
    success: true,

    source: "Vertex TX Engine V3",

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
      so_loi_hoat_dong: result.cores_active,
      tong_loi: CORES.length,

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
      phien_cu: previous?.id ?? null,
      gioi_han_pattern: MAX_PATTERN
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
    version: "3.0.0",
    status: "online",
    endpoints: [
      "/health",
      "/api/lc/md5",
      "/api/stats"
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

    res.setHeader("Cache-Control", "no-store");

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
// RESET
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

  return res.json({
    success: true,
    message: "Đã reset thống kê"
  });
});

// =====================================================
// SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" VERTEX PREMIUM TX API V3");
  console.log("==================================");
  console.log(`PORT: ${PORT}`);
  console.log(`API: /api/lc/md5`);
  console.log(`HEALTH: /health`);
  console.log(`MIN_HISTORY: ${MIN_HISTORY}`);
  console.log(`MAX_PATTERN: ${MAX_PATTERN}`);
  console.log(`CORES: ${CORES.length}`);
  console.log("MODE: PATTERN-BASED");
  console.log("SERVER READY");
});
