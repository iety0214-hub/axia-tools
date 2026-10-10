/**
 * generate_takken_docx.js — 宅建問題の docx 2ファイル生成
 *
 *   入力: ./questions.js  ./explanations.js   （形式は assets/data_format.md）
 *   出力: ./問題編.docx    ./解答解説編.docx
 *
 * 環境変数
 *   TAKKEN_TITLE   タイトル文字列（14pt固定・中央揃え・1行・スケール対象外）
 *   TAKKEN_SCALE   本文フォントの倍率（既定 1.0。0.85 等。下限8ptで頭打ち）
 *   TAKKEN_MARGIN  余白 DXA（既定 1080 = 0.75インチ。最小 720 = 0.5インチ）
 *   TAKKEN_OUT_Q   問題編の出力ファイル名（既定 問題編.docx）
 *   TAKKEN_OUT_A   解答解説編の出力ファイル名（既定 解答解説編.docx）
 *
 * 体裁ルール（SKILL.md §6「docx体裁」と一致させること）
 *   - A4 / 本文 Yu Mincho / 見出し・ラベル Yu Gothic
 *   - 本文21・ラベル22・解説20（half-point）を TAKKEN_SCALE で一括スケール
 *   - 問番号と正解は太字。正解は赤 C00000、ひっかけは緑 1F6B2E
 *   - 各問は keepNext / keepLines で1ブロック化しページ跨ぎを防ぐ
 *   - 問題編には正解・解説を一切含めない
 */

const fs = require("fs");
const path = require("path");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
} = require("docx");

const MARKS = ["ア", "イ", "ウ", "エ"];

const TITLE = process.env.TAKKEN_TITLE || "宅地建物取引士試験　演習問題";
const SCALE = parseFloat(process.env.TAKKEN_SCALE || "1.0");
const MARGIN = Math.max(720, parseInt(process.env.TAKKEN_MARGIN || "1080", 10));
const OUT_Q = process.env.TAKKEN_OUT_Q || "問題編.docx";
const OUT_A = process.env.TAKKEN_OUT_A || "解答解説編.docx";

// フォントは環境変数で差し替え可（例: Mac は "Hiragino Sans"、Windows は "Yu Gothic"）
const MINCHO = process.env.TAKKEN_FONT || "IPAGothic";
const GOTHIC = process.env.TAKKEN_FONT || "IPAGothic";

// half-point 単位。下限は8pt = 16 half-point
const sz = (base) => Math.max(16, Math.round(base * SCALE));
const SZ_BODY = sz(21);
const SZ_LABEL = sz(22);
const SZ_EXPL = sz(20);
const SZ_TITLE = 28; // 14pt 固定（スケール対象外）

const questions = require(path.resolve("./questions.js"));
const explanations = require(path.resolve("./explanations.js"));
const emap = new Map(explanations.map((e) => [e.num, e]));

function titleParagraph(sub) {
  const out = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 },
      keepNext: true,
      children: [
        new TextRun({
          text: TITLE,
          bold: true,
          size: SZ_TITLE,
          font: { name: GOTHIC, eastAsia: GOTHIC },
        }),
      ],
    }),
  ];
  if (sub) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        keepNext: true,
        children: [
          new TextRun({
            text: sub,
            size: SZ_LABEL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
        ],
      })
    );
  }
  return out;
}

function docShell(children) {
  return new Document({
    styles: {
      default: {
        document: {
          run: { font: { name: MINCHO, eastAsia: MINCHO }, size: SZ_BODY },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: MARGIN,
              bottom: MARGIN,
              left: MARGIN,
              right: MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
}

/* ---------- 問題編 ---------- */
function buildQuestions() {
  const children = titleParagraph("第 1 部：問題編　／　最新法令準拠");

  for (const q of questions) {
    const head = `問 ${q.num}　${q.text}${q.ask}。`;
    // 問題文（問番号は太字）
    children.push(
      new Paragraph({
        spacing: { before: 160, after: 60 },
        keepNext: true,
        keepLines: true,
        children: [
          new TextRun({
            text: `問 ${q.num}　`,
            bold: true,
            size: SZ_LABEL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
          new TextRun({
            text: `${q.text}${q.ask}。`,
            size: SZ_BODY,
            font: { name: MINCHO, eastAsia: MINCHO },
          }),
        ],
      })
    );

    (q.items || []).forEach((it) => {
      children.push(
        new Paragraph({
          indent: { left: 240, hanging: 240 },
          spacing: { after: 20 },
          keepNext: true,
          keepLines: true,
          children: [
            new TextRun({
              text: String(it),
              size: SZ_BODY,
              font: { name: MINCHO, eastAsia: MINCHO },
            }),
          ],
        })
      );
    });

    q.choices.forEach((c, i) => {
      const last = i === q.choices.length - 1;
      children.push(
        new Paragraph({
          indent: { left: 240, hanging: 240 },
          spacing: { after: last ? 40 : 20 },
          keepNext: !last,
          keepLines: true,
          children: [
            new TextRun({
              text: `${MARKS[i]}．`,
              size: SZ_BODY,
              font: { name: GOTHIC, eastAsia: GOTHIC },
            }),
            new TextRun({
              text: String(c),
              size: SZ_BODY,
              font: { name: MINCHO, eastAsia: MINCHO },
            }),
          ],
        })
      );
    });
    void head;
  }
  return docShell(children);
}

/* ---------- 解答解説編 ---------- */
function buildAnswers() {
  const children = titleParagraph("第 2 部：解答・解説編（別紙）");

  for (const q of questions) {
    const e = emap.get(q.num);
    if (!e) throw new Error(`問${q.num} の解説がない`);

    children.push(
      new Paragraph({
        spacing: { before: 160, after: 40 },
        keepNext: true,
        keepLines: true,
        children: [
          new TextRun({
            text: `問 ${q.num}　`,
            bold: true,
            size: SZ_LABEL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
          new TextRun({
            text: `正解：${e.ans}`,
            bold: true,
            color: "C00000",
            size: SZ_LABEL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
        ],
      })
    );

    children.push(
      new Paragraph({
        spacing: { after: 20 },
        keepNext: true,
        keepLines: true,
        children: [
          new TextRun({
            text: "【解説】",
            bold: true,
            size: SZ_EXPL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
        ],
      })
    );

    e.lines.forEach((ln) => {
      children.push(
        new Paragraph({
          indent: { left: 240, hanging: 240 },
          spacing: { after: 20 },
          keepNext: true,
          keepLines: true,
          children: [
            new TextRun({
              text: String(ln),
              size: SZ_EXPL,
              font: { name: MINCHO, eastAsia: MINCHO },
            }),
          ],
        })
      );
    });

    children.push(
      new Paragraph({
        indent: { left: 240, hanging: 240 },
        spacing: { after: 60 },
        keepLines: true,
        children: [
          new TextRun({
            text: "ひっかけ：",
            bold: true,
            color: "1F6B2E",
            size: SZ_EXPL,
            font: { name: GOTHIC, eastAsia: GOTHIC },
          }),
          new TextRun({
            text: String(e.trap),
            color: "1F6B2E",
            size: SZ_EXPL,
            font: { name: MINCHO, eastAsia: MINCHO },
          }),
        ],
      })
    );
  }
  return docShell(children);
}

(async () => {
  fs.writeFileSync(OUT_Q, await Packer.toBuffer(buildQuestions()));
  fs.writeFileSync(OUT_A, await Packer.toBuffer(buildAnswers()));
  console.log(
    `generated: ${OUT_Q} / ${OUT_A}  (scale=${SCALE}, margin=${MARGIN}, body=${SZ_BODY / 2}pt)`
  );
})();
