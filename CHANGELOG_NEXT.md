## v1.11.0 — 每张监控卡都有自己的插件面板

之前只有最多 2 个插件面板（主聚合 + 我的聚合），第 3 张及之后的监控卡没有 UI 控件。

**v1.11.0 起**：

- **页面上所有监控卡都自动挂一个独立面板**（青蓝色主题 🎯）
- 标题显示该卡的标题文字（如「本卡聚合 · 钱包监控」）
- **默认 scope='panel'**：只聚合本卡当前展示的钱包（用户滚动卡时白名单累积）
- 完全独立的 config：阈值 / 时间窗 / 声音 / 浮窗 / 位置 / 分级开关 — 每张卡各保各的
- 储存在 `config.cardPanels[cardId]`，第 N 张卡 cardId = `card-N`

主聚合（金色）和我的聚合（绿色）行为不变，仍默认 scope='all' 全页面聚合。

**典型用法**：

- 主面板：全页面聚合（追全局热点）
- 我的面板：全页面 + 我的列过滤
- 卡 3+：仅本卡（每条链/每个分组独立监控）
- 任一个都能切浮窗 🪟、独立声音、独立阈值

实现细节：
- `extraPanels` 数组维护「每卡面板」状态（cardEl + alerts + cardId）
- `checkConvergence` variants 数组动态加入每卡 variant
- `bindPanelEvents` 用 cardId 区分配置读写路径
- `mountExtraPanels` 跟着 `startMountWatcher` 每 2 秒检查一次新卡

gmgn 单面板架构不受影响。
