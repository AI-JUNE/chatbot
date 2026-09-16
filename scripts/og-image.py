# 링크 미리보기 이미지(1200x630) 생성 — src/app/opengraph-image.png · twitter-image.png (DS 4-5)
# 브랜드 토큰(globals.css)과 같은 색. 수치·타사 로고 없음(§13). 한글 글꼴은 Noto Sans CJK KR(빌드 환경 기본).
# 실행: python3 scripts/og-image.py
from PIL import Image, ImageDraw, ImageFont
import os
W, H = 1200, 630
BRAND, BRAND600, BRAND50, INK, SUB, LINE, SURFACE = '#2563EB', '#1D4ED8', '#EFF6FF', '#0F172A', '#475569', '#E2E8F0', '#FFFFFF'
S = 3  # 슈퍼샘플링(안티앨리어싱)
img = Image.new('RGB', (W*S, H*S), SURFACE)
d = ImageDraw.Draw(img)
# 상단 브랜드 그라데이션 (brand-50 → surface)
for y in range(0, int(H*S*0.62)):
    t = y / (H*S*0.62)
    c = tuple(int(a*(1-t)+b*t) for a, b in zip((0xEF,0xF6,0xFF),(0xFF,0xFF,0xFF)))
    d.line([(0,y),(W*S,y)], fill=c)
d.rectangle([0, H*S-8*S, W*S, H*S], fill=BRAND)  # 하단 브랜드 바

FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
def f(px): return ImageFont.truetype(FONT, px*S, index=2)  # index 2 = KR
def text(xy, s, px, fill, bold=0):
    d.text((xy[0]*S, xy[1]*S), s, font=f(px), fill=fill, stroke_width=bold*S, stroke_fill=fill)

# 브랜드 마크 — icon.svg 와 같은 구성(말풍선 몸통 + 이니셜 G), 32 좌표계를 size 로 스케일
mark_size = 72
mx, my = 84, 84
sc = mark_size/32
d.rounded_rectangle([(mx+1.5*sc)*S, (my+2.5*sc)*S, (mx+30.5*sc)*S, (my+24.5*sc)*S], radius=int(5.5*sc*S), fill=BRAND)
d.polygon([((mx+8*sc)*S, (my+24*sc)*S), ((mx+13*sc)*S, (my+24*sc)*S), ((mx+8*sc)*S, (my+29.5*sc)*S)], fill=BRAND)
# G: 원호 + 가로선
cx, cy, r = mx+16*sc, my+13.5*sc, 6*sc
d.arc([(cx-r)*S, (cy-r)*S, (cx+r)*S, (cy+r)*S], start=-40, end=270, fill='#FFFFFF', width=int(2.6*sc*S))
d.line([(cx)*S, cy*S, (cx+r)*S, cy*S], fill='#FFFFFF', width=int(2.6*sc*S))
text((mx+mark_size+22, my+12), 'GOWON Chat', 40, INK, bold=1)

# AI 고지 pill
px, py, pw, ph = 84, 214, 300, 48
d.rounded_rectangle([px*S, py*S, (px+pw)*S, (py+ph)*S], radius=24*S, fill=SURFACE, outline=LINE, width=2*S)
d.ellipse([(px+20)*S, (py+19)*S, (px+30)*S, (py+29)*S], fill=BRAND)
text((px+42, py+9), '인공지능(AI)이 응대합니다', 22, BRAND600)

# 헤드라인 2줄 (랜딩 히어로와 같은 문장)
text((84, 292), '등록한 자료를 근거로 답하는', 64, INK, bold=2)
text((84, 380), '상담 챗봇', 64, INK, bold=2)
# 신뢰 3원칙
text((84, 490), '답변마다 근거 표시  ·  모르면 단정하지 않음  ·  필요할 때 상담원 전환', 27, SUB)

out = img.resize((W, H), Image.LANCZOS)
os.makedirs('src/app', exist_ok=True)
out.save('src/app/opengraph-image.png', optimize=True)
out.save('src/app/twitter-image.png', optimize=True)
print('ok', os.path.getsize('src/app/opengraph-image.png'))
