// Velocity/yaw commands for the pretrained controller; no visual motion is generated here.
export function createWalkingControls({button,status,canRun,start,pause,update,setRunning,onError,ensureReady=async()=>{}}){
 let active=false,actionGeneration=0;
 const held=new Set(),touchHeld=new Map(),keys=new Set(['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']);
 const editing=target=>target?.isContentEditable||!!target?.closest?.('textarea,input,select,.cm-editor,.monaco-editor');
 function has(key){return held.has(key)||[...touchHeld.values()].includes(key);}
 function command(){return [
  0.3*(Number(has('KeyW')||has('ArrowUp'))-Number(has('KeyS')||has('ArrowDown'))),
  0,
  0.5*(Number(has('KeyA')||has('ArrowLeft'))-Number(has('KeyD')||has('ArrowRight')))
 ];}
 function report(){const twist=command(),[v,,yaw]=twist;status.textContent='Target: '+v.toFixed(2)+' m/s · turn '+yaw.toFixed(2)+' rad/s';if(active)update(twist);}
 function clear(){held.clear();touchHeld.clear();report();}
 for(const control of document.querySelectorAll('[data-drive]')){
  control.addEventListener('pointerdown',event=>{
   if(!active)return;event.preventDefault();
   if(control.dataset.drive==='zero'){clear();return;}
   control.setPointerCapture(event.pointerId);touchHeld.set(event.pointerId,control.dataset.drive);report();
  });
  const release=event=>{touchHeld.delete(event.pointerId);report();};
  control.addEventListener('pointerup',release);control.addEventListener('pointercancel',release);control.addEventListener('lostpointercapture',release);
 }

 window.addEventListener('keydown',event=>{
  if(!active||editing(event.target)||!keys.has(event.code))return;
  event.preventDefault();if(event.code==='Space'){held.clear();touchHeld.clear();}else held.add(event.code);report();
 });
 window.addEventListener('keyup',event=>{if(keys.has(event.code)){held.delete(event.code);if(active){event.preventDefault();report();}}});
 window.addEventListener('blur',clear);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
 document.addEventListener('focusin',event=>{if(editing(event.target))clear();});
 function finish(reason){actionGeneration++;active=false;clear();button.disabled=false;button.textContent='Run pretrained';setRunning(false);if(reason==='fallen')status.textContent='Robot fell. Stop and prepare again to reset.';}
 async function stop(){if(!active)return;const action=actionGeneration;active=false;button.disabled=true;clear();try{await pause();}finally{if(action===actionGeneration)finish();}}
 button.onclick=async()=>{
  const action=++actionGeneration;
  button.disabled=true;
  try{
   if(active){await stop();return;}
   await ensureReady();
   if(action!==actionGeneration)return;
   if(!canRun())return;
   active=true;clear();button.textContent='Pause walking';setRunning(true);
   await start(command());
  }catch(error){if(action===actionGeneration){finish();onError(error);}}
  finally{if(action===actionGeneration)button.disabled=false;}
 };
 report();
 return {stop,finish,isRunning:()=>active,command};
}
