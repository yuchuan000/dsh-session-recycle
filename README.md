# dsh-session-recycle

给 **DeepSeek Harness (DSH)** 加会话删除 —— 而且是**删进回收站**，随时能还原。

DSH 官方只有「归档」，没有删除。社区插件有，但都是**永久删除、无回收站**。
这个插件补上那块安全网：删错了，在插件面板里点还原就行。

> **English**: Delete DSH sessions from the UI — into a recycle bin, not into oblivion.
> Sidebar menu + header button, native tool, no extra HTTP route.

---

## 特性

- **回收站，不是火葬场** —— 删掉的会话进插件自己的回收站（`$DSH_HOME/session-recycle-store/`），
  随时还原。还原 = 反向 rename，也是瞬间完成
- **秒删** —— 删除、还原、彻底删除都是**一次同卷 rename**（实测 ~20ms），
  三平台同一套代码，不起任何子进程
- **彻底删除** —— 会话日志 + 统计缓存 + 工作区分组记录一起清，不会残留成「未分组」幽灵条目
- **两个入口** —— 侧栏会话行 `...` 菜单，和会话标题栏的垃圾桶按钮
- **跨站防护** —— 客户端路由校验 Host / Origin / sec-fetch-site，不让别的网页驱动你的删除
- **运行中也能删** —— 先 cancel 并等 agent 静默，再动手；不会被后续 flush 复活
- **中文 / English** 双语，跟随 DSH 语言设置
- **零依赖** —— 不装任何第三方包，无安装脚本

## 安装

**把下面这段整段复制，丢给你的 AI**（Claude Code / Cursor / 或 DSH 自己的会话），
它会自己完成安装。

````text
帮我安装 DSH 插件 dsh-session-recycle。

仓库：https://github.com/yuchuan000/dsh-session-recycle
作用：给 DeepSeek Harness 加会话删除（官方只有归档，没有删除），
      删掉的会话进回收站，可以随时还原。

请按以下步骤操作：

1. 找到我的 DSH profile 目录。默认是 ~/.dsh/profiles/desktop/
   （如果我有多个 profile，先问我装到哪个）

2. 克隆仓库到该 profile 下的 vendor/dsh-session-recycle/：
   git clone https://github.com/yuchuan000/dsh-session-recycle.git <profile>/vendor/dsh-session-recycle

3. 编辑 <profile>/package.json，做两处修改：
   a) 在 dependencies 里加一行：
      "dsh-session-recycle": "file:./vendor/dsh-session-recycle"
   b) 在 dsh.profile.bundles 数组里加上：
      "dsh-session-recycle"

4. 在 <profile>/ 目录下安装依赖：
   pnpm install
   （如果我用的不是 pnpm，先问清楚再用对应的包管理器）

5. 验证安装结果：
   - <profile>/node_modules/dsh-session-recycle 存在
   - 它里面的 src/index.js 和 src/client.js 与 vendor/ 里的内容一致
     （用 hash 对比，比如 sha256sum 或 Get-FileHash）

6. 告诉我装好了，并提醒我：**必须重启 DSH 才能生效**。
   只刷新浏览器页面不够 —— DSH 的客户端插件是在启动时打包的。

注意：
- 不要修改我的其他依赖或配置
- 如果 package.json 已经有 dsh-session-recycle，先告诉我，别重复加
- 如果安装过程中报错，把完整错误贴给我，不要自己猜测性修改
````

装好后，侧栏会话行的 `...` 菜单里会出现「删除会话」，
设置页里会多一个「会话删除」分区（含回收站）。

<details>
<summary>手动安装（不想用 AI 的话）</summary>

```sh
cd ~/.dsh/profiles/<profile>
git clone https://github.com/yuchuan000/dsh-session-recycle.git vendor/dsh-session-recycle
```

然后在 `package.json` 里加两处：

```jsonc
{
  "dependencies": {
    "dsh-session-recycle": "file:./vendor/dsh-session-recycle"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-recycle"]
    }
  }
}
```

再跑 `pnpm install`，然后**重启 DSH**。

</details>

> **改代码后必须重启 DSH** —— 客户端插件是在启动时打包的，只刷新浏览器页面不够。

## 使用

侧栏会话行 → **`...`** → 「删除会话」，
或会话标题栏 → **垃圾桶图标**。

弹窗会显示会话名和序列号，勾选确认后才会执行。

**删除的是当前正在看的那个对话时**，右侧面板会**清空**，而不是自动跳到列表里的
下一个 —— 下一个该看哪个是你的选择，替你挑是一种猜测。左侧列表里点一下即可。

### 设置

**设置 → 会话删除** 里有三个开关：

| 设置 | 默认 | 说明 |
|---|---|---|
| 删除单个会话时先确认 | 开 | 关闭后点删除直接执行，不再弹确认框 |
| 删空后询问是否移除工作区 | 开 | 某工作区下最后一个会话被删后，询问是否一并移除该分组 |
| 删除时移入回收站 | 开 | 关闭后删除不可恢复 |

同一页下方是**回收站**：列出本插件删过、且仍可还原的会话，
每条一个「还原」按钮。还原结果以**顶部横幅**提示（不打断操作，几秒后淡出）。
勾选多条可以**批量还原**或**彻底删除**（全选按钮在工具栏上）。

每一行都会显示**这是什么**，而不是一串 uuid：

```
修复登录 bug                      [还原]
my-project/src
2026/01/15 09:41:22
wb-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

- 标题取自删除前的会话名；没有名字的会话回退显示**项目文件夹名**
- 会话 id 仍然保留（等宽小字），用于精确对应
- **旧条目也能显示** —— 之前记录里没存标题的，会从回收站里的会话文件头
  解出 `cwd` 反推项目名，不需要重新删一遍

还原后会**立刻**出现在左侧列表，并且回到**原来的工作区分组**（删除时会把该会话
从 `sessionIds` 里摘掉，插件在删除前记下了它属于哪个组，还原时挂回去）。

> 如果那个工作区在这期间被移除了，会话照常还原，只是会落在「未分组」。

### 空工作区怎么处理

当你删掉某个工作区下的**最后一个**会话时，如果开了询问，会弹窗问要不要一起移除
那个空分组。**永远只是询问，不会自动删** —— 空工作区通常代表你还在用的项目目录。

选择「移除分组」只删分组记录：**项目文件夹和会话日志都保留**，
和 DSH 官方「删除工作区」的行为一致。

## 删除都做了什么

一次删除会同步清理四处，任何一处漏掉都会产生"幽灵会话"：

| 位置 | 不清理的后果 |
|---|---|
| `$DSH_HOME/sessions/<slug>/<id>/` | 会话文件还在 |
| `session_projcache` 域 | 侧栏标题缓存还在，列表里仍显示 |
| `workspace` 域的 `sessionIds` | 掉进「未分组」显示为孤立条目 |
| `workspace` 域的 `archivedSessionIds` | 已归档的会话清理不干净 |

另外会先停止运行中的 agent 并 flush，否则 dispose 时的写入会把刚删的目录重建出来。

## 模型也能用

注册了五个原生工具：

| 工具 | 用途 |
|---|---|
| `list_sessions` | 列出磁盘上所有会话（id + 工作区 slug），按修改时间倒序 |
| `session_delete` | 删除指定会话；`permanent: true` 时跳过回收站直接删 |
| `list_recycled` | 列出回收站里仍可还原的会话 |
| `session_restore` | 把某个回收站会话还原回原位置 |
| `workspace_remove` | 移除一个工作区分组（只删分组，保留目录和日志） |

所以你可以直接对 AI 说「把 xxx 那个会话删了」。

## 还原

在 **设置 → 会话删除 → 回收站** 里点「还原」即可，会话**立刻**回到侧边栏，
并回到它原来的工作区分组。

也可以对 AI 说「把 xxx 还原回来」（`session_restore` 工具）。

数据在哪：删掉的会话被 rename 到 `$DSH_HOME/session-recycle-store/<session-id>/`，
清单在 `$DSH_HOME/session-recycle-bin.json`。手工把目录挪回去也能恢复，
但**建议用面板** —— 它会顺带修好分组、清掉回收站条目。

如果清单丢了（误删文件、或写入时崩溃），插件**启动时会自动重建**：
store 里的每个目录都能从自己的会话头读出 id 和项目路径，所以不会变成孤儿。

> 注意：删除**不会**进操作系统的回收站 / 废纸篓。要恢复请用插件面板。

## 安全设计

- 会话 id 必须匹配 `<prefix>-<uuid>`，路径分隔符与 `..` 一律拒绝
- 每个删除候选都经 `path.resolve` 复核，必须是会话根目录的**直接子目录**，
  否则直接报错拒绝（`OUT_OF_ROOT`）—— 实测路径穿越、绝对路径全部拦住
- 删除前再校验一次包含关系，不是只在入口校验
- `permanent` 需要显式传 `true`，默认永远是回收站

### 客户端按钮怎么触达 host

浏览器端**没有** `tools` 服务 —— `@deepseek-ai/dsh-tools` 是 host-only 包，
没有 `./client` 导出，所以 `ctx.get('tools')` 在客户端永远是 `undefined`。
客户端按钮必须有显式通道才能触达 host。

本插件注册八条 `exact` 路由（`list` / `delete` / `settings` / `workspaces` /
`recycled` / `restore` / `purge` / `remove-workspace`），
与社区市场对自己所有写操作的做法一致。因为 `exact` 注册会**优先于** harness
自带的 `/api` 围栏，这些路由必须自己防守，规则照搬市场已验证的那套：

| 检查 | 原因 |
|---|---|
| `Host` 必须是 loopback（或 `--trusted-host` 声明的授权） | DNS rebinding：攻击页面能让 `Origin === Host` 成立，而 `Host` 是它唯一伪造不了的头部 |
| `sec-fetch-site: cross-site` 直接拒绝 | 浏览器自己声明的跨站 |
| `Origin` **存在**时必须等于 `Host` | 跨站页面会被拒 |
| `Origin` **缺失**时放行 | Desktop 版代理会剥掉它；非浏览器客户端本就能伪造，拒绝没意义 |
| `Origin: null` 拒绝 | 沙箱 iframe / `data:` 文档：是"存在但不可解析"，不等于缺失 |
| body 上限 4 KiB，只读两个已知字段 | |

## 与社区同类插件的区别

| | 本插件 | 常见的 `dsh-plugin-session-delete` |
|---|---|---|
| 删除方式 | 移入插件回收站（可还原） | `rm -rf` 永久删除 |
| 触发通道 | 同源守卫的专用路由 + 原生工具 | 无守卫的 `POST /__chameleon/session/delete` |
| 跨站防护 | 校验 Host / Origin / sec-fetch-site | 无（仅依赖 localhost 绑定） |
| 导入会话 id | 原生支持 `wb-` / `codex-` 等前缀 | 正则只认 `session-`，导入的会话删不掉 |

## 兼容性

在 DSH `0.2.0-rc.2`（session format v4）上开发并验证。
删除逻辑依赖 `sessions` / `agents` / `storageDomain` 服务与
`session_projcache` / `workspace` 两个存储域；这些是当前版本的既有接口。
`webServer` 是可选依赖：纯终端 profile 没有 web 界面时，插件照常加载，
只注册工具、不注册路由。

## License

[MIT](LICENSE)
