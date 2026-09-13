# 基本設計 v0.2

本書は将来設計。既存状態はUPSTREAM_AUDITを参照する。

## 1. 再利用境界

Tauri／Vue／Tiptap／CodeMirrorと既存Mermaid表示、AIパネル、snapshotは再利用候補。既存の文書write経路が今回の承認・競合契約を満たすかを別途試験する。新しい巨大frameworkへの置換、全moduleのrenameはしない。

| 責務 | 既存接点／新規案 |
|---|---|
| ViewとSource | 既存Tiptap／CodeMirror。source textが正本でVisualは投影 |
| Mermaid | `src/components/MermaidNode.vue`をadapterで拡張 |
| Provider | NEW `src/diagrams/`。Mermaid／draw.io／imageの能力表 |
| Resource | NEW `src/resources/`。parser、参照、source range、保存形式 |
| Transaction | NEW `src-tauri/src/resources/`。認可・hash・journal・save・recover |
| AI | `src-tauri/src/ai/process/codex.rs`等をprovider contractで包む |
| Context | NEW `src/ai-context/`。選択範囲・source・render添付 |
| Security | backend認可と描画隔離。CSPだけを境界にしない |

NEWは実装予定のpathで、現在存在すると主張しない。実装PRで既存命名へ合わせて変更してよい。

## 2. 正本とデータ型

Documentはraw bytes、復号したsource、revision、disk hash、encoding／BOM／改行情報を持つ。画像はraw bytes、図はcanonical sourceを保存し、SVGやpreview PNGは派生物とする。

```ts
type ResourceKind = 'image' | 'mermaid' | 'drawio';
type Storage = 'embedded' | 'external';
interface ResourceRef {
  id: string;
  kind: ResourceKind;
  storage: Storage;
  documentRevision: number;
  sourceSpanUtf16: { from: number; to: number };
  sourceHash: string;
  externalPath?: string;
  mime?: 'image/png' | 'image/svg+xml';
  capabilities: { visualEdit: boolean; embed: boolean; extract: boolean };
}
interface ResourceEdit {
  resourceId: string;
  expectedRevision: number;
  expectedHash: string;
  candidate: string | Uint8Array;
}
```

TypeScriptのoffsetはUTF-16、Rustはbyte offset。境界で明示変換し、revisionが異なるrangeを適用しない。IDは保存metadataがあれば利用し、既存文書ではsession内の位置＋hashで識別する。IDが同じ別ブロックを見つけたら再採番を提案し勝手に同一resourceとみなさない。

## 3. Provider契約

`probe`で形式・安全性・GUI編集可否を判定し、`render`は隔離された描画結果、`beginEdit`は保留session、`export`は派生物を返す。`commit`とファイル削除はproviderに与えない。全providerの保存はTransactionServiceだけを通す。

各operationはAbortSignal、timeout、byte上限、revisionを受け、failureはtyped errorへ正規化する。GUI能力は形式／図種ごとに返し、Mermaid表示可とGUI構造編集可を分ける。入力をそのままtrusted HTMLとして挿入しない。

## 4. 状態遷移

Document: `Closed → Loading → Clean ↔ Dirty → Saving → Clean`。外部更新とdirtyが重なると`Conflict`、中断journalがあれば`RecoveryRequired`。Conflictから自動上書きでCleanへ戻さない。

図編集: `Idle → LoadingEditor → EditingCandidate → Review → Applying → Committed`。Cancelは原本不変、timeoutは原本を残してError、source revision不一致はStaleへ。draw.ioのautosaveイベントは候補更新でありdisk commitではない。

AI: `Idle → ContextConfirmed → Running → ProposalReady → Review → Applying → Applied`。AskはRunning→Answeredで終了し原本write不可。Cancelは子プロセス停止と候補破棄を確認して終える。

## 5. 永続化

複数ファイルの本当のatomic transactionは仮定しない。Resource変換は、事前認可→元hash／revision固定→snapshot→journal PREPARED→資産temp write→flush／rename→ASSET_DURABLE→文書CAS／atomic replace→DOCUMENT_DURABLE→COMPLETEDで進める。

文書commitが成立する前に参照先をdurableにする。中断後のhashが期待値と違えば勝手にrollbackせずRecoveryRequiredにする。文書未更新で残った新規資産はorphan候補として記録し、利用者確認なしで消さない。詳細はRESOURCE_FORMATを参照。

## 6. AIとファイル権限

既存AI UIを活用しても、原本へ直接書く既存既定値は引き継がない。最小経路はsourceと候補テキストを受け渡し、ホストが保存する。agentによるファイル編集が必要な場合は承認したコピーだけのstaging環境を利用し、OS／provider側で原本へwriteできないことを負例で検証する。

単に作業dirをtempへ変えるだけでは隔離にならない。read-only sandboxも読取範囲まで限定する保証ではない。権限を強制できないproviderではtoolsを無効化するか、対応モードを公開しない。クラウドmodelへの通信は明示許可し、追加web toolsは別認可とする。

session keyはprovider、document ID、policy fingerprint、workspace ID。policy変更で旧sessionをresumeしない。図のrender添付はsource revisionとrender hashを持ち、他画面を無断captureしない。

## 7. 起動と負荷

閲覧shell→軽量previewを先に表示する。Mermaid表示もviewport単位で処理し、GUI編集runtime・draw.io・AI・exportはdynamic import／on-demand processとする。cache keyはsource hash＋engine version＋theme。cache消失が文書データ消失にならない。

## 8. 実装順の制約

T02のfork更新先・release分離、T04の安全境界を早期に完了する。外部記法とtransaction契約を承認してからproviderを永続化につなぐ。Visimerとdraw.ioのspikeは独立してよいが、原本文書での利用はsecurityと保存ゲート通過後にする。
