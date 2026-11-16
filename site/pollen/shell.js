// Pollen-inspired scene entry. Ready state comes from the existing controls.
export function createSceneShell(document, {onEnter} = {}) {
  const body=document.body,enter=document.getElementById('enter-scene'),menu=document.getElementById('scene-menu');
  const walk=document.getElementById('walk-mode'),prepare=document.getElementById('prepare-simulation');
  // Entry needs only the visual scene (the button is enabled by assetsReady): the live
  // controls stay disabled until the simulation is ready, and a recorded preview, when
  // there is one, is labelled as such meanwhile.
  enter.onclick=()=>{
    if(onEnter)onEnter();
    else if(walk.disabled&&!prepare.disabled){
      document.getElementById('loading').textContent='RUMOCA / MODELICA · preparing physics…';
      prepare.click();
    }
    body.classList.add('entered');
  };
  menu.onclick=()=>{body.classList.toggle('entered');};
  for(const button of document.querySelectorAll('button[data-panel]'))button.onclick=()=>{
    const name=button.dataset.panel,open=body.dataset.panel===name;
    body.dataset.panel=open?'':name;
    for(const peer of document.querySelectorAll('button[data-panel]'))peer.setAttribute('aria-expanded',String(!open&&peer.dataset.panel===name));
    window.dispatchEvent(new Event('resize'));
  };
  return {assetsReady(){enter.disabled=false;document.getElementById('loading').textContent='Scene ready. Load the Modelica physics to begin.';}};
}
