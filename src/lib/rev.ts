/**
 * 「내가 본 그때의 모습」을 한 줄로 — 두 화면이 같은 것을 들고 있는지 재는 자 (DS 46-1).
 *
 * 이 제품의 쓰기 경로는 전부 **덮어쓰기**다: 콘솔의 편집 폼은 칸의 값을 통째로 보내고, 서버는
 * 받은 대로 갈아 끼운다. 한 사람이 쓸 때는 맞는 동작이지만, 관리 콘솔은 **여러 사람이 같은
 * 토큰으로** 들어와 30초마다 갱신되는 목록을 보는 화면이다. 그 사이 다른 사람이 같은 자료를
 * 고쳤거나 지웠으면
 *  - 고친 것은 **말없이 사라지고**(먼저 연 쪽이 나중에 저장하면 이긴다),
 *  - 지운 것은 「수정 저장」이 **되살린다**(없는 식별자를 새로 만든다 — DS 27-3 이 같은 탭에서
 *    닫았던 자리가 두 사람 사이에서는 그대로 열려 있었다).
 *
 * 그래서 「무엇을 보고 고치기 시작했는가」를 한 줄(`rev`)로 들고 다닌다. 서버는 저장 직전에
 * 지금 값의 rev 와 견주어, 다르면 **거절하고 무엇이 달라졌는지 말한다**. 값은 저장소에 적지
 * 않는다 — 내용에서 그때그때 만드는 값이라 스냅샷·백업 모양이 바뀌지 않는다.
 *
 * 재는 자는 **한 벌**이다(DS 42-2) — 보내는 쪽(목록 응답)과 견주는 쪽(저장)이 다른 식으로
 * 계산하면 영영 어긋나거나 영영 같아진다.
 */

/** 키 순서에 흔들리지 않는 직렬화 — `{a,b}` 와 `{b,a}` 는 같은 모습이다. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const o = value as Record<string, unknown>;
  // 없는 칸과 `undefined` 인 칸은 같은 사실이다(JSON 왕복에서 둘은 구분되지 않는다).
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/**
 * 내용 한 줄 — 같은 내용이면 같은 값, 한 글자라도 다르면 다른 값.
 *
 * 비밀을 지키는 값이 아니라 **달라졌는지**를 재는 값이라 짧은 해시로 충분하다. 다만 한글은
 * 한 글자가 두 바이트라 상위 바이트까지 함께 섞고(그러지 않으면 「요금」과 「요구」가 같은 값이
 * 될 수 있다), 길이를 뒤에 붙여 우연히 같아지는 자리를 한 겹 더 줄인다.
 */
export function revOf(value: unknown): string {
  const s = stable(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 16777619);
    h = Math.imul(h ^ (c >>> 8), 16777619);
  }
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}
