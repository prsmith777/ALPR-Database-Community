# Visual-search models

These pinned models run locally through the OpenVINO 2025.4 LTS runtime
(`openvino-node@2025.4.0`). The application
does not download models or transmit images during runtime.

## vehicle-detection-0202

- Source: Open Model Zoo 2023.0, FP16 IR
- Documentation: https://docs.openvino.ai/2023.3/omz_models_model_vehicle_detection_0202.html
- License: Apache-2.0 (`LICENSE.open-model-zoo.txt`)
- `vehicle-detection-0202.xml` SHA-256: `08b844a402a615605a626261fd9e27161a044845426ece5aa0872203c50bb5a2`
- `vehicle-detection-0202.bin` SHA-256: `c0a602428cfd71ac63a533c23b7cdb8c83e144f118a81001420246701daf0c78`

The FP16 artifacts came from:

`https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/vehicle-detection-0202/FP16/`

## vehicle-reid-0001

- Upstream artifact: `osnet_ain_x1_0_vehicle_reid.onnx`
- Documentation: https://docs.openvino.ai/2023.3/omz_models_model_vehicle_reid_0001.html
- License: MIT (`LICENSE.vehicle-reid-0001.txt`)
- Upstream ONNX SHA-256: `4aaad3e5db648618b0df3d2ff21c61323985ff9e50194c3d2edd4fb87c92d91f`
- `vehicle-reid-0001.xml` SHA-256: `c7d4dd41453ef1f652efbab1405d5893dffb609e614c732230871d2a525eafc6`
- `vehicle-reid-0001.bin` SHA-256: `dd439e50a9040378ee784a12cd26881da98cd3ffd55c652a3dda1df186a04c81`

The ONNX file was downloaded from Open Model Zoo 2022.1 and converted once with
OpenVINO 2024.6.0. The fixed input shape prevents runtime conversion and startup
ambiguity:

```text
ovc osnet_ain_x1_0_vehicle_reid.onnx \
  --output_model vehicle-reid-0001.xml \
  --input input[1,3,208,208] \
  --compress_to_fp16=True
```

The original model uses RGB input. The detector's converted IR uses BGR input.
