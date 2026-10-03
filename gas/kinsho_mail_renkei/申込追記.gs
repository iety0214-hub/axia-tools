/**
 * 【申込】メールを読んで、金消アプリ（AXIA_Kinsho）に物件を自動で追記するスクリプト。
 *
 * ■ 使い方
 *   1. 「AXIA金消メール連携」プロジェクトの 申込追記.gs に入っとる（Supabaseの接続先は コード.gs の CFG を共用）
 *   2. まず testRunMoushikomi() を実行（何も書き込まん。登録される内容がログに出るだけ）
 *   3. 中身が合っとったら setupTriggerMoushikomi() を実行（10分おきの自動実行がセットされる）
 *   4. 止めたいときは stopMoushikomi() を実行
 *
 * ■ やること
 *   ・Gmailで未処理の【申込】メールを探す
 *   ・物件名・号室・顧客名・銀行・契約日時・立会・担当・同行を読み取る
 *     （担当・同行は「佐野係長」→「佐野」のように役職を外し、2人以上は「・」でつなぐ）
 *   ・金消アプリ（Supabase）の「契約日の月」の一覧に行を足す。1通で複数物件なら、その数だけ行を作る
 *   ・どこかの月に同じ「物件名＋号室」の行がすでにあったら飛ばす
 *   ・処理したメールには「金消登録済」のラベルを付けて、二度と処理せん
 */

// ===== 設定 =====
// Supabaseの接続先（URL・キー・テーブル名）は コード.gs の CFG を共用する
const MCFG = {
  // 探すメール。【種別】申込 が入っとるAXIA JAPANグループ宛てのメールだけ
  QUERY: 'to:axia-japan@googlegroups.com "【種別】申込" newer_than:14d',
  DONE_LABEL: '金消登録済',   // 処理済みの印。消すとまた処理してしまうけん注意
  REPORT_TO: 'iety0214@gmail.com',  // 結果の知らせ先。空にすると知らせメールを出さん
  REPORT_ONLY_WHEN_CHANGED: true,   // 追加も失敗も無い回はメールを出さん
};

// ===== 本体 =====
function syncMoushikomiMails() {
  const label = getOrCreateLabel_(MCFG.DONE_LABEL);
  allRows_.cache = null;
  const threads = GmailApp.search(MCFG.QUERY + ' -label:"' + MCFG.DONE_LABEL + '"', 0, 30);
  if (!threads.length) return;  // 申込メールがない回はSupabaseに問い合わせずに終わる
  const settings = fetchSettings_();
  const added = [], skipped = [], failed = [];

  threads.forEach(th => {
    th.getMessages().forEach(msg => {
      const body = msg.getPlainBody() || '';
      if (body.indexOf('【種別】') < 0 || body.indexOf('申込') < 0) return;
      try {
        const rows = buildRows_(body, msg.getDate(), settings);
        if (!rows.length) { failed.push(msg.getSubject() + '：中身を読み取れんかった'); return; }
        rows.forEach(row => {
          const dup = findDuplicate_(row, settings);
          if (dup) { skipped.push(row._label + '（' + dup.month + ' にすでにある）'); return; }
          insertRow_(row);
          added.push(row._label);
        });
      } catch (e) {
        failed.push(msg.getSubject() + '：' + e);
      }
    });
    th.addLabel(label);
  });

  report_(added, skipped, failed);
  return { added: added, skipped: skipped, failed: failed };
}

/** 書き込まずに、登録される中身をログに出すだけ（動作確認用） */
function testRunMoushikomi() {
  const settings = fetchSettings_();
  const threads = GmailApp.search(MCFG.QUERY, 0, 10);
  threads.forEach(th => th.getMessages().forEach(msg => {
    const body = msg.getPlainBody() || '';
    if (body.indexOf('【種別】') < 0 || body.indexOf('申込') < 0) return;
    const rows = buildRows_(body, msg.getDate(), settings);
    Logger.log('--- ' + msg.getSubject() + ' (' + msg.getDate() + ')');
    rows.forEach(r => Logger.log('  ' + r._label + '  月=' + r.month + '  ' + JSON.stringify(r.fields)
      + (findDuplicate_(r, settings) ? '  ★' + findDuplicate_(r, settings).month + ' にすでにあるけん飛ばす' : '')));
  }));
}

function setupTriggerMoushikomi() {
  stopMoushikomi();
  ScriptApp.newTrigger('syncMoushikomiMails').timeBased().everyMinutes(10).create();
  Logger.log('10分おきの自動実行をセットしたばい');
}

function stopMoushikomi() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncMoushikomiMails') ScriptApp.deleteTrigger(t);
  });
  Logger.log('自動実行を止めたばい');
}

// ===== メールを読み取って、アプリの行に組み立てる =====
function buildRows_(body, mailDate, settings) {
  const v = parseBody_(body);
  const pairs = propertyPairs_(v);
  if (!pairs.length) return [];

  const contract = parseDateTime_(v['契約予定'] || v['契約'], mailDate);
  // 【契約予定】（旧【契約】）の月の一覧に入れる。契約日が読み取れんかったときは【決済予定】、それも無ければメールが届いた月
  const kessai = parseDateTime_(v['決済予定'], mailDate);
  const month = contract.d ? contract.d.slice(0, 7)
    : kessai.d ? kessai.d.slice(0, 7)
    : Utilities.formatDate(mailDate, 'Asia/Tokyo', 'yyyy-MM');

  return pairs.map(p => {
    const f = {};
    if (settings.keyOf.bukken) f[settings.keyOf.bukken] = p.bukken;
    if (settings.keyOf.room && p.room) f[settings.keyOf.room] = p.room;
    if (settings.keyOf.bank) {
      const b = normalizeBank_(v['銀行'], settings.bankOptions);
      if (b) f[settings.keyOf.bank] = b;
    }
    if (settings.keyOf.contract) f[settings.keyOf.contract] = contract;
    if (settings.keyOf.kinsho) f[settings.keyOf.kinsho] = { d: '', t: '', none: true };  // 金消予定日はメールに無いけん空
    const tachiai = clean_(v['立会']);
    if (settings.keyOf.tachiai && tachiai && tachiai !== '－' && tachiai !== '-') {
      f[settings.keyOf.tachiai] = tachiai;
    }
    const tanto = staffNames_(v['担当']);
    if (settings.keyOf.tanto && tanto) f[settings.keyOf.tanto] = tanto;
    const doko = staffNames_(v['同行']);
    if (settings.keyOf.doko && doko) f[settings.keyOf.doko] = doko;
    return {
      month: month,
      name: (clean_(v['顧客名']) || '').replace(/様\s*$/, ''),
      fields: f,
      _bukken: p.bukken,
      _room: p.room,
      _label: p.bukken + (p.room ? ' ' + p.room : '') + '／' + (clean_(v['顧客名']) || '名前なし'),
    };
  });
}

/** 【キー】値 を全部拾う。値が次の行に続くこともあるけん、次の【が出るまで繋ぐ */
function parseBody_(body) {
  const out = {};
  let key = null;
  body.split('\n').forEach(line => {
    let rest = line;
    let m;
    while ((m = rest.match(/【([^】]+)】/))) {
      const before = rest.slice(0, m.index);
      if (key && before.trim()) out[key] = (out[key] ? out[key] + '\n' : '') + before.trim();
      key = m[1].trim();
      if (!(key in out)) out[key] = '';
      rest = rest.slice(m.index + m[0].length);
    }
    if (key && rest.trim()) out[key] = (out[key] ? out[key] + '\n' : '') + rest.trim();
    // 空行が来たら、値の続きはそこで終わり
    if (!line.trim()) key = null;
  });
  return out;
}

/** 物件名と号室を組にする。3つの書き方に対応 */
function propertyPairs_(v) {
  const rawProp = clean_(v['物件名']);
  if (!rawProp) return [];
  // ①「AXIA CITY神戸松原 201号室／AXIA CITY神戸松原 202号室」のように、物件名の中に号室が入っとる形
  const parts = rawProp.split(/[／\/\n]+/).map(s => s.trim()).filter(String);
  const embedded = parts.map(s => {
    const m = s.match(/^(.*?)[\s　]*([0-9]{1,5})\s*号室$/);
    return m ? { bukken: m[1].trim(), room: m[2] } : { bukken: s, room: '' };
  });
  if (embedded.some(p => p.room)) return embedded;

  // ②③ 号室は【号室】に別途書いてある形
  const rooms = (clean_(v['号室']) || '').split(/[\s　,、／\/\n]+/).map(s => s.replace(/号室$/, '').trim()).filter(String);
  const props = embedded.map(p => p.bukken);
  if (!rooms.length) return props.map(b => ({ bukken: b, room: '' }));
  if (props.length === 1) return rooms.map(r => ({ bukken: props[0], room: r }));       // 1物件に複数号室
  if (props.length === rooms.length) return props.map((b, i) => ({ bukken: b, room: rooms[i] })); // 物件と号室が同数（順番どおり組む）
  // 数が合わんときは多いほうに合わせる（あとで人が直せるように、足りん分は空にする）
  const n = Math.max(props.length, rooms.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ bukken: props[i] || props[0], room: rooms[i] || '' });
  return out;
}

/** 「9月25日（金）22:00茨城石岡」→ {d:'2026-09-25', t:'22:00', none:false} */
function parseDateTime_(raw, mailDate) {
  const s = clean_(raw) || '';
  const md = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!md) return { d: '', t: '', none: true };
  const mon = Number(md[1]), day = Number(md[2]);
  const base = new Date(mailDate);
  let year = Number(Utilities.formatDate(base, 'Asia/Tokyo', 'yyyy'));
  const mailMon = Number(Utilities.formatDate(base, 'Asia/Tokyo', 'MM'));
  // 年またぎ：12月のメールで1月の契約なら翌年、その逆なら前年とみなす
  if (mon - mailMon <= -6) year += 1;
  else if (mon - mailMon >= 7) year -= 1;
  const tm = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  const pad = n => ('0' + n).slice(-2);
  return {
    d: year + '-' + pad(mon) + '-' + pad(day),
    t: tm ? pad(Number(tm[1])) + ':' + tm[2] : '',
    none: false,
  };
}

/** 「楽天銀行」→ アプリの選択肢の「楽天」に寄せる */
function normalizeBank_(raw, options) {
  const s = clean_(raw) || '';
  if (!s) return '';
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o && (s.indexOf(o) >= 0 || o.indexOf(s) >= 0)) return o;
  }
  return s.replace(/銀行$/, '');
}

/** 「安部課長、佐野係長」→「安部・佐野」。役職や「さん」を外して「・」でつなぐ。空や「－」「なし」は '' */
function staffNames_(raw) {
  return (clean_(raw) || '').split(/[、,，・／\/\n]+/)
    .map(s => s.trim().replace(/(課長代理|部長代理|部長|次長|課長|係長|主任|店長|社長|専務|常務|室長|さん|様)$/, '').trim())
    .filter(s => s && !/^(－|-|ー|―|なし|無し)$/.test(s))
    .join('・');
}

function clean_(s) {
  return (s == null ? '' : String(s)).replace(/^[\s　:：]+|[\s　]+$/g, '');
}

// ===== アプリ（Supabase）とのやりとり =====
/** 設定から「項目名 → キー」を作る。設定で項目名を変えても追従できるようにするため */
function fetchSettings_() {
  const res = api_('GET', '/rest/v1/' + CFG.STABLE + '?select=settings&id=eq.1');
  const fields = (res[0] && res[0].settings && res[0].settings.fields) || [];
  const find = re => { const f = fields.filter(x => re.test(x.label || ''))[0]; return f ? f.key : ''; };
  const bankKey = find(/銀行/);
  const bankField = fields.filter(x => x.key === bankKey)[0];
  return {
    keyOf: {
      bukken: find(/物件/),
      room: find(/号室|部屋/),
      bank: bankKey,
      contract: find(/契約/),
      kinsho: find(/金消/),
      tachiai: find(/立会/),
      tanto: find(/担当/),
      doko: find(/同行/),
    },
    bankOptions: (bankField && bankField.options) || [],
  };
}

/** 一覧の行を全部取ってくる（1回の実行では1度だけ取りに行く） */
function allRows_(refresh) {
  if (refresh || !allRows_.cache) {
    allRows_.cache = api_('GET', '/rest/v1/' + CFG.TABLE + '?select=id,month,name,fields,sort_order');
  }
  return allRows_.cache;
}

/** 同じ「物件名＋号室」の行が、どこかの月にすでにあるか（月をまたいで二重にせんため） */
function findDuplicate_(row, settings) {
  const bk = settings.keyOf.bukken, rk = settings.keyOf.room;
  // 「(諸費用有102万)」みたいな注記や空白は外して見る
  const norm = s => String(s == null ? '' : s).replace(/[（(].*?[）)]/g, '').replace(/[\s　]/g, '').toLowerCase();
  return allRows_().filter(r => {
    const f = r.fields || {};
    return norm(f[bk]) === norm(row._bukken) && norm(f[rk]) === norm(row._room);
  })[0];
}

function insertRow_(row) {
  const rows = allRows_();
  const maxSo = rows.filter(r => r.month === row.month)
    .reduce((m, r) => Math.max(m, r.sort_order || 0), 0);
  const made = api_('POST', '/rest/v1/' + CFG.TABLE, {
    month: row.month, name: row.name, fields: row.fields, sort_order: maxSo + 1000,
  });
  // 足した行もためておく（同じ回のうちに同じ物件が2回来ても二重に入れんように）
  rows.push({ id: (made[0] || {}).id, month: row.month, fields: row.fields, sort_order: maxSo + 1000 });
}

function api_(method, path, payload) {
  const opt = {
    method: method,
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      apikey: CFG.SUPABASE_KEY,
      Authorization: 'Bearer ' + CFG.SUPABASE_KEY,
      Prefer: 'return=representation',
    },
  };
  if (payload) opt.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(CFG.SUPABASE_URL + path, opt);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error('Supabase ' + code + ' ' + res.getContentText().slice(0, 200));
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : [];
}

// ===== 結果の知らせ =====
function report_(added, skipped, failed) {
  if (!MCFG.REPORT_TO) return;
  if (MCFG.REPORT_ONLY_WHEN_CHANGED && !added.length && !failed.length) return;
  const lines = [];
  if (added.length) lines.push('■ 追加した物件（' + added.length + '件）', ...added.map(s => '・' + s), '');
  if (skipped.length) lines.push('■ すでにあったけん飛ばした（' + skipped.length + '件）', ...skipped.map(s => '・' + s), '');
  if (failed.length) lines.push('■ 登録できんかった（' + failed.length + '件）', ...failed.map(s => '・' + s), '');
  lines.push('金消アプリ：https://iety0214-hub.github.io/axia-tools/AXIA_Kinsho.html');
  GmailApp.sendEmail(MCFG.REPORT_TO,
    '【金消アプリ】申込メールから ' + added.length + '件追加' + (failed.length ? ' / ' + failed.length + '件失敗' : ''),
    lines.join('\n'));
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}


// ===== 繰り越し（毎朝6時）：前の月までに残っとる「金消予定日が空」の案件を今月へ移す =====
// 動かし方：carryOverKinshoTest＝書き込まずログだけ／setupTriggerCarryOver＝毎朝6時に自動／stopCarryOver＝止める
function setupTriggerCarryOver() {
  stopCarryOver();
  ScriptApp.newTrigger('carryOverKinsho').timeBased().atHour(6).everyDays(1).create();
  Logger.log('毎朝6時の繰り越しをセットしたばい');
}

function stopCarryOver() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'carryOverKinsho') ScriptApp.deleteTrigger(t);
  });
  Logger.log('繰り越しの自動実行を止めたばい');
}

function carryOverKinsho(dryRun) {
  // トリガーから呼ばれると引数にイベントが入るけん、true のときだけお試し扱いにする
  const dry = dryRun === true;
  const settings = fetchSettings_();
  const kKey = settings.keyOf.kinsho;
  const bKey = settings.keyOf.bukken, rKey = settings.keyOf.room;
  const nowMonth = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
  const rows = allRows_(true);
  const moved = [], failed = [];

  rows.filter(r => r.month < nowMonth).forEach(r => {
    const v = (r.fields || {})[kKey];
    const d = (v && typeof v === 'object') ? v.d : v;
    if (d) return;   // 金消予定日が入っとる案件はそのまま（済んだ月に残す）
    const label = ((r.fields || {})[bKey] || '') + ' ' + ((r.fields || {})[rKey] || '')
      + '／' + (r.name || '名前なし') + '（' + r.month + '→' + nowMonth + '）';
    if (dry) { moved.push(label); return; }
    try {
      const maxSo = rows.filter(x => x.month === nowMonth)
        .reduce((m, x) => Math.max(m, x.sort_order || 0), 0);
      api_('PATCH', '/rest/v1/' + CFG.TABLE + '?id=eq.' + r.id,
        { month: nowMonth, sort_order: maxSo + 1000 });
      r.month = nowMonth; r.sort_order = maxSo + 1000;   // 次の1件の並び順の計算に使う
      moved.push(label);
    } catch (e) {
      failed.push(label + '：' + e);
    }
  });

  Logger.log((dry ? '【お試し】' : '') + '繰り越し ' + moved.length + '件'
    + (failed.length ? ' / 失敗 ' + failed.length + '件' : ''));
  moved.forEach(m => Logger.log('  ' + m));
  failed.forEach(m => Logger.log('  ⚠ ' + m));

  if (!dry && MCFG.REPORT_TO && (moved.length || failed.length)) {
    GmailApp.sendEmail(MCFG.REPORT_TO,
      '【金消アプリ】' + moved.length + '件を' + nowMonth + 'へ繰り越し'
        + (failed.length ? ' / ' + failed.length + '件失敗' : ''),
      ['■ 金消予定日が空のまま残っとった案件を今月へ移したっちゃ',
        ...moved.map(m => '・' + m), '',
        ...(failed.length ? ['■ 移せんかった分', ...failed.map(m => '・' + m), ''] : []),
        '金消アプリ：https://iety0214-hub.github.io/axia-tools/AXIA_Kinsho.html'].join('\n'));
  }
  return { moved: moved, failed: failed };
}

/** 書き込まずに、繰り越される案件だけログに出す */
function carryOverKinshoTest() { carryOverKinsho(true); }
