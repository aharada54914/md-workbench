# 固定 draw.io の Chromium 観測（非製品 spike）

## 結果と対象

v31.4.5 の未改変配布物を別オリジン iframe で起動し、人工 XML の図形ラベルを実際の UI で `SPIKE BEFORE` から `SPIKE AFTER` に編集、Save → Exit をクリックして `init/load/save/exit` を受信した。保存候補は非圧縮 XML 824 bytes。人工 XML 中の外部画像、fetch、WebSocket、Worker、Service Worker、CSS 画像、inline script の負例は CSP で遮断された。

これは有限の Chromium 操作の再現資料であり、**T16/#26 の受入、native WebView の隔離、nonce 対応、全機能の offline 対応、配布ライセンスの完了を意味しない**。既存 synthetic CI の missing native receipt 条件は変更しない。製品依存・通常ルート・native IPC・永続化は追加しない。

## 固定入力

| 項目 | 固定値 |
| --- | --- |
| Release | [v31.4.5](https://github.com/jgraph/drawio/releases/tag/v31.4.5) |
| 公式 download | [draw.war](https://github.com/jgraph/drawio/releases/download/v31.4.5/draw.war) |
| Commit | `f3abfe0f082c18f7b4fee8a34c2d07b1987687fd` |
| Annotated tag object | `29bf16aa1b69cb51fc2223ac7d63f120f3de9ed7` |
| WAR bytes | 53,739,401 |
| WAR SHA256 | `6ee1ce19242bbabf348c52e41e1fe17057d57236e731acf48d7a3710ca50c375` |
| 固定 manifest SHA256 | `1e46b33115fc440cd871ea8d6bc7ea9caeb419fd9792b6b7afc0d645e6e488ef` |
| 抽出 subset | 2,308 files / 36,332,532 bytes |

[manifest](../../scripts/drawio-vanilla-spike/manifest.json) はパス・サイズ・SHA256 一覧のみ。WAR・上流 assets はリポジトリに含めない。署名や再現 build の検証はしていない。core index/bootstrap/main/PreConfig/PostConfig/app/shapes/stencils/extensions、styles/images/img/mxgraph 資産、英語/日本語 locale などを選択する。Java server、templates、plugins、math4、viewer/export、Service Worker のルートは含めない。`img` 全体を含むため最小サイズの証明ではない。

manifest 自体を信頼せず固定 digest・件数・総量・個別サイズ・パス/重複を確認する。ZIP 全体の digest・総量・エントリー数・重複・symlink/escape を拒否し、選択した全 bytes を検証してから新規 `assets/` を作る。runner は symlink と全 asset hash を起動前に確認し、各応答にも hash 検証する。同じ OS ユーザーによる実行中の作業ディレクトリ改変に対する native 権限境界ではない。

## 再現

Node、Python 3、既存のプロジェクト依存と Playwright Chromium が必要。新しい依存・CI job は不要。リポジトリ root から実行する。`SPIKE_WORK` は自分が所有する**新規の作業ディレクトリ**へ設定し、`drawio.war` という名前で公式 WAR を保存する。

```sh
mkdir "$SPIKE_WORK"
curl --fail --location https://github.com/jgraph/drawio/releases/download/v31.4.5/draw.war --output "$SPIKE_WORK/drawio.war"
python3 scripts/drawio-vanilla-spike/extractor.py --work-dir "$SPIKE_WORK"
node scripts/drawio-vanilla-spike/runner.mjs --work-dir "$SPIKE_WORK" --output-dir "$SPIKE_WORK/baseline" --mode baseline
node scripts/drawio-vanilla-spike/runner.mjs --work-dir "$SPIKE_WORK" --output-dir "$SPIKE_WORK/final" --mode approved-xml-negative
node scripts/drawio-vanilla-spike/checker.mjs --work-dir "$SPIKE_WORK" --report "$SPIKE_WORK/final/report.json"
DRAWIO_SPIKE_TEST_WORK_DIR="$SPIKE_WORK" node --test scripts/drawio-vanilla-spike/contract.test.mjs
```

`--work-dir`/`--output-dir`/`--mode` は明示必須。mode は `baseline`、`approved-style-data`、`approved-xml-negative` のみ。抽出先 `assets/` と output directory は既存なら拒否する。再実行は別の新規 output directory を使う。検証失敗・起動失敗は非ゼロ終了し、生成済み report に原因を記録する。入力/CLI 検証など出力作成前の失敗は stderr に記録する。サーバーの一部だけが起動した場合も終了時に閉じる。

固定ポート `127.0.0.1:16631`（wrapper）、`:16632`（editor）を使用する。他の runner と並行実行しない。負例は loopback `:16633` のみで、実文書や外部サービスへは送らない。測定後に browser と server は閉じる。rollback は自分で指定した作業ディレクトリと観測出力を削除するだけで、製品データの移行はない。

## CSP と観測方法

iframe は別 origin、sandbox `allow-scripts allow-same-origin`。GET の固定パスだけを配信し、未知 path は 403。HTTP(S) の外部 route は Playwright で abort する。

Baseline:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'; worker-src 'none'; manifest-src 'none'
```

Baseline は init/load まで動いたが inline CSS と data icons が拒否され、UI の配置・アイコンが崩れた。この isolated spike に限って承認された変更は **`style-src 'self' 'unsafe-inline'` と `img-src 'self' data:` のみ**。script inline/eval は許可せず、その他の directive と上流 asset は変更していない。製品 CSP への承認ではない。

固定 URL query は `embed=1&proto=json&stealth=1&local=1&plugins=0&math=0&pwa=0&drafts=0&sync=none&lang=en&libraries=0&saveAndExit=1`。ただし upstream PreConfig が `sync` を `manual` に変更するため query 単独を通信遮断の証明にしない。

Host は current iframe の source/origin、文字列長を確認して人工 XML を load し、save 候補をメモリーで観測する。nonce adapter、production schema、XML 安全性検証ではない。Exit 後も負例測定のため frame を残すので、破棄・cancel・session retirement は証明しない。

## 保存された実測

[compact report](drawio-vanilla-observation.json) は repository runner を新規作業ディレクトリで再実行した 2026-09-16 の観測。Node v24.13.0、Playwright 1.58.2、Chromium 145.0.7632.6、Darwin 25.6.0 arm64。環境固有の絶対パスと文書 XML は保存していない。

- 新規抽出、WAR と全 2,308 asset hash、checker が PASS。
- スクリプト検証 13 tests PASS（起動失敗の cleanup・上書き拒否を含む）。環境変数未指定なら asset が必要な 2 tests は skip と表示する。
- 実 UI 編集→Save→Exit、非圧縮候補 824 bytes、`AFTER` が存在し `BEFORE` が消えた。page error 0。
- ローカル server 20 requests、うち 15 distinct allowed assets / 22,951,973 bytes。他に locale の再読取、`/null` image 403 と意図した未知 path 403。
- 外部 HTTP route entry 0。CSP 違反 8 件。許可 locale の GET 200、未知 manifest path の 403 を server 側でも確認した。

| 負例 | 根拠 |
| --- | --- |
| XML 画像・直接 Image・CSS background | `img-src` 違反と requestfailed `csp`。外部 HTTP route entry なし |
| fetch | `connect-src`、TypeError。外部 HTTP route entry なし |
| WebSocket | `connect-src` 違反。constructor 成功を接続成功として扱わない |
| Service Worker | `worker-src`、SecurityError、登録数 0。local server request なし |
| Worker | `worker-src`、local server request なし。constructor 成功を起動成功として扱わない |
| inline script | `script-src-elem`、実行 marker false |

Browser request event は CSP 拒否された画像にも発生するので wire と数えない。HTTP route hook は WebSocket を捕捉しないため WebSocket は CSP event による証拠であり、packet capture/handshake 観測ではない。Playwright init-script/evaluate は観測器で、page CSP を受けない。Service Worker は browser context 側で許可した状態で CSP の拒否を確認した（初期実験の context-level block による擬似結果は採用しない）。

`/null` は起動時の upstream image request。403 のまま扱い、許可リストを広げなかった。後の DOM snapshot には該当一時画像がなく、正確な発生元は未特定。core JS/CSS の欠損はこの操作では見つからなかったが、他機能の asset 充足は未検証。

## 配布前に残る事項

- [root LICENSE](https://github.com/jgraph/drawio/blob/f3abfe0f082c18f7b4fee8a34c2d07b1987687fd/LICENSE) は Apache-2.0。WAR の subset だけでは root notice が揃わない。
- [img/LICENSE](https://github.com/jgraph/drawio/blob/f3abfe0f082c18f7b4fee8a34c2d07b1987687fd/src/main/webapp/img/LICENSE)、shapes/stencils の notice には Atlassian ecosystem 向け制限がある。個別アイコンの権利も棚卸しが必要。
- [build.xml](https://github.com/jgraph/drawio/blob/f3abfe0f082c18f7b4fee8a34c2d07b1987687fd/etc/build/build.xml#L488) が `extensions.min.js` に libavoid を組み込む。[LGPL-2.1 notice](https://github.com/jgraph/drawio/blob/f3abfe0f082c18f7b4fee8a34c2d07b1987687fd/src/main/webapp/js/libavoid-js/LICENSE) を含む source/notice/配布義務の確認は未完了。今回の抽出は配布可能性の認定ではない。
- 全ライブラリ、templates、math、font、import/export、popup/navigation/download、圧縮/巨大/不正 XML、悪意ある HTML、資源上限、異常終了、Save & Exit は未検証。
- Native WebView2/WKWebView、custom protocol origin、fs/shell IPC 非公開、nonce/session/schema、stale/replay 拒否、保存 transaction は未統合・未受入。T16/#26 と既存 missing native receipt を合格扱いしない。
