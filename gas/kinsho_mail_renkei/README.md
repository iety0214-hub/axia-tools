# AXIA金消メール連携（GAS）

Apps Script「AXIA金消メール連携」の中身。clasp で反映する。

```
cd gas/kinsho_mail_renkei
npx @google/clasp login      # 初回だけ（iety0214@gmail.com）
npx @google/clasp push -f
```

| ファイル | 役割 |
|---|---|
| コード.gs | 【本承認】メール → 承認日の反映。Supabase接続先 `CFG` もここ |
| 申込追記.gs | 【申込】メール → 金消アプリに行を追加（担当・同行も入れる）、毎朝の繰り越し |
| 販売一覧連携.gs | 販売一覧との連携 |

※ push するとこのフォルダの .gs が Apps Script 側を丸ごと上書きする。
