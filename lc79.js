// VERTEX PREMIUM — dashboard + API proxy, Node.js 18+
// Run: node 68md5.js
// Open: http://localhost:3000
// API source: https://wtxmd52.tele68.com/v1/txmd5/sessions
"use strict";

const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const PING_URL = "https://wtxmd52.tele68.com/v1/txmd5/ping";
const POLL_MS = 5000;
const HISTORY_LIMIT = 50;

let state = {
  connected: false,
  latency: null,
  lastSync: null,
  error: null,
  sessions: [],
  predictions: [],
  latestSessionId: null
};

function pickResult(s) {
  const raw = s?.resultTruyenThong ?? s?.result ?? s?.ket_qua ?? s?.result_traditional;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (["tai", "tài", "big"].includes(v)) return "Tài";
  if (["xiu", "xỉu", "small"].includes(v)) return "Xỉu";
  return null;
}

function sessionId(s) {
  return s?.id ?? s?.session_id ?? s?._id ?? null;
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.sessions,
    payload?.data,
    payload?.results,
    payload?.result,
    payload?.data?.sessions,
    payload?.data?.results,
    payload?.data?.data,
    payload?.result?.sessions,
    payload?.result?.data
  ];
  return candidates.find(Array.isArray) || [];
}

function safeSession(s) {
  const dices = Array.isArray(s?.dices) ? s.dices : null;
  return {
    id: sessionId(s),
    result: pickResult(s),
    point: Number.isFinite(Number(s?.point)) ? Number(s.point) : null,
    dices: dices && dices.length ? dices.slice(0, 3).map(Number) : null,
    md5: s?.md5 ?? s?.hash ?? s?.md5_hash ?? null,
    timestamp: s?.timestamp ?? s?.time ?? s?.created_at ?? null
  };
}

// A transparent, modest heuristic for display/testing only.
// Its "score" is model strength, NOT a verified win probability.
function buildPrediction(sessions) {
  const settled = sessions.filter(s => s.result);
  if (settled.length < 8) return null;
  const last = settled.slice(-30);
  const tai = last.filter(s => s.result === "Tài").length;
  const xiu = last.length - tai;
  const recent = last.slice(-6);
  const recentTai = recent.filter(s => s.result === "Tài").length;
  const recentXiu = recent.length - recentTai;

  // Neutral prior prevents a default Tài/Xỉu choice.
  const taiScore = (tai + 1) / (last.length + 2) * 0.65 +
    (recentTai + 1) / (recent.length + 2) * 0.35;
  const xiuScore = (xiu + 1) / (last.length + 2) * 0.65 +
    (recentXiu + 1) / (recent.length + 2) * 0.35;

  if (Math.abs(taiScore - xiuScore) < 0.035) {
    return {
      side: "Chưa đủ tín hiệu",
      score: 50,
      note: "Hai phía cân bằng; tiếp tục quan sát",
      sample: last.length,
      targetSession: settled[settled.length - 1].id == null
        ? null : String(Number(settled[settled.length - 1].id) + 1)
    };
  }

  const side = taiScore > xiuScore ? "Tài" : "Xỉu";
  const gap = Math.abs(taiScore - xiuScore);
  const score = Math.min(70, 50 + gap * 100);
  return {
    side,
    score: Number(score.toFixed(2)),
    note: "Điểm xu hướng thống kê; không phải xác suất thắng",
    sample: last.length,
    targetSession: settled[settled.length - 1].id == null
      ? null : String(Number(settled[settled.length - 1].id) + 1)
  };
}

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 VertexPremium/1.1",
          "origin": "https://lc79c.vin",
          "referer": "https://lc79c.vin/"
        }
      });
    } catch (err) {
      const cause = err?.cause?.code || err?.code;
      if (err?.name === "AbortError") throw new Error(`Timeout sau ${timeout}ms khi gọi API`);
      throw new Error(`${cause ? cause + ": " : ""}${err?.cause?.message || err.message || "Không kết nối được API"}`);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 180);
      throw new Error(`HTTP ${res.status}${body ? " — " + body : ""}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error("API trả về nội dung không phải JSON hợp lệ");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function syncSessions() {
  const start = Date.now();
  try {
    const payload = await fetchJson(API_URL);
    const raw = normalizePayload(payload);
    const sessions = raw.map(safeSession).filter(s => s.id != null);
    if (!sessions.length) throw new Error("API trả về JSON nhưng không nhận diện được danh sách phiên.");
    // API commonly returns newest first. Sort numeric IDs ascending when possible.
    sessions.sort((a, b) => {
      const na = Number(a.id), nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a.id).localeCompare(String(b.id));
    });

    const oldPrediction = state.predictions[state.predictions.length - 1];
    const latest = sessions[sessions.length - 1];
    if (oldPrediction && oldPrediction.actual == null) {
      const matched = sessions.find(s => String(s.id) === String(oldPrediction.targetSession));
      if (matched?.result) {
        oldPrediction.actual = matched.result;
        oldPrediction.correct = oldPrediction.side === matched.result;
        oldPrediction.settledAt = new Date().toISOString();
      }
    }

    state.sessions = sessions.slice(-HISTORY_LIMIT);
    state.latestSessionId = latest.id;
    state.connected = true;
    state.latency = Date.now() - start;
    state.lastSync = new Date().toISOString();
    state.error = null;

    const prediction = buildPrediction(state.sessions);
    if (prediction && prediction.targetSession &&
        state.predictions[state.predictions.length - 1]?.targetSession !== prediction.targetSession) {
      state.predictions.push({
        ...prediction,
        actual: null,
        correct: null,
        createdAt: new Date().toISOString()
      });
      state.predictions = state.predictions.slice(-HISTORY_LIMIT);
    }
  } catch (e) {
    state.connected = false;
    state.error = e?.message || "Lỗi kết nối API";
  }
}

const html = String.raw`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#080d19"><title>VERTEX PREMIUM — Analyzer</title>
<style>
:root{color-scheme:dark;--bg:#080d19;--panel:#10192b;--panel2:#0c1424;--line:#24334d;--text:#edf4ff;--muted:#8fa3c2;--cyan:#52e6ff;--blue:#6c8cff;--green:#43e0a0;--red:#ff647c;--gold:#ffd36a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0%,#14284a 0,transparent 36%),var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:auto;padding:22px 16px 38px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:12px}.logo{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:900;color:#07111d;background:linear-gradient(135deg,var(--cyan),var(--blue));box-shadow:0 0 25px #52e6ff40}.brand h1{font-size:16px;letter-spacing:2px;margin:0}.brand p{font-size:11px;color:var(--muted);margin:3px 0 0;letter-spacing:1.3px}.status{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:#0d1626;padding:8px 11px;border-radius:999px;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--red)}.dot.on{background:var(--green);box-shadow:0 0 10px #43e0a080}
.hero{position:relative;border:1px solid transparent;border-radius:18px;padding:1px;background:linear-gradient(120deg,#52e6ff80,#344a78,#7c72ff80,#52e6ff80);background-size:300% 300%;animation:borderflow 8s ease infinite;margin-bottom:14px}.hero-in{border-radius:17px;background:linear-gradient(115deg,#111e34,#0c1424 65%);padding:22px;display:grid;grid-template-columns:1.2fr .8fr;gap:18px}.eyebrow{color:var(--cyan);font-size:10px;letter-spacing:2px;font-weight:800}.hero h2{font-size:clamp(22px,4vw,34px);margin:8px 0}.sub{color:var(--muted);margin:0;max-width:560px}.signal{align-self:center;border:1px solid var(--line);background:#08111f;border-radius:14px;padding:16px}.signal-top{display:flex;justify-content:space-between;color:var(--muted);font-size:11px}.side{font-size:34px;font-weight:850;letter-spacing:1px;margin:8px 0}.side.tai{color:var(--red)}.side.xiu{color:var(--cyan)}.side.neutral{color:var(--gold)}.bar{height:6px;background:#1b2940;border-radius:10px;overflow:hidden}.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--blue));border-radius:10px}.tiny{font-size:11px;color:var(--muted);margin-top:9px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}.card{background:linear-gradient(145deg,#111b2d,#0d1524);border:1px solid var(--line);border-radius:14px;padding:15px;min-width:0}.k{font-size:11px;color:var(--muted);margin-bottom:8px}.v{font-size:22px;font-weight:800;overflow-wrap:anywhere}.detail{font-size:11px;color:var(--muted);margin-top:5px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.section-head h3{font-size:13px;letter-spacing:.5px;margin:0}.pill{font-size:10px;color:var(--cyan);border:1px solid #52e6ff40;padding:4px 7px;border-radius:999px;white-space:nowrap}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:12px}th{text-align:left;color:var(--muted);font-size:10px;font-weight:600;padding:10px 8px;border-bottom:1px solid var(--line)}td{padding:10px 8px;border-bottom:1px solid #1a2940}tr:last-child td{border-bottom:0}.tag{display:inline-block;border-radius:6px;padding:3px 7px;font-size:10px;font-weight:800}.tag.tai{color:#ff8da0;background:#ff647c18}.tag.xiu{color:#6feaff;background:#52e6ff16}.tag.win{color:var(--green);background:#43e0a015}.tag.loss{color:var(--red);background:#ff647c15}.empty{text-align:center;padding:24px;color:var(--muted);font-size:12px}.footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:10px;margin-top:14px}.notice{border:1px solid #ffd36a30;background:#ffd36a0a;border-radius:12px;padding:12px 14px;color:#c7d2e4;font-size:11px;margin-top:14px}.refresh{border:1px solid var(--line);background:#121f34;color:var(--text);padding:8px 12px;border-radius:9px;font-weight:700;cursor:pointer}.refresh:active{transform:scale(.98)}
@keyframes borderflow{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
@media(max-width:760px){.wrap{padding:15px 11px 28px}.hero-in{grid-template-columns:1fr;padding:17px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.columns{grid-template-columns:1fr}.top{align-items:flex-start}.brand h1{font-size:14px}.status{font-size:10px}.card{padding:13px}.v{font-size:20px}.side{font-size:29px}}
</style></head>
<body><main class="wrap">
<header class="top"><div class="brand"><div class="logo">V</div><div><h1>VERTEX PREMIUM</h1><p>WILD BOUNTY · SESSION ANALYZER</p></div></div><div class="status"><span id="dot" class="dot"></span><span id="connection">Đang kết nối API</span></div></header>
<section class="hero"><div class="hero-in"><div><div class="eyebrow">LIVE DATA · TELE68 API</div><h2>Phân tích phiên tự động</h2><p class="sub">Theo dõi dữ liệu phiên, chấm kết quả dự đoán và đo hiệu suất từ dữ liệu đã xác minh.</p><div class="tiny" id="updated">Đang tải dữ liệu…</div></div><div class="signal"><div class="signal-top"><span>DỰ ĐOÁN THAM KHẢO</span><span id="target">Phiên —</span></div><div id="prediction" class="side neutral">ĐANG TẢI</div><div class="bar"><span id="scorebar" style="width:0%"></span></div><div class="tiny" id="confidence">Điểm mô hình: —</div><div class="tiny" id="signalnote">Chờ đủ dữ liệu phiên.</div></div></div></section>
<section class="grid">
<div class="card"><div class="k">PHIÊN MỚI NHẤT</div><div class="v" id="latest">—</div><div class="detail" id="latestResult">Chưa có kết quả</div></div>
<div class="card"><div class="k">PING / LATENCY</div><div class="v" id="latency">—</div><div class="detail">Thời gian phản hồi API</div></div>
<div class="card"><div class="k">ĐỘ CHÍNH XÁC ĐÃ ĐÁNH GIÁ</div><div class="v" id="accuracy">—</div><div class="detail" id="evaluated">Chưa có phiên đối chiếu</div></div>
<div class="card"><div class="k">TỔNG DỰ ĐOÁN</div><div class="v" id="totalPred">0</div><div class="detail" id="winloss">WIN 0 · LOSS 0</div></div>
</section>
<section class="columns">
<div class="card"><div class="section-head"><h3>LỊCH SỬ DỰ ĐOÁN</h3><span class="pill">AUTO SETTLEMENT</span></div><div class="table-wrap"><table><thead><tr><th>PHIÊN</th><th>DỰ ĐOÁN</th><th>ĐIỂM</th><th>KẾT QUẢ</th></tr></thead><tbody id="predRows"><tr><td colspan="4" class="empty">Đang chờ dữ liệu…</td></tr></tbody></table></div></div>
<div class="card"><div class="section-head"><h3>LỊCH SỬ PHIÊN API</h3><button class="refresh" id="refresh">Làm mới</button></div><div class="table-wrap"><table><thead><tr><th>PHIÊN</th><th>XÚC XẮC</th><th>TỔNG ĐIỂM</th><th>KẾT QUẢ</th></tr></thead><tbody id="sessionRows"><tr><td colspan="4" class="empty">Đang tải phiên…</td></tr></tbody></table></div></div>
</section>
<div class="notice" id="notice">Độ tin cậy hiển thị là điểm xu hướng của mô hình đơn giản, không phải xác suất thắng đã được chứng minh. Kết quả trò chơi có thể ngẫu nhiên; không có bảo đảm thắng.</div>
<div class="footer"><span>VERTEX PREMIUM · DATA MONITOR</span><span id="error">Không có lỗi được ghi nhận</span><span>Tự đồng bộ mỗi 5 giây</span></div>
</main>
<script>
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "—").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function fmtTime(v){if(!v)return "—";const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString("vi-VN");}
function resultTag(v){if(!v)return "—";return '<span class="tag '+(v==="Tài"?"tai":"xiu")+'">'+esc(v)+'</span>';}
async function refresh(){
  try{
    const r=await fetch("/api/status",{cache:"no-store"});const d=await r.json();
    $("dot").className="dot "+(d.connected?"on":"");
    $("connection").textContent=d.connected?"API ĐANG HOẠT ĐỘNG":"API MẤT KẾT NỐI";
    $("updated").textContent="Cập nhật: "+fmtTime(d.lastSync);
    $("latency").textContent=d.latency==null?"—":d.latency+" ms";
    $("latest").textContent=d.latestSessionId??"—";
    const latest=(d.sessions||[]).slice(-1)[0];
    $("latestResult").innerHTML=latest?resultTag(latest.result):"Chưa có kết quả";
    const p=d.predictions||[];const settled=p.filter(x=>x.correct!==null);
    const wins=settled.filter(x=>x.correct).length;
    $("accuracy").textContent=settled.length?((wins/settled.length)*100).toFixed(2)+"%":"—";
    $("evaluated").textContent=settled.length+" phiên đã đối chiếu";
    $("totalPred").textContent=p.length;
    $("winloss").textContent="WIN "+wins+" · LOSS "+(settled.length-wins);
    const current=p[p.length-1];
    if(current){
      $("prediction").textContent=current.side;
      $("prediction").className="side "+(current.side==="Tài"?"tai":current.side==="Xỉu"?"xiu":"neutral");
      $("target").textContent="Phiên "+(current.targetSession??"—");
      $("confidence").textContent="Điểm mô hình: "+Number(current.score).toFixed(2)+"/100";
      $("scorebar").style.width=Math.max(0,Math.min(100,Number(current.score)))+"%";
      $("signalnote").textContent=current.note||"Điểm tham khảo";
    }else{
      $("prediction").textContent="CHƯA ĐỦ DỮ LIỆU";$("prediction").className="side neutral";
      $("target").textContent="Phiên —";$("confidence").textContent="Điểm mô hình: —";$("scorebar").style.width="0%";
      $("signalnote").textContent="Cần tối thiểu 8 phiên có kết quả.";
    }
    const pr=[...p].reverse().slice(0,12);
    $("predRows").innerHTML=pr.length?pr.map(x=>'<tr><td>'+esc(x.targetSession)+'</td><td>'+esc(x.side)+'</td><td>'+Number(x.score).toFixed(2)+'</td><td>'+(x.correct===null?'<span class="tag">CHỜ</span>':x.correct?'<span class="tag win">WIN</span>':'<span class="tag loss">LOSS</span>')+'</td></tr>').join(""):'<tr><td colspan="4" class="empty">Chưa có dự đoán</td></tr>';
    const ss=[...(d.sessions||[])].reverse().slice(0,12);
    $("sessionRows").innerHTML=ss.length?ss.map(x=>'<tr><td>'+esc(x.id)+'</td><td>'+esc(x.dices?x.dices.join(" · "):"—")+'</td><td>'+esc(x.point??"—")+'</td><td>'+resultTag(x.result)+'</td></tr>').join(""):'<tr><td colspan="4" class="empty">API chưa trả phiên</td></tr>';
    $("error").textContent=d.error?"API: "+d.error:"Không có lỗi được ghi nhận";
  }catch(e){$("connection").textContent="LỖI DASHBOARD";$("error").textContent=e.message;}
}
$("refresh").addEventListener("click",refresh);
refresh();setInterval(refresh,5000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }
  if (url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({
      connected: state.connected,
      latency: state.latency,
      lastSync: state.lastSync,
      error: state.error,
      sessions: state.sessions,
      predictions: state.predictions,
      latestSessionId: state.latestSessionId
    }));
  }
  if (url.pathname === "/api/diagnostics") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({
      apiUrl: API_URL,
      connected: state.connected,
      lastSync: state.lastSync,
      latency: state.latency,
      error: state.error,
      sessionsReceived: state.sessions.length,
      hint: state.error
        ? "Xem trường error để biết HTTP/DNS/TLS/timeout hoặc lỗi cấu trúc JSON."
        : "API phiên đã trả dữ liệu hợp lệ."
    }));
  }
  if (url.pathname === "/api/ping") {
    const start = Date.now();
    try {
      const data = await fetchJson(PING_URL, 5000);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, latency: Date.now() - start, data }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VERTEX PREMIUM running at http://localhost:${PORT}`);
  console.log(`API source: ${API_URL}`);
  syncSessions();
  setInterval(syncSessions, POLL_MS);
});
