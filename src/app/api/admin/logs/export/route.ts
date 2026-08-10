// 대화 로그 CSV 내보내기(관리 콘솔 다운로드용).
// 인메모리 로그(최근 500건)만 포함 — 영구 저장·전체 이력은 [승인 필요].
// 인증: x-admin-token 헤더 또는 ?token= 쿼리(브라우저 다운로드 링크 지원).
import { NextRequest, NextResponse } from 'next/server';
import { listAllTurns } from '@/lib/convlog';
import { requireAdmin } from '@/lib/http';

export const dynamic = 'force-dynamic';

function csvCell(v: string | boolean): string {
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req, { allowQueryToken: true });
  if (denied) return denied;

  const header = ['id', 'at', 'channel', 'sessionId', 'intent', 'source', 'escalate', 'message', 'reply'];
  const rows = listAllTurns().map((l) =>
    [l.id, l.at, l.channel, l.sessionId, l.intent, l.source, l.escalate, l.message, l.reply].map(csvCell).join(',')
  );
  // UTF-8 BOM: 엑셀에서 한글 깨짐 방지
  const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n') + '\r\n';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-logs-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
