# usage修复后最终只读独立复核

2026-10-27，Asia/Shanghai。本轮仅读取候选文件、docker inspect/docker exec与只读API；未改生产配置/数据库，未发送QQ或模型请求。

当前fish-bot实际镜像ID为 `sha256:d8f67e0bcc074368febe03670c3a86f90fbc197a401dfbefa49ff0d8790def95`。镜像内companion-build source为 `c1619aecffb4b60a9fd7f19cf9496db569d5faac`，版本0.1.2，包SHA256 `eb22ad1007693d08eaa51359a90998549a5ae9c979077b8d43ec82b6bb82b4e6`，与指定新候选一致。

## 新产物

候选目录 `D:\deepseek_flash\backup\companion-package-c1619ae\dist`。final-check-release.mjs检查60/60通过：tgz源码、lib、锁文件、清单与冻结目录逐文件一致，页面仅LF/CRLF差异，旧0.1.0/0.1.1产物hash未变。最终ZIP SHA256 `cee20451cdb016bdf5d1f82acf875970ebb6fd32ff8979331c74b1def2e351f2`；内嵌tgz字节hash、SHA256SUMS、CANDIDATE sourceCommit均匹配c1619ae新候选。证据：final-release-results.json、final-zip-results.json。本轮未以旧1c8bd8d结果代替新包。

生产安装的src/adapters/dsh/usage.js及lib/index.js SHA256分别为 `1f0168b225c05f0d77ceacb3112fa0c8403edf966aecc042e950b39f9faf446e`、`1a65f7b8127ea12aed047f5f08b6f3ad2ca88243dea60e53a0ad988b97d5e27c`，均与冻结目录相同。源码确实读取最新runtime-context user消息、snapshot内唯一同名qq-companion-memory section，核对召回原文而非普通用户文字，并保留storageEpoch回调隔离；安装lib也含相应实现。此处是源码/安装一致性复核，未新增模型调用来重复证明真实usage行为。

## 当前宿主状态

pluginInventory/list实际返回：旧dsh-fish-memory enabled=false；mood enabled=true且active；companion enabled=true且active。管理status实际返回capture/recall=true，learning/trial/autoAdopt=false。

takeover只读查询返回一条private范围active、acknowledged=true、legacyDisabled=true、desiredOwner=companion、bridgeVersion=0.2.1-r1。binding只读查询返回一条active、有session和bot，bindingVersion=1。没有在报告中输出真实QQ、session或正文。

status/page/page.css/page.js匿名访问均401、宿主认证访问均200；内部controls匿名401、正确内部认证200。证据为final-inventory.json、final-installed-auth.json、final-binding-takeover.json、final-installed-file-hashes.json、final-source-metadata.json与final-container-image.txt。认证材料不进入输出。

结论：指定新候选包/ZIP、运行镜像、source metadata、安装usage源码/lib及当前功能/ACK/绑定/认证状态互相一致。真实联调预算和历史调用成功属于主代理本轮证据；本独立复核没有增加任何模型或QQ调用。
