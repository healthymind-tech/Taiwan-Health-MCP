/**
 * Sample files for OCR testing.
 * Serves pre-loaded PDF and image samples so users can test OCR without uploading files.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate sample directories, first existing one wins:
 *   1. OCR_SAMPLES_DIR (explicit override);
 *   2. <dist|src>/../../public/samples — /app/public/samples in the app image
 *      (node-server/Dockerfile copies the repo's public/samples there);
 *   3. <repo>/public/samples — local dev (tsx src/ or node dist/ under node-server/).
 */
const SAMPLE_DIR_CANDIDATES: string[] = [
  process.env.OCR_SAMPLES_DIR?.trim() || "",
  path.resolve(HERE, "..", "..", "public", "samples"),
  path.resolve(HERE, "..", "..", "..", "public", "samples"),
].filter(Boolean);

let resolvedSamplesDir: string | null = null;
async function samplesDir(): Promise<string> {
  if (resolvedSamplesDir) return resolvedSamplesDir;
  for (const dir of SAMPLE_DIR_CANDIDATES) {
    try {
      if ((await fs.stat(dir)).isDirectory()) return (resolvedSamplesDir = dir);
    } catch {
      // try the next candidate
    }
  }
  // None exists: fall through to the first candidate (listSamples returns []).
  return SAMPLE_DIR_CANDIDATES[0];
}

export interface SampleFile {
  id: string;
  name: string;
  filename: string;
  type: "pdf" | "image";
  description: string;
  mimeType: string;
  sizeBytes?: number;
}

/**
 * List all available sample files for OCR testing.
 * Returns metadata without loading file contents.
 */
export async function listSamples(): Promise<SampleFile[]> {
  const dir = await samplesDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const samples: SampleFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filename = entry.name;
      const ext = path.extname(filename).toLowerCase();
      const stem = path.basename(filename, ext);

      // Only include supported file types
      if (![".pdf", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif"].includes(ext))
        continue;

      const filepath = path.join(dir, filename);
      const stats = await fs.stat(filepath);

      let sampleType: "pdf" | "image" = "image";
      let mimeType = "image/jpeg";

      if (ext === ".pdf") {
        sampleType = "pdf";
        mimeType = "application/pdf";
      } else if (ext === ".png") {
        mimeType = "image/png";
      } else if (ext === ".gif") {
        mimeType = "image/gif";
      } else if (ext === ".bmp") {
        mimeType = "image/bmp";
      } else if (ext === ".webp") {
        mimeType = "image/webp";
      } else if (ext === ".tiff" || ext === ".tif") {
        mimeType = "image/tiff";
      }

      samples.push({
        id: stem,
        name: stem.replace(/[-_]/g, " "),
        filename,
        type: sampleType,
        description: `Sample ${sampleType} file for OCR testing`,
        mimeType,
        sizeBytes: stats.size,
      });
    }

    return samples.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    // Samples directory doesn't exist or is empty
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Get the file data for a sample by ID.
 * Returns null if sample not found.
 */
export async function getSampleData(sampleId: string): Promise<Buffer | null> {
  // Security: prevent directory traversal
  if (sampleId.includes("..") || sampleId.includes("/") || sampleId.includes("\\")) {
    return null;
  }

  try {
    const samples = await listSamples();
    const sample = samples.find((s) => s.id === sampleId);
    if (!sample) return null;

    const filepath = path.join(await samplesDir(), sample.filename);
    return await fs.readFile(filepath);
  } catch {
    return null;
  }
}
