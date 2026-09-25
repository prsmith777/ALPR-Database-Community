"use strict";

const path = require("node:path");

const openvino = require("openvino-node");

const MODEL_DIRECTORY = "/app/models/visual-search";
const MODEL_NAMES = Object.freeze([
  "vehicle-detection-0202.xml",
  "vehicle-reid-0001.xml",
  "vehicle-attributes-recognition-barrier-0039.xml",
]);

const { Core, Tensor } = openvino.addon;
const core = new Core();
const models = [];

for (const name of MODEL_NAMES) {
  const model = core.readModelSync(path.join(MODEL_DIRECTORY, name));
  const compiled = core.compileModelSync(model, "CPU");
  const inputShape = compiled.inputs[0].shape.map(Number);
  const elementCount = inputShape.reduce((product, value) => product * value, 1);
  const request = compiled.createInferRequest();
  const outputs = request.infer([
    new Tensor("f32", inputShape, new Float32Array(elementCount)),
  ]);
  const outputTensors = Object.values(outputs);
  if (
    outputTensors.length === 0 ||
    outputTensors.some((tensor) => !tensor?.data?.length) ||
    outputTensors.some((tensor) => Array.from(tensor.data).some((value) => !Number.isFinite(Number(value))))
  ) {
    throw new Error(`${name} returned an invalid inference result`);
  }
  models.push({
    name,
    inputShape,
    outputElements: outputTensors.reduce((sum, tensor) => sum + tensor.data.length, 0),
  });
}

process.stdout.write(`${JSON.stringify({ status: "ok", device: "CPU", models })}\n`);
