export const VEHICLE_ASSET_ATTRIBUTE_ALGORITHM = "canonical-overview-crop-attributes-v1";

export const VEHICLE_ASSET_COLOR_ATTRIBUTE = Object.freeze({
  attributeKey: "color",
  provider: "local-hsv-histogram",
  modelVersion: "vehicle-color-hsv-v2",
});

export const VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE = Object.freeze({
  attributeKey: "body_type",
  provider: "openvino-open-model-zoo",
  modelVersion: "vehicle-attributes-recognition-barrier-0039-fp16-v1",
});

export const VEHICLE_ASSET_ATTRIBUTE_CONTRACTS = Object.freeze([
  VEHICLE_ASSET_COLOR_ATTRIBUTE,
  VEHICLE_ASSET_BODY_TYPE_ATTRIBUTE,
]);
