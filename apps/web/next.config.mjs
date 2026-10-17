/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 답변 코드 검증(src/lib/verify.ts)이 읽는 .d.ts는 코드가 import하지 않아 자동 추적되지 않으므로 함수 번들에 직접 넣는다
    outputFileTracingIncludes: {
      "/api/chat": ["./types-bundle/**/*"],
    },
  },
};

export default nextConfig;
