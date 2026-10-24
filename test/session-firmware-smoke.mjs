// Local-only contract check: actual firmware sender -> isolated Sync database.
// Run: node --import tsx test/session-firmware-smoke.mjs /absolute/path/to/simulator/program
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { openDatabase, migrate } from '../src/db/db.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const program=resolve(process.argv[2]);
for (const mode of ['ok','missing-ack','wrong-ack','old-server']) {
  const db=openDatabase(':memory:');migrate(db);
  const app=createApp(db,{registrationDisabled:false,authRateLimitPerMinute:0,trustProxy:false,corsOrigins:'*'});
  let sessionRequests=0;
  const server=serve({hostname:'127.0.0.1',port:0,fetch:async(request,...args)=>{
    const session=new URL(request.url).pathname==='/api/v1/stats/sessions';
    if(session && mode==='old-server')return new Response('{}',{status:404});
    const response=await app.fetch(request,...args);
    if(session && ++sessionRequests===1 && ['missing-ack','wrong-ack'].includes(mode)) {
      const body=await response.json();
      if(mode==='missing-ack')delete body.accepted_session_ids;
      else body.accepted_session_ids=['different-session'];
      return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    }
    return response;
  }});
  await new Promise(resolve=>server.once('listening',resolve));
  const root=mkdtempSync(join(tmpdir(),'reading-session-firmware-'));
  try {
    const username=`session-${mode}`,password='local-test-only';
    const key=createHash('md5').update(password).digest('hex');
    assert.equal((await app.request('/users/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:key})})).status,201);
    const child=spawn(program,[],{cwd:root,env:{...process.env,SDL_VIDEODRIVER:'dummy',
      CROSSPOINT_SIM_SD:join(root,'sd'),CROSSINK_SIMULATOR_SMOKE_TEST:'1',
      CROSSINK_STATS_TEST_SERVER:`http://127.0.0.1:${server.address().port}`,CROSSINK_STATS_TEST_USER:username,
      CROSSINK_STATS_TEST_PASSWORD:password,CROSSINK_STATS_TEST_SESSION:mode},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const timeout=setTimeout(()=>child.kill('SIGKILL'),60000);
    const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timeout);
    assert.equal(code,0,output.slice(-9000));
    const rows=db.prepare('SELECT * FROM reading_sessions').all();
    assert.equal(rows.length,mode==='old-server'?0:1);
    if(rows.length)assert.equal(rows[0].seconds,1200);
    const pending=existsSync(join(root,'sd/.crosspoint/reading_sessions/0123456789abcdef0123456789abcdef.bin'));
    assert.equal(pending,mode==='old-server');
    const globals=db.prepare('SELECT payload FROM stats_device_global').all();
    assert.equal(globals.length,1);
    assert.equal(JSON.parse(globals[0].payload).seconds,mode==='old-server'?600:1200);
    console.log(`${mode}: actual firmware session payload, retries, acknowledgment and legacy counters verified`);
  } finally {
    await new Promise(resolve=>server.close(resolve));db.close();rmSync(root,{recursive:true,force:true});
  }
}
