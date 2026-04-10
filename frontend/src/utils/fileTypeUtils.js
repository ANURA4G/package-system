/**
 * Detect file type from the file name extension.
 * Returns one of: "dicom", "pdf", "image", "excel", "other"
 */
export function getFileType(fileName) {
  if (!fileName) return "other";

  const ext = fileName.split(".").pop().toLowerCase();

  const typeMap = {
    // Medical imaging
    dcm: "dicom",
    dicom: "dicom",

    // PDF
    pdf: "pdf",

    // Archives
    zip: "archive",

    // Images
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    bmp: "image",
    webp: "image",
    svg: "image",

    // Excel
    xlsx: "excel",
    xls: "excel",
    csv: "excel",
  };

  return typeMap[ext] || "other";
}

/**
 * Get a human-readable label for the file type.
 */
export function getFileTypeLabel(fileType) {
  const labels = {
    dicom: "DICOM Medical Image",
    pdf: "PDF Document",
    archive: "ZIP Archive",
    image: "Image",
    excel: "Spreadsheet",
    other: "File",
  };
  return labels[fileType] || "File";
}

const MAGIC_PROBE_BYTES = 132;
const ALLOWED_MAGIC_TYPES = new Set(["dicom", "jpeg", "png", "pdf", "zip"]);

function startsWithBytes(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function matchesDicomMarker(bytes) {
  if (bytes.length < MAGIC_PROBE_BYTES) return false;
  return (
    bytes[128] === 0x44 && // D
    bytes[129] === 0x49 && // I
    bytes[130] === 0x43 && // C
    bytes[131] === 0x4d // M
  );
}

export async function detectFileTypeFromMagicBytes(file) {
  if (!file) {
    return "unknown";
  }

  const headerBuffer = await file.slice(0, MAGIC_PROBE_BYTES).arrayBuffer();
  const bytes = new Uint8Array(headerBuffer);

  if (matchesDicomMarker(bytes)) {
    return "dicom";
  }

  if (startsWithBytes(bytes, [0xff, 0xd8])) {
    return "jpeg";
  }

  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "png";
  }

  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return "pdf";
  }

  if (
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "zip";
  }

  return "unknown";
}

export async function validateFileTypeByMagicBytes(file) {
  const detectedType = await detectFileTypeFromMagicBytes(file);
  const isAllowed = ALLOWED_MAGIC_TYPES.has(detectedType);

  if (isAllowed) {
    return {
      isAllowed: true,
      detectedType,
      message: null,
    };
  }

  return {
    isAllowed: false,
    detectedType,
    message: "Unsupported file type. Allowed types: DICOM, JPEG, PNG, PDF, ZIP.",
  };
}

export { MAGIC_PROBE_BYTES, ALLOWED_MAGIC_TYPES };
