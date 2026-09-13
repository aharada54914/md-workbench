# 受入・検証計画 v0.2

**下表は実行予定。現在はアプリの実機試験・ビルド・性能測定を実施していない。**

## 1. 品質ゲート

G0: 上流固定・既存テスト結果・fork更新／配布分離・初期脅威モデル。
G1: 保存形式承認・parser・journal・安全な描画／FS。
G2: 4形式の往復変換・GUI編集・日本語編集。
G3: AIのAsk／Propose／Apply・画像文脈・負例。
G4: 実機性能・installer・署名・SBOM・利用者承認。

ブラウザmockでTauri IPCを置き換えたE2Eだけでは、OS関連付け・filesystem認可・process sandboxの合格証明にならない。

## 2. 要件と受入ケース

| Case | R | 必須シナリオ |
|---|---|---|
| AT01 | R01 | app未起動／起動済みから日本語.mdを開く。複数指定・関連付け解除・他app共存 |
| AT02 | R02 | 閲覧／Source／Visual／Splitの切替、keyboard、未保存確認、AI折畳み |
| AT03 | R03 | 日本語IME composition中の保存・Undo・モード切替、BOM／CRLF／表／数式／front matter保持 |
| AT04 | R04 | PNG／SVG挿入、draw.io metadata有無の区別、再編集とflatten exportの違い |
| AT05 | R05 | MermaidのGUIラベル／ノード／線編集。対応type能力表と未知構文fallback |
| AT06 | R06 | draw.io新規／再編集／複数page、オフライン、save／cancel／timeout |
| AT07 | R07 | 画像external→embedded→externalのhash一致、破損Base64、名前衝突、大きな画像 |
| AT08 | R08 | .mmdとfenceの往復。backtick、Unicode、改行、共有参照、外部変更 |
| AT09 | R09 | XMLとdrawio fenceの往復。圧縮XML、壊れたXML、保存モード切替 |
| AT10 | R10 | journal各段階でkill、disk full、権限拒否、replace失敗、hash競合から回復 |
| AT11 | R11 | script／onerror／javascript／foreignObject／外部CSS／圧縮bombの拒否。未許可通信ゼロ |
| AT12 | R12 | ../、percent encoding、absolute、UNC、symlink、junction、TOCTOU、許可外write拒否 |
| AT13 | R13 | Askで原本と許可外fileのhash不変。認証なし／providerなしでも文書閲覧可 |
| AT14 | R14 | Propose→Reject、Cancel、stale、Apply。承認前は原本hash不変 |
| AT15 | R15 | source／render添付の選択、revision対応、切れた画像、非対応provider、画像削除 |
| AT16 | R16 | AI未使用・図編集未使用で対象runtime／process未起動。文書数増加時の解放 |
| AT17 | R17 | 同一fixtureで起動／プロセス群メモリ／操作応答を測る |
| AT18 | R18 | アプリID／更新先分離、署名、更新失敗、downgrade、SBOM、release trigger |
| AT19 | R19 | 他viewerでsourceリンクが残る、未知marker version保持、最小diff |
| AT20 | R20 | dirty＋file watcher、crash復旧、shared asset Undo、旧AI sessionのscope変更 |

## 3. fixtureセット

F01: UTF-8 100KiB本文＋画像2枚、F02: 10MiB Markdown、F03: Mermaid 10図、F04: 最大許可data URI、F05: draw.io複数pageとmetadata付きPNG／SVG、F06: 上記攻撃fixture、F07: 日本語・space・長path・BOM・CRLF。

実文書・機密情報ではなく人工データを使う。fixture versionとSHA-256を保存し、生成seedとdependency versionを記録する。

## 4. 性能測定

端末仕様、OS、WebView、電源、画面scale、virus scanner、app version、provider停止状態を記録。cleanなrelease buildを使いdev serverやdebug binaryと比較しない。

T0はOS open要求、T1は本文の最初の読めるframe、T2は初期viewport図の表示完了。cold process launchとOS reboot後のcold cacheを区別し、warmは起動済みprocessへのopenとする。

通常cold 30回、warm 50回を初期案とし、試行毎のraw値・P50／P95・sample数・失敗を保存。単発の最速値で判断しない。Windowsはprocess treeのprivate bytesとworking set、macOSはphysical footprintを別指標として計測し、WebView子processを除外しない。共有pageを単純合算した値の限界も記載する。

比較はupstream MerMark、VS Code（拡張なしと同等機能構成を区別）、fork。Folynは候補比較時のみ追加。容量≠メモリ、Tauri採用≠実測上高速である。

暫定目標はPRODUCT_SPECを参照。測定端末決定後に固定し、未達ならcache／lazy-load／viewportレンダリングを改善、または利用者承認付きで目標変更する。

## 5. 実装PRの証跡

`pnpm install --frozen-lockfile`、`pnpm test:run`、`pnpm build`、`pnpm test:e2e`、`cargo test --manifest-path src-tauri/Cargo.toml`を出発点に、対応するOS前提と上流の実際のconfigをT01で確定する。GUI実機項目は録画／手順・結果を添える。

各PRはT番号、R番号、Case番号、結果、実行環境、未実施理由を記す。test存在とtest成功を区別する。baseline失敗を勝手に削除して緑にしない。
