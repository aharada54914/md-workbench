# 設計判断・未決事項 v0.2

`採用（計画）`は今回の設計方針、`提案`は利用者承認前、`要実証`はspike合格前。どれも実装済みを意味しない。

## ADR-0001: MerMark forkを基盤とする

状態: 採用（計画）。利用者が`aharada54914/md-workbench`を作成したため、このforkで仕様と検証を進める。

既存のTauri／Vue／Tiptap／CodeMirror／AIを活用し、全体rewriteを避ける。Folynはdraw.io統合の参考、Yank Noteはresource操作の参考とする。ただしコード流用前には各ファイルとdependencyのlicenseを確認する。性能比較で根本的な不適合が出た場合のみ、証跡をもとに再検討する。forkをやり直すことを最初の作業にしない。

## ADR-0002: 外部resourceの記法

状態: 提案。通常Markdown画像、通常リンク＋version付きmarker、標準Mermaid fence、drawio fenceを使う。

理由: 見えないコメントだけを正本にすると他viewerで何も残らない。link targetをsourceパスの唯一の正本にし二重管理を避ける。独自記法を標準Markdownで全て描画可能と宣伝しない。T07で承認してから永続形式を実装する。

## ADR-0003: 原本writeをホストに集約

状態: 採用（計画）。GUIとAIはcandidateを返し、hostがrevision検証後にcommitする。

理由: AIの直接write後にsnapshotで戻す方式は、承認前不変の要件を満たさない。backend認可・CAS・journalを共有し、write経路ごとの抜け道を減らす。

## ADR-0004: 作図engineは既存部品を使う

状態: 要実証。Mermaid GUIはVisimer core／domを第一候補、draw.ioは公式engine／protocolを候補とする。

VisimerのREADME上の編集対応を自社appでの互換性保証としない。Vue・日本語・未知構文・version pinをT13で検証する。draw.ioは同梱でoffline動作を目標にし、asset再配布とorigin／CSPをT16で実証する。失敗時は承認済みscopeと代替案を記録し、単なるAI生成をGUI編集の代用としない。

## ADR-0005: AI providerの通信方式

状態: 要実証。既存Codex exec経路を監査し、公式app-server stdioを比較候補にする。最初から全面置換しない。

公式app-serverは深いclient統合に向く一方、使用transport／protocolの成熟度と互換性はversion毎に確認する。認証・画像・resume・approval・cancelを契約テストにする。未知protocolでは権限を緩めずfail closed。Claude／local endpointを後退させる場合も理由を記載する。

## ADR-0006: 閲覧優先・重い機能は遅延起動

状態: 採用（計画）。AI・GUI engine・exportを必要時だけloadする。SourceとVisualを常時両方起動する必要はない。具体的な性能値は実測後に合意する。

## 利用者との決定待ち

| ID | 提案初期値 | 確定する時点 |
|---|---|---|
| D01 | Windows 11 x64優先、macOS Apple Siliconも検証 | T01／T03開始時 |
| D02 | 起動時は閲覧、前回モード記憶は設定可能 | T05／T06 |
| D03 | 任意PNG／SVGのフル編集ではなく、draw.io生成物を再編集 | T11前。要件追加なら別scope |
| D04 | `<文書名>.assets/`とvisible link＋marker | T07承認時 |
| D05 | stableはoffline draw.io、online embedはopt-in spikeのみ | T16 |
| D06 | cold 1.5秒／warm 0.8秒は目標、memoryはOS別実測で決定 | T03 |
| D07 | AIはAsk初期値、原本直接write禁止 | T19／T20 |
| D08 | 製品名MD Workbench、installerはcurrent-user優先案 | T02／T24 |

未決事項は無関係な調査まで止めない。不可逆な記法固定・公開配布・権限緩和の前には合意を得る。
