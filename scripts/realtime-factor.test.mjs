import test from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeFactor} from '../site/realtime-factor.js';
test('live factor measures advanced simulation time and includes elapsed waiting',()=>{
 let wall=1000;const rate=createRealtimeFactor(()=>wall);
 assert.equal(rate.sample(12),null);rate.start(12);assert.equal(rate.sample(12),null);
 wall=3000;assert.deepEqual(rate.sample(13),{factor:.5,simulatedSeconds:1,wallSeconds:2});
 wall=5000;assert.equal(rate.sample(13).factor,.25);
 assert.equal(rate.sample(11),null);rate.reset();assert.equal(rate.sample(13),null);
});
test('resuming starts a new interval so paused time is excluded',()=>{
 let wall=0;const rate=createRealtimeFactor(()=>wall);rate.start(5);wall=1000;
 assert.equal(rate.sample(6).factor,1);wall=11000;rate.start(6);wall=12000;
 assert.equal(rate.sample(8).factor,2);assert.throws(()=>rate.start(NaN),/Invalid/);
});
