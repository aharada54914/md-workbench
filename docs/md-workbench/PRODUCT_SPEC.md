# 製品仕様 v0.2

状態: レビュー用。明示された利用者要件と、設計側の推奨初期値を分ける。

## 1. 目的・対象外

`.md`をダブルクリックして読むことを最短経路とし、必要時だけ文章・図の編集とAIを使える単独デスクトップアプリにする。VS Codeの機能を再現することは目的ではない。Vault登録・Git初期化・ログイン・クラウド同期を閲覧の前提にしない。

必須はファイル関連付け、GUI作図、外部／内蔵の双方向変換、AIへの質問・修正依頼の4点。一般PNGの図形復元、任意SVGのフルベクトル編集、共同編集、モバイル、plugin市場、汎用IDEはv1の対象外**という提案**であり、利用者が任意SVGの編集を求める場合はscopeを再検討する。

## 2. 対応環境と優先度

推奨初期案: Windows 11 x64を主受入対象、macOS Apple Siliconを互換性確認対象とし、上流のLinuxビルドを不必要に壊さない。最終対応OS、最低OS版、installer権限、署名体制はDECISIONSで合意する。利用者の端末を推測して確定しない。

P0はv1必須。R番号は仕様の安定ID、T番号は実装計画ID。機能が存在するだけで受入済みとはしない。

## 3. 機能・非機能要件

| ID | 優先 | 要件・受入の要点 |
|---|---|---|
| R01 | P0 | `.md`／`.markdown`をOS関連付けで直接開く。cold／warm・複数ファイル・日本語パスを扱い既定アプリを強制変更しない |
| R02 | P0 | 閲覧／Source／Visual／Splitを切替可能。初回は閲覧を推奨。AIパネルは折畳み可。特定の3列配置を強制しない |
| R03 | P0 | GFM・表・code fence・数式・front matter・日本語IMEを扱う。無編集保存では元bytesを変えない。編集不能構文はSourceへ退避 |
| R04 | P0 | PNG／SVGを挿入・表示・出力。draw.io編集データを持つ画像は図形再編集可能と区別。任意PNGからの図形復元は保証しない |
| R05 | P0 | MermaidをGUIで編集。flowchartを最低必須とし、sequence／state／class／ERはspikeで能力確認。不対応操作は理由とSource fallbackを示す |
| R06 | P0 | draw.ioで図形・線・ラベルをGUI編集しXMLを保持。通常PNG／SVGと編集データ付き出力を分ける |
| R07 | P0 | PNG／SVGの外部参照↔data URI格納を双方向変換。変換だけなら元bytes・metadataを保持 |
| R08 | P0 | Mermaid fence↔`.mmd`外部ソースを双方向変換。コードと日本語・改行を保持 |
| R09 | P0 | draw.io fence↔`.drawio`外部ソースを双方向変換。XMLを表示画像へ無断flattenしない |
| R10 | P0 | 資産と文書をまたぐ保存にjournal・hash検証・障害回復を持つ。既存ファイルを無断上書き／削除しない |
| R11 | P0 | 不明なMarkdown／HTML／SVG／図は不信頼入力。閲覧でscript、shell、外部通信、特権IPCを起動しない |
| R12 | P0 | 読み書き先をbackendで認可。relative path、symlink、junction、UNC、パストラバーサルを扱う |
| R13 | P0 | AIへ選択文・対象図・文書について質問できる。Askは原本へのwrite禁止。未設定でも閲覧と作図が動く |
| R14 | P0 | AI修正を候補として表示しApply／Reject／Cancel。承認後にホストがrevisionを再確認して適用する |
| R15 | P0 | 図sourceと描画画像を区別して送信前に選択・確認する。画像送信の失敗を黙ってsource推測で置き換えない |
| R16 | P0 | AI、draw.io編集runtime、Mermaid GUI、重いexportを必要時だけload。単なる閲覧でAI子プロセスを起動しない |
| R17 | P0 | 同じ端末・文書・条件で上流とVS Codeのcold／warm時間、プロセス群メモリ、操作遅延を測定する |
| R18 | P0 | fork独自のアプリID、設定領域、更新元、署名、配布ゲート、license通知を持つ |
| R19 | P0 | Markdownと資産を正本とし、独自記法はversion付き・可逆・未知version保持。外部図は他viewerでもsourceリンクとして残る |
| R20 | P0 | dirty文書の外部変更、snapshot、crash復旧、Undo、共有資産を扱い黙って更新を失わない |

## 4. 画面と主操作

上部は開く／保存／閲覧・編集モード、本文は単列またはsource＋preview、右は必要時のみAI。図のtoolbarは「編集」「AIに質問」「AIで修正」「内蔵」「外部へ」「出力」「元ファイル」を能力に応じて表示する。画像の外部化はexportと区別する。

Resource状態は読込中・表示可・編集可能・読取専用・見つからない・形式不正・権限待ち・変更競合を表示。無効ボタンに理由を付け、keyboardと日本語ラベルを提供する。

### 閲覧

OSから指定されたファイルを開く。未保存文書や復旧候補があるときに勝手に置換しない。文書内の外部URLは自動取得しない。リンク先が欠落していても本文を読める。

### 図編集

対象resourceのrevisionを固定しcandidateを開く。GUI編集は保留データへ反映しApplyでcommit、Cancelで破棄。元文書または外部ファイルが変わればstaleを通知し再読込／再提案を選ぶ。

### 内蔵／外部の変換

対象・保存先・増加容量・既存ファイル衝突を事前表示。未保存文書で相対パスを作る前に文書保存先を決める。外部化先は初期案`<文書名>.assets/`。元ファイルは残す。共有資産の削除は自動化しない。

### AI

初期案はCodexを優先し、既存Claude経路も安全条件を満たす範囲で維持。AskとProposeは明示選択する。クラウド推論の通信と、AIによるweb／shell tool使用許可は別項目。応答を原本に直接writeさせず、差分を承認後にホストが適用する。

## 5. 性能・容量の提案値

通常fixtureはUTF-8 100KiB、画像2枚、図なし。参照端末・WebView版を固定したうえでcold process launch P50≤1.5秒、warm open P50≤0.8秒を目安とする。これは実測値でも保証値でもない。

旧案のidle RSS≤180MBはOS間で同一指標にならないため、そのまま合否値にしない。Windowsのprivate bytes／working setとmacOS physical footprintを別々に報告し、初期の180MiB目安をT03で再合意する。10MiB文書・10図・大きなdata URIを別stress fixtureで測る。

暫定安全上限: 画像20MiB/件、総内蔵50MiB、展開XML20MiB/件、render timeout 5秒。上限はサイズを表示して拒否し、切詰めや無断外部送信はしない。正式値はT03／T16で調整する。

## 6. v1の出口

全R要件にTEST_PLANの証跡を持ち、draw.io編集は通信遮断でも利用可能とする案を採る。外部embedを使うspikeは明示opt-inの非配布検証に限定する。未達機能は制限として公開し、表示・AI生成だけでGUI編集要件を達成扱いしない。
