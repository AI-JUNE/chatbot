// 대화 로그 CSV 내보내기(관리 콘솔 다운로드용).
// 인메모리 로그(최근 500건)만 포함 — 영구 저장·전체 이력은 [승인 필요].
// 인증: x-admin-token 헤더 또는 ?token= 쿼리(브라우저 다운로드 링크 지원).
import { NextRequest, NextResponse } from 'next/server';
import { listAllTurns } from '@/lib/convlog';
import { CHANNEL_LABELS, SOURCE_LABELS, intentLabel, intentLabelMap } from '@/lib/intents';
import { listCustomRules } from '@/lib/adminStore';
import { requireAdmin } from '@/lib/http';
import { csvRow } from '@/lib/csv';
import { kstStamp } from '@/lib/kst';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

  // 열 이름과 값은 받는 사람(한국의 운영자)이 읽는 말로 적는다 — 「주제」·「근거」는 엔진 코드
  // (`kb:환불`·`fallback`)가 아니라 화면과 **같은 이름**으로, 코드는 따로 한 열에 남긴다
  // (다른 시스템으로 옮겨 담을 때 쓰는 값이다).
  const labels = intentLabelMap(listCustomRules());
  const header = ['번호', '시각', '채널', '대화', '주제', '근거', '상담원 제안', '고객 메시지', '챗봇 답변', '주제코드'];
  const rows = listAllTurns().map((l) =>
    csvRow([
      l.id,
      l.at,
      CHANNEL_LABELS[l.channel] ?? l.channel,
      l.sessionId,
      intentLabel(l.intent, labels),
      SOURCE_LABELS[l.source] ?? l.source,
      l.escalate ? '예' : '아니오',
      l.message,
      l.reply,
      l.intent,
    ])
  );
  // UTF-8 BOM: 엑셀에서 한글 깨짐 방지
  const csv = '\uFEFF' + [csvRow(header), ...rows].join('\r\n') + '\r\n';
  // 파일 이름의 날짜는 받는 사람(한국의 운영자)이 읽는 날짜다 — 서버 시간대가 아니라 KST.
  const date = kstStamp();

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-logs-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
