import Image from "next/image";
import {
  normalizeSubmissionImage,
  type SubmissionImageRecord,
} from "@/lib/types";

export default function SubmissionImage({
  image,
  alt,
  priority = false,
  sizes = "(max-width: 760px) 100vw, 33vw",
  className = "",
}: {
  image: Partial<SubmissionImageRecord> & { storage_path: string };
  alt: string;
  priority?: boolean;
  sizes?: string;
  className?: string;
}) {
  const normalized = normalizeSubmissionImage(image);
  return (
    <span className={`submission-image ${className}`.trim()}>
      <Image
        src={normalized.storage_path}
        alt={alt}
        fill
        priority={priority}
        sizes={sizes}
        draggable={false}
        style={{
          objectPosition: `${50 + normalized.crop_x}% ${50 + normalized.crop_y}%`,
          transform: `scale(${normalized.zoom}) rotate(${normalized.rotation}deg)`,
        }}
      />
    </span>
  );
}
