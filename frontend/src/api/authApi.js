import axios from "axios";

const API_BASE = import.meta.env.VITE_API_AUTH_BASE || "/api/auth";

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

export async function loginUser(username, password) {
  const { data } = await api.post("/login", { username, password });
  return data;
}

export async function registerUser(username, password) {
  const { data } = await api.post("/register", { username, password });
  return data;
}

export async function getCurrentUser() {
  const { data } = await api.get("/me");
  return data;
}
