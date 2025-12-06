import * as path from "node:path";

/**
 * Get content type from file extension
 */
export function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".txt": "text/plain;charset=utf-8",
    ".html": "text/html;charset=utf-8",
    ".css": "text/css;charset=utf-8",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".pdf": "application/pdf",
  };
  return contentTypes[ext] || "application/octet-stream";
}

/**
 * Reverse bytes for parent ID (used in ordinals protocol)
 */
export function reverseBytes(hexString: string): string {
  return Buffer.from(hexString, "hex").reverse().toString("hex");
}

/**
 * Break content into chunks of maximum 520 bytes
 * This is necessary because Bitcoin script has a 520-byte push limit
 */
export function breakContentIntoChunks(contentHex: string): string[] {
  const MAX_CHUNK_SIZE = 520; // Maximum bytes per push in Bitcoin script
  const chunks: string[] = [];

  for (let i = 0; i < contentHex.length; i += MAX_CHUNK_SIZE * 2) {
    // *2 because hex string has 2 chars per byte
    chunks.push(contentHex.slice(i, i + MAX_CHUNK_SIZE * 2));
  }

  return chunks;
}
