# 测试说明

版本目标：`3.0.0-beta.1`，运行环境：SillyTavern `1.17.0`。

## 测试范围

### 浏览器 UI 测试

安装包含以下 6 个运行文件：`index.js`、`style.css`、`console.js`、`console.css`、`services.js`、`manifest.json`。在浏览器加载扩展后执行 `Ctrl+F5`，确认扩展设置可打开，五页手机式控制台可切换，版本条诊断显示 `3.0.0-beta.1`。`services.js` 的职责包括 API 分流、只读记忆、独立后台试聊和地图导入。

逐项检查：

- 联系人状态可以显示，日记目标字数可选 `50`、`200`、`800`、`1600` 和自定义；界面将其作为目标提示，不断言精确字数。
- 试聊按钮只创建独立后台会话，不新增主聊天消息，不改变世界或 NPC 主状态。
- 地图可显示自身地点、tags 和路线；导入 JSON 后先显示候选，只有确认后才进入自身目录。
- 地图图片仅接受本地 `PNG`、`JPG/JPEG`、`WebP` 数据 URL；不会请求第三方地图 API。
- 设置变更重新加载后仍可从 `extensionSettings['npc-life']` 恢复；界面布局从 `localStorage` 恢复。
- 关闭记忆增强开关时不读取记忆表；开启后只检查当前聊天最近非用户消息、关键词和行预算行为。
- 未确认地点、未知解析结果和过期记忆不会覆盖当前状态。

## API mocks

API mock 应覆盖以下接口边界：

1. 主 API：`generateRaw` 默认收到 ST 当前选定配置，且请求只使用独立 prompt。
2. ST 副 API：`ConnectionManagerRequestService.getSupportedProfiles` 返回可选 profile；`sendRequest` 验证所选副 profile 与任务路由。preset/model 继承 profile。
3. 副 API 失败：界面显示错误，不调用主 API 作为静默 fallback。
4. 记忆增强：mock `window.stMemoryEnhancement.ext_getAllTables`，确认默认关闭；开启后只截取关键词命中的行并遵守行预算。
5. 生成失败或返回未知内容：错误可见，未知保持未知，不伪造地点、状态或路线。

## 数据与副作用检查

- 试聊结果不写入主聊天，不调用主世界状态更新。
- 地图导入确认前不写入自身目录；确认后只写扩展自身设置。
- 模板只追加文本；没有生成前 hard interception。
- 记忆表读取不写外部表，过期表格不覆盖当前状态。
- 不保存连接密钥，不切换主连接。

## 联调边界

本项目记录浏览器 UI 测试和 API mocks 的测试方式。连接功能目前限本机测试，本文不声称已经调用真实 API 完成所有联调；真实 API 行为仍取决于本机酒馆连接配置、profile、preset 和模型服务。测试也不把主模型遵守注入内容视为可保证条件。

## 回归记录格式

提交测试记录时请至少填写：

```text
环境：ST 版本 / 浏览器 / 扩展版本
范围：UI / 主 API mock / 副 API mock / 记忆 mock
步骤：最小复现或操作顺序
预期：
实际：
主聊天是否变化：是 / 否
世界状态是否变化：是 / 否
是否调用真实 API：是 / 否
```
