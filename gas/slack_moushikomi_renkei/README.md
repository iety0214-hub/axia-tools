# AXIA申込→Slack連携（GAS）

Apps Script「AXIA申込→Slack連携」の中身。clasp で反映する。

```
cd gas/slack_moushikomi_renkei
npx @google/clasp login      # 初回だけ（iety0214@gmail.com）
npx @google/clasp push -f
```

| ファイル | 役割 |
|---|---|
| コード.gs | axia-japan@googlegroups.com 宛の申込・オープン・訂正メールを #案件進捗 に投稿／取り消し線／差し替えする。`doGet` は契約作成依頼アプリ（AXIA_Slack契約作成依頼.html）から投稿スレッドを引くウェブアプリ |

Slack のトークンはスクリプトプロパティ `SLACK_BOT_TOKEN` に入れてある（コードには書かない）。

デプロイは @HEAD の1つだけなので、push すればトリガーもウェブアプリもそのまま新しいコードで動く。

※ push するとこのフォルダの .gs が Apps Script 側を丸ごと上書きする。
