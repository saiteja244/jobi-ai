import axios from "axios";

let resolvedApiBase = "";

function fromBuildEnv() {
  const url = import.meta.env.VITE_API_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  return "";
}

export function getApiBaseUrl() {
  if (resolvedApiBase) return resolvedApiBase;
  const fromEnv = fromBuildEnv();
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined" && window.__API_BASE__) {
    return window.__API_BASE__;
  }
  return "/api";
}

/** Load /api-config.json at startup (production fallback when VITE_API_URL is unset). */
export async function loadApiConfig() {
  const fromEnv = fromBuildEnv();
  if (fromEnv) {
    resolvedApiBase = fromEnv;
    return resolvedApiBase;
  }

  try {
    const response = await fetch("/api-config.json", { cache: "no-store" });
    if (response.ok) {
      const config = await response.json();
      const url = config?.apiUrl?.trim();
      if (url) {
        resolvedApiBase = url.replace(/\/$/, "");
        if (typeof window !== "undefined") {
          window.__API_BASE__ = resolvedApiBase;
        }
        return resolvedApiBase;
      }
    }
  } catch {
    /* use /api — works when Vercel rewrites /api to Render */
  }

  resolvedApiBase = "/api";
  return resolvedApiBase;
}

const API = axios.create({
  timeout: 120000,
});

API.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();

  if (config.data instanceof FormData) {
    if (config.headers) {
      delete config.headers["Content-Type"];
      delete config.headers["content-type"];
    }
  }
  return config;
});

API.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error.response?.data;
    const message =
      data?.error ||
      data?.message ||
      (typeof data === "string" ? data : null) ||
      error.message ||
      "Request failed";
    const err = new Error(message);
    err.status = error.response?.status;
    err.recoverable = error.response?.status === 400;
    return Promise.reject(err);
  }
);

export default API;
