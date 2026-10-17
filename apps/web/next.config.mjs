/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Phase 8 사전 검증용: 코드가 import하지 않는 .d.ts는 자동 추적되지 않으므로 함수 번들에 직접 넣는다.
    outputFileTracingIncludes: {
      "/api/verify-spike": ["./types-bundle/**/*"],
    },
  },
};

export default nextConfig;
