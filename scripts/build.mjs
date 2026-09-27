// Bundles the web app. Stamps the git commit so you can see which version is live.
import { build } from "esbuild";
import { execSync } from "node:child_process";

let version = "dev";
try {
  version = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout */
}

const common = { bundle: true, minify: true, target: "safari16", define: { __VERSION__: JSON.stringify(version) } };
await build({ ...common, entryPoints: ["web/src/app.js"], format: "esm", outfile: "web/public/app.js" });
await build({ ...common, entryPoints: ["web/src/sw.js"], format: "iife", outfile: "web/public/firebase-messaging-sw.js" });
console.log(`Built MomMeds version ${version}`);
