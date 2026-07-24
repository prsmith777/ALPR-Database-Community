import { useState, useRef, useEffect } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { ZoomIn } from "lucide-react";
import NextImage from "next/image";

const ImageViewer = ({ image }) => {
  const [zoom, setZoom] = useState(image?.crop_coordinates ? 3 : 1);
  const [imageSize, setImageSize] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    setZoom(image?.crop_coordinates ? 3 : 1);
    const img = new Image();
    img.onload = () => {
      setImageSize({ width: img.width, height: img.height });
    };
    img.src = image.url;
  }, [image.url, image.crop_coordinates]);

  const getImageStyle = () => {
    if (zoom === 1 || !image?.crop_coordinates || !imageSize) {
      return {
        transform: "none",
        width: "100%",
        height: "100%",
      };
    }

    const [xMin, yMin, xMax, yMax] = image.crop_coordinates;

    // Calculate true center point of the plate
    const centerX = xMin + (xMax - xMin) / 2;
    const centerY = yMin + (yMax - yMin) / 2;

    // Calculate percentage positions using actual image dimensions
    const originX = (centerX / imageSize.width) * 100;
    const originY = (centerY / imageSize.height) * 100;

    return {
      transform: `scale(${zoom})`,
      transformOrigin: `${originX}% ${originY}%`,
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
        <div className="flex items-center gap-4 py-2 2xl:pt-6 2xl:px-2">
          <Button variant="outline" onClick={() => setZoom(1)}>
            Reset
          </Button>
          {image?.crop_coordinates && (
            <Button variant="outline" onClick={() => setZoom(3)}>
              <ZoomIn className="mr-2 h-4 w-4" />
              Zoom to Plate
            </Button>
          )}
          <div className="flex-1">
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
