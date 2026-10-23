# 侦查与页面理解（草案，待审）

2026-10-15。回答一个问题：写采集脚本或自动化流程之前，工具怎么让人和 AI 对**一个站点、一个页面**有整体、直观、可验证的了解。对应 `03` §5 `analyze`、§10 第 6 条；§12 的靶场场景接 `05` §5，从 s22 起编号。

来源有两部分：
- 主循环 10-15 用 0.1.0 在一个真实的后台类 Web 应用上的试用，相关结论标【实测】。
- 采集与浏览器自动化的一线经验和公开资料。各 UI 库、框架、协议的特征没有在本机逐一验过，统一按【待验】处理，落地前先用靶场验。

本文里的命令名都是提案，名字和 CLI 契约改动按 `AGENTS.md` 先提案再动手。

标注：【实测】跑过；【推断】间接推出；【待验】没验证。

## 0. 核心判断

1. **看页面是为了回答三个问题**，不是为了找按钮：
   - **数据在哪**：页面上哪一块是要的数据，背后是哪个接口、哪个字段，或者内嵌在哪段 HTML / 脚本里。
   - **数据怎么变**：哪些控件（日期范围、工作区、分页、筛选、tab）改了请求里的哪个参数。
   - **我现在在哪**：当前是哪个工作区 / 日期范围 / 地区 / 语言；有没有遮挡层；有没有刚闪过的报错。

   AX 树只能回答第一个问题里「控件在哪」那一小部分。
2. **分四层做**：
   - 站点层：`recon` 侦查档案；
   - 页面层：`outline` 页面地图；
   - 控件层：widget 适配器；
   - 数据通道层：解码器。
3. **适配器按控件、框架、通道做，不按网站做。** 站点适配器是维护地狱，也有法律风险，`03` §6 已经定了主仓库不放针对具体网站的模块。控件和框架适配器可复用、中立，适合社区贡献，是开源项目的护城河。
4. **感知分三层，每条结论标来源和置信度**：
   - ARIA：欧美站有 ADA 诉讼压力，加上欧盟无障碍法案 2025-06 生效，ARIA 质量普遍好；
   - DOM 启发式：国内后台和上古系统主要靠这层；
   - 视觉：带编号框的截图。

   三层互相印证，不单押一层。
5. **输出有预算**：
   - 渐进展开（站点 → 页面 → 区域 → 块 → 行）；
   - 样板区域每站只完整列一次，之后只说「未变」；
   - 动作之后只报变化。

## 1. 站点层：`recon` 侦查档案

资深工程师接一个站点，动手写脚本前要先回答下面这些问题。工具应该自动给出答案，产出一份人能读的 `dossier.md` 加一份机器可读的 `dossier.json`，写进证据包，格式另议，改 `04` 要作者批。

> 0.4-J 已实现 `recon` v0：只答第 1、2 问与第 4 问的 cookie 分类、第 8 问的防护识别（作者 10-16 定的四问），文件格式见 `04` §22；其余问题和 `--probe` 仍是本节草案。

| # | 问题 | 现在靠人怎么查 | 工具该给出什么 |
|---|---|---|---|
| 1 | 技术栈 | 翻源码、装 Wappalyzer | 框架和版本：`__NEXT_DATA__`、`ng-version`、`__VUE__` / `__vue_app__`、`__NUXT__`、React 根容器、`Turbolinks` / `Turbo`、`Ext.versions`、`jQuery.fn.jquery`。UI 库从类名前缀认（§5）。服务端从响应头、cookie 名、URL 认：`.jsp`、`.do`、`.action`、`.aspx`、`JSESSIONID`、`ASP.NET_SessionId`、`_rails_session`、`laravel_session`、`PHPSESSID`。认出来就知道该用哪套打法 |
| 2 | 数据在哪 | DevTools 一条条点 | 数据通道清单：整页 HTML、内嵌状态、XHR/JSON、GraphQL、OData、WebSocket、HTML 片段、服务端返回的 JS、下载文件、PDF。再给**覆盖率**：页面可见数据的文字有多少能在哪个来源里找到，比如「表格文字 92% 在 r-12」 |
| 3 | 能不能纯 HTTP 采 | 试了才知道 | 结论分三档：**纯接口可行** / **需要表单往返**（ViewState、一次性 token）/ **只能留在浏览器**（Blazor Server、签名参数、强防护、IE 专属控件）。每档附理由和证据 |
| 4 | 认证和会话 | 抄 cURL 反复试 | 认证类型：表单、SSO（CAS、SAML、OIDC）、HTTP 质询（Basic、NTLM/Negotiate）、客户端证书、MFA。cookie 按用途分类：会话 / CSRF / 同意 / A/B / 防护 / 统计。token 存在哪、怎么刷新、多久超时、会不会单会话互踢 |
| 5 | 分页和上限 | 手动翻到底 | 分页类型：offset、page、cursor、隐藏字段 POST、无限滚动、加载更多。有没有总数，结果上限多少，要不要按类别 / 时间 / 数值区间切分 |
| 6 | 参数从哪来、稳不稳 | 猜 | 依赖链（`03` 的 `deps`）。标出**随发布变化**的值：Next 的 buildId 和 Server Action id、GraphQL 持久化查询哈希、哈希类名、JSF 的 `j_id` |
| 7 | 地区和变体 | 换 IP 试 | 记录 Accept-Language、币种、地区 / 邮编、地区跳转、A/B 变体 cookie、CDN 缓存命中（`age`、`x-nextjs-cache`） |
| 8 | 防护和限流 | 被封了才知道 | **只识别、不绕过**：防护厂商的 cookie、脚本、挑战页特征，限流响应头（`retry-after`、`x-ratelimit-*`），robots.txt 结论。认出来以后交给人和 guard |
| 9 | 字段含义 | 对着页面猜 key | 页面标签和 JSON key 的对照（§3），以及响应 schema 推断，直接出类型定义和样例 |
| 10 | 现成的结构化数据和旁路 | 常被忽略 | JSON-LD、microdata、RDFa、OpenGraph；robots.txt 里的 sitemap、sitemap index；数据 feed、RSS；导出 Excel/CSV/PDF 的端点；打印视图 |
| 11 | 上古特征 | 踩坑才知道 | 字符集（GBK、Big5、Shift_JIS、windows-1252，以及 meta 和响应头不一致）；frameset 和 iframe 深度；IE 专属特征（§6.1）；旧 TLS；自签证书；内网代理 |

档案示意。下面的站点和数据是虚构的：

```
站点   admin.intranet.example
栈     JSP / Struts 1 · jQuery 1.8 + EasyUI 1.3 · frameset(3) + iframe 最深 4 层 · GBK
通道   表单 POST 回整页 72% · DWR 18% · 导出 .xls（实为 GBK HTML 表格）10%
认证   CAS 跳转（/cas/login?service=）→ JSESSIONID（带 URL 重写）；空闲 30 min 超时；单会话互踢
表单   Struts TOKEN 一次性 → 重放时每次先 GET 表单页
分页   POST 隐藏字段 pageNo + javascript:goPage(n)；共 1,284 条 / 65 页
防护   未识别到；内网，不适用 robots
结论   纯 HTTP 可行：会话 cookie + 每页先取 TOKEN + GBK 解码
下一步 录 3 页翻页做 diff；确认导出端点能否直接按条件下载
```

## 2. 页面层：`outline` 页面地图

控制在一屏以内（约 1.5k 字），按「上下文 → 遮挡 → 导航 → 区域 → 数据块 → 控件」组织。

### 2.1 例子：现代后台（Element UI）

页面结构来自 10-15 的真实页面【实测】，名称已换成中性示例。接口那行是示意，因为 0.1.0 没有溯源能力。

```
t1 示例后台 - 列表页  #/workspace/list  n-10   就绪 ✓ 可交互 ✓
上下文  用户 （已打码） · 日期范围 2026-09 [e155]
遮挡    dialog「系统提示」(修改密码) 挡住 main → 关闭 e183
导航    顶部 首页/列表/报表/设置（另有 23 个无名图标链接，已折叠）
        子菜单 列表* 批量打印 进度 设置 数据迁移
main
  筛选  名称搜索 [e154] · 日期范围 [e155]（只读，用 set-date）· tab 全部*/分组 A/分组 B
  表格  工作区列表 [e162]  可见 1 行 / 共 1 条 · 20 条/页 第 1 页
        列  ☐ | 名称（编号）| 状态 | … | 操作
        行1 示例工作区 | … | [进入 e221]
        来源 r-xxxx POST …/<列表接口>  $.data[*]（1/1 行对上）
  批量  批量归档 [e156] 批量新建 [e157]
隐藏    布局设置抽屉（8 个控件，--include-hidden 展开）
```

### 2.2 例子：上古 JSP 内网（frameset 加多层 iframe）

示意。

```
t1 XX 管理系统  /main.jsp  GBK   frameset 3 帧
帧树
  f1 top    /top.jsp       同源  用户 张三 · 部门 示例部门 · [退出 f1:e3]
  f2 left   /menu.jsp      同源  zTree 菜单 42 项（已折叠；find 可搜）
  f3 main   /query.do      同源
    f3.1 iframe#rptFrame   /report/list.do?pageNo=1   同源
      表单  查询条件：日期 [f3.1:e5]（My97 日期，在自己的 iframe 里）· 部门 [f3.1:e6] · [查询 f3.1:e7]（javascript:doQuery()）
      表格  数据表 [f3.1:e12]（外层另有 2 张布局表格，已剔除）  可见 20 行 / 共 1,284 条
            列  序号 | 编号 | 日期 | 数值 | 状态        （无 th，表头由加粗首行推断）
            分页 javascript:goPage(n)（POST 隐藏字段 pageNo、org.apache.struts.taglib.html.TOKEN）
            来源 本帧文档 POST /report/list.do（整页 HTML，无 JSON）
      导出  [导出 Excel f3.1:e30] → GET /report/export.do（响应实为 GBK HTML 表格）
遮挡    无
```

### 2.3 规则

- **遮挡排在最前**：`aria-modal` 对话框、同意弹窗、客服挂件、吸顶头部、iframe 弹层（layer.js type 2、门户类系统的 iframe 对话框）、会话超时提示、「选择地区」弹窗。今天卡住可信点击的就是一个遮挡层【实测：`covered by div.el-dialog__wrapper`】。
- **帧树是一等公民**：
  - 每帧写清名字、src、是否同源、深度；
  - ref 带帧路径（`f3.1:e12`），帧内数据块和外层分开列；
  - 跨帧调用（`parent.` / `top.` / `opener.`）和指向命名帧的提交（`target="main"`）要在回执里出现。
- **样板折叠**：同一站点的导航、菜单、页脚第二次起只说「未变」；连续的无名图标链接折叠成一行。0.1.0 每次快照都会重复 23 个无名链接和一个隐藏抽屉【实测】。
- **隐藏剪枝**：`display:none`、`visibility:hidden`、移出视口的抽屉、`aria-hidden` 默认不列，只给计数。
- **数据块摘要**：
  - 表格：列头、可见行数 / 总数、分页状态、前两行样本、来源；
  - 列表：项数和前两项的字段；
  - 表单：字段和当前值（密码照旧打码）；
  - 详情：键值对。
- **就绪和可交互是两件事**：SSR 和 hydration 页面在 `complete` 之后可能还不能点（§6.2），头部要单独标「可交互」。
- **瞬时信号**：toast、alert、加载遮罩统一通过 `aria-live` / `role=status|alert` 区域的变化、`aria-busy`、骨架屏、DOM 变动静止来判断。它们一出现就写进事件流，快照拍不到的东西事件流里也要有。它们是风控和会话过期的第一信号，guard 要用到。

## 3. 页面 ↔ 数据：溯源与动作回执

### 3.1 `where`：值从哪来

- `where <ref>` 或 `where "1,234.56"`：返回这个值来自哪个请求、什么解码链、哪个路径。路径可以是 JSON path、HTML 选择器，或者 flight / devalue 解码后的路径。
- **匹配前先归一化值**，否则大半对不上：
  - 数字：`1,234.56`、`1.234,56`、`1 234,56`（NBSP）、`1'234.56`、`1,23,456`、`(1,234.56)` 表示负数、尾随负号 `1234-`、`1234.5600`、全角数字；
  - 日期：`2026-09` ↔ `202609`、MM/DD 和 DD/MM 的歧义（同页其他值能消歧时才判）、相对时间「2 days ago」、时区；
  - 编码与方向：带点的分级编码 `1001.01` ↔ `100101`；方向标记（如 `IN` / `OUT`）↔ `1` / `-1`；空 ↔ 0 ↔ null；
  - 文本：GBK 与 UTF-8、HTML 实体、JS 字符串转义（服务端返回的 JS 里嵌着数据，§6.1）、首尾空白和 `&nbsp;` 填充。
- **整表对齐**：表格各行和响应里的数组（或 HTML 行）对齐，输出「列 → 字段」映射和匹配率，比如「编号 ← pfx+seq」「数量 ← qty」。这就是写采集代码时的字段映射草稿。
- **schema 推断**：根据多次录到的响应推出字段类型、可空性、枚举，并附上页面标签作注释，导出成 Python dataclass / TypedDict 和样例。

### 3.2 动作回执

每次 click、fill、select、切 tab、提交之后，自动附一份回执：
- 触发了哪些请求，包括跨帧的和弹窗里的；
- 和上一次同类请求比，参数变了哪些（`pageIndex 1→2`、`period 202609→202608`、`__EVENTTARGET=gvList`）；
- 页面哪些块变了，哪个帧换了文档；
- 期间出现过的瞬时信号；
- 有没有新开窗口或弹窗。

这是学分页、日期范围、切换上下文参数最快的办法。0.2 的 `wait` 和 `net wait` 已经有了一半。

## 4. 定位与操作

- **按行定位**：`find button 进入 --row "示例工作区"`。后台列表多是对某一条记录操作（进入、编辑、导出），按行找最多。
- **能点的非语义元素也要有 ref**，判断依据按可靠度排：
  - 元素自身有监听（`DOMDebugger.getEventListeners`）；
  - 框架的委托监听：React 17+ 把事件挂在根容器上，看元素上 `__reactProps$*` 的 `onClick`；Vue 3 看 `el._vei`；jQuery 看 `$._data(el, "events")` 和委托选择器；
  - `onclick` 属性、`javascript:` href；
  - `cursor:pointer`、`tabindex`。

  每条标上判据。0.1.0 漏了「记住密码」复选框和顶部的 div 按钮【实测】。
- **文字命中返回最近的可点祖先**，可点的排在前面。0.1.0 把不可点的 cell 排在可点的 button 前面，文字节点返回了外层 form 的 ref【实测】。
- **逃生口**：支持 `--css` / `--xpath`，可以跨 shadow、跨帧。
- **稳定选择器建议**：给一个 ref，输出几条按稳定性排序的候选，供写独立脚本用。
  - 加分：`data-testid` / `data-test` / `data-qa`、语义 id、`name`、ARIA、可见文本、结构路径。
  - 降权：哈希类名（styled-components、Emotion 的 `css-xxxx`、CSS Modules、Tailwind 原子类）、自动生成的 id（Ext JS 的 `ext-gen123` / `ext-comp-1001`、JSF 的 `j_id_xx`、React `useId` 的 `:r1:`、Element 的 `el-id-xxxx`、ASP.NET 的 `ctl00_…`。最后这个其实稳定，但很长，可以接受）。
- **旧 ref 自动重找，绝不假成功**：节点被重渲染后，按「角色 + 名字 + 路径」重新定位，标 `re-resolved`；找不到就报 `stale-ref`。0.1.0 对已脱离 DOM 的节点做 DOM 点击会返回 ok【实测】，`05` s18 已立。
- **高层动作**按控件适配器分派，事后**回读校验**，校验失败就报错：
  - `select <ref> "选项"`；
  - `set-date <ref> 2026-09[..2026-12]`；
  - `upload <ref> <file>`（`DOM.setFileInputFiles`）；
  - `extract table|list <ref>`。

## 5. 控件层：UI 库的特征和痛点

### 5.1 现代库

| 控件类 | 涉及的库 | 痛点 | 适配器做什么 |
|---|---|---|---|
| 浮层（portal） | MUI、AntD、Element、Radix、Headless UI、Vuetify、Angular CDK、PrimeNG / PrimeVue、Naive UI | 下拉、菜单、日期面板、tooltip 渲染到 body 末尾，离触发器很远，只在打开时存在，失焦就关 | 用 `aria-controls` / `aria-owns` / `aria-activedescendant` 关联，在地图里标出「属于 e12」；在焦点仿真下保持打开 |
| 自定义下拉 / 组合框 | React-Select（类名是哈希）、MUI Autocomplete、AntD Select（rc-virtual-list 只渲染约 10 项）、el-select、v-select、mat-select、Headless Combobox | 不是原生 select；选项虚拟化；输入后异步搜索 | `select` 阶梯：原生 → ARIA listbox → 打开、输入、滚动、选中 → 回读 |
| 日期选择 | 各库都有，另有上古的 My97DatePicker（自带 iframe）和 jQuery UI datepicker | 输入框只读、月份或区间选择、格式随地区变 | `set-date` 阶梯：设值并触发框架事件 → 调框架 API → 键入 → 日历翻页 → 回读 |
| 数据表格 | AG Grid（行列双向虚拟化，固定列在 `ag-pinned-*` 独立容器）、MUI DataGrid、TanStack Table（无样式）、Handsontable、Kendo、DevExtreme、SAP UI5 Table、lightning-datatable（在 shadow 里）、el-table（固定列另渲染成表）、AntD Table、PrimeNG、Vuetify、mat-table | 虚拟化、固定列被拆开、表头分组、行分组、树形懒加载、单元格是自定义渲染器 | 优先按 `aria-rowindex` / `aria-colindex` 重建；拿 `aria-rowcount` 和实际渲染行数对比判断是否虚拟化；固定列按行号拼回；树形表报出「已展开 / 总节点」；虚拟化时指向背后的接口 |
| 虚拟列表 / 无限滚动 | react-window、react-virtuoso、vue-virtual-scroller、TanStack Virtual、CDK virtual scroll | DOM 里只有 20 条；靠 IntersectionObserver 哨兵或「加载更多」 | 标「已渲染 20 / 约 5000」；给出接口和分页参数；滚动加载只在显式要求时才做 |
| Shadow DOM / Web Components | Shoelace / Web Awesome、Ionic、Adobe Spectrum、Fluent、UI5 Web Components、Material Web、Stencil | CSS 选择器进不去；有闭合的 shadow root | 穿透选择器；用 CDP 的 `pierce` 处理闭合 root；在地图里画出边界 |
| 表单 | React 受控输入、掩码输入（imask、cleave）、藏起原生 input 的复选框 / 单选 / 开关、富文本（ProseMirror / Tiptap、Slate、Quill、iframe 里的 TinyMCE / CKEditor、Monaco、CodeMirror） | 填了框架状态没更新；必须逐字键入；该点的是 label | `fill` 按控件类型分派；掩码输入逐字键入；富文本走编辑器 API 或 `insertText`；一律回读 |
| 弹窗和焦点陷阱 | focus-trap、`aria-modal`、滚动锁 | 和焦点仿真、可信输入打架 | 识别出来，回执里写明「焦点被困在 dialog 里」 |
| 通知 / toast | MUI Snackbar、notistack、react-toastify、Sonner、AntD message、ElMessage、MatSnackBar、PrimeNG Toast、Toastr | 一两秒就消失 | 统一靠 `aria-live` 区域，已知容器作补充（§2.3） |
| 图表 | ECharts、Chart.js、Plotly、Highcharts、amCharts、D3 | 数据只在 JS 实例里，从 SVG / canvas 抠很难 | 只读实例数据：`echarts.getInstanceByDom(el).getOption()`、`Chart.getChart(canvas)`、`el.data`（Plotly）、`Highcharts.charts`。仪表盘和报表页很需要 |
| Canvas 渲染 | Flutter Web、在线文档 / 表格类应用 | 没有 DOM | Flutter 点隐藏的「Enable accessibility」占位（`flt-semantics-placeholder`）就会生成语义树；其他情况走接口加编号截图 |

### 5.2 上古库（内网、政府、老式管理系统常见）

| 库 / 组件 | 特征和痛点 | 适配器做什么 |
|---|---|---|
| jQuery EasyUI | datagrid 固定列分在 `.datagrid-view1` / `.datagrid-view2` 两块；combo、tree、dialog 都是 div 拼的；国内内网极常见 | 按行号拼回固定列；读 `$(el).datagrid('getData')` 拿原始行 |
| layui / layer.js | `layui-table-fixed` 固定列重复渲染；`layer.open({type:2})` 弹出 iframe 弹层 | 拼回固定列；把 iframe 弹层识别为对话框，内容可以操作 |
| Ext JS（3–7） | 全是 div；自动 id `ext-gen*`；grid 缓冲渲染；数据在 Store 里；Ext.Direct 通道 | 读 `Ext.ComponentQuery` / store 数据；选择器降权自动 id |
| jqGrid、DataTables、Bootstrap Table | 冻结列复制；DataTables 服务端模式参数是 `draw` / `start` / `length` | 识别分页参数，直接指向接口 |
| jQuery UI、Dojo dijit、YUI | widget 是 div 拼的；旧版 ARIA 很少 | 靠类名和结构认 |
| zTree、各类树 | 懒加载节点；节点是 `<a>` 加 `onclick` | 报出展开状态，指向懒加载接口 |
| My97DatePicker | 日期面板在自己的 iframe 里 | `set-date` 直接设 input 值并触发 `onpicked` 一类事件 |
| 报表查看器 | SSRS ReportViewer（WebForms 异步回发，导出走 `Reserved.ReportViewerWebControl.axd`）、Crystal、JasperReports 等 | 分页走 viewer 自己的 API，DOM 是绝对定位的 div 碎片 | 识别出 viewer，**直接指向导出端点**（CSV / Excel 往往最干净）；DOM 抽取只作兜底 |
| 门户框架 | 老式企业门户：主内容放在固定命名的 iframe 里，模态框也是 iframe；iframe 名字随产品固定，可作识别特征 | 主内容总在某个命名 iframe 里 | 认出门户以后直接把主帧当成工作区，地图从主帧开始画 |

## 6. 数据通道层：数据藏在哪

### 6.1 上古服务端渲染（JSP / Servlet / Struts / JSF、ASP 经典版 / WebForms、PHP、老 Rails / Django）

- **frameset 和 iframe 层层嵌套**：
  - frameset 加 3–5 层同源 iframe；提交和跳转指向命名帧（`target="main"`）；
  - 跨帧调用 `parent.doQuery()`、`top.frames['main']`；
  - 用隐藏帧做「伪 ajax」：表单提交到隐藏 iframe，再由返回的脚本回写父页面。

  工具要有帧树、带帧路径的 ref、按帧归属的请求，回执里要列出跨帧动作。
- **参照选择窗口**：点「选择」后 `window.open` 一个查询窗口，选中后用 `opener.document.forms[0].x.value=…` 回填并关窗。老式管理系统里很常见。弹窗必须可以操作（`05` s17），回填的变化要进主页回执。
- **`showModalDialog`**：Chrome 37 起已删除。依赖它的系统在 Chromium 里会坏掉，或者自带 polyfill。recon 要识别并在结论里说明。
- **表单状态与一次性 token**：
  - 大量隐藏字段；
  - Struts 的 `org.apache.struts.taglib.html.TOKEN`、Rails 的 `authenticity_token` 和 `<meta name="csrf-token">`、Django 的 `csrfmiddlewaretoken`、Spring 的 `_csrf`、Laravel 的 `_token`；
  - ASP.NET 的 `__VIEWSTATE` / `__EVENTVALIDATION` / `__RequestVerificationToken`、JSF 的 `javax.faces.ViewState`。

  recon 要标出「重放前必须先取表单」，回执里显示隐藏字段的变化。
- **`javascript:` 链接和 POST 分页**：`href="javascript:goPage(3)"`、`onclick="doQuery()"`；分页是隐藏字段 `pageNo` 加 POST 整页回来；后退会提示「页面已过期」。
- **局部更新的私有协议**：
  - ASP.NET UpdatePanel：管道分隔的增量，`长度|类型|id|内容|`；
  - JSF / PrimeFaces：partial-response XML；
  - DWR：`/dwr/call/plaincall/*.dwr`，响应是一段 JS 文本；
  - Ext.Direct；
  - jQuery `.load()`：HTML 片段；
  - Rails `data-remote`：返回 `text/javascript`，也就是服务端生成的 JS，数据嵌在 JS 字符串里，`find` 要先解 JS 转义；
  - Turbolinks：替换 body，没有整页导航事件；会先显示**缓存的旧快照**再刷新，旧快照不能当真。
- **伪装成链接的写操作**：rails-ujs 的 `<a data-method="delete">` 点一下就是 POST `_method=delete`，`data-confirm` 会弹 confirm。recon 和 outline 必须把它标成「写操作」。按 `AGENTS.md` 的规则，写操作要人确认，爬虫式遍历链接绝不能点它。
- **字符集**：
  - GBK、GB2312、Big5、Shift_JIS、windows-1252；meta 和响应头不一致；
  - 表单按页面字符集提交；URL 里是 GBK 百分号编码（`%D6%D0`）；
  - 「导出 .xls」其实是 GBK 的 HTML 表格或 CSV。

  证据包里的正文、`find`、`where` 都要按正确的字符集解码。
- **布局表格**：数据表格套在两三层布局表格里，没有 `<th>`，表头是加粗的首行，满是 `<font>`、`&nbsp;` 填充和合计行。`extract` 要分得清布局表格和数据表格，能推断表头、标出合计行。
- **IE 专属**：ActiveX（`<object classid=…>`，USB key、证书、打印控件）、`document.all` 分支、VBScript、`attachEvent`、怪异模式、UA 检测后跳到「请使用 IE 浏览器」。recon 结论要写「需 IE 模式（Edge IE mode），在 Chromium 里不可自动化」，然后交给人。
- **会话**：`JSESSIONID` 和 URL 重写的 `;jsessionid=`、空闲超时短、单会话互踢、重复提交保护。
- **认证**：
  - CAS（`/cas/login?service=` → `ticket=ST-…`）；
  - HTTP 质询（Basic、NTLM/Negotiate，即 Windows 集成认证）：要走 `Fetch.authRequired`，否则标签会卡在浏览器原生登录框；
  - 客户端证书和 USB key；
  - 内网代理、自签证书、旧 TLS：Chrome 已不支持 TLS 1.0/1.1，要明确报错，不能只报超时。
- **总体**：只要不是 IE 专属，这类站点通常**最适合纯 HTTP**。结论多半是「HTML 解析 + 表单往返 + 字符集」，难点在侦查阶段把帧、token、字符集摸清楚。

### 6.2 现代前后端一体 SSR

| 框架 | 首屏数据 | 客户端导航 / 交互的数据 | 坑 |
|---|---|---|---|
| Next.js Pages Router | `__NEXT_DATA__` JSON | `/_next/data/<buildId>/…json` | buildId 每次发布都变 |
| Next.js App Router | RSC flight：`self.__next_f.push([...])`，不是 JSON | `?_rsc=` 请求，带 `RSC: 1` 头，返回 flight；Server Action 是 POST，带 `Next-Action: <id>` 头 | flight 要专门解码；action id 随构建变化；流式 Suspense 先发占位，数据在 `<div hidden id="S:0">` 里，再由 `$RC` 搬过去，所以 `complete` 时数据可能还没到位 |
| Remix / React Router 7 | `window.__remixContext` / `__reactRouterContext` | 旧版 `?_data=routes/…`，新版 `.data`（turbo-stream 序列化，不是 JSON） | 又一种私有序列化格式 |
| Nuxt 3 | `<script id="__NUXT_DATA__">`（devalue 格式）；Nuxt 2 是 `window.__NUXT__` | `_payload.json`；Nitro 的 `/api/*` 常常是干净 JSON | devalue 是带引用的扁平数组，要还原 |
| SvelteKit | 内联 devalue | `__data.json`；表单 action 是 `?/name` | 同上 |
| Astro / Qwik / Fresh | island 的 props 序列化在属性里（`astro-island props=`）；Qwik 是 `qwik/json` | 各家私有 | 只有 island 能交互 |
| Inertia.js（Laravel / Rails） | `#app` 上的 `data-page` JSON（新版也可能是 script 标签） | 带 `X-Inertia: true` 头的请求返回 JSON 页面对象 | 最友好的一类：整页 props 就是 JSON |
| Hotwire（Rails 7+） | 整页 HTML | Turbo Drive 换 body；Turbo Frame 懒加载 HTML 片段（`<turbo-frame src>`）；Turbo Stream（`text/vnd.turbo-stream.html`，或经 ActionCable WebSocket） | 数据是 HTML 片段，溯源要支持 HTML 路径 |
| Livewire | `wire:snapshot` 属性里的 JSON | POST `/livewire/update`，带 snapshot 和 checksum | snapshot 带签名，只能在浏览器里交互 |
| Phoenix LiveView | 整页 HTML | WebSocket diff（JSON） | 数据只从 ws 来 |
| Blazor | Server 版：SignalR 上的二进制渲染批次；WASM 版：自己调 API | — | Server 版基本只能留在浏览器 |
| Angular SSR | `<script id="ng-state">` TransferState（旧版 `serverApp-state`） | 普通 XHR | — |

共同的坑：
- **首屏没有 XHR**：数据内联在 HTML 里，客户端导航后又换了一种格式。recon 要写清「首屏：flight；导航：`?_rsc=`；没有 JSON API」，再建议走哪条。
- **hydration 空窗**：SSR 的按钮在 hydration 前点了不响应，点击会丢。0.1.0 没有区分「就绪」和「可交互」。要靠目标元素或框架根容器上是否已挂监听来判断（§4），报 `not-interactive` 并给出等待建议。
- **随构建变化的标识**：buildId、Server Action id、持久化查询哈希。replay 和 watch 要知道哪些值需要每次从页面重取。
- **缓存与边缘**：ISR / CDN 返回的可能是旧数据（`x-nextjs-cache: STALE`、`age`）；edge middleware 按地区和 A/B 分流。都要记进档案。

### 6.3 SPA / API

- **REST、JSON:API、SSE**：常规。
- **GraphQL**：
  - 所有请求打同一个端点，`net list` 要按 `operationName` 分组，`diff` 按 variables 比；
  - 持久化查询（APQ 的 `sha256Hash`）随发布变化；
  - 批量请求（数组体）；`@defer` / `@stream` 返回 multipart；订阅走 `graphql-ws`。
- **OData**：`$batch` 返回 `multipart/mixed`，要拆开子响应；分页靠 `$skiptoken` / `@odata.nextLink`。
- **gRPC-web / Connect**：protobuf 做无 schema 解码，这一项 `03` 已列。
- **WebSocket 上的应用层封装**：Socket.IO（`42["event",{…}]`）、STOMP、SignalR、ActionCable。帧已经能录（0.2-A），要补解码。
- **应用层加密**：比如 `{"p":"…"}` / `{"m":"…"}` 的 AES 体【实测：10-15 真实站点】。`find` 0 命中时要提示「疑似加密」（`05` s21）；追踪模式下记录页面解密后的明文（`03` §10.4）。

### 6.4 结构化与旁路数据

- JSON-LD（Product、Offer、AggregateRating、BreadcrumbList、JobPosting、Event 等）、microdata、RDFa、OpenGraph。欧美站为了 SEO 普遍都有，等于白给的结构化数据。
- robots.txt 里列的 sitemap、sitemap index、数据 feed、RSS；部分建站平台公开的 JSON 列表端点。全量枚举往往从这里走，绕开搜索结果上限。
- 下载（Excel、CSV、PDF）、打印视图、报表导出端点：要能进证据包（`Browser.setDownloadBehavior`）。
- 图表实例数据（§5.1）。

### 6.5 解码器清单

| 格式 | 怎么识别 | 解码 |
|---|---|---|
| gzip / br / base64 / URL 编码 | 已有（0.2 `analyze find`） | 已有 |
| 字符集 | 响应头、meta、BOM、字节特征 | GBK、Big5、Shift_JIS、windows-1252 → UTF-8 |
| JS 字符串 | `text/javascript` 响应、内联脚本 | 先解转义，再在字符串字面量里搜 |
| RSC flight | `self.__next_f`、`RSC: 1`、`text/x-component` | 按行解出 `id:类型:载荷`，再递归 JSON |
| devalue | `__NUXT_DATA__`、`__data.json` | 还原带引用的扁平数组 |
| turbo-stream（Remix） | `.data` 请求 | 同类还原 |
| Inertia | `data-page`、`X-Inertia` | 就是 JSON |
| UpdatePanel 增量 | `|updatePanel|` 管道格式 | 按长度切段 |
| JSF partial-response | XML `<partial-response>` | 取 `<update>` 里的 CDATA |
| DWR | `/dwr/` 路径 | 解析 JS 文本里的字面量 |
| multipart（OData `$batch`、`@defer`） | `multipart/mixed` | 拆开子响应 |
| Socket.IO / STOMP / SignalR | 帧前缀 | 去掉封装取载荷 |
| protobuf | `application/x-protobuf`、`grpc-web` | 无 schema 解码 |

## 7. 欧美目标的特有痛点

- **同意弹窗（GDPR / CCPA）**：OneTrust 在 DOM 里，Usercentrics 在 shadow 里，Sourcepoint 在 iframe 里。第一次访问必然挡路，而且同意与否会改变加载的脚本和内容。工具负责识别和标出遮挡；**同意由人点**，因为那是用户的法律行为。同意状态记进档案。
- **地区、币种**：内容随邮编和地区变（「选择地区」弹窗），还有 geo-IP 跳转。档案里要记录当时的上下文。
- **登录**：
  - SSO：Okta、Entra ID、Auth0、Ping，SAML 用 POST 跳转链；
  - MFA：TOTP、短信、Duo / Okta 推送；
  - passkey / WebAuthn：CDP 有虚拟认证器，但应交给人；
  - 「记住这台设备」cookie；
  - 会话超时的「你还在吗」：安全要求高的站点常见，要识别并提醒保活。
- **大型企业门户**：Web Components 用 shadow DOM、部分页面仍有 ViewState、OData `$batch`；公共服务类站点常见 WebForms 加验证码。下载、打印、PDF 是主要的数据通道。
- **有官方 API 的 SaaS**：档案里应提示「优先走官方 API」。数字常见 `(1,234.56)` 表示负数。
- **大列表**：搜索结果有上限，要按类别、数值区间切分；sitemap 和 feed 往往是全量枚举最好的入口。
- **防护普遍存在**：Cloudflare、Akamai、HUMAN（PerimeterX）、DataDome、Imperva、Kasada、F5、AWS WAF，再加上 reCAPTCHA、hCaptcha、Turnstile、Arkose。只认 cookie、脚本、挑战页特征，然后交人，与 `03` §6 一致。
- **合规就是开源项目的名声**：默认限速（guard）；档案显示 robots 结论；定位成「分析你自己的会话」。登录后的数据和 ToS 一直是风险。

## 8. 国内目标的特有痛点（同样不按网站做）

- **Element UI / Element Plus、AntD、layui、EasyUI 后台**：固定列重复渲染、复选框藏起原生 input、只读日期框、单元格级的弹层。
- **门户弹窗进子系统**：门户点一下就 `window.open` 进子系统。弹窗必须可以操作，而且不能抢前台【实测：0.1.0 弹窗约 0.8 s 后把 Chrome 拉到前台，`05` s17】。
- **页面扫描本机端口**：页面探测本地客户端或检测工具，在 `127.0.0.1` 上留下大量失败请求【实测 10-15，`05` s20】。
- **请求体和响应体被应用层 AES 加密**【实测，`05` s21】。
- **iframe 弹层**（layer.js）、My97 日期控件、报表查看器、zTree 菜单、GBK 编码的老式管理系统。
- **IE 专属控件**（USB key、证书、打印）：recon 写「需 IE 模式」后交给人。

## 9. 架构建议

1. **适配器注册表**，做成声明式数据加小段页面内 JS，分六类：
   - `widget`（§5）、`framework`（§6.2）、`channel`（§6.5 解码器）、`overlay`（同意弹窗、iframe 弹层、超时提示）、`protection`（只识别）、`viewer`（报表查看器、门户框架）。

   每个适配器有五个钩子：
   - `detect`：靠类名前缀、全局变量、DOM 特征、响应头认出自己，给置信度；
   - `describe`：在地图里怎么呈现；
   - `act`：select、set-date、extract 等怎么做，事后怎么回读；
   - `read`：只读的实例数据，比如 store、图表 option、grid data；
   - `decode`：通道解码。

   每个适配器自带一个靶场页面和 `expected.json`（§12）。只读的 `read` 也要在页面里执行 JS；它不改变页面行为，但仍要在输出里标明「读了实例数据」。
2. **感知三层叠加**：ARIA、启发式、视觉，每个元素和数据块都标出判据，冲突时都列出来，不偷偷取一个。
3. **主动探测必须过 guard**：参数消融（去掉某个 header 或 cookie 重放，看是不是必需）、探分页终点、试导出端点，都会多发请求。默认关闭，显式 `--probe` 才开，并受站点预算限制。
4. **地图、回执、档案都写进证据包**：它们是结论，要能用同一份包复算（「证据要新」）。事件种类和格式改的是 `04`，需要作者批。
5. **靶场依赖只用 MIT / Apache / BSD 许可的库**（MUI、AntD、Element Plus、AG Grid Community、ECharts、Chart.js、layui、Shoelace 等）。商业库或非开源许可的（Highcharts、Ext JS、Kendo、DevExtreme、商业报表工具、AG Grid Enterprise 功能）用结构等价的桩页，不打包这些库本身。

## 10. 命令提案（名字待定）

| 命令 | 做什么 |
|---|---|
| `recon [url]` | 站点侦查档案（§1）；默认只看已录的证据和当前页面，`--probe` 才主动发请求 |
| `outline [--frame f3.1] [--include-hidden] [--depth N]` | 页面地图（§2） |
| `frames` | 帧树（名字、src、是否同源、深度、文档字符集） |
| `where <ref>\|<text>` | 值溯源（§3.1） |
| `align <table-ref>` | 表格与响应对齐，输出「列 → 字段」 |
| `shape <request-pattern>`（不在 0.4） | 根据多次响应推断 schema，导出类型定义。**0.6-G 已实现**为 `analyze shape <bundle> [--request r-N \| --template "GET /path"]`（按端点的类型树与出现次数，`exports/shape.json`）与 `analyze schema-diff <旧包> <新包>`（字段增删、类型 / 可选性 / 枚举变化，漂移时退出码 1）；离线读证据包，不导出类型定义文件（`04` §32） |
| `extract table\|list <ref> [--format json\|csv]` | 走控件适配器抽取（§5） |
| `select <ref> <option>` / `set-date <ref> <value>` / `upload <ref> <file>` | 高层动作，事后回读 |
| `find … --row <text>` / `--css` / `--xpath` | 定位增强（§4） |
| `selector <ref>` | 稳定选择器建议 |
| `screenshot --annotate` | 带编号框的截图，编号就是 ref |
| 动作回执 | 不是独立命令：click、fill、select、提交等的输出里自带 `receipt` 字段（§3.2） |

## 11. 优先级

- **P0**：
  - `outline`（含帧树、遮挡、样板折叠、隐藏剪枝、表格摘要、「可交互」标记）；
  - 动作回执；
  - 按行定位、能点元素的识别、旧 ref 重找。

  做完这几项才算「能看懂页面、点得准」。0.1.0 试用里卡住的几处都在这里【实测】。
- **P1**：
  - `where` 加值归一化（数字、日期、字符集、编码与方向）；
  - `recon` v0：技术栈指纹、通道分类和覆盖率、cookie 分类、结构化数据、防护识别、可行性结论；
  - 内嵌状态解码器：flight、devalue、Inertia、UpdatePanel、JSF、JS 字符串；
  - 带帧路径的 ref 和按帧归属的请求；
  - `screenshot --annotate`；
  - 表格适配器：el-table、EasyUI、layui、AG Grid、MUI DataGrid、布局表格剔除。
- **P2**：
  - `select` / `set-date` / `upload` 的完整阶梯；
  - 图表 `read`；
  - 报表查看器和门户框架适配器；
  - `align` / `schema`；
  - `--probe` 参数消融；
  - Socket.IO / STOMP / SignalR 解码；
  - 同意弹窗、超时提示的 overlay 适配器。

## 12. 靶场场景提案（接 `05` §5，s22 起）

页面一律不模仿任何真实站点的品牌和界面；用真实开源库搭控件，商业库用结构等价的桩。优先级沿用 `05` 的记法。

| 编号 | 名称 | 页面 | 证明什么 | 优先级 |
|---|---|---|---|---|
| s22 | jsp-frameset | frameset 三帧，main 里再套 3 层同源 iframe；`target="main"` 的表单提交；`parent.goPage()` 跨帧调用 | `outline` 出帧树；带帧路径的 ref 能点；请求挂到正确的帧；回执列出跨帧动作 | P1 |
| s23 | lookup-popup-opener | 「选择」按钮打开参照窗口，选中后用 `opener` 回填并关窗 | 弹窗可以操作、不抢前台；回填的值出现在主页回执里 | P1 |
| s24 | iframe-modal-and-my97 | layer.js 风格的 iframe 弹层 + 自带 iframe 的日期控件 | 弹层识别为对话框，内容可操作；`set-date` 成功并回读 | P1 |
| s25 | gbk-legacy-form | GBK 页面，meta 和响应头的 charset 冲突；GBK 表单 POST；「.xls」导出实为 GBK HTML 表格 | 正文正确解码；`find` 能命中中文；导出被识别并进包 | P1 |
| s26 | postback-and-token | WebForms 风格 `__VIEWSTATE` + `__doPostBack` 分页 + UpdatePanel 增量；另一页是 Struts 风格一次性 TOKEN | 通道分类为 postback；回执显示隐藏字段的变化；recon 标出「重放前先取表单」；增量被解码 | P1 |
| s27 | layout-tables | 布局表格套数据表格，无 `th`，`<font>`、`&nbsp;`，有合计行 | `extract` 剔除布局表格、推断表头、标出合计行 | P1 |
| s28 | rails-ujs-sjr-turbolinks | `data-remote` 表单返回 `text/javascript`（数据在 JS 字符串里）；`data-method="delete"` 链接加 `data-confirm`；Turbolinks 缓存预览 | `find` 命中 JS 字符串里的值；危险链接标为写操作；不把预览快照当真 | P1 |
| s29 | ie-only-detect | ActiveX `object`、`document.all` 分支、`showModalDialog` 调用、UA 检测后跳「请使用 IE」 | recon 结论为「需 IE 模式」并交人 | P2 |
| s30 | next-app-router | 流式 Suspense + RSC flight + 客户端导航 `?_rsc=` + Server Action 提交 | `find` / `where` 命中 flight 里的值；流式完成前不报「数据就绪」；回执识别出 Server Action | P1 |
| s31 | devalue-and-inertia | Nuxt 风格 `__NUXT_DATA__` 的 devalue 数据 + Inertia 风格的 `data-page` 和 `X-Inertia` JSON 导航 | 解码后能命中；recon 写出首屏与导航两种格式 | P1 |
| s32 | hydration-gap | SSR 按钮在 hydration 前 1.5 s 不响应 | `outline` 标出不可交互；`click` 报 `not-interactive` 或等到监听挂上再点；不假成功 | P1 |
| s33 | turbo-frames-streams | Turbo Frame 懒加载 + Turbo Stream 响应 | 片段归到所属区域；回执显示片段替换；溯源支持 HTML 路径 | P2 |
| s34 | graphql-apq-batch | APQ 持久化查询 + 批量请求 + `@defer` | `net list` 按 operationName 分组；`diff` 比 variables；multipart 被拆开 | P1 |
| s35 | odata-batch | `$batch` multipart/mixed + `$skiptoken` 分页 | 拆开子响应后能 `find`；识别出分页参数 | P2 |
| s36 | consent-overlays | 通用结构的同意弹窗，DOM 版、shadow 版、iframe 版各一个 | 都识别为遮挡；工具不自动点同意，交给人 | P1 |
| s37 | virtual-grid | AG Grid Community 行列虚拟化 + 固定列容器 + `aria-rowindex` / `aria-rowcount`；el-table / EasyUI 风格的固定列重复渲染 | `extract` 重建完整行；标出虚拟化比例并指向接口；固定列按行号拼回 | P1 |
| s38 | portal-select-datepicker | 虚拟化下拉（只渲染 10 项）+ 异步搜索组合框 + 只读日期输入 + 区间日期 | `select` / `set-date` 成功并回读；浮层关联到触发器 | P2 |
| s39 | transient-toast-busy | `aria-live` 提示 1.5 s 后消失 + `aria-busy` 骨架屏 + 加载遮罩 | 事件流里有提示；`wait --settled` 等到真正静止 | P1 |
| s40 | locale-numbers | 同一份数据按 en-US / de-DE / fr-FR / en-IN、括号负数、尾随负号、方向标记、带点的分级编码分别渲染 | `where` 都能对回同一个 JSON 值 | P1 |
| s43 | structured-data | JSON-LD Product / Offer + robots.txt 里列的 sitemap index | recon 列出结构化数据和 sitemap | P1 |
| s44 | legacy-auth | CAS 风格跳转加票据；HTTP Basic 质询（NTLM 难在本地造，用 Negotiate 头模拟质询流程） | recon 认出认证类型；质询不让标签卡在原生登录框 | P2 |
| s45 | session-timeout-kick | 「你还在吗」倒计时弹窗 + 单会话互踢 | 识别为遮挡并提醒人；互踢后识别为会话失效，交给 guard / handoff | P2 |
| s57 | chart-instance | 数据只在 ECharts / Chart.js 实例里 | `read` 拿到 series 数据；`where` 能指向实例 | P2 |
| s58 | report-viewer | 报表查看器风格：iframe + 绝对定位的 div 碎片 + 分页 API + 导出端点 | recon 认出查看器并指向导出端点；导出文件进包 | P2 |

10-21 改号：s57（原 s41）、s58（原 s42）。原来的两个号与 `05` 已落地的 s41 embedded-state、s42 decode-plugins 撞号，改用空号；`05` §20 场景索引列了全部编号与空号。

## 13. 主循环的意见（10-15，供作者决策；本节没有任何已定事项）

**我认为可以采纳的判断**（待作者定）：§0 的三个问题、四层划分、适配器按控件 / 框架 / 通道而不按网站、感知三层互相印证、输出有预算、主动探测过 guard、靶场依赖只用宽松许可。这些与 `03` §4 / §6 / §10 一致。

**我建议要改的地方**（待作者定）：
1. **命令名 `schema` 与现有 `tabcap schema --json`（CLI 契约导出）冲突**，响应 schema 推断改名，建议 `shape <request-pattern>`。
2. **jQuery EasyUI 不是宽松许可**（免费版 GPL，商用需授权），§9 第 5 条已定只用 MIT / Apache / BSD，所以 EasyUI 和 Ext JS、Kendo、DevExtreme、商业报表工具一样用结构等价的桩页，不引库。
3. **写进证据包的新东西要过 `04`**：动作回执放进 `cmd` 的 end 事件（`outputSummary.receipt`），不另立 kind；`outline` 结果和 `recon` 档案分别作为新 kind `view` 与包内文件 `dossier.json` / `dossier.md`，字段在实现前补进 `04` §4，由主循环定稿。
4. **GBK 等字符集解码在 Bun 的 `TextDecoder` 里是否可用【待验】**，不可用就要带码表，这决定 s25 的成本。
5. **`read` 钩子在页面里执行 JS 读实例数据**，按 `03` §10 第 3 条属于显式模式：默认不做，`outline --read` 或适配器声明时才做，输出标明。

**范围与顺序的建议**（只是建议，作者定）：
- **0.3**：`store` + 最小 guard（已定第一位）→ `replay serve`（已定）→ 本文 P0 的「页面地图」子集：帧树、遮挡置前、样板折叠、隐藏剪枝、表格摘要、「可交互」标记、按行定位、可点元素识别（监听 / 框架委托 / `cursor:pointer`）、旧 ref 重找；动作回执。靶场补 s17–s21 与国内常见形态的 s22、s23、s24、s27、s37、s39。
- **0.4**：`where` 加值归一化（数字 / 日期 / 字符集 / 编码与方向）、`recon` v0（技术栈、通道分类与覆盖率、cookie 分类、防护识别、可行性结论）、内嵌状态解码器（flight / devalue / Inertia / UpdatePanel / JSF / JS 字符串）、`screenshot --annotate`、带帧路径的 ref。靶场 s25、s26、s28、s30、s31、s32、s36。
- **backlog**：`select` / `set-date` / `upload` 完整阶梯、图表 `read`、报表查看器与门户适配器、`align` / `shape`、`--probe` 消融、Socket.IO / STOMP / SignalR 解码、其余靶场场景。

本文保持「草案，待审」；作者定了之后再写进 `08`。
