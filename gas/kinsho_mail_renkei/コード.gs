/**
 * ============================================================
 *  AXIA 金消アプリ ／ 本承認メール自動連携
 * ------------------------------------------------------------
 *  Gmail に届く「【本承認】〜」の報告メールを読み取り、
 *  金消予定日一覧アプリ（Supabase）の「承認日」を自動で埋める。
 *
 *  - 30分おきに実行（トリガーで設定）
 *  - 処理済みメールにはラベルを付けて二重反映を防ぐ
 *  - 該当行が無い／曖昧な場合は反映せず、まとめてメール通知
 * ============================================================
 */

/* ===== 設定（ここだけ触ればよか） ===== */
const CFG = {
  SUPABASE_URL: 'https://zrqdoorolwvjlwuatlkc.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpycWRvb3JvbHd2amx3dWF0bGtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxODYwMDksImV4cCI6MjA5Mzc2MjAwOX0.TMdTX0a3c7weNqgmW_IrRGlnV7VfWeAZrktc5M5qh98',
  TABLE: 'axia_kinsho',
  STABLE: 'axia_kinsho_settings',

  // Gmail検索条件。過去何日分を対象にするか
  SEARCH_DAYS: 30,

  // 業務部からの報告メールの差出人。空にすると差出人を問わない
  // 誤爆が起きるようなら 'j.fukaya.jp@gmail.com' 等を入れて絞る
  FROM: '',

  // Gmailの検索語。
  // 件名は人が編集できるので、Gmail builder が必ず出力する本文の
  // 固定文字列「【種別】本承認」で絞る。これが一番形が安定しとる。
  QUERY: '"【種別】本承認"',

  // 上のQUERYで取りこぼす場合の予備の検索語。
  // diagnose を流すと両方の件数を比べて出すけん、少ない方に気づける。
  QUERY_FALLBACK: '"本承認"',

  // 処理済みの目印に付けるラベル
  LABEL_DONE: '金消連携/反映済み',
  LABEL_SKIP: '金消連携/未マッチ',

  // 通知先（未マッチがあった時だけ届く）
  NOTIFY_TO: '',

  // true にすると、すでに承認日が入っとっても上書きする
  OVERWRITE: false,

  // true にすると書き込みをせずログだけ出す（初回テスト用）
  DRY_RUN: false,
};

/* ===== メイン ===== */
function syncApprovalMails() {
  const settings = fetchSettings();
  const keys = resolveFieldKeys(settings);
  if (!keys.approval) throw new Error('「承認」を含む項目が設定に見つからん。アプリの設定画面を確認して。');

  const rows = fetchRows();
  const threads = GmailApp.search(buildQuery(''));
  const seen = loadSeen();          // 処理済みメッセージIDの記録

  const done = [];
  const skipped = [];
  let scanned = 0;

  // スレッドではなくメッセージ単位で処理する。
  // Gmailは同じ件名のメールを1スレッドに束ねるため、
  // スレッド単位で判定すると同じ物件の別号室が取りこぼされる。
  threads.forEach(th => {
    th.getMessages().forEach(msg => {
      const id = msg.getId();
      if (seen[id]) return;

      const parsed = parseMail(msg.getPlainBody());
      if (!parsed || parsed['種別'] !== '本承認') { seen[id] = 'skip:種別'; return; }
      scanned++;

      const approvalDate = Utilities.formatDate(msg.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');
      const hit = matchRow(rows, parsed);

      if (!hit.row) {
        skipped.push({ reason: hit.reason, mail: parsed, date: approvalDate, subject: msg.getSubject() });
        Logger.log(`未マッチ: [${parsed['物件名']}] [${parsed['号室']}] [${parsed['顧客名']}] → ${hit.reason}`);
        return;   // 記録せず、次回また拾えるようにしておく
      }

      const field = settings.fields.find(f => f.key === keys.approval);
      const current = (hit.row.fields || {})[keys.approval];
      if (!CFG.OVERWRITE && hasValue(field, current)) {
        Logger.log(`手入力済みのためスキップ: ${parsed['物件名']} ${parsed['号室']} ${parsed['顧客名']}`);
        seen[id] = 'skip:手入力済み';
        return;
      }

      const newFields = Object.assign({}, hit.row.fields || {});
      newFields[keys.approval] = buildValue(field, approvalDate);

      if (!CFG.DRY_RUN) {
        patchRow(hit.row.id, { fields: newFields });
        seen[id] = 'done:' + approvalDate;
      }
      hit.row.fields = newFields;   // 同一実行内の再照合用
      done.push({ mail: parsed, date: approvalDate });
      Logger.log(`反映: ${parsed['物件名']} ${parsed['号室']} ${parsed['顧客名']} → ${approvalDate}` + (hit.reason ? `  ※${hit.reason}` : ''));
    });
  });

  if (!CFG.DRY_RUN) saveSeen(seen);
  Logger.log(`完了 — 本承認メール ${scanned}通を確認 ／ 反映 ${done.length}件 ／ 未マッチ ${skipped.length}件`);
  if (skipped.length) notifySkipped(skipped);
  return { done: done.length, skipped: skipped.length };
}

/* ===== 処理済みメッセージの記録 =====
 * Gmailラベルはスレッド単位でしか付けられんので、
 * メッセージ単位の管理はスクリプトプロパティで行う。
 */
const SEEN_KEY = 'processedMessageIds';

function loadSeen() {
  const raw = PropertiesService.getScriptProperties().getProperty(SEEN_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function saveSeen(seen) {
  // 肥大化を防ぐため直近1000件だけ残す
  const keys = Object.keys(seen);
  if (keys.length > 1000) {
    const trimmed = {};
    keys.slice(-1000).forEach(k => { trimmed[k] = seen[k]; });
    seen = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty(SEEN_KEY, JSON.stringify(seen));
}

/* ===== 処理済み記録をリセットして最初からやり直す ===== */
function clearProcessed() {
  PropertiesService.getScriptProperties().deleteProperty(SEEN_KEY);
  Logger.log('処理済みの記録を消したばい。次の実行で全メールを見直す');
}

/* ===== Gmail検索クエリの組み立て ===== */
function buildQuery(extra, queryOverride) {
  const parts = [queryOverride || CFG.QUERY, `newer_than:${CFG.SEARCH_DAYS}d`];
  if (CFG.FROM) parts.push(`from:${CFG.FROM}`);
  if (extra) parts.push(extra);
  return parts.join(' ');
}

/* ===== メール解析 ===== */
/**
 * 「【項目名】値」を全部拾って辞書にする。
 * ・1行に複数の【項目】が並んどっても分解する
 * ・同じ項目名が複数出てきたら「最初のもの」を採用する
 *   （引用返信で前のメールの内容がぶら下がることがあるため）
 * ・引用行（> で始まる行）は無視する
 */
function parseMail(body) {
  if (!body) return null;
  const out = {};

  // 引用部分を落とす
  const lines = String(body).split(/\r?\n/).filter(l => !/^\s*[>｜|]/.test(l));
  // 署名やフッターより後ろは見ない
  const cut = lines.findIndex(l => /^\s*--\s*$/.test(l) || /Google グループ/.test(l));
  const text = (cut >= 0 ? lines.slice(0, cut) : lines).join('\n');

  // 【項目】値 を順に拾う。値は次の【が現れるまで
  const re = /【([^】]+)】\s*([^【\n]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const k = m[1].trim();
    const v = m[2].trim().replace(/[。\s]+$/, '');
    if (!(k in out)) out[k] = v;   // 先勝ち
  }
  return Object.keys(out).length ? out : null;
}

/* ===== 照合 ===== */
function matchRow(rows, mail) {
  const mProp = mail['物件名'];
  const mRoom = normRoom(mail['号室']);
  const mName = mail['顧客名'];
  if (!normProp(mProp)) return { row: null, reason: '物件名が読み取れんかった' };

  // 全行に対して「物件名の近さ」を採点する
  const scored = rows
    .map(r => ({ row: r, score: propScore(r._flat.prop, mProp) }))
    .filter(x => x.score > 0);

  if (!scored.length) return { row: null, reason: `物件名が一致する行がなかった（メール:${mProp}）` };

  // 最も物件名が近いグループに絞る
  const best = Math.max.apply(null, scored.map(x => x.score));
  let cands = scored.filter(x => x.score === best).map(x => x.row);

  // 号室で絞る（メール側に号室がある場合のみ）
  // アプリ側の号室が空欄の行は判定材料が無いので候補に残す
  if (mRoom) {
    const byRoom = cands.filter(r => {
      const rr = normRoom(r._flat.room);
      return !rr || rr === mRoom;
    });
    if (!byRoom.length) {
      return {
        row: null,
        reason: `物件は一致したが号室${mail['号室']}の行がなかった（アプリの号室:${cands.map(c => c._flat.room || '空').join('／')}）`
      };
    }
    cands = byRoom;
  }

  // 名前で絞る
  if (normName(mName)) {
    const byName = cands.filter(r => nameMatches(r.name, mName));
    if (!byName.length) {
      return {
        row: null,
        reason: `物件は一致したが「${mName}」の行がなかった（アプリの名前:${cands.map(c => c.name || '空').join('／')}）`
      };
    }
    cands = byName;
  }

  if (cands.length > 1) {
    return {
      row: null,
      reason: `候補が${cands.length}件あって特定できんかった（${cands.map(c => `${c.name}/${c._flat.room}`).join('　')}）`
    };
  }

  const only = cands[0];
  const notes = [];
  if (best < 1) notes.push(`物件名は類似一致（スコア${best.toFixed(2)}）`);
  if (mRoom && !normRoom(only._flat.room)) notes.push(`アプリ側の号室が空欄`);
  if (!normName(mName)) notes.push(`メール側の顧客名が空`);
  return { row: only, reason: notes.join('／') };
}

/* ===== 正規化 ===== */
// 姓によく出る異体字を統一する（メールとアプリで表記が割れるため）
const VARIANTS = {
  '﨑': '崎', '嶋': '島', '髙': '高', '濵': '浜', '濱': '浜', '邊': '辺', '邉': '辺',
  '齋': '斎', '齊': '斉', '澤': '沢', '瀨': '瀬', '眞': '真', '槗': '橋', '橳': '橋',
  '國': '国', '藪': '薮', '冨': '富', '曻': '昇', '德': '徳', '祐': '祐', '禮': '礼',
};
function unifyVariants(s) {
  return String(s).replace(/[^\u0000-\u00ff]/g, c => VARIANTS[c] || c);
}

// 全角英数→半角、空白除去、小文字化、異体字統一
function norm(s) {
  if (!s) return '';
  return unifyVariants(String(s))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　]/g, '')
    .replace(/[‐‑‒–—―ー−]/g, '-')
    .toLowerCase();
}
/**
 * 物件名の正規化。
 * 大文字小文字・全角半角・スペース・ハイフン・中黒・括弧の揺れを全部潰す。
 *   「AXIA M-City大阪加賀屋」「AXIA M-CITY 大阪加賀屋」「ＡＸＩＡ Ｍ-Ｃｉｔｙ大阪加賀屋」
 *   → いずれも "axiamcity大阪加賀屋"
 */
function normProp(s) {
  if (!s) return '';
  let v = unifyVariants(String(s));
  // 全角英数・全角記号 → 半角
  v = v.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 半角カナ → 全角カナ
  v = halfKanaToFull(v);
  // 区切り記号・空白の類を全部除去
  v = v.replace(/[\s　]/g, '')
       .replace(/[-‐‑‒–—―−ー－ｰ]/g, '')
       .replace(/[・･.,、。･]/g, '')
       .replace(/[()（）\[\]［］{}｛｝「」『』【】〔〕]/g, '')
       .replace(/[\/／\\＼|｜_＿&＆＋+]/g, '');
  return v.toLowerCase();
}

// 半角カナを全角に直す
const HK = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const FK = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
function halfKanaToFull(s) {
  return String(s)
    .replace(/([ｦ-ﾝ])ﾞ/g, (m, c) => {
      const i = HK.indexOf(c);
      return i < 0 ? m : String.fromCharCode(FK.charCodeAt(i) + 1);
    })
    .replace(/([ﾊﾋﾌﾍﾎ])ﾟ/g, (m, c) => {
      const i = HK.indexOf(c);
      return i < 0 ? m : String.fromCharCode(FK.charCodeAt(i) + 2);
    })
    .replace(/[ｦ-ﾝ]/g, c => {
      const i = HK.indexOf(c);
      return i < 0 ? c : FK[i];
    });
}

/**
 * 物件名の一致判定。
 * 1. 正規化して完全一致
 * 2. どちらかがどちらかを含む（「AXIA M-City大阪加賀屋」と「M-City大阪加賀屋」等）
 * 3. 編集距離での類似度が閾値以上（軽微な誤字・脱字を吸収）
 * 戻り値は 0〜1 のスコア。0 は不一致。
 */
function propScore(a, b) {
  const x = normProp(a), y = normProp(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 短すぎる文字列での部分一致は誤爆するので4文字以上を条件にする
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return 0.95;
  const sim = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return sim >= 0.85 ? sim : 0;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 号室の正規化。
 * 「303」「303号室」「702.」「－」「なし」などの揺れを吸収し、
 * 英数字だけを残す。値が無い扱いのものは空文字にする。
 */
function normRoom(s) {
  if (!s) return '';
  const v = norm(s).replace(/[^0-9a-z]/g, '');
  return v;
}
// 敬称・肩書きを落とす
function normName(s) {
  return norm(s).replace(/(様|さま|さん|氏|殿)$/, '');
}

/**
 * 名前の一致判定。
 * メール側は「岩崎様」のように姓だけのことがあり、
 * アプリ側は「岩﨑 冬瑠」とフルネームで入っとる。
 * よって「どちらかがどちらかを含んどれば一致」とみなす。
 */
function nameMatches(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return true;            // 片方が空なら判定材料なし＝通す
  return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0 || x.includes(y) || y.includes(x);
}

/* ===== 値の組み立て（項目の型に合わせる） ===== */
function buildValue(field, ymd) {
  if (!field) return ymd;
  if (field.type === 'datetime') return { d: ymd, t: '', none: false };
  return ymd; // date / text はそのまま
}
function hasValue(field, v) {
  if (field && field.type === 'datetime') {
    const o = (v && typeof v === 'object') ? v : {};
    return !!o.d || !!o.none;
  }
  return !!(v && String(v).length);
}

/* ===== 設定から項目キーを特定 ===== */
function resolveFieldKeys(settings) {
  const find = (re) => {
    const f = (settings.fields || []).find(x => re.test(x.label || ''));
    return f ? f.key : null;
  };
  return {
    approval: find(/承認/),
    prop: find(/物件/),
    room: find(/号室|部屋/),
    bank: find(/銀行|金融機関/),
  };
}

/* ===== Supabase ===== */
function sbFetch(path, options) {
  const opt = Object.assign({
    muteHttpExceptions: true,
    headers: {
      apikey: CFG.SUPABASE_KEY,
      Authorization: 'Bearer ' + CFG.SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
  }, options || {});
  const res = UrlFetchApp.fetch(CFG.SUPABASE_URL + '/rest/v1/' + path, opt);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error(`Supabase ${code}: ${res.getContentText()}`);
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : null;
}

function fetchSettings() {
  const d = sbFetch(`${CFG.STABLE}?id=eq.1&select=settings`);
  if (!d || !d.length) throw new Error('設定が取得できんかった');
  return d[0].settings;
}

function fetchRows() {
  const rows = sbFetch(`${CFG.TABLE}?select=*`);
  const settings = fetchSettings();
  const keys = resolveFieldKeys(settings);
  // 照合しやすいように物件名・号室を平坦化して持たせる
  rows.forEach(r => {
    const f = r.fields || {};
    r._flat = {
      prop: keys.prop ? f[keys.prop] : '',
      room: keys.room ? f[keys.room] : '',
    };
  });
  return rows;
}

function patchRow(id, patch) {
  sbFetch(`${CFG.TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'patch',
    payload: JSON.stringify(patch),
  });
}

/* ===== Gmailラベル ===== */
function labelThread(thread, name) {
  if (CFG.DRY_RUN) return;
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  thread.addLabel(label);
}

/* ===== 未マッチ通知 ===== */
function notifySkipped(list) {
  const lines = list.map(s =>
    `・${s.mail['物件名'] || '(物件名なし)'} ${s.mail['号室'] || ''}／${s.mail['顧客名'] || ''}\n` +
    `　承認日：${s.date}　理由：${s.reason}`
  ).join('\n\n');

  const body =
    `金消アプリへの自動反映で、${list.length}件が反映できませんでした。\n` +
    `アプリを開いて手入力してください。\n\n${lines}\n\n` +
    `アプリ：https://iety0214-hub.github.io/axia-tools/AXIA_Kinsho.html\n\n` +
    `※ 該当メールには「${CFG.LABEL_SKIP}」ラベルが付いています。\n` +
    `　 行を作ってから再反映したい場合は、そのラベルを外すと次回また拾います。`;
  if (!CFG.NOTIFY_TO) return;  // 通知先が空なら送らない
  GmailApp.sendEmail(CFG.NOTIFY_TO, `【金消アプリ】自動反映できんかった案件 ${list.length}件`, body);
}

/* ===== 初回セットアップ：30分おきのトリガーを作る ===== */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncApprovalMails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncApprovalMails').timeBased().everyMinutes(30).create();
  Logger.log('30分おきのトリガーを作成したばい');
}

/* ===== 動作確認用：書き込みせずログだけ出す ===== */
function dryRun() {
  const bak = CFG.DRY_RUN;
  CFG.DRY_RUN = true;
  try { syncApprovalMails(); } finally { CFG.DRY_RUN = bak; }
}


/* ============================================================
 *  診断ツール（書き込みもラベル付けもせん）
 *  メール側とアプリ側の値を突き合わせて、どこで外れとるか見る
 * ============================================================ */
function diagnose() {
  const settings = fetchSettings();
  const keys = resolveFieldKeys(settings);

  Logger.log('===== アプリ側の項目 =====');
  (settings.fields || []).forEach(f => Logger.log(`  ${f.label} (key=${f.key}, type=${f.type})`));
  Logger.log(`  → 承認日として使う項目: ${keys.approval}`);
  Logger.log(`  → 物件名の項目: ${keys.prop} ／ 号室の項目: ${keys.room}`);

  const rows = fetchRows();
  Logger.log(`\n===== アプリ側の行（${rows.length}件） =====`);
  rows.forEach(r => {
    Logger.log(`  月:${r.month} 名前:[${r.name}] 物件:[${r._flat.prop}] 号室:[${r._flat.room}]`);
    Logger.log(`      正規化 → 物件:[${normProp(r._flat.prop)}] 号室:[${normRoom(r._flat.room)}] 名前:[${normName(r.name)}]`);
  });

  const q = buildQuery('');
  const threads = GmailApp.search(q);
  let msgCount = 0, honCount = 0, hitCount = 0;
  threads.forEach(th => { msgCount += th.getMessageCount(); });

  Logger.log(`\n===== メール側 =====`);
  Logger.log(`  検索条件: ${q}`);
  Logger.log(`  ヒット: ${threads.length}スレッド ／ ${msgCount}通`);

  // 予備の検索語だと何通拾えるかを比較する（取りこぼしの検知用）
  if (CFG.QUERY_FALLBACK) {
    const fbThreads = GmailApp.search(buildQuery('', CFG.QUERY_FALLBACK));
    let fbHon = 0;
    fbThreads.forEach(th => th.getMessages().forEach(m => {
      const pp = parseMail(m.getPlainBody());
      if (pp && pp['種別'] === '本承認') fbHon++;
    }));
    let curHon = 0;
    threads.forEach(th => th.getMessages().forEach(m => {
      const pp = parseMail(m.getPlainBody());
      if (pp && pp['種別'] === '本承認') curHon++;
    }));
    Logger.log(`  参考）予備の検索語 ${CFG.QUERY_FALLBACK} なら本承認 ${fbHon}通 ／ 現行なら ${curHon}通`);
    if (fbHon > curHon) Logger.log(`  ※ 予備の方が多い。CFG.QUERY を '${CFG.QUERY_FALLBACK}' に変えた方がよかかも`);
  }

  threads.forEach(th => {
    th.getMessages().forEach(msg => {
      const p = parseMail(msg.getPlainBody());
      const d = Utilities.formatDate(msg.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (!p) { Logger.log(`  ${d} [解析不可] ${msg.getSubject()}`); return; }
      if (p['種別'] !== '本承認') {
        Logger.log(`  ${d} 種別:[${p['種別']}] → 本承認でないためスキップ`);
        return;
      }
      honCount++;
      Logger.log(`  ${d} 物件:[${p['物件名']}] 号室:[${p['号室']}] 名前:[${p['顧客名']}]`);
      Logger.log(`      正規化 → 物件:[${normProp(p['物件名'])}] 号室:[${normRoom(p['号室'])}] 名前:[${normName(p['顧客名'])}]`);
      const hit = matchRow(rows, p);
      if (hit.row) hitCount++;
      Logger.log(hit.row
        ? `      → 一致: ${hit.row.name} ${hit.row._flat.prop} ${hit.row._flat.room}${hit.reason ? '  ※' + hit.reason : ''}`
        : `      → 未マッチ: ${hit.reason}`);
    });
  });

  Logger.log(`\n===== まとめ =====`);
  Logger.log(`  本承認メール ${honCount}通 のうち ${hitCount}通 が一致、${honCount - hitCount}通 が未マッチ`);
  Logger.log('\n===== 診断おわり =====');
}

/* ===== 連携ラベルを全部外す（やり直したい時に使う） ===== */
function clearSyncLabels() {
  [CFG.LABEL_DONE, CFG.LABEL_SKIP].forEach(name => {
    const label = GmailApp.getUserLabelByName(name);
    if (!label) return;
    let n = 0;
    let threads = label.getThreads(0, 100);
    while (threads.length) {
      threads.forEach(t => t.removeLabel(label));
      n += threads.length;
      threads = label.getThreads(0, 100);
    }
    Logger.log(`${name} を ${n}件から外したばい`);
  });
}
