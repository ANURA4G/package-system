function toHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digestSha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

async function tryNativeStreamDigest(file) {
  try {
    // Some browsers may support stream-based digest input for SubtleCrypto.
    const digest = await crypto.subtle.digest("SHA-256", file.stream());
    return new Uint8Array(digest);
  } catch {
    return null;
  }
}

export async function computeFileChecksum(file) {
  if (!file) {
    throw new Error("File is required for checksum computation");
  }

  const nativeDigest = await tryNativeStreamDigest(file);
  if (nativeDigest) {
    return toHex(nativeDigest);
  }

  // Compatibility fallback for browsers that do not support stream digest input.
  const fileBuffer = await file.arrayBuffer();
  return toHex(await digestSha256(fileBuffer));
}
