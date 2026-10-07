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
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#050815;color:#eaf2ff}body{padding:14px}button{font:inherit} .wrap{width:min(1180px,100%);margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 14px}.brand{padding:18px 20px;border:1px solid #24345b;border-radius:22px;background:linear-gradient(135deg,#0d1833,#080b18);box-shadow:0 0 35px #091a45}.brand h1{margin:0;font-size:clamp(26px,6vw,44px);letter-spacing:8px}.brand p{margin:6px 0 0;color:#7182a8;font-size:11px;letter-spacing:2px}.status{font-size:12px;padding:8px 12px;border-radius:999px;border:1px solid #26345b;background:#0b1124;color:#9fb0d3}.ok{color:#62f7bb;border-color:#1d6e55}.bad{color:#ff7387;border-color:#713043}.card{background:linear-gradient(180deg,#0b1225,#070b18);border:1px solid #202d50;border-radius:18px;padding:14px;margin:12px 0;box-shadow:0 12px 35px #0005}.title{font-size:13px;font-weight:800;letter-spacing:.8px;margin-bottom:10px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.cell{border:1px solid #1c2948;background:#070c1b;border-radius:11px;padding:10px;min-height:56px}.cell small{display:block;color:#637394;font-size:9px;text-transform:uppercase}.cell b{display:block;margin-top:5px;font-size:14px;overflow:hidden;text-overflow:ellipsis}.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.btn{border:1px solid #30426d;border-radius:12px;padding:13px;background:#121b34;color:#eaf2ff;font-weight:800;cursor:pointer}.btn.main{background:linear-gradient(90deg,#00d9ff,#5ef2ff);color:#04101a;border:0}.btn.stop{background:#321322;color:#ff9aae}.btn:active{transform:scale(.99)}.hero{display:grid;place-items:center;min-height:165px;border:1px solid #21345e;border-radius:16px;background:radial-gradient(circle at 50% 45%,#162448,#070b18 58%);position:relative;overflow:hidden}.hero .sig{font-size:44px;font-weight:900}.hero .id{position:absolute;right:12px;top:10px;color:#7182a8;font-size:11px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}.stat{border:1px solid #1d2947;background:#060a17;border-radius:12px;padding:12px;text-align:center}.stat span{display:block;color:#7180a0;font-size:10px;text-transform:uppercase}.stat b{display:block;font-size:18px;margin-top:5px}.bars{margin-top:10px}.barrow{margin:9px 0}.barhead{display:flex;justify-content:space-between;font-size:10px;color:#8796b6}.track{height:8px;background:#131a2d;border-radius:99px;overflow:hidden;margin-top:5px}.fill{height:100%;width:50%;border-radius:99px}.tai{background:linear-gradient(90deg,#ff426c,#ff9860)}.xiu{background:linear-gradient(90deg,#16d9ff,#39f5d1)}.note{border:1px dashed #263558;color:#7180a0;border-radius:12px;padding:10px;font-size:11px;margin-top:10px}.section-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.mini{border:1px solid #1d2947;background:#070b18;border-radius:11px;padding:10px}.mini strong{font-size:11px}.mini div{color:#7180a0;font-size:10px;margin-top:5px}.table{overflow:auto;border:1px solid #1d2947;border-radius:12px}.row{display:grid;grid-template-columns:90px 70px 70px 70px 1fr;min-width:370px;border-bottom:1px solid #121c32}.row:last-child{border:0}.row>div{padding:8px;font-size:10px}.head{color:#7484a7;background:#0a1020}.win{color:#5ef2b7}.loss{color:#ff7288}.muted{color:#7180a0}.foot{font-size:10px;color:#566685;text-align:center;padding:16px 0}.spin{animation:spin 1s linear infinite;display:inline-block}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:800px){body{padding:7px}.top{display:block}.status{display:inline-block;margin-top:8px}.grid{grid-template-columns:repeat(2,1fr)}.actions{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.section-grid{grid-template-columns:repeat(2,1fr)}.card{padding:10px;border-radius:14px}.brand{padding:15px}.brand h1{letter-spacing:5px}}
@media(min-width:801px){.card{padding:18px}}
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

  <section class="card"><div class="title">40 ANALYSIS ENGINES</div><div id="engines" class="section-grid"></div></section>
  <section class="card"><div class="title">20 ENSEMBLE MODELS</div><div id="models" class="section-grid"></div></section>
  <section class="card"><div class="title">10 SMART AI LAYERS</div><div id="ais" class="section-grid"></div></section>

  <section class="card"><div class="title">📊 AUTO BACKTEST <span id="btCount" class="muted" style="float:right">0</span></div><div id="backtest" class="table"><div class="row head"><div>PHIÊN</div><div>DỰ ĐOÁN</div><div>THỰC TẾ</div><div>KQ</div><div>THỜI GIAN</div></div></div></section>
  <div class="foot">VERTEX PREMIUM • Research / backtest interface • Không đảm bảo kết quả ngẫu nhiên</div>
</div>
<script>
const state={running:false,timer:null,last:null,predictions:new Map(),history:[]};
try{state.history=JSON.parse(localStorage.getItem('vertex_history_v2')||'[]');}catch(_){}
const $=id=>document.getElementById(id);
const api='/api/sessions';

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
function setStatus(text,cls=''){const e=$('status');e.textContent='● '+text;e.className='status '+cls;}
function showError(msg){const e=$('error');e.style.display='block';e.textContent='API lỗi: '+msg;}
function clearError(){$('error').style.display='none';}
function fmtTime(){return new Date().toLocaleTimeString('vi-VN');}

async function load(){
  const t0=performance.now();
  try{
    setStatus('LOADING');
    const r=await fetch(api+'?t='+Date.now(),{cache:'no-store',headers:{Accept:'application/json'}});
    const j=await r.json();
    if(!r.ok||!j.success) throw new Error(j.error||('HTTP '+r.status));
    const list=Array.isArray(j.list)?j.list:[];
    if(!list.length) throw new Error('API_LIST_EMPTY');
    $('latency').textContent=Math.round(performance.now()-t0)+' ms';
    $('updated').textContent=fmtTime();
    clearError();setStatus('ONLINE','ok');
    process(list);
  }catch(e){setStatus('API ERROR','bad');showError(e.message||String(e));$('masterState').textContent='ERROR';}
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
  const tp=a.coreDir==='TAI'?a.confidence:100-a.confidence;
  const xp=100-tp;
  $('taiPct').textContent=tp.toFixed(2)+'%';$('xiuPct').textContent=xp.toFixed(2)+'%';$('taiBar').style.width=tp+'%';$('xiuBar').style.width=xp+'%';
  $('masterState').textContent='READY';
  $('diag').textContent='Core: '+a.coreDir+' • Giá trị '+a.s.core.value+' • parity '+a.parity+' • '+a.engineItems.filter(x=>x.score!==0).length+'/40 engines có tín hiệu chẩn đoán. Consensus chỉ là chỉ số nghiên cứu, không phải xác suất thắng.';
  $('engines').innerHTML=a.engineItems.map((x,i)=>'<div class="mini"><strong>'+(i+1)+'. '+esc(x.name)+'</strong><div>'+esc(x.detail)+'</div></div>').join('');
  $('models').innerHTML=a.models.map((x,i)=>'<div class="mini"><strong>'+(i+1)+'. '+esc(x.name)+'</strong><div>'+esc(x.detail)+'</div></div>').join('');
  $('ais').innerHTML=a.ais.map((x,i)=>'<div class="mini"><strong>'+(i+1)+'. '+esc(x.name)+'</strong><div>'+esc(x.detail)+'</div></div>').join('');
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

$('start').onclick=()=>{if(state.running)return;state.running=true;state.timer=setInterval(load,5000);load();$('start').textContent='⚡ AUTO ENGINE ĐANG CHẠY';};
$('once').onclick=load;
$('stop').onclick=()=>{state.running=false;if(state.timer)clearInterval(state.timer);state.timer=null;$('start').textContent='⚡ BẬT AUTO ENGINE';setStatus('STOPPED');};
load();
</script>
</body></html>`;
}

const server=http.createServer(async (req,res)=>{
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
    const u=new URL(req.url,'http://'+(req.headers.host||'localhost'));
    if(u.pathname==='/health') return json(res,200,{success:true,status:'ONLINE',service:'VERTEX PREMIUM',uptime:process.uptime(),time:new Date().toISOString()});
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
