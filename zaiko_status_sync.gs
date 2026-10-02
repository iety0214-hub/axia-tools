/**
 * Gmail → 販売可能物件一覧「在庫状況全て」 現況の自動更新
 *
 * axia-japan@googlegroups.com 宛のメールを10分おきに確認して、該当する物件・号室の「現況」を書き換える。
 *   申込     → 2.申込中
 *   契約     → 3.契約済み
 *   事前承認 → 4.事前承認
 *   本承認   → 5.本承認
 *   金消     → 6.金消済み
 *   オープン → 1.販売可（顧客・決済日も空にする）
 *
 * 種別は本文の【種別】【完了種類】【種類】で見分ける（「契約 金消」のように複数あれば先の段階を採る）。
 * 現況は先に進むときだけ書き換える（契約済みの物件に遅れて申込メールが来ても戻さない）。
 * 顧客欄に別のお客様が入っている行は書き換えず、エラーとして知らせる。
 * オープンは 申込中〜本承認 の行だけ戻す（金消済み・引渡済みは戻さずエラーにする）。
 *
 * 初回だけ dryRun() で確認してから setup() を実行してトリガーを作る。
 */

// ===== 設定 =====
const SHEET_ID = '1xj4nwJI2dXhXDXmL5a6_kBBmPhkBH5C5K7-Dfv6hwW0';
const SHEET_NAME = '在庫状況全て';
const SEARCH_QUERY = 'to:axia-japan@googlegroups.com newer_than:3d -label:在庫反映済み -label:在庫反映エラー';
const LABEL_DONE = '在庫反映済み';
const LABEL_ERROR = '在庫反映エラー';

// 処理済みメールIDを覚えておく日数（検索範囲の3日より長ければよい）
const DONE_KEEP_DAYS = 10;

// 種別 → 現況の番号。上から順に見て、本文の種別に含まれる言葉のうち一番進んだ段階を採る
const STAGES = [
  { word: '金消', rank: 6 },
  { word: '本承認', rank: 5 },
  { word: '事前承認', rank: 4 },
  { word: '契約', rank: 3 },
  { word: '申込', rank: 2 },
];
const OPEN_RANK = 1;

// 現況のプルダウンが読めなかったときに使う表記
const STATUS_LABELS = {
  1: '1.販売可', 2: '2.申込中', 3: '3.契約済み', 4: '4.事前承認', 5: '5.本承認', 6: '6.金消済み', 7: '7.引渡済み',
};

// オープンで戻してよい現況（申込中〜本承認）
const OPENABLE_RANKS = [2, 3, 4, 5];

// オープンのときに空にする列
const CLEAR_ON_OPEN = ['顧客', '決済日'];

// 物件名の表記ゆれをどこまで同じ物件とみなすか（共通部分 ÷ 短い方の長さ）
const NAME_MATCH_RATIO = 0.7;

// ===== エントリポイント =====
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncZaikoStatus')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncZaikoStatus').timeBased().everyMinutes(10).create();
  getLabel_(LABEL_DONE);
  getLabel_(LABEL_ERROR);
}

function syncZaikoStatus() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    run_(SEARCH_QUERY, false);
    cleanupDone_();
  } finally {
    lock.releaseLock();
  }
}

/** シートには書かずに、直近14日のメールで何が起きるかをログに出す */
function dryRun() {
  run_('to:axia-japan@googlegroups.com newer_than:14d', true);
}

function run_(query, dry) {
  const threads = GmailApp.search(query, 0, 50);
  if (!threads.length) return;

  const props = PropertiesService.getScriptProperties();
  const done = dry ? {} : props.getProperties();
  const items = [];
  threads.forEach(thread => thread.getMessages().forEach(m => {
    if (!done['done_' + m.getId()]) items.push({ thread: thread, message: m });
  }));
  if (!items.length) return;
  items.sort((a, b) => a.message.getDate() - b.message.getDate());

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」がない');
  const table = readTable_(sheet);

  const results = new Map();  // threadId → { applied, errors }
  items.forEach(({ thread, message }) => {
    const r = results.get(thread.getId()) || { applied: false, errors: [] };
    results.set(thread.getId(), r);
    let outcome;
    try {
      outcome = processMessage_(table, message, dry);
    } catch (e) {
      outcome = { applied: 0, errors: [e.message] };
    }
    if (!outcome) return;  // 対象外のメール
    if (outcome.applied) r.applied = true;
    outcome.errors.forEach(e => r.errors.push(message.getSubject() + ': ' + e));
    if (dry) console.log((outcome.log || []).concat(outcome.errors.map(e => '  × ' + e)).join('\n'));
  });

  if (dry) return;
  items.forEach(({ message }) => props.setProperty('done_' + message.getId(), String(Date.now())));
  threads.forEach(thread => {
    const r = results.get(thread.getId());
    if (!r || (!r.applied && !r.errors.length)) return;
    if (r.errors.length) {
      thread.addLabel(getLabel_(LABEL_ERROR));
      notifyError_(thread, r.errors);
    } else {
      thread.addLabel(getLabel_(LABEL_DONE));
    }
  });
}

// ===== 1通の処理 =====
/** 対象外のメールなら null。対象なら { applied: 書き換えた件数, errors: [...], log: [...] } */
function processMessage_(table, message, dry) {
  const body = message.getPlainBody().split(/\n--\s*\n|このメールは Google/)[0];
  const f = parseBody_(body);
  const type = (f['種別'] || f['完了種類'] || f['種類'] || '').replace(/\s+/g, ' ');
  if (!type) return null;

  const isOpen = type.indexOf('オープン') !== -1;
  const stage = STAGES.find(s => type.indexOf(s.word) !== -1);
  if (!isOpen && !stage) return null;  // 物件振替・物件確定・電話面談などは対象外

  const mail = isOpen ? parseOpenMail_(f) : parseProgressMail_(f);
  const rank = isOpen ? OPEN_RANK : stage.rank;
  const out = { applied: 0, errors: [], log: [fmt_(message.getDate()) + ' ' + message.getSubject() + ' → ' + table.label(rank)] };
  if (!mail.units.length) {
    if (/未定/.test(f['物件名'] || f['物件名 号室'] || '')) return null;  // 物件未定の申込は反映するものがない
    out.errors.push('物件名・号室が読み取れない');
    return out;
  }

  mail.units.forEach(u => {
    const unitText = u.name + ' ' + u.room;
    const row = findRow_(table, u, mail.customer);
    if (!row) return out.errors.push(unitText + ' が一覧に見つからない');

    const current = statusRank_(row.status);
    const sameCustomer = !row.customer || !mail.customer || sameName_(row.customer, mail.customer);
    let reason = null;
    if (isOpen) {
      if (current === OPEN_RANK) return out.log.push('  - ' + row.name + ' ' + row.room + ': すでに「' + row.status + '」なのでそのまま');
      if (OPENABLE_RANKS.indexOf(current) === -1) reason = '現況が「' + row.status + '」なのでオープンに戻さない';
      else if (row.customer && !sameName_(row.customer, mail.customer)) reason = '顧客欄が「' + row.customer + '」でメールのお客様と違う';
    } else {
      if (!sameCustomer) reason = '顧客欄が「' + row.customer + '」でメールのお客様と違う';
      else if (current >= rank) return out.log.push('  - ' + row.name + ' ' + row.room + ': すでに「' + row.status + '」なのでそのまま');
    }
    if (reason) return out.errors.push(row.name + ' ' + row.room + ': ' + reason);

    out.log.push('  ✓ ' + row.name + ' ' + row.room + ': 「' + row.status + '」→「' + table.label(rank) + '」');
    if (!dry) writeRow_(table, row, rank, isOpen ? '' : (row.customer || surname_(mail.customer)), isOpen);
    out.applied++;
  });
  return out;
}

/** 申込・契約・承認・金消メール: 【物件名】【号室】または【物件名 号室】から号室ごとに分ける */
function parseProgressMail_(f) {
  const customer = cleanName_(f['顧客名'] || f['お客様名前'] || '');
  const propertyText = f['物件名'] || f['物件名 号室'] || f['物件名号室'] || '';
  const roomText = f['号室'] || '';
  const units = [];
  propertyText.split(/[／\/\n]/).map(s => s.trim()).filter(Boolean).forEach(p => {
    if (roomText) {
      splitRooms_(roomText).forEach(room => units.push({ name: p, room: room }));
      return;
    }
    const m = toHalfWidth_(p).match(/^(.*?)\s*(\d{2,4})\s*(?:号室|号)?$/);
    if (m && m[1].trim()) units.push({ name: m[1].trim(), room: m[2] });
  });
  return { customer: customer, units: units };
}

/** オープンメール: 【内容】の「○○様 物件名 号室 … ↓ オープン」から読み取る */
function parseOpenMail_(f) {
  let content = (f['内容'] || '').split('↓')[0];
  let customer = '';
  const i = content.indexOf('様');
  if (i !== -1) {
    customer = cleanName_(content.slice(0, i));
    content = content.slice(i + 1);
  }
  const units = [];
  let lastName = '';
  content.split('\n').forEach(line => {
    const re = /([^\d]*?)\s*(\d{2,4})\s*(?:号室|号)?/g;
    let m;
    while ((m = re.exec(toHalfWidth_(line))) !== null) {
      const name = m[1].replace(/^[\s、,，・.．\/／]+|[\s、,，・.．\/／]+$/g, '');
      if (name) lastName = name;
      if (lastName) units.push({ name: lastName, room: m[2] });
    }
  });
  return { customer: customer, units: units };
}

/** 本文の「【項目】値」を読み取る。値が次の行から始まる書き方や、複数行の値にも対応 */
function parseBody_(body) {
  const fields = {};
  let current = null;
  body.split(/\r?\n/).forEach(line => {
    const text = line.trim();
    if (!text) return;
    if (/^(よろしく|宜しく|以上)/.test(text)) { current = null; return; }
    const m = text.match(/^【(.+?)】\s*(.*)$/);
    if (m) {
      current = m[1].replace(/\s+/g, ' ').trim();
      if (!(current in fields)) fields[current] = m[2].trim();
      else current = null;  // 同じ項目が2回目以降なら最初の値を使う
      return;
    }
    if (current) fields[current] = (fields[current] ? fields[current] + '\n' : '') + text;
  });
  return fields;
}

function splitRooms_(text) {
  return (toHalfWidth_(text).match(/\d{2,4}/g) || []);
}

// ===== シート =====
/** 見出し行（A列が「物件」）から次の見出し行までを読む */
function readTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  const head = values.findIndex(v => String(v[0]).trim() === '物件');
  if (head === -1) throw new Error('見出し行（A列「物件」）が見つからない');
  const col = {};
  values[head].forEach((h, i) => { col[String(h).trim()] = i; });
  ['物件', '号室', '現況', '顧客'].forEach(k => {
    if (!(k in col)) throw new Error('見出し「' + k + '」の列がない');
  });

  const rows = [];
  for (let i = head + 1; i < values.length; i++) {
    const v = values[i];
    if (String(v[0]).trim() === '物件') break;  // 下の別表（仕入れ）は対象外
    if (!String(v[col['物件']]).trim()) continue;
    rows.push({
      r: i + 1,
      name: String(v[col['物件']]).trim(),
      room: String(v[col['号室']]).trim(),
      status: String(v[col['現況']]).trim(),
      customer: String(v[col['顧客']]).trim(),
    });
  }

  const labels = statusLabels_(sheet, head + 2, col['現況'] + 1);
  return { sheet: sheet, col: col, rows: rows, label: rank => labels[rank] || STATUS_LABELS[rank] };
}

/** 現況列のプルダウンに「4.○○」があればその表記を使う */
function statusLabels_(sheet, row, column) {
  const labels = Object.assign({}, STATUS_LABELS);
  const rule = sheet.getRange(row, column).getDataValidation();
  if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return labels;
  (rule.getCriteriaValues()[0] || []).forEach(v => {
    const n = statusRank_(v);
    if (n) labels[n] = String(v).trim();
  });
  return labels;
}

function writeRow_(table, row, rank, customer, isOpen) {
  const { sheet, col } = table;
  const label = table.label(rank);
  sheet.getRange(row.r, col['現況'] + 1).setValue(label);
  if (isOpen) {
    CLEAR_ON_OPEN.filter(k => k in col).forEach(k => sheet.getRange(row.r, col[k] + 1).clearContent());
  } else if (customer && !row.customer) {
    sheet.getRange(row.r, col['顧客'] + 1).setValue(customer);
  }
  row.status = label;
  row.customer = isOpen ? '' : (row.customer || customer);
}

/**
 * 号室が一致し、物件名が十分似ている行を探す。
 * 候補が複数あれば、顧客名が合う行 → 物件名がより似ている行の順で選ぶ。
 */
function findRow_(table, unit, customer) {
  const room = normRoom_(unit.room);
  const name = normalize_(unit.name);
  const candidates = table.rows
    .filter(row => normRoom_(row.room) === room)
    .map(row => ({ row: row, score: nameScore_(normalize_(row.name), name) }))
    .filter(c => c.score >= NAME_MATCH_RATIO);
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (customerHit_(b.row, customer) - customerHit_(a.row, customer)) || (b.score - a.score));
  return candidates[0].row;
}

function customerHit_(row, customer) {
  return row.customer && customer && sameName_(row.customer, customer) ? 1 : 0;
}

/** 片方がもう片方を含めば1。そうでなければ共通部分の長さ ÷ 短い方の長さ */
function nameScore_(a, b) {
  if (!a || !b) return 0;
  if (Math.min(a.length, b.length) >= 3 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) return 1;
  return longestCommon_(a, b) / Math.min(a.length, b.length);
}

function longestCommon_(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

function statusRank_(status) {
  const m = toHalfWidth_(String(status)).match(/^\s*(\d)/);
  return m ? Number(m[1]) : 0;
}

// ===== 名前 =====
function cleanName_(s) {
  return String(s).replace(/\n/g, ' ').replace(/\s*様.*$/, '').trim();
}

/** シートの顧客欄は苗字だけなので、空白で区切られていれば最初の部分を使う */
function surname_(name) {
  return String(name).trim().split(/[\s　]+/)[0] || '';
}

/** 「水澤」と「水澤 虎太郎」、「岩﨑」と「岩崎」は同じ人とみなす */
function sameName_(a, b) {
  const x = nameKey_(a), y = nameKey_(b);
  if (!x || !y) return false;
  return x.indexOf(y) === 0 || y.indexOf(x) === 0;
}

function nameKey_(s) {
  return String(s).replace(/[\s　]|様/g, '')
    .replace(/﨑/g, '崎').replace(/髙/g, '高').replace(/[齋齊斎]/g, '斉').replace(/邊|邉/g, '辺');
}

// ===== 小道具 =====
function normalize_(s) {
  return toHalfWidth_(String(s))
    .replace(/号室/g, '')
    .replace(/[\s　\-‐－ｰー―・.．]/g, '')
    .toLowerCase();
}

function normRoom_(s) {
  const m = toHalfWidth_(String(s)).match(/\d+/);
  return m ? String(Number(m[0])) : '';
}

function toHalfWidth_(s) {
  return String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function fmt_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'M/d HH:mm');
}

function getLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function cleanupDone_() {
  const props = PropertiesService.getScriptProperties();
  const limit = Date.now() - DONE_KEEP_DAYS * 86400000;
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('done_') === 0 && Number(all[k]) < limit) props.deleteProperty(k);
  });
}

function notifyError_(thread, errors) {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    '【在庫反映エラー】' + thread.getFirstMessageSubject(),
    '在庫状況に自動で反映できんかった分があるけん、手で直してね。\n\n' +
    errors.map(e => '・' + e).join('\n') + '\n\n' + thread.getPermalink());
}
