# Security・信頼境界 v0.2

将来設計の要件。現在のアプリを安全と認定する報告ではない。

## 1. 早期対応が必要な現状

UPSTREAM_AUDITのA02〜A05を参照。`csp: null`、広い`fs` permission、AIの既定file_writeと`workspace-write`、上流updater設定を確認した。これはsource上の設定確認であり、攻撃成立や利用者被害を実証したものではない。

## 2. 信頼モデル

不信頼: 開いたMarkdown、HTML、SVG、draw.io XML、画像metadata、Mermaid、外部URL、AI出力、取得したREADMEや文書内命令。
信頼: 署名・version固定したアプリコードと、backendが認可した限定operation。ただしRust backendも自動的に安全とはしない。

分離する領域は通常UI、文書preview、図editor、filesystem broker、AI subprocess、provider network。文書のrendererへUIの特権IPCを渡さない。

## 3. 制御

| 脅威 | 要求する制御 | 担当 |
|---|---|---|
| HTML／SVG内script、event、javascript URL | allowlist sanitize＋CSP＋隔離表示。raw bytes保存と表示コピー分離 | T04,T11 |
| SVG foreignObject、外部font／画像／CSS | untrusted previewで能動機能と外部通信を拒否。壊れた見た目は明示 | T04,T11 |
| path traversal、symlink、junction、UNC、TOCTOU | backendでcanonical path／handleを検証。許可rootを超える参照は明示grant | T05,T08 |
| XML entity／圧縮bomb／巨大画像 | DTD・外部entity禁止、解凍後byte／pixel上限、timeout | T11,T16 |
| postMessage偽装 | source window、exact origin、session nonce、schema、sizeを検証 | T16 |
| AI文書内prompt injection | 文書を権限命令にしない。source folderのAGENTS／MCP／skillsを無条件に継承しない | T19,T20 |
| AIの原本／他file書換え | Ask write禁止、Proposeをcandidate化、host ApplyとCAS | T19,T20 |
| stale提案、dirty上書き、crash | revision／hash検証、journal、snapshot、手動回復 | T08,T20 |
| forkが上流binaryへ更新される | identifier／更新先／署名鍵の分離、未設定では更新無効 | T02,T24 |
| 供給網 | versionとlockfile固定、license／SBOM、署名・checksum、release承認 | T01,T02,T24 |

## 4. CSP・Capabilities

release用CSPを明示し、developmentだけの許可を本番へ残さない。CSP文字列を他製品から盲目的にcopyせず、実際のasset／style／worker要件を列挙して最小許可にする。default fs `**`を文書previewへ提供しない。Tauri公式はCapabilitiesだけでは不正なRust commandや緩いscopeを防げないと説明している。[CSP](https://v2.tauri.app/security/csp/)／[Capabilities](https://v2.tauri.app/security/capabilities/)

draw.ioは同梱assetを隔離editorで使う案を優先する。公式embed protocolのhosted構成を、単に相対URLへ変えれば本番オフライン対応になると仮定しない。spikeで各OSのorigin、CSP、メッセージと必要資産を検証する。opaque originしか得られない場合はoriginだけで認証せず、独立WebView＋権限なしbridgeを設計し直す。

## 5. AI権限

UIのチェックボックスやプロンプトだけを権限境界にしない。provider API／OS sandboxとhost側で強制する。read-onlyが任意fileの読取を制限するとは限らないことを検証する。temp作業dirだけでは隔離と扱わない。

通常UIにapproval／sandbox bypassを設けない。providerが要求を満たせなければAsk限定または無効にし、こっそり権限を広げない。権限が変わったsessionをresumeしない。

通信は、クラウド推論に必要な宛先許可と追加web toolを分ける。画像添付前に対象・容量・送信先を表示する。view-only時にAIを自動呼出ししない。カメラや全画面captureはv1に不要。

## 6. 保存・秘密情報

tokenは既存CLI認証またはOSの安全な保管に委譲し、repo／Markdown／consoleへ書かない。auditはaction、resource ID、許可結果、hash等に絞る。履歴・snapshot・添付一時画像はprivate領域で保存し、削除と保持期間のUIを用意する。

## 7. releaseを止める条件

閲覧だけで未許可通信／script実行、previewから任意file write、Askから原本write、Rejectで原本変更、無断上書き、誤updater、署名検証の黙示bypassはいずれもblocker。負例の実行証跡なしに安全機能を完了しない。
