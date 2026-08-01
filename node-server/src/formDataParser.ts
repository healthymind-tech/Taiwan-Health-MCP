/**
 * Simple multipart/form-data parser for OCR test endpoint.
 * Uses the built-in FormData parser available in Node.js.
 */

import { Request } from "express";

export interface FormDataFields {
  file?: Buffer;
  filename?: string;
  [key: string]: Buffer | string | undefined;
}

/**
 * Parse multipart/form-data from request.
 * Returns a simple object with file buffer and string fields.
 */
export async function parseFormData(req: Request): Promise<FormDataFields> {
  const contentType = req.headers["content-type"] ?? "";

  if (!contentType.includes("multipart/form-data")) {
    throw new Error("Content-Type must be multipart/form-data");
  }

  // Extract boundary from content-type header
  const boundaryMatch = contentType.match(/boundary=([^;]+)/);
  if (!boundaryMatch) {
    throw new Error("Invalid multipart/form-data: missing boundary");
  }

  const boundary = boundaryMatch[1].replace(/"/g, "");
  const chunks: Buffer[] = [];

  // Collect all data
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve());
    req.on("error", reject);
  });

  const buffer = Buffer.concat(chunks);
  const data = buffer.toString("latin1");

  const fields: FormDataFields = {};
  const parts = data.split(`--${boundary}`);

  for (const part of parts) {
    if (!part.includes("Content-Disposition")) continue;

    // Parse headers
    const headerEndIndex = part.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) continue;

    const headerSection = part.substring(0, headerEndIndex);
    const body = part.substring(headerEndIndex + 4);

    // Extract field name
    const nameMatch = headerSection.match(/name="([^"]+)"/);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];

    // Extract filename (for file uploads)
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      // This is a file field
      const fileContent = body.slice(0, -2); // Remove trailing \r\n
      fields[fieldName] = Buffer.from(fileContent, "latin1");
      if (fieldName === "file") {
        fields.file = fields[fieldName];
      }
    } else {
      // This is a text field
      const fieldValue = body.slice(0, -2); // Remove trailing \r\n
      fields[fieldName] = fieldValue;
    }
  }

  return fields;
}
