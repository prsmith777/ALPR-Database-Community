import { useState, useRef, useEffect } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { ZoomIn } from "lucide-react";
import NextImage from "next/image";

const ImageViewer = ({ image, compactControls = false }) => {
  const [zoom, setZoom] = useState(image?.crop_coordinates ? 3 : 1);
  const [imageSize, setImageSize] = useState(null);
  const [containerSize, setContainerSize] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    setZoom(image?.crop_coordinates ? 3 : 1);
    const img = new Image();
    img.onload = () => {
      setImageSize({ width: img.width, height: img.height });
    };
    img.src = image.url;
  }, [image.url, image.crop_coordinates]);

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
  }, []);

  const getImageStyle = () => {
    if (
      zoom === 1 ||
      !image?.crop_coordinates ||
      !imageSize ||
      !containerSize?.width ||
      !containerSize?.height
    ) {
      return {
        transform: "none",
        width: "100%",
        height: "100%",
      };
    }

    const [xMin, yMin, xMax, yMax] = image.crop_coordinates;

    // Map the source-image plate center into the object-contain rendering.
    const centerX = xMin + (xMax - xMin) / 2;
    const centerY = yMin + (yMax - yMin) / 2;
    const fitScale = Math.min(
      containerSize.width / imageSize.width,
      containerSize.height / imageSize.height
    );
    const renderedWidth = imageSize.width * fitScale;
    const renderedHeight = imageSize.height * fitScale;
    const offsetX = (containerSize.width - renderedWidth) / 2;
    const offsetY = (containerSize.height - renderedHeight) / 2;
    const renderedPlateX = offsetX + centerX * fitScale;
    const renderedPlateY = offsetY + centerY * fitScale;

    // Scale from the top-left, then translate the rendered plate center to
    // the center of the viewer. This keeps off-center plates centered at any zoom.
    const translateX = containerSize.width / 2 - renderedPlateX * zoom;
    const translateY = containerSize.height / 2 - renderedPlateY * zoom;

    return {
      transform: `translate(${translateX}px, ${translateY}px) scale(${zoom})`,
      transformOrigin: "0 0",
      width: "100%",
      height: "100%",
      transition: "transform 0.2s ease-out",
    };
  };

  return (
    <div className="flex flex-col h-full">
      <div
        ref={containerRef}
        className="relative w-full h-full overflow-hidden flex items-center justify-center"
      >
        <div style={getImageStyle()}>
          <NextImage
            src={image.url}
            priority={true}
            alt={`License plate ${image.plateNumber}`}
            fill
            className="object-contain"
            unoptimized
          />
        </div>
      </div>
      {image?.crop_coordinates && (
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
            onClick={() => setZoom(1)}
          >
            Reset
          </Button>
          {image?.crop_coordinates && (
            <Button
              variant="outline"
              className={compactControls ? "w-full" : undefined}
              onClick={() => setZoom(3)}
            >
              <ZoomIn className="mr-2 h-4 w-4" />
              Zoom to Plate
            </Button>
          )}
          <div className={compactControls ? "col-span-2 px-1" : "flex-1"}>
            <Slider
              value={[zoom]}
              onValueChange={([newZoom]) => setZoom(newZoom)}
              min={1}
              max={5}
              step={0.1}
              className="w-full"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageViewer;
