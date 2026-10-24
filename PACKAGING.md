# 打包成 App

## 一、为什么不能直接把现在的目录打包

这个项目现在的 `data/` 里有：

| 内容 | 为什么不能给别人 |
|---|---|
| `monitor.db` | 13 个账号的作品标题、阅读数、粉丝数 |
| `backups/` | 上面那些数据的每日备份 |
| `diag/` | 平台后台页面的原文片段（可能含昵称、头像地址） |
| `exports/` | 你自己导出的 CSV |
| `ai-token.txt` | AI 接口的密钥 |
| `adapters/` | 如果改过平台配置，里面是个人调过的参数 |

`data/` 一旦进 `.app`，它就跟着安装包发给别人了。

**代码层面已经隔离好了**：`main.js` 里

```js
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')   // 打包后：用户自己的目录
  : path.join(__dirname, 'data');                // 开发时：项目里的 data
```

所以别人装上之后，数据会写到**他自己**的
`~/Library/Application Support/账号监控/data/`，跟你无关。
唯一要做的是：**别把开发时的 `data/` 打进安装包**。

## 二、打包步骤

```bash
# 1. 检查（会列出不该打包的东西，有就退出码 1）
npm run check:pack

# 2. 把个人数据挪走（不是删，是移到上一级目录）
npm run clean:personal

# 3. 打包
npm run dist

# 4. 打完马上挪回来
npm run restore:personal
```

第 2 步会移到 `../_personal-backup-<时间戳>/`，第 4 步挪回来。
中间如果忘了恢复，`npm run restore:personal` 会读 `../_personal-backup-latest.txt` 找回。

`package.json` 里的 `build.files` 也写死了排除规则：

```json
"!data/**/*", "!screenshots/**/*", "!test/**/*",
"!scripts/**/*", "!dist/**/*", "!**/*.md", "!**/.workbuddy/**/*"
```

**两道防线**：清理脚本防「忘了」。如果清理脚本被跳过，
`files` 白名单也只会打 `main.js / preload.js / ui / lib / mcp`。
即使如此，**不要把 `npm run dist` 当成安全的**——先跑 `check:pack`。

## 三、MCP 的路径问题（换电脑、给别人都不能写死）

### 问题

开发时 MCP 配置是这样的：

```json
{ "command": "node",
  "args": ["/Users/你的名字/Desktop/AccountMonitor/mcp/server.js"] }
```

这条配置在别人机器上有两个毛病：
1. 路径不存在
2. 即使路径对，打包后 `mcp/server.js` 在 `app.asar` **里面**，
   外部的 `node` 打不开 asar 内部的文件

### 现在的做法

启动时把 `mcp/server.js` **复制到用户自己的数据目录**，配置指向那里：

```
~/Library/Application Support/账号监控/data/mcp-server.js
```

好处：
- 路径属于用户，跟着他的账号数据走，不写死任何人的名字
- 不在 asar 里，任何 node 都能跑
- 脚本按 `__dirname/../data` 找数据，复制过去正好对上
- app 升级时每次覆盖，MCP 协议跟着更新

### 用哪个程序去跑

不用 `node`，用**应用自己**：

```json
{
  "mcpServers": {
    "account-monitor": {
      "command": "/Applications/账号监控.app/Contents/MacOS/账号监控",
      "args": ["/Users/<用户名>/Library/Application Support/账号监控/data/mcp-server.js"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "AM_DATA_DIR": "/Users/<用户名>/Library/Application Support/账号监控/data"
      }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 模式运行，不开窗口。
**用户不需要另外装 node** —— 少一个失败点。

设置页里的「复制配置」按钮给的就是这段（路径已经填好当前的）。

## 四、给别人之前还要确认的

1. **AI 密钥**：`data/ai-token.txt` 不打包，新用户第一次打开时自动生成新的。
2. **分区目录**（登录态）在 `~/Library/Application Support/账号监控/Partitions/`，
   不在项目目录里，本来就不会被打包。
3. **签名**：现在 `mac.identity = null`（不签名）。给别人装会提示「无法验证开发者」，
   对方要右键 → 打开。要正式分发需要 Apple Developer 账号，配置 `identity` 和公证。
4. **首次启动**：空库会自动建表（`lib/migrations.js`），主页是空的，等用户自己登录。
5. **node_modules 不进包**：`electron-builder` 默认把 devDependencies 排除，
   项目 runtime 依赖是零，所以包里没有 node_modules。

## 五、Windows / macOS / Linux 适配

**结论：核心功能三平台都能跑。** 逐项核过：

| 项目 | macOS | Windows | Linux | 说明 |
|---|---|---|---|---|
| 账号隔离（核心） | ✓ | ✓ | ✓ | Electron session 机制三平台一致 |
| 读数（12 个平台） | ✓ | ✓ | ✓ | 纯页面脚本，和系统无关 |
| 数据库 | ✓ | ✓ | ✓ | Node 24 内置 `node:sqlite`，无需编译 |
| 导出 xlsx / docx | ✓ | ✓ | ✓ | 手写 zip，零依赖 |
| 报告 PDF | ✓ | ✓ | ✓ | Electron `printToPDF` |
| MCP 接入 | ✓ | ✓ | ✓ | 用 app 自身的 node 模式 |
| 从 Chrome 导入登录态 | ✓ | **✗** | **✗** | 见下 |

### 已经改掉的三处平台绑定

1. **无边框标题栏**：`titleBarStyle: 'hiddenInset'` + 红绿灯位置只在 macOS 加。
   在 Windows 上传了这两个参数会得到一个没有标题栏、没有关闭按钮、还拖不动的窗口。
2. **字体**：界面字体栈补了 `Microsoft YaHei` / `Noto Sans CJK SC`；
   xlsx / docx 里的字体从 `PingFang SC` 改成 `Microsoft YaHei`
   （Windows 和 macOS 的 Office 都有，中文不会缺字）。
3. **Chrome 资料目录**：原来写死 `~/Library/Application Support/Google/Chrome`，
   现在按平台取（Windows `%LOCALAPPDATA%\Google\Chrome\User Data`，
   Linux `~/.config/google-chrome`），并顺带支持 Edge / Chromium。

### 唯一的功能差异：从 Chrome 导入登录态

`lib/chrome_cookies.js` 要解密 Chrome 的 Cookie，各系统方式不同：
- macOS：Keychain（`security` 命令，纯字符串操作，零依赖）
- Windows：DPAPI（需要原生模块）
- Linux：gnome-keyring / kwallet（需要 D-Bus 绑定）

后两个都要引原生模块，和「零依赖」冲突。所以现在的处理是：
**在其他平台上明确提示「这个功能只支持 macOS，请在面板里直接登录一次」**，
而不是抛一个看不懂的错误。

这不影响使用 —— 面板里登录是一样效果的，只是要自己输一次密码。

### 打包命令

```bash
npm run dist:mac     # .dmg（arm64 + x64）
npm run dist:win     # .exe 安装包（NSIS）
npm run dist:linux   # .AppImage
```

跨平台打包要注意：**在 macOS 上打 Windows 包需要装 wine**，打 Linux 包需要 docker。
最省事的做法是在各自系统上打各自的包（或上 CI）。

## 六、还没做的（如果要做正式分发）

- [ ] 应用图标（`build/icon.icns` + `build/icon.ico` + `build/icon.png`）
- [ ] mac 签名与公证（需要 Apple Developer 证书，否则别人装会提示「无法验证开发者」）
- [ ] Windows 代码签名（不签会被 SmartScreen 拦一次）
- [ ] 自动更新（`electron-updater`，要有更新服务器）
