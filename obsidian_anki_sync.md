# Obsidian → Anki 单向同步插件设计文档（AI 实现版）

## 0. 需求重述与领域归类

你这个需求，更准确的表述可以写成：

**为桌面端 Obsidian 开发一个仅支持 Basic 卡片的单向同步插件，通过 AnkiConnect 将 Obsidian 中用 HTML 注释块标记的卡片同步到 Anki；Obsidian 是唯一数据源，Anki 只负责复习；插件需要支持新增、更新、删除、文件重命名、文件删除、回跳到源笔记，并在卡片规模增大后仍保持可接受的同步效率。**

这个问题属于**Obsidian 插件工程 + 增量同步设计 + 文本语法协议设计**。核心不是“怎么发 HTTP 请求”，而是三件事：一，Markdown 里的卡片语法如何定义；二，插件如何维护本地索引；三，如何在“现存文件更新”和“文件已消失”两种情况下都正确同步到 Anki。当前生态里已经存在多种路线，例如 `Question::Answer`、`#cards + ---`、以及“一篇 Obsidian 笔记对应一条 Anki note + YAML”的做法，所以你现在做的是**自定义一种更适合你工作流的协议**，而不是照搬某个现成插件。([GitHub][1])

## 1. 设计总览

本设计的最终结论如下：

1. 插件仅支持**桌面端 Obsidian**，不考虑移动端。Obsidian 社区插件清单里可以通过 `isDesktopOnly` 标记为桌面专用。([obsidian-developer-docs.pages.dev][2])
2. 同步方向固定为**Obsidian → Anki**，Anki 不回写源内容。这个方向也与现有一些单向同步插件的设计哲学一致。([GitHub][3])
3. 仅支持 **Anki Basic** note type，不支持 Cloze、反向卡、复杂模板。AnkiConnect 可以查询模型名、字段名，并通过 `addNote` / `updateNoteFields` 操作 Basic note。([GitHub][4])
4. Markdown 中采用**三段式 HTML 注释块语法**：`card-start`、`card-back`、`card-end`。
5. `card-start` 只放**用户主动配置**，例如 `deck`、`tags`。
6. `card-end` 只放**插件维护字段**，例如本地稳定卡片 ID、Anki note id、内容版本指纹。
7. 不把“dirty 已修改标记”作为长期真相写回 Markdown；真正的删除处理依赖**插件内部持久化索引**。
8. 同步策略采用**增量优先，文件级重解析，必要时全量对账兜底**。
9. 每张 Anki 卡片附带一个 **Obsidian URI**，用于从 Anki 回跳到源笔记。Obsidian 官方支持 `obsidian://open?vault=...&file=...` 形式，并支持跳到标题或块。([Obsidian Help][5])

## 2. 设计目标

### 2.1 必须实现的目标

1. 用户在 Obsidian 中写卡片，Anki 只做复习，不改内容。
2. 支持一篇笔记内存在多张 Basic 卡。
3. 支持新增、更新、删除、文件重命名、文件删除。
4. 支持从 Anki 打开 Obsidian 源笔记。
5. 当卡片规模增大时，同步仍以**变更文件为主**，避免每次全库全文重算。
6. 插件异常退出、错过事件、外部工具改文件时，仍有恢复一致性的能力。

### 2.2 明确不做的事

1. 不支持 Cloze。
2. 不支持反向卡、多个模板、任意字段映射。
3. 不支持从 Anki 编辑后再写回 Obsidian。
4. 不追求“零私有语法”。你已经明确接受 HTML 注释块协议。
5. v1 不做复杂媒体同步；先把纯文本、Markdown、基本链接打通。

## 3. 运行前提与外部依赖

插件运行依赖桌面版 Obsidian 与桌面版 Anki。AnkiConnect 在启动 Anki 时会在本地开启一个 HTTP 服务，默认监听 `127.0.0.1:8765`；Anki 必须保持运行，AnkiConnect README 也建议客户端先调用 `version` 确认双方协议版本，再使用其他 action。其 README 中记录了 `deckNames`、`modelNames`、`addNote`、`updateNoteFields`、`findNotes`、`notesInfo`、`multi`、`guiBrowse` 等接口。([GitHub][4])

实现上不要硬编码“我一定面对的是某个固定版本的 AnkiConnect”。插件启动时先调用：

```json
{"action":"version","version":5}
```

如果返回版本不满足最小要求，就给出错误提示并终止同步。这样比在代码里假设“用户一定是某个版本”更稳。([GitHub][4])

## 4. Markdown 语法协议

### 4.1 最终采用的语法

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
ATP 的全称是什么？
<!-- card-back -->
Adenosine Triphosphate
<!-- card-end uid="01H..." id="1759203812345" rev="sha256:abcd..." -->
```

这是本设计的标准形式。

### 4.2 三个标记的职责

`card-start`：用户定义卡片开始，同时可带用户配置字段。
`card-back`：前后面分界。
`card-end`：卡片结束，同时可带插件维护字段。

职责必须严格分离：

* `card-start` 只能出现**用户字段**。
* `card-back` 不允许带任何字段。
* `card-end` 只能出现**插件字段**。

这样做的目的，是把“用户定义内容”和“同步状态”分开，避免解析器状态混乱。

### 4.3 支持的字段

`card-start` 支持字段：

* `deck`：可选，字符串，覆盖默认 deck。
* `tags`：可选，字符串，逗号分隔。

`card-end` 支持字段：

* `uid`：本地稳定卡片 ID，插件生成，长期不变。
* `id`：Anki note id，首次成功创建后写入。
* `rev`：上次成功同步时的内容版本指纹。

### 4.4 为什么需要 `uid`

仅靠 `id` 不够。
原因是：当一张卡尚未同步到 Anki 时，它还没有 `id`；当用户在文件内移动卡片顺序时，仅靠位置索引会不稳定；当文件重命名或部分内容重排时，需要一个**不依赖文本位置**的本地稳定标识。因此必须引入 `uid`。

建议 `uid` 使用短 UUID、ULID 或时间有序 ID。
要求只有两个：

1. 在当前 vault 内唯一。
2. 一旦生成，除非卡片被彻底删除，否则永不更改。

### 4.5 为什么不持久化 dirty 标记

不把 `dirty=1` 之类的状态长期写回 Markdown。
原因有三点：

1. 编辑期间频繁回写文件会导致写入过多。
2. dirty 状态在删除场景下没有用，因为整张卡都消失了。
3. 真正可靠的增量同步应该依赖“变更文件集合 + 文件级重解析 + 索引对账”，而不是依赖单个卡片行内的一个布尔值。

因此，`rev` 持久化，`dirty` 只保存在运行时内存里。

### 4.6 注释语法约束

HTML 注释使用 `<!-- ... -->` 形式；注释不能嵌套，遇到第一个 `-->` 就结束。这个语法本身适合做“机器可见、阅读视图不可见”的轻量协议。([MDN 文档][6])

因此约束如下：

1. 每个注释标记都必须独占一行。
2. 不允许在属性值里出现 `-->`。
3. 不支持嵌套卡片。
4. v1 不允许在列表项、表格单元格内部写卡片块；统一要求卡片块是块级结构。

## 5. 配置层级设计

为减少每张卡都重复写 `deck` / `tags`，建议采用三级配置优先级。

### 5.1 配置优先级

`卡片级 > 文件级 > 插件全局级`

### 5.2 文件级配置

文件头部可选 frontmatter：

```md
---
anki-deck: Biology::Cell
anki-tags: [bio, exam]
---
```

规则：

* `anki-deck` 作为该文件所有卡片的默认 deck。
* `anki-tags` 作为该文件所有卡片的默认 tags。

### 5.3 插件全局配置

插件设置页中提供：

* 默认 deck
* 默认 tags
* AnkiConnect host / port
* 是否自动在 Back 附加源链接
* 同步时是否自动创建 deck
* 是否启用启动时一致性对账

Obsidian 插件开发中，`loadData()` / `saveData()` 是常见的插件持久化方法，社区插件开发文档也给出了典型用法。([Marcus Olsson][7])

## 6. 数据模型设计

### 6.1 解析后的卡片对象

```ts
type ParsedCard = {
  uid: string | null;
  noteId: string | null;      // 对应 card-end 的 id
  rev: string | null;         // 对应 card-end 的 rev

  filePath: string;
  fileMtime: number;

  startLine: number;
  backLine: number;
  endLine: number;

  frontRaw: string;
  backRaw: string;

  frontNormalized: string;
  backNormalized: string;

  effectiveDeck: string;
  effectiveTags: string[];

  obUri: string;
};
```

### 6.2 插件内部索引

这是整个设计里最重要的数据结构。

```ts
type CardIndexRecord = {
  uid: string;
  filePath: string;
  ankiNoteId: string | null;
  lastSyncedRev: string | null;
  lastSeenAt: number;
};

type PluginIndex = {
  schemaVersion: number;
  cardsByUid: Record<string, CardIndexRecord>;
  uidsByFile: Record<string, string[]>;
  pendingDeleteNoteIds: string[];
  dirtyFiles: string[];
  lastFullReconcileAt: number | null;
};
```

### 6.3 为什么必须有插件索引

因为 Markdown 里的 `card-end` 只能描述**当前仍然存在的卡片**。
一旦文件被删除，里面所有 `card-end` 一起消失，你无法再从源文件中恢复“这份文件原来有哪些 Anki note id”。这就是删除处理必须依赖插件索引，而不能只依赖 Markdown 的根本原因。

## 7. 内容版本指纹 `rev` 的计算规则

`rev` 不建议直接对整段原文硬算哈希，而应该对**规范化后的业务内容**计算。

### 7.1 参与 rev 的内容

* 固定 note type：`Basic`
* 生效后的 deck
* 生效后的 tags（排序后）
* front 内容
* back 内容

### 7.2 不参与 rev 的内容

* `uid`
* `id`
* `rev` 本身
* 注释顺序以外的同步元数据
* 文件路径
* 文件修改时间

### 7.3 规范化规则

建议最小规范化，不要过度“美化”文本：

1. 行结束符统一转为 `\n`
2. 去掉 UTF-8 BOM
3. 去掉 front/back 首尾的空白空行
4. tags 去重、排序、trim
5. 不折叠正文内部空格，不改代码块内容

示例：

```ts
const revPayload = {
  model: "Basic",
  deck: effectiveDeck,
  tags: [...effectiveTags].sort(),
  front: normalizeFront(frontRaw),
  back: normalizeBack(backRaw),
};
const rev = "sha256:" + sha256(JSON.stringify(revPayload));
```

## 8. Obsidian 侧事件与监听策略

Obsidian 官方 `Vault` 提供 `create`、`modify`、`delete`、`rename` 事件；`Workspace` 提供 `editor-change`；`MetadataCache.on('changed')` 会在文件重新索引后触发，但**不会处理 rename**，重命名要单独监听 `vault rename`。另外，官方也明确说明：如果你不想在 vault 初始加载时收到所有现有文件的 `create` 事件，应当在 `Workspace.onLayoutReady()` 之后再注册。([obsidian-developer-docs.pages.dev][8])

### 8.1 推荐监听清单

```ts
workspace.on("editor-change", ...)
vault.on("modify", ...)
vault.on("delete", ...)
vault.on("rename", ...)
workspace.onLayoutReady(() => {
  vault.on("create", ...)
})
```

### 8.2 各事件的职责

`editor-change`：
只做轻量工作，例如把当前文件加入内存中的 `dirtyFiles` 集合。不要在这里频繁改写源文件。官方文档说明该事件会在用户编辑或程序修改编辑器内容后触发。([obsidian-developer-docs.pages.dev][9])

`modify`：
文件已落盘，适合作为“下次同步需要重解析该文件”的信号。

`rename`：
更新索引中的 `filePath`，并重建该文件下所有卡片的 Obsidian URI。

`delete`：
不要试图读已删除文件；直接用旧 `filePath` 去索引中找历史记录，并把对应 `ankiNoteId` 放入待删除队列。

`create`：
只在 layout ready 之后注册，避免把启动时已有文件误当作“新建”。([obsidian-developer-docs.pages.dev][10])

## 9. 文件读写策略

Obsidian 官方文档区分了 `read()` / `cachedRead()` / `modify()` / `process()`。如果目的是“读-改-写同一文件”，更稳的是使用 `Vault.process()`，因为它会原子地读取、修改并保存文本。官方文档对 `process()` 的描述就是“Atomically read, modify, and save the contents of a note”。如果只是枚举当前 vault 的 Markdown 文件，则使用 `getMarkdownFiles()`。([Developer Documentation][11])

### 9.1 推荐策略

1. 扫描文件内容时，读操作可以用 `read()` 或 `cachedRead()`。
2. 写回 `card-end` 字段时，统一用 `Vault.process()`。
3. 不要在 `editor-change` 中直接 `modify()` 当前文件。
4. 所有回写都集中到“同步前修正”或“同步后提交元数据”阶段。

### 9.2 为什么不用频繁实时写回

因为边打字边重写文件，容易出现：

* 写入过于频繁
* 触发自身监听回环
* 与其他格式化插件相互干扰
* 增加文件冲突概率

## 10. Anki 侧映射策略

### 10.1 固定模型

v1 固定使用：

* `modelName = "Basic"`
* 字段映射：`Front` ← front，`Back` ← back

AnkiConnect 的 `modelNames`、`modelFieldNames` 可以用来校验当前环境是否存在 `Basic` 及字段名。`addNote` 用于创建 note，`updateNoteFields` 用于更新字段。([GitHub][4])

### 10.2 需要用到的 AnkiConnect action

最小必需集合：

* `version`
* `deckNames`
* `modelNames`
* `addNote`
* `updateNoteFields`
* `findNotes`
* `notesInfo`
* `multi`

`guiBrowse` 不是同步必需，但可作为调试命令使用。`multi` 可减少多次往返请求。([GitHub][4])

### 10.3 删除策略

优先按 `ankiNoteId` 删除。
如果 `ankiNoteId` 缺失，但索引中仍记录了 `uid -> id` 映射，则以索引为准。
不要使用“front 文本匹配”来做删除，因为 front 可改、可重名，风险太高。

### 10.4 Back 中附加源链接

建议在 Back 末尾追加一个小节：

```html
<p><a href="obsidian://open?vault=MyVault&file=Path/Note.md">Open in Obsidian</a></p>
```

Obsidian 官方帮助文档确认支持 `obsidian://open?vault=...&file=...`，也支持跳到标题或块。([Obsidian Help][5])

## 11. 同步总流程

### 11.1 启动阶段

1. 加载插件设置。
2. 加载 `PluginIndex`。
3. 调用 AnkiConnect `version` 探测可用性。
4. 校验 `Basic` note type 是否存在。
5. 注册事件监听。
6. 可选：执行一次轻量路径对账。

### 11.2 单次同步流程

```text
Step 1  收集待处理文件
Step 2  解析这些文件中的所有卡片
Step 3  与插件索引做文件级 diff
Step 4  生成同步计划：create / update / delete / rewrite-meta
Step 5  执行 AnkiConnect 请求
Step 6  成功后原子写回 card-end
Step 7  更新插件索引
Step 8  清理 dirtyFiles / pendingDelete
```

### 11.3 为什么是“文件级 diff”而不是“只看卡片 dirty”

因为卡片删除时，卡片本身已经不在文件里了。
你能比较的，不是“当前还能看到的每张卡的 dirty 标记”，而是“这个文件上次索引中有这些 uid，这次重解析后只剩这些 uid”，由此得出哪个 uid 被删除。

## 12. 删除与重命名处理

### 12.1 文件内删除卡片

场景：文件还在，但用户删掉了一张卡。

做法：

1. 本次同步重解析该文件
2. 得到当前 uid 集合
3. 与索引中的旧 uid 集合求差
4. 差集里的 uid 对应的 `ankiNoteId` 进入删除计划
5. 删除成功后，从索引中移除这些 uid

### 12.2 文件整体删除

场景：整个 Markdown 文件被删。

做法：

1. `vault.on("delete")` 收到旧路径
2. 直接查索引里的 `uidsByFile[filePath]`
3. 取出全部 `ankiNoteId`
4. 加入 `pendingDeleteNoteIds`
5. 同步成功后删除索引记录

### 12.3 文件重命名

场景：路径变了，但内容没变。

做法：

1. `vault.on("rename")` 收到新旧路径
2. 更新索引中的 `filePath`
3. 对该文件下所有卡，重建新的 Obsidian URI
4. 如果 Back 中附加了源链接，则视情况执行一次字段更新

### 12.4 为什么还要做启动/同步前路径对账

因为事件监听并不保证永远不漏。
例如：

* 插件未启用时用户删了文件
* Obsidian 异常退出
* 外部程序直接改了 vault

因此每次启动或同步前，都应该拿当前 `getMarkdownFiles()` 返回的路径集合，与索引中的路径集合做差集，找出“索引中存在但 vault 中不存在”的文件，并补做删除计划。Obsidian 官方 Vault 文档展示了 `getMarkdownFiles()` 的典型用法。([Developer Documentation][11])

## 13. 解析器规则

### 13.1 合法卡片

合法卡片必须满足：

1. 出现一个 `card-start`
2. 后续出现一个 `card-back`
3. 后续出现一个 `card-end`
4. 三者顺序严格递增
5. 中间不能嵌套第二个 `card-start`

### 13.2 非法情况

以下全部视为语法错误，不参与同步：

1. 有 `card-start` 没有 `card-back`
2. 有 `card-back` 没有 `card-end`
3. `card-back` 出现在 `card-start` 之前
4. 卡片嵌套
5. `card-start` 或 `card-end` 属性解析失败
6. front 或 back 为空字符串

### 13.3 出错策略

建议：

* 单张卡语法错误时，不影响同文件其他卡
* 在 Notice 或日志面板里报告文件路径、行号、错误类型
* 不自动修复不确定内容
* 语法错误卡片不更新索引、不推送到 Anki

## 14. `card-end` 回写规则

### 14.1 首次创建后回写

若卡片没有 `uid`：

1. 生成 `uid`
2. 调用 `addNote`
3. 获取 Anki note id
4. 计算 `rev`
5. 写回：

```md
<!-- card-end uid="..." id="1759203812345" rev="sha256:..." -->
```

### 14.2 更新后回写

若卡片已有 `uid` 和 `id`：

1. 计算当前 `revNew`
2. 与 `card-end.rev` 比较
3. 不同则调用 `updateNoteFields`
4. 成功后把 `rev` 改成新值

### 14.3 未变化时不写回

如果 `rev` 一致，不要重写该文件。
这能减少无意义写入，也能避免影响 Git diff。

## 15. 模块划分建议

这个部分是给 AI 写代码时最关键的结构建议。

### 15.1 `syntax.ts`

负责：

* 解析 `card-start` / `card-back` / `card-end`
* 解析属性
* 生成规范化 token
* 报告语法错误

建议暴露：

```ts
parseCardsFromMarkdown(text: string, filePath: string): ParseResult
serializeCardEnd(meta: CardEndMeta): string
```

### 15.2 `normalize.ts`

负责：

* front/back 规范化
* tags 标准化
* deck 规范化
* rev 计算

### 15.3 `index-store.ts`

负责：

* `loadIndex()`
* `saveIndex()`
* `getCardsByFile()`
* `upsertCardRecord()`
* `removeCardRecord()`
* `markPendingDelete()`

### 15.4 `obsidian-events.ts`

负责：

* 注册 `editor-change` / `modify` / `delete` / `rename` / `create`
* 更新内存态 `dirtyFiles`
* 记录待删除文件路径

### 15.5 `scanner.ts`

负责：

* 给定文件路径集合，读取文件
* 调用 parser 得到 `ParsedCard[]`
* 汇总成 `file -> cards` 结构

### 15.6 `planner.ts`

负责：

* 比较 `parsed cards` 与 `index`
* 生成同步计划：

```ts
type SyncPlan = {
  creates: ParsedCard[];
  updates: ParsedCard[];
  deletes: { uid: string; noteId: string }[];
  rewriteMeta: ParsedCard[];
};
```

### 15.7 `anki-client.ts`

负责：

* HTTP POST 到 `127.0.0.1:8765`
* `version`
* `deckNames`
* `modelNames`
* `addNote`
* `updateNoteFields`
* `notesInfo`
* `multi`

### 15.8 `sync-runner.ts`

负责：

* 串联 planner 与 anki-client
* 控制执行顺序
* 事务式更新索引
* 成功后回写 Markdown

### 15.9 `uri.ts`

负责：

* 构造 `obsidian://open?vault=...&file=...`
* 可选支持 heading / block 深链

### 15.10 `settings.ts`

负责：

* 设置页
* 默认 deck / tags
* host / port
* 自动附加源链接开关
* 启动时对账开关

## 16. 关键算法伪代码

### 16.1 单文件重解析 + diff

```ts
function diffFile(filePath: string, parsedCards: ParsedCard[], index: PluginIndex) {
  const oldUids = new Set(index.uidsByFile[filePath] ?? []);
  const newUids = new Set(parsedCards.map(c => c.uid).filter(Boolean) as string[]);

  const creates: ParsedCard[] = [];
  const updates: ParsedCard[] = [];
  const deletes: string[] = [];

  for (const card of parsedCards) {
    if (!card.uid) {
      creates.push(card);
      continue;
    }

    const old = index.cardsByUid[card.uid];
    if (!old) {
      creates.push(card);
      continue;
    }

    if (card.rev !== old.lastSyncedRev) {
      updates.push(card);
    }
  }

  for (const uid of oldUids) {
    if (!newUids.has(uid)) {
      deletes.push(uid);
    }
  }

  return { creates, updates, deletes };
}
```

### 16.2 启动或同步前路径对账

```ts
async function reconcileMissingFiles(app: App, index: PluginIndex) {
  const currentPaths = new Set(app.vault.getMarkdownFiles().map(f => f.path));
  for (const filePath of Object.keys(index.uidsByFile)) {
    if (!currentPaths.has(filePath)) {
      for (const uid of index.uidsByFile[filePath]) {
        const rec = index.cardsByUid[uid];
        if (rec?.ankiNoteId) {
          index.pendingDeleteNoteIds.push(rec.ankiNoteId);
        }
      }
    }
  }
}
```

### 16.3 成功同步后原子写回 `card-end`

```ts
await app.vault.process(file, (data) => {
  // 重新定位该文件中的 card-end
  // 用新 meta 替换旧 meta
  return rewritten;
});
```

Obsidian 官方文档明确说明 `Vault.process()` 会原子地读、改、写文件，适合这种“基于旧文本改一小段”的场景。([obsidian-developer-docs.pages.dev][12])

## 17. UI 与命令设计

v1 建议只做最小界面：

### 17.1 命令

1. `Sync cards to Anki`
2. `Rebuild sync index`
3. `Validate card syntax in current file`
4. `Insert card template`

### 17.2 设置项

1. Anki host
2. Anki port
3. 默认 deck
4. 默认 tags
5. 自动附加 Obsidian URI
6. 启动时执行路径对账
7. 日志等级

### 17.3 当前文件插入模板

执行后插入：

```md
<!-- card-start -->
Front
<!-- card-back -->
Back
<!-- card-end -->
```

## 18. 失败处理与恢复策略

### 18.1 网络或 Anki 未启动

* `version` 调用失败时直接终止本次同步
* 不改写任何 `card-end`
* 不更新索引
* 保留 `dirtyFiles`

### 18.2 某张卡新增失败

* 只标记该卡失败
* 不影响其他卡
* 不写入 `id`
* 下次同步继续尝试

### 18.3 某张卡更新失败

* 不更新该卡的 `rev`
* 保留旧索引
* 下次同步继续尝试

### 18.4 删除失败

* `ankiNoteId` 继续留在 `pendingDeleteNoteIds`
* 不从索引移除
* 下次同步继续删除

### 18.5 索引损坏

* 提供 `Rebuild sync index`
* 做法是重新扫描当前 vault 中所有卡片
* 从 Markdown 中读取 `uid/id/rev`
* 重建 `cardsByUid` 与 `uidsByFile`
* 再执行一次路径对账

## 19. 需要特别强调的实现原则

### 19.1 真相源的优先级

真相源优先级必须明确：

1. 当前文件内容
2. `card-end` 中的机器字段
3. 插件索引
4. Anki 当前状态

含义是：

* front/back 内容以当前 Markdown 为准
* 删除判断以“当前文件集合 + 插件索引”联合为准
* Anki 只是目标端，不是源真相

### 19.2 不要把 Anki 查询结果当主索引

AnkiConnect 的 `findNotes`、`notesInfo` 很有用，但它们适合校验和调试，不适合当你插件的唯一主索引。因为你需要首先知道“Obsidian 中这张卡是谁”，而这件事只能靠 `uid + 索引` 解决。([GitHub][4])

### 19.3 不要让 parser 依赖“邻近行猜测”

不要设计成“哪个 `SYNC` 行离它最近就归谁”。
你的前面顾虑是对的：一旦格式化、插入空行、用户手动挪动，就会产生归属歧义。
所以 `card-end` 直接携带机器字段，是当前设计里更稳的选择。

## 20. AI 编码时的推荐实施顺序

这是给另一个 AI 最有用的执行顺序。

### 20.1 第一阶段

先完成纯本地能力，不接 Anki：

1. 解析器
2. `card-start/back/end` 语法校验
3. `uid/rev` 生成
4. `card-end` 原子写回
5. 索引持久化

### 20.2 第二阶段

接入最小 AnkiConnect：

1. `version`
2. `modelNames`
3. `addNote`
4. `updateNoteFields`

此时先不做删除，只打通新增和更新。

### 20.3 第三阶段

补删除链路：

1. 文件内卡片删除
2. 文件整体删除
3. 重命名处理
4. 启动时路径对账

### 20.4 第四阶段

补体验层：

1. 插入模板命令
2. 当前文件校验命令
3. Rebuild index 命令
4. Back 附加 Obsidian URI

## 21. 最终推荐的 v1 协议

如果你要把协议直接定下来，我建议就用下面这版，不再摇摆：

```md
---
anki-deck: Biology::Cell
anki-tags: [bio, exam]
---

一些普通正文。

<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
ATP 的全称是什么？
<!-- card-back -->
Adenosine Triphosphate

<p><a href="obsidian://open?vault=MyVault&file=Biology/ATP.md">Open in Obsidian</a></p>
<!-- card-end uid="01HXYZ..." id="1759203812345" rev="sha256:3a8e..." -->

继续普通正文。
```

这套协议的核心优点是：

1. 用户字段和机器字段分离
2. 文件内多卡支持自然
3. 删除可通过索引解决
4. 重命名可通过路径更新解决
5. 不依赖额外 `SYNC` 行
6. 不依赖脆弱的“邻近归属”猜测
7. 可以在卡片数量增长后继续做增量同步

## 22. 一句话总结

这份设计文档的核心思想可以压缩成一句话：

**Markdown 里的 `card-start/back/end` 负责定义和承载卡片本体，`card-end` 只存稳定机器字段；增量同步靠“变更文件重解析”，删除同步靠“插件持久化索引 + 删除事件 + 启动时路径对账”，而不是靠卡片行内的 dirty 标记。**

如果你需要，我下一条可以继续把这份设计文档再收缩成一份“给 AI 下代码任务的实现清单”，按文件拆成 `main.ts / syntax.ts / index-store.ts / anki-client.ts / sync-runner.ts` 的形式。
