/**
 * Gmail → Slack #案件進捗 自動連携
 *
 *  ・【種別】申込   のメール → Slackに投稿
 *  ・【種別】オープン のメール → 該当する申込投稿を取り消し線に書き換え
 *  ・「訂正」「誤り」と書かれた申込メール → 訂正前の投稿を取り消し線にして、訂正後を投稿
 *
 * セットアップ:
 *   1) 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」に
 *        SLACK_BOT_TOKEN = xoxb-...   を登録する（コードには書かない）
 *   2) Slackの #案件進捗 に Moshikomi Notify アプリを追加しておく
 *   3) dryRun() で確認 → markExistingAsDone() → setupTrigger()
 */

// ===== 設定 =====
const SLACK_CHANNEL = 'C08P1PGLHT5';   // #案件進捗

// Botトークンはスクリプト プロパティから読む
function slackToken_() {
  return PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN') || '';
}

// 拾う範囲。グループ宛と自分宛の両方（テスト送信も拾えるように）
const MAIL_SCOPE = '{to:axia-japan@googlegroups.com to:me}';

// Slackに流す【種別】。['申込','契約'] のように増やせる
const TARGET_TYPES = ['申込'];

// 処理済みメールに付ける目印ラベル（Gmail上で見分ける用。判定には使わない）
const DONE_LABEL = 'Slack投稿済み';

// Slackに出す項目の順番
const ORDER = ['種別', '区分', '顧客名', '物件名', '号室', '銀行', '持込予定', '契約予定', '契約', '決済予定', '担当', '同行', '所属', '立会'];

// 見出し行にまとめる項目（本文側には出さない）
const TITLE_KEYS = ['種別', '区分', '顧客名'];

// 物件名・号室は連結して1行にするので、本文ループからは外す
const MERGED_KEYS = ['物件名', '号室'];

// 項目名を付けて出す項目。これ以外は値だけを出す（例: 銀行）
const LABELED_KEYS = ['持込予定', '契約予定', '契約', '決済予定', '担当', '同行', '所属', '立会'];

// 本文中のあいさつ文（ここに来たら項目パース終了）
const STOP_LINE = /^(よろしく|宜しく|お疲れ様|以上)/;

// 「未記入」とみなす値
const EMPTY_VALUES = ['ー', '－', '-', '―', '—', 'なし', '無し', '未定'];

// 投稿の記録を保持する日数（これを過ぎた申込はオープンで取り消せなくなる）
// Slackフリープランは90日より前のメッセージが非表示になるため、それに合わせている
const KEEP_DAYS = 90;

// 処理済みメールIDを覚えておく日数（検索範囲の3日より長ければよい）
const DONE_KEEP_DAYS = 10;

// 件名か、本文の【項目】より前のあいさつ部分にこの言葉があれば訂正メールとみなす
const CORRECTION_WORDS = /訂正|誤り|間違い|修正|差し替え|差替/;

// 訂正メールが差し替える申込投稿を探す期間（これより前の投稿は差し替えない）
const CORRECTION_WINDOW_DAYS = 3;


// ===== トリガーから呼ばれる本体 =====
function runSync() {
  processApplications_();
  processOpens_();
  cleanupOldRecords_();
}


// ============================================================
//  1. 申込メール → Slack投稿
// ============================================================
function processApplications_() {
  const label = getOrCreateLabel_(DONE_LABEL);
  const query = MAIL_SCOPE + ' subject:【申込】 newer_than:3d';

  eachNewMessage_(query, function (msg) {
    const body = msg.getPlainBody();
    const fields = parseBody_(body);
    if (!isTargetType_(fields)) return;

    // 訂正メールなら、差し替える前の投稿を探しておく
    const corrected = isCorrectionMail_(msg.getSubject(), body);
    const old = corrected ? findPostForCorrection_(fields, msg) : null;

    const res = slackApi_('chat.postMessage', {
      channel: SLACK_CHANNEL,
      text: headerTextOf_(fields) + (corrected ? '（訂正）' : ''),
      blocks: corrected ? buildCorrectedBlocks_(fields, msg, old) : buildBlocks_(fields, msg),
      unfurl_links: false,   // Gmailリンクのプレビューを出さない
      unfurl_media: false
    });
    rememberPost_(fields, res.ts, msg);
    Utilities.sleep(1100);   // Slackのレート制限（1秒1件）対策

    if (old) strikeCorrectedPost_(old, res.ts, msg, body);
  }, label);
}


// 訂正前の投稿を取り消し線にして、訂正後の投稿へのリンクを付ける
function strikeCorrectedPost_(old, newTs, msg, body) {
  try {
    slackApi_('chat.update', {
      channel: SLACK_CHANNEL,
      ts: old.ts,
      text: '【訂正前】' + old.header,
      blocks: buildSupersededBlocks_(old, newTs, msg),
      attachments: []
    });
  } catch (e) {
    notify_(msg, body,
      '⚠️ *訂正メールを受信しましたが、訂正前の投稿「' + old.header + '」を書き換えられませんでした*\n' +
      '（理由: ' + e.message + '）手動で対応をお願いします。');
  }
  // 訂正前の投稿は、あとでオープンメールが来ても取り消し対象にしない
  forgetPost_(old.ts);
  Utilities.sleep(1100);
}


// ============================================================
//  2. オープンメール → 該当投稿を取り消し線に
// ============================================================
function processOpens_() {
  const label = getOrCreateLabel_(DONE_LABEL);
  const query = MAIL_SCOPE + ' subject:オープン newer_than:3d';

  eachNewMessage_(query, function (msg) {
    const body = msg.getPlainBody();
    if (!isOpenMail_(body)) return;   // 物件振替・物件確定はここで弾く

    const hits = findPostsForOpen_(body);

    if (hits.length === 0) {
      notify_(msg, body,
        '⚠️ *オープンメールを受信しましたが、対応する申込投稿が見つかりませんでした*\n' +
        '手動で確認をお願いします。');
      return;
    }

    hits.forEach(function (rec) {
      try {
        slackApi_('chat.update', {
          channel: SLACK_CHANNEL,
          ts: rec.ts,
          text: '【取消】' + rec.header,
          blocks: buildCancelBlocks_(rec, msg),
          attachments: []   // リンクのプレビューが付いていたら消す
        });
      } catch (e) {
        notify_(msg, body,
          '⚠️ *オープンメールを受信しましたが、申込投稿「' + rec.header + '」を書き換えられませんでした*\n' +
          '（投稿が古すぎる等。理由: ' + e.message + '）手動で対応をお願いします。');
      }
      forgetPost_(rec.ts);
      Utilities.sleep(1100);
    });
  }, label);
}


// 検索に当たったメールのうち、まだ処理していない1通1通に handler を適用する。
// 処理済みかどうかはメールIDで判定する（スレッド単位だと同じ件名のメールが
// 1つのスレッドにまとめられて2通目以降を取りこぼすため）。
// 届いた順（古い順）に処理する。元の申込と訂正メールが同じ回に拾われても、
// 先に元の申込を投稿してから訂正で差し替えられるようにするため。
function eachNewMessage_(query, handler, label) {
  const props = PropertiesService.getScriptProperties();
  const pending = [];

  GmailApp.search(query, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      if (props.getProperty('done_' + msg.getId())) return;
      pending.push({ msg: msg, thread: thread });
    });
  });

  pending.sort(function (a, b) { return a.msg.getDate() - b.msg.getDate(); });

  pending.forEach(function (p) {
    handler(p.msg);
    props.setProperty('done_' + p.msg.getId(), String(new Date().getTime()));
    if (label) p.thread.addLabel(label);
  });
}


function notify_(msg, body, lead) {
  slackApi_('chat.postMessage', {
    channel: SLACK_CHANNEL,
    unfurl_links: false,
    unfurl_media: false,
    text: lead.replace(/\*/g, ''),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lead + '\n\n```' + trimBody_(body) + '```' } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: msg.getFrom() + '　|　' + fmtDate_(msg.getDate()) + '　|　<' + mailLink_(msg) + '|Gmailで開く>'
        }]
      }
    ]
  });
}


// オープンメールかどうか。【種別】or【種類】行に「オープン」が入っていれば対象。
// 「物件振替」「物件確定」だけのメールは対象外。
function isOpenMail_(body) {
  const m = body.match(/【種[類別]】\s*(.*)/);
  if (!m) return false;
  return m[1].indexOf('オープン') !== -1;
}


// オープンメール本文から、取り消すべき申込投稿を探す。
//   1) 新フォーマット：【物件名】＋【号室】のキーが完全一致
//   2) 旧フォーマット：本文のどこかに「物件名＋号室」が含まれる（号室ありキーのみ）
//   3) 複数ヒットしたときは【顧客名】で絞り込む
//   ※【物件名】が未定のときは、物件未定の申込投稿を【顧客名】で探す
function findPostsForOpen_(body) {
  const fields = parseBody_(body);
  if (isUndecidedProperty_(fields)) return findUndecidedPostsByCustomer_(fields);
  const openKeys = matchKeysOf_(fields);
  const haystack = normalize_(body);
  const props = PropertiesService.getScriptProperties().getProperties();
  const seen = {};
  let hits = [];

  Object.keys(props).forEach(function (key) {
    if (key.indexOf('post_') !== 0) return;

    let rec;
    try { rec = JSON.parse(props[key]); } catch (e) { return; }
    if (!rec.keys || !rec.ts || seen[rec.ts]) return;

    const matched = rec.keys.some(function (k) {
      if (openKeys.indexOf(k) !== -1) return true;              // 完全一致
      if (!/\d/.test(k) || k.length < 6) return false;          // 号室なし・短すぎるキーは包含判定に使わない
      return haystack.indexOf(k) !== -1;                        // 旧フォーマット救済
    });

    if (matched) {
      seen[rec.ts] = true;
      hits.push(rec);
    }
  });

  // 同じ物件・号室で複数の申込が生きている場合は顧客名で絞る
  if (hits.length > 1) {
    const who = customerKey_(get_(fields, '顧客名'));
    if (who) {
      const narrowed = hits.filter(function (rec) { return rec.customer === who; });
      if (narrowed.length > 0) hits = narrowed;
    }
  }

  return hits;
}


// 物件未定のオープンメール用：物件未定の申込投稿を顧客名で探す。
//   ・フルネームが一致する投稿を優先（「佐藤 将様」と「佐藤将様」は同じ）
//   ・なければ「佐藤様」のような姓だけの書き方も同じ人とみなす
//     ただし別人（佐藤将／佐藤健）が複数当たったときは取り消さず、手動確認に回す
function findUndecidedPostsByCustomer_(fields) {
  const name = nameKey_(get_(fields, '顧客名'));
  if (!name) return [];

  const props = PropertiesService.getScriptProperties().getProperties();
  const exact = [];
  const partial = [];

  Object.keys(props).forEach(function (key) {
    if (key.indexOf('post_') !== 0) return;
    let rec;
    try { rec = JSON.parse(props[key]); } catch (e) { return; }
    if (!rec.ts || !isUndecidedRecord_(rec)) return;

    const recName = rec.name || nameKey_((rec.raw || {})['顧客名']);
    if (!recName) return;
    if (recName === name) exact.push(rec);
    else if (recName.indexOf(name) === 0 || name.indexOf(recName) === 0) partial.push(rec);
  });

  if (exact.length > 0) return exact;
  const names = {};
  partial.forEach(function (rec) { names[rec.name || nameKey_((rec.raw || {})['顧客名'])] = true; });
  return Object.keys(names).length === 1 ? partial : [];
}

// 保存してある申込投稿が物件未定のものか
// （古い記録では「物件未定」がそのまま照合キーに入っていることがある）
function isUndecidedRecord_(rec) {
  return (rec.keys || []).every(function (k) {
    return UNDECIDED_VALUES.indexOf(k) !== -1;
  });
}


// 訂正メールかどうか。件名か、本文の最初の【項目】より前のあいさつ部分で判定する
// （【備考】などに「修正」とあっても訂正扱いにしないため）。
function isCorrectionMail_(subject, body) {
  const lead = body.split(/\r?\n/).reduce(function (acc, line) {
    if (acc.stop || /^\s*【/.test(line)) return { text: acc.text, stop: true };
    return { text: acc.text + line + '\n', stop: false };
  }, { text: '', stop: false }).text;
  return CORRECTION_WORDS.test(subject) || CORRECTION_WORDS.test(lead);
}


// 訂正メールが差し替える申込投稿を探す。
//   ・同じ顧客名（「飯田 健太郎様」と「飯田健太郎様」、「飯田様」も同じ人とみなす）
//   ・訂正メールより前、CORRECTION_WINDOW_DAYS 日以内に投稿したもの
//   ・同じ送信者の投稿があればそちらを優先
//   ・候補が複数あれば一番新しいもの（直前に送った誤りメール）
function findPostForCorrection_(fields, msg) {
  const name = nameKey_(get_(fields, '顧客名'));
  if (!name) return null;

  const mailAt = msg.getDate().getTime();
  const from = senderOf_(msg);
  const limit = mailAt - CORRECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const props = PropertiesService.getScriptProperties().getProperties();
  let hits = [];

  Object.keys(props).forEach(function (key) {
    if (key.indexOf('post_') !== 0) return;
    let rec;
    try { rec = JSON.parse(props[key]); } catch (e) { return; }

    const postedAt = rec.mailAt || rec.savedAt;
    if (!rec.ts || !postedAt || postedAt < limit || postedAt > mailAt) return;

    const recName = rec.name || nameKey_((rec.raw || {})['顧客名']);
    if (!recName) return;
    if (recName !== name && recName.indexOf(name) !== 0 && name.indexOf(recName) !== 0) return;

    hits.push(rec);
  });

  if (from) {
    const same = hits.filter(function (rec) { return rec.from === from; });
    if (same.length > 0) hits = same;
  }

  hits.sort(function (a, b) { return (b.mailAt || b.savedAt) - (a.mailAt || a.savedAt); });
  return hits[0] || null;
}


// ============================================================
//  投稿内容の組み立て
// ============================================================
function headerTextOf_(fields) {
  return ['【申込】', get_(fields, '区分'), get_(fields, '顧客名')]
    .filter(String).join(' ');
}

function detailTextOf_(fields) {
  const lines = propertyLines_(fields);

  ORDER.forEach(function (key) {
    if (TITLE_KEYS.indexOf(key) !== -1) return;
    if (MERGED_KEYS.indexOf(key) !== -1) return;
    const value = get_(fields, key);
    if (!value) return;
    lines.push(LABELED_KEYS.indexOf(key) !== -1 ? key + '　' + value : value);
  });

  return lines.join('\n');
}

// 物件名と号室をつないで「AXIA CITY神戸松原301」の形にする。
// 物件名欄にすでに号室が書いてある場合や、数が合わない場合はそのまま出す。
function propertyLines_(fields) { if (isUndecidedProperty_(fields)) return undecidedLines_(fields);
  const buildings = splitBuildings_(get_(fields, '物件名'));
  const rooms = splitRooms_(get_(fields, '号室'));
  if (buildings.length === 0) return rooms.length ? ['号室　' + rooms.join(' ')] : [];

  const hasEmbeddedRoom = buildings.some(function (b) {
    return /\d{2,5}\s*号室?\s*$/.test(b);
  });
  if (hasEmbeddedRoom || rooms.length === 0) return buildings;

  if (buildings.length === rooms.length) {
    return buildings.map(function (b, i) { return b + rooms[i]; });
  }
  if (buildings.length === 1) {
    return rooms.map(function (r) { return buildings[0] + r; });
  }
  return buildings.concat(['号室　' + rooms.join(' ')]);
}

function buildBlocks_(fields, msg) {
  return [
    { type: 'header', text: { type: 'plain_text', text: headerTextOf_(fields), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: detailTextOf_(fields) || trimBody_(msg.getPlainBody()) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '送信: ' + msg.getFrom() +
              '　|　' + fmtDate_(msg.getDate()) +
              '　|　<' + mailLink_(msg) + '|Gmailで開く>'
      }]
    }
  ];
}

// 訂正後の投稿。訂正前から変わった行を太字にし、訂正前の投稿へのリンクを付ける
function buildCorrectedBlocks_(fields, msg, old) {
  const oldLines = old ? (old.detail || '').split('\n') : null;
  const detail = detailTextOf_(fields);
  const marked = detail && oldLines ? detail.split('\n').map(function (line) {
    return line && oldLines.indexOf(line) === -1 ? '*' + line + '*' : line;
  }).join('\n') : detail;

  const note = old
    ? '✏️ *訂正版です*（太字が訂正箇所）　|　<' + postLink_(old.ts) + '|訂正前の投稿>'
    : '✏️ *訂正版です*（訂正前の投稿は見つかりませんでした。古い投稿があれば手動で消してください）';

  return [
    { type: 'header', text: { type: 'plain_text', text: headerTextOf_(fields) + '（訂正）', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: marked || trimBody_(msg.getPlainBody()) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: note +
              '\n送信: ' + msg.getFrom() +
              '　|　' + fmtDate_(msg.getDate()) +
              '　|　<' + mailLink_(msg) + '|Gmailで開く>'
      }]
    }
  ];
}

// 訂正で差し替えられた投稿（取り消し線＋訂正後へのリンク）
function buildSupersededBlocks_(old, newTs, correctionMsg) {
  return [
    supersededTitleBlock_(old.header),
    { type: 'section', text: { type: 'mrkdwn', text: strike_(old.detail) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '✏️ *' + fmtDate_(correctionMsg.getDate()) + ' 訂正メールにより差し替え*' +
              '　|　<' + postLink_(newTs) + '|訂正後の投稿を見る>' +
              '　|　<' + mailLink_(correctionMsg) + '|訂正メールを開く>'
      }]
    }
  ];
}

// header ブロックは書式が使えず取り消し線を引けないので、太字＋取り消し線の section にする
function supersededTitleBlock_(header) {
  return { type: 'section', text: { type: 'mrkdwn', text: '✏️ *~' + header + '~* （訂正前・誤り）' } };
}

function strike_(text) {
  return (text || '').split('\n').map(function (line) {
    return line ? '~' + line + '~' : line;
  }).join('\n');
}

// 取り消し線バージョン
function buildCancelBlocks_(rec, openMsg) {
  const struck = (rec.detail || '').split('\n').map(function (line) {
    return line ? '~' + line + '~' : line;
  }).join('\n');

  return [
    { type: 'header', text: { type: 'plain_text', text: '🚫 ' + rec.header + '（オープン）', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: struck } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '🚫 *' + fmtDate_(openMsg.getDate()) + ' オープンメールにより取消*' +
              '　|　' + openMsg.getFrom() +
              '　|　<' + mailLink_(openMsg) + '|オープンメールを開く>'
      }]
    }
  ];
}


// ============================================================
//  投稿の記録（オープン時に探せるように保存しておく）
// ============================================================
function rememberPost_(fields, ts, msg) {
  const record = {
    ts: ts,
    header: headerTextOf_(fields),
    detail: detailTextOf_(fields),
    keys: matchKeysOf_(fields),
    customer: customerKey_(get_(fields, '顧客名')),
    // 訂正メールで差し替え元を探すときに使う
    name: nameKey_(get_(fields, '顧客名')),
    from: msg ? senderOf_(msg) : '',
    mailAt: msg ? msg.getDate().getTime() : 0,
    // 表示形式を変えてもキーを作り直せるように、元の値も残しておく
    raw: {
      '物件名': get_(fields, '物件名'),
      '号室': get_(fields, '号室'),
      '顧客名': get_(fields, '顧客名')
    },
    savedAt: new Date().getTime()
  };
  PropertiesService.getScriptProperties().setProperty('post_' + ts, JSON.stringify(record));
}

function forgetPost_(ts) {
  PropertiesService.getScriptProperties().deleteProperty('post_' + ts);
}

// 「物件名＋号室」の照合キーを作る。
function matchKeysOf_(fields) { if (isUndecidedProperty_(fields)) return [];
  // 物件名は「 / 」「／」「、」「,」区切りのみ。空白で切ると
  // 「AXIA M-City大阪加賀屋」が割れてしまうので切らない
  let buildings = splitBuildings_(get_(fields, '物件名'));
  // 号室は「305 1104」のように空白区切りで複数入ることがある
  let rooms = splitRooms_(get_(fields, '号室'));

  // 「AXIA CITY神戸松原 201号室／AXIA CITY神戸松原 202号室」のように
  // 物件名欄に号室まで書いてある場合は、そこから号室を取り出す
  const embedded = buildings.map(function (b) {
    const m = b.match(/^(.*?)[\s　]*(\d{2,5})\s*号室?\s*$/);
    return m ? { name: m[1].trim(), room: m[2] } : { name: b, room: '' };
  });
  if (embedded.some(function (e) { return e.room; })) {
    buildings = embedded.map(function (e) { return e.name; });
    rooms = embedded.map(function (e, i) { return e.room || rooms[i] || ''; });
    const keys = [];
    buildings.forEach(function (b, i) {
      const nb = normalize_(b);
      if (nb) keys.push(nb + rooms[i]);
    });
    return keys;
  }

  const keys = [];

  // 物件と号室の数が揃っているなら、書かれた順に1対1で対応させる
  if (buildings.length > 1 && buildings.length === rooms.length) {
    buildings.forEach(function (b, i) {
      const nb = normalize_(b);
      if (nb) keys.push(nb + rooms[i]);
    });
    return keys;
  }

  // 揃っていないときは総当たりで作る（取りこぼすよりマシ）
  buildings.forEach(function (b) {
    const nb = normalize_(b);
    if (!nb) return;
    if (rooms.length === 0) {
      keys.push(nb);
    } else {
      rooms.forEach(function (r) { keys.push(nb + r); });
    }
  });
  return keys;
}

// 顧客名の照合キー。「佐々木 広明様」「佐々木様」→ 姓の部分だけ取り出す
function customerKey_(name) {
  const n = String(name || '').replace(/様|さん|殿/g, '').trim();
  if (!n) return '';
  const first = n.split(/[\s　]+/)[0];
  return normalize_(first);
}

// 顧客名の照合キー（フルネーム）。「飯田 健太郎様」「飯田健太郎様」→ 同じキーになる
function nameKey_(name) {
  return normalize_(String(name || '').replace(/様|さん|殿/g, ''));
}

// 送信者のメールアドレスだけ取り出す
function senderOf_(msg) {
  const from = String(msg.getFrom() || '');
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

// 古い記録を掃除（スクリプトプロパティを溜め込まない）
function cleanupOldRecords_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = new Date().getTime();
  const postLimit = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const doneLimit = now - DONE_KEEP_DAYS * 24 * 60 * 60 * 1000;

  Object.keys(all).forEach(function (key) {
    if (key.indexOf('post_') === 0) {
      try {
        const rec = JSON.parse(all[key]);
        if (!rec.savedAt || rec.savedAt < postLimit) props.deleteProperty(key);
      } catch (e) {
        props.deleteProperty(key);
      }
    } else if (key.indexOf('done_') === 0) {
      const t = Number(all[key]);
      if (!t || t < doneLimit) props.deleteProperty(key);
    }
  });
}


// ============================================================
//  本文パース
// ============================================================
function parseBody_(raw) {
  const body = raw.split(/\n--\s*\n|このメールは Google/)[0];
  const fields = {};
  let current = null;

  body.split(/\r?\n/).forEach(function (line) {
    const text = line.trim();
    if (text === '') return;

    if (STOP_LINE.test(text)) { current = null; return; }

    const m = text.match(/^【(.+?)】\s*(.*)$/);
    if (m) {
      current = m[1];
      if (!fields[current]) fields[current] = [];
      fields[current].push(m[2].trim());
      return;
    }

    if (current && fields[current].length > 0) {
      const arr = fields[current];
      arr[arr.length - 1] = (arr[arr.length - 1] + ' / ' + text).replace(/^ \/ /, '');
    }
  });

  return fields;
}

function isTargetType_(fields) {
  const shubetsu = ((fields['種別'] || [])[0] || '').trim();
  if (shubetsu === '') return false;
  return TARGET_TYPES.indexOf(shubetsu) !== -1;
}


// ============================================================
//  小道具
// ============================================================
function get_(fields, key) {
  return (fields[key] || []).filter(function (v) {
    return v !== '' && EMPTY_VALUES.indexOf(v.trim()) === -1;
  }).join(' / ');
}

function splitBuildings_(value) {
  return String(value || '').split(/\s*[\/／、,，]\s*/).map(function (v) {
    return v.trim();
  }).filter(String);
}

function splitRooms_(value) {
  return String(value || '').split(/[\s\/／、,，]+/).map(function (v) {
    const m = v.match(/\d+/);
    return m ? m[0] : '';
  }).filter(String);
}

// 比較用に、空白・記号を落として全角英数を半角にする
function normalize_(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[\s　\-ー－・]/g, '')
    .replace(/号室/g, '')
    .toLowerCase();
}

function trimBody_(body) {
  return body.split(/\n--\s*\n|このメールは Google/)[0].trim().slice(0, 2000);
}

function fmtDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'M/d HH:mm');
}

function mailLink_(msg) {
  return 'https://mail.google.com/mail/u/0/#all/' + msg.getId();
}

function postLink_(ts) {
  return 'https://slack.com/archives/' + SLACK_CHANNEL + '/p' + String(ts).replace('.', '');
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function slackApi_(method, payload) {
  const token = slackToken_();
  if (token.indexOf('xoxb-') !== 0) {
    throw new Error('スクリプト プロパティ SLACK_BOT_TOKEN が未設定です（プロジェクトの設定 → スクリプト プロパティ）');
  }
  const res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());
  if (!json.ok) throw new Error('Slack ' + method + ' 失敗: ' + json.error);
  return json;
}


// ============================================================
//  セットアップ / 確認用
// ============================================================

// 5分おきの自動実行をセットする
function setupTrigger() {
  // 旧バージョンのトリガー（postShinkomiToSlack など）も含めて全部消してから作り直す
  const old = ScriptApp.getProjectTriggers();
  old.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(5).create();
  Logger.log('古いトリガー ' + old.length + '件を削除し、5分おきの自動実行をセットしました');
}

// 初回だけ実行：今ある申込・オープンメールを処理済み扱いにして、過去分の一斉投稿を防ぐ
function markExistingAsDone() {
  const label = getOrCreateLabel_(DONE_LABEL);
  let n = 0;
  ['subject:【申込】', 'subject:オープン'].forEach(function (cond) {
    eachNewMessage_(MAIL_SCOPE + ' ' + cond + ' newer_than:3d', function () { n++; }, label);
  });
  Logger.log(n + '通を処理済み扱いにしました。以降に届く分だけSlackに流れます。');
}

// Slackには何も送らず、何がどう処理されるかだけログに出す
function dryRun() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('SLACK_BOT_TOKEN: ' + (slackToken_().indexOf('xoxb-') === 0 ? '設定済み' : '★未設定（プロジェクトの設定 → スクリプト プロパティ）'));
  Logger.log('');

  Logger.log('===== 申込メール（直近7日） =====');
  GmailApp.search(MAIL_SCOPE + ' subject:【申込】 newer_than:7d', 0, 10).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const done = props.getProperty('done_' + msg.getId()) ? '[処理済み] ' : '';
      const fields = parseBody_(msg.getPlainBody());
      const shubetsu = ((fields['種別'] || [])[0] || '(種別なし)').trim();
      if (!isTargetType_(fields)) {
        Logger.log(done + 'スキップ: 種別=' + shubetsu + ' / ' + msg.getSubject());
        return;
      }
      Logger.log(done + '投稿する: ' + headerTextOf_(fields));
      if (isCorrectionMail_(msg.getSubject(), msg.getPlainBody())) {
        const old = findPostForCorrection_(fields, msg);
        Logger.log('    ✏️ 訂正メール → 差し替える投稿: ' + (old ? old.header + ' (ts=' + old.ts + ')' : '見つからない'));
      }
      Logger.log('--- Slackでの見え方 ---\n' + headerTextOf_(fields) + '\n\n' + detailTextOf_(fields) + '\n-----------------------');
      Logger.log('    照合キー: ' + JSON.stringify(matchKeysOf_(fields)) +
                 ' / 顧客キー: ' + customerKey_(get_(fields, '顧客名')));
    });
  });

  Logger.log('');
  Logger.log('===== オープンメール（直近14日） =====');
  Logger.log('※「該当投稿」は runSync で実際に投稿した記録と照合します。まだ記録が無ければ0件になるのが正常です。');
  GmailApp.search(MAIL_SCOPE + ' subject:オープン newer_than:14d', 0, 10).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const done = props.getProperty('done_' + msg.getId()) ? '[処理済み] ' : '';
      const body = msg.getPlainBody();
      if (!isOpenMail_(body)) {
        Logger.log(done + 'スキップ(振替/確定): ' + msg.getSubject());
        return;
      }
      const hits = findPostsForOpen_(body);
      Logger.log(done + 'オープン検知: ' + fmtDate_(msg.getDate()) + ' / ' + msg.getSubject());
      Logger.log('    照合キー: ' + JSON.stringify(matchKeysOf_(parseBody_(body))));
      Logger.log('    → 該当投稿 ' + hits.length + '件 ' +
                 JSON.stringify(hits.map(function (h) { return h.header; })));
    });
  });
}

// 保存されている投稿記録を一覧表示する（デバッグ用）
function showRecords() {
  const props = PropertiesService.getScriptProperties().getProperties();
  let posts = 0, dones = 0;
  Object.keys(props).forEach(function (key) {
    if (key.indexOf('done_') === 0) { dones++; return; }
    if (key.indexOf('post_') !== 0) return;
    posts++;
    const rec = JSON.parse(props[key]);
    Logger.log(rec.header + ' / keys=' + JSON.stringify(rec.keys) +
               ' / customer=' + rec.customer + ' / ts=' + rec.ts);
  });
  Logger.log('投稿記録 ' + posts + '件 / 処理済みメール ' + dones + '通');
}

// 保存済みの投稿記録の照合キーを、今のロジックで作り直す
// （キーの作り方を変えたあとに1回だけ実行する。Slackには何も送らない）
function fixRecords() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let n = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('post_') !== 0) return;
    let rec;
    try { rec = JSON.parse(all[key]); } catch (e) { return; }

    // 保存してある元データからキーを作り直す。
    // raw が無い古い記録は、旧形式の detail（"*物件名*　AXIA..."）から拾う。
    const fields = {};
    if (rec.raw) {
      Object.keys(rec.raw).forEach(function (k) { fields[k] = [rec.raw[k]]; });
    } else {
      (rec.detail || '').split('\n').forEach(function (line) {
        const m = line.match(/^\*(.+?)\*　(.*)$/);
        if (m) fields[m[1]] = [m[2]];
      });
    }
    const before = JSON.stringify(rec.keys);
    rec.keys = matchKeysOf_(fields);
    rec.customer = customerKey_(get_(fields, '顧客名'));
    props.setProperty(key, JSON.stringify(rec));
    n++;
    Logger.log(rec.header + '  ' + before + ' → ' + JSON.stringify(rec.keys) + ' / ' + rec.customer);
  });
  Logger.log(n + '件の記録を更新しました');
}


// ============================================================
//  メンテナンス
// ============================================================

// 記録が残っている投稿から、Gmailリンクのプレビュー（展開）を消す
function removeUnfurls() {
  const props = PropertiesService.getScriptProperties().getProperties();
  let n = 0;
  Object.keys(props).forEach(function (key) {
    if (key.indexOf('post_') !== 0) return;
    const ts = key.slice(5);
    try {
      slackApi_('chat.update', { channel: SLACK_CHANNEL, ts: ts, attachments: [] });
      n++;
    } catch (e) {
      Logger.log('失敗 ts=' + ts + ': ' + e.message);
    }
    Utilities.sleep(1100);
  });
  Logger.log(n + '件のプレビューを消しました');
}

// Botが投稿したメッセージを消す。
// Slackで消したい投稿の「…」→「リンクをコピー」したURLを下に貼って、deleteListedPosts() を実行する。
const DELETE_LINKS = [
  // 'https://axia-japan.slack.com/archives/C08P1PGLHT5/p1758000000000000',
];

function deleteListedPosts() {
  let n = 0;
  DELETE_LINKS.forEach(function (link) {
    const m = String(link).match(/\/p(\d{10})(\d{6})/);
    if (!m) { Logger.log('リンクの形式が違います: ' + link); return; }
    const ts = m[1] + '.' + m[2];
    try {
      slackApi_('chat.delete', { channel: SLACK_CHANNEL, ts: ts });
      forgetPost_(ts);
      n++;
      Logger.log('削除: ' + ts);
    } catch (e) {
      Logger.log('削除失敗 ' + ts + ': ' + e.message);
    }
    Utilities.sleep(1100);
  });
  Logger.log(n + '件削除しました');
}

// 自動で差し替えられなかった訂正を手で直す。
// [訂正前の投稿のリンク, 訂正後の投稿のリンク] の組を貼って、markCorrectedPosts() を実行する。
// 訂正前の投稿が取り消し線になり、訂正後の投稿へのリンクが付く。
const CORRECTED_LINKS = [
  // ['https://axia-japan.slack.com/archives/C08P1PGLHT5/p1759145700000000',   // 訂正前（誤り）
  //  'https://axia-japan.slack.com/archives/C08P1PGLHT5/p1759146000000000'],  // 訂正後
];

function markCorrectedPosts() {
  const props = PropertiesService.getScriptProperties();
  let n = 0;
  CORRECTED_LINKS.forEach(function (pair) {
    const oldTs = tsOfLink_(pair[0]), newTs = tsOfLink_(pair[1]);
    if (!oldTs || !newTs) { Logger.log('リンクの形式が違います: ' + pair); return; }

    const saved = props.getProperty('post_' + oldTs);
    if (!saved) { Logger.log('訂正前の投稿の記録がありません（90日より前か、取消済み）: ' + pair[0]); return; }
    const old = JSON.parse(saved);

    try {
      slackApi_('chat.update', {
        channel: SLACK_CHANNEL,
        ts: oldTs,
        text: '【訂正前】' + old.header,
        blocks: [
          supersededTitleBlock_(old.header),
          { type: 'section', text: { type: 'mrkdwn', text: strike_(old.detail) } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: '✏️ *訂正により差し替え*　|　<' + postLink_(newTs) + '|訂正後の投稿を見る>' }] }
        ],
        attachments: []
      });
      forgetPost_(oldTs);
      n++;
      Logger.log('差し替え: ' + old.header);
    } catch (e) {
      Logger.log('失敗 ' + oldTs + ': ' + e.message);
    }
    Utilities.sleep(1100);
  });
  Logger.log(n + '件を訂正前として書き換えました');
}

function tsOfLink_(link) {
  const m = String(link || '').match(/\/p(\d{10})(\d{6})/);
  return m ? m[1] + '.' + m[2] : '';
}



// ===== 物件未定の扱い =====
// 「未定」「物件未定」「空欄」のどれで来ても、同じ扱いにする
const UNDECIDED_VALUES = ['未定', '物件未定'];

function isUndecidedProperty_(fields) {
  const raw = ((fields['物件名'] || [])[0] || '').trim();
  if (raw === '') return true;
  return UNDECIDED_VALUES.indexOf(normalize_(raw)) !== -1;
}

// 物件未定のときに本文へ出す行。号室だけ入っていれば一緒に出す
function undecidedLines_(fields) {
  const rooms = splitRooms_(get_(fields, '号室'));
  return rooms.length ? ['物件未定', '号室　' + rooms.join(' ')] : ['物件未定'];
}

// ============================================================
//  契約作成依頼アプリ用：申込投稿のスレッドを探す（Webアプリ）
// ============================================================
//  契約作成依頼アプリ（AXIA_Slack契約作成依頼.html）が「Slack投稿」で
//  選んだ物件の申込投稿のスレッドを開けるように、投稿の ts を返す。
//
//  公開手順（1回だけ）:
//    右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
//      次のユーザーとして実行: 自分 ／ アクセスできるユーザー: 全員
//    → 出てきた「ウェブアプリのURL」（…/exec）を契約作成依頼アプリの ⚙ 変更 に貼る
//
//  例: …/exec?property=スプレスター志村坂上&room=504&customer=齋藤 瑠維&callback=cb
//      → cb({"ok":true,"ts":"1759157733.123456","url":"https://axia-japan.slack.com/archives/…"})
//  返すのは投稿の場所だけ（顧客名などの中身は返さない）。

const SLACK_WORKSPACE_URL = 'https://axia-japan.slack.com';

function doGet(e) {
  const p = (e && e.parameter) || {};
  let result;
  try {
    const rec = findPostForThread_(p.property, p.room, p.customer);
    result = rec ? { ok: true, ts: rec.ts, url: threadLink_(rec.ts) } : { ok: true, ts: '' };
  } catch (err) {
    result = { ok: false, ts: '' };
  }
  const json = JSON.stringify(result);
  // 契約作成依頼アプリは <script> で読み込むので、callback があれば JSONP で返す
  const callback = String(p.callback || '');
  if (/^[A-Za-z_$][\w$]{0,60}$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// 物件名＋号室で申込投稿を探す。複数あれば顧客名（姓）で絞り、いちばん新しいものを返す
function findPostForThread_(property, room, customer) {
  const building = normalize_(property);
  if (!building || UNDECIDED_VALUES.indexOf(building) !== -1) return null;
  const roomNo = (String(room || '').match(/\d+/) || [''])[0];
  const key = building + roomNo;

  const props = PropertiesService.getScriptProperties().getProperties();
  let hits = [];
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('post_') !== 0) return;
    let rec;
    try { rec = JSON.parse(props[k]); } catch (err) { return; }
    if (!rec.ts || !rec.keys) return;
    const matched = rec.keys.some(function (rk) {
      // 号室が分からないときは物件名だけで探す
      return roomNo ? rk === key : rk.indexOf(building) === 0;
    });
    if (matched) hits.push(rec);
  });

  const who = customerKey_(customer);
  if (who && hits.length > 1) {
    const narrowed = hits.filter(function (rec) { return rec.customer === who; });
    if (narrowed.length > 0) hits = narrowed;
  }
  hits.sort(function (a, b) { return (b.mailAt || b.savedAt) - (a.mailAt || a.savedAt); });
  return hits[0] || null;
}

// 申込投稿のスレッドを開くリンク
function threadLink_(ts) {
  return SLACK_WORKSPACE_URL + '/archives/' + SLACK_CHANNEL + '/p' + String(ts).replace('.', '') +
    '?thread_ts=' + ts + '&cid=' + SLACK_CHANNEL;
}
