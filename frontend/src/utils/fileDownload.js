export function inferDownloadFileName(record = {}) {
  return record?.filename || record?.file_name || record?.fileKey || record?.file_key || "download";
}

export function parsePresignedExpiryFromUrl(url) {
  try {
    const parsed = new URL(url);
    const expiresSeconds = Number(parsed.searchParams.get("X-Amz-Expires") || 0);
    const signatureDateRaw = parsed.searchParams.get("X-Amz-Date") || "";

    if (!expiresSeconds || !signatureDateRaw) {
      return null;
    }

    const timestamp = Date.parse(
      `${signatureDateRaw.slice(0, 4)}-${signatureDateRaw.slice(4, 6)}-${signatureDateRaw.slice(6, 8)}T${signatureDateRaw.slice(9, 11)}:${signatureDateRaw.slice(11, 13)}:${signatureDateRaw.slice(13, 15)}Z`,
    );

    if (Number.isNaN(timestamp)) {
      return null;
    }

    return timestamp + expiresSeconds * 1000;
  } catch {
    return null;
  }
}

export function computeExpiryTimestamp(url, expiresInSeconds) {
  if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return parsePresignedExpiryFromUrl(url);
}

export function formatExpiryHint(expiresAt) {
  if (!expiresAt || !Number.isFinite(expiresAt)) {
    return "Presigned URL expires soon";
  }

  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes <= 1) return "Link expires in under 1 minute";
  return `Link expires in about ${minutes} minutes`;
}

export async function verifyPresignedUrl(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return {
      canInspectStatus: true,
      status: response.status,
      expired: response.status === 401 || response.status === 403,
    };
  } catch {
    // Cross-origin and browser restrictions can block status inspection.
    return {
      canInspectStatus: false,
      status: null,
      expired: false,
    };
  }
}

export function triggerPresignedFileAction(url, { mode = "download", fileName = "download" } = {}) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener noreferrer";

  if (mode === "open") {
    link.target = "_blank";
  } else {
    link.download = fileName;
    link.target = "_self";
  }

  document.body.appendChild(link);
  link.click();
  link.remove();
}
