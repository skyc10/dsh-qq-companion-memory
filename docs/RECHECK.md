# 原计划复核记录

2026-10-27，版本0.1.1。按原PLAN重新逐项核对，不能把提前发送的GitHub请求作为完成依据。

| 范围 | 主要实现 | 本轮修正 |
| --- | --- | --- |
| 身份、原文、归档 | service、conversations、SQLite、管理页 | 群绑定补可信参与者 |
| 当前记忆与共享 | service、management、memory | 事实时效/替代/冲突，保持来源和共享条件 |
| T1–T5、配额与失败 | scheduler、quota、failures | 未知用量保持未知 |
| T6–T8 | model、scheduler、http | 完整消息预算、批次输出上限、自动召回预算 |
| S1–S6 | evidence、versioning | 每候选单独核验实际应用，避免串计 |
| R1–R8 | management、service、versioning | 事实冲突落地处理、已采纳规则的本人暂停 |
| 用量与管理 | usage、客户端页面 | 聊天/记忆/学习分列，注入明示估算 |
| 接管与迁移 | bridge adapter、patch、prepare工具 | 保持固定源与离线副本，不执行接管 |
| 备份恢复与回退 | operations、SQLite、versioning | 旧异步用量不写入恢复后的库 |

静态核对覆盖源码、构建、语法、固定源补丁、包内容及独立数值公式。此记录不是运行性验收结论。未编写执行测试，未运行插件业务、QQ或模型，未部署。

两名先前只读审计子代理的结果通道在当前会话不可见，未收到的报告不算已完成独立复核。主代理继续完成源码核对；后续收到报告仍需处理。
