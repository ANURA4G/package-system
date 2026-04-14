import axios from "axios";
import { getAccessToken, storeAuthSession } from "../utils/storage";
import { silentRefresh } from "./authApi";

const API_BASE = import.meta.env.VITE_API_UPLOAD_BASE || "/api/upload";

const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true, // needed for HttpOnly refresh cookie
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Retry once after silent refresh on 401.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retried) {
      original._retried = true;
      try {
        const newToken = await silentRefresh();
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch {
        // Refresh failed — propagate the original 401.
      }
    }
    return Promise.reject(error);
  },
);

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

