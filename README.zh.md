---
description: "按 DSH 会话寻址的长驻 PTY bash 终端，命令以异步 job 结算。"
kind: "plugin-bundle"
---

# dsh-shared-bash

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的、**按会话寻址的常驻 PTY bash 终端**，命令以**异步 job** 结算。

每个 DSH 会话有一个长驻 shell，用会话 id 作地址：可以接入之前会话留下的那个 shell，工作目录、变量、函数和还在跑的进程都还在，不用从头开始。把命令交给它，立刻拿到一个 **job 句柄**；结果随后用 wait 取，或者在跑的过程中用 read 看。

## 环境要求

- DeepSeek Harness `^0.2.1-rc.2`
- 已挂载支持 PTY 的 subprocess provider。桌面版组合里已经包含 `@deepseek-ai/dsh-subprocess-local` 与 `dsh-experimental-terminal-bundle`；Windows 上默认 shell 是 `C:\msys64\usr\bin\bash.exe`。

## 安装

```bash
dsh plugin --profile desktop add git+https://github.com/snowy-yang/dsh-shared-bash.git
```

执行前请完全退出应用：Host 占着文件时 pnpm 重写 profile 的 `node_modules` 会失败（`ERR_PNPM_EPERM`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `bash_attach` | 接入某个会话的终端，没有就开一个。可选 `cwd`；`recreate` 替换已有 shell。 |
| `bash_exec` | 执行一条命令，立刻返回 job id。可选 `wait_ms`，命令很快结束就直接给结果。 |
| `bash_wait` | 等一个 job，返回退出码、输出和 `timed_out`。 |
| `bash_read` | 只读地取终端保留的输出，不发送输入。 |
| `bash_interrupt` | 给前台进程组发 SIGINT，等价于真正的 Ctrl-C，shell 本身存活。 |
| `bash_close` | 关掉一个或全部终端。 |
| `bash_list` | 列出终端：会话 id、状态、cwd、是否在跑命令。 |

每个工具都接受可选的 `session_id`。不传就是「我自己会话的那一个」；传了就是「那个会话的终端」，这就是本插件提供的显式跨 agent 共享：

```text
bash_list              → 3f2a… · busy · C:\proj\widgets
bash_read   {session_id: "3f2a…"}
bash_exec   {session_id: "3f2a…", command: "git status --short"}
bash_wait   {job_id: "bash-9c1e…"}
```

## 终端模型

- 每个 DSH 会话 id 一个 PTY；注册表是 profile 级的，shell 不会在背后被谁共用。
- `bash -l -i`：交互式登录 shell，MSYS2 的 `PATH` 与用户 profile 生效。传入的 `cwd` 会在 shell 里真正 `cd` 过去，`/tmp` 这类 POSIX 路径会翻译成 MSYS2 安装目录（`C:\msys64\tmp`）。
- 两次调用之间，shell 保留工作目录、导出变量与普通变量、函数、别名，以及你放到后台的进程。
- 命令写进脚本文件再 source，stdin 接 `/dev/null`：heredoc、循环、管道、引号都和脚本里完全一样，读 stdin 的命令拿到 EOF 而不是抢走终端的输入。
- 结束判定靠 shell 在命令后打印的哨兵行，其中带的 token 只存在于环境变量里 —— 终端回显命令行无法伪造完成信号。
- 每个终端保留 4000 行环形输出，ANSI 转义序列会被剥掉。

## 异步执行

`bash_exec` 不会阻塞在命令上：它返回 `{job_id, session_id, status}`。后续三条路：

```text
bash_exec  {command: "npm run build"}        → job bash-9c1e…，状态 running
bash_wait  {job_id: "bash-9c1e…"}            → 阻塞到结束，返回 exit_code 与输出
bash_read  {}                                → 终端到目前为止打印的内容
bash_interrupt {}                            → SIGINT，job 以 interrupted 结算
```

同一个终端同一时刻只跑一条命令；第二条会被 `SESSION_BUSY` 拒绝。`bash_wait` 用较短的 `timeout_ms` 会返回 `timed_out: true` 并让命令继续跑，因此可以轮询。

## 设置页面

**设置 → Bash 终端**：按会话 id 列出所有终端，查看保留的输出，发送命令（按 job 结算），中断，按会话 id 接入新终端，关闭终端。

数据由插件自己的 JSON API 提供，前缀 `/api/shared-bash`：`GET /sessions`、`GET /output?session_id=…`、`GET /wait?job_id=…`、`POST /attach|/exec|/interrupt|/close`。harness 的 web server 自身不带请求策略，所以这条路由自己设防：有 `connection` 服务就交给它判定，没有就只允许 loopback `Host` 且 `Origin`/`Referer` 同源（`dsh-app://app` 中继仅在单独出现时放行）。

## 配置

`cordis.patch.yml` 的默认值，全部可选：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `bashPath` | `C:\msys64\usr\bin\bash.exe` | shell 可执行文件 |
| `msystem` | `MSYS` | 传给 shell 的 `MSYSTEM` |
| `login` | `true` | 用 `bash -l -i`，而不是 `--noprofile --norc -i` |
| `cwd` | Host 进程目录 | 没有指定目录时的起始目录 |
| `maxLines` | `4000` | 每个终端保留的输出行数 |
| `maxSessions` | `16` | profile 内并发终端数 |
| `cols` / `rows` | `120` / `30` | 上报的 PTY 尺寸 |

## 限制

- 一个终端同一时刻一条命令；要并行就开并行会话。
- 设置页是管理界面而不是完整终端模拟器：它显示剥离转义后的文本，不是实时屏幕。
- 终端是进程内的：Host 结束它们就结束；它也不是沙箱 —— shell 用的是 Host 自己的权限。

## 开发

```bash
node --test test/
```

测试用管道版 `bash -s` 通过同一个 `spawnTerminal` 契约替代 PTY，因此分帧、job、注册表和 HTTP API 都能脱离应用验证。设置 `DSH_TOOLS_MODULE` 时还会用 harness 自己的 `assertSupportedJsonSchema` 校验工具 schema。

MIT 许可。
