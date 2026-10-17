// 답변 코드 검증(src/lib/verify.ts)에 필요한 .d.ts를 pnpm 심볼릭 링크 없이 평평한 폴더로 복사한다. dev·build 전에 실행된다.
// Vercel 함수 번들은 심볼릭 링크 구조를 그대로 옮긴다는 보장이 없으므로 실제 파일만 담는다.
import fs from "node:fs";
import path from "node:path";

const appDir = process.cwd();
const outDir = path.join(appDir, "types-bundle");
// 검사 대상 패키지. 의존성(dependencies·peerDependencies)은 따라가며 함께 복사한다
const roots = [
  "@langchain/langgraph",
  "@langchain/core",
  "langchain",
  "deepagents",
  "@langchain/openai",
  "@langchain/anthropic",
  "zod",
  "@types/node",
];
const isTypeFile = (f) => /\.d\.(ts|cts|mts)$/.test(f) || path.basename(f) === "package.json";

// Node 해석 규칙대로 fromDir에서 위로 올라가며 node_modules/<name>을 찾는다.
function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
    if (dir === path.dirname(dir)) return undefined;
  }
}

function copyTypes(src, dest) {
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    if (entry.isDirectory()) count += copyTypes(s, path.join(dest, entry.name));
    else if (isTypeFile(s)) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(s, path.join(dest, entry.name));
      count++;
    }
  }
  return count;
}

fs.rmSync(outDir, { recursive: true, force: true });
const done = new Map();
const queue = roots.map((name) => [name, appDir]);
while (queue.length) {
  const [name, fromDir] = queue.shift();
  if (done.has(name)) continue;
  const dir = findPackage(name, fromDir);
  if (!dir) continue;
  const count = copyTypes(dir, path.join(outDir, "node_modules", name));
  done.set(name, count);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) queue.push([dep, dir]);
}

// TS 기본 lib 파일
const tsLib = path.join(findPackage("typescript", appDir), "lib");
fs.mkdirSync(path.join(outDir, "ts-lib"));
for (const f of fs.readdirSync(tsLib)) {
  if (/^lib\..*\.d\.ts$/.test(f)) fs.copyFileSync(path.join(tsLib, f), path.join(outDir, "ts-lib", f));
}
console.log(`types-bundle: ${done.size} packages`);
