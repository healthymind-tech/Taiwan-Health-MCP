import sharp from "sharp";

export interface DrugWebImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Render the browser-facing derivative while leaving source bytes untouched. */
export async function renderDrugWebImage(source: Buffer): Promise<DrugWebImage> {
  const rendered = await sharp(source)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 86, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}
