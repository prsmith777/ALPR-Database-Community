import test from "node:test";
import assert from "node:assert/strict";
import { resolveBlueIrisCamera, readMatchTolerance } from "../lib/blue-iris-camera-binding.mjs";

test("Blue Iris short IDs and display aliases resolve only an unambiguous camera", () => {
  const cameras = [{id:"eastlpr",name:"East LPR"}];
  assert.equal(resolveBlueIrisCamera(cameras," eastlpr "),cameras[0]);
  assert.equal(resolveBlueIrisCamera(cameras,"East LPR"),cameras[0]);
  assert.equal(resolveBlueIrisCamera([...cameras,{id:"other",name:"East LPR"}],"East LPR"),null);
  assert.equal(resolveBlueIrisCamera(cameras,"different"),null);
});
test("ALPR read tolerance is explicit, bounded and independent of the alert window", () => {
  assert.equal(readMatchTolerance(),3);
  assert.equal(readMatchTolerance(30),30);
  for(const value of [0,31,90,NaN,Infinity,"bad"])assert.throws(()=>readMatchTolerance(value));
});
