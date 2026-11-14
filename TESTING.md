# beta.7 验证说明

运行扩展仍为三文件、无运行依赖。下述依赖只用于开发测试。

## 逻辑回归

```sh
bun tests/auto.test.mjs
```

虚构角色卡与聊天、mock生成，不访问网络，不读取真实用户数据。覆盖回复计数/冷却、结构化字段与引句、组织与歧义、私密不注入、当前场景过滤、单飞超时、关闭切卡、前台竞争、来源后缀撤回、12事务窗口外重建、旧格式保留、容量与备份导入。包含两轮“找药→拒绝→改变尝试→编辑后撤回”确定性场景；模型响应是fixture，不证明真实模型剧情质量。

## 真实宿主事件总线与jQuery组合

```sh
ST_ROOT=/path/to/SillyTavern UI_HAPPY_DOM=file:///path/to/happy-dom/lib/index.js bun tests/auto-ui.test.mjs
```

`ST_ROOT`只用于读取公开宿主EventEmitter及jQuery源码，不读取settings或用户聊天。`UI_HAPPY_DOM`未指定时从开发环境解析happy-dom。检查单开关、人物覆盖与组织拒绝、频率边界、结构化任务、STARTED/AFTER_COMMANDS/MESSAGE_SENT提示重建、暂停恢复、无效导入、清理后台及重复初始化。

## Edge真实布局（虚构页面）

```sh
ST_ROOT=/path/to/SillyTavern UI_LAYOUT=1 UI_HAPPY_DOM=file:///path/to/happy-dom/lib/index.js UI_PLAYWRIGHT=file:///path/to/playwright/index.mjs bun tests/auto-ui.test.mjs
```

Playwright使用本机Edge，在279/360/560px宽度检查横向溢出。不连接真实酒馆页面，没有绕过认证，也不把虚构页面当成实际卡片联调。

## 实际宿主/API待验证

- 主模型是否遵守结构化JSON和引用要求；特定预设/模板是否干扰独立请求；真实供应商是否遵守2400token预算。
- 不同模型能否自然地延续动机，且不将准备写成成功或泄漏自己猜测的心理。
- 各世界书命名格式的自动人物识别召回率；证据截取与否定/假设/回忆等语义的误差。
- 正文真实性由用户创作与模型决定，文本引用存在并不能完全证明事实语义正确。
- 超时不会取消已发请求；无独立取消signal，不保证免计费。其他后端自动任务明确停用，避免用共享响应预算冒充隔离。

当前测试不声称已完成真实付费API联调，不声称完全解决旧20字截断。历史完整版测试保留在legacy/beta5，与本次结果分开。
