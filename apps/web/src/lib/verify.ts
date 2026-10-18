// 답변의 TypeScript 코드 블록을 실제 패키지 타입 정의로 타입 검사한다 (Phase 8).
// 타입 정의는 scripts/bundle-types.mjs가 dev·build 전에 types-bundle/에 모아 둔다
import path from "node:path";
import ts from "typescript";
// 문서 페이지 URL → 그 페이지 예시 코드의 판정 에러 키. scripts/verify-docs.ts --write가 만든다
import sourceErrors from "./source-errors.json";

// 판정 대상 에러: LangChain 패키지 API를 잘못 쓴 경우만. 발췌 코드에서 흔한 선언 없는 변수(TS2304) 등은 제외한다
export const JUDGED_CODES = new Set([
  2305, // 모듈에 export가 없음
  2724, // export가 없음 (비슷한 이름 제안)
  2614, // default export 없음
  2339, // 속성 없음
  2551, // 속성 없음 (비슷한 이름 제안)
  2353, // 객체 리터럴에 알 수 없는 속성
  2345, // 인자 타입 불일치
  2554, // 인자 개수 불일치
  2769, // 맞는 오버로드 없음
  2322, // 타입 불일치
]);

// 이 패키지들에 선언된 API에서 난 에러만 판정한다 (zod·Node 등은 제외)
const API_PACKAGE = /[\\/]node_modules[\\/](@langchain[\\/][^\\/]+|langchain|deepagents)[\\/]/;

// cwd는 Next 함수에서 apps/web. 스크립트는 import 전에 chdir한다
const bundleDir = path.join(process.cwd(), "types-bundle");
const snippetPath = path.join(bundleDir, "__snippet__.ts");

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

export type CodeError = { code: number; api: string; line: number; message: string };
export type VerifiedError = CodeError & { block: number; inSource: boolean };
// blocks: 답변의 TS 코드 블록 수, errors: 판정된 에러 (block은 몇 번째 코드 블록인지, 0부터)
export type VerifyResult = { blocks: number; errors: VerifiedError[] };

// 라이브러리 .d.ts는 한 번 파싱해 두고 다음 검사에서 재사용한다 (첫 검사 약 2초, 이후 0.1~0.5초).
// 모듈 해석 때 반복되는 파일·폴더 존재 확인도 캐시한다 (실행 중 types-bundle은 바뀌지 않음)
const sourceFileCache = new Map<string, ts.SourceFile>();
const existsCache = new Map<string, boolean>();
const cached = (key: string, check: () => boolean) => {
  if (!existsCache.has(key)) existsCache.set(key, check());
  return existsCache.get(key)!;
};
let oldProgram: ts.Program | undefined;

function createProgram(code: string) {
  const host = ts.createCompilerHost(options);
  host.getDefaultLibLocation = () => path.join(bundleDir, "ts-lib");
  host.getDefaultLibFileName = (o) => path.join(bundleDir, "ts-lib", ts.getDefaultLibFileName(o));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === snippetPath) return ts.createSourceFile(fileName, code, languageVersion, true);
    let sf = sourceFileCache.get(fileName);
    if (!sf) {
      sf = getSourceFile(fileName, languageVersion);
      if (sf) sourceFileCache.set(fileName, sf);
    }
    return sf;
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName === snippetPath || cached(`f:${fileName}`, () => fileExists(fileName));
  const directoryExists = host.directoryExists!.bind(host);
  host.directoryExists = (dir) => cached(`d:${dir}`, () => directoryExists(dir));
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => (fileName === snippetPath ? code : readFile(fileName));

  const program = ts.createProgram({ rootNames: [snippetPath], options, host, oldProgram });
  oldProgram = program;
  return program;
}

// 마크다운의 ```ts / ```typescript 코드 블록. 문서에는 탭 안에서 들여쓴 블록도 있다
const CODE_BLOCK = /^([ \t]*)(`{3,})(?:ts|typescript)\b[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm;

export function extractCodeBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(CODE_BLOCK)).map(([, indent, , body]) =>
    indent ? body.replace(new RegExp(`^${indent}`, "gm"), "") : body,
  );
}

function declaredInApiPackage(symbol: ts.Symbol | undefined, checker: ts.TypeChecker) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return !!symbol?.declarations?.some((d) => API_PACKAGE.test(d.getSourceFile().fileName));
}

function nameOf(node: ts.Expression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return node.getText();
}

// 에러 위치에서 어떤 패키지 API의 에러인지 찾는다. 사용자 코드(콜백 본문 등)의 에러면 undefined
function apiOf(node: ts.Node, code: number, checker: ts.TypeChecker): string | undefined {
  if (code === 2305 || code === 2724 || code === 2614) {
    const decl = ts.findAncestor(node, ts.isImportDeclaration);
    const specifier = decl && (decl.moduleSpecifier as ts.StringLiteral).text;
    return specifier && API_PACKAGE.test(`/node_modules/${specifier}/`) ? node.getText() : undefined;
  }
  if ((code === 2339 || code === 2551) && ts.isPropertyAccessExpression(node.parent)) {
    const type = checker.getTypeAtLocation(node.parent.expression);
    return declaredInApiPackage(type.getSymbol() ?? type.aliasSymbol, checker) ? node.getText() : undefined;
  }
  // 인자·객체 리터럴 에러는 감싸는 호출의 대상 함수로 판단한다. 함수 경계를 넘으면 사용자 코드로 본다
  for (let n: ts.Node | undefined = node; n && !ts.isFunctionLike(n); n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression;
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      return declaredInApiPackage(symbol, checker) ? nameOf(callee) : undefined;
    }
  }
  return undefined;
}

// 위치를 감싸는 가장 안쪽 노드
function findNode(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined =>
    node.getStart(sf) <= pos && pos < node.getEnd() ? (ts.forEachChild(node, visit) ?? node) : undefined;
  return visit(sf);
}

// ignored는 판정에서 뺀 에러의 코드 (평가 스크립트가 무엇이 빠졌는지 집계하는 데 쓴다)
export function checkCode(code: string): { errors: CodeError[]; ignored: number[] } {
  const program = createProgram(code);
  const checker = program.getTypeChecker();
  const snippet = program.getSourceFile(snippetPath)!;
  const errors: CodeError[] = [];
  const ignored: number[] = [];
  for (const d of ts.getPreEmitDiagnostics(program, snippet)) {
    const node = JUDGED_CODES.has(d.code) && d.start !== undefined ? findNode(snippet, d.start) : undefined;
    const api = node && apiOf(node, d.code, checker);
    if (!api) {
      ignored.push(d.code);
      continue;
    }
    errors.push({
      code: d.code,
      api,
      line: snippet.getLineAndCharacterOfPosition(d.start!).line + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    });
  }
  return { errors, ignored };
}

// 답변 에러와 문서 에러를 비교하는 키 (에러 코드 + API 이름)
export const errorKey = (e: CodeError) => `${e.code}:${e.api}`;

// 답변 코드를 검사하고, 에러가 있으면 출처 문서 페이지의 예시 코드에도 같은 에러가 있는지 표시한다.
// 출처 청크가 아니라 페이지 전체로 비교한다 (청크는 코드 블록이 경계에서 잘려 있어 추출되지 않는 경우가 많음)
export function verifyAnswer(answer: string, sourceUrls: string[]): VerifyResult {
  const blocks = extractCodeBlocks(answer);
  const errors = blocks.flatMap((code, block) => checkCode(code).errors.map((e) => ({ ...e, block })));
  const pages = sourceErrors as Record<string, string[]>;
  const sourceKeys = new Set(sourceUrls.flatMap((url) => pages[url] ?? []));
  return { blocks: blocks.length, errors: errors.map((e) => ({ ...e, inSource: sourceKeys.has(errorKey(e)) })) };
}
