---
description: "给 DeepSeek Harness 用的 tmux 式共享 bash 会话：同一 profile 里所有 agent 共用一组长驻 shell。"
kind: "plugin-bundle"
---

# dsh-shared-bash

[English](README.md) | 中文

## 它解决什么问题

`dsh-shared-bash` 给一个 DeepSeek Harness profile 提供一组长期存活的 bash 会话，**同一 profile 里的所有 agent 共享这些会话**。一个 agent 可以 `cd` 进构建目录、导出变量、起一个服务，另一个 agent（队友、子 agent，或后来的会话）能接着读输出、继续在同一个 shell 里干活。

内置的 `terminal_*` 工具做不到这一点：它们的会话按 agent 隔离，一个 agent 没法把活着的 shell 交给另一个。

插件只挂一行 Host 配置，注册六个工具。Windows 上默认用 MSYS2 的 bash（`C:\msys64\usr\bin\bash.exe`）并加载登录环境，`pacman`、`gcc`、`sed`、`find`、autotools 都和在正常 MSYS2 终端里一样。

## 安装

```bash
# 从 registry 装
dsh plugin --profile desktop add dsh-shared-bash

# 从本仓库装
dsh plugin --profile desktop add git+https://github.com/snowy-yang/dsh-shared-bash.git
```

也可以手改 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-shared-bash"] } },
  "dependencies": { "dsh-shared-bash": "^0.1.0" }
}
```

然后在 profile 目录跑 `pnpm install`，重启应用（没有 HMR 的 profile 只在启动时加载 bundle）。

## 工具

| 工具 | 作用 |
|---|---|
| `shared_bash_open` | 打开或复用命名会话（默认 `main`），可选 `cwd`、`msystem`、`bash_path`、`recreate` |
| `shared_bash_send` | 执行命令并返回输出与退出码；`timeout_ms` 限定等待，超时后命令继续跑 |
| `shared_bash_read` | 分页读取保留的输出，不发送任何输入（`lines`、`offset`） |
| `shared_bash_list` | 列出 profile 内所有会话的状态、cwd、忙碌标记与活动时间 |
| `shared_bash_interrupt` | 停掉正在跑的命令，保留 shell 及其状态 |
| `shared_bash_close` | 关闭一个或全部会话 |

典型流程：

```text
shared_bash_open  { "session": "build", "cwd": "C:\\proj" }
shared_bash_send  { "session": "build", "command": "cmake -S . -B build && cmake --build build -j8" }
shared_bash_send  { "session": "build", "command": "./build/tests/unit" }
shared_bash_read  { "session": "build", "lines": 200 }
shared_bash_interrupt { "session": "build" }
```

## 设置页面

这个 bundle 还带一个浏览器半边（`client.js`）：**设置 → 共享 Bash** 会列出该 profile 里的所有会话及状态、目录、命令数与最近活动。在这个页面上可以读保留的输出、中断正在跑的命令、关闭单个或全部会话、在指定目录新建命名会话，也能自己发一条命令。

它通过插件自己的 JSON 接口与 Host 半边通信，挂在 harness web 服务器的 `/api/shared-bash` 下（`sessions`、`output`、`open`、`send`、`interrupt`、`close`）。因为比 `/api` 更长的前缀会优先于内核的准入检查，这条路由自带请求围栏：组合里存在 `connection` 服务时由它裁决，否则按同样的结构性规则判断（`Host` 必须是回环地址、拒绝跨站请求、`Origin`/`Referer` 必须与 `Host` 同源，另外放行桌面端 `dsh-app://app` 的转发 Referer）。没有 Web 服务器时路由根本不会注册，工具在无头组合里照常工作。

## 实现方式

每个会话是一个带管道的 `bash -l -s` 进程。命令写进会话目录里的临时文件，用 `. file </dev/null` 执行，随后 shell 打印一条随机完成哨兵，带上退出码和当时的 `$PWD`。这带来三个性质：

- **状态保留** —— `cd`、变量、导出的环境、shell 函数在多次调用之间都还在。
- **多行输入可用** —— heredoc、循环、`&&` 链都是普通的文件内容，不需要往终端里粘贴。
- **哨兵不会被吃掉** —— 命令的 stdin 是 `/dev/null`，`read`、无参 `cat` 或误写的 `select` 不会吞掉完成标记。

`shared_bash_interrupt` 走 Cygwin/MSYS2 的进程表（`ps -ef`）和它自己的 `kill`：MSYS2 把会话 shell 报成 `PPID 1`，Windows 的进程树描述不了这个作业。结果就是 shell 活着，作业死掉。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `bashPath` | 装了 MSYS2 时用它，否则用 `PATH` 里的 `bash` | bash 可执行文件 |
| `msystem` | `MSYS` | `MSYS`、`UCRT64`、`MINGW64` 或 `CLANG64` |
| `login` | `true` | 加载登录环境（`-l`）；关掉等于 `--noprofile --norc` 加一个光秃秃的 `PATH` |
| `cwd` | Host 工作目录 | 新会话的默认目录 |
| `commandTimeoutMs` | `120000` | 单条命令的默认前台等待 |
| `maxLines` | `4000` | 每个会话保留的输出行数 |
| `maxSessions` | `16` | 每个 profile 的并发会话数 |
| `env` | `{}` | 追加给 shell 的环境变量 |

单次会话的 `cwd` 接受 MSYS2 安装所拥有的 POSIX 风格路径（`/tmp`、`/home/...`、`/c/Users/...`），插件会转换成 Host 可用的路径。`shared_bash_open` 还会在 shell 内部真正进入该目录：登录 shell 会跑 profile 脚本，而 MSYS2 的那套以 `$HOME` 收尾，只给 spawn 目录是留不住的。

## 限制

- **没有 TTY。** 走管道意味着没有颜色、没有光标控制，`vim`、`top`、`less` 都用不了，也没有 Ctrl-C 字节。交互式程序按设计不支持；要停作业请用 `shared_bash_interrupt`。
- **单会话串行。** 命令执行期间再次 `shared_bash_send` 会被拒绝而不是排队，这样输出来源不会混淆。
- **命令是受信任的。** 它们以用户权限跑在 Harness Host 进程里，在 agent 沙箱之外，和内置终端工具一致。
- **不是隔离边界。** 任何能调用这些工具的 agent 都能读写所有会话，共享会话等于共享状态，别当隔离用。

## 开发

```bash
node --test test/
```

会话测试会启动真实的 bash 进程；用 `DSH_SHARED_BASH` 指向别的可执行文件。设置 `DSH_TOOLS_MODULE` 可以额外跑 Harness 的 JSON Schema 校验。

## 许可证

MIT
