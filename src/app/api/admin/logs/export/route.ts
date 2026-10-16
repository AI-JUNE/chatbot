// 대화 로그 CSV 내보내기(관리 콘솔 다운로드용).
// 인메모리 로그(최근 500건)만 포함 — 영구 저장·전체 이력은 [승인 필요].
// 인증: x-admin-token 헤더 또는 ?token= 쿼리(브라우저 다운로드 링크 지원).
//
// 표를 만드는 일은 `@/lib/convlog` 의 `turnsToCsv` 가 한다 (DS 40-1·40-2) — 라우트는 HTTP
// 메서드·설정 외 export 가 금지되어 **돌려 볼 수 없는 자리**이고, 종전에는 그래서 열 이름만
// 소스 텍스트로 대조하고 값은 아무도 보지 않았다(시각이 UTC 로 나가던 것을 테스트가 못 잡았다).
import { NextRequest, NextResponse } from 'next/server';
import { turnCount, turnsToCsv } from '@/lib/convlog';
import { intentLabelMap } from '@/lib/intents';
import { listCustomRules } from '@/lib/adminStore';
import { logAudit } from '@/lib/audit';
import { requireAdmin, isAdminAuthed } from '@/lib/http';
import { kstStamp } from '@/lib/kst';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

  // 주제 이름은 어휘를 아는 쪽이 붙인다 — 운영자가 만든 규칙(`cr_*`)의 이름은 런타임에만 안다.
  const csv = turnsToCsv(intentLabelMap(listCustomRules()));
  // 파일 이름의 날짜는 받는 사람(한국의 운영자)이 읽는 날짜다 — 서버 시간대가 아니라 KST.
  const date = kstStamp();

  /**
   * 꺼내 간 사실을 남긴다 (DS 40-3).
   *
   * 이 파일에는 상담 내용 보존분 전체가 들어 있다(개인정보를 가린 글이지만 고객이 친 말이다).
   * 종전에는 **정산 리포트 내려받기만** 감사 로그에 남았다 — 금액 표는 흔적이 남고 상담 내용은
   * 남지 않았다. 두 창구가 같은 이유로 쿼리 토큰까지 열어 두고 있었는데(브라우저 다운로드),
   * 흔적이 더 필요한 쪽이 비어 있었다. 연락처·대화 본문은 싣지 않는다 — 건수만 남긴다(§10.3).
   */
  logAudit({
    action: 'conversation.export',
    detail: `대화 ${turnCount()}건(보관분 전체)`,
    authed: isAdminAuthed(req, true),
  });

  return new NextResponse('﻿' + csv + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-logs-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
