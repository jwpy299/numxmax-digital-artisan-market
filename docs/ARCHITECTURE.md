# Architecture

治理控制面与最小权限执行面分离。MySQL 是合同、钱包、证据、幂等键、lease 与流水的 canonical 事实源，浏览器只负责展示。事件经过 lease/fencing token、dedupe、checkpoint 与撤销传播；Watchdog 只读并产证据，不充当第二调度器。

`executed != done`，`awaiting_review != delivered`。跨企业隔离、独立复核、幂等、失败恢复与跨设备接管是验收前提。
