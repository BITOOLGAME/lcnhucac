const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "evaluation-history.json");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ pending: [], evaluated: [] }, null, 2));

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); }
  catch { return { pending: [], evaluated: [] }; }
}
function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}
function normalizeResult(row) {
  const dice = Array.isArray(row.dices) ? row.dices.map(Number) : [];
  const point = Number(row.point ?? dice.reduce((a,b)=>a+b,0));
  let result = String(row.resultTruyenThong || "").toUpperCase();
  if (result !== "TAI" && result !== "XIU") {
    result = point >= 11 && point <= 17 ? "TAI" : point >= 4 && point <= 10 ? "XIU" : "";
  }
  return {
    id: Number(row.id),
    result,
    dice,
    point,
    raw: row
  };
}
async function getSessions() {
  const response = await fetch(SOURCE_API, {
    headers: { "accept": "application/json", "user-agent": "TX-Pattern-Dashboard/1.0" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Nguồn dữ liệu trả HTTP ${response.status}`);
  const json = await response.json();
  const list = Array.isArray(json) ? json : json.list;
  if (!Array.isArray(list)) throw new Error("API không trả về list hợp lệ");
  return list.map(normalizeResult).filter(x => Number.isFinite(x.id) && x.result)
    .sort((a,b) => b.id - a.id);
}

const patterns = [
  { id:"PATTERN_6", patterns:["TXTXTT","XTXTXX"], weight:.89, confidence:.76 },
  { id:"1-1", patterns:["TXTXTX","XTXTXT"], weight:.85, confidence:.78 },
  { id:"1-2-1", patterns:["TXXTXX","XTTXTT"], weight:.88, confidence:.81 },
  { id:"1-3-1", patterns:["TXXXT","XTTTX"], weight:.86, confidence:.79 },
  { id:"1-4-1", patterns:["TXXXXT","XTTTTX"], weight:.83, confidence:.75 },
  { id:"1-5-1", patterns:["TXXXXXT","XTTTTTX"], weight:.80, confidence:.72 },
  { id:"2-1-2", patterns:["TTXTTX","XXTXXT"], weight:.87, confidence:.80 },
  { id:"2-3-2", patterns:["TTXXXT","XXTTTX"], weight:.89, confidence:.82 },
  { id:"2-4-2", patterns:["TTXXXXT","XXTTTTX"], weight:.85, confidence:.77 },
  { id:"2-5-2", patterns:["TTXXXXXT","XXTTTTTX"], weight:.81, confidence:.73 },
  { id:"3-1-3", patterns:["TTTXTTT","XXXTXXX"], weight:.84, confidence:.76 },
  { id:"3-2-3", patterns:["TTXXTT","XXTTXX"], weight:.88, confidence:.80 },
  { id:"3-3-3", patterns:["TTTXXX","XXXTTT"], weight:.90, confidence:.83 },
  { id:"3-4-3", patterns:["TTTXXXX","XXXTTTT"], weight:.86, confidence:.78 },
  { id:"3-5-3", patterns:["TTTXXXXX","XXXTTTTT"], weight:.82, confidence:.74 },
  { id:"4-1-4", patterns:["TTTTXTTTT","XXXXTXXXX"], weight:.83, confidence:.75 },
  { id:"4-2-4", patterns:["TTTTXXTTTT","XXXXTTXXXX"], weight:.86, confidence:.78 },
  { id:"4-3-4", patterns:["TTTTXXXTTTT","XXXXTTTXXXX"], weight:.89, confidence:.81 },
  { id:"4-4-4", patterns:["TTTTXXXXTTTT","XXXXTTTTXXXX"], weight:.91, confidence:.84 },
  { id:"4-5-4", patterns:["TTTTXXXXXTTTT","XXXXTTTTTXXXX"], weight:.85, confidence:.77 },
  { id:"BET_TAI_7", patterns:["TTTTTTT"], weight:.90, confidence:.82 },
  { id:"BET_XIU_7", patterns:["XXXXXXX"], weight:.90, confidence:.82 },
  { id:"1-2-3", patterns:["TXXTTT","XTTXXX"], weight:.88, confidence:.80 },
  { id:"1-2-4", patterns:["TXXTTTT","XTTXXXX"], weight:.85, confidence:.77 },
  { id:"1-2-5", patterns:["TXXTTTTT","XTTXXXXX"], weight:.82, confidence:.74 },
  { id:"2-3-4", patterns:["TTXXXTTTT","XXTTTXXXX"], weight:.89, confidence:.81 },
  { id:"2-3-5", patterns:["TTXXXTTTTT","XXTTTXXXXX"], weight:.86, confidence:.78 },
  { id:"3-3-4", patterns:["TTTXXXTTTT","XXXTTTXXXX"], weight:.87, confidence:.79 },
  { id:"3-3-5", patterns:["TTTXXXTTTTT","XXXTTTXXXXX"], weight:.84, confidence:.76 },
  { id:"3-4-4", patterns:["TTTXXXXTTTT","XXXTTTTXXXX"], weight:.88, confidence:.80 },
  { id:"3-4-5", patterns:["TTTXXXXTTTTT","XXXTTTTXXXXX"], weight:.91, confidence:.83 }
];

const clamp = (v, lo=0, hi=1) => Math.max(lo, Math.min(hi, v));
function prob(t, x, smooth=2) {
  const sum = t+x+smooth;
  return { T: (t+smooth/2)/sum, X: (x+smooth/2)/sum };
}
function countNext(seq, context) {
  let t=0,x=0;
  for (let i=0;i+context.length<seq.length;i++) {
    if (seq.slice(i,i+context.length) !== context) continue;
    if (seq[i+context.length] === "T") t++; else x++;
  }
  return {t,x};
}
function predict(history) {
  const seq = history.map(s => s.result === "TAI" ? "T" : "X").reverse().join("");
  if (seq.length < 8) return { ready:false, message:"Chưa đủ lịch sử (cần tối thiểu 8 phiên)." };
  const models = [];

  // Model 1: Pattern bank. Only uses patterns matching the current suffix.
  let pt=0,px=0,patternMatches=0;
  for (const p of patterns) for (const raw of p.patterns) {
    const pat=raw.toUpperCase();
    if (pat.length > seq.length || seq.slice(-pat.length)!==pat) continue;
    const c=countNext(seq.slice(0,-pat.length), pat); // historical context, conservative fallback below
    const all=countNext(seq, pat);
    const support=all.t+all.x;
    if (!support) continue;
    const factor=p.weight*p.confidence*(support/(support+5));
    pt += (all.t/support)*factor; px += (all.x/support)*factor; patternMatches++;
  }
  models.push({ name:"Pattern có trọng số", ...prob(pt,px), support:patternMatches });

  // Model 2: one-step transition.
  const last=seq.at(-1);
  let t=0,x=0;
  for(let i=0;i<seq.length-1;i++) if(seq[i]===last) { if(seq[i+1]==="T")t++;else x++; }
  models.push({name:"Chuyển tiếp 1 bước",...prob(t,x),support:t+x});

  // Model 3: current run length compared with prior run endings.
  let run=1;
  for(let i=seq.length-2;i>=0 && seq[i]===last;i--) run++;
  let rt=0,rx=0;
  for(let i=0;i<seq.length-1;i++) {
    let r=1;
    for(let j=i-1;j>=0 && seq[j]===seq[i];j--) r++;
    if(r===run && i+1<seq.length) { if(seq[i+1]==="T")rt++;else rx++; }
  }
  models.push({name:"Cầu bệt / độ dài chuỗi",...prob(rt,rx),support:rt+rx});

  // Model 4: multi-order n-gram.
  let ngT=0,ngX=0,ngW=0;
  for(let n=1;n<=Math.min(6,seq.length-1);n++) {
    const context=seq.slice(-n), c=countNext(seq,context), s=c.t+c.x;
    if(!s) continue;
    const w=(s/(s+5))*(n/6);
    ngT += c.t/s*w; ngX += c.x/s*w; ngW += w;
  }
  models.push({name:"N-gram đa độ dài",...prob(ngT,ngX),support:Number(ngW.toFixed(2))});

  // Model 5: ensemble of first four statistical models.
  const ws=[.30,.25,.15,.30];
  let ensT=0,ensX=0;
  models.forEach((m,i)=>{ensT+=m.T*ws[i];ensX+=m.X*ws[i];});
  const ensemble=prob(ensT*10,ensX*10,0);
  models.push({name:"Ensemble tổng hợp",...ensemble,support:models.reduce((a,m)=>a+(m.support||0),0)});

  // Three transparent analysis layers (not external LLMs).
  const votesT=models.slice(0,4).filter(m=>m.T>m.X).length;
  const votesX=4-votesT;
  const agreement=Math.max(votesT,votesX)/4;
  const entropy=-(ensemble.T*Math.log2(Math.max(ensemble.T,1e-9))+ensemble.X*Math.log2(Math.max(ensemble.X,1e-9)));
  const support=models.slice(0,4).reduce((a,m)=>a+Math.min(10,m.support||0),0);
  const sampleAdequacy=clamp(support/20);
  const rawConfidence=Math.round(100*agreement*sampleAdequacy*(1-entropy/2));
  const prediction=ensemble.T===ensemble.X ? null : ensemble.T>ensemble.X ? "TAI":"XIU";

  return {
    ready:true,
    prediction,
    probability:{TAI:Number((ensemble.T*100).toFixed(1)),XIU:Number((ensemble.X*100).toFixed(1))},
    confidenceIndex:rawConfidence,
    agreement,
    sampleAdequacy,
    patternMatches,
    models:models.map(m=>({...m,TAI:Number((m.T*100).toFixed(1)),XIU:Number((m.X*100).toFixed(1))})),
    aiAnalysis:[
      {name:"AI 1 · Pattern", result:patternMatches ? `Tìm thấy ${patternMatches} mẫu có hỗ trợ` : "Chưa có pattern khớp đủ dữ liệu"},
      {name:"AI 2 · Kiểm định", result:`Đồng thuận ${Math.round(agreement*100)}%; lượng hỗ trợ ${Math.round(sampleAdequacy*100)}%`},
      {name:"AI 3 · Tổng hợp", result:entropy>.90 ? "Hai phía gần cân bằng; tín hiệu yếu" : "Đã tổng hợp điểm; cần đối chiếu kết quả thực tế"}
    ],
    note:"Chỉ số tin cậy là chỉ báo nội bộ, không phải xác suất thắng đã được xác minh."
  };
}
function settlePending(sessions) {
  const store=readStore();
  const byId=new Map(sessions.map(s=>[String(s.id),s]));
  const stillPending=[];
  for(const p of store.pending) {
    const actual=byId.get(String(p.targetSessionId));
    if(!actual) { stillPending.push(p); continue; }
    const won=p.prediction===actual.result;
    store.evaluated.unshift({
      ...p, actualResult:actual.result, dice:actual.dice, point:actual.point,
      outcome:won?"WIN":"LOSS", settledAt:new Date().toISOString()
    });
  }
  store.pending=stillPending;
  store.evaluated=store.evaluated.slice(0,500);
  writeStore(store);
}
app.get("/api/sessions", async (req,res) => {
  try {
    const sessions=await getSessions();
    settlePending(sessions);
    res.json({ok:true,source:SOURCE_API,updatedAt:new Date().toISOString(),sessions});
  } catch(e) { res.status(502).json({ok:false,error:e.message}); }
});
app.get("/api/dashboard", async (req,res) => {
  try {
    const sessions=await getSessions();
    settlePending(sessions);
    const store=readStore();
    const history=sessions.slice(0,200);
    const prediction=predict(history);
    const latest=history[0];
    const lastSaved=store.pending.find(p=>String(p.sourceSessionId)===String(latest?.id));
    res.json({
      ok:true,updatedAt:new Date().toISOString(),source:SOURCE_API,
      latest, sessions:history, prediction,
      pending:store.pending.slice(0,30), evaluated:store.evaluated.slice(0,100),
      stats:{
        total:store.evaluated.length,
        wins:store.evaluated.filter(x=>x.outcome==="WIN").length,
        losses:store.evaluated.filter(x=>x.outcome==="LOSS").length,
        pending:store.pending.length
      },
      savedForLatest:!!lastSaved
    });
  } catch(e) { res.status(502).json({ok:false,error:e.message}); }
});
app.post("/api/predict", async (req,res) => {
  try {
    const sessions=await getSessions();
    settlePending(sessions);
    const latest=sessions[0];
    const result=predict(sessions.slice(0,200));
    if(!result.ready || !result.prediction) return res.status(400).json({ok:false,error:"Chưa đủ dữ liệu để lưu dự đoán."});
    const targetSessionId=Number(latest.id)+1;
    const store=readStore();
    const existing=store.pending.find(p=>String(p.targetSessionId)===String(targetSessionId));
    if(existing) return res.status(409).json({ok:false,error:"Đã có dự đoán cho phiên mục tiêu này.",existing});
    const item={
      predictionId:`${Date.now()}-${targetSessionId}`,
      sourceSessionId:latest.id,targetSessionId,
      prediction:result.prediction,probability:result.probability,
      confidenceIndex:result.confidenceIndex,createdAt:new Date().toISOString()
    };
    store.pending.unshift(item); store.pending=store.pending.slice(0,200); writeStore(store);
    res.json({ok:true,item});
  } catch(e) { res.status(502).json({ok:false,error:e.message}); }
});
app.get("/api/history", (req,res) => {
  const store=readStore();
  res.json({ok:true,pending:store.pending,evaluated:store.evaluated});
});
app.get("/api/health", (req,res) => res.json({ok:true,service:"TX Pattern Dashboard"}));
app.listen(PORT,()=>console.log(`Dashboard running at http://localhost:${PORT}`));
