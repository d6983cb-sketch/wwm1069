"use client";

import { PointerEvent, useRef, useState } from "react";
import SubmissionImage from "@/app/components/SubmissionImage";
import {
  DEFAULT_SUBMISSION_IMAGE_CROP,
  normalizeSubmissionImage,
  type SubmissionImageCrop,
  type SubmissionImageRecord,
} from "@/lib/types";

export type EditableSubmissionImage = Partial<SubmissionImageRecord> & {
  id?: number;
  storage_path: string;
  position: number;
};

export default function ImageCropEditor({
  images,
  onChange,
  disabled = false,
}: {
  images: EditableSubmissionImage[];
  onChange: (images: Array<EditableSubmissionImage & SubmissionImageCrop>) => void;
  disabled?: boolean;
}) {
  const normalized = images.map(normalizeSubmissionImage);
  const [active, setActive] = useState(0);
  const [showSafeArea, setShowSafeArea] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const dragStart = useRef<{ x: number; y: number; cropX: number; cropY: number } | null>(null);
  const image = normalized[Math.min(active, Math.max(0, normalized.length - 1))];

  const update = (changes: Partial<SubmissionImageCrop>) => {
    if (!image || disabled) return;
    onChange(normalized.map((item, index) => (
      index === active ? normalizeSubmissionImage({ ...item, ...changes }) : item
    )));
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!image || disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY, cropX: image.crop_x, cropY: image.crop_y };
  };

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current || !image || disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    update({
      crop_x: dragStart.current.cropX + ((event.clientX - dragStart.current.x) / bounds.width) * 100,
      crop_y: dragStart.current.cropY + ((event.clientY - dragStart.current.y) / bounds.height) * 100,
    });
  };

  if (!image) return null;

  return (
    <section className="crop-editor">
      <div className="crop-tabs" role="tablist" aria-label="選擇要調整的圖片">
        {normalized.map((item, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={index === active}
            className={index === active ? "on" : ""}
            onClick={() => setActive(index)}
            key={item.id ?? `${item.storage_path}-${index}`}
          >
            第 {index + 1} 張
          </button>
        ))}
      </div>
      <div
        className="crop-stage"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={() => { dragStart.current = null; }}
        onPointerCancel={() => { dragStart.current = null; }}
      >
        <SubmissionImage image={image} alt={`裁切預覽第 ${active + 1} 張`} sizes="(max-width: 760px) 92vw, 520px" />
        {showGrid && <span className="crop-grid" aria-hidden="true" />}
        {showSafeArea && <span className="crop-safe-area" aria-hidden="true"><small>主要內容安全區域</small></span>}
      </div>
      <p className="muted">拖曳圖片調整位置；框內畫面會與排行榜、作品頁、手機及電腦版一致。</p>
      <div className="crop-controls">
        <label>縮放
          <input type="range" min="1" max="3" step="0.01" value={image.zoom} disabled={disabled}
            onChange={(event) => update({ zoom: Number(event.target.value) })} />
          <output>{image.zoom.toFixed(2)}×</output>
        </label>
        <label>旋轉
          <input type="range" min="-180" max="180" step="1" value={image.rotation} disabled={disabled}
            onChange={(event) => update({ rotation: Number(event.target.value) })} />
          <output>{Math.round(image.rotation)}°</output>
        </label>
      </div>
      <div className="crop-actions">
        <button type="button" onClick={() => update(DEFAULT_SUBMISSION_IMAGE_CROP)} disabled={disabled}>重設位置</button>
        <label><input type="checkbox" checked={showSafeArea} onChange={(event) => setShowSafeArea(event.target.checked)} /> 安全區域</label>
        <label><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} /> 九宮格</label>
      </div>
    </section>
  );
}
