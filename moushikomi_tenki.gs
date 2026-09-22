/**
 * 【申込】メール → 決済進行状況表 自動転記
 *
 * axia-japan@googlegroups.com 宛の「【申込】」メールを5分おきに確認し、
 * 申込日の月シート（例: 2026.9）の当月案件欄（4〜23行目）の空き行へ転記する。
 * 手で入力済みのセルは上書きしない。同じ案件の行がすでにあれば、空欄のセルだけ埋める。
 * 転記したスレッドには「転記済み」、読み取れなかったものには「転記エラー」ラベルを付ける。
 *
 * 初回だけ setup() を実行してトリガーを作る。
 */

// ===== 設定 =====
const SHEET_ID = 'ここにGoogleスプレッドシートのIDを入れる';
const TEMPLATE_SHEET = '原本';
const SEARCH_QUERY = 'to:axia-japan@googlegroups.com subject:【申込】 newer_than:3d -label:転記済み -label:転記エラー';
const LABEL_DONE = '転記済み';
const LABEL_ERROR = '転記エラー';

// 当月案件欄・繰越欄（重複チェック用）
const MAIN_FIRST_ROW = 4;
const MAIN_LAST_ROW = 23;
const CARRY_FIRST_ROW = 26;
const CARRY_LAST_ROW = 55;

// この時刻より前に送られたメールは前日の申込として扱う（深夜報告の対策）
const LATE_NIGHT_HOUR = 6;

// 同姓がいる担当者はシート上の表記に置き換える
const NAME_MAP = {
  '伊藤': '伊藤愛',
};

const TITLES = /(課長代理|部長|次長|課長|係長|主任|店長|さん|様)$/;

// 列（1始まり）
const COL = {
  申込日: 2, 契約日: 3, 区分: 4, 顧客名: 5, 物件名: 9, 号室: 10,
  金融機関: 17, 決済日: 23, 課責: 24, 担当: 25, 同行1: 26, 同行2: 27,
};

// ===== エントリポイント =====
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processMoushikomi')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processMoushikomi').timeBased().everyMinutes(5).create();
  getLabel_(LABEL_DONE);
  getLabel_(LABEL_ERROR);
}

function processMoushikomi() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const threads = GmailApp.search(SEARCH_QUERY, 0, 20);
    threads.forEach(thread => {
      try {
        thread.getMessages()
          .filter(m => m.getSubject().indexOf('【申込】') !== -1)
          .forEach(m => transcribeMessage_(ss, m));
        thread.addLabel(getLabel_(LABEL_DONE));
      } catch (e) {
        console.error(thread.getFirstMessageSubject() + ': ' + e.message);
        thread.addLabel(getLabel_(LABEL_ERROR));
        notifyError_(thread, e);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ===== 転記 =====
function transcribeMessage_(ss, message) {
  const appliedAt = applicationDate_(message.getDate());
  const rows = buildRows_(parseBody_(message.getPlainBody()), appliedAt);
  const sheet = getMonthSheet_(ss, appliedAt);

  rows.forEach(row => {
    const r = findExistingRow_(sheet, row) || findEmptyRow_(sheet);
    if (!r) throw new Error(sheet.getName() + ' の当月案件欄（' + MAIN_FIRST_ROW + '〜' + MAIN_LAST_ROW + '行）に空きがない');
    fillBlanks_(sheet, r, row);
  });
}

/** 手で入力済みのセルは残し、空欄のセルだけメールの値で埋める */
function fillBlanks_(sheet, r, row) {
  Object.keys(COL).forEach(key => {
    if (row[key] === '' || row[key] == null) return;
    const cell = sheet.getRange(r, COL[key]);
    if (String(cell.getValue()).trim() === '') cell.setValue(row[key]);
  });
}

/** 本文の「【項目】値」を読み取る */
function parseBody_(body) {
  const fields = {};
  body.split(/\r?\n/).forEach(line => {
    const m = line.trim().match(/^【(.+?)】\s*(.*)$/);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  });
  return fields;
}

/** 読み取った項目を、号室ごとの行データに組み立てる */
function buildRows_(f, appliedAt) {
  if (f['種別'] && f['種別'] !== '申込') throw new Error('種別が「申込」ではない: ' + f['種別']);
  if (!f['顧客名'] || !f['物件名']) throw new Error('顧客名か物件名が読み取れない');

  const staff = splitNames_(f['担当']);
  const companions = splitNames_(f['同行']);
  const base = {
    申込日: appliedAt,
    契約日: parseJpDate_(f['契約'], appliedAt),
    区分: f['区分'] || '',
    顧客名: f['顧客名'].replace(/様$/, '').trim(),
    金融機関: f['銀行'] || '',
    決済日: parseJpDate_(f['決済予定'], appliedAt),
    課責: (f['所属'] || '').replace(/課$/, '').trim(),
    担当: staff[0] || '',
    同行1: companions[0] || '',
    同行2: companions[1] || '',
  };

  return splitUnits_(f['物件名'], f['号室']).map(u =>
    Object.assign({}, base, { 物件名: u.name, 号室: u.room }));
}

/**
 * 「AXIA CITY神戸松原」＋【号室】304 の形と、
 * 「AXIA CITY神戸松原 201号室／AXIA CITY神戸松原 202号室」の形の両方に対応する
 */
function splitUnits_(propertyText, roomText) {
  const parts = propertyText.split(/[／\/]/).map(s => s.trim()).filter(Boolean);
  const units = [];
  parts.forEach(p => {
    const m = p.match(/^(.*?)\s*(\d+)\s*(号室|号)?$/);
    if (m && m[1]) units.push({ name: m[1].trim(), room: toNumber_(m[2]) });
    else if (roomText) {
      roomText.split(/[、,・／\/\s]+/).filter(Boolean).forEach(room =>
        units.push({ name: p, room: toNumber_(room.replace(/号室?$/, '')) }));
    } else units.push({ name: p, room: '' });
  });
  if (!units.length) throw new Error('物件名が読み取れない: ' + propertyText);
  return units;
}

function splitNames_(text) {
  if (!text) return [];
  return text.split(/[、,，・／\/]+/)
    .map(s => s.trim().replace(TITLES, '').trim())
    .filter(Boolean)
    .map(s => NAME_MAP[s] || s);
}

/** 「9月25日（金）」→ Date。年は申込日から近い方を採る */
function parseJpDate_(text, ref) {
  if (!text) return '';
  const m = toHalfWidth_(text).match(/(?:(\d{4})[年\/.])?\s*(\d{1,2})[月\/.]\s*(\d{1,2})/);
  if (!m) return '';
  let year = m[1] ? Number(m[1]) : ref.getFullYear();
  let d = new Date(year, Number(m[2]) - 1, Number(m[3]));
  if (!m[1] && d.getTime() < ref.getTime() - 180 * 86400000) d = new Date(year + 1, Number(m[2]) - 1, Number(m[3]));
  return d;
}

/** 送信日時から申込日を決める（深夜・早朝の報告は前日扱い） */
function applicationDate_(sentAt) {
  const d = new Date(sentAt.getFullYear(), sentAt.getMonth(), sentAt.getDate());
  if (sentAt.getHours() < LATE_NIGHT_HOUR) d.setDate(d.getDate() - 1);
  return d;
}

// ===== シート操作 =====
function getMonthSheet_(ss, date) {
  const y = date.getFullYear(), m = date.getMonth() + 1;
  const sheet = ss.getSheetByName(y + '.' + m) || ss.getSheetByName(y + ',' + m);
  if (sheet) return sheet;

  // 月シートがまだなければ原本をコピーして作る
  const template = ss.getSheetByName(TEMPLATE_SHEET);
  if (!template) throw new Error('シート「' + y + '.' + m + '」も「' + TEMPLATE_SHEET + '」もない');
  const created = template.copyTo(ss).setName(y + '.' + m);
  ss.setActiveSheet(created);
  ss.moveActiveSheet(template.getIndex() + 1);
  created.getRange('B1').setValue('決済進行状況表' + y + '年' + m + '月期');
  return created;
}

function findEmptyRow_(sheet) {
  const names = sheet.getRange(MAIN_FIRST_ROW, COL.顧客名, MAIN_LAST_ROW - MAIN_FIRST_ROW + 1, 1).getValues();
  const i = names.findIndex(v => String(v[0]).trim() === '');
  return i === -1 ? null : MAIN_FIRST_ROW + i;
}

/** 同じ顧客・物件・号室の行が当月案件欄か繰越欄にあれば、その行番号を返す */
function findExistingRow_(sheet, row) {
  const key = normalize_(row.顧客名) + '|' + normalize_(row.物件名) + '|' + normalize_(row.号室);
  for (const [from, to] of [[MAIN_FIRST_ROW, MAIN_LAST_ROW], [CARRY_FIRST_ROW, CARRY_LAST_ROW]]) {
    const values = sheet.getRange(from, 1, to - from + 1, COL.号室).getValues();
    const i = values.findIndex(v =>
      normalize_(v[COL.顧客名 - 1]) + '|' + normalize_(v[COL.物件名 - 1]) + '|' + normalize_(v[COL.号室 - 1]) === key);
    if (i !== -1) return from + i;
  }
  return null;
}

// ===== 小道具 =====
function normalize_(v) {
  return toHalfWidth_(String(v)).replace(/[\s　]/g, '').toUpperCase();
}

function toHalfWidth_(s) {
  return String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function toNumber_(s) {
  const n = Number(toHalfWidth_(s).trim());
  return isNaN(n) ? s : n;
}

function getLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function notifyError_(thread, e) {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
    '【転記エラー】' + thread.getFirstMessageSubject(),
    '自動転記できんかったけん、手で入れてね。\n\n理由: ' + e.message + '\n\n' + thread.getPermalink());
}

// ===== 動作確認用（シートには書かん） =====
function testParse() {
  const samples = [
    '【種別】申込\n【区分】新規\n【顧客名】加賀谷 直樹様\n【物件名】AXIA CITY神戸松原\n【号室】304\n【銀行】楽天銀行\n【契約】9月25日（金）\n【決済予定】10月30日（金）\n【担当】五十嵐主任\n【同行】安部課長、佐野係長\n【所属】佐野課',
    '【種別】申込\n【区分】新規\n【顧客名】水澤　虎太郎様\n【物件名】AXIA CITY神戸松原 201号室／AXIA CITY神戸松原 202号室\n【銀行】楽天銀行\n【契約】9月30日（水）\n【決済予定】10月30日（金）\n【担当】伊藤係長\n【同行】笠原部長\n【所属】笠原課',
  ];
  samples.forEach(s => console.log(JSON.stringify(buildRows_(parseBody_(s), new Date(2026, 8, 19)))));
}
