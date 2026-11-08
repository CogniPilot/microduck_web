import test from 'node:test';
import assert from 'node:assert/strict';
import {readPixelsAsync} from '../site/async-readback.js';

function fixture(statuses = [9]) {
  const queue = [], buffers = new Map(), deleted = [], packs = new Map([[4,8],[5,2],[6,1],[7,1]]);
  let bound = 'caller', now = 0, reads = 0, copies = 0, lost = false, error = 0;
  let pixels = Uint8Array.of(1,2,3,4);
  const gl = {
    PIXEL_PACK_BUFFER:1, PIXEL_PACK_BUFFER_BINDING:2, STREAM_READ:3,
    PACK_ALIGNMENT:4, PACK_ROW_LENGTH:5, PACK_SKIP_PIXELS:6, PACK_SKIP_ROWS:7,
    TIMEOUT_EXPIRED:8, ALREADY_SIGNALED:9, CONDITION_SATISFIED:10, WAIT_FAILED:11,
    RGBA:12, UNSIGNED_BYTE:13, SYNC_GPU_COMMANDS_COMPLETE:14, NO_ERROR:0,
    createBuffer(){const id={};buffers.set(id,null);return id;},
    getParameter(name){return name===2?bound:packs.get(name);},
    bindBuffer(_target,value){bound=value;},
    bufferData(_target,size){assert.equal(size,4);},
    pixelStorei(name,value){packs.set(name,value);},
    readPixels(x,y,w,h,format,type,offset){
      assert.deepEqual([x,y,w,h,format,type,offset],[0,0,1,1,12,13,0]);
      assert.deepEqual([...packs.values()],[4,0,0,0]);reads++;
      buffers.set(bound,new Uint8Array(pixels));
    },
    fenceSync(){return 'fence';},flush(){},
    clientWaitSync(_sync,flags,timeout){assert.equal(flags,0);assert.equal(timeout,0);return statuses.shift()??9;},
    getBufferSubData(_target,offset,destination){assert.equal(offset,0);copies++;destination.set(buffers.get(bound));},
    deleteSync(value){deleted.push(['sync',value]);},deleteBuffer(value){deleted.push(['buffer',value]);},
    getError(){return error;},isContextLost(){return lost;}
  };
  return {gl,queue,deleted,packs,options:{schedule:cb=>queue.push(cb),clock:()=>now,maxWaitMs:10},
    poll(){const cb=queue.shift();assert(cb);cb();},setTime:v=>{now=v;},setBound:v=>{bound=v;},
    setPixels:v=>{pixels=v;},setLost:()=>{lost=true;},setError:()=>{error=1282;},
    state:()=>({bound,reads,copies})};
}

test('queues a pixel-pack read, yields until signaled and preserves both caller bindings',async()=>{
  const f=fixture([8,10]),bytes=new Uint8Array(4),promise=readPixelsAsync(f.gl,1,1,bytes,f.options);
  assert.deepEqual(f.state(),{bound:'caller',reads:1,copies:0});
  assert.deepEqual([...f.packs.values()],[8,2,1,1]);
  f.poll();assert.equal(f.state().copies,0);
  f.setPixels(Uint8Array.of(9,9,9,9));f.setBound('new caller');f.poll();
  assert.equal(await promise,bytes);assert.deepEqual([...bytes],[1,2,3,4]);
  assert.equal(f.state().bound,'new caller');assert.equal(f.deleted.length,2);
});

for(const mode of ['timeout','failed fence','lost context','GPU error'])test(mode+' refuses and releases owned objects',async()=>{
  const f=fixture(mode==='timeout'?[8]:mode==='failed fence'?[11]:[9]);
  const p=readPixelsAsync(f.gl,1,1,new Uint8Array(4),f.options);
  const rejection=assert.rejects(p,/deadline|fence failed|context was lost|WebGL error/);
  if(mode==='timeout')f.setTime(10);
  if(mode==='lost context')f.setLost();
  if(mode==='GPU error')f.setError();
  f.poll();await rejection;assert.equal(f.deleted.length,2);assert.equal(f.state().bound,'caller');
});

test('a missing fence refuses after restoring pixel-pack state',async()=>{
  const f=fixture();f.gl.fenceSync=()=>null;
  await assert.rejects(readPixelsAsync(f.gl,1,1,new Uint8Array(4),f.options),/Could not fence/);
  assert.equal(f.deleted.length,1);assert.equal(f.state().bound,'caller');
  assert.deepEqual([...f.packs.values()],[8,2,1,1]);
});

test('invalid dimensions and an unbounded deadline allocate nothing',async()=>{
  const f=fixture();let allocations=0;f.gl.createBuffer=()=>{allocations++;return {};};
  await assert.rejects(readPixelsAsync(f.gl,1,1,new Uint8Array(3),f.options),/extent/);
  await assert.rejects(readPixelsAsync(f.gl,1,1,new Uint8Array(4),{...f.options,maxWaitMs:Infinity}),/deadline/);
  assert.equal(allocations,0);
});
