// Pollen-inspired scene entry. Ready state comes from the existing controls.
export function createSceneShell(document) {
  const body=document.body,enter=document.getElementById('enter-scene'),menu=document.getElementById('scene-menu');
  const walk=document.getElementById('walk-mode'),prepare=document.getElementById('prepare-simulation');
  let requested=false;
  const entered=()=>{body.classList.add('entered');requested=false;enter.disabled=false;};
  const observer=new MutationObserver(()=>{if(requested&&!walk.disabled)entered();});
  observer.observe(walk,{attributes:true,attributeFilter:['disabled']});
  observer.observe(prepare,{attributes:true,attributeFilter:['disabled']});
  enter.onclick=()=>{
    requested=true;
    if(!walk.disabled){entered();return;}
    document.getElementById('loading').textContent='RUMOCA / MODELICA · preparing physics…';
    prepare.click();
  };
  menu.onclick=()=>{body.classList.toggle('entered');requested=false;};
  for(const button of document.querySelectorAll('button[data-panel]'))button.onclick=()=>{
    const name=button.dataset.panel,open=body.dataset.panel===name;
    body.dataset.panel=open?'':name;
    for(const peer of document.querySelectorAll('button[data-panel]'))peer.setAttribute('aria-expanded',String(!open&&peer.dataset.panel===name));
    window.dispatchEvent(new Event('resize'));
  };
  return {assetsReady(){enter.disabled=false;document.getElementById('loading').textContent='Scene ready. Load the Modelica physics to begin.';}};
}
