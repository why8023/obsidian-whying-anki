# obak

Obsidian 桌面插件，用于把 Markdown 卡片块按阶段、单向同步到 Anki。

英文版说明见 `README.md`。

## 当前状态

目前已实现第 1 阶段到第 4 阶段：

- 解析 `card-start` / `card-back` / `card-end` 卡片块。
- 按文件校验卡片语法。
- 生成稳定的本地 `uid` 和 `rev` 哈希。
- 通过 `Vault.process()` 原子重写 `card-end` 元数据。
- 持久化本地索引，用于后续同步和删除阶段。
- 通过 AnkiConnect 连接 Anki。
- 同步前自动创建并校验 `OBAK Basic` 模型。
- 添加新笔记前自动创建缺失的牌组。
- 使用 `addNote` 创建新笔记。
- 使用自定义字段集和 `changeDeck` 更新已有笔记。
- 通过待删除队列删除已移除的笔记。
- 在启动时处理缺失文件对账。
- 在文件重命名后保留笔记映射关系。
- 在专用字段中保存 Obsidian 源文件 URI，并在卡片模板中渲染。
- 将远程 Markdown 嵌入（如 `![](<https://.../image.png>)`）转换成 Anki 可渲染的 HTML 媒体标签。

后续计划：

- 下一步主要可以继续补 UI 体验和端到端集成测试。

## 卡片语法

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
What does ATP stand for?
<!-- card-back -->
Adenosine Triphosphate
<!-- card-end uid="..." rev="sha256:..." -->
```

支持在正面和背面内容中使用远程媒体嵌入。同步时会把 Obsidian 风格的外链嵌入转换成 Anki 可渲染的 HTML，转换规则按 URL 扩展名判断：

- 图片：`png`、`jpg`、`jpeg`、`gif`、`webp`、`svg`、`avif`、`bmp`、`apng`
- 音频：`mp3`、`wav`、`ogg`、`oga`、`opus`、`m4a`、`flac`、`aac`
- 视频：`mp4`、`webm`、`mov`、`m4v`、`ogv`

示例：

```md
<!-- card-start -->
Name the structure shown below.
<!-- card-back -->
![](https://img.whynia.wang/20260309_1c371986b8ff8d2bc975039b78a5d213.png)
<!-- card-end -->
```

支持的文件默认值：

```md
---
anki-deck: Biology::Cell
anki-tags: [bio, exam]
---
```

牌组优先级：

- `card-start` 上显式声明的 `deck="..."`
- 文件 frontmatter 里的 `anki-deck`
- `默认牌组::vault::relative::file`
- `默认牌组`

## Commands

- `Sync cards to Anki`
- `Sync changed cards to Anki`
- `Insert card template`
- `Validate card syntax in current file`
- `Refresh card metadata in current file`
- `Rebuild sync index`

## 同步流程

```mermaid
flowchart TD
    A[触发入口] --> A1{进入哪条路径}
    A1 -->|手动全量同步| B[Sync cards to Anki]
    A1 -->|手动增量同步| C[Sync changed cards to Anki]
    A1 -->|自动同步：停止编辑 / 离开文件 / 重命名 / 删除| C
    A1 -->|启动期缺失文件对账| R[只做缺失文件 reconcile]
    A1 -->|刷新 metadata 或重建索引| M[仅本地维护路径]

    R --> R1[比较索引里的 tracked files 和当前 vault 文件]
    R1 --> R2[把缺失文件记入 deletedFilePaths tombstone]
    R2 --> R3[持久化 data.json，等待下一次真正同步]

    M --> M1{具体命令}
    M1 -->|Refresh card metadata in current file| M2[扫描当前文件并回写 uid / noteId / rev 标记]
    M1 -->|Rebuild sync index| M3[重新扫描整个 vault 并重建 cardsByUid 与 uidsByFile]
    M2 --> M4[只保留索引里已经可信的 lastSyncedRev]
    M3 --> M4
    M4 --> M5[不推进全局同步游标]

    B --> D[获取独占同步锁]
    C --> D
    D --> E{Vault 中的 Markdown 文件是否已就绪}
    E -->|否| Z1[安全退出，并提示 vault 仍在加载]
    E -->|是| F{全量还是增量}

    F -->|全量| G[选择全部 Markdown 文件]
    F -->|增量| H[选择仍有待处理工作的文件]
    H --> H1[dirty 文件]
    H --> H2[lastSyncAt 之后有新修改的文件]
    H --> H3[tracked 卡片里仍缺少 noteId 或 lastSyncedRev 的文件]
    H --> H4[已删除文件 tombstone 和已恢复的删除文件]

    G --> I[扫描 Markdown，构造成 ParsedCard]
    H --> I
    I --> I1[解析 card-start / card-back / card-end]
    I --> I2[合并 frontmatter 默认值和插件默认值]
    I --> I3[把 Markdown 渲染为 Anki HTML]
    I --> I4[基于内容、牌组、标签、路径、Obsidian URI 计算当前 rev]
    I --> I5[过滤重复 UID 冲突]

    I5 --> J[连接 AnkiConnect]
    J --> J1[检查 AnkiConnect 版本]
    J --> J2[确保 OBAK Basic 模型的字段、模板、CSS 都正确]
    J2 --> K[准备同步状态]
    K --> K1[确保每张卡都有稳定 uid]
    K --> K2[优先从本地索引恢复 noteId]
    K --> K3[必要时按 ObsidianUid 去 Anki 里找回 noteId]
    K --> K4[用 canAddNotes 对待创建卡片做预检查]
    K --> K5[启用自动建牌组时，确保目标牌组存在]

    K5 --> L[处理删除逻辑]
    L --> L1[活文件里被删掉的卡片进入删除候选]
    L --> L2[vault 中缺失文件的 tracked noteId 进入删除候选]
    L --> L3[如果 UID 在别处仍存在，则视为移动，不删除]
    L --> L4[没有 noteId 的本地孤儿卡只做本地索引清理]

    L4 --> N{是否需要批量删除前备份}
    N -->|是| N1[把默认牌组导出为带时间戳的 .apkg]
    N -->|否| O[在 Anki 中删除排队的 noteId]
    N1 --> O

    O --> P[按文件逐个同步卡片]
    P --> P1[每张卡决定走 create / update / unchanged / skip]
    P1 --> P2[Create：先 addNote，再 updateNote 回写 AnkiNoteId]
    P1 --> P3[Update：先 updateNote 字段和标签，再 changeDeck]
    P1 --> P4[Unchanged：当前 rev 与 lastSyncedRev 相同]
    P1 --> P5[远端失败或创建被阻止：文件保留 dirty，等待重试]

    P2 --> Q[把最新 uid / noteId / rev 回写到 card-end]
    P3 --> Q
    P4 --> Q
    P5 --> Q

    Q --> Q1[用原子 Vault.process 重写；若文件中途变化则放弃]
    Q1 --> S[更新本地索引]
    S --> S1[写入 cardsByUid 和 uidsByFile]
    S --> S2[只有真实同步成功后才推进 lastSyncedRev]
    S --> S3[删除阶段失败或有解析错误时保留 unseen 旧卡]
    S --> S4[只有文件完整走通后才清理 dirty]

    S4 --> T{是否推进全局同步游标}
    T -->|仅全量或增量同步| T1[更新 lastSyncAt 和 lastScanConfigHash]
    T -->|仅本地维护路径| T2[保持游标不变]

    T1 --> U[持久化 data.json]
    T2 --> U
    U --> V[显示进度和结果通知]
```

关键点：

- `data.json` 是本地同步状态的核心存储。最重要的字段包括 `cardsByUid`、`uidsByFile`、`pendingDeleteNoteIds`、`deletedFilePaths`、`lastSyncAt` 和 `lastScanConfigHash`。
- `Refresh card metadata in current file` 和 `Rebuild sync index` 都属于维护命令。它们会重写本地标记、重建索引，但不会宣称 Anki 已经同步完成。
- 增量同步不只是 `dirty + mtime`。它还会重新纳入那些 tracked 卡片同步状态还不完整的文件，比如缺少 `noteId` 或缺少 `lastSyncedRev`。
- 文件删除是两阶段流程：vault 事件和启动期 reconcile 先只记本地 tombstone，后续某次真正同步再去执行 Anki 删除。
- 只有当文件的远端同步路径完整走通后，才会从 dirty 集合里移除；远端失败会保留重试资格，等待下一次增量同步。

## Development

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run lint`

项目在 `package.json` 里通过 Volta 固定了 Node 和 npm 版本。

## Releases

推送一个与 `package.json` 和 `manifest.json` 完全一致的版本标签后，GitHub Releases 工作流会自动构建并发布插件产物。

- 使用 `npm version patch`、`npm version minor` 或 `npm version major` 更新版本。
- 使用 `git push origin main --follow-tags` 推送提交和标签。
- 发布工作流会上传 `main.js`、`manifest.json` 和 `styles.css`。

如果你更喜欢在 GitHub UI 里手动创建 release，只要针对已存在的版本标签发布 release，也会触发同一套工作流并刷新上传产物。
