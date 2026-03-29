# OBAK

Obsidian 桌面插件，用于把 Markdown 卡片单向同步到 Anki。

英文版说明见 [README.md](README.md)。

## 概览

OBAK 以 Obsidian 为唯一真相源。插件会扫描 Markdown 文件里的卡片块，通过 AnkiConnect 同步到 Anki，并维护一份本地索引，用来支持增量同步、文件重命名和文件删除。

当前实现要点：

- 解析 Markdown 文件中的 `card-start` / `card-back` / `card-end` 卡片块。
- 以原子方式重写 `card-end`，回写已同步的 Anki `id`。
- 持久化本地“文件到 note”索引，用于增量同步和删除对账。
- 同步前自动创建或修正 `OBAK Basic` Anki 模型。
- 在启用时自动创建缺失牌组。
- 按 vault 当前状态创建、更新、删除 Anki note。
- 在文件重命名后保留 note 跟踪关系。
- 先在本地记录已删除文件，再在后续同步时执行 Anki 删除。
- 在 Anki 字段中保存 Obsidian URI、路径和计算后的 revision。
- 在卡片背面渲染 `Open in Obsidian` 链接。
- 把 Markdown 渲染成适合写入 Anki 的 HTML，支持任务列表、`==高亮==`、数学公式、表格、原生 HTML 和受支持的远程媒体嵌入。
- 可选在停止编辑或跟踪文件变化后自动执行增量同步。
- 可选在批量删除前导出牌组备份。

## 运行要求

- 仅支持 Obsidian 桌面端。
- 需要启动 Anki 桌面端并启用 AnkiConnect。
- 要求 AnkiConnect 版本不低于 6。
- 默认 AnkiConnect 地址为 `127.0.0.1:8765`。

## 卡片语法

最小示例：

```md
<!-- card-start deck="Biology::Energy" tags="atp,cell" -->
What does ATP stand for?
<!-- card-back -->
Adenosine triphosphate
<!-- card-end -->
```

首次同步成功后，插件会把结束标记改写为带有 Anki note id 的形式：

```md
<!-- card-end id="1759203812345" -->
```

支持的文件级默认值：

```md
---
anki-deck: Biology::Cell
anki-tags:
  - bio
  - exam
---
```

规则：

- `card-start` 支持内置属性 `deck="..."` 和 `tags="tag1,tag2"`，也允许额外的自定义 `key="value"` 属性。
- `card-start` 上的未知自定义属性目前只参与语法解析，不会参与同步；`deck` 和 `tags` 是保留属性名。
- `card-back` 不接受任何属性。
- `card-end` 由插件维护，目前只写入 `id="..."`。
- 如果 `card-end` 没有 `id`，该卡片会被当作新卡片处理。
- 旧的 `rev="..."` 标记仍可被读取，但会在下一次改写时被移除。
- 旧的 `uid="..."` 标记不再被当前解析器支持。
- 标记顺序必须正确，且不支持卡片嵌套。
- 正面和背面不能同时为空。

牌组优先级：

- `card-start` 上显式声明的 `deck="..."`
- 文件 frontmatter 中的 `anki-deck`
- `默认牌组::文件夹::笔记名`
- `默认牌组`

标签会合并三层来源：插件默认标签、文件 `anki-tags`、卡片 `tags`。

## Markdown 支持

卡片正文会先做规范化，再渲染成 HTML 后写入 Anki。当前支持：

- 常见 Markdown 块级和行内语法
- 表格
- 任务列表
- `==高亮==`
- 行内和块级数学公式
- 原生 HTML
- 带已知扩展名的远程 `http` / `https` 媒体嵌入

支持转换的远程媒体类型：

- 图片：`apng`、`avif`、`bmp`、`gif`、`jpeg`、`jpg`、`png`、`svg`、`webp`
- 音频：`aac`、`flac`、`m4a`、`mp3`、`oga`、`ogg`、`opus`、`wav`
- 视频：`m4v`、`mov`、`mp4`、`ogv`、`webm`

本地 Obsidian 嵌入和未识别的媒体 URL 目前会原样保留，不做转换。

## 同步行为

- 全量同步会扫描 vault 中全部 Markdown 文件。
- 增量同步会扫描脏文件、最近改动文件、待重试文件以及已记录的删除状态。
- 全量同步会把结果和 Anki 中现有的 `OBAK Basic` note 做比较；当本次全量扫描结果可信时，会删除 vault 中已不存在的 note。
- 已删除文件采用两阶段处理：先本地记录，再在后续同步中确认并删除 Anki note。
- 文件重命名会更新本地索引，使 note 归属跟随新路径。
- `Refresh card metadata in current file` 和 `Rebuild sync index` 属于本地维护命令。它们会更新本地标记和索引，但不表示 Anki 已经同步完成。
- 文件改写统一通过 `Vault.process()` 完成；如果改写期间文件发生变化，会中止这次回写。

## 命令

- `Sync cards to Anki`
- `Sync changed cards to Anki`
- `Validate card syntax in current file`
- `Refresh card metadata in current file`
- `Rebuild sync index`
- `Make card`
- `Delete card`
- `Insert card template`

编辑器模板命令插入的内容为：

```md
<!-- card-start -->
Front
<!-- card-back -->
Back
<!-- card-end -->
```

## 设置项

- 默认牌组
- 默认标签
- Anki 主机
- Anki 端口
- 自动创建缺失牌组
- 启动时对账
- 自动同步增量改动
- 自动同步延迟（秒）
- 批量删除前备份
- 批量删除备份导出路径
- 批量删除备份阈值
- 显示详细错误通知
- 详细控制台日志

## Anki 模型

OBAK 会把卡片同步到自定义 note type `OBAK Basic`，并在需要时自动创建或修正它。

字段如下：

- `ObakSyncId`
- `AnkiDeck`
- `AnkiTags`
- `AnkiNoteId`
- `Front`
- `Back`
- `ObsidianUri`
- `ObsidianPath`
- `ObsidianRev`

当 `ObsidianUri` 存在时，卡片背面模板会渲染 `Open in Obsidian` 链接。

## 开发

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run lint`

如果你使用 Volta，`package.json` 当前固定了以下版本：

- `node`: `22.20.0`
- `npm`: `10.9.3`

## 发布

- 使用 `npm version patch`、`npm version minor` 或 `npm version major` 更新版本。
- 仓库里的 `version` 脚本会同步更新 `manifest.json` 和 `versions.json`。
- 推送提交和版本标签时不要加前缀 `v`。
- 发布产物为 `main.js`、`manifest.json` 和 `styles.css`。

## 许可证

0BSD
