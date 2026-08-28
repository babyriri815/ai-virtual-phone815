import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["workers/float-service-worker-unified.js"],
    outfile: "public/sw.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
  }),
  build({
    entryPoints: ["workers/float-amsg-cloudflare-worker.js"],
    outfile: "public/float-amsg-cloudflare-worker.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
  }),
]);

console.log("[offline-messages] Service Worker and Cloudflare Worker bundles updated.");
