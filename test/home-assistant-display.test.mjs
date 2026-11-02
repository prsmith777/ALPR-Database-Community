import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HomeAssistantDisplayService, normalizeDisplayGrant, createDisplayReadHandler } from "../lib/home-assistant-display.mjs";
import { createMiddlewareHandler } from "../lib/middleware-auth.mjs";

const id = "11111111-1111-4111-8111-111111111111", token = "A".repeat(43);
test("display origins cannot inject policy, use wildcard hosts, or contain credentials", () => {
  for (const allowedOrigin of ["*", "https://*.example.com", "https://a;script-src.example.com", "https://user:pass@ha.example", "https://ha.example/dashboard", "https://ha.example/#secret", "javascript:alert(1)", "https://ha.example/?a=b"]) {
    assert.throws(() => normalizeDisplayGrant({label:"test",allowedOrigin}));
  }
  assert.equal(normalizeDisplayGrant({label:"test",allowedOrigin:"http://[::1]:8123"}).allowedOrigin,"http://[::1]:8123");
  assert.throws(() => normalizeDisplayGrant({label:"test",allowedOrigin:"http://ha:8123",days:91}));
});

test("a display never authorizes missing, incorrect or query-string credentials", async () => {
  let queries = 0;
  const service = new HomeAssistantDisplayService({query:async () => {queries++;return {rows:[{id,label:"Display",camera_name:"Camera",token_hash:createHash("sha256").update(token).digest("hex")}]};}});
  for (const value of [null,"Bearer wrong", `Bearer ${"B".repeat(43)}`]) assert.equal(await service.authorize(id,value),null);
  assert.deepEqual(await service.authorize(id,`Bearer ${token}`),{id,label:"Display",cameraName:"Camera"});
  const handler = createDisplayReadHandler({service});
  const response = await handler(new Request(`http://alpr.invalid/api/home-assistant/display/${id}?token=${token}`),{params:{grantId:id}});
  assert.equal(response.status,401);
  assert.equal(response.headers.get("cache-control"),"no-store, private");
  assert.equal(queries,2);
});

test("display authorization cannot bypass normal pages, image routes or server actions", async () => {
  const middleware = createMiddlewareHandler({next:()=>({status:200}),redirect:url=>({status:307,path:url.pathname}),json:(body,init)=>({body,...init}),fetchImpl:()=>{throw new Error("unexpected verifier");}});
  for (const route of ["/settings", "/dashboard", "/images/plate.jpg", "/api/current-access", `/api/home-assistant/display/${id}/other`]) {
    const url = new URL(route,"http://alpr.invalid");
    const response = await middleware({url:url.href,nextUrl:url,method:"GET",cookies:{get:()=>undefined},headers:new Headers({authorization:`Bearer ${token}`})});
    assert.ok([307,401].includes(response.status));
  }
  const url = new URL(`/api/home-assistant/display/${id}`,"http://alpr.invalid");
  assert.equal((await middleware({url:url.href,nextUrl:url,method:"POST",cookies:{get:()=>undefined},headers:new Headers({authorization:`Bearer ${token}`})})).status,401);
});

test("unauthorized image requests never read storage or execute the data query", async () => {
  const handler = createDisplayReadHandler({service:{authorize:async()=>null, imagePath:()=>assert.fail("unexpected data access")},readImage:()=>assert.fail("unexpected storage access")});
  assert.equal((await handler(new Request("http://alpr.invalid"),{params:{grantId:id,readId:"1"}})).status,401);
});
