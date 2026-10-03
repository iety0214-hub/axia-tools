/**
 * ============================================================
 *  AXIA 販売可能物件一覧 ／ 本承認メール自動連携
 * ------------------------------------------------------------
 *  Gmail の「【種別】本承認」メールを読み取り、
 *  販売可能物件一覧スプレッドシートの該当行の「現況」を
 *  「承認済み」に変更する。
 *
 *  ※ このファイルは「AXIA金消メール連携」プロジェクトに
 *     2つ目のファイルとして追加して使う。
 *     parseMail / normProp / normRoom / propScore などは
 *     金消側のファイルの関数をそのまま使い回す。
 * ============================================================
 */

/* ===== 設定 ===== */
const SCFG = {
  // 対象スプレッドシート
  SHEET_ID: '1xj4nwJI2dXhXDXmL5a6_kBBmPhkBH5C5K7-Dfv6hwW0',

  // メールの【種別】→ 現況に入れる値の対応。
  // ここに足せば「申込」「契約」なども拾えるようになる。
  TYPE_TO_STATUS: {
    '事前承認': '4.事前承認',
    '本承認': '5.本承認',
  },

  // 現況の工程順。左が手前、右が先。
  // 「今の値より先の工程」にしか進めん（後戻りさせん）ための順序表。
  // プルダウンの選択肢と文字を完全に一致させること。
  STATUS_ORDER: ['1.販売可', '2.申込中', '3.契約済み', '4.事前承認', '5.本承認', '6.金消済み', '7.引渡済み'],

  // 対象にするタブ名。空配列にすると全タブを対象にする
  ONLY_SHEETS: ['在庫状況全て'],

  // 対象外にするタブ名（部分一致）
  SKIP_SHEETS: ['金利', '抵当', 'マスタ', 'master', '集計', 'テンプレ', '設定'],

  // ヘッダー行を探す範囲（1行目から何行目まで見るか）
  HEADER_SCAN_ROWS: 10,

  // 現況列を入力規則から特定するときの手がかりにする値
  VALIDATION_HINT: '5.本承認',

  // STATUS_ORDER に無い値（古い選択肢の残骸など）が入っとる行の扱い。
  //   'skip'      … 触らずに報告する（安全側。既定）
  //   'overwrite' … 空欄と同じ扱いにして上書きする
  UNKNOWN_POLICY: 'skip',

  // Gmailの検索語。事前承認と本承認の両方を拾う
  QUERY: '"【種別】事前承認" OR "【種別】本承認"',

  // 結果の通知先。空にすると通知せん
  NOTIFY_TO: 'iehara@axia-japan.co.jp',

  // Gmailを遡る日数
  SEARCH_DAYS: 30,

  // true にすると書き込みせずログだけ出す
  DRY_RUN: false,
};

/* ===== 工程の順位を返す。表に無い値や空欄は -1 =====
 * プルダウンの表記ゆれを吸収してから比べる。
 *   「5.本承認」「本承認」「5．本承認」→ すべて同じ
 *   「引渡し済み」「引渡済み」→ 同じ
 * これで、選択肢を番号付きに変えた後も、
 * 古い表記のまま残っとるセルを正しく判定できる。
 */
function normStatus(v) {
  return String(v || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/^\s*\d+\s*[.．、:：)）]?\s*/, '')   // 先頭の番号を落とす
    .replace(/[\s　]/g, '')
    .replace(/し済み$/, '済み')                     // 引渡し済み → 引渡済み
    .replace(/渡し/, '渡');                         // 引渡し → 引渡
}

function statusRank(v) {
  const t = normStatus(v);
  if (!t) return -1;
  for (let i = 0; i < SCFG.STATUS_ORDER.length; i++) {
    if (normStatus(SCFG.STATUS_ORDER[i]) === t) return i;
  }
  return -1;
}

/* ===== このファイル用のGmail検索クエリ ===== */
function buildQuerySheet() {
  return `(${SCFG.QUERY}) newer_than:${SCFG.SEARCH_DAYS}d`;
}

/* ============================================================
 *  メイン：本承認メール → 現況を「承認済み」に更新
 * ============================================================ */
function syncSalesSheet() {
  const rows = buildRowIndex();
  if (!rows.length) throw new Error('対象の行が1件も作れんかった。diagnoseSheet を実行して構造を確認して。');

  const threads = GmailApp.search(buildQuerySheet());
  const seen = loadSeenSheet();

  const done = [];
  const skipped = [];
  const kept = [];
  let scanned = 0;

  threads.forEach(th => {
    th.getMessages().forEach(msg => {
      const id = msg.getId();
      if (seen[id]) return;

      const p = parseMail(msg.getPlainBody());
      if (!p) { seen[id] = 'skip:解析不可'; return; }

      const status = SCFG.TYPE_TO_STATUS[p['種別']];
      if (!status) { seen[id] = 'skip:対象外の種別'; return; }
      scanned++;

      const hit = findRow(rows, p);
      if (!hit.row) {
        skipped.push({ reason: hit.reason, mail: p, status: status });
        Logger.log(`未マッチ: [${p['種別']}] [${p['物件名']}] [${p['号室']}] [${p['顧客名']}] → ${hit.reason}`);
        return;   // 記録せず、次回また拾えるようにする
      }

      const t = hit.row;
      const cell = t.sheet.getRange(t.rowNum, t.statusCol);
      const before = String(cell.getValue() || '');

      const curRank = statusRank(before);
      const newRank = statusRank(status);

      // 選択肢に無い値が入っとる行は、勝手に潰さず報告だけする
      if (before && curRank < 0 && SCFG.UNKNOWN_POLICY === 'skip') {
        Logger.log(`変更せん（選択肢に無い値）: ${t.propRaw} ${t.roomRaw} 現況[${before}] メール[${status}]`);
        kept.push({
          prop: t.propRaw, room: t.roomRaw, name: p['顧客名'] || '',
          before: before, mail: status, why: '選択肢に無い値',
          sheet: t.sheetName, rowNum: t.rowNum,
        });
        seen[id] = 'skip:未知の値';
        return;
      }

      // 今の値と同じか、今の方が先に進んどる場合は触らん
      if (curRank >= newRank) {
        const why = (statusRank(before) === statusRank(status)) ? 'すでに同じ' : '先の工程';
        Logger.log(`変更せん（${why}）: ${t.propRaw} ${t.roomRaw} 現況[${before || '空欄'}] メール[${status}]`);
        kept.push({
          prop: t.propRaw, room: t.roomRaw, name: p['顧客名'] || '',
          before: before || '（空欄）', mail: status, why: why,
          sheet: t.sheetName, rowNum: t.rowNum,
        });
        seen[id] = 'skip:' + why;
        return;
      }

      if (!SCFG.DRY_RUN) {
        cell.setValue(status);
        seen[id] = 'done:' + status;
      }
      done.push({
        sheet: t.sheetName, rowNum: t.rowNum, prop: t.propRaw, room: t.roomRaw,
        name: p['顧客名'] || '', before: before || '（空欄）', after: status,
      });
      Logger.log(`更新: ${t.propRaw} ${t.roomRaw} [${before || '空欄'}] → [${status}]  (${t.sheetName} ${t.rowNum}行目)` + (hit.reason ? `  ※${hit.reason}` : ''));
    });
  });

  if (!SCFG.DRY_RUN) saveSeenSheet(seen);
  Logger.log(`完了 — 対象メール ${scanned}通 ／ 更新 ${done.length}件 ／ 据え置き ${kept.length}件 ／ 未マッチ ${skipped.length}件`);
  // 更新が1件以上あるときだけ通知する。
  // 未反映・据え置きだけの回は毎回同じ内容が届いて埋もれるので送らん。
  // （中身はログに残っとるし、次に更新があった回のメールに一緒に載る）
  if (done.length) notifySheetResult(done, skipped, kept);
  return { done: done.length, kept: kept.length, skipped: skipped.length };
}

/* ============================================================
 *  シート構造の解析
 * ============================================================ */

// 対象にするタブを絞る
function targetSheets() {
  const ss = SpreadsheetApp.openById(SCFG.SHEET_ID);
  return ss.getSheets().filter(sh => {
    const n = sh.getName();
    if (SCFG.ONLY_SHEETS && SCFG.ONLY_SHEETS.length) {
      return SCFG.ONLY_SHEETS.indexOf(n) >= 0;
    }
    if (sh.isSheetHidden()) return false;
    return !SCFG.SKIP_SHEETS.some(x => n.indexOf(x) >= 0);
  });
}

/**
 * ヘッダー行と各列の位置を割り出す。
 * 「号室」「物件」「現況」らしきラベルが一番多く揃う行をヘッダーとみなす。
 */
function detectLayout(sh) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return null;

  const scan = Math.min(SCFG.HEADER_SCAN_ROWS, lastRow);
  const head = sh.getRange(1, 1, scan, lastCol).getDisplayValues();

  const RE_ROOM = /^(号室|部屋番号|部屋|室番号|号|room)$/i;
  const RE_PROP = /^(物件|物件名|建物|建物名|物件名称|マンション名)$/;
  const RE_STAT = /^(現況|ステータス|状況|進捗|状態|status)$/i;

  let best = null;
  for (let r = 0; r < scan; r++) {
    let roomCol = 0, propCol = 0, statCol = 0, score = 0;
    for (let c = 0; c < lastCol; c++) {
      const v = String(head[r][c] || '').replace(/[\s　]/g, '');
      if (!v) continue;
      if (!roomCol && RE_ROOM.test(v)) { roomCol = c + 1; score++; }
      if (!propCol && RE_PROP.test(v)) { propCol = c + 1; score++; }
      if (!statCol && RE_STAT.test(v)) { statCol = c + 1; score++; }
    }
    if (score && (!best || score > best.score)) {
      best = { headerRow: r + 1, roomCol: roomCol, propCol: propCol, statusCol: statCol, score: score };
    }
  }
  if (!best) return null;

  // 現況列は入力規則からも確認する（ヘッダー名が変わっても追従させるため）
  const byRule = findStatusColByValidation(sh, best.headerRow, lastRow, lastCol);
  if (byRule) best.statusCol = byRule;
  best.byRule = byRule;

  return best;
}

/**
 * 入力規則（プルダウン）の選択肢に VALIDATION_HINT を含む列を探す。
 * リスト直接指定と、範囲参照の両方に対応する。
 */
function findStatusColByValidation(sh, headerRow, lastRow, lastCol) {
  const start = headerRow + 1;
  if (start > lastRow) return 0;
  const n = Math.min(30, lastRow - start + 1);

  let rules;
  try { rules = sh.getRange(start, 1, n, lastCol).getDataValidations(); }
  catch (e) { return 0; }

  const count = {};
  rules.forEach(row => {
    row.forEach((rule, ci) => {
      if (!rule) return;
      let list = [];
      try {
        const cv = rule.getCriteriaValues();
        if (!cv || !cv.length) return;
        const first = cv[0];
        if (Array.isArray(first)) {
          list = first.map(v => String(v).trim());
        } else if (first && typeof first.getValues === 'function') {
          // 範囲参照のプルダウン
          list = first.getValues().map(r2 => String(r2[0]).trim());
        }
      } catch (e) { return; }
      if (list.indexOf(SCFG.VALIDATION_HINT) >= 0) count[ci + 1] = (count[ci + 1] || 0) + 1;
    });
  });

  let bestCol = 0, bestN = 0;
  Object.keys(count).forEach(c => { if (count[c] > bestN) { bestN = count[c]; bestCol = Number(c); } });
  return bestCol;
}

/**
 * 全タブの全行をフラットな一覧にする。
 * 物件名は「物件名列の値」、無ければ「タブ名」を使う。
 * これで1タブ集約でも物件別タブでも同じ照合ロジックが使える。
 */
function buildRowIndex() {
  const out = [];

  targetSheets().forEach(sh => {
    const L = detectLayout(sh);
    if (!L || !L.roomCol || !L.statusCol) return;

    const lastRow = sh.getLastRow();
    const start = L.headerRow + 1;
    if (start > lastRow) return;

    const width = Math.max(L.roomCol, L.propCol || 0, L.statusCol);
    const body = sh.getRange(start, 1, lastRow - start + 1, width).getDisplayValues();

    let lastProp = '';   // 物件名が縦に結合／省略されとる場合に引き継ぐ
    body.forEach((row, i) => {
      const propRaw = L.propCol ? String(row[L.propCol - 1] || '').trim() : '';
      if (propRaw) lastProp = propRaw;
      const roomRaw = String(row[L.roomCol - 1] || '').trim();
      const room = normRoom(roomRaw);
      if (!room) return;

      out.push({
        sheet: sh,
        sheetName: sh.getName(),
        rowNum: start + i,
        statusCol: L.statusCol,
        roomRaw: roomRaw,
        room: room,
        propRaw: propRaw || lastProp || sh.getName(),
      });
    });
  });

  return out;
}

/* ============================================================
 *  メールとシート行の照合
 * ============================================================ */
function findRow(rows, mail) {
  const mProp = mail['物件名'];
  const mRoom = normRoom(mail['号室']);
  if (!normProp(mProp)) return { row: null, reason: '物件名が読み取れんかった' };
  if (!mRoom) return { row: null, reason: '号室が読み取れんかった' };

  // 物件名の近さで全行を採点
  const scored = rows
    .map(r => ({ r: r, score: propScore(r.propRaw, mProp) }))
    .filter(o => o.score > 0);

  if (!scored.length) {
    return { row: null, reason: `物件名が一致する行がなかった（メール:${mProp}）` };
  }

  const best = Math.max.apply(null, scored.map(o => o.score));
  let cands = scored.filter(o => o.score === best).map(o => o.r);

  // 号室で絞る
  const byRoom = cands.filter(r => r.room === mRoom);
  if (!byRoom.length) {
    const list = cands.slice(0, 15).map(c => c.roomRaw).join('／');
    return { row: null, reason: `物件[${cands[0].propRaw}]に号室${mail['号室']}の行がなかった（ある号室:${list}）` };
  }
  cands = byRoom;

  if (cands.length > 1) {
    return {
      row: null,
      reason: `同じ物件・号室の行が${cands.length}個あった（${cands.map(c => c.sheetName + ':' + c.rowNum + '行目').join('／')}）`
    };
  }

  return { row: cands[0], reason: best < 1 ? `物件名は類似一致（スコア${best.toFixed(2)}）` : '' };
}

/* ============================================================
 *  処理済みメッセージの記録
 * ============================================================ */
const SEEN_KEY_SHEET = 'processedMessageIds_salesSheet';

function loadSeenSheet() {
  const raw = PropertiesService.getScriptProperties().getProperty(SEEN_KEY_SHEET);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function saveSeenSheet(seen) {
  const keys = Object.keys(seen);
  if (keys.length > 1000) {
    const t = {};
    keys.slice(-1000).forEach(k => { t[k] = seen[k]; });
    seen = t;
  }
  PropertiesService.getScriptProperties().setProperty(SEEN_KEY_SHEET, JSON.stringify(seen));
}

function clearProcessedSheet() {
  PropertiesService.getScriptProperties().deleteProperty(SEEN_KEY_SHEET);
  Logger.log('販売一覧側の処理済み記録を消したばい。次の実行で全メールを見直す');
}

/* ============================================================
 *  結果通知
 * ============================================================ */
function notifySheetResult(done, skipped, kept) {
  if (!SCFG.NOTIFY_TO) return;
  kept = kept || [];
  let body = '';

  if (done.length) {
    body += `■ 現況を変更した案件（${done.length}件）\n\n`;
    body += done.map(d =>
      `・${d.prop} ${d.room}　${d.name}\n　${d.before} → ${d.after}　（${d.sheet} ${d.rowNum}行目）`
    ).join('\n\n') + '\n\n';
  }

  const unknown = kept.filter(k => k.why === '選択肢に無い値');
  if (unknown.length) {
    body += `■ 現況が選択肢に無い値のため変更しなかった案件（${unknown.length}件）\n\n`;
    body += unknown.map(d =>
      `・${d.prop} ${d.room}　${d.name}\n　現況「${d.before}」は現在の選択肢にありません（メールは${d.mail}）　（${d.sheet} ${d.rowNum}行目）`
    ).join('\n\n') + '\n\n';
  }

  // すでに同じ値だったものは通知に載せても意味がないので、先の工程だったものだけ出す
  const ahead = kept.filter(k => k.why === '先の工程');
  if (ahead.length) {
    body += `■ すでに先の工程のため変更しなかった案件（${ahead.length}件）\n\n`;
    body += ahead.map(d =>
      `・${d.prop} ${d.room}　${d.name}\n　現況「${d.before}」のまま（メールは${d.mail}）　（${d.sheet} ${d.rowNum}行目）`
    ).join('\n\n') + '\n\n';
  }

  if (skipped.length) {
    body += `■ 反映できんかった案件（${skipped.length}件）\n\n`;
    body += skipped.map(s =>
      `・[${s.status}] ${s.mail['物件名'] || ''} ${s.mail['号室'] || ''}／${s.mail['顧客名'] || ''}\n　理由：${s.reason}`
    ).join('\n\n') + '\n\n';
  }

  if (!body) return;
  body += `シート：https://docs.google.com/spreadsheets/d/${SCFG.SHEET_ID}/edit\n`;

  const subject = `【販売一覧】現況の自動反映 ${done.length}件更新`
    + (ahead.length + unknown.length ? ` / ${ahead.length + unknown.length}件据え置き` : '')
    + (skipped.length ? ` / ${skipped.length}件未反映` : '');
  GmailApp.sendEmail(SCFG.NOTIFY_TO, subject, body);
}

/* ============================================================
 *  診断：シート構造とメールの照合結果をログに出す（書き込みせん）
 * ============================================================ */
function diagnoseSheet() {
  const ss = SpreadsheetApp.openById(SCFG.SHEET_ID);
  Logger.log(`===== スプレッドシート =====`);
  Logger.log(`  ${ss.getName()}`);
  Logger.log(`  全タブ: ${ss.getSheets().map(s => s.getName() + (s.isSheetHidden() ? '(非表示)' : '')).join(' / ')}`);

  const sheets = targetSheets();
  Logger.log(`  対象タブ: ${sheets.map(s => s.getName()).join(' / ') || '（なし）'}`);

  Logger.log(`\n===== 各タブの構造 =====`);
  sheets.forEach(sh => {
    const L = detectLayout(sh);
    if (!L) {
      Logger.log(`  [${sh.getName()}] 構造を認識できんかった`);
      dumpHead(sh);
      return;
    }
    Logger.log(`  [${sh.getName()}] ヘッダー行:${L.headerRow}` +
      ` 物件列:${L.propCol ? colName(L.propCol) : 'なし(タブ名を使う)'}` +
      ` 号室列:${L.roomCol ? colName(L.roomCol) : 'なし'}` +
      ` 現況列:${L.statusCol ? colName(L.statusCol) : 'なし'}` +
      `${L.byRule ? '（現況列は入力規則から特定）' : ''}`);
    if (!L.roomCol || !L.statusCol) {
      Logger.log(`      ※ 号室列か現況列が特定できとらんけん、このタブは対象外になる`);
      dumpHead(sh);
    }
  });

  const rows = buildRowIndex();
  Logger.log(`\n===== 読み取れた行 =====`);
  Logger.log(`  合計 ${rows.length}行`);
  const props = {};
  rows.forEach(r => { props[r.propRaw] = (props[r.propRaw] || 0) + 1; });
  const names = Object.keys(props);
  Logger.log(`  物件 ${names.length}件`);
  names.slice(0, 40).forEach(n => Logger.log(`    ${n}（${props[n]}室）`));
  if (names.length > 40) Logger.log(`    … 他${names.length - 40}件`);

  // 現況が選択肢に無い値になっとる行を洗い出す
  const strays = {};
  rows.forEach(r => {
    const v = String(r.sheet.getRange(r.rowNum, r.statusCol).getValue() || '').trim();
    if (v && statusRank(v) < 0) strays[v] = (strays[v] || 0) + 1;
  });
  const strayKeys = Object.keys(strays);
  if (strayKeys.length) {
    Logger.log(`\n===== 選択肢に無い現況の値 =====`);
    strayKeys.forEach(k => Logger.log(`  「${k}」… ${strays[k]}行`));
    Logger.log(`  ※ UNKNOWN_POLICY が 'skip' の間、これらの行は変更されん`);
  }

  const q = buildQuerySheet();
  const threads = GmailApp.search(q);
  Logger.log(`\n===== メール照合 =====`);
  Logger.log(`  検索条件: ${q}`);
  Logger.log(`  工程順: ${SCFG.STATUS_ORDER.join(' → ')}`);

  let target = 0, hit = 0, willChange = 0;
  threads.forEach(th => {
    th.getMessages().forEach(msg => {
      const p = parseMail(msg.getPlainBody());
      if (!p) return;
      const status = SCFG.TYPE_TO_STATUS[p['種別']];
      if (!status) return;
      target++;

      const d = Utilities.formatDate(msg.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');
      Logger.log(`  ${d} [${p['種別']}] 物件:[${p['物件名']}] 号室:[${p['号室']}] 名前:[${p['顧客名']}]`);

      const r = findRow(rows, p);
      if (!r.row) { Logger.log(`      → 未マッチ: ${r.reason}`); return; }
      hit++;

      const cur = String(r.row.sheet.getRange(r.row.rowNum, r.row.statusCol).getValue() || '');
      const curRank = statusRank(cur), newRank = statusRank(status);
      let verdict;
      if (curRank >= 0 && curRank === newRank) verdict = `変更なし（すでに${cur}）`;
      else if (cur && curRank < 0 && SCFG.UNKNOWN_POLICY === 'skip') verdict = `変更せん（現況「${cur}」は選択肢に無い値）`;
      else if (curRank >= newRank) verdict = `変更せん（現況「${cur}」の方が先の工程）`;
      else { verdict = `[${cur || '空欄'}] → [${status}]`; willChange++; }

      Logger.log(`      → 一致: ${r.row.sheetName} ${r.row.rowNum}行目 [${r.row.propRaw} ${r.row.roomRaw}]`);
      Logger.log(`         ${verdict}${r.reason ? '  ※' + r.reason : ''}`);
    });
  });

  Logger.log(`\n===== まとめ =====`);
  Logger.log(`  対象メール ${target}通 のうち ${hit}通 が一致、${target - hit}通 が未マッチ`);
  Logger.log(`  実行すると ${willChange}件 の現況が変わる`);
  Logger.log(`\n===== 診断おわり =====`);
}

// 先頭数行をそのまま出す（構造が読めん時の手がかり用）
function dumpHead(sh) {
  const r = Math.min(6, sh.getLastRow());
  const c = Math.min(12, sh.getLastColumn());
  if (!r || !c) return;
  const v = sh.getRange(1, 1, r, c).getDisplayValues();
  v.forEach((row, i) => Logger.log(`      ${i + 1}行目: ${row.map(x => x || '-').join(' | ')}`));
}

// 列番号を A, B, C… の表記に直す
function colName(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s || '?';
}

/* ===== 書き込みせず動作だけ見る ===== */
function dryRunSheet() {
  const bak = SCFG.DRY_RUN;
  SCFG.DRY_RUN = true;
  try { syncSalesSheet(); } finally { SCFG.DRY_RUN = bak; }
}

/* ===== 30分おきのトリガーを作る ===== */
function setupTriggerSheet() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncSalesSheet')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncSalesSheet').timeBased().everyMinutes(30).create();
  Logger.log('販売一覧側も30分おきのトリガーを作成したばい');
}


/* ============================================================
 *  プルダウンの表記を変えた時の移行用
 *  古い表記（番号なし等）のセルを、STATUS_ORDER の正式な表記に揃える。
 *  DRY_RUN が true なら書き込まずログだけ出す。
 * ============================================================ */
function migrateStatusValues() {
  const rows = buildRowIndex();
  const changes = [];

  rows.forEach(r => {
    const cell = r.sheet.getRange(r.rowNum, r.statusCol);
    const cur = String(cell.getValue() || '').trim();
    if (!cur) return;

    const rank = statusRank(cur);
    if (rank < 0) {
      Logger.log(`  対応する選択肢がなか: ${r.propRaw} ${r.roomRaw} [${cur}]（${r.rowNum}行目）`);
      return;
    }
    const proper = SCFG.STATUS_ORDER[rank];
    if (cur === proper) return;

    changes.push({ r: r, cell: cell, from: cur, to: proper });
  });

  Logger.log(`表記を揃える対象: ${changes.length}件`);
  changes.forEach(c => {
    Logger.log(`  ${c.r.propRaw} ${c.r.roomRaw}（${c.r.rowNum}行目） [${c.from}] → [${c.to}]`);
    if (!SCFG.DRY_RUN) c.cell.setValue(c.to);
  });
  Logger.log(SCFG.DRY_RUN ? '※ DRY_RUN のため書き込んどらん' : `${changes.length}件を書き換えたばい`);
  return changes.length;
}

/* ===== 移行を書き込みせず確認する ===== */
function migrateStatusValuesDryRun() {
  const bak = SCFG.DRY_RUN;
  SCFG.DRY_RUN = true;
  try { migrateStatusValues(); } finally { SCFG.DRY_RUN = bak; }
}