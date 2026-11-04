// Serve actual application/data unchanged in a fresh isolated headless context.
// Vendor files are prepared outside the checkout; external requests are blocked.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=process.env.DASHBOARD_SOURCE_HTML||path.join(repo,'index.html');
const source=fs.readFileSync(sourcePath);
export const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
const vendorFiles={
  'chart.js':['d2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e','text/javascript'],
  'leaflet.js':['db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a','text/javascript'],
  'leaflet.css':['a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6','text/css']
};
const mime=name=>name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.json')?'application/json':name.endsWith('.css')?'text/css':'application/octet-stream';
export async function createHarness({viewport={width:1440,height:1000},now='2026-11-03T22:00:00Z',localDelays={},responseForRequest,externalResponse,clock=false}={}){
  assert(process.env.DASHBOARD_VENDOR_DIR,'Set DASHBOARD_VENDOR_DIR to the prepared Chart4.4.1/Leaflet1.9.4 directory');
  const vendors={};
  for(const [name,[expected,type]]of Object.entries(vendorFiles)){
    const bytes=fs.readFileSync(path.join(process.env.DASHBOARD_VENDOR_DIR,name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected,`${name} checksum`);
    vendors[name]={bytes,type};
  }
  const moduleName=process.env.DASHBOARD_PLAYWRIGHT_MODULE||'playwright';
  const playwright=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
  const engineName=process.env.DASHBOARD_BROWSER_ENGINE||'chromium';
  const engine=playwright[engineName];assert(engine,`Unsupported browser engine ${engineName}`);
  const server=http.createServer(async(req,res)=>{
    let name;
    try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
    const relative=name==='/'?'index.html':name.replace(/^\/+/,''),file=path.resolve(repo,relative);
    if(!file.startsWith(repo+path.sep)){res.writeHead(403).end();return;}
    try{
      if(localDelays[relative])await new Promise(r=>setTimeout(r,localDelays[relative]));
      const bytes=relative==='index.html'?source:fs.readFileSync(file);
      res.writeHead(200,{'content-type':mime(file),'cache-control':'no-store'});res.end(bytes);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser,context;
  const errors=[],warnings=[],externalRequests=[];
  try{
    browser=await engine.launch({headless:true,...(process.env.DASHBOARD_BROWSER_EXECUTABLE?{executablePath:process.env.DASHBOARD_BROWSER_EXECUTABLE}:{})});
    context=await browser.newContext({viewport,timezoneId:'America/New_York'});
    // Offset the wall clock while retaining elapsed real time and advancing
    // performance.now(), so Chart.js animations and gesture timing complete.
    await context.addInitScript(value=>{
      const NativeDate=Date,offset=NativeDate.parse(value)-NativeDate.now();
      class AuditDate extends NativeDate{
        constructor(...args){super(...(args.length?args:[NativeDate.now()+offset]));}
        static now(){return NativeDate.now()+offset;}
      }
      window.Date=AuditDate;
    },now);
    await context.route('**/*',async route=>{
      const url=route.request().url();
      const override=await responseForRequest?.({url,request:route.request()});
      if(override)return route.fulfill({status:200,contentType:'application/json',...override,body:typeof override.body==='string'||Buffer.isBuffer(override.body)?override.body:JSON.stringify(override.body)});
      if(url.startsWith(origin+'/'))return route.continue();
      let name=null;
      if(url.startsWith('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'))name='chart.js';
      if(url==='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js')name='leaflet.js';
      if(url==='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css')name='leaflet.css';
      if(name)return route.fulfill({status:200,contentType:vendors[name].type,body:vendors[name].bytes});
      externalRequests.push(url);
      const response=await externalResponse?.({url,request:route.request()});
      if(response)return route.fulfill({status:200,contentType:'application/json',...response,body:typeof response.body==='string'||Buffer.isBuffer(response.body)?response.body:JSON.stringify(response.body)});
      return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Controlled unavailable external source"}'});
    });
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',message=>{if(message.type()==='warning')warnings.push(message.text());});
    if(clock)await page.clock.install({time:new Date(now)});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    return {page,context,browser,origin,engineName,errors,warnings,externalRequests,
      async ready({settleMs=2500}={}){
        await page.waitForFunction(()=>document.querySelectorAll('#histBody tr').length>0&&document.querySelectorAll('#doyYearTable button').length>0&&document.querySelectorAll('#shorelyLegend-annualChart button').length>0);
        if(settleMs)await page.waitForTimeout(settleMs);
      },
      async close(){await context.close();await browser.close();await new Promise(r=>server.close(r));}
    };
  }catch(error){await context?.close();await browser?.close();await new Promise(r=>server.close(r));throw error;}
}
export function writeReport(record){
  if(process.env.DASHBOARD_BROWSER_REPORT){const file=process.env.DASHBOARD_BROWSER_REPORT;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');}
  console.log(JSON.stringify(record,null,2));
}
