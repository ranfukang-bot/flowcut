"use client";

import { useEffect, useRef, useState } from "react";

// Keep IDs as strings: TikTok IDs commonly exceed Number.MAX_SAFE_INTEGER.
// Windows/browser duplicate downloads may append " (2)" before the extension.
export function productIdFromImageName(name: string): string {
  return name.trim().match(/^(\d+)(?:\s*\(\d+\))?\.(?:jpe?g|png|webp|gif|avif|bmp|heic|heif|tiff?)$/i)?.[1] || "";
}

export function useImageProductId(files: ReadonlyArray<{ name: string }>) {
  const [productId, setProductId] = useState("");
  const firstImageSeen = useRef(false);
  const automaticId = useRef("");

  useEffect(() => {
    if (!files.length) {
      if (firstImageSeen.current) {
        firstImageSeen.current = false;
        // Clear our own value when starting a new group, never a manual edit.
        const previousAutomaticId = automaticId.current;
        automaticId.current = "";
        if (previousAutomaticId) {
          setProductId((current) => current === previousAutomaticId ? "" : current);
        }
      }
      return;
    }
    if (firstImageSeen.current) return;
    // Even an unrecognizable first image consumes this group's one attempt.
    firstImageSeen.current = true;
    const inferred = productIdFromImageName(files[0].name);
    if (!productId.trim() && inferred) {
      automaticId.current = inferred;
      setProductId(inferred);
    }
  }, [files, productId]);

  function editProductId(value: string) {
    automaticId.current = "";
    setProductId(value);
  }

  return [productId, editProductId] as const;
}
