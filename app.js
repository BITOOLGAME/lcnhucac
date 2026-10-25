const $ = id => document.getElementById(id);
let dashboard = null;
let busy = false;
function fmtTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("vi-VN", {hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function showToast(message, error=false) {
  const el=$("toast"); el.textContent=message; el.className="toast show"+(error?" error":"");
  clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>el.className="toast",3500);
}
async function api(path, options={}) {
  const res=await fetch(path,{headers:{"Content-Type":"application/json"},...options});
  const json=await res.json().catch(()=>({ok:false,error:"Phản hồi không phải JSON"}));
  if(!res.ok || json.ok===false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
function resultPill(result) {
  const tai=result==="TAI";
  return `<span class="result-pill ${tai?"tai":"xiu"}">${tai?"TÀI":"XỈU"}</span>`;
}
function renderModels(pred) {
  const names=["Pattern engine","Transition model","Streak model","N-gram model","Ensemble"];
  $("modelGrid").innerHTML=(pred?.models||[]).map((m,i)=>`
    <div class="model-card"><div class="model-no">MODEL 0${i+1}</div><h3>${names[i]||m.name}</h3>
      <div class="model-probs"><div>TÀI<b>${m.TAI}%</b></div><div>XỈU<b>${m.XIU}%</b></div></div>
      <div class="model-foot">Hỗ trợ: ${m.support ?? "—"} · ${m.name}</div>
    </div>`).join("");
  $("modelSummary").textContent=`${pred?.models?.length||0} bộ phân tích thống kê`;
  $("aiGrid").innerHTML=(pred?.aiAnalysis||[]).map((a,i)=>`
    <div class="ai-card"><div class="ai-icon">${["⌘","✓","⤴"][i]}</div><div><h3>${a.name}</h3><p>${a.result}</p></div></div>`).join("");
}
function renderSessions(sessions=[]) {
  $("sessionsTable").innerHTML=sessions.slice(0,50).map(s=>`
    <tr><td>#${s.id}</td><td>${(s.dice||[]).join(" · ")||"—"}</td><td>${s.point??"—"}</td><td>${resultPill(s.result)}</td></tr>
  `).join("") || `<tr><td colspan="4" class="empty">Không có dữ liệu phiên.</td></tr>`;
}
function renderEvaluation(data) {
  const rows=[
    ...(data.pending||[]).map(p=>({...p,outcome:"PENDING"})),
    ...(data.evaluated||[])
  ].sort((a,b)=>Number(b.targetSessionId)-Number(a.targetSessionId)).slice(0,100);
  $("evaluationTable").innerHTML=rows.map(r=>{
    const actual=r.actualResult ? resultPill(r.actualResult) : `<span class="muted">Đang chờ</span>`;
    const status=r.outcome==="WIN"?`<span class="outcome win">THẮNG</span>`:r.outcome==="LOSS"?`<span class="outcome loss">THUA</span>`:`<span class="outcome pending">PENDING</span>`;
    return `<tr><td>#${r.targetSessionId}</td><td>${resultPill(r.prediction)}</td><td>Tài ${r.probability?.TAI ?? "—"}% / Xỉu ${r.probability?.XIU ?? "—"}%</td><td>${actual}</td><td>${status}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">Chưa có lịch sử. Nhấn “Lưu dự đoán phiên tới”.</td></tr>`;
}
function render(data) {
  dashboard=data;
  const s=data.latest, p=data.prediction;
  $("connection").textContent="Đã kết nối";
  $("sourceStatus").textContent="Đang hoạt động";
  $("latestId").textContent=s?`#${s.id}`:"—";
  $("latestResult").textContent=s?.result==="TAI"?"TÀI":s?.result==="XIU"?"XỈU":"—";
  $("latestResult").className="latest-result "+(s?.result==="XIU"?"xiu":"");
  $("diceRow").innerHTML=(s?.dice||[]).map(d=>`<span>${d}</span>`).join("")||"<span>—</span>";
  $("latestPoint").textContent=s?.point??"—";
  $("updatedAt").textContent=fmtTime(data.updatedAt);
  $("targetSession").textContent=`Phiên mục tiêu: #${s?Number(s.id)+1:"—"}`;
  if(p?.ready) {
    $("predictionOrb").textContent=p.prediction==="TAI"?"TÀI":p.prediction==="XIU"?"XỈU":"—";
    $("predictionOrb").className="prediction-orb "+(p.prediction==="TAI"?"tai":p.prediction==="XIU"?"xiu":"");
    $("predictionLabel").textContent=p.prediction==="TAI"?"Nghiêng về TÀI":p.prediction==="XIU"?"Nghiêng về XỈU":"Chưa phân định";
    $("predictionSub").textContent=`Từ ${data.sessions.length} phiên · ${p.patternMatches||0} pattern khớp`;
    $("confidenceValue").textContent=`${p.confidenceIndex}%`;
    $("confidenceBar").style.width=`${p.confidenceIndex}%`;
    $("taiProb").textContent=`${p.probability.TAI}%`;
    $("xiuProb").textContent=`${p.probability.XIU}%`;
    $("savePredictionBtn").disabled=!!data.savedForLatest;
    $("savePredictionBtn").textContent=data.savedForLatest?"Đã lưu phiên mục tiêu":"Lưu dự đoán phiên tới ↗";
  } else {
    $("predictionLabel").textContent=p?.message||"Chưa có dự đoán";
    $("predictionSub").textContent="Cần thêm dữ liệu";
  }
  const st=data.stats||{total:0,wins:0,losses:0,pending:0};
  $("statTotal").textContent=st.total;
  $("statWins").textContent=st.wins;
  $("statLosses").textContent=st.losses;
  $("statPending").textContent=st.pending;
  $("winRate").textContent=`Tỷ lệ đúng: ${st.total?((st.wins/st.total)*100).toFixed(1):"—"}${st.total?"%":""}`;
  renderModels(p); renderSessions(data.sessions); renderEvaluation(data);
}
async function refresh(silent=false) {
  if(busy)return; busy=true;
  $("refreshBtn").disabled=true;
  try { render(await api("/api/dashboard")); }
  catch(e) { $("connection").textContent="Lỗi kết nối"; $("sourceStatus").textContent="Không truy cập được"; if(!silent)showToast(e.message,true); }
  finally { busy=false; $("refreshBtn").disabled=false; }
}
$("refreshBtn").addEventListener("click",()=>refresh());
$("savePredictionBtn").addEventListener("click",async()=>{
  const btn=$("savePredictionBtn"); btn.disabled=true;
  try { await api("/api/predict",{method:"POST",body:"{}"}); showToast("Đã lưu dự đoán. Hệ thống sẽ tự đối chiếu khi phiên mục tiêu xuất hiện."); await refresh(true); }
  catch(e) { showToast(e.message,true); }
  finally { btn.disabled=false; }
});
refresh();
setInterval(()=>refresh(true),15000);
