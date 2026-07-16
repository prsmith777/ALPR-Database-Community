import Image from "next/image";
import { useState } from "react";

export default function PlateImage({ plate, onClick, className }) {
  const [error, setError] = useState(false);

  const getImageUrl = () => {
    if (error || (!plate.image_path && !plate.image_data)) {
      return "/fallback.jpg";
    }

    // If we have a thumbnail path
    if (plate.thumbnail_path) {
      // Handle both old paths (that might include 'thumbnails/') and new paths
      // const filename = plate.thumbnail_path.replace(/^thumbnails\//, "");
      return `/images/${plate.thumbnail_path}`;
    }

    // If we have an image path
    if (plate.image_path) {
      return `/images/${plate.image_path}`;
    }

    // backwards compatibility for old base64
    if (plate.image_data) {
      if (plate.image_data.startsWith("data:image/jpeg;base64,")) {
        return plate.image_data;
      }
      return `data:image/jpeg;base64,${plate.image_data}`;
    }

    return "/fallback.jpg";
  };

  return (
    <Image
      src={getImageUrl()}
      alt={plate.plate_number}
      width={100}
      height={75}
      unoptimized
      priority={true}
      placeholder="blur"
      blurDataURL="/fallback.jpg"
      className={`rounded cursor-pointer ${className || ""}`}
      onClick={onClick}
      onError={(e) => {
        console.error("Image load error for plate:", plate.plate_number);
        setError(true);
      }}
    />
  );
}
