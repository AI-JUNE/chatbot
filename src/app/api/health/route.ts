// 헬스체크 — 공통 런치 P0-5. 민감정보 없음(플래그 상태만).
import { NextResponse } from 'next/server';
import { KAKAO_LIVE } from '@/lib/kakao';

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'chatbot',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
    flags: {
      kakaoLive: KAKAO_LIVE, // [승인 필요] 전까지 false
      llm: 'stub', // LLM 실키 연동은 [승인 필요]
    },
  });
}
