// Phase 8 사전 검증용 임시 API: 첫 실행·이후 실행의 타입 검사 시간을 잰다.
import fs from "node:fs";
import { bundleDir, check } from "./check";
import { samples } from "./samples";

export const dynamic = "force-dynamic";

const moduleLoadedAt = Date.now();
let invocations = 0;

export async function GET() {
  invocations++;
  const results = Object.entries(samples).map(([name, code]) => {
    const start = performance.now();
    const { diagnostics, files } = check(code);
    return { name, ms: Math.round(performance.now() - start), files: files.length, diagnostics };
  });
  return Response.json({
    invocation: invocations,
    msSinceModuleLoad: Date.now() - moduleLoadedAt,
    cwd: process.cwd(),
    bundleExists: fs.existsSync(bundleDir),
    results,
  });
}
