import ChatWidget from '@/components/ChatWidget';

/**
 * 랜딩 — AICC Portal 과 같은 디자인 시스템(globals.css 토큰)만 쓴다.
 *
 * 벤치마킹(9/10): 채널톡 알프·Intercom Fin 의 상용 랜딩 구조를 참고했다.
 * - 히어로에서 **바로 체험**시킨다(설명보다 먼저 써 보게 한다)
 * - "무엇을 근거로 답하는가"를 전면에 둔다(근거 표시·모르면 단정하지 않음·상담원 전환)
 * - 채널·도입 절차·운영 콘솔·FAQ 순으로 의사결정에 필요한 정보를 채운다
 *
 * 원칙(§13)
 * - 근거 없는 성과 수치·타사 로고·고객사 후기를 쓰지 않는다. 측정값이 없으면 「측정 중」이라고 쓴다.
 * - 설치 스니펫·관리 콘솔 같은 **운영자용 정보는 랜딩에 노출하지 않는다**(관리 콘솔 「설치」 탭에 있다).
 */
export const metadata = { title: 'GOWON Chat — 등록한 자료를 근거로 답하는 AI 상담' };

const NAV = [
  ['#trust', '동작 방식'],
  ['#features', '기능'],
  ['#channels', '채널'],
  ['#steps', '도입'],
  ['#faq', '자주 묻는 질문'],
] as const;

/** 화면 아이콘 — 16px 뷰박스 선 아이콘. 이모지를 쓰지 않는다(제품 화면과 결을 맞춘다). */
const ICONS = {
  cite: 'M9.5 2.5H5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 5 13.5h6a1.5 1.5 0 0 0 1.5-1.5V5.5zM9.5 2.5v3h3M6 8.5h4M6 10.8h2.6',
  guard: 'M8 2.2 3.5 3.8v3.4c0 2.7 1.8 4.6 4.5 5.4 2.7-.8 4.5-2.7 4.5-5.4V3.8zM6 7.9l1.4 1.4 2.6-2.8',
  handoff: 'M2 11h5.5M7.5 11 5.8 9.3M7.5 11l-1.7 1.7M11.4 6.6a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8M8.6 13c0-1.8 1.3-2.8 2.8-2.8s2.8 1 2.8 2.8',
  library: 'M2.5 4h4.2c.5 0 .9.2 1.3.5.4-.3.8-.5 1.3-.5h4.2v8H9.3c-.5 0-.9.2-1.3.5-.4-.3-.8-.5-1.3-.5H2.5zM8 4.5v8',
  checklist: 'M2.5 5h1.8l1 1 2-2.2M9.5 5h4M2.5 11h1.8l1 1 2-2.2M9.5 11h4',
  form: 'M6 2.5h4v1.6H6zM4.5 3.3H3.4v10.2h9.2V3.3h-1.1M5.8 7.5h4.4M5.8 10.3h3',
  swap: 'M2.5 6h9.2L9.4 3.7M13.5 10H4.3l2.3 2.3',
  rating: 'M5.5 13.8V7.2l2.9-4.7a1.6 1.6 0 0 1 1.5 1.6v2.2h3a1.2 1.2 0 0 1 1.2 1.5l-.9 4.2a1.3 1.3 0 0 1-1.3 1.1zM5.5 7.4H2.8v6.4h2.7',
  lock: 'M4.8 7.2V5.4a3.2 3.2 0 0 1 6.4 0v1.8M3.5 7.2h9v6.3h-9z',
  chat: 'M2.5 3.5h11v7.2H7.6l-3.3 2.7v-2.7H2.5z',
  kakao: 'M8 2.8c-3.1 0-5.6 2-5.6 4.4 0 1.6 1.1 3 2.7 3.8l-.7 2.4 2.7-1.5c.3 0 .6.1.9.1 3.1 0 5.6-2 5.6-4.8S11.1 2.8 8 2.8z',
  call: 'M5.2 2.8 7 5.1 5.6 6.5a7.5 7.5 0 0 0 3.9 3.9L11 9l2.2 1.8v1.7a1.3 1.3 0 0 1-1.4 1.3C7.2 13.4 2.6 8.8 2.2 4.2A1.3 1.3 0 0 1 3.5 2.8z',
  spark: 'M8 2.4l1.2 3.1 3.1 1.2-3.1 1.2L8 11l-1.2-3.1L3.7 6.7l3.1-1.2zM12.6 10.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z',
  arrow: 'M4.5 4.5 11.5 11.5M11.5 6.6v4.9H6.6',
} as const;

type IconKey = keyof typeof ICONS;

function Icon({ name, size = 16 }: { name: IconKey; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d={ICONS[name]} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 브랜드 마크 — 말풍선 + 이니셜. 원본은 `src/app/icon.svg`(파비콘)이며 경로 데이터를 같이 쓴다. */
const MARK_BODY = 'M7 2.5h18A5.5 5.5 0 0 1 30.5 8v11a5.5 5.5 0 0 1-5.5 5.5H13l-5 5v-5H7A5.5 5.5 0 0 1 1.5 19V8A5.5 5.5 0 0 1 7 2.5Z';
const MARK_G = 'M20.9 9.9A6 6 0 1 0 22 13.5h-5.2';

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
      <path d={MARK_BODY} fill="var(--brand)" />
      <path d={MARK_G} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TRUST = [
  {
    icon: 'cite' as IconKey,
    title: '답변마다 근거를 붙입니다',
    body: '등록한 안내 자료의 어느 항목에서 나온 답인지 문장 그대로 함께 보여줍니다. 고객은 답을 믿을지 스스로 판단할 수 있습니다.',
  },
  {
    icon: 'guard' as IconKey,
    title: '모르면 지어내지 않습니다',
    body: '등록된 자료에 없는 질문에는 추측 대신 “확인이 필요합니다”라고 답하고 담당자 연결로 넘깁니다.',
  },
  {
    icon: 'handoff' as IconKey,
    title: '필요할 때 사람에게 넘깁니다',
    body: '전환 요청·불만·긴급 문의는 지금까지의 대화 요약과 함께 상담원에게 접수됩니다. 고객이 같은 말을 두 번 하지 않습니다.',
  },
] as const;

const FEATURES = [
  { icon: 'library' as IconKey, title: '자료 등록만으로 시작', body: '쓰던 FAQ·안내문을 그대로 올리면 바로 답합니다. 시나리오를 하나하나 그릴 필요가 없습니다.' },
  { icon: 'checklist' as IconKey, title: '정해진 안내는 항상 같게', body: '영업시간·환불처럼 답이 정해진 문의는 규칙으로 고정해 매번 같은 문장으로 답합니다.' },
  { icon: 'form' as IconKey, title: '접수도 대화로', body: '예약·장애 신고처럼 받을 항목이 많은 문의는 몇 단계인지 보여주며 차례로 물어봅니다.' },
  { icon: 'swap' as IconKey, title: '전환하면 순번까지', body: '상담원으로 넘길 때 접수번호와 접수 순번을 알려 줍니다. 없는 예상 대기시간은 만들지 않습니다.' },
  { icon: 'rating' as IconKey, title: '평가가 곧 보완 목록', body: '고객이 남긴 「도움됐어요 / 아쉬워요」가 어떤 자료를 손봐야 하는지 알려 줍니다.' },
  { icon: 'lock' as IconKey, title: '연락처는 흘리지 않습니다', body: '연락처와 대화 내용은 로그·오류 리포트에서 가려집니다. 관리 기능은 권한을 확인합니다.' },
] as const;

const CHANNELS = [
  { icon: 'chat' as IconKey, title: '웹 채팅', body: '홈페이지 오른쪽 아래에 뜨는 상담창. 모바일에서는 전체화면으로 열립니다.', state: '운영 중' },
  { icon: 'kakao' as IconKey, title: '카카오톡 채널', body: '같은 지식·같은 규칙으로 카카오톡 문의에 응답합니다.', state: '연동 준비 — 채널 승인 후 활성화' },
  { icon: 'call' as IconKey, title: '콜봇 연계', body: 'AICC 콜봇과 같은 지식·같은 상담원 전환 규칙을 공유합니다.', state: '연계 설계 완료' },
] as const;

const STEPS = [
  { n: '1', title: '안내 자료 등록', body: '기존 FAQ·안내문을 관리 콘솔에 붙여 넣습니다. 항목마다 근거 라벨이 자동으로 붙습니다.' },
  { n: '2', title: '규칙·전환 기준 확인', body: '고정 안내와 상담원 전환 조건을 확인합니다. 응답 테스트에서 실제 답을 미리 봅니다.' },
  { n: '3', title: '설치 후 오픈', body: '관리 콘솔에서 발급되는 설치 코드를 사이트에 넣으면 끝입니다. 개발 작업은 필요하지 않습니다.' },
] as const;

const CONSOLE_KPI = [
  ['오늘 대화', '측정 중'],
  ['자동 완결', '측정 중'],
  ['상담원 전환', '측정 중'],
  ['평균 응답', '측정 중'],
] as const;

const FAQ = [
  {
    q: '학습(파인튜닝)이 필요한가요?',
    a: '필요하지 않습니다. 등록한 안내 자료에서 답을 찾아 근거와 함께 보여주는 방식이라, 자료를 고치면 답도 즉시 바뀝니다.',
  },
  {
    q: '엉뚱한 답을 하면 어떻게 하나요?',
    a: '답변마다 근거가 표시되므로 어떤 자료에서 나온 답인지 바로 확인할 수 있습니다. 고객이 남긴 「아쉬워요」 평가는 관리 콘솔에서 어떤 자료를 고쳐야 하는지 알려 줍니다.',
  },
  {
    q: '상담원 연결은 어떻게 되나요?',
    a: '고객이 요청하거나 불만·긴급으로 판단되면 접수번호를 발급하고 대화 요약을 함께 넘깁니다. 실제 상담원 알림 연동은 고객사 환경에 맞춰 연결합니다.',
  },
  {
    q: '개인정보는 어떻게 다루나요?',
    a: '연락처는 접수에 필요한 경우에만 받고, 로그·오류 리포트에서는 가려집니다. 대화 본문의 영구 저장은 고객사 승인 후에만 켭니다.',
  },
  {
    q: '카카오톡에서도 같은 답을 하나요?',
    a: '같은 지식과 같은 규칙을 씁니다. 채널이 달라도 답과 전환 기준이 달라지지 않습니다.',
  },
  {
    q: '효과는 얼마나 되나요?',
    a: '도입 전 실측 없이 수치를 말씀드리지 않습니다. 운영 콘솔이 자동 완결·전환 비율을 실제로 집계하므로, 파일럿 기간의 자기 데이터로 판단하시는 편을 권합니다.',
  },
] as const;

const card = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
} as const;

const sectionLabel = { fontSize: 12.5, fontWeight: 800, letterSpacing: '.06em', color: 'var(--brand-600)', textTransform: 'uppercase' } as const;
const h2 = { fontSize: 'clamp(23px,3.4vw,32px)', fontWeight: 800, letterSpacing: '-.025em', lineHeight: 1.3, margin: '10px 0 10px' } as const;
const lead = { fontSize: 15.5, color: 'var(--sub)', lineHeight: 1.7, margin: 0 } as const;
const wrap = { maxWidth: 1080, margin: '0 auto', padding: '0 22px' } as const;

export default function Home() {
  return (
    <main style={{ minHeight: '100vh' }}>
      {/* ── 상단바 ── */}
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: 'rgba(255,255,255,.86)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ ...wrap, height: 62, display: 'flex', alignItems: 'center', gap: 18 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontWeight: 800, fontSize: 16, letterSpacing: '-.02em' }}>
            <BrandMark size={28} />
            GOWON Chat
          </span>
          <nav aria-label="주요 섹션" className="lp-nav">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--sub)' }}>{label}</a>
            ))}
          </nav>
          <a href="#contact" style={{ marginLeft: 'auto', fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'var(--brand)', borderRadius: 10, padding: '9px 16px' }}>
            도입 문의
          </a>
        </div>
      </header>

      {/* ── 히어로 ── */}
      <section style={{ background: 'linear-gradient(180deg,var(--brand-50) 0%,var(--bg) 62%)', padding: '64px 0 56px' }}>
        <div className="lp-hero" style={wrap}>
          <div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 999, padding: '7px 14px' }}>
              <Icon name="spark" size={14} /> 인공지능(AI)이 응대합니다
            </span>
            <h1 style={{ fontSize: 'clamp(32px,5vw,54px)', fontWeight: 800, letterSpacing: '-.035em', lineHeight: 1.14, margin: '18px 0 16px' }}>
              등록한 자료를 <span style={{ color: 'var(--brand)' }}>근거로</span> 답하는<br />상담 챗봇
            </h1>
            <p style={{ ...lead, fontSize: 17, maxWidth: 520 }}>
              FAQ와 안내문을 등록하면 AI가 1차 응대하고, 답변마다 어느 자료에서 나왔는지 함께 보여줍니다.
              확인이 필요한 문의는 대화 요약과 함께 상담원에게 넘깁니다.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 26 }}>
              <a href="#demo" style={{ fontSize: 14.5, fontWeight: 700, color: '#fff', background: 'var(--brand)', borderRadius: 12, padding: '13px 22px' }}>
                상담창 열어보기
              </a>
              <a href="#contact" style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--line-2)', borderRadius: 12, padding: '13px 22px' }}>
                도입 상담 요청
              </a>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 14 }}>
              코드 한 줄만 넣으면 됩니다. 개발 작업은 필요하지 않습니다.
            </p>
          </div>

          {/* 대화 예시 — 실제 위젯 화면과 같은 구성(값은 예시 문구) */}
          <div style={{ ...card, borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-pop)' }} aria-label="상담 화면 예시">
            <div style={{ background: 'var(--brand)', color: '#fff', padding: '13px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14 }}>G</span>
              <div style={{ lineHeight: 1.25 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>GOWON Chat</div>
                <div style={{ fontSize: 10.5, opacity: .9 }}>AI가 응대합니다</div>
              </div>
            </div>
            <div style={{ background: 'var(--bg)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ alignSelf: 'flex-end', background: 'var(--brand)', color: '#fff', borderRadius: 14, borderBottomRightRadius: 4, padding: '9px 12px', fontSize: 13, maxWidth: '82%' }}>
                환불은 며칠까지 가능한가요?
              </div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, borderBottomLeftRadius: 4, padding: '9px 12px', fontSize: 13, lineHeight: 1.6, maxWidth: '90%' }}>
                수령일로부터 7일 이내에 신청하실 수 있어요. 사용 흔적이 있으면 접수가 제한될 수 있습니다.
              </div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderLeft: '3px solid var(--brand)', borderRadius: 10, padding: '8px 10px', fontSize: 11.5, color: 'var(--sub)', maxWidth: '90%' }}>
                <div style={{ fontWeight: 700, color: 'var(--brand-600)', fontSize: 11 }}>근거 · 안내문 4. 환불 규정</div>
                <div style={{ marginTop: 3 }}>“수령일로부터 7일 이내 신청 가능”</div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--mut)', textAlign: 'center', paddingTop: 2 }}>화면 예시입니다 — 실제 답변은 등록한 자료에 따라 달라집니다.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 동작 방식(신뢰) ── */}
      <section id="trust" style={{ ...wrap, padding: '72px 22px 8px' }}>
        <span style={sectionLabel}>동작 방식</span>
        <h2 style={h2}>믿을 수 있는 답만 내보냅니다</h2>
        <p style={{ ...lead, maxWidth: 620 }}>
          생성형 답변의 가장 큰 위험은 그럴듯한 오답입니다. 이 챗봇은 답을 만들기 전에 등록된 자료를 먼저 찾고, 찾지 못하면 답하지 않습니다.
        </p>
        <div className="lp-grid" style={{ marginTop: 30 }}>
          {TRUST.map((t) => (
            <div key={t.title} style={{ ...card, padding: '22px 20px' }}>
              <span style={{ display: 'inline-flex', width: 36, height: 36, borderRadius: 11, background: 'var(--brand-50)', color: 'var(--brand-600)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={t.icon} size={18} />
              </span>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '12px 0 8px', letterSpacing: '-.015em' }}>{t.title}</h3>
              <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.7, margin: 0 }}>{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 기능 ── */}
      <section id="features" style={{ ...wrap, padding: '64px 22px 8px' }}>
        <span style={sectionLabel}>기능</span>
        <h2 style={h2}>상담 운영에서 실제로 쓰는 것만</h2>
        <div className="lp-grid" style={{ marginTop: 26 }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ ...card, padding: '20px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--brand-50)', color: 'var(--brand-600)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={f.icon} size={17} />
                </span>
                <h3 style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.015em' }}>{f.title}</h3>
              </div>
              <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.7, margin: '11px 0 0' }}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 채널 ── */}
      <section id="channels" style={{ ...wrap, padding: '64px 22px 8px' }}>
        <span style={sectionLabel}>채널</span>
        <h2 style={h2}>고객이 있는 곳에서 같은 답을</h2>
        <div className="lp-grid" style={{ marginTop: 26 }}>
          {CHANNELS.map((c) => (
            <div key={c.title} style={{ ...card, padding: '22px 20px' }}>
              <span style={{ display: 'inline-flex', width: 36, height: 36, borderRadius: 11, background: 'var(--brand-50)', color: 'var(--brand-600)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={c.icon} size={18} />
              </span>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '12px 0 8px' }}>{c.title}</h3>
              <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.7, margin: '0 0 12px' }}>{c.body}</p>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--brand-50)', borderRadius: 999, padding: '5px 11px' }}>{c.state}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 도입 단계 ── */}
      <section id="steps" style={{ ...wrap, padding: '64px 22px 8px' }}>
        <span style={sectionLabel}>도입</span>
        <h2 style={h2}>오픈까지 세 단계</h2>
        <div className="lp-grid" style={{ marginTop: 26 }}>
          {STEPS.map((s) => (
            <div key={s.n} style={{ ...card, padding: '22px 20px' }}>
              <span aria-hidden="true" style={{ display: 'inline-flex', width: 30, height: 30, borderRadius: '50%', background: 'var(--brand)', color: '#fff', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14 }}>{s.n}</span>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '13px 0 8px' }}>{s.title}</h3>
              <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.7, margin: 0 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 운영 콘솔 미리보기 ── */}
      <section style={{ ...wrap, padding: '64px 22px 8px' }}>
        <span style={sectionLabel}>운영</span>
        <h2 style={h2}>무엇이 자동으로 끝났는지 확인합니다</h2>
        <p style={{ ...lead, maxWidth: 640 }}>
          운영 콘솔이 대화량·자동 완결·상담원 전환을 집계합니다. 아직 측정되지 않은 값은 숫자를 지어내지 않고 「측정 중」으로 둡니다.
        </p>
        <div style={{ ...card, padding: 20, marginTop: 24 }}>
          <div className="lp-kpi">
            {CONSOLE_KPI.map(([label, value]) => (
              <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 16px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--sub)' }}>{label}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--mut)', marginTop: 6, letterSpacing: '-.02em' }}>{value}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--mut)', margin: '14px 0 0' }}>
            운영을 시작하면 이 자리에 실제 집계값이 들어갑니다.
          </p>
        </div>
      </section>

      {/* ── 체험 ── */}
      <section id="demo" style={{ ...wrap, padding: '64px 22px 8px' }}>
        <div style={{ ...card, padding: '30px 26px', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ maxWidth: 560 }}>
            <span style={sectionLabel}>체험</span>
            <h2 style={{ ...h2, fontSize: 'clamp(21px,2.6vw,27px)', margin: '8px 0 8px' }}>화면 오른쪽 아래에서 지금 물어보세요</h2>
            <p style={{ ...lead, fontSize: 14.5 }}>
              이 페이지에 떠 있는 상담창이 실제 제품입니다. 답변에 붙는 근거 표시와 상담원 전환까지 그대로 확인하실 수 있습니다.
            </p>
          </div>
          <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, fontWeight: 700, color: 'var(--brand-600)' }}>
            <span>오른쪽 아래 상담창</span><Icon name="arrow" size={20} />
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={{ ...wrap, padding: '64px 22px 8px' }}>
        <span style={sectionLabel}>자주 묻는 질문</span>
        <h2 style={h2}>도입 전에 많이 받는 질문</h2>
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {FAQ.map((f) => (
            <details key={f.q} className="lp-faq" style={{ ...card, padding: '16px 18px' }}>
              <summary style={{ fontSize: 14.5, fontWeight: 700, cursor: 'pointer', listStyle: 'none' }}>{f.q}</summary>
              <p style={{ fontSize: 13.5, color: 'var(--sub)', lineHeight: 1.75, margin: '10px 0 0' }}>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ── 최종 CTA ── */}
      <section id="contact" style={{ ...wrap, padding: '64px 22px 80px' }}>
        <div style={{ background: 'var(--ink)', borderRadius: 'var(--r-lg)', padding: '44px 32px', textAlign: 'center', color: '#fff' }}>
          <h2 style={{ fontSize: 'clamp(22px,3vw,30px)', fontWeight: 800, letterSpacing: '-.025em', margin: 0 }}>
            가지고 계신 FAQ로 먼저 확인해 보세요
          </h2>
          <p style={{ fontSize: 15, color: '#CBD5E1', lineHeight: 1.7, margin: '14px auto 24px', maxWidth: 520 }}>
            운영 중인 안내 자료를 그대로 등록해 실제 문의에 어떻게 답하는지 보여 드립니다. 파일럿 기간의 집계값으로 도입을 판단하실 수 있습니다.
          </p>
          <a href="mailto:contact@example.com?subject=GOWON%20Chat%20%EB%8F%84%EC%9E%85%20%EB%AC%B8%EC%9D%98" style={{ display: 'inline-block', fontSize: 15, fontWeight: 700, color: 'var(--ink)', background: '#fff', borderRadius: 12, padding: '14px 26px' }}>
            도입 문의 보내기
          </a>
          <p style={{ fontSize: 12, color: '#94A3B8', margin: '16px 0 0' }}>데모 환경입니다 — 문의 주소는 도입 시 고객사 담당 창구로 바뀝니다.</p>
        </div>
      </section>

      <footer style={{ borderTop: '1px solid var(--line)', background: 'var(--surface)' }}>
        <div style={{ ...wrap, padding: '26px 22px 34px', textAlign: 'center', fontSize: 12.5, color: 'var(--mut)' }}>
          <a href="/terms" style={{ color: 'var(--sub)', fontWeight: 600, marginRight: 16 }}>이용약관</a>
          <a href="/privacy" style={{ color: 'var(--sub)', fontWeight: 600 }}>개인정보처리방침</a>
          <span style={{ display: 'block', marginTop: 10 }}>© GOWON Chat (데모) — 약관·방침은 초안이며 법률 검토 전입니다.</span>
        </div>
      </footer>

      <ChatWidget />
    </main>
  );
}
