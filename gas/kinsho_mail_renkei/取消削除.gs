/**
 * 【オープン】【物件振替】メールを読んで、金消アプリ（AXIA_Kinsho）から該当の行を消すスクリプト。
 *
 * ■ 使い方
 *   ・申込追記.gs の syncMoushikomiMails（10分おき）の最後に一緒に動くけん、トリガーの追加はいらん
 *   ・まず testRunDelete() を実行（何も消さん。消される行がログに出るだけ）
 *
 * ■ やること
 *   ・オープン   → 【物件名】【号室】（旧形式は【内容】の「○○様 物件名 号室 … ↓ オープン」）の行を消す
 *   ・物件振替   → 【振替前】の「物件名 号室」の行を消す（振替後の物件の行は足さん）
 *   ・物件名＋号室が一致して、顧客名も食い違わん行が1件に絞れたときだけ消す
 *   ・金消予定日が入っとる行は消さずに知らせる
 *   ・行が見つからんときは、申込の行がまだ作られとらん可能性があるけん1日は待って拾い直す
 */

// ===== 設定 =====
const DCFG = {
  QUERY: 'to:axia-japan@googlegroups.com {"【種別】オープン" "【種別】物件振替" subject:オープン subject:物件振替} newer_than:14d',
  DONE_PREFIX: 'kdel_',     // 処理済みメッセージIDの記録（スクリプトプロパティ）
  DONE_KEEP_DAYS: 30,       // 記録を残す日数（検索範囲の14日より長ければよい）
  RETRY_HOURS: 24,          // 行が見つからんとき、この時間までは次の回にまた探す
};

// ===== 本体 =====
function syncOpenTransferMails(dryRun) {
  const dry = dryRun === true;
  const props = PropertiesService.getScriptProperties();
  const pending = [];
  GmailApp.search(DCFG.QUERY, 0, 50).forEach(th => th.getMessages().forEach(msg => {
    if (!props.getProperty(DCFG.DONE_PREFIX + msg.getId())) pending.push(msg);
  }));
  if (!pending.length) return;
  pending.sort((a, b) => a.getDate() - b.getDate());   // 届いた順に処理する

  const settings = fetchSettings_();
  allRows_(true);
  const deleted = [], failed = [];

  pending.forEach(msg => {
    const v = parseBody_(msg.getPlainBody() || '');
    const kind = delKind_(v['種別'] || v['完了種類'] || v['種類']);
    if (!kind) { if (!dry) markDelDone_(props, msg); return; }

    const units = kind === 'オープン' ? delOpenUnits_(v) : delUnitsOf_(v['振替前']);
    const customer = delCustomer_(v);
    const subject = msg.getSubject();
    if (!units.length) {
      if (!/未定/.test(v['物件名'] || v['振替前'] || '')) failed.push(subject + '：物件名・号室が読み取れんかった');
      if (!dry) markDelDone_(props, msg);
      return;
    }

    const notFound = [];
    units.forEach(u => {
      const label = u.bukken + ' ' + u.room + '／' + (customer || '名前なし') + '（' + kind + '）';
      const hit = delFindRow_(u, customer, settings);
      if (hit.error) { failed.push(label + '：' + hit.error); return; }
      if (!hit.row) { notFound.push(label); return; }
      const k = (hit.row.fields || {})[settings.keyOf.kinsho];
      if (k && typeof k === 'object' ? k.d : k) {
        failed.push(label + '：金消予定日が入っとるけん消さんかった');
        return;
      }
      try {
        if (!dry) api_('DELETE', '/rest/v1/' + CFG.TABLE + '?id=eq.' + encodeURIComponent(hit.row.id));
        allRows_.cache = allRows_.cache.filter(r => r.id !== hit.row.id);
        deleted.push(label + '（' + hit.row.month + '）');
      } catch (e) {
        failed.push(label + '：' + e);
      }
    });

    // 申込の行がまだ作られとらんだけかもしれんので、しばらくは次の回にまた探す
    if (notFound.length && Date.now() - msg.getDate().getTime() < DCFG.RETRY_HOURS * 3600 * 1000) return;
    notFound.forEach(s => failed.push(s + '：アプリに該当の行が見つからんかった'));
    if (!dry) markDelDone_(props, msg);
  });

  Logger.log((dry ? '【お試し】' : '') + '削除 ' + deleted.length + '件' + (failed.length ? ' / 消せんかった ' + failed.length + '件' : ''));
  deleted.forEach(s => Logger.log('  ✓ ' + s));
  failed.forEach(s => Logger.log('  ⚠ ' + s));
  if (!dry) cleanupDelDone_(props);

  if (!dry && MCFG.REPORT_TO && (deleted.length || failed.length)) {
    const lines = [];
    if (deleted.length) lines.push('■ オープン・物件振替で消した行（' + deleted.length + '件）', ...deleted.map(s => '・' + s), '');
    if (failed.length) lines.push('■ 消せんかった（' + failed.length + '件）手で確認してください', ...failed.map(s => '・' + s), '');
    lines.push('金消アプリ：https://iety0214-hub.github.io/axia-tools/AXIA_Kinsho.html');
    GmailApp.sendEmail(MCFG.REPORT_TO,
      '【金消アプリ】オープン・物件振替で ' + deleted.length + '件削除' + (failed.length ? ' / ' + failed.length + '件要確認' : ''),
      lines.join('\n'));
  }
  return { deleted: deleted, failed: failed };
}

/** 書き込まずに、消される行だけログに出す（処理済みの記録もせん） */
function testRunDelete() { syncOpenTransferMails(true); }

/** 【種別】から「オープン」「物件振替」を返す。両方入っとったらオープン扱い。それ以外は '' */
function delKind_(raw) {
  const s = clean_(raw);
  if (s.indexOf('オープン') !== -1) return 'オープン';
  if (s.indexOf('物件振替') !== -1) return '物件振替';
  return '';
}

/** オープンメールの物件。新形式は【物件名】【号室】、旧形式は【内容】から読む */
function delOpenUnits_(v) {
  if (clean_(v['物件名'])) {
    return propertyPairs_(v).filter(p => p.room).map(p => ({ bukken: p.bukken, room: p.room }));
  }
  let content = (v['内容'] || '').split('↓')[0];
  const i = content.indexOf('様');
  if (i !== -1) content = content.slice(i + 1);
  return delUnitsOf_(content);
}

/** 「AXIA CITY神戸松原 201号室／202」のような文字列を {bukken, room} に分ける。号室だけなら直前の物件名を使う */
function delUnitsOf_(raw) {
  const units = [];
  let last = '';
  (raw || '').split('\n').forEach(line => {
    const re = /([^\d]*?)\s*(\d{2,5})\s*(?:号室|号)?/g;
    let m;
    const s = String(line).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    while ((m = re.exec(s)) !== null) {
      const name = m[1].replace(/^[\s　、,，・.．\/／]+|[\s　、,，・.．\/／]+$/g, '');
      if (name) last = name;
      if (last) units.push({ bukken: last, room: m[2] });
    }
  });
  return units;
}

/** 顧客名。旧形式のオープンメールは【内容】の「○○様」から取る */
function delCustomer_(v) {
  const name = clean_(v['顧客名']);
  if (name) return name.replace(/様\s*$/, '');
  const c = v['内容'] || '';
  const i = c.indexOf('様');
  return i > 0 ? clean_(c.slice(0, i)) : '';
}

/**
 * 消す行を探す。物件名（表記揺れは吸収、類似一致は使わん）と号室が両方一致する行のうち、
 * 顧客名が食い違わんもの。1件に絞れんときは消さん。
 */
function delFindRow_(u, customer, settings) {
  const bk = settings.keyOf.bukken, rk = settings.keyOf.room;
  // 「(諸費用有102万)」みたいな注記は外して見る
  const prop = s => normProp(String(s == null ? '' : s).replace(/[（(].*?[）)]/g, ''));
  const room = normRoom(u.room);
  let cands = allRows_().filter(r => {
    const f = r.fields || {};
    return propScore(prop(f[bk]), prop(u.bukken)) >= 0.95 && normRoom(f[rk]) === room;
  });
  if (!cands.length) return { row: null };
  cands = cands.filter(r => nameMatches(r.name, customer));
  if (!cands.length) return { error: 'アプリの行は別のお客様の名前になっとる' };
  if (cands.length > 1) return { error: '該当の行が' + cands.length + '件あって特定できんかった' };
  return { row: cands[0] };
}

function markDelDone_(props, msg) {
  props.setProperty(DCFG.DONE_PREFIX + msg.getId(), String(Date.now()));
}

/** 古い処理済み記録を消す（スクリプトプロパティの容量対策） */
function cleanupDelDone_(props) {
  const limit = Date.now() - DCFG.DONE_KEEP_DAYS * 24 * 3600 * 1000;
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf(DCFG.DONE_PREFIX) === 0 && Number(all[k]) < limit) props.deleteProperty(k);
  });
}
