# 账号监控 · Account Monitor

一个**完全本地运行**的多平台账号数据留底工具。给同时运营多个平台、又不想把数据交给任何第三方的人用。

12 个平台、一个号一个独立环境、数据只存在你自己电脑上。

```
公众号  小红书  抖音  视频号  微博  知乎  B站
X  YouTube  Instagram  Threads  TikTok
```

---

## 它解决什么问题

平台后台的数字是**流动的** —— 昨天的阅读量、上周的粉丝数，过几天就被新数据覆盖了。
做内容的人真正需要的是「三个月前那条到底跑了多少」，但后台只给你看当下。

这个工具每天把各平台后台的数字抄一遍，存进本地数据库，于是你能回答：

- 这个月比上个月好在哪、差在哪（而不只是「今天多少」）
- 同一个题材里，哪一篇写得更好
- 哪个平台的精力投入产出比最高
- 粉丝是涨是跌，什么时候开始变的

## 它刻意不做的事

这几条是设计红线，写在代码里也是写在这份文档里：

| 不做 | 为什么 |
|---|---|
| **不自动登录** | 登录只由你本人完成。不填表、不点通行密钥、不猜密码。 |
| **不自动发布 / 点赞 / 关注** | 任何「帮你操作账号」的行为都可能触发风控。这是账号安全，不是技术限制。 |
| **不做高频轮询** | 每平台有硬性最小间隔（抖音/小红书 20 分钟，其余 15 分钟）。平台后台对高频访问敏感。 |
| **不上传任何数据** | 没有服务端，没有账号体系，没有埋点。断网也能用。 |

## 一个号一个环境

每个账号独占一个 Electron session 分区（`persist:acct-<平台>-<序号>`），
Cookie、localStorage、缓存全部隔离。

这不是「为了方便多开」，而是**防止串号**：同一个浏览器环境里登两个号，
数据会混在一起，而且是那种看不见的错 —— 数字真实、但属于另一个号，光看数字发现不了。

## 数据存在哪

| 环境 | 位置 |
|---|---|
| 开发运行（`npm start`） | 项目内 `data/monitor.db` |
| 打包后的 App | `~/Library/Application Support/账号监控/data/monitor.db` |

数据库是单文件 SQLite（Node 内置 `node:sqlite`，无需安装任何东西）。
备份就是复制这个文件。

## 跑起来

需要 Node 20+（内置 `node:sqlite` 要求）。

```bash
git clone https://github.com/labulaka-ai/account-monitor.git
cd account-monitor
npm install          # 只装 electron，无其它运行时依赖
npm start
```

首次打开是空的。点平台卡片 → 右侧面板会打开该平台后台 → **你自己登录** → 点「刷新数据」。

### 打包成 App

```bash
npm run check:pack       # 检查个人数据是否已隔离
npm run clean:personal   # 挪走 data/ 等个人目录
npm run dist             # 打 dmg
npm run restore:personal # 挪回来
```

详见 [PACKAGING.md](PACKAGING.md)。

## 技术选择

**零运行时依赖。** 除了 Electron 本身，不引任何第三方包：

- 数据库：Node 24 内置 `node:sqlite`
- Excel / Word：手写 ZIP + XML（`lib/zip.js`、`lib/xlsx.js`、`lib/docx.js`）
- PDF：交给 Chromium 自己的 `printToPDF`
- MCP 服务：手写 JSON-RPC over stdio

为什么：这类工具要能放三年还能跑。依赖越少，三年后 `npm install` 失败的概率越低。
副作用是安装包小、没有 native 编译、不用担心供应链投毒。

## 图标

源图在 `build/icon-source.jpg`，跑 `npm run icon` 生成 `icon.png` / `icon.icns` / `icon.ico`。

形状不是直接裁圆角矩形，而是按 macOS 的超椭圆（`|x|^n + |y|^n = 1`，n=5）
算 4×4 超采样 alpha —— 正圆角在大尺寸下能看出「方肩」，和系统里其它图标并排会露怯。
刻度照 Apple 的规范：1024 画布、824 主体、四周各留 100。

换图案只换源图，别手改生成的三个文件（尤其 icns：它里面是 10 个尺寸，手改必然漏）。
`npm run icon -- --crop 1.06` 可以调主体占比，数字越大图越满。

## 目录结构

```
main.js              Electron 主进程（窗口、IPC、读数调度）
preload.js           上下文隔离桥
lib/
  adapters/          平台定义（加平台改这里一个数组）
  platforms/         各平台取数脚本，一个平台一个文件（在页面内执行）
  collectors.js      把上面这些拼成注册表
  reader.js          读数编排 + 逐页对账
  sync.js            读数结果写库
  scheduler.js       每日自动更新
  report.js          报告生成（md / html / docx）
  plat_profile.js    每个平台该看哪个指标
  db.js migrations.js
ui/                  前端（零构建，原生 JS）
mcp/server.js        MCP 服务，让 AI 读取你的数据
scripts/             图标生成、打包前清理个人数据
```

### 加一个平台

在 `lib/platforms/` 新建一个文件，导出一个 `pages` 数组，
再到 `lib/collectors.js` 的 `MODULES` 里加一行。别的平台的代码不用碰。

**每个页面脚本都会被 `toString()` 后注入到平台页面里单独执行**，所以函数体不能引用
文件外的任何变量 —— 连本文件里的 `const` 也不行。要小工具就写在函数体里面。
这条约定由 `test/scripts.test.js` 守着：它去掉注释和字符串之后，比对平台文件里的顶层变量名。

## AI 接入（可选）

内置一个 MCP 服务，可以让 Claude、Cursor 之类的 AI 读取你的账号数据做分析。
**默认关闭**，你在设置里打开才会启动监听端口（仅 127.0.0.1 + Bearer token）。

## 已知限制

- **YouTube 在 Electron 里登不上**（Google 拒绝非标准浏览器）。用「从 Chrome 导入登录态」。
- 部分平台的单条指标读不到，报告里显示 `—`（不是 0，是平台不给）。每个平台的能力声明在 `lib/adapters/platforms.js` 的 `caps` 里。
- 只支持 macOS 打包（开发时是 Intel x64）。Windows / Linux 的构建配置在 `package.json` 里但没实测过。

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE) —— **可以自用，不允许商用**。

**允许**：自己用、随便改、分享给朋友自用；学习研究、个人兴趣项目、教学、慈善 / 公共研究 / 政府机构使用。

**不允许**：任何商业用途。卖这个软件、拿它收费提供服务、或者放进公司的业务流程里省成本，都算商业用途。

两点要说清楚：

- **不要求你公开自己的改动**（这点和 AGPL 正好相反）。改了可以自己留着。
- **这不是 OSI 认定的「开源」**。源码公开可读，但「开源」有明确门槛，这里不冒充。

需要商业授权请单独联系作者。**作者本人不受这些限制**：随时可以自己商用，也可以另签商业许可。

为什么这么选：这个工具的价值就在于「账号数据留在这台电脑上」。一旦被人打包成 SaaS 卖，用户的登录态就成了别人的资产。禁商用挡的是这条路，不是挡你自己用。
