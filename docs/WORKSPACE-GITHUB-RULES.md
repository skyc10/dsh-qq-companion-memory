# 工作区规则：版本更新同步 GitHub

用户要求，2026-10-27（Asia/Shanghai）。适用于 `D:\大肥鱼QQ` 工作区及下表登记的三个关联项目，以及在这些项目中工作的主代理和子代理。部署与面板实际代码目录位于 `D:\deepseek_flash\project`，从那些目录单独接手时也应读取本规则和项目登记说明。

## 必须同步留档

- 各子项目完成版本更新或可恢复的开发阶段后，必须将对应源码、锁文件、版本/变更说明及必要交接文档提交并推送到该项目的 GitHub 仓库；GitHub 留档是完成条件，不能只留在本地。
- 此要求是用户对正常版本更新同步的持续授权。已有正确远端和可用认证时，完成必要核对后直接提交推送，不反复询问同一同步动作。
- 推送前检查实际 Git 状态、目标仓库/分支、变更范围与已有授权内的检查结果；保留用户已有修改，不以覆盖、重置或强制推送解决分歧。远端有新提交时先核对并整合。
- 推送后核对远端分支提交与本地一致，告知仓库、分支和提交号。推送失败或缺少远端/认证时如实说明，不将本地提交称为已备份；缺失的仓库归属等信息须由用户明确。

## 备份与发布分别记录

- 可先推送源码备份，再由其它 agent 测试；未测、未打包、未部署的状态要写清楚。推送不代表测试通过或上线完成，也不扩大测试、QQ/模型调用、部署和容器/profile操作的授权。
- 正式发布时同步版本号、锁文件、变更说明和相应产物记录；不覆盖已发布版本或改写旧标签。仅源码备份无需伪造新发行版本。
- 保持现有仓库私有性；不上传凭据、真实配置、用户数据库/聊天数据、依赖目录或无关生成物。构建/发行产物按各子项目现有规则处理。
- 独立 Git 仓库分别提交推送，不把所有子项目强行并成一个新仓库。没有版本更新的项目不为本规则制造空提交。

## 当前已确认的仓库

2026-10-27已通过GitHub API及本机origin逐项核对；三个仓库均为私有仓库，默认分支main。

| 子项目 | 实际代码目录 | GitHub | 默认备份分支 |
| --- | --- | --- | --- |
| 01-dafeiyu-deploy代码 | `D:\deepseek_flash\project` | [skyc10/dafeiyu-deploy](https://github.com/skyc10/dafeiyu-deploy) | main |
| 02-dafeiyu-control-panel | `D:\deepseek_flash\project\management-panel` | [skyc10/dafeiyu-control-panel](https://github.com/skyc10/dafeiyu-control-panel) | main |
| QQ陪伴记忆插件 | `D:\大肥鱼QQ\03-dsh-qq-companion-memory` | [skyc10/dsh-qq-companion-memory](https://github.com/skyc10/dsh-qq-companion-memory) | main |

完整用途、核验时提交及本地未提交状态见工作区根目录 `PROJECTS.md`（插件仓库备份副本为 `docs/WORKSPACE-PROJECTS.md`）。管理面板虽位于部署目录内，仍是独立Git仓库，必须分别提交推送。

工作区根目录当前不是 Git 仓库。本规则在根目录对所有子项目生效；副本保存于插件仓库 `docs/WORKSPACE-GITHUB-RULES.md` 随源码备份，不代表其它项目必须推送到插件仓库。
