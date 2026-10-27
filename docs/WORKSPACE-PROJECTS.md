# 大肥鱼工作区：三个项目与 GitHub 仓库

核验日期：2026-10-27（Asia/Shanghai）。已使用当前GitHub账号 `skyc10` 查询仓库信息、远端main提交，并与本机Git根目录、分支、origin和HEAD核对。下列是与本工作区相关的三个项目，不代表账号只有三个仓库。

## 项目对应关系

| 项目 | 职责 | 实际代码目录 | GitHub仓库 | 分支 / 可见性 |
| --- | --- | --- | --- | --- |
| 01-dafeiyu-deploy代码 | Docker Compose、专用DSH/桥接镜像、入口脚本、配置模板、运维脚本 | `D:\deepseek_flash\project` | [skyc10/dafeiyu-deploy](https://github.com/skyc10/dafeiyu-deploy) | main / 私有 |
| 02-dafeiyu-control-panel | 本机网页控制台、状态探测、固定启停、控制台跳转及插件入口登记 | `D:\deepseek_flash\project\management-panel` | [skyc10/dafeiyu-control-panel](https://github.com/skyc10/dafeiyu-control-panel) | main / 私有 |
| QQ陪伴记忆插件 | 记忆、档案、证据学习、人格版本及插件自己的WebUI | `D:\大肥鱼QQ\03-dsh-qq-companion-memory` | [skyc10/dsh-qq-companion-memory](https://github.com/skyc10/dsh-qq-companion-memory) | main / 私有 |

本目录 `D:\大肥鱼QQ` 是工作区资料与工具入口，不是Git仓库；三个项目的源码不全在本目录物理路径下。不要为了对应目录名称而移动正在使用的部署或面板文件。

`management-panel`虽然嵌套在部署目录里，但Git根目录、origin和HEAD均独立，应进入对应仓库提交推送。`过时与待清理\2026-10-27\05-审计与调研\源码审计`里的qq-bridge、旧记忆和心情插件是参考审计副本，不是上述三个自有项目的替代路径。

## 核验时的备份与本地状态

以下为本说明写入前的现场快照。后续提交文档会产生新的提交号，实际最新提交应从各仓库远端查询。

| 仓库 | 核验时本地HEAD = GitHub main | 核验时本地状态 |
| --- | --- | --- |
| dafeiyu-deploy | `631cd0adbe02d50a5ed4c1af3006ce87bcdbfcfe` | `fish-bot/entrypoint.sh` 有未提交修改 |
| dafeiyu-control-panel | `f9a0bff55e830a1e1b7dcdbfa0f362ab2f53d432` | `server.py` 有未提交修改 |
| dsh-qq-companion-memory | `a155881de1aa89a1880d5c10d2e8fb2864a98d8f` | 工作区干净；修复、WebUI及40项待测清单已留档 |

前两个项目的未提交修改尚不包含在上述远端提交中；本次只登记实际状态，没有将这些修改打包进插件仓库或替其它开发任务提交。各项目后续完成版本更新时，应先审阅当前修改、核对远端，再提交并推送各自仓库。

## 入口与分工

- 部署项目负责运行环境、容器与接线；具体运行状态需要另行检查，不能由代码提交推断。
- 管理面板是独立的本机网页控制台；仓库README记录默认入口为 `http://127.0.0.1:18100/`，本次未启动或验证该服务。
- 记忆插件的WebUI在专用DSH侧栏“记忆管理”，同源路径 `/api/qq-companion-memory/v1/page`。它与独立管理面板是两个界面；插件入口接入面板属于两项目之间的集成工作，不能仅凭都有WebUI就判定已经集成。
- 记忆插件业务与页面人工检查仍待执行，见插件 `docs/TEST-CHECKLIST.md`；源码留档不代表运行验收或部署完成。

## 版本更新规则与说明备份

所有项目版本更新后均须提交并推送对应GitHub仓库，执行规则见根目录 `AGENTS.md`。保持现有私有性，源码与模板留档，不上传真实配置、令牌、聊天数据或数据库。

本说明及根目录规则分别在记忆插件仓库的 `docs/WORKSPACE-PROJECTS.md`、`docs/WORKSPACE-GITHUB-RULES.md`保存相同内容副本。根目录文件便于所有项目接手者查阅，仓库副本用于GitHub备份；这不改变三个项目各自独立的仓库归属。

## 2026-10-27 工作区按项目整理

根目录入口更新为 `00-项目导航.md`；部署资料位于“01-dafeiyu-deploy”，面板资料位于“02-dafeiyu-control-panel”，插件仓库为 `03-dsh-qq-companion-memory`。
根目录只保留面板启动快捷方式；查看状态、启停和控制台跳转统一从管理面板操作。四个旧BAT和配套PS脚本已归档，实际运行目录未移动。
新插件直接新增根目录同级项目目录，并在本登记中补充职责、源码位置和明确的仓库归属。

旧六类目录已取消；历史资料集中在 `过时与待清理\2026-10-27`，原路径和清理建议见其 `整理清单.md`。
Docker汉化资料含回滚备份，删除前确认；临时脚本与参考审计分别标注。归档实体仅在本地，不代表已上传GitHub。
插件源码、当前交接、待验收清单与依赖保持原位。本次为文件整理和文档留档，不代表运行验收、打包或上线完成。

## 项目目录命名约定

2026-10-27按用户要求统一为编号加英文名：`01-dafeiyu-deploy`（Docker部署资料）、`02-dafeiyu-control-panel`（面板资料）、`03-dsh-qq-companion-memory`（插件源码，用户手动改名已完成）。
部署与面板实际源码仍位于上表外部路径，插件仓库由用户关闭Codex后完成手动改名；GitHub仓库名称及远端不变。
以后插件按04、05等递增编号。根目录仅保留面板启动快捷方式作为操作入口，“过时与待清理”目录保持原位。
