// Phase 8 사전 검증용 임시 코드: Vercel 함수에서 TS 컴파일러로 문서 예시 코드를 타입 검사할 수 있는지 측정한다.
import path from "node:path";
import ts from "typescript";

// scripts/bundle-types.mjs가 빌드 전에 만든 폴더. 예시 코드를 이 안에 있는 파일로 취급해 node_modules를 찾게 한다.
export const bundleDir = path.join(process.cwd(), "types-bundle");

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts"],
  types: ["node"],
  typeRoots: [path.join(bundleDir, "node_modules", "@types")],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
};

// 라이브러리 .d.ts는 한 번 파싱해 두고 다음 검사에서 재사용한다.
const sourceFileCache = new Map<string, ts.SourceFile>();
const snippetPath = path.join(bundleDir, "__snippet__.ts");
let oldProgram: ts.Program | undefined;

export function check(code: string) {
  const host = ts.createCompilerHost(options);
  host.getDefaultLibLocation = () => path.join(bundleDir, "ts-lib");
  host.getDefaultLibFileName = (o) => path.join(bundleDir, "ts-lib", ts.getDefaultLibFileName(o));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === snippetPath) return ts.createSourceFile(fileName, code, languageVersion);
    let sf = sourceFileCache.get(fileName);
    if (!sf) {
      sf = getSourceFile(fileName, languageVersion);
      if (sf) sourceFileCache.set(fileName, sf);
    }
    return sf;
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName === snippetPath || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => (fileName === snippetPath ? code : readFile(fileName));

  const program = ts.createProgram({ rootNames: [snippetPath], options, host, oldProgram });
  oldProgram = program;
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ({
    code: d.code,
    file: d.file ? path.basename(d.file.fileName) : undefined,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 300),
  }));
  return { diagnostics, files: program.getSourceFiles().map((sf) => sf.fileName) };
}
