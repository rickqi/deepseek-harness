# Agent Note: Web 输入框高亮文件路径并支持 Ctrl/⌘+点击打开

Status: implemented

[English](2026-08-15-web-composer-file-path-recognition.md) | 中文

## Problem

输入框唯一的附件通道是图片摄取，草稿里的其余内容都是纯文本。以"直接给路径"方式向 agent 传文件的用户（这是文档规定的传文件方式）输入路径时得不到任何"已被识别"的反馈：路径与普通文字一样渲染，唯一的使用方式是整条发送后等待 agent 的文件工具。纯文本引用机制（`decorations.scanTextRefs`，见 slash 管线 note）已能对热词典中的 `/name`、`@name` token 高亮，但路径是无界名称、任何词典都无法枚举，该机制覆盖不了。本部署的用户实际输入的是 UNC 与盘符路径（`\\wsl.localhost\Ubuntu-22.04\…`、`C:\…`）以及 POSIX 形式，只认正斜杠的规则会漏掉主要用户真实文件的写法。

## Decision

输入框把草稿中的路径形 token 作为纯文本扫描并高亮，Ctrl/⌘+点击即可打开该路径。

`decorations.scanPathRefs(draft)` 识别两个结构性家族，均要求至少两个非空段：正斜杠家族（`/a/b`、`./x/y`、`../x/y`、`~/x/y`）与反斜杠家族（UNC `\\server\share\…`、盘符 `X:\…` 与 `X:/…`）。它绝不匹配单段 `/name` 命令 token、URL 残留（`https://…`、协议相对 `//…`）、裸盘符根（`C:\`）或孤立反斜杠，并会裁剪句末标点（`open /tmp/a/b.docx.` 高亮 `/tmp/a/b.docx`）。扫描纯属结构判断——击键时不做任何文件系统解析——因此过期或移动过的路径仍会高亮，高亮永远不会因文件状态失败，文件真实性由 host 负责。

`DraftDecorations` 新增 `pathRefs`；InputBar 的 backdrop 把每个区间渲染为 `.pathRef` 标记（浅色底加点状下划线，与命令/提及的 `.textRef` 标记区分，沿用同一双层 advance 约定）并带 title 提示。两条重叠规则保持装饰来源互不交叠：chip 占位符（U+FFFC）是路径连续边界，路径 token 绝不跨越 chip；同起点的 text-ref 若是 path ref 的严格前缀（词典中的 `/plan` 出现在 `/plan/assets` 里）则在推导时丢弃——路径是同一跨度的更具体读法——因此渲染出来的与 Ctrl/⌘+点击命中的完全一致。由于 textarea 覆盖在 backdrop 之上，打开手势放在 textarea 上：光标落在高亮区间内时 Ctrl/⌘+点击调用经 `ComposerBarInjected` 注入的新回调 `openPath`。`apply.ts` 将其经助手文件提及打开所用的同一个 `resolveWorkspacePath(cwd, path)` 解析后接到 `ctx.workspaces.openPath`——扫描保留 `./`/`../`/`~/` 前缀而 host 打开器没有会话上下文，因此 token 在交给 host 前先按会话 cwd 解析——并沿用与 assistant 文件提及相同的静默 catch：host 无法解析的路径打开无果且绝不把 composer 报错抛给用户。

本功能是"装饰 + host 侧打开动词"，不引入文件行、文件输入、上传协议，也不改动加号按钮的 Command 启动器：想让 agent *读取*文件的用户仍然把路径作为消息发送（agent 的文件工具才是读者）；高亮与打开用于确认识别，并让用户无需离开草稿即可在 host 操作系统中触达该文件。

## Alternatives considered

**把每个路径对客户端工作区文件索引解析、只高亮存在的文件。** 需要每次击键做目录列举或在浏览器里维护全量工作区索引；UNC 与盘符路径不在已连接工作区下，浏览器无从判断其存在性；且会把装饰变成异步、易失败。结构扫描保持渲染路径同步、无副作用、只对"形状"负责；存在性由 host 在打开时判定。

**扩展词典名册让 `scanTextRefs` 覆盖路径。** 热词典是精确名称成员表；路径是无界名称，必须按草稿逐条枚举，这恰是纯文本引用决策要避免的。路径识别是结构性的、而非名册式的，因此作为独立扫描与 `scanTextRefs` 并列，而非放进其内部。

**普通点击即打开（无修饰键）。** textarea 的主要点击职责是放置光标；为路径劫持点击会破坏编辑。Ctrl/⌘+点击是 IDE 标准的显式选择，不干扰普通点击，且可从高亮的 affordance 中习得。

**只高亮正斜杠形式。** 本部署的主要用户通过 WSL UNC 路径（`\\wsl.localhost\…`）与 Windows 盘符路径触达文件，因此反斜杠与盘符形式从首个发布版本起就在范围内。

**发送消息后也高亮路径（MessageItem）。** 会话记录的装饰是自然的后续工作，但是独立的渲染面；v1 只做输入框，让扫描与打开手势一起落地。

## Testing

`packages/client/ui-conversation` 单元覆盖在 `input-machine.client.spec.ts` 的 `describe('decorations: scanPathRefs')` 下固定了扫描器行为：

- 绝对路径在行首与空白后匹配（`/root/a/b.txt`）；
- 多个路径与 `./`、`../`、`~/` 相对形式按草稿顺序匹配；
- 单段 `/name` 是命令 token、绝非路径（`/goal /commit-helper` → 无）；
- URL 残留与协议相对 token 不是路径（`https://a/b/c` → 无）；
- UNC 反斜杠路径以精确区间与保留分隔符匹配（`\\wsl.localhost\Ubuntu-22.04\root\HMC\HMC1\待核对清单.xlsx`）；
- Windows 盘符路径两种斜杠方向均可匹配（`C:\Users\me\file.txt`、`D:/tmp/other.log`）；
- 裸盘符根与孤立反斜杠不是路径（`C:\` 与 `\\nope` → 无）；
- 句末标点从路径裁剪（`/tmp/a/b.docx.` → `/tmp/a/b.docx`）；
- `deriveDecorations` 透传 `pathRefs`；同文件中对 `deriveDecorations` 的精确相等断言已同步补充 `pathRefs: []`。

`InputBar` 组件套件（`input-bar.client.spec.tsx`）以扩展后的 fixture props 传递 `openPath` 后通过，`ui-conversation` 全量套件（27 个文件、425 个用例）全绿——新的 `openPath` prop、backdrop 分支与点击处理器无回归。

## Consequences

- 输入框中的路径一眼可辨、无需发送即可触达；Ctrl/⌘+点击的 affordance 可从高亮习得，路径有误时也无害（静默无操作，与 assistant 文件提及一致）。
- `ComposerBarInjected` 增加一个可选成员（`openPath`）；任何构造这些 props 的替代 bar 实现或 composer takeover 都必须接受新键，类型会强制这一点。
- 高亮只是提示：它证明形状、不证明存在。用户仍可输入 host 打不开的路径；消息发送后 agent 的文件工具仍是权威读者。
- 路径扫描与[web 输入状态机与 slash 管线 note](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) 所拥有的纯文本引用机制并列而非嵌套——两者独立（名册成员 vs 结构形状），互不取代。
