import preact from "@preact/preset-vite";
import { execSync } from "child_process";
import { defineConfig, Plugin } from "vite";

/** Identifies the build. The server reports it to screens, which reload when it changes. */
function buildVersion(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 12);
  try {
    return `${execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()}-${Date.now().toString(36)}`;
  } catch {
    return Date.now().toString(36);
  }
}

const version = process.env.NODE_ENV === "production" || process.argv.includes("build") ? buildVersion() : "dev";

/** Writes version.txt beside index.html for the server to read. */
function versionFile(): Plugin {
  return {
    name: "notice-brd-version",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.txt", source: version });
    },
  };
}

export default defineConfig({
  root: "web",
  publicDir: "public",
  plugins: [preact(), versionFile()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // Old tablets and smart TVs make good screens; keep their browsers in.
    target: ["es2017", "safari12", "chrome64", "firefox68", "edge79"],
    cssTarget: ["safari12", "chrome64", "firefox68", "edge79"],
  },
  server: {
    // Same origin in production (one server serves both), so the dev server proxies /api.
    // Host is kept as-is: the API refuses writes whose Origin doesn't match it.
    proxy: {
      "/api": { target: process.env.NOTICEBRD_API ?? "http://localhost:3000", changeOrigin: false },
    },
  },
});
