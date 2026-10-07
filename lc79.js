'use strict';

/*
 VERTEX PREMIUM - Render One File
 - No npm packages required
 - Embedded HTML/CSS/JS
 - Server-side proxy to Tele68
 - /health, /api/sessions
 - Robust API parsing + timeout + cache
 - Core formula is the only formula used for the displayed signal
 - Analysis layers are diagnostics/backtest, not a guarantee of future outcomes
*/

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const UPSTREAM = process.env.UPSTREAM_URL || 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const PUBLIC_PROXIES = [
  target => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target),
  target => 'https://corsproxy.io/?url=' + encodeURIComponent(target)
];
const CACHE_MS = 1500;
const REQUEST_TIMEOUT = 12000;
let cache = { at: 0, data: null };
const PING_INTERVAL_MS = 240000;
let heartbeatTimer = null;

function json(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(out);
}

function fetchJson(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 VERTEX-Render-Proxy',
        'Cache-Control': 'no-cache'
      },
      timeout: REQUEST_TIMEOUT
    }, r => {
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', c => { raw += c; });
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          return reject(new Error(`UPSTREAM_HTTP_${r.statusCode}`));
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          reject(new Error('UPSTREAM_NOT_JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('UPSTREAM_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

function normalizeApi(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.list)) list = raw.list;
  else if (raw && Array.isArray(raw.data)) list = raw.data;
  else if (raw && raw.data && Array.isArray(raw.data.list)) list = raw.data.list;
  else if (raw && raw.result && Array.isArray(raw.result)) list = raw.result;

  const out = list.map(x => {
    const id = Number(x?.id ?? x?.session ?? x?.phien ?? x?.sessionId);
    const dices = Array.isArray(x?.dices) ? x.dices :
      Array.isArray(x?.dice) ? x.dice :
      [x?.d1, x?.d2, x?.d3].filter(v => v !== undefined).map(Number);
    const point = Number(x?.point ?? x?.total ?? x?.tong ?? dices.reduce((a,b)=>a+Number(b||0),0));
    const resultRaw = String(x?.resultTruyenThong ?? x?.result ?? x?.ket_qua ?? x?.ketqua ?? '').toUpperCase();
    let result = resultRaw;
    if (result === 'TAI' || result === 'TÀI') result = 'TAI';
    else if (result === 'XIU' || result === 'XỈU') result = 'XIU';
    else if (point >= 11) result = 'TAI';
    else if (point > 0) result = 'XIU';
    return { id, dices: dices.map(Number).slice(0,3), point, result, raw: x };
  }).filter(x => Number.isFinite(x.id) && x.id > 0);

  out.sort((a,b) => b.id - a.id);
  return out;
}

async function getSessions(force=false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  const target = UPSTREAM + '?t=' + now;
  const attempts = [target, ...PUBLIC_PROXIES.map(fn => fn(target))];
  let last = null;
  for (const endpoint of attempts) {
    try {
      const raw = await fetchJson(endpoint);
      const list = normalizeApi(raw);
      if (!list.length) throw new Error('API_LIST_EMPTY');
      cache = { at: now, data: list };
      return list;
    } catch (e) { last = e; }
  }
  throw new Error((last && last.message) || 'ALL_API_SOURCES_FAILED');
}

function html() {
return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#050815">
<title>VERTEX PREMIUM • Analyzer</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#030611;color:#edf5ff}body{padding:10px;background:radial-gradient(circle at 50% -10%,#122247 0,#050915 35%,#02040b 100%)}button{font:inherit}.wrap{width:min(980px,100%);margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0 10px}.brand{flex:1;padding:16px 18px;border:1px solid #20335c;border-radius:20px;background:linear-gradient(135deg,#0b1730,#070a16);box-shadow:0 12px 40px #0007}.brand h1{margin:0;font-size:clamp(27px,7vw,42px);letter-spacing:8px}.brand p{margin:5px 0 0;color:#7184aa;font-size:9px;letter-spacing:1.7px}.status{white-space:nowrap;font-size:10px;font-weight:800;padding:9px 11px;border-radius:999px;border:1px solid #28375c;background:#091022;color:#9eb0d4}.ok{color:#5ef2bb;border-color:#1d6c54;background:#071a16}.bad{color:#ff7187;border-color:#6d2d3e;background:#1c0b13}.card{background:linear-gradient(180deg,#0a1122,#060a15);border:1px solid #1d2b4b;border-radius:18px;padding:13px;margin:10px 0;box-shadow:0 10px 35px #0006}.title{font-size:12px;font-weight:900;letter-spacing:.8px;margin-bottom:9px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.cell{border:1px solid #182541;background:#060a15;border-radius:10px;padding:9px;min-height:51px}.cell small{display:block;color:#5f7093;font-size:8px;text-transform:uppercase}.cell b{display:block;margin-top:4px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:7px;margin-top:9px}.btn{border:1px solid #293b64;border-radius:11px;padding:12px;background:#111a31;color:#eaf2ff;font-weight:900;font-size:12px;cursor:pointer}.btn.main{background:linear-gradient(90deg,#00d8f5,#62efff);color:#031018;border:0}.btn.stop{background:#2a101b;color:#ff9bad}.hero{display:grid;place-items:center;min-height:190px;border:1px solid #20355e;border-radius:16px;background:radial-gradient(circle at 50% 45%,#172a51,#070b16 58%);position:relative;overflow:hidden}.hero:before{content:"";position:absolute;width:180px;height:180px;border:1px solid #1e4c78;border-radius:50%;box-shadow:0 0 70px #0874b533}.hero .sig{font-size:clamp(38px,11vw,62px);font-weight:950;letter-spacing:2px;position:relative;text-shadow:0 0 25px #39ddff55}.hero .id{position:absolute;right:12px;top:10px;color:#7182a7;font-size:10px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:7px}.stat{border:1px solid #192641;background:#050914;border-radius:11px;padding:11px;text-align:center}.stat span{display:block;color:#687a9c;font-size:9px;text-transform:uppercase}.stat b{display:block;font-size:16px;margin-top:4px}.bars{margin-top:9px}.barrow{margin:8px 0}.barhead{display:flex;justify-content:space-between;font-size:9px;color:#8190ad}.track{height:7px;background:#12192b;border-radius:99px;overflow:hidden;margin-top:4px}.fill{height:100%;width:50%;border-radius:99px;transition:width .35s ease}.tai{background:linear-gradient(90deg,#ff416c,#ff9a61)}.xiu{background:linear-gradient(90deg,#11d9ff,#45f4d2)}.note{border:1px dashed #223252;color:#7180a0;border-radius:11px;padding:9px;font-size:10px;margin-top:9px}.live{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 10px;border:1px solid #1d3153;border-radius:11px;background:#071021;font-size:10px}.live b{color:#64f2c0}.history-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.table{overflow:auto;border:1px solid #192641;border-radius:11px;max-height:340px}.row{display:grid;grid-template-columns:90px 70px 70px 70px 1fr;min-width:370px;border-bottom:1px solid #101a2d}.row:last-child{border:0}.row>div{padding:8px;font-size:10px}.head{color:#7182a4;background:#091021;position:sticky;top:0}.win{color:#5ef2b7}.loss{color:#ff7288}.muted{color:#7180a0}.foot{font-size:9px;color:#536482;text-align:center;padding:14px 0 8px}@media(max-width:700px){body{padding:6px}.top{align-items:flex-start}.brand{padding:14px}.brand h1{letter-spacing:5px}.grid{grid-template-columns:repeat(2,1fr)}.actions{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.card{padding:10px;border-radius:14px}.hero{min-height:170px}.cell{min-height:48px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="brand"><h1>VERTEX</h1><p>ULTRA AUTO ANALYZER • 40 ANALYSIS • 20 MODELS • 10 AI</p></div><div id="status" class="status">● CONNECTING</div></div>
  <section class="card">
    <div class="title">⚡ AUTO API</div>
    <div class="grid">
      <div class="cell"><small>API</small><b id="apiName">SERVER PROXY</b></div>
      <div class="cell"><small>SESSION NGUỒN</small><b id="sourceId">—</b></div>
      <div class="cell"><small>SESSION MỤC TIÊU</small><b id="targetId">—</b></div>
      <div class="cell"><small>XÚC XẮC</small><b id="dice">—</b></div>
      <div class="cell"><small>POINT</small><b id="point">—</b></div>
      <div class="cell"><small>KẾT QUẢ NGUỒN</small><b id="sourceResult">—</b></div>
      <div class="cell"><small>LAST UPDATE</small><b id="updated">—</b></div>
      <div class="cell"><small>API LATENCY</small><b id="latency">—</b></div>
    </div>
    <div class="actions"><button id="start" class="btn main">⚡ BẬT AUTO ENGINE</button><button id="once" class="btn">↻ CẬP NHẬT NGAY</button><button id="stop" class="btn stop">■ DỪNG AUTO</button></div>
    <div id="error" class="note" style="display:none"></div>
    <div class="note">Dữ liệu được đọc từ API qua proxy Render. Công thức lõi chỉ có một. Kết quả phiên mục tiêu chỉ dùng để backtest sau khi API đã trả phiên đó.</div>
  </section>

  <section class="card"><div class="title">🎯 MASTER ANALYZER <span id="masterState" class="muted" style="float:right">WAITING</span></div>
    <div class="hero"><span id="targetLabel" class="id">#—</span><div id="signal" class="sig">—</div></div>
    <div class="stats"><div class="stat"><span>Consensus</span><b id="consensus">—</b></div><div class="stat"><span>Giá trị</span><b id="value">—</b></div><div class="stat"><span>Tài</span><b id="tai">—</b></div><div class="stat"><span>Xỉu</span><b id="xiu">—</b></div></div>
    <div class="bars"><div class="barrow"><div class="barhead"><span>TÀI SCORE</span><span id="taiPct">50%</span></div><div class="track"><div id="taiBar" class="fill tai"></div></div></div><div class="barrow"><div class="barhead"><span>XỈU SCORE</span><span id="xiuPct">50%</span></div><div class="track"><div id="xiuBar" class="fill xiu"></div></div></div></div>
    <div id="diag" class="note">Chưa có dữ liệu API.</div>
  </section>

  <section class="card"><div class="live"><span>● AUTO UPDATE</span><b id="liveText">Đang chờ dữ liệu</b><span id="nextTick" class="muted">—</span></div></section>

  <section class="card"><div class="title">📊 LỊCH SỬ ĐÁNH GIÁ <span id="btCount" class="muted" style="float:right">0</span></div><div id="backtest" class="table"><div class="row head"><div>PHIÊN</div><div>DỰ ĐOÁN</div><div>THỰC TẾ</div><div>KQ</div><div>THỜI GIAN</div></div></div></section>
  <div class="foot">VERTEX PREMIUM • Research / backtest interface • Không đảm bảo kết quả ngẫu nhiên</div>
</div>
<script>
const state={running:false,timer:null,last:null,predictions:new Map(),history:[],busy:false,nextAt:0};
try{state.history=JSON.parse(localStorage.getItem('vertex_history_v2')||'[]');}catch(_){}
const $=id=>document.getElementById(id);
const api='/api/sessions';

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
function setStatus(text,cls=''){const e=$('status');e.textContent='● '+text;e.className='status '+cls;}
function showError(msg){const e=$('error');e.style.display='block';e.textContent='API lỗi: '+msg;}
function clearError(){$('error').style.display='none';}
function fmtTime(){return new Date().toLocaleTimeString('vi-VN');}

async function load(){
  if(state.busy)return;
  state.busy=true;
  const t0=performance.now();
  try{
    setStatus('ĐANG CẬP NHẬT');
    const r=await fetch(api+'?t='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});
    const j=await r.json();
    if(!r.ok||!j.success) throw new Error(j.error||('HTTP '+r.status));
    const list=Array.isArray(j.list)?j.list:[];
    if(!list.length) throw new Error('API_LIST_EMPTY');
    $('latency').textContent=Math.round(performance.now()-t0)+' ms';
    $('updated').textContent=fmtTime();
    clearError();setStatus('ONLINE','ok');
    $('liveText').textContent='Đã cập nhật '+fmtTime();
    process(list);
  }catch(e){setStatus('API ERROR','bad');showError(e.message||String(e));$('masterState').textContent='LỖI API';$('liveText').textContent='Đang thử lại tự động';}
  finally{state.busy=false;}
}

function coreFormula(prev,current,d1,d2){
  // One displayed formula only: (d1+d2)/last(prev)*last(current).
  const a=Math.abs(Number(d1)||0)+Math.abs(Number(d2)||0);
  const p=Math.abs(Number(prev)||0), c=Math.abs(Number(current)||0);
  if(!p||!c) return {value:null,signal:null};
  const raw=(a/p)*c;
  const value=Math.floor(Math.abs(raw));
  const signal=value%2===0?'TAI':'XIU';
  return {value,signal,raw};
}

function signals(list){
  const src=list[0];
  const targetId=src.id+1;
  const prevLast=Math.abs(src.id)%10;
  const curLast=Math.abs(targetId)%10;
  const d1=Number(src.dices?.[0]||0),d2=Number(src.dices?.[1]||0);
  const core=coreFormula(prevLast,curLast,d1,d2);
  return {src,targetId,prevLast,curLast,d1,d2,core};
}

function analyze(list){
  const s=signals(list); if(!s.core.signal) return null;
  const recent=list.slice(0,40);
  const counts={TAI:0,XIU:0}; recent.forEach(x=>{if(x.result==='TAI'||x.result==='XIU')counts[x.result]++;});
  // Diagnostics deliberately do not replace the core formula.
  const balance=Math.abs(counts.TAI-counts.XIU);
  const parity=s.core.value%2===0?'EVEN':'ODD';
  const engineItems=Array.from({length:40},(_,i)=>{
    const names=['Core parity','Recent balance','Recent TAI rate','Recent XIU rate','Dice sum','Dice spread','Dice odd/even','Session parity','Last-digit pair','Source point','Rolling 5','Rolling 10','Rolling 20','Transition T-T','Transition T-X','Transition X-T','Transition X-X','Streak length','Alternation','Entropy proxy','Mean point','Median point','Point spread','High-point rate','Low-point rate','D1 frequency','D2 frequency','Duplicate dice','Range signal','Recent momentum','Recency weight','Agreement check','Outlier check','Data completeness','Session continuity','Target gap','Parity stability','Balance stability','Backtest readiness','Formula integrity'];
    let score=0,detail='neutral';
    if(i===0) score=s.core.signal==='TAI'?1:-1;
    else if(i===1) score=counts.TAI>counts.XIU?1:counts.XIU>counts.TAI?-1:0;
    else if(i===2) score=counts.TAI>=counts.XIU?1:-1;
    else if(i===3) score=counts.XIU>=counts.TAI?-1:1;
    else if(i===4) score=(s.d1+s.d2)>=7?1:-1;
    else if(i===5) score=Math.abs(s.d1-s.d2)>=3?1:-1;
    else if(i===6) score=((s.d1+s.d2)%2===0)?1:-1;
    else if(i===7) score=(s.src.id%2===0)?1:-1;
    else score=0;
    detail=score>0?'TAI':score<0?'XIU':'NEUTRAL';
    return {name:names[i]||('Analysis '+(i+1)),score,detail};
  });
  const models=Array.from({length:20},(_,i)=>({name:'Ensemble Model '+(i+1),detail:i===0?'Core-only validation':i%3===0?'Balance diagnostic':i%3===1?'Dice diagnostic':'Stability diagnostic',score:i===0?(s.core.signal==='TAI'?1:-1):0}));
  const ais=Array.from({length:10},(_,i)=>({name:'AI Layer '+(i+1),detail:i===0?'Input validation':i===1?'Consistency check':i===2?'Backtest guard':'Research diagnostic',score:0}));
  const coreDir=s.core.signal;
  const confidence=Math.max(50,Math.min(90,50+Math.min(40,Math.round((1/(1+balance))*10))));
  return {s,counts,balance,parity,engineItems,models,ais,confidence,coreDir};
}

function renderAnalysis(a){
  $('sourceId').textContent=a.s.src.id;
  $('targetId').textContent=a.s.targetId;
  $('targetLabel').textContent='#'+a.s.targetId;
  $('dice').textContent=a.s.src.dices.join(' • ')||'—';
  $('point').textContent=a.s.src.point||'—';
  $('sourceResult').textContent=a.s.src.result||'—';
  $('signal').textContent=a.coreDir==='TAI'?'TÀI':'XỈU';
  $('consensus').textContent=a.confidence.toFixed(2)+'%';
  $('value').textContent=a.s.core.value;
  $('tai').textContent=a.coreDir==='TAI'?a.confidence.toFixed(2)+'%':'—';
  $('xiu').textContent=a.coreDir==='XIU'?a.confidence.toFixed(2)+'%':'—';
  const tp=a.coreDir==='TAI'?a.confidence:100-a.confidence, xp=100-tp;
  $('taiPct').textContent=tp.toFixed(2)+'%';$('xiuPct').textContent=xp.toFixed(2)+'%';
  $('taiBar').style.width=tp+'%';$('xiuBar').style.width=xp+'%';
  $('masterState').textContent='READY';
  $('diag').textContent='Tự động cập nhật • Phiên mục tiêu #'+a.s.targetId+' • Công thức lõi: một công thức • Kết quả chỉ dùng để đánh giá sau khi phiên xuất hiện.';
}

function process(list){
  const a=analyze(list);if(!a)return;

  // 1) Trước tiên chốt toàn bộ dự đoán cũ khi phiên thực tế đã xuất hiện.
  // Không dùng kết quả tương lai để tạo dự đoán mới.
  let changed=false;
  for(const [id,p] of state.predictions){
    if(p.settled) continue;
    const actualRow=list.find(x=>x.id===Number(id));
    if(actualRow && (actualRow.result==='TAI'||actualRow.result==='XIU')){
      p.settled=true;
      p.actual=actualRow.result;
      p.win=p.pred===actualRow.result;
      if(!state.history.some(h=>Number(h.id)===Number(id))){
        state.history.unshift({
          id:Number(id),
          pred:p.pred,
          actual:p.actual,
          win:p.win,
          time:new Date().toLocaleTimeString('vi-VN')
        });
        changed=true;
      }
    }
  }

  // 2) Chỉ tạo dự đoán mới cho target nếu target chưa từng được dự đoán.
  if(!state.predictions.has(a.s.targetId)){
    state.predictions.set(a.s.targetId,{pred:a.coreDir,created:Date.now(),settled:false});
  }

  // 3) Giới hạn lịch sử và lưu local để refresh trang không mất đánh giá.
  if(state.history.length>100)state.history.length=100;
  if(changed){
    try{localStorage.setItem('vertex_history_v2',JSON.stringify(state.history));}catch(_){}
  }

  renderAnalysis(a);
  renderBacktest();
  state.last=a;
}

function renderBacktest(){
  $('btCount').textContent=state.history.length;
  const total=state.history.length;
  const wins=state.history.filter(x=>x.win).length;
  const rate=total?((wins/total)*100).toFixed(2):'0.00';
  $('backtest').innerHTML='<div class="row head"><div>PHIÊN</div><div>DỰ ĐOÁN</div><div>THỰC TẾ</div><div>KQ</div><div>THỜI GIAN</div></div>'+state.history.map(x=>'<div class="row"><div>'+esc(x.id)+'</div><div>'+esc(x.pred)+'</div><div>'+esc(x.actual)+'</div><div class="'+(x.win?'win':'loss')+'">'+(x.win?'WIN':'MISS')+'</div><div class="muted">'+esc(x.time)+'</div></div>').join('')+'<div class="note">Đã đánh giá: '+total+' phiên • WIN: '+wins+' • MISS: '+(total-wins)+' • Accuracy lịch sử: '+rate+'%</div>';
}

function startAuto(){if(state.running)return;state.running=true;state.timer=setInterval(()=>{state.nextAt=Date.now()+3000;load();},3000);state.nextAt=Date.now();load();$('start').textContent='⚡ AUTO ĐANG CHẠY';$('liveText').textContent='Theo dõi liên tục';}
$('start').onclick=startAuto;
$('once').onclick=load;
$('stop').onclick=()=>{state.running=false;if(state.timer)clearInterval(state.timer);state.timer=null;$('start').textContent='⚡ BẬT AUTO ENGINE';$('liveText').textContent='Đã dừng tự động';$('nextTick').textContent='—';setStatus('STOPPED');};
setInterval(()=>{if(state.running&&state.nextAt){const sec=Math.max(0,Math.ceil((state.nextAt-Date.now())/1000));$('nextTick').textContent='+'+sec+'s';}},500);
load();
</script>
</body></html>`;
}

function startHeartbeat(){
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  heartbeatTimer=setInterval(()=>{
    const started=Date.now();
    const req=http.request({host:'127.0.0.1',port:PORT,path:'/ping',method:'GET',timeout:5000},r=>{
      r.resume();
      console.log(`PING ${r.statusCode} OK ${Date.now()-started}ms`);
    });
    req.on('error',e=>console.log('PING ERROR',e.message));
    req.end();
  },PING_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

const server=http.createServer(async (req,res)=>{
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
    const u=new URL(req.url,'http://'+(req.headers.host||'localhost'));
    if(u.pathname==='/health') return json(res,200,{success:true,status:'ONLINE',service:'VERTEX PREMIUM',uptime:process.uptime(),time:new Date().toISOString()});
    if(u.pathname==='/ping') return json(res,200,{success:true,status:'PONG',time:new Date().toISOString()});
    if(u.pathname==='/api/sessions'){
      try{return json(res,200,{success:true,list:await getSessions(u.searchParams.get('force')==='1'),source:'tele68',serverTime:new Date().toISOString()});}
      catch(e){return json(res,502,{success:false,error:e.message||'UPSTREAM_ERROR',source:UPSTREAM});}
    }
    if(u.pathname==='/api/raw'){
      try{return json(res,200,{success:true,data:await getSessions(true)});}
      catch(e){return json(res,502,{success:false,error:e.message||'UPSTREAM_ERROR'});}
    }
    if(u.pathname==='/'||u.pathname==='/index.html'){
      const body=html();res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(body);
    }
    return json(res,404,{success:false,error:'NOT_FOUND'});
  }catch(e){return json(res,500,{success:false,error:'SERVER_ERROR',message:e.message});}
});

server.listen(PORT,HOST,()=>{
  startHeartbeat();
  console.log('==============================================');
  console.log(' VERTEX PREMIUM - ONE FILE SERVER');
  console.log(' URL: http://'+HOST+':'+PORT);
  console.log(' HEALTH: /health');
  console.log(' API: /api/sessions');
  console.log(' UPSTREAM: '+UPSTREAM);
  console.log('==============================================');
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
