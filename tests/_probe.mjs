/** 64차 재감사 가설 확인용 임시 스크립트 — 끝나면 설명 주석으로 되돌린다. */
import { importLib } from './_compile.mjs';

const S = await importLib('slots', ['normalize', 'handoff', 'kst', 'refusal']);
const NOW = new Date('2026-09-03T01:00:00Z'); // KST 2026-09-03 10:00
const DT = { key: 'datetime', label: '희망 일시', kind: 'datetime', hint: '예: 내일 오후 2시', required: true };

const show = (label, v) => console.log(label.padEnd(34), JSON.stringify(v));

console.log('── ① 없는 날짜 ──');
show('2월 31일 2시', S.parseDateTimeParts('2월 31일 2시', NOW));
show('4/31 14시', S.parseDateTimeParts('4/31 14시', NOW));
show('2026-02-30 14:00', S.parseDateTimeParts('2026-02-30 14:00', NOW));
show('2027-02-29 14:00', S.parseDateTimeParts('2027-02-29 14:00', NOW));
show('validate 2월 31일', S.validateSlot(DT, '2월 31일 오후 2시', NOW));
show('validate 2027-02-30', S.validateSlot(DT, '2027-02-30 14:00', NOW));

console.log('── ② 시 뒤 숫자 ──');
show('내일 오후 2시 4명이요', S.parseDateTimeParts('내일 오후 2시 4명이요', NOW));
show('내일 2시 10명', S.parseDateTimeParts('내일 2시 10명', NOW));
show('내일 오후 2시 (정상)', S.parseDateTimeParts('내일 오후 2시', NOW));
show('내일 오후 2시 30분 (정상)', S.parseDateTimeParts('내일 오후 2시 30분', NOW));
show('내일 14:30 (정상)', S.parseDateTimeParts('내일 14:30', NOW));
show('내일 2시 반 (정상)', S.parseDateTimeParts('내일 2시 반', NOW));
show('validate 2시 4명', S.validateSlot(DT, '내일 오후 2시 4명이요', NOW));

console.log('── ③ 오전·오후 ──');
show('내일 밤 12시', S.parseDateTimeParts('내일 밤 12시', NOW));
show('내일 낮 12시', S.parseDateTimeParts('내일 낮 12시', NOW));
show('오후는 안 되고 오전 10시', S.parseDateTimeParts('내일 오후는 안 되고 오전 10시', NOW));
show('오전 말고 오후 3시', S.parseDateTimeParts('내일 오전 말고 오후 3시', NOW));
show('내일 저녁 12시', S.parseDateTimeParts('내일 저녁 12시', NOW));
show('내일 오전 12시', S.parseDateTimeParts('내일 오전 12시', NOW));
show('내일 새벽 2시 (정상)', S.parseDateTimeParts('내일 새벽 2시', NOW));
