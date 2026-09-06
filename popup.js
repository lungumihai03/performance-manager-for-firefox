async function refresh(){
  const s=await browser.runtime.sendMessage({type:"getStatus"});
  document.getElementById("status").innerHTML=
    `<b>${s.awake}</b> awake · <b>${s.discarded}</b> sleeping · <b>${s.total}</b> total<br>`+
    `<small>Sleep after: ${s.idleMinutes} min · Check: ${s.checkSeconds}s`+
    (s.maxAwakeTabsEnabled?` · Max awake: ${s.maxAwakeTabs}`:"")+`</small>`;
}
document.getElementById("free").onclick=async()=>{const r=await browser.runtime.sendMessage({type:"freeMemory"});await refresh();const b=document.getElementById("free");b.textContent=`Freed ${r.discarded} tab${r.discarded===1?"":"s"}`;setTimeout(()=>b.textContent="Free memory now",1800)};
document.getElementById("discard").onclick=async()=>{const r=await browser.runtime.sendMessage({type:"discardNow"});await refresh();const b=document.getElementById("discard");b.textContent=`Discarded ${r.discarded}`;setTimeout(()=>b.textContent="Run automatic cleanup",1800)};
document.getElementById("options").onclick=()=>browser.runtime.openOptionsPage();
refresh();
