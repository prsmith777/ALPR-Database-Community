const DEFAULT_VIEWPORT_ASPECT = 16 / 9;
const DEFAULT_PADDING_RATIO = 0.12;

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

function normalizedDetectionBox(box) {
  if (!box) return null;

  const values = Array.isArray(box)
    ? box
    : [box.left, box.top, box.right, box.bottom];
  if (
    values.length !== 4
    || values.some((value) => !Number.isFinite(Number(value)))
  ) {
    return null;
  }

  const [left, top, right, bottom] = values.map(Number);
  if (
    left < 0
    || top < 0
    || right > 1
    || bottom > 1
    || right <= left
    || bottom <= top
  ) {
    return null;
  }

  return { left, top, right, bottom };
}

function boundedOrigin(center, size) {
  return clamp(center - size / 2, 0, Math.max(0, 1 - size));
}

function percentage(value) {
  return `${Number(value.toFixed(4))}%`;
}

export function getVehiclePreviewCropStyle(
  detectionBox,
  imageWidth,
  imageHeight,
  {
    viewportAspect = DEFAULT_VIEWPORT_ASPECT,
    paddingRatio = DEFAULT_PADDING_RATIO,
  } = {}
) {
  const box = normalizedDetectionBox(detectionBox);
  const width = Number(imageWidth);
  const height = Number(imageHeight);
  const targetAspect = Number(viewportAspect);
  const padding = Number(paddingRatio);
  if (
    !box
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(targetAspect)
    || targetAspect <= 0
    || !Number.isFinite(padding)
    || padding < 0
  ) {
    return null;
  }

  const boxWidth = box.right - box.left;
  const boxHeight = box.bottom - box.top;
  const paddedLeft = clamp(box.left - boxWidth * padding, 0, 1);
  const paddedRight = clamp(box.right + boxWidth * padding, 0, 1);
  const paddedTop = clamp(box.top - boxHeight * padding, 0, 1);
  const paddedBottom = clamp(box.bottom + boxHeight * padding, 0, 1);
  const centerX = (paddedLeft + paddedRight) / 2;
  const centerY = (paddedTop + paddedBottom) / 2;

  let cropWidth = paddedRight - paddedLeft;
  let cropHeight = paddedBottom - paddedTop;
  const normalizedTargetAspect = targetAspect * height / width;
  if (cropWidth / cropHeight < normalizedTargetAspect) {
    cropWidth = cropHeight * normalizedTargetAspect;
  } else {
    cropHeight = cropWidth / normalizedTargetAspect;
  }

  if (cropWidth > 1) {
    cropWidth = 1;
    cropHeight = Math.min(1, cropWidth / normalizedTargetAspect);
  }
  if (cropHeight > 1) {
    cropHeight = 1;
    cropWidth = Math.min(1, cropHeight * normalizedTargetAspect);
  }

  const cropLeft = boundedOrigin(centerX, cropWidth);
  const cropTop = boundedOrigin(centerY, cropHeight);
  return {
    position: "absolute",
    left: percentage((-cropLeft / cropWidth) * 100),
    top: percentage((-cropTop / cropHeight) * 100),
    width: percentage((1 / cropWidth) * 100),
    height: percentage((1 / cropHeight) * 100),
  };
}
