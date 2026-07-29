import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { X, ZoomIn } from "lucide-react";
import NextImage from "next/image";

const MAX_IMAGE_ZOOM = 12;

function normalizedFocusCoordinates(coordinates, imageSize) {
  if (!coordinates || !imageSize) return null;

  const values = Array.isArray(coordinates)
    ? coordinates
    : [coordinates.left, coordinates.top, coordinates.right, coordinates.bottom];
  if (values.length !== 4 || values.some((value) => !Number.isFinite(Number(value)))) {
    return null;
  }

  const numeric = values.map(Number);
  if (numeric.every((value) => value >= 0 && value <= 1)) {
    return [
      numeric[0] * imageSize.width,
      numeric[1] * imageSize.height,
      numeric[2] * imageSize.width,
      numeric[3] * imageSize.height,
    ];
  }
  return numeric;
}

const ImageViewer = ({
  image,
  compactControls = false,
  plateZoom = 3,
  fitPlateOnOpen = false,
  zoomEnabled = false,
  defaultZoom = null,
  zoomLabel = "Zoom to Plate",
  onFullscreenChange = null,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState(null);
  const [containerSize, setContainerSize] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const initializedViewRef = useRef(null);
  const canZoom = zoomEnabled || Boolean(image?.crop_coordinates || image?.focus_coordinates);
  const viewResetKey = JSON.stringify([
    image?.url || "",
    image?.focus_coordinates || image?.crop_coordinates || null,
    defaultZoom,
    fitPlateOnOpen,
    plateZoom,
  ]);

  const focusCoordinates = useMemo(
    () => normalizedFocusCoordinates(
      image?.focus_coordinates || image?.crop_coordinates,
      imageSize
    ),
    [image?.crop_coordinates, image?.focus_coordinates, imageSize]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const updateContainerSize = () => {
      setContainerSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateContainerSize();
    const observer = new ResizeObserver(updateContainerSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isFullscreen]);

  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);

  useEffect(() => () => onFullscreenChange?.(false), [onFullscreenChange]);

  const getFocusFitZoom = useCallback(() => {
    if (
      !focusCoordinates ||
      !imageSize ||
      imageSize.url !== image?.url ||
      !containerSize?.width ||
      !containerSize?.height
    ) {
      return Math.max(1, Number(plateZoom) || 1);
    }

    const [xMin, yMin, xMax, yMax] = focusCoordinates;
    const fitScale = Math.min(
      containerSize.width / imageSize.width,
      containerSize.height / imageSize.height
    );
    const focusWidth = Math.max((xMax - xMin) * fitScale, 1);
    const focusHeight = Math.max((yMax - yMin) * fitScale, 1);
    const margin = 0.85;
    const fittedZoom = Math.min(
      MAX_IMAGE_ZOOM,
      (containerSize.width * margin) / focusWidth,
      (containerSize.height * margin) / focusHeight
    );

    return Math.max(1, Math.floor(fittedZoom * 10) / 10);
  }, [containerSize, focusCoordinates, image?.url, imageSize, plateZoom]);

  const getSliderMax = useCallback(
    () => Math.max(5, getFocusFitZoom()),
    [getFocusFitZoom]
  );

  const getFocusZoom = useCallback(() => {
    if (fitPlateOnOpen || image?.focus_coordinates) return getFocusFitZoom();
    const midpoint = (1 + getSliderMax()) / 2;
    return Math.round(midpoint * 10) / 10;
  }, [fitPlateOnOpen, getFocusFitZoom, getSliderMax, image?.focus_coordinates]);

  const clampZoom = useCallback(
    (value) => Math.min(getSliderMax(), Math.max(1, Math.round(value * 10) / 10)),
    [getSliderMax]
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const setZoomAndResetPan = useCallback((nextZoom) => {
    setZoom(clampZoom(nextZoom));
    setPan({ x: 0, y: 0 });
  }, [clampZoom]);

  const handleWheel = useCallback((event) => {
    if (!canZoom || event.deltaY === 0) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const wheelStep = (getSliderMax() - 1) / 3;
    setZoom((currentZoom) => clampZoom(currentZoom + direction * wheelStep));
  }, [canZoom, clampZoom, getSliderMax]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [handleWheel, isFullscreen]);

  useEffect(() => {
    setImageSize(null);
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active) setImageSize({ url: image.url, width: img.width, height: img.height });
    };
    img.src = image.url;
    return () => {
      active = false;
    };
  }, [image.url]);

  useEffect(() => {
    const needsFocusMeasurements = defaultZoom === null && Boolean(
      image?.focus_coordinates || image?.crop_coordinates
    );
    if (
      initializedViewRef.current === viewResetKey ||
      (needsFocusMeasurements && (
        imageSize?.url !== image.url ||
        !containerSize?.width ||
        !containerSize?.height
      ))
    ) {
      return;
    }

    const initialZoom = defaultZoom === null
      ? image?.focus_coordinates || image?.crop_coordinates ? getFocusZoom() : 1
      : defaultZoom;
    initializedViewRef.current = viewResetKey;
    setZoom(clampZoom(initialZoom));
    setPan({ x: 0, y: 0 });
  }, [
    clampZoom,
    containerSize,
    defaultZoom,
    getFocusZoom,
    image?.crop_coordinates,
    image?.focus_coordinates,
    image.url,
    imageSize,
    viewResetKey,
  ]);

  useEffect(() => {
    if (!isFullscreen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  const getImageStyle = () => {
    if (!imageSize || !containerSize?.width || !containerSize?.height) {
      return { position: "relative", width: "100%", height: "100%" };
    }

    const fitScale = Math.min(
      containerSize.width / imageSize.width,
      containerSize.height / imageSize.height
    );
    const renderedWidth = imageSize.width * fitScale;
    const renderedHeight = imageSize.height * fitScale;
    const offsetX = (containerSize.width - renderedWidth) / 2;
    const offsetY = (containerSize.height - renderedHeight) / 2;
    const [xMin, yMin, xMax, yMax] = focusCoordinates || [
      0,
      0,
      imageSize.width,
      imageSize.height,
    ];
    const focusX = offsetX + (xMin + (xMax - xMin) / 2) * fitScale;
    const focusY = offsetY + (yMin + (yMax - yMin) / 2) * fitScale;
    const translateX = zoom === 1
      ? 0
      : containerSize.width / 2 - focusX * zoom + pan.x;
    const translateY = zoom === 1
      ? 0
      : containerSize.height / 2 - focusY * zoom + pan.y;

    return {
      position: "relative",
      transform: zoom === 1
        ? "none"
        : `translate(${translateX}px, ${translateY}px) scale(${zoom})`,
      transformOrigin: "0 0",
      width: "100%",
      height: "100%",
      transition: isDragging ? "none" : "transform 0.12s ease-out",
    };
  };

  const handlePointerDown = (event) => {
    if (zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, pan };
    setIsDragging(true);
  };

  const handlePointerMove = (event) => {
    if (!dragRef.current) return;
    const maxX = Math.max(containerSize?.width || 0, 1) * zoom;
    const maxY = Math.max(containerSize?.height || 0, 1) * zoom;
    setPan({
      x: Math.max(-maxX, Math.min(maxX, dragRef.current.pan.x + event.clientX - dragRef.current.x)),
      y: Math.max(-maxY, Math.min(maxY, dragRef.current.pan.y + event.clientY - dragRef.current.y)),
    });
  };

  const endDrag = (event) => {
    if (dragRef.current && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const controls = canZoom ? (
    <div
      className={
        compactControls
          ? "grid grid-cols-2 gap-2 py-2"
          : "flex items-center gap-4 py-2 2xl:px-2 2xl:pt-6"
      }
    >
      <Button
        variant="outline"
        className={compactControls ? "w-full" : undefined}
        onClick={resetView}
      >
        Reset
      </Button>
      <Button
        variant="outline"
        className={compactControls ? "w-full" : undefined}
        onClick={() => setZoomAndResetPan(getFocusZoom())}
      >
        <ZoomIn className="mr-2 h-4 w-4" />
        {zoomLabel}
      </Button>
      <div className={compactControls ? "col-span-2 px-1" : "flex-1"}>
        <Slider
          value={[zoom]}
          onValueChange={([newZoom]) => setZoom(newZoom)}
          min={1}
          max={getSliderMax()}
          step={0.1}
          className="w-full"
        />
      </div>
    </div>
  ) : null;

  const viewer = (fullscreen = false) => (
    <div className={fullscreen ? "fixed inset-0 z-[100] flex flex-col bg-black p-3" : "flex h-full flex-col"}>
      {fullscreen ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute right-5 top-5 z-[110]"
          onClick={() => setIsFullscreen(false)}
          aria-label="Close full screen image"
        >
          <X className="h-5 w-5" />
        </Button>
      ) : null}
      <div
        ref={containerRef}
        title={`${canZoom ? "Scroll to zoom; drag to pan; " : ""}double-click for full screen`}
        className={`relative flex min-h-0 flex-1 w-full items-center justify-center overflow-hidden select-none ${
          zoom > 1 ? isDragging ? "cursor-grabbing" : "cursor-grab" : "cursor-zoom-in"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setIsFullscreen((current) => !current)}
      >
        <div style={getImageStyle()}>
          <NextImage
            src={image.url}
            priority
            alt={`Vehicle capture for ${image.plateNumber}`}
            fill
            className="object-contain"
            draggable={false}
            unoptimized
          />
        </div>
      </div>
      {controls}
    </div>
  );

  if (isFullscreen && typeof document !== "undefined") {
    return createPortal(viewer(true), document.body);
  }
  return viewer(false);
};

export default ImageViewer;
