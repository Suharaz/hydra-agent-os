import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("hydra-demo.html", "dist/index.html");
copyFileSync("hydra-overview.html", "dist/overview.html");
if (existsSync("src/dashboard/public/index.html")) {
  copyFileSync("src/dashboard/public/index.html", "dist/classic.html");
}

console.log("Assets bundled to ./dist:", readdirSync("dist"));
