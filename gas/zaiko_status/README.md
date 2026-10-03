# 在庫ステータス自動更新（GAS）

Apps Script「在庫ステータス自動…」の中身。clasp で反映する。

```
cd gas/zaiko_status
npx @google/clasp login      # 初回だけ（iety0214@gmail.com）
npx @google/clasp push -f
```

| ファイル | 役割 |
|---|---|
| コード.gs | axia-japan@googlegroups.com 宛のメールの【種別】を見て、販売可能物件一覧「在庫状況全て」の現況を書き換える（申込→2.申込中、契約→3.契約済み、事前承認→4、本承認→5、金消→6.金消済み、オープン→1.販売可） |

読むのは【種別】【顧客名】【物件名】【号室】（オープンは【内容】）だけで、持込予定・契約予定・決済予定などの日付欄は使わない。

※ push するとこのフォルダの .gs が Apps Script 側を丸ごと上書きする。
