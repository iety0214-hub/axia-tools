/**
 * 転職説明会アンケート 作り直しスクリプト
 *
 * 既存のGoogleフォーム（FORM_ID）の質問をすべて削除し、転職説明会用の質問に置き換える。
 *   1. 基本情報
 *   2. 転職の状況・志向
 *   3. 当社への印象・関心
 *
 * 使い方:
 *   1. https://script.google.com で新しいプロジェクトを作り、このファイルの中身を貼り付ける
 *   2. rebuildForm() を実行する（初回はフォームの編集権限を許可する）
 *
 * 注意: 既存の質問は削除される。これまでの回答を残したい場合は、
 *       実行前にフォームをコピーするか、回答をスプレッドシートへ書き出しておく。
 *       選択肢は下の定数を書き換えれば変えられる。
 */

// ===== 設定 =====
const FORM_ID = '1cW7yU0YyCFqqYOsx7D59_QY_gPkZ7mQpIFwacn0fwIg';

const FORM_TITLE = '転職説明会 アンケート';
const FORM_DESCRIPTION =
  '本日はご参加いただき、ありがとうございました。\n' +
  '今後のご案内の参考にさせていただきますので、アンケートへのご協力をお願いいたします。\n' +
  '（所要時間：約3分）';

const CURRENT_JOBS = [
  '営業', '販売・接客・サービス', '事務・アシスタント', '企画・マーケティング',
  'IT・エンジニア', '金融・保険', '不動産', '建設・施工管理', '製造・技術',
  '医療・介護', '公務員・教育', '学生・未就業',
];

const EXPERIENCE_YEARS = [
  '1年未満', '1〜3年未満', '3〜5年未満', '5〜10年未満', '10年以上',
];

const DESIRED_JOBS = [
  '営業', '販売・接客・サービス', '事務・アシスタント', '企画・マーケティング',
  'IT・エンジニア', '管理部門（人事・経理など）', '不動産', '金融・保険',
];

const TIMING = ['すぐに', '3か月以内', '半年〜1年以内', '情報収集中'];

const PRIORITIES = [
  '仕事内容', '年収', '勤務地', '働き方（リモート・フレックスなど）',
  '福利厚生', '社風', '成長機会', '安定性',
];

const INTERESTS = ['事業内容', '仕事内容', '給与・待遇', '働き方', '社風', 'キャリアパス'];

// ===== 本体 =====
function rebuildForm() {
  const form = FormApp.openById(FORM_ID);

  form.getItems().forEach(item => form.deleteItem(item));

  form.setTitle(FORM_TITLE)
    .setDescription(FORM_DESCRIPTION)
    .setCollectEmail(false)
    .setProgressBar(true)
    .setConfirmationMessage('ご回答ありがとうございました。今後ともよろしくお願いいたします。');

  // --- 1. 基本情報 ---
  form.addSectionHeaderItem().setTitle('1. 基本情報');

  form.addTextItem().setTitle('氏名').setRequired(true);

  form.addTextItem()
    .setTitle('メールアドレス')
    .setRequired(true)
    .setValidation(FormApp.createTextValidation()
      .requireTextIsEmail()
      .setHelpText('メールアドレスの形式で入力してください')
      .build());

  form.addTextItem().setTitle('電話番号').setHelpText('任意');

  form.addMultipleChoiceItem()
    .setTitle('現在の職種・業界')
    .setChoiceValues(CURRENT_JOBS)
    .showOtherOption(true)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('経験年数（現在の職種）')
    .setChoiceValues(EXPERIENCE_YEARS)
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('希望する職種（複数選択可）')
    .setChoiceValues(DESIRED_JOBS)
    .showOtherOption(true)
    .setRequired(true);

  // --- 2. 転職の状況・志向 ---
  form.addPageBreakItem().setTitle('2. 転職の状況・志向');

  form.addMultipleChoiceItem()
    .setTitle('転職を考えている時期')
    .setChoiceValues(TIMING)
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('転職で重視すること（3つまで）')
    .setChoiceValues(PRIORITIES)
    .setRequired(true)
    .setValidation(FormApp.createCheckboxValidation()
      .requireSelectAtMost(3)
      .setHelpText('3つまで選択してください')
      .build());

  form.addParagraphTextItem()
    .setTitle('転職活動の進み具合（任意）')
    .setHelpText('例：応募済みの企業数、面接の有無など');

  // --- 3. 当社への印象・関心 ---
  form.addPageBreakItem().setTitle('3. 当社への印象・関心');

  form.addCheckboxItem()
    .setTitle('本日の説明で興味を持ったこと（複数選択可）')
    .setChoiceValues(INTERESTS)
    .showOtherOption(true)
    .setRequired(true);

  form.addScaleItem()
    .setTitle('当社に対する印象')
    .setBounds(1, 5)
    .setLabels('よくない', 'とてもよい')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('上記の印象の理由')
    .setRequired(true);

  form.addParagraphTextItem().setTitle('もっと詳しく知りたい点');

  Logger.log('更新しました: ' + form.getEditUrl());
}
