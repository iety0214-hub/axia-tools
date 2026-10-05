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

トリガーは @HEAD で動くので、push すればそのまま新しいコードになる。

ウェブアプリ（`doGet`）は版を固定したデプロイ `AKfycbzhld5E17COxKKp_L7CLezAbS7H_XGPZNjeWztU9C7GDXm63GTjlx4X7s6XDNSWXsTKmA` で公開している（契約作成依頼アプリにこのURLを埋め込み済み）。`doGet` まわりを直したときは、URLを変えずに同じデプロイを新しい版に差し替える。

```
npx @google/clasp push -f
npx @google/clasp deploy -i AKfycbzhld5E17COxKKp_L7CLezAbS7H_XGPZNjeWztU9C7GDXm63GTjlx4X7s6XDNSWXsTKmA -d "申込スレッド検索"
```

※ push するとこのフォルダの .gs が Apps Script 側を丸ごと上書きする。
