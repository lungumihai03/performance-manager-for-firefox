const D={
  enabled:true,idleMinutes:1,checkSeconds:5,
  maxAwakeTabsEnabled:false,maxAwakeTabs:8,
  skipPinned:true,skipAudible:true,skipPlaying:true,
  skipPrivate:false,excludedDomains:[]
};

const $=id=>document.getElementById(id);

async function load(){
  const s=await browser.storage.local.get(D);
  ["enabled","maxAwakeTabsEnabled","skipPinned","skipAudible","skipPlaying","skipPrivate"]
    .forEach(id=>$(id).checked=!!s[id]);
  ["idleMinutes","checkSeconds","maxAwakeTabs"]
    .forEach(id=>$(id).value=String(s[id]));
  $("excludedDomains").value=(s.excludedDomains||[]).join("\n");
  await refreshStatus();
  await refreshLog();
}

async function save(){
  const domains=$("excludedDomains").value.split(/[\n,]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  await browser.storage.local.set({
    enabled:$("enabled").checked,
    idleMinutes:Number($("idleMinutes").value),
    checkSeconds:Number($("checkSeconds").value),
    maxAwakeTabsEnabled:$("maxAwakeTabsEnabled").checked,
    maxAwakeTabs:Number($("maxAwakeTabs").value),
    skipPinned:$("skipPinned").checked,
    skipAudible:$("skipAudible").checked,
    skipPlaying:$("skipPlaying").checked,
    skipPrivate:$("skipPrivate").checked,
    excludedDomains:[...new Set(domains)]
  });
  await browser.runtime.sendMessage({type:"reloadAlarm"});
  $("saved").textContent="Saved";
  setTimeout(()=>$("saved").textContent="",1500);
  await refreshStatus();
}

async function refreshStatus(){
  const s=await browser.runtime.sendMessage({type:"getStatus"});
  $("awakeCount").textContent=s.awake;
  $("sleepingCount").textContent=s.discarded;
  $("totalCount").textContent=s.total;
  const score=s.total?Math.round((s.discarded/s.total)*100):0;
  $("score").textContent=`${score}%`;
  const active=s.enabled?"● Running":"● Paused";
  $("liveStatus").textContent=active;
  $("liveStatus").className=`status-pill ${s.enabled?"":"paused"}`;
}

function formatTime(ts){
  return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

function escapeHtml(value){
  return String(value??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

async function refreshLog(){
  const entries=await browser.runtime.sendMessage({type:"getLog"});
  if(!entries.length){$("activityLog").innerHTML='<div class="empty">No activity yet. Actions taken by the manager will appear here.</div>';return;}
  $("activityLog").innerHTML=entries.slice(0,200).map(e=>`
    <div class="log-entry">
      <span class="log-time">${formatTime(e.time)}</span>
      <span class="log-type ${escapeHtml(e.type)}">${escapeHtml(e.type)}</span>
      <span><strong>${escapeHtml(e.title)}</strong><span class="log-detail">${e.detail?` · ${escapeHtml(e.detail)}`:""}</span></span>
    </div>`).join("");
}

$("save").onclick=save;
$("free").onclick=async()=>{
  const r=await browser.runtime.sendMessage({type:"freeMemory"});
  $("free").textContent=`Freed ${r.discarded} tab${r.discarded===1?"":"s"}`;
  setTimeout(()=>$("free").textContent="Free memory now",1800);
  await refreshStatus(); await refreshLog();
};
$("discard").onclick=async()=>{
  const r=await browser.runtime.sendMessage({type:"discardNow"});
  $("discard").textContent=`Discarded ${r.discarded}`;
  setTimeout(()=>$("discard").textContent="Run automatic cleanup",1800);
  await refreshStatus(); await refreshLog();
};
$("clearLog").onclick=async()=>{
  await browser.runtime.sendMessage({type:"clearLog"});
  await refreshLog();
};

setInterval(async()=>{await refreshStatus();await refreshLog();},5000);
load();
