import axios from "axios";

const API_BASE = import.meta.env.VITE_API_UPLOAD_BASE || "/api/upload";

const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export async function startUpload(
  fileId,
  fileName,
  contentType,
  size = 0,
  checksum = "pending",
  bucketName = null,
) {
  const { data } = await api.post("/start-upload", {
    file_id: fileId,
    file_name: fileName,
    content_type: contentType || "application/octet-stream",
    size,
    checksum,
    bucket_name: bucketName || undefined,
  });
  return data;
}

export async function getPresignedUrl(fileKey, uploadId, partNumber, bucketName = null) {
  const { data } = await api.post("/presigned-url", {
    file_key: fileKey,
    upload_id: uploadId,
    part_number: partNumber,
    bucket_name: bucketName || undefined,
  });
  return data;
}

export async function updatePart(fileId, fileKey, uploadId, partNumber, etag) {
  const { data } = await api.post("/update-part", {
    file_id: fileId,
    file_key: fileKey,
    upload_id: uploadId,
    part_number: partNumber,
    etag: etag,
  });
  return data;
}

export async function resumeSession(fileId, bucketName = null) {
  try {
    const query = new URLSearchParams({ file_id: fileId });
    if (bucketName) {
      query.set("bucket_name", bucketName);
    }

    const { data } = await api.get(`/resume-session?${query.toString()}`);

    if (data && data.has_session === false) {
      return null;
    }

    return data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function completeUpload(fileId, fileKey, uploadId, fileName, size, parts, checksum, bucketName = null) {
  const { data } = await api.post("/complete-upload", {
    file_id: fileId,
    file_key: fileKey,
    upload_id: uploadId,
    file_name: fileName,
    size,
    checksum,
    bucket_name: bucketName || undefined,
    parts,
  });
  return data;
}

export async function abortUpload(fileKey, uploadId, bucketName = null) {
  const { data } = await api.post("/abort", {
    file_key: fileKey,
    upload_id: uploadId,
    bucket_name: bucketName || undefined,
  });
  return data;
}

export async function getUploadHistory(options = {}) {
  const query = new URLSearchParams();
  if (options.fromTs) query.set("from_ts", options.fromTs);
  if (options.toTs) query.set("to_ts", options.toTs);

  const queryString = query.toString();
  const endpoint = queryString ? `/uploads?${queryString}` : "/uploads";

  const { data } = await api.get(endpoint);
  return data;
}

export async function getBuckets() {
  const { data } = await api.get("/buckets");
  return data;
}

export async function addBucket(bucketPayload) {
  const { data } = await api.post("/add-bucket", bucketPayload);
  return data;
}

export async function deleteBucket(bucketId) {
  const { data } = await api.delete(`/buckets/${encodeURIComponent(bucketId)}`);
  return data;
}

export async function updateBucket(bucketId, bucketPayload) {
  const { data } = await api.patch(`/buckets/${encodeURIComponent(bucketId)}`, bucketPayload);
  return data;
}

export async function getBucketUsage(bucketName) {
  const { data } = await api.get(`/bucket-usage/${encodeURIComponent(bucketName)}`);
  return data;
}

export async function getBucketFiles({ bucketId = null, bucketName = null } = {}) {
  const params = {};
  if (bucketId) params.bucket_id = bucketId;
  if (bucketName) params.bucket_name = bucketName;

  const { data } = await api.get("/bucket-files", { params });
  return data;
}

export async function deleteUploadedFile(uploadRecordId) {
  const { data } = await api.delete(`/file/${encodeURIComponent(uploadRecordId)}`);
  return data;
}

export async function deleteFileByKey(payload) {
  const { data } = await api.post("/file/delete-by-key", payload);
  return data;
}

export async function deleteHistoryRecord(uploadRecordId) {
  const { data } = await api.delete(`/uploads/${encodeURIComponent(uploadRecordId)}`);
  return data;
}

export async function clearUploadHistory() {
  const { data } = await api.post("/uploads/clear-history");
  return data;
}

function normalizeFileDownloadResponse(data) {
  const url = data?.url;
  if (!url) {
    throw new Error("Download URL is missing in backend response");
  }

  return {
    url,
    fileKey: data?.file_key || data?.fileKey || null,
    expiresInSeconds: Number(data?.expires_in || data?.expiresIn || 0) || null,
  };
}

function getRecordFileId(record = {}) {
  return record?.fileId || record?.file_id || null;
}

function getRecordFileKey(record = {}) {
  return record?.fileKey || record?.file_key || null;
}

export async function getFileDownloadUrl(record) {
  const fileId = getRecordFileId(record);
  const fileKey = getRecordFileKey(record);
  const uploadRecordId = record?.id || null;
  const bucketId = record?.bucket_id || record?.bucketId || null;
  const bucketName = record?.bucket_name || record?.bucketName || null;
  let lastError = null;

  if (fileId) {
    try {
      const { data } = await api.get("/get-file-url", {
        params: {
          fileId,
          file_id: fileId,
          upload_record_id: uploadRecordId || undefined,
          bucket_id: bucketId || undefined,
          bucket_name: bucketName || undefined,
        },
      });
      return normalizeFileDownloadResponse(data);
    } catch (error) {
      lastError = error;
    }
  }

  if (fileKey) {
    try {
      const { data } = await api.post("/get-file-url", {
        file_key: fileKey,
        fileKey: fileKey,
        upload_record_id: uploadRecordId || undefined,
        bucket_id: bucketId || undefined,
        bucket_name: bucketName || undefined,
      });
      return normalizeFileDownloadResponse(data);
    } catch (error) {
      lastError = error;
    }
  }

  if (uploadRecordId) {
    try {
      const { data } = await api.post("/get-file-url", {
        upload_record_id: uploadRecordId,
        bucket_id: bucketId || undefined,
        bucket_name: bucketName || undefined,
      });
      return normalizeFileDownloadResponse(data);
    } catch (error) {
      lastError = error;
    }
  }

  if (!fileId && !fileKey && !uploadRecordId) {
    throw new Error("No file reference found for this record");
  }

  throw lastError || new Error("Failed to get file download URL");
}

