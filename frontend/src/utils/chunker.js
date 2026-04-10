const MIN_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB
const CHUNK_SIZE = MIN_CHUNK_SIZE;

function normalizeChunkSize(chunkSize = CHUNK_SIZE) {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    return CHUNK_SIZE;
  }
  return Math.min(Math.max(Math.floor(chunkSize), MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
}

/**
 * Split a File object into 5MB chunks.
 * @param {File} file
 * @returns {Array<{ partNumber: number, blob: Blob, start: number, end: number }>}
 */
export function splitFileIntoChunks(file, chunkSize = CHUNK_SIZE) {
  const effectiveChunkSize = normalizeChunkSize(chunkSize);
  const chunks = [];
  let start = 0;
  let partNumber = 1;

  while (start < file.size) {
    const end = Math.min(start + effectiveChunkSize, file.size);
    chunks.push({
      partNumber,
      blob: file.slice(start, end),
      start,
      end,
    });
    start = end;
    partNumber++;
  }

  return chunks;
}

/**
 * Calculate total number of chunks for a given file size.
 */
export function getTotalChunks(fileSize, chunkSize = CHUNK_SIZE) {
  const effectiveChunkSize = normalizeChunkSize(chunkSize);
  return Math.ceil(fileSize / effectiveChunkSize);
}

export { CHUNK_SIZE, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, normalizeChunkSize };
