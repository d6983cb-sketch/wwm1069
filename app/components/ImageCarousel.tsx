"use client";

import Link from "next/link";
import { TouchEvent, useRef, useState } from "react";

export default function ImageCarousel({
  images,
  alt,
  href,
  compact = false,
}: {
  images: string[];
  alt: string;
  href?: string;
  compact?: boolean;
}) {
  const [active, setActive] = useState(0);
  const touchStart = useRef<number | null>(null);
  const safeImages = images.length ? images : [""];

  const move = (direction: number) => {
    setActive((current) => (current + direction + safeImages.length) % safeImages.length);
  };

  const finishSwipe = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStart.current === null) return;
    const distance = event.changedTouches[0].clientX - touchStart.current;
    touchStart.current = null;
    if (Math.abs(distance) < 40 || safeImages.length < 2) return;
    event.preventDefault();
    move(distance < 0 ? 1 : -1);
  };

  return (
    <div
      className={`image-carousel ${compact ? "compact" : ""}`}
      onTouchStart={(event) => { touchStart.current = event.touches[0].clientX; }}
      onTouchEnd={finishSwipe}
    >
      <div className="carousel-track" style={{ transform: `translateX(-${active * 100}%)` }}>
        {safeImages.map((image, index) => {
          const picture = <img src={image} alt={`${alt}（${index + 1} / ${safeImages.length}）`} />;
          return href
            ? <Link href={href} className="carousel-slide" key={`${image}-${index}`}>{picture}</Link>
            : <div className="carousel-slide" key={`${image}-${index}`}>{picture}</div>;
        })}
      </div>
      {safeImages.length > 1 && (
        <>
          <button type="button" className="carousel-arrow previous" aria-label="上一張照片" onClick={() => move(-1)}>‹</button>
          <button type="button" className="carousel-arrow next" aria-label="下一張照片" onClick={() => move(1)}>›</button>
          <div className="carousel-dots" aria-label={`目前是第 ${active + 1} 張，共 ${safeImages.length} 張`}>
            {safeImages.map((_, index) => (
              <button
                type="button"
                aria-label={`查看第 ${index + 1} 張照片`}
                aria-current={index === active ? "true" : undefined}
                className={index === active ? "on" : ""}
                onClick={() => setActive(index)}
                key={index}
              />
            ))}
          </div>
          <span className="carousel-count">{active + 1} / {safeImages.length}</span>
        </>
      )}
    </div>
  );
}
