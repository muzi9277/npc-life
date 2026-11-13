# NPC Life 角色生活

版本：`3.0.0-beta.1`  
目标环境：SillyTavern `1.17.0`（ST1.17.0）  
作者：YG

NPC Life 是一个无构建、原生 ESM + jQuery 的 SillyTavern 前端扩展。它保留旧原型的 NPC 模拟与约束核心，并提供五页手机式控制台。控制台只负责 UI 与剧情相关的数据操作，不把页面结构当成剧情规则。

## 安装

将扩展包放入 ST 扩展目录：

```text
public/scripts/extensions/third-party/npc-life/
```

目录应包含以下 6 个运行文件：

```text
index.js
style.css
console.js
console.css
services.js
manifest.json
```

其中 `index.js` 是运行入口；`services.js` 负责 API 分流、只读记忆、独立后台试聊和地图导入；以包内 `manifest.json` 的实际声明为准。安装或更新后在浏览器执行 `Ctrl+F5`，打开扩展设置，确认版本条诊断显示 `3.0.0-beta.1`。本项目无 npm 依赖、无打包步骤、无后端。

## 功能边界

- 五页手机式控制台只提供界面和数据入口，不自动替剧情做决定。
- NPC 模拟、在场判断、地点约束、日志生命周期沿用旧核心思路：系统提供约束，模型负责演绎；不修改角色卡、世界书或主聊天记录。
- 用户明确写入当前剧情的事实优先于角色卡初始设定：例如正文明确写出逃出监狱，会解除对应的初始囚禁投影；用户愿望、假设和模拟提案不会自动成为正史。正史保留消息来源锚点，消息删除/编辑后可撤销对应投影并恢复基线。
- 联系人页可查看 NPC 状态和日记。日记目标字数可选 `50`、`200`、`800`、`1600` 或“自定义”。目标是提示参数，不保证输出精确达到该字数。
- 联系人页的“试聊”是独立后台会话：结果不写入主聊天、不改变世界状态，只有用户主动按按钮才请求模型。
- 地图页只处理自身确认的地点、`tags` 与路线。导入地图 JSON 后，候选地点和路线必须由用户确认才进入自身目录；目录不写卡。
- 地图图片只接受本地 `PNG`、`JPG/JPEG`、`WebP` 数据 URL。不会自动兼容或调用第三方地图 API。

## 地图 JSON

导入文件使用以下结构。`id`、`fromId`、`toId` 可省略；省略时可使用对应的名称字段匹配。坐标范围是 `0..100`，路线天数必须是整数。`image` 只能是本地图片数据 URL。

```json
{
  "locations": [
    {
      "id": "harbor-01",
      "name": "雾港旧灯塔",
      "tags": ["海边", "高处"],
      "x": 24,
      "y": 68
    },
    {
      "id": "market-01",
      "name": "铜铃集市",
      "tags": ["集市"],
      "x": 66,
      "y": 44
    }
  ],
  "routes": [
    {
      "fromId": "harbor-01",
      "toId": "market-01",
      "durationDays": 1
    }
  ]
}
```

`image` 为可选字段，格式限 `data:image/(png|jpeg|webp);base64,` 后跟完整 Base64 图片数据；[完整示例](examples/map.example.json) 附带真实微型 PNG。

导入只产生待确认候选；用户确认后才保存。候选失败、未知字段或无法确认的路线保持未知，不会自动猜测或写入地点目录。

## API 与连接

主 API 生成使用 `generateRaw`，默认使用 ST 当前选定配置。插件不会通过静默续写接口把主聊天记录带入生成。

ST 副 API 使用已核实的 `ConnectionManagerRequestService` 方法 `getSupportedProfiles` 与 `sendRequest`。使用前，用户需要先在酒馆连接管理器配置连接 profile，再在 NPC Life 设置中选择副 profile 和任务路由。设置页提供类似 Connection Manager 的“编辑副 API 渠道”窗口：展示渠道名、API 类型、地址摘要、模型、温度/最大 token/超时/思考强度/流式/排除参数；密钥和永久地址仍由酒馆 Connection Manager 管理，不写入 NPC Life。`preset`、`model` 继承所选 profile；插件不切换主连接。副 API 失败时不会静默回退主 API，界面应显示失败原因。

模板只附加文本。插件不提供生成前 hard interception，也不能保证主模型遵守注入内容；解析到未知内容时保持未知。

## 记忆增强读取

可选读取 `window.stMemoryEnhancement.ext_getAllTables`（已核实版本 `2.2.19`）获取当前聊天最近的非用户消息表。读取默认关闭，开启后按关键词和行预算截取；相关行会发送给用户选定的 API。过期表格不会覆盖当前状态，也不会写入外部表。记忆读取是本地读取，但开启相关功能后仍可能产生模型请求。

## 数据与隐私

- 只有用户主动点击生成或试聊等模型操作按钮时才触发模型请求；地图导入确认等本地操作不因此请求模型。
- 插件不会自动跨消息调用模型，也不宣称“自动”或“不计费”。实际费用和请求行为取决于用户选择的连接配置。
- 持久化数据存放在 `extensionSettings['npc-life']`；界面布局和折叠状态使用浏览器 `localStorage`。
- 副 API 密钥由酒馆连接配置管理，插件自身不保存密钥。
- 连接功能目前限本机测试；本项目没有声称已调用真实 API 完成全部联调。

## 测试说明

浏览器 UI 测试和 API mocks 由主报告记录。测试方式与未完成的联调边界见 [TESTING.md](TESTING.md)。

## 许可

原作者标记为 YG。用户尚未指定开源许可证，本项目未附 `LICENSE`；本 README 不构成开源许可授予。
