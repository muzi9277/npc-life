# 更新日志

## 3.0.0-beta.1

- 增加类似 Connection Manager 的副 API 渠道编辑/状态窗口，敏感字段仍由酒馆管理。
- 增加用户正史事实账本：明确正文创作可覆盖角色卡初始处境，愿望/假设保持提案。
- 增加消息锚点与基线恢复，消息编辑或删除后可撤销失效正史投影。


- 发布五页手机式控制台的 beta 版本，页面只承担 UI 与数据操作。
- 保留 NPC 模拟与约束旧核心：地点约束、在场状态、日志与注入边界不改为自动剧情决策。
- 联系人支持状态查看、日记目标字数选项（50 / 200 / 800 / 1600 / 自定义）和独立后台试聊；目标字数不是精确字数保证，试聊不写主聊天、不改世界。
- 地图支持自身确认的地点、tags、路线、路线天数和本地 PNG/JPG/WebP 数据 URL；导入候选需用户确认，不自动调用第三方地图 API。
- ST 副 API 接入 `ConnectionManagerRequestService.getSupportedProfiles` / `sendRequest` 的配置路径；副 profile、任务路由由用户选择，preset/model 继承 profile，失败不静默回退主 API。
- 主 API 默认使用 ST 选定配置的 `generateRaw`。
- 记忆增强读取默认关闭；开启后可从 `window.stMemoryEnhancement.ext_getAllTables` 读取当前聊天最近非用户消息表，按关键词行预算截取，不覆盖当前状态、不写外部表。
- 扩展设置持久化使用 `extensionSettings`，界面状态使用 `localStorage`。
- 增加版本条诊断、浏览器 UI 测试与 API mocks 的测试记录入口。

## 旧原型

- 旧原型仅作为 NPC Life 的早期实现与约束核心来源保留。
- 本日志不追补旧版本的未核实历史记录；旧原型阶段的限制和未实现项以仓库内现存旧说明为准。
