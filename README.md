# 彩绘玻璃工作室 · 网页拼片台

为彩绘玻璃工作室设计的网页拼片台：输入矩形窗框的正整数毫米宽高，在画布上以**整数毫米坐标**绘制带**编号与颜色**的简单多边形玻璃片；服务端精确校验每一次编辑，只有**完整覆盖窗框且无空隙**的草稿才能发布；发布时生成**铅条下料清单**（公共边只计一次，外框另列）。历史发布版不可变，随时查阅。

围绕已发布图纸还可**安排铅条生产**：登记铅条原材定尺与库存根数，选择发布版本、件数、原材规格与每刀损耗进行排产；系统按 0.01 mm 精确计算切段方案，确认时**原子预留库存**（并发不超卖），计划永久绑定发布快照。

工作室调整拼片并再次发布后，还可选择**同一图纸的任意两个已发布版本核对铅条下料变化**：按几何位置比较内部公共边与四根外框，区分沿用/取消/新增，部分重叠自动拆分；核对全程**只读**，不影响发布快照、生产计划与库存。

大窗框现场拼接时，可对已发布图纸按**实物 1:1 分张打印**：选择不可变发布版本，输入纸张宽高、四边留白与相邻页重叠宽度（整数毫米），预览按行列编号的总页数、每页覆盖的图纸坐标与拼接标记，并逐页下载物理尺寸为毫米的 SVG；玻璃片轮廓、编号与外框全部取自所选发布快照，跨页轮廓裁切到可打印区域，页内带毫米校准标尺。分张预览与下载全程**只读**。

还可直接从**彩色玻璃原片裁出已发布图纸的拼片**：每种颜色登记一种原片规格（宽高为 1–2000 整数毫米）与库存张数（调整库存不得低于已预留数）；选择发布版本、制作件数与片间最小间距（0–50 整数毫米）后按快照颜色排样，总裁片数最多 60 张；每片只可平移或旋转 90° 的整数倍，不得镜像、越板或与同板其他片轮廓净距不足。预览给出逐张原片的片号、件次、旋转角度、放置坐标与轮廓，以及各色用板数与库存缺口；确认时**原子预留所有颜色**的所需原片，并发不超卖；计划永久绑定发布快照。

已确认的裁片订单在客户改图后还可**换单**：从一张已确认订单换到**同一图纸的另一已发布版本**，重新输入件数与片间距；换单预览按颜色对比旧单与新排样的**用板数、净增减、计入旧单退出预留后的可用量与缺口**（预览不占库存）。确认换单在**同一事务**内让旧单退出预留并确认新单，任一颜色不足则旧单、库存与订单记录**全部保持原状**；成功后旧单标记**已替换**（快照与排样仍可查，但不能再取消/修改/删除），新单为独立的已确认订单；对同一旧单按相同参数重试**返回原新单**，不同参数报冲突，均不重复预留。

工作室为同一发布图纸备料时还可下**整套用料单**：一次选择发布版本、件数、铅条原材与刀损、玻璃片距；预览沿用现有铅条切段与玻璃排样规则，列出**铅条需用根数、各色原片用板张数、可用量与缺口**（不占库存）。确认时在**同一事务**内核验并预留两类库存，**任一不足全部保持原状**；成功后生成绑定同一发布快照与件数的**关联生产计划与裁片订单**。整套单取消时两类预留**各释放一次**；关联单**不能从原入口单独取消、修改、换单或删除**，重复确认/取消均不重复变更库存；原有的独立计划、订单及其接口继续可用。

月底或盘点时还可在**同一张盘点单**中勾选若干**铅条原材与玻璃原片**规格，逐项录入**实盘总数**（非负整数，同单规格不得重复）：预览保存各项当时的**系统库存、已确认独立单与整套单预留、差异及实盘后可用量，但不改库存**；确认时在**同一事务**内重核所有选中规格的库存与预留——**任一项与预览基准不符或实盘数低于当前预留，即返回该项及原因、整单不生效**；全部通过才一次更新库存，并记下**原值、实盘值与确认时间**。已确认盘点**重复提交返回同一记录、不再调整**，记录永久保留可在网页查阅；独立计划、裁片订单与整套单的确认/取消随后继续按盘点后库存计算，原有库存调整入口也继续可用。

备料完成后工作室可**按已确认单据分次领料**：来源为已确认的**独立铅条计划、独立裁片订单或整套用料单**；网页直接展示各规格**尚未领出的预留量（净预留）**。操作者提交单据、唯一领料号与本次铅条根数或各色原片张数——数量为非负整数且至少一项大于零，不得超过该单剩余预留，整套单允许只领其中一类。确认在**同一事务**内扣减实物库存与对应预留并追加**不可变领料记录**，返回本次、累计领料与余留量；任一项不合法则整次不生效。同一领料号与内容重试返回原记录，内容不同报冲突。**已领料单据不能取消，已领料的独立裁片订单不能换单**；未领料单据仍按原规则操作。盘点、手工库存调整及后续确认都按结转后的库存与净预留计算。网页可查领料历史，并提供可调用的 HTTP API 与调用示例。

工作室发现玻璃原片有瑕疵时还可对**已登记颜色原片提交隔离或解除隔离**：一次选一种或多种颜色，提交各色**正整数张数、非空原因与唯一操作号**。隔离只能划出当前**未预留（净预留）且未隔离**的实物，解除不得超过**隔离余额**；**实物库存不因隔离变化**，而新裁片订单与整套单的**实际可用量须扣除隔离量**（`可用 = 实物库存 − 净预留 − 隔离`）。裁片订单、整套单的确认/换单/领料、手工调库与盘点全部守住**实物库存不低于净预留与隔离量之和**，已确认单据仍可按原预留领料；未知颜色、非法数量或任一颜色余额不足时**整次不生效**。每次操作在同一事务原子写入**不可变隔离记录**与台账中的**隔离增减、笔后余额**；同操作号同内容重试返回原记录，异内容报冲突。网页“瑕疵隔离”标签与 HTTP API 展示各色隔离余额、实际可用量与历史。

工作室还可从**任一已发布图纸选片复用到另一张图纸的草稿**：从来源发布快照勾选**至少一片且编号不重复**的拼片，指定目标图纸草稿、绕**来源图纸坐标原点**的 **0/90/180/270° 旋转**与**整数毫米平移**，先**定位预览**转换后的轮廓、原色、目标位置以及草稿覆盖状态；预览**落库但不写拼片**，确认时在同一写事务内重核草稿指纹与几何——**预览后草稿被编辑即 409 报冲突、须重新预览**——通过则**整批赋予目标图纸的新编号（保留原色）**。所有拼片必须仍是合法简单多边形、完全落在目标窗框内，彼此及与目标已有拼片**不得面积重叠**（合法共边、T 接、顶点相接允许）；来源发布快照、已有生产单与库存始终不变，确认结果按现有草稿规则参与覆盖检查、下料清单与后续发布，原有单片编辑与发布接口继续可用。

## 功能一览

- **窗框建模**：宽、高为正整数毫米（1–100000）。
- **拼片绘制**：画布点击取点（自动吸附已有顶点/窗框角），双击或“闭合多边形”完成；也可直接输入 `x,y` 坐标。每片有独立编号与颜色。
- **编辑校验（拒绝并标出位置，图中红色 ✕ 标记）**：
  - 顶点必须是整数毫米，且在窗框内 —— 越界拒绝；
  - 必须是简单多边形：自交（边交叉/边重叠/非端点相触）、重复顶点、零边、相邻共线均拒绝；
  - 与现有拼片**面积重叠**拒绝（边交叉、顶点穿入、共边同侧重叠、顶点处内角相交）；
  - 允许合法相邻：共边共享、T 接、顶点相接；
  - **允许相邻片边界一侧是整边、另一侧为数段**。
- **覆盖检查与缺口可视化**：未发布前实时分析草稿，缺口区域以红色斜纹多边形标出并给出每块缺口面积；面积重叠以紫色标出。
- **发布**：仅当无缺口、无重叠、面积合计等于窗框面积时可发布，否则返回 422 并附带缺口数据。发布版带递增版本号，快照不可变。
- **发布图纸**：展示每片编号、颜色与面积（mm²），画布上直接标注编号与面积。
- **铅条下料清单**：
  - 内部公共边无论怎样分段都**合并为一根、只计一次**（T 接处直线继续则不断开）；
  - 外框四根（上/下/左/右）另列；
  - 每根长度、分类小计与总长都是**先求和再四舍五入至 0.01 mm**。
- **草稿/发布分离**：后续编辑、删除、改色与清单重算只作用于草稿；历史发布版通过版本下拉框查阅，内容永不变化。
- **两版铅条核对（本轮新增）**：
  - 选择同一图纸的两个已发布版本，分别比较**内部公共边**与**四根外框**（上/下/左/右）；
  - 两版**共线且空间重叠**的部分为**沿用**，仅较早版覆盖为**取消**，仅较晚版覆盖为**新增**，部分重叠在端点处**自动拆分**；
  - 比较前做无向直线归一与同版区间合并：**反向记录、清单顺序变化、T 接处分段变化（一侧整边/另一侧数段）都不产生虚假差异**；
  - 展示每类线段的起点/终点（mm）、长度（mm）与分类合计；各类合计**先求和再四舍五入到 0.01 mm**；
  - 版本不存在、两个发布版不属于同一图纸时**明确报错**；核对为**只读**，发布快照、生产计划、库存均不变化。
- **铅条生产（本轮新增）**：
  - **原材登记**：登记原材规格名、**定尺长度**（正数，精确到 0.01 mm）与**库存根数**（非负整数）；非法输入一律拒绝且不改库存。
  - **排产取段**：只取所选**发布版本**铅条清单中的**内部公共边**与**四根外框**（上/下/左/右），按**件数**逐件展开，每一段都是**不可拼接**的独立切段。
  - **切段规则**：切段按长度**降序**排列，同长按清单顺序；依次放入**第一根能容纳**它的原材（首次适应递减 FFD）。每段占用 `成品长度 + 一刀损耗`，放不下就开新原材；输出逐根切段、每根余料与需用根数。
  - **预览不占库存**：任何非法输入、单段连同刀损超过定尺（整单拒绝）都不会改动库存。
  - **缺口与确认**：需用根数超过可用数时返回**缺口根数且不能确认**；确认在一个 `BEGIN IMMEDIATE` 事务中**原子预留**，多计划并发也**不会超卖**。
  - **幂等与释放**：重复确认不会重复预留；取消只释放一次，重复取消不重复改库存；已确认计划不可删除（须先取消）。
  - **快照绑定**：计划一旦建立即绑定该发布版本，后续草稿改动或再发布新版本**都不影响**其用料。
  - 网页“铅条生产”标签可登记库存、预览、确认/取消计划并查看可用库存。
- **1:1 分张打印（本轮新增）**：
  - 在“分张打印”标签选择图纸与**已发布版本**，输入**纸张宽高、四边留白、相邻页重叠宽度（整数毫米）**生成拼接预览；
  - 玻璃片轮廓/编号/颜色/面积与外框**全部取自所选不可变快照**，草稿改动或再发布均不影响已生成的分页（重新预览才取新版本）；
  - 预览给出**行列编号总页数**（行自下而上对应图纸 y 轴、列自左而右）、**每页覆盖的图纸坐标范围**与四边**拼接标记**（邻页页码、重叠带、红色对位十字及其图纸坐标）；
  - 每页可**单独下载 SVG**，也可一键逐页下载：`width/height` 以 **mm** 标定物理尺寸，图纸内容按 1:1 绘制并**裁剪到可打印区域**，重叠带在相邻两页使用**完全相同的图纸坐标**，页内含**毫米校准标尺**（打印请选“实际大小/100%”）；
  - **校验**：纸张尺寸与重叠必须为正，留白可为零；可打印尺寸非正、重叠不小于任一可打印边长、版本不存在、总页数超过 **200** 时**明确拒绝且不输出部分页面**；
  - 预览与下载均为**只读**，不修改草稿、发布版、生产计划或库存。
- **玻璃裁片（本轮新增）**：
  - **原片登记**：每种颜色登记**一种**原片规格——宽、高为 **1–2000 整数毫米**，库存张数为非负整数；颜色/宽高属规格身份不可修改，仅可调整库存且**不得低于已确认订单预留张数**。
  - **按快照颜色排样**：选择发布版本、**制作件数**（正整数）与**片间最小间距 gap（0–50 整数毫米）**，按发布快照把拼片逐件展开、按颜色分组独立装箱；**相同版本与排样参数的布局逐字节一致**（确定性），不保证全局最少用板。
  - **每片约束**：仅可**整数毫米平移**或旋转 **0°/90°/180°/270°**（不得镜像）；轮廓必须**完全在原片矩形内**（可贴边）；同板片间**不得面积重叠**，且**轮廓最短净距 ≥ gap**（gap=0 允许共边/T 接/顶点接触）；距离判定使用整数坐标的 **BigInt 精确运算**，无浮点误差。
  - **装箱策略**：片按外接矩形面积降序排列，逐片**首次适应**（先试既有原片再开新片），同板采用**左下角**定位并对四个旋转角取最低、最左、角度最小者，最后以真实多边形轮廓精确复核间距与越板。
  - **预览**：给出**逐张原片**的片号、件次、旋转角度、放置坐标 `(x,y)`、外接宽高与放置后轮廓（整数毫米绝对坐标，附 SVG 示意图），以及**各色用板数、库存/已预留/可用/缺口**与总缺口；预览不落库、不占库存。
  - **整单拒绝（不产生部分方案）**：缺少对应颜色原片登记（`missing_color`）、单片任何旋转都无法放入原片（`piece_too_large`）、参数非法、总裁片数超过 **60**（`too_many_sheets`）。
  - **原子预留与并发**：确认在一个 `BEGIN IMMEDIATE` 事务中逐色核对并预留，**任一颜色库存不足则整单失败、不留部分**；多订单并发也**不会超卖**。
  - **幂等与快照**：重复确认不重复预留；取消只释放一次（重复取消返回 409 且不再改库存）；已确认订单不可改、不可删（须先取消）；订单永久绑定发布快照，草稿改动或再发布均不改变已确认方案。
  - **换单（本轮新增）**：仅**已确认**订单可换；选择**同一图纸的另一已发布版本**与新件数/片间距，预览按颜色列出**旧单用板/新排样用板/净增减/计入旧单退出预留后的可用量/缺口**（只读不占库存）；确认在一个 `BEGIN IMMEDIATE` 事务内**旧单退出预留 + 新单创建即确认**，任一颜色不足整体回滚并返回各色缺口；成功后旧单置为**已替换**（保留发布快照与排样，不可再取消/修改/删除），新单是独立已确认订单、可继续取消或再次换单（形成换单链）；同一旧单相同参数重试**幂等返回原新单**、不同参数返回 409 冲突，均不重复预留。
  - 网页“玻璃裁片”标签可登记原片、排样预览、存草稿、确认/取消订单并查看逐张排样示意；已确认订单详情内展开“换单”面板即可查看换单预览并确认换单。
- **整套用料单（本轮新增）**：
  - **一次备齐**：选择发布版本、件数、铅条原材与每刀损耗、玻璃片间最小间距；**整套预览**沿用现有切段（FFD + 刀损）与玻璃排样规则，列出铅条**需用根数**、**各色原片用板张数**、各自**库存/已预留/可用/缺口**与总缺口；预览**不落库、不占库存**，几何/缺色/超 60 张等整单拒绝规则不变。
  - **原子确认**：确认在一个 `BEGIN IMMEDIATE` 事务内同时核验铅条原材与各色玻璃原片，**铅条或任一颜色不足即整体回滚**（409 `shortage`，返回铅条与每色缺口），两类库存、计划/订单记录**全部保持原状**；成功后同事务生成**关联生产计划 + 关联裁片订单**（均创建即已确认），二者绑定**同一发布快照与同一件数**。
  - **幂等**：确认须带 `requestId` 幂等键；同键重试**返回原整套单**（不重复预留），同键不同参数返回 409 `request_conflict`；多客户端并发由写事务串行化，**两类库存都不超卖**。
  - **取消**：整套单取消在一个事务内把关联计划与订单同时置为已取消，**铅条与玻璃预留各释放一次**；重复取消返回 409 且不重复变更库存。
  - **关联单保护**：关联生产计划不能从 `/api/plans` 入口单独确认/取消/修改/删除；关联裁片订单不能从 `/api/cut-orders` 入口单独确认/取消/修改/删除/换单（均 409 `combo_locked`，只读详情仍可查），防止状态分叉。
  - **独立性**：原有独立铅条计划、独立裁片订单（含换单）的全部接口与网页入口**继续可用、互不影响**；独立单 `comboId` 为 `null`。
  - 网页新增“整套备料”标签：整套预览（含逐根切段与逐色/逐张排样示意）、一键原子确认、整套单列表与详情、取消整套单；“铅条生产/玻璃裁片”列表中关联单带 🔗 标记且无独立操作按钮。
- **库存盘点（本轮新增）**：
  - **同单混盘**：一张盘点单可同时勾选若干**铅条原材**与**玻璃原片**规格，逐项录入**实盘总数**（非负整数；同类型规格同单不得重复，铅条与玻璃各自去重）；空单、负数、小数一律拒绝。
  - **预览即固化基准（不改库存）**：预览会保存为草稿盘点单，逐项记录当时的**系统库存、已确认独立单与整套单预留**，并给出**差异（实盘 − 系统）**与**实盘后可用量（实盘 − 预留）**；预览本身**不改动任何库存**。草稿可修改重选规格/改实盘数（重新固化基准）或删除。
  - **确认整单重核（同事务）**：在一个 `BEGIN IMMEDIATE` 事务内对所有项重核——规格仍存在、规格身份未变（铅条定尺/玻璃宽高）、**系统库存与预留均与预览基准一致**、且**实盘数不低于当前已确认预留**；任一项不符即 **409 返回全部问题项及原因**（`spec_missing`/`spec_changed`/`stock_changed`/`reserved_changed`/`below_reserved`，附基准值与当前值），**整单不生效、库存不变**。
  - **一次更新与永久记录**：全部通过才在同一事务内一次更新各规格库存，并记录每项**原值、实盘值与确认时间**；已确认单**重复提交返回同一记录**（`idempotent:true`），**不再调整库存**；已确认单不可修改/删除，列表与详情（含网页）随时可查。
  - **盘点后口径不变**：独立铅条计划、独立裁片订单（含换单）与整套用料单的确认/取消继续按 `库存 − 已确认预留` 计算（已包含盘点调整后的库存）；`PATCH` 调整库存的原入口继续可用，但预览后经该入口变动库存会使旧预览在确认时按基准不符被拒绝。
- **分次领料（本轮新增）**：
  - **领料来源**：仅**已确认**的独立铅条计划、独立裁片订单、整套用料单可领；草稿/已取消/已替换不能领；整套单的关联计划/订单只能从整套单入口领（独立入口 409 `issue_use_combo`）。
  - **网页展示净预留**：铅条/玻璃库存表新增“已领”“未领预留”；选中单据即显示各规格**预留总量/已领/尚未领出的余留量/实物库存**。接口 `reserved` = 尚未领出的净预留，另附 `grossReserved`、`picked`、`remainingReserved`。
  - **数量规则**：`issueNo` 唯一领料号 + 本次铅条根数或各色原片张数；非负整数且**至少一项大于零**；逐项不得超过该单**剩余预留**；**整套单允许只领一类**（另一类为 0/不传）。
  - **原子确认**：一个 `BEGIN IMMEDIATE` 事务内核验单据状态、剩余预留与实物库存，**同时扣减实物库存并追加不可变领料记录**（同号多行）；任一项不合法（超剩余/实物不足/颜色不在单内/数量非法）**整次不生效**。
  - **返回与结转口径**：返回**本次/累计/余留量**与当前实物库存；此后盘点、手工调库、新单据确认都按 `available = stock −（grossReserved − picked）` 计算，领料不影响其他单据的可预留量。
  - **幂等与冲突**：同领料号同内容重试返回原记录（200 `idempotent:true`，不再次扣减）；同号不同内容 409 `issue_no_conflict`；并发领料由写事务串行化，合计不超过余留。
  - **终态保护**：**已领料单据不能取消**（409 `already_issued`）；**已领料的独立裁片订单不能换单**（预览/确认均 409）；未领料单据仍按原规则操作。领料记录只追加、不可变、不可删除。
  - 网页新增“领料”标签：选单→看净预留→分次领料（自动生成领料号、可重试）、领料历史筛选；HTTP API 与 curl 示例见下文“分次领料规则”。
- **玻璃原片瑕疵隔离（本轮新增）**：
  - **隔离/解除**：发现玻璃原片有瑕疵时，选**一种或多种已登记颜色**，对每色提交**正整数张数、非空原因与唯一操作号**；一次操作在一个 `BEGIN IMMEDIATE` 事务内对多色**原子生效**。
  - **划出上限**：隔离只能划出当前**未预留（净预留）且未隔离**的实物——可隔离量 = `实物库存 − 净预留 − 已隔离`；解除隔离不得超过该色**隔离余额**。**实物库存（stock）不随隔离变化**，变化的只是隔离余额。
  - **实际可用量**：新裁片订单与整套单的可用量一律 `available = stock − 净预留 − quarantined`；裁片订单确认/换单、整套单确认、领料、手工调库、盘点全部守住**实物库存不低于净预留与隔离量之和**；**已确认单据仍可按原预留领料**。
  - **整次不生效**：未知颜色/未登记颜色（404）、数量非正整数、空原因、缺操作号、同色重复、任一颜色可隔离量/隔离余额不足，均返回该项原因并**整次不生效**（不写任何隔离记录、不改台账）。
  - **不可变与幂等**：隔离主记录与分色明细（含各色**笔后隔离余额**）**只追加、不可变**；同一操作号同内容重试返回原记录（200 `idempotent:true`），同号异内容 409 `op_no_conflict`。
  - **台账同步**：每次操作在同事务写台账 `quarantine_hold`/`quarantine_release`（实物/净预留增减为 0，隔离增减 ±n、笔后隔离余额），逐笔可顺序核对；网页与 HTTP API 展示各色**实物库存/净预留/隔离余额/实际可用量**与历史。
- **库存台账（本轮新增）**：
  - **按规格逐笔追溯**：网页“库存台账”标签或 `GET /api/ledger` 选择**材料类型（铅条原材/玻璃原片）+ 规格 + 时间范围**后，逐笔展示**发生时间、业务来源、实物库存与净预留的增减及笔后余额**（按发生顺序排列）；无记录返回空结果，类型/规格/时间非法或区间颠倒**明确报错**（400/404）。
  - **同事务记账**：原材/原片**登记**与**手工调库**、独立计划/独立裁片订单/**整套单**的**确认与取消**、**裁片换单**（旧单退出 + 新单接替）、**盘点确认**、**领料确认**，都在**同一事务**内写入台账；任一步失败整体回滚，**预览、失败回滚与幂等重试不留下重复流水**。
  - **基线口径**：已有数据库**首次启用**时按各规格**当前实物库存与净预留**写一条 `baseline` 基线（旧业务**不倒推**）；全新库无规格则不写基线；**新登记规格从 `register` 登记流水起账**。此后每规格的流水都可从首笔起**顺序核对**（上笔余额 + 本笔增减 = 本笔余额）至当前结存。
  - **口径一致**：台账的“净预留”与库存接口的 `reserved` 同口径（已确认预留 − 已领出）；领料一笔同时核减实物库存与净预留；换单按“先旧单退出、后新单接替”两笔记，保证同色也能逐笔对平。
- **跨图纸拼片复用（本轮新增）**：
  - **选片**：从**任一已发布图纸**的某个不可变版本快照中勾选**至少一片且不重复**的拼片编号（源/目标可以是不同窗框尺寸的图纸，也允许同一图纸）；颜色取自快照，导入后**保留原色**。
  - **定位**：对整批统一做绕**来源图纸坐标原点 (0,0)** 逆时针 **0°/90°/180°/270°** 旋转，再做 **整数毫米平移 (dx,dy)**；不镜像。刚体变换保持整数坐标、面积与多边形简单性。
  - **定位预览（落库但不写拼片）**：返回逐片的**来源编号、原色、旋转/平移、转换后轮廓与外接范围**、目标草稿当前与**导入后模拟覆盖状态**（缺口/重叠照常标出）；几何不通过（`out_of_frame`/`overlap`）返回 **422 并逐片指出原因、位置与冲突对象**，来源版本或来源片号不存在返回 404，**整批不写入**。
  - **确认整批写入**：在一个 `BEGIN IMMEDIATE` 写事务内先比对**草稿指纹**（预览后目标草稿新增/修改/删除任一片即不符）再重放全部几何校验；通过则按选片顺序**整批赋予目标图纸的新编号（编号在目标图纸内继续递增、永不复用）**，保留原色。**预览后草稿被编辑** → 409 `draft_changed`（须重新预览）；**几何冲突** → 422；**任一拼片或来源版本不存在** → 404；均**整批不写入**。
  - **预览管理与终态**：待确认预览可列出、再次载入画布或删除；确认成功的记录永久保留、**不能重复确认**（409 `already_confirmed`，不重复写片）也不能删除。
  - **下游口径不变**：导入只作用于目标图纸的**草稿**；确认结果按现有草稿规则参与**覆盖检查、铅条下料清单与后续发布**；**源发布快照、已有生产单（铅条/裁片/整套）与库存台账完全不变**；原有单片新增/编辑/删除与发布接口继续可用。
  - 网页新增“跨图复用”标签：选来源图纸/版本勾选拼片 → 选目标草稿与旋转/平移 → “定位预览”（画布蓝色半透明为导入片、灰色淡片为目标已有片、红 ✕ 标冲突点）→ “确认整批导入”；HTTP API 与 curl 示例见下文“跨图纸拼片复用规则”。

## 技术栈

- Node.js ≥ 20（CommonJS）
- Express 4（Web/API/静态资源）
- better-sqlite3（SQLite，同步事务）
- 原生 HTML/CSS/Canvas + 原生 JS（无前端构建步骤）
- 几何判定全部使用整数坐标的精确整数运算（叉积/射线法），交点以精确分数表示，避免浮点误差

## 快速启动

### 方式一：Docker Compose（推荐，一键启动并初始化数据库）

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖，并在容器内对 `/data/studio.db` 执行建表初始化
（`CREATE TABLE IF NOT EXISTS`），无需手动初始化。

浏览器打开：

```
http://localhost:3000
```

停止：

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 同时删除数据库卷
```

### 方式二：本地 Node.js 运行

```bash
npm install
npm start
```

若 better-sqlite3 需要本地编译，请确保具备 Python 3、make、g++（Debian/Ubuntu：
`apt-get install -y python3 make g++`）。

浏览器同样打开 http://localhost:3000 。

运行几何算法测试：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `data/studio.db`（本地）/ `/data/studio.db`（Docker） | SQLite 数据库文件路径；目录不存在会自动创建，首次启动自动建表 |

Compose 中通过命名卷 `studio-data` 持久化 `/data`；改宿主机端口只需修改
`docker-compose.yml` 的端口映射（如 `"8080:3000"`）。

## 网页地址与端口

- 应用首页：`http://localhost:3000/`
- 端口：`3000`（可用 `PORT` 环境变量或 compose 端口映射更改）

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/designs` | 图纸列表 |
| POST | `/api/designs` | 新建图纸 `{name,width,height}`（宽高正整数毫米） |
| GET | `/api/designs/:id` | 草稿完整汇总（片/面积/缺口/铅条清单） |
| POST | `/api/designs/:id/pieces` | 新增拼片 `{color,polygon:[[x,y],...]}` |
| PUT | `/api/designs/:id/pieces/:pieceId` | 编辑拼片（改色/改顶点） |
| DELETE | `/api/designs/:id/pieces/:pieceId` | 删除拼片（仅草稿） |
| POST | `/api/designs/:id/imports/preview` | 跨图复用定位预览 `{publicationId 或 sourceDesignId+sourceVersion, pieceNos, rotation, dx, dy}`（预览落库但不写拼片） |
| GET | `/api/designs/:id/imports` | 复用预览列表（可 `?status=pending|confirmed`） |
| GET | `/api/designs/:id/imports/:importId` | 单个复用预览（`stale=true` 表示预览后草稿已被编辑） |
| POST | `/api/designs/:id/imports/:importId/confirm` | 整批确认：整批赋予目标草稿新编号、保留原色；草稿已变 409 `draft_changed` |
| DELETE | `/api/designs/:id/imports/:importId` | 删除待确认预览（已确认 409） |
| POST | `/api/designs/:id/publish` | 发布（未完整覆盖返回 422 + 缺口数据） |
| GET | `/api/designs/:id/publications` | 发布版列表 |
| GET | `/api/designs/:id/publications/:version` | 查阅指定发布版（不可变快照） |
| GET | `/api/designs/:id/publications/diff?fromVersion=1&toVersion=2` | 两版铅条核对（版本号；自动按版本号定较早/较晚，只读） |
| POST | `/api/designs/:id/publications/:version/print/preview` | 1:1 分张打印预览 `{paperWidth,paperHeight,margin,overlap}`（整数毫米，只读） |
| GET | `/api/designs/:id/publications/:version/print/page?paperWidth&paperHeight&margin&overlap&page=n` | 下载指定页 SVG（`image/svg+xml`，物理尺寸 mm，只读） |
| POST | `/api/publications/diff` | 两版铅条核对 `{publicationIdA,publicationIdB}`（非同图纸返回 400） |
| GET | `/api/materials` | 铅条原材规格与库存（含已预留/可用根数） |
| POST | `/api/materials` | 登记原材 `{name,length,stock}`（定尺正数 mm、库存非负整数） |
| GET | `/api/materials/:id` | 单个原材规格 |
| PATCH | `/api/materials/:id` | 改名称/库存根数 `{name?,stock?}`（定尺不可改；库存不得低于已预留） |
| POST | `/api/plans/preview` | 排产预览 `{publicationId,materialId,copies,kerf}`（不落库、不占库存） |
| POST | `/api/plans` | 建草稿计划（同上，可带 `name`） |
| GET | `/api/plans` | 计划列表（含状态/需用/缺口） |
| GET | `/api/plans/:id` | 计划详情（逐根切段、余料、绑定版本） |
| PUT | `/api/plans/:id` | 修改草稿（重选版本/件数/原材/刀损并重算） |
| POST | `/api/plans/:id/confirm` | 确认并原子预留；缺口返回 409 |
| POST | `/api/plans/:id/cancel` | 取消并释放预留（幂等） |
| DELETE | `/api/plans/:id` | 删除草稿/已取消计划（已确认须先取消） |
| GET | `/api/glass-sheets` | 彩色原片规格与库存（含已预留/可用张数） |
| POST | `/api/glass-sheets` | 登记颜色原片 `{color,width,height,stock}`（每色一种，宽高 1–2000 整数 mm） |
| GET | `/api/glass-sheets/:id` | 单个颜色原片规格 |
| PATCH | `/api/glass-sheets/:id` | 调整库存张数 `{stock}`（颜色/宽高不可改；不得低于已预留） |
| POST | `/api/cut-orders/preview` | 裁片排样预览 `{publicationId,copies,gap}`（不落库、不占库存） |
| POST | `/api/cut-orders` | 建草稿裁片订单（同上，可带 `name`） |
| GET | `/api/cut-orders` | 裁片订单列表（含状态/各色用板/缺口） |
| GET | `/api/cut-orders/:id` | 订单详情（逐张原片放置、绑定版本） |
| PUT | `/api/cut-orders/:id` | 修改草稿（重选版本/件数/间距并重算） |
| POST | `/api/cut-orders/:id/confirm` | 确认并原子预留所有颜色；任一色不足返回 409（整单失败） |
| POST | `/api/cut-orders/:id/cancel` | 取消并释放预留（只释放一次，幂等） |
| POST | `/api/cut-orders/:id/replacement/preview` | 换单预览 `{targetPublicationId 或 targetVersion, copies?, gap?}`（只读，不占库存） |
| POST | `/api/cut-orders/:id/replacement` | 确认换单（同事务旧单退出预留+新单确认；相同参数幂等返回原新单，不同参数 409） |
| DELETE | `/api/cut-orders/:id` | 删除草稿/已取消订单（已确认须先取消；已替换不可删） |
| POST | `/api/combo-orders/preview` | 整套用料预览 `{publicationId,materialId,copies,kerf,gap}`（铅条根数+各色张数/可用/缺口；不落库、不占库存） |
| POST | `/api/combo-orders` | 确认整套单 `{...,requestId,name?}`（同事务核验并预留两类库存，任一不足全部回滚；同 requestId 重试幂等） |
| GET | `/api/combo-orders` | 整套单列表（含状态/关联计划与订单） |
| GET | `/api/combo-orders/:id` | 整套单详情（关联生产计划、裁片订单、两套方案快照） |
| POST | `/api/combo-orders/:id/cancel` | 取消整套单（同事务取消两个关联单，两类预留各释放一次；重复取消 409） |
| POST | `/api/stocktakes/preview` | 盘点预览（建草稿并固化基准库存/预留，不改库存）`{name?,items:[{type:'lead'|'glass',specId,counted}]}` |
| GET | `/api/stocktakes` | 盘点单列表（含状态/铅条项数/玻璃项数/确认时间） |
| GET | `/api/stocktakes/:id` | 盘点单详情（逐项原值/预留/实盘/差异/实盘后可用量） |
| PUT | `/api/stocktakes/:id` | 修改草稿盘点单（重选规格/改实盘数并重新固化基准；已确认 409） |
| POST | `/api/stocktakes/:id/confirm` | 确认盘点（同事务重核全部项；不符返回 409 各项原因；重复提交幂等返回原记录） |
| DELETE | `/api/stocktakes/:id` | 删除草稿盘点单（已确认永久记录不可删，409） |
| POST | `/api/issues` | 统一领料入口 `{issueNo, sourceType, planId/orderId/comboId, leadBars?, sheets?}`（同事务扣实物+净预留，记录不可变） |
| POST | `/api/plans/:id/issues` | 按独立铅条计划领料 `{issueNo, leadBars}` |
| POST | `/api/cut-orders/:id/issues` | 按独立裁片订单领料 `{issueNo, sheets:[{sheetId 或 color,count}]}` |
| POST | `/api/combo-orders/:id/issues` | 按整套单领料（允许只领一类）`{issueNo, leadBars?, sheets?}` |
| GET | `/api/issues` | 领料历史（可 `?source=lead_plan|cut_order|combo` 过滤） |
| GET | `/api/issues/:issueNo` | 按唯一领料号查领料记录（本次/累计/余留） |
| GET | `/api/plans/:id/issues` | 计划维度：铅条剩余预留 + 该单领料历史 |
| GET | `/api/cut-orders/:id/issues` | 订单维度：分色剩余预留 + 该单领料历史 |
| GET | `/api/combo-orders/:id/issues` | 整套单维度：铅条+玻璃剩余预留 + 该单领料历史 |
| GET | `/api/ledger?type=lead\|glass&specId=N&from&to` | 库存台账：按材料类型+规格+时间范围逐笔查实物库存/净预留/隔离增减与笔后余额（无记录返回空；非法筛选 400/404） |
| POST | `/api/glass-quarantines` | 玻璃原片瑕疵隔离/解除 `{opNo,action:'hold'\|'release',reason,items:[{sheetId 或 color,count}]}`（同事务原子写不可变记录与台账；同号同内容幂等，异内容 409） |
| GET | `/api/glass-quarantines` | 隔离历史（可 `?sheetId=N`、`?color=#rrggbb`、`?opNo=...` 过滤） |
| GET | `/api/glass-quarantines/:id` | 单条隔离记录（分色当次张数与笔后隔离余额） |

校验失败统一返回：

```json
{ "ok": false, "error": "原因", "category": "invalid|out_of_frame|overlap|not_covered",
  "at": [x, y], "gaps": [ { "polygon": [[x,y],...], "area": 1234.5 } ] }
```

## 使用流程

1. 左侧“新建图纸”，输入名称与窗框宽高（正整数毫米）。
2. 选择颜色，在画布上依次点击顶点绘制多边形（可自动吸附），双击完成；或在文本框逐行输入 `x,y` 后点“闭合多边形”。
3. 若被拒绝，画布会用红色 ✕ 标出问题位置，顶部红条说明原因与坐标。
4. 重复绘制直到覆盖状态变为“✓ 完整覆盖，无空隙”；绘制过程中缺口实时以红色斜纹显示。
5. 点击“发布图纸”，得到新版本；切到“已发布图纸”标签，选择版本查阅图纸、面积明细与铅条下料清单。
6. 发布后仍可继续编辑草稿（产生新版本），旧版本内容保持不变。
7. 切到“版本核对”标签：选择图纸与较早/较晚两个发布版 → “核对铅条下料变化”：画布与表格展示沿用（蓝实线）、取消（红虚线）、新增（绿实线）每一段的位置与长度，以及内部公共边、四根外框与总计三类合计。
8. 切到“铅条生产”标签：登记原材定尺与库存根数 → 选发布版本/件数/原材/每刀损耗 → “排产预览”查看逐根切段与余料 → “存为草稿计划” → 库存足够时“确认计划”原子预留；需要退料时“取消计划”释放预留。
9. 切到“分张打印”标签：选图纸与已发布版本 → 输入纸张宽高、四边留白与相邻页重叠（整数毫米）→ “生成拼接预览”查看行列总页数、每页覆盖坐标与拼接标记 → 逐页或一键“逐页下载全部 SVG”，打印时选择“实际大小/100%”，按重叠带与红色对位十字现场拼接。
10. 切到“玻璃裁片”标签：按颜色登记原片宽×高（1–2000 整数 mm）与库存张数 → 选发布版本、制作件数与片间最小间距 → “排样预览”查看逐张原片的片号/件次/旋转/坐标/轮廓与各色用板、库存缺口 → “存为草稿订单” → 库存充足时“确认订单”原子预留所有颜色；需要退料时“取消订单”一次性释放。客户改图并再次发布后，打开**已确认订单**详情、展开底部“⇄ 换单”面板 → 选同一图纸的新版本、件数与片间距 → “换单预览”核对各色旧/新用板、净增减与旧单释放后的可用量 → “确认换单”原子完成（旧单变“已替换”，新单即确认）；相同参数重复提交会返回原新单。
11. 切到“整套备料”标签：选发布版本、件数、铅条原材与刀损、玻璃片距 → “整套预览”一次看清铅条根数与各色原片张数的可用/缺口（不占库存）→ “确认整套单”在同一事务预留两类库存并生成绑定同一快照与件数的关联生产计划、裁片订单；退料时在整套单详情“取消整套单”，两类预留各释放一次。关联单在“铅条生产/玻璃裁片”中带 🔗 标记，只能查阅、不能单独操作。
12. 切到“库存盘点”标签：勾选要盘点的铅条原材与玻璃原片规格（可只盘其中几项）、逐项填写实盘总数 → “预览盘点”保存当时的系统库存、已确认预留、差异与实盘后可用量（不改库存）→ 核对无误后“确认盘点”；若预览后库存或预留有变化，或某项实盘数低于当前预留，会标出该项与原因且整单不生效，可“改后重新预览”刷新基准后再确认。已确认盘点单永久保留、重复确认返回原记录；之后独立计划、裁片订单与整套单都按盘点后的库存继续计算。
13. 切到“领料”标签：选择已确认的独立铅条计划/独立裁片订单/整套用料单，页面列出各规格**尚未领出的预留量（净预留）**与实物库存；填写唯一领料号（可一键生成）与本次铅条根数/各色原片张数（非负整数、至少一项大于 0、不超过余留；整套单可只领一类）→ “确认领料”，同一事务扣减实物库存与对应预留，并返回本次/累计/余留。网络重试直接用同一领料号即可返回原记录；换内容则报冲突。已领料的计划/订单/整套单不能再取消，已领料的独立裁片订单不能换单；下方可筛选查阅全部领料历史。
14. 切到“库存台账”标签：选择**材料类型**（铅条原材/玻璃原片）与**规格**，可再限定**起止时间** → “查询台账”，逐笔查看发生时间、业务来源、实物库存与净预留（玻璃另含瑕疵隔离）的增减及笔后余额；左下“当前结存”可与末笔余额对照核对。首次启用时各规格以当时库存与净预留建立基线，新登记规格从登记流水起账。
15. 切到“跨图复用”标签：在左侧选**来源图纸与已发布版本**并勾选至少一片拼片，再选**目标图纸草稿**、设置**旋转角与整数平移** → “定位预览”；画布上灰色淡片为目标已有片、蓝色实片为转换后的导入片，冲突位置以红色 ✕ 标出，右侧逐片列出原色、外接范围与导入前后覆盖状态。确认无误点“确认整批导入”，整批按顺序获得目标图纸新编号（原色不变）；若预览后草稿又被编辑，确认会提示冲突，重新预览即可。预览列表中的待确认项可随时载入画布或删除。
16. 切到“瑕疵隔离”标签：右上表格直接展示各色**实物库存 / 净预留 / 隔离余额 / 实际可用量**；左侧选“隔离”或“解除隔离”→ 生成唯一操作号、填写非空原因、为一种或多种颜色填写正整数张数 → “提交”原子生效。隔离只能划出当前未预留且未隔离的实物（每行实时显示可隔离量/隔离余额），任一颜色余额不足整次不生效；提交后点历史记录可查看各色当次张数与笔后隔离余额。同一操作号重试返回原记录，换内容报冲突。

## 玻璃裁片排样规则

- **原片规格**：每种颜色（`#RRGGBB`，大小写归一）只可登记一种规格：宽、高均为 **1–2000 整数毫米**；库存张数为非负整数。颜色与宽高是规格身份不可修改，只可 `PATCH` 调整库存，且**库存不得低于净预留与瑕疵隔离量之和**（`reserved + quarantined`）。
- **排样输入**：`publicationId`（不可变发布版）、`copies` 制作件数（正整数）、`gap` 片间最小间距（**0–50 整数毫米**）。拼片、颜色与轮廓全部取自发布快照；按件数逐件展开（件次 1..N），再按颜色分组独立装箱。
- **每片允许的变换**：整数毫米平移 + 旋转 **0/90/180/270**；**不允许镜像**。放置后轮廓必须完全位于原片矩形 `[0,width]×[0,height]` 内（允许贴边）。
- **同板约束（精确整数判定）**：片间不得有任何面积重叠（边交叉、共线重叠、顶点穿入、包含均拒绝；共边/T 接/顶点接触合法）；轮廓之间的**最短欧氏距离必须 ≥ gap**。距离用整数坐标的 BigInt 平方距离精确比较（点-线段垂足参数用叉积判定，交叉相乘与 gap² 比较），斜边、斜向净距也无浮点误差；gap=0 时等价于“不重叠即可接触”。
- **装箱（确定性，非全局最优）**：片先按外接矩形面积（再按高、宽、片号、件次）降序；逐片首次适应——按板号从早到晚尝试，板内取四个旋转角中**最低 y、同 y 最左 x、角度最小**的左下角可行位置；矩形包围盒快速定位后，再用真实多边形轮廓精确复核重叠与净距。放不下就开新原片。相同发布版本 + 相同 copies/gap 的布局**完全一致**；**不保证全局最少用板**。
- **总裁片数上限 60**：所有颜色用板总数超过 60 时返回 422（`too_many_sheets`，附 `totalSheets/maxSheets`），**不输出任何部分方案**。
- **整单拒绝的其他情形**：快照中某颜色未登记原片（422 `missing_color`）；单片在 0/90/180/270 任一旋转下外接矩形都超出原片（422 `piece_too_large`，附片号/件次/颜色/片外接与原片尺寸）；copies、gap 非法（400）；发布版不存在（404）。
- **库存口径**：`available = stock − 净预留 − 瑕疵隔离量`（净预留 = 所有已确认订单分色预留之和 − 已领出；隔离见“玻璃原片瑕疵隔离规则”）。预览与草稿均不占库存；只有确认才预留。
- **确认与并发**：确认使用 SQLite `BEGIN IMMEDIATE` 写事务，在同一事务内逐色读取已预留总量、核对缺口、置为 confirmed；**任一颜色不足即回滚整单**（返回 409 与每色 `shortages`），绝不留下部分预留；多个订单并发确认也不会超卖。
- **取消幂等**：重复确认返回 409 且不重复预留；取消把已确认订单置为 canceled 并一次性释放全部颜色预留，重复取消返回 409 且不再改库存；草稿未预留时取消返回 409（可直接删除）；已确认订单须先取消才能修改或删除。
- **快照绑定**：订单（及逐张布局 JSON）创建时即绑定发布版本；后续草稿增删改、重新发布都不影响已确认/已存订单。

### 玻璃裁片调用示例（curl）

```bash
# 1) 按颜色登记原片：红色 600×400 mm、库存 8 张（颜色大小写自动归一）
curl -s localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#FF0000","width":600,"height":400,"stock":8}'
# -> {"ok":true,"sheet":{"id":1,"color":"#ff0000","width":600,"height":400,
#                        "stock":8,"reserved":0,"available":8,...}}

# 2) 查询各色库存（reserved=已确认订单预留，available=还可用于新订单）
curl -s localhost:3000/api/glass-sheets

# 3) 排样预览（不落库、不占库存）：发布版 id=1，制作 3 件，片间净距至少 4 mm
curl -s localhost:3000/api/cut-orders/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"copies":3,"gap":4}'
# -> { ok:true, preview:{ publicationId, version, copies, gap,
#      totalSheets, maxSheets:60,
#      colors:[{color,sheetId,sheetWidth,sheetHeight,requiredSheets,
#               stock,reserved,available,shortage}],
#      totalShortage, feasible,
#      layout:{ copies,gap,totalSheets,
#        colors:[{color,sheetWidth,sheetHeight,requiredSheets,
#          sheets:[{index,width,height,placements:[
#            {pieceNo,copy,color,rotation,x,y,width,height,polygon:[[x,y],...]}]}]}]}}}

# 4) 存为草稿订单
curl -s localhost:3000/api/cut-orders -H 'Content-Type: application/json' \
  -d '{"name":"三联窗裁片","publicationId":1,"copies":3,"gap":4}'

# 5) 确认（各色库存都足够才成功；任一色不足整单失败）
curl -s -X POST localhost:3000/api/cut-orders/1/confirm
# 缺口时：409 {"ok":false,"code":"shortage",
#   "shortages":[{"color":"#ff0000","required":6,"available":4,"shortage":2}], ...}

# 6) 取消（一次性释放全部颜色预留；重复取消 409 且不再次改库存）
curl -s -X POST localhost:3000/api/cut-orders/1/cancel

# 7) 仅调整库存张数（颜色/宽高不可改；低于已预留返回 409）
curl -s -X PATCH localhost:3000/api/glass-sheets/1 \
  -H 'Content-Type: application/json' -d '{"stock":12}'
```

非法与整单拒绝示例（均不产生订单或预留）：

```bash
# 宽高越界 / 库存为负 / gap 越界 / 件数非正
curl -s -X POST localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#ff0000","width":2001,"height":400,"stock":1}'            # 400
curl -s -X POST localhost:3000/api/cut-orders/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"copies":1,"gap":51}'                            # 400

# 缺少某颜色的原片登记
# -> 422 {"ok":false,"code":"missing_color","color":"#00ff00", ...}

# 单片任何旋转都放不进原片
# -> 422 {"ok":false,"code":"piece_too_large","color":"#ff0000",
#         "pieceNo":7,"copy":2,"pieceWidth":620,"pieceHeight":410,
#         "sheetWidth":600,"sheetHeight":400}

# 总裁片数超过 60
# -> 422 {"ok":false,"code":"too_many_sheets","totalSheets":61,"maxSheets":60}
```

## 裁片订单换单规则

- **适用对象**：仅 **已确认（confirmed）** 订单可以换单；草稿（请直接修改/删除重建）、已取消、已替换的订单均明确拒绝（409，`order_not_confirmed`/`order_canceled`/`order_replaced`）。
- **目标版本**：换到的必须是**同一图纸的另一已发布版本**——可传 `targetVersion`（该图纸版本号）或 `targetPublicationId`（全局发布版 id）；版本不存在 404（`target_not_found`），不属于同一图纸 400（`different_design`），与旧单当前版本相同 400（`same_version`）。件数、片间距省略时沿用旧单参数，传入则仍按 1–10000 件、0–50 mm 校验。
- **新排样约束不变**：仍按目标发布快照颜色排样，遵守全部几何约束（仅平移/90° 旋转、不镜像、不越板、净距 ≥ gap）与颜色规格；缺色（422 `missing_color`）、单片放不下（422 `piece_too_large`）、总裁片数超 60（422 `too_many_sheets`）都**整单拒绝**。
- **换单预览（只读，不落库、不占库存）**：按颜色列出
  - `oldSheets` 旧单用板数、`requiredSheets` 新排样用板数、`netChange` 净增减；
  - `stock` 库存、`reserved` 当前全部已确认单预留（含旧单自身）；
  - `availableAfter = stock −（reserved − oldSheets）`，即**计入旧单退出预留后的可用量**；
  - `shortage = max(0, requiredSheets − availableAfter)`；另给 `oldTotalSheets/totalSheets/netSheets/totalShortage/feasible` 与新排样逐张布局。仅出现在旧单或新排样其一的颜色也会列出（另一侧按 0 计）。
- **确认（原子事务）**：在一个 `BEGIN IMMEDIATE` 事务内逐色核对——**旧单自身预留视为即将释放、不再占用**，但其他已确认单预留照常；任一颜色 `required > 库存 − 其他已确认预留` 即整单回滚（409 `shortage`，`shortages` 给出每色 `required/available/shortage/oldReserved`），**旧单状态、库存预留、订单记录全部保持原状**。成功则同事务：创建一张 **confirmed** 新单（布局即目标版本快照）、旧单置为 **replaced**（退出预留）、写入换单关联。
- **旧单终态**：`replaced` 旧单的发布快照与逐张排样仍可通过 `GET /api/cut-orders/:id` 查阅（含 `replacedBy.newOrderId`），但不能再取消、修改、删除（均 409 `order_replaced`）。新单为独立 confirmed 订单（含 `replaces.oldOrderId`），可正常取消，也可继续换单形成换单链；其取消不会改变旧单的 `replaced` 终态。
- **幂等与冲突**：对同一旧单以**相同目标版本/件数/片间距**重试确认，直接返回原新单（`idempotent:true`，HTTP 200，不重新排样、不重复预留）；参数不同返回 409 `param_conflict`（附已完成换单的 `current` 参数与 `newOrder`）。多个客户端并发换单由写事务串行化，不会超卖或产生两张新单。
- **网页**：在“玻璃裁片”标签打开一张已确认订单，展开底部 **⇄ 换单** 面板，选择目标版本、件数与片间距后“换单预览”（表格对比旧/新用板、净增减与释放后可用量，并展示新排样逐张示意），库存充足时“确认换单”；订单列表中旧单显示“已替换 · 由 #N 接替”徽章，新单显示“接替 #M”，点击可互相跳转。

### 换单调用示例（curl）

```bash
# 0) 前置：登记原片、确认一张 v1 订单 #7（红/绿各 1 张，共 2 张）
#    改图后发布 v2（右上红片改为蓝色，需红/绿/蓝各 1 张，共 3 张）

# 1) 换单预览（targetVersion 为该图纸版本号；copies/gap 省略则沿用旧单）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement/preview \
  -H 'Content-Type: application/json' \
  -d '{"targetVersion":2,"copies":1,"gap":0}'
# -> { ok:true, preview:{ oldOrderId:7,
#      old:{version:1,totalSheets:2,colors:[{color:"#ff0000",requiredSheets:1}, ...]},
#      target:{publicationId:12,version:2}, copies:1, gap:0,
#      oldTotalSheets:2, totalSheets:3, netSheets:1, totalShortage:0, feasible:true,
#      layout:{...新排样逐张放置...},
#      colors:[
#        {color:"#ff0000",oldSheets:1,requiredSheets:1,netChange:0,
#         stock:3,reserved:1,availableAfter:3,shortage:0},
#        {color:"#00ff00",oldSheets:1,requiredSheets:1,netChange:0, ...},
#        {color:"#0000ff",oldSheets:0,requiredSheets:1,netChange:1,
#         stock:1,reserved:0,availableAfter:1,shortage:0} ] } }
# 也可传全局发布版 id： {"targetPublicationId":12}

# 2) 确认换单（同事务旧单退出预留、新单即确认）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement \
  -H 'Content-Type: application/json' \
  -d '{"targetVersion":2,"copies":1,"gap":0,"name":"改图后新单"}'
# -> 201 { ok:true, idempotent:false,
#      order:{ id:8, status:"confirmed", version:2, totalSheets:3,
#              replaces:{oldOrderId:7,targetPublicationId:12,copies:1,gap:0}, ... },
#      oldOrder:{ id:7, status:"replaced", version:1, replacedAt:"...",
#                 replacedBy:{newOrderId:8,...} } }

# 3) 相同参数重试 → 返回原新单（200, idempotent:true，不重复预留）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement \
  -H 'Content-Type: application/json' -d '{"targetVersion":2}'

# 4) 不同参数重试 → 409 冲突（不产生新单、不重复预留）
# -> 409 {"ok":false,"code":"param_conflict",
#         "requested":{"targetPublicationId":12,"copies":2,"gap":0},
#         "current":{"targetPublicationId":12,"copies":1,"gap":0},
#         "newOrder":{"id":8,...}}

# 5) 旧单终态保护
curl -s -X POST localhost:3000/api/cut-orders/7/cancel     # -> 409 order_replaced
curl -s -X PUT  localhost:3000/api/cut-orders/7 -H 'Content-Type: application/json' -d '{"copies":2}'
#                                                           # -> 409
curl -s -X DELETE localhost:3000/api/cut-orders/7          # -> 409 order_replaced
curl -s localhost:3000/api/cut-orders/7                    # 旧单快照/排样仍可查
```

失败示例（均不改变旧单、库存与订单记录）：

```bash
# 目标版本不存在
curl -s -X POST localhost:3000/api/cut-orders/7/replacement/preview \
  -H 'Content-Type: application/json' -d '{"targetVersion":99}'
# -> 404 {"ok":false,"code":"target_not_found",...}

# 目标版本属于另一张图纸
# -> 400 {"ok":false,"code":"different_design","oldDesignId":3,"targetDesignId":5}

# 新排样出现未登记原片的颜色 / 超过 60 张
# -> 422 {"ok":false,"code":"missing_color","color":"#0000ff"} / {"code":"too_many_sheets",...}

# 计入旧单释放后仍不足（旧单蓝 0、新单需 3，蓝库存为 0）
# -> 409 {"ok":false,"code":"shortage",
#         "shortages":[{"color":"#0000ff","required":3,"available":0,"shortage":3,"oldReserved":0}],
#         "oldOrder":{...仍为 confirmed、version:1...}}
```

## 整套用料单规则（铅条 + 玻璃 一次备齐）

- **用途**：工作室为同一发布图纸同时备齐铅条与玻璃时，一次确认整套用料，避免“铅条已预留、玻璃却不够”的半成状态。
- **入参**：`publicationId`（不可变发布版）、`materialId`（铅条原材规格）、`copies` 件数（正整数，≤10000）、`kerf` 每刀损耗（≥0，精确到 0.01 mm）、`gap` 玻璃片间最小间距（0–50 整数毫米）。铅条切段与玻璃排样**完全沿用各自现有规则**（内部公共边+四框、FFD+刀损；90°旋转/整数平移、不镜像、不越板、净距 ≥ gap，总用板 ≤ 60）。
- **预览只读**：`POST /api/combo-orders/preview` 返回
  - `lead`：原材、`requiredBars` 需用根数、`stockBars/reservedBars/availableBars`、`shortage` 与逐根切段 `layout`；
  - `glass`：分色 `requiredSheets/stock/reserved/available/shortage`、`totalSheets/totalShortage` 与逐张排样 `layout`；
  - 顶层 `leadShortage/totalShortage/feasible`。预览**不落库、不占库存**；几何类整单拒绝（`segment_too_long`/`missing_color`/`piece_too_large`/`too_many_sheets`）状态码与原接口一致。
- **原子确认**：`POST /api/combo-orders` 须额外携带 `requestId`（1–80 个字母/数字/`._:-`）作为**客户端幂等键**。服务端在一个 `BEGIN IMMEDIATE` 事务内：
  1. 铅条原材定尺身份核对、库存核对（`available = stock − 所有已确认计划预留`，含其他独立计划与其他整套单的关联计划）；
  2. 玻璃逐色规格身份核对、库存核对（`available = stock − 所有已确认订单分色预留`，含独立订单与其他整套单的关联订单）；
  3. **任一不足 → 回滚**：409 `shortage`，`lead:{required,available,shortage}` 与 `shortages:[{color,required,available,shortage}]`，两类库存与任何记录保持原状，绝不留下半套预留；
  4. 充足 → 同事务插入一张**已确认关联生产计划**、一张**已确认关联裁片订单**（含分色项）与整套单记录并互相回填 id，原子提交。
- **幂等与并发**：同一 `requestId` 重试返回原整套单（200，`idempotent:true`，不重新排样、不重复预留）；同一 `requestId` 但版本/原材/件数/刀损/间距不同 → 409 `request_conflict`（附首次提交的 `current` 参数）。并发确认由写事务串行化，铅条根数与各色张数**均不超卖**。
- **取消（各释放一次）**：`POST /api/combo-orders/:id/cancel` 在一个事务内把关联计划与关联订单同时置为 `canceled`：铅条预留随计划状态释放、各色玻璃预留随订单状态释放（复用既有库存口径，状态机保证各计一次）；重复取消返回 409 且库存不重复变化。取消后关联单记录保留可查，仍不可删除。
- **关联单保护（防状态分叉）**：关联计划与关联订单只能随整套单确认/取消：
  - 铅条侧：`PUT/DELETE /api/plans/:id`、`POST /api/plans/:id/confirm|cancel` 一律 409 `combo_locked`；
  - 玻璃侧：`PUT/DELETE /api/cut-orders/:id`、`POST /api/cut-orders/:id/confirm|cancel`、`.../replacement` 与 `.../replacement/preview` 一律 409 `combo_locked`；
  - 只读接口 `GET /api/plans/:id`、`GET /api/cut-orders/:id` 照常，返回体新增 `comboId`/`comboLocked`（独立单为 `null`/`false`）。
- **快照绑定**：整套单及其两个关联单均绑定同一 `publicationId`；草稿改动、再发布均不影响已确认用料。
- **独立入口不受影响**：原有独立生产计划、独立裁片订单与换单的全部接口、网页与库存口径保持不变；两类库存视图（`/api/materials`、`/api/glass-sheets`）的 `reserved/available` 已自动把整套单的关联预留计入。

### 整套用料单调用示例（curl）

```bash
# 0) 前置：登记铅条原材与各色玻璃原片（沿用原接口）
curl -s localhost:3000/api/materials -H 'Content-Type: application/json' \
  -d '{"name":"6m 通用铅条","length":6000,"stock":10}'
curl -s localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#ff0000","width":600,"height":400,"stock":8}'
curl -s localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#00ff00","width":600,"height":400,"stock":4}'

# 1) 整套预览（不落库、不占库存）
curl -s localhost:3000/api/combo-orders/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"materialId":1,"copies":2,"kerf":0.5,"gap":4}'
# -> { ok:true, preview:{
#      publicationId, version, copies, kerf, gap,
#      lead:{ material:{...}, requiredBars:1, stockBars:10, reservedBars:0,
#             availableBars:10, shortage:0, layout:{bars:[...]} },
#      glass:{ totalSheets:4, maxSheets:60, totalShortage:0,
#              colors:[{color:"#ff0000",requiredSheets:2,stock,reserved,available,shortage:0},
#                      {color:"#00ff00",requiredSheets:2,...}], layout:{colors:[...]} },
#      leadShortage:0, totalShortage:0, feasible:true } }

# 2) 确认整套单（同事务预留两类库存；requestId 用于网络重试幂等）
curl -s localhost:3000/api/combo-orders -H 'Content-Type: application/json' \
  -d '{"name":"三联窗整套","publicationId":1,"materialId":1,
       "copies":2,"kerf":0.5,"gap":4,"requestId":"order-20261003-0001"}'
# -> 201 { ok:true, idempotent:false, combo:{
#      id:1, status:"confirmed", version:1, copies:2, kerf:0.5, gap:4,
#      requiredBars:1, totalSheets:4,
#      leadPlanId:10, cutOrderId:11, snapshotBound:true,
#      leadPlan:{ id:10, status:"confirmed", comboId:1, ... },
#      cutOrder:{ id:11, status:"confirmed", comboId:1, ... } } }

# 3) 网络重试 / 重复确认：相同 requestId 返回原单（不重复预留）
curl -s localhost:3000/api/combo-orders -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"materialId":1,"copies":2,"kerf":0.5,"gap":4,
       "requestId":"order-20261003-0001"}'
# -> 200 { ok:true, idempotent:true, combo:{ id:1, ... } }

# 4) 查询整套单列表 / 详情
curl -s localhost:3000/api/combo-orders
curl -s localhost:3000/api/combo-orders/1

# 5) 取消整套单：两个关联单同时取消，铅条与玻璃预留各释放一次
curl -s -X POST localhost:3000/api/combo-orders/1/cancel
# -> { ok:true, combo:{ status:"canceled", leadPlan:{status:"canceled"}, cutOrder:{status:"canceled"} } }
curl -s -X POST localhost:3000/api/combo-orders/1/cancel
# -> 409 整套单已取消…未重复变更库存
```

失败与锁定示例（库存与记录均保持原状）：

```bash
# 缺少幂等键
# -> 400 {"ok":false,"error":"requestId 必填：…"}

# 铅条或玻璃不足（绿色可用 0、需 2 张）
# -> 409 {"ok":false,"code":"shortage",
#         "lead":{"required":1,"available":10,"shortage":0},
#         "shortages":[{"color":"#00ff00","required":2,"available":0,"shortage":1}]}

# 同一 requestId 不同参数
# -> 409 {"ok":false,"code":"request_conflict","comboId":1,
#         "current":{"publicationId":1,"materialId":1,"copies":2,"kerf":0.5,"gap":4}}

# 从原入口操作关联单（计划 #10 / 订单 #11 属于整套 #1）
curl -s -X POST localhost:3000/api/plans/10/cancel
# -> 409 {"ok":false,"code":"combo_locked","comboId":1,
#         "error":"该计划属于整套用料单 #1，取消整套单时会一并释放铅条预留，不能单独取消"}
curl -s -X POST localhost:3000/api/cut-orders/11/replacement/preview \
  -H 'Content-Type: application/json' -d '{"targetVersion":2}'
# -> 409 {"ok":false,"code":"combo_locked","comboId":1,...}
# 只读详情仍可查：GET /api/plans/10、GET /api/cut-orders/11（comboId:1）
```

## 跨图纸拼片复用规则（已发布快照 → 目标草稿）

- **来源与选片**：来源必须是**已发布版本**（不可变快照），可传全局 `publicationId`，或传 `sourceDesignId` + `sourceVersion`（版本号属于来源图纸）；来源图纸与目标图纸可以不同，也允许是同一张图纸。`pieceNos` 为来源快照中的**拼片编号**数组，**至少 1 片、编号不得重复**（单次最多 500 片）；导入颜色直接取自快照，**确认时保留原色**。
- **变换（整批统一）**：先绕**来源图纸的坐标原点 (0,0)** 逆时针旋转 `rotation ∈ {0,90,180,270}`（与玻璃裁片排样同方向、不镜像），再做整数毫米平移 `(dx,dy)`（−1,000,000–1,000,000 mm）。变换逐顶点进行，结果顶点仍是整数毫米；刚体变换保持面积与简单多边形性，无需也不会改变形状。
- **逐片几何校验（预览与确认同一套口径）**：
  - 转换后轮廓必须仍是**合法简单多边形**（理论上刚体变换恒满足，仍严格复核）；
  - 所有顶点必须落在目标窗框 `[0,width]×[0,height]` 内（`out_of_frame`，附越界顶点）；
  - 与目标草稿**已有拼片**及本批其他片**不得面积重叠**（边交叉、顶点穿入、共边同侧重叠、顶点内角相交均拒绝）；**合法共边、T 接（一侧整边/另一侧数段）、顶点相接允许**（`overlap`，附冲突点及冲突对象 `withKind: existing|import` 与 `withPieceNo`）。
  - 多个问题会**逐片全部返回**；有任一问题即整单拒绝，**不写入任何拼片**。
- **预览即固化基准（不写拼片）**：`POST /api/designs/:id/imports/preview` 会生成一张 `pending` 预览记录，保存逐片转换结果与当时目标草稿的**指纹**（对全部草稿片的编号/颜色/顶点做摘要）。响应给出 `targetDraft`（预览前片数与覆盖状态）与 `simulated`（导入后片数与**模拟覆盖状态**：缺口/重叠按现有分析口径计算），但**草稿拼片表不变**。
- **确认（同事务重核，整批写入/整批拒绝）**：`POST .../imports/:importId/confirm` 在一个 `BEGIN IMMEDIATE` 写事务内依次核对：预览存在且属于该图纸、仍为 `pending`、目标图纸存在、**当前草稿指纹与预览基准一致**、并对当前草稿**重放全部几何校验**；全部通过才按选片顺序整批插入，**编号沿目标图纸现有最大片号继续递增（永不复用）**，颜色沿用来源原色，同事务刷新图纸时间并把预览置为 `confirmed`。
  - 预览后草稿被新增/编辑/删除任一片 → **409 `draft_changed`，整批不写入**，请重新预览；
  - 重放几何不通过（例如同一张待确认预览之外草稿又变了）→ 422 `geometry_conflict`；
  - 重复确认同一张预览 → **409 `already_confirmed`**（返回原记录与当时写入的 `confirmedPieces`，不重复写片）；已确认记录永久保留、不可删除。
- **不变项**：来源发布快照不变；铅条计划、裁片订单（含换单链）、整套用料单、盘点单、领料与库存台账**完全不受影响**；导入的只是目标**草稿**片，后续覆盖检查、铅条清单与是否可发布全部走现有草稿规则；原有单片 `POST/PUT/DELETE` 与发布接口继续可用。

### 跨图纸拼片复用调用示例（curl）

```bash
# 0) 前置：图纸 #1 已发布 v1（100×100，4 片各 50×50）；图纸 #2（100×100）是待编辑的目标草稿

# 1) 定位预览：从图纸 #1 的 v1 选 #1、#4，绕源原点旋转 180° 再平移 (100,100)（落库但不写拼片）
curl -s -X POST localhost:3000/api/designs/2/imports/preview \
  -H 'Content-Type: application/json' \
  -d '{"sourceDesignId":1,"sourceVersion":1,"pieceNos":[1,4],
       "rotation":180,"dx":100,"dy":100}'
# -> 201 { ok:true, preview:{
#      id:3, status:"pending",
#      target:{designId:2,width:100,height:100},
#      source:{publicationId:7,designId:1,designName:"源图纸",version:1},
#      selection:[1,4], rotation:180, dx:100, dy:100, draftToken:"...",
#      items:[
#        {index:1, sourcePieceNo:1, color:"#ff0000", rotation:180, dx:100, dy:100,
#         polygon:[[100,100],[50,100],[50,50],[100,50]],
#         bounds:{minX:50,minY:50,maxX:100,maxY:100,width:50,height:50}, area:2500},
#        {index:2, sourcePieceNo:4, color:"#ffff00", ...,
#         bounds:{minX:0,minY:0,maxX:50,maxY:50,...} }],
#      targetDraft:{pieceCount:0, coverage:{covered:false,gaps:[...],...}},
#      simulated:{pieceCount:2, coverage:{covered:false, gaps:[...], overlapping:[]}} } }

# 也可直接用全局发布版 id：{"publicationId":7,"pieceNos":[1,4],"rotation":180,"dx":100,"dy":100}

# 2) 确认整批导入（同事务核对草稿指纹 + 几何，通过才写片）
curl -s -X POST localhost:3000/api/designs/2/imports/3/confirm
# -> 201 { ok:true,
#      pieceImport:{id:3,status:"confirmed",confirmedAt:"...",
#                   confirmedPieces:[...]},
#      addedPieces:[
#        {pieceNo:1, sourcePieceNo:1, color:"#ff0000", polygon:[[100,100],[50,100],[50,50],[100,50]]},
#        {pieceNo:2, sourcePieceNo:4, color:"#ffff00", polygon:[[0,0],[50,0],[50,50],[0,50]]}],
#      draft:{...目标草稿最新汇总（覆盖状态/缺口/铅条清单）...} }

# 3) 待确认预览列表 / 单个（stale=true 表示预览后草稿已被编辑）/ 删除待确认预览
curl -s 'localhost:3000/api/designs/2/imports?status=pending'
curl -s localhost:3000/api/designs/2/imports/3
curl -s -X DELETE localhost:3000/api/designs/2/imports/3
```

失败示例（均不写入拼片、不影响源快照/生产单/库存）：

```bash
# 未选片 / 编号重复 / 旋转角非法 / 平移非整数 → 400
curl -s -X POST localhost:3000/api/designs/2/imports/preview \
  -H 'Content-Type: application/json' -d '{"publicationId":7,"pieceNos":[1,1],"rotation":0}'
# -> 400 {"ok":false,"error":"拼片编号 #1 重复，一次导入中每片只能选一次"}

# 来源发布版不存在 / 来源图纸的版本不存在 → 404 source_not_found
# -> 404 {"ok":false,"code":"source_not_found", ...}

# 来源片号不存在（逐号列出），且不产生预览记录
curl -s -X POST localhost:3000/api/designs/2/imports/preview \
  -H 'Content-Type: application/json' -d '{"publicationId":7,"pieceNos":[1,99],"rotation":0}'
# -> 404 {"ok":false,"code":"source_piece_not_found","missing":[99],
#         "source":{"publicationId":7,"designId":1,"version":1}}

# 转换后越界 / 与目标已有片或本批片面积重叠 → 422，逐片指出对象与位置
# -> 422 {"ok":false,"code":"geometry_conflict","problems":[
#      {"index":1,"sourcePieceNo":1,"reason":"out_of_frame",
#       "reasonText":"转换后的拼片超出目标窗框","at":[80,0],"frame":{"width":50,"height":50}},
#      {"index":2,"sourcePieceNo":3,"reason":"overlap",
#       "reasonText":"与现有拼片面积重叠（顶点穿入）","at":[50,60],
#       "withKind":"existing","withPieceNo":2}]}

# 预览后目标草稿被编辑过（任意单片增删改）再确认
# -> 409 {"ok":false,"code":"draft_changed",
#         "error":"目标草稿在预览后已被编辑（新增/修改/删除拼片），请重新预览后再确认；整批未写入"}

# 同一张预览重复确认 / 删除已确认记录
# -> 409 {"ok":false,"code":"already_confirmed", ...} / 409 已确认的复用记录永久保留，不能删除
```

## 库存盘点规则（铅条 + 玻璃 同一张盘点单）

- **盘点对象**：在**同一张盘点单**中任选若干已登记规格——`type:"lead"` 为铅条原材（`specId` 为铅条规格 id），`type:"glass"` 为玻璃原片（`specId` 为颜色原片 id）。逐项录入**实盘总数 `counted`**：非负整数；同类型规格在一张单内**不得重复**（铅条与玻璃分开去重）。空单、负数、小数、非法类型一律 400；规格不存在 404。
- **预览（建草稿、固化基准、不改库存）**：`POST /api/stocktakes/preview` 立即生成一张 **draft** 盘点单并逐项固化预览当时的基准值：
  - `stock` 系统库存（原值基准）、`reserved` **全部已确认单预留**（独立计划/订单与整套关联单同一口径，按状态计）；
  - `diff = counted − stock`（正为盘盈、负为盘亏）；
  - `availableAfterCount = counted − reserved`（**实盘后可用量**）。
  - 预览**不改动库存**；另有实时口径 `currentStock/currentReserved/currentAvailable` 供页面提示基准是否已漂移。
- **草稿维护**：`PUT /api/stocktakes/:id` 可重选规格/改实盘数并**按当前库存重新固化基准**（仅草稿）；`DELETE` 仅可删除草稿。
- **确认（同事务重核、整单生效/整单拒绝）**：`POST /api/stocktakes/:id/confirm` 在一个 `BEGIN IMMEDIATE` 事务内对**所有项**重核，按以下顺序判定（每项给出主原因）：
  1. `spec_missing` 规格已不存在；
  2. `spec_changed` 规格身份与预览基准不一致（铅条定尺变化、玻璃宽高变化）；
  3. `stock_changed` 当前系统库存 ≠ 预览基准（预览后库存被调整/被其他盘点改动）；
  4. `reserved_changed` 当前已确认预留 ≠ 预览基准（预览后有计划/订单/整套单确认或取消）；
  5. `below_reserved` 实盘总数 < 当前已确认预留（不能使预留超出现货）。

  任一项不符即 **409 `baseline_mismatch`**，`items[]` 返回**全部问题项**及基准值/当前值/实盘值与中文原因，**整单不生效、库存一律不变**；全部通过才在同一事务内**一次更新所有选中规格的库存**，并记录确认时间。
- **幂等**：已确认盘点单重复提交确认 → **200 `idempotent:true` 返回同一记录，不再调整库存**（即使此后库存又变化）。已确认单不可修改/删除，原值、实盘值与确认时间永久保留。
- **盘点后的业务口径**：独立铅条计划、独立裁片订单（含换单）与整套用料单的确认/取消**继续按盘点后库存**计算 `available = stock − 已确认预留`（盘点本身不触碰任何预留/订单记录）；并发盘点与并发确认单由写事务串行化，库存不会被双重调整。
- **原有库存调整入口**：`PATCH /api/materials/:id` 与 `PATCH /api/glass-sheets/:id` 继续可用；若在盘点预览之后经这些入口改动了库存/预留，旧预览确认时会因基准不符被整单拒绝（重新预览刷新基准即可）。

### 库存盘点调用示例（curl）

```bash
# 0) 前置：已登记铅条原材 #1（库存 10 根）、红色玻璃原片 #1（600×400，库存 5 张）

# 1) 预览：同一张单盘点 铅条 #1 实盘 7 根、红色玻璃 #1 实盘 4 张（不改库存）
curl -s localhost:3000/api/stocktakes/preview -H 'Content-Type: application/json' \
  -d '{"name":"三月盘点","items":[
        {"type":"lead","specId":1,"counted":7},
        {"type":"glass","specId":1,"counted":4}]}'
# -> 201 { ok:true, stocktake:{ id:1, status:"draft", itemCount:2, leadCount:1, glassCount:1,
#      items:[
#        {type:"lead", specId:1, name:"6m", stock:10, reserved:0, counted:7,
#         diff:-3, availableAfterCount:7, currentStock:10, currentReserved:0, ...},
#        {type:"glass", specId:1, color:"#ff0000", width:600, height:400,
#         stock:5, reserved:0, counted:4, diff:-1, availableAfterCount:4, ...} ] } }

# 2) 预览后若想改项/改实盘数：PUT 草稿（按当前库存重新固化基准）
curl -s -X PUT localhost:3000/api/stocktakes/1 -H 'Content-Type: application/json' \
  -d '{"items":[{"type":"lead","specId":1,"counted":8},{"type":"glass","specId":1,"counted":4}]}'

# 3) 确认：同事务重核全部项，通过才一次更新库存
curl -s -X POST localhost:3000/api/stocktakes/1/confirm
# -> 200 { ok:true, idempotent:false, stocktake:{ status:"confirmed", confirmedAt:"...", ... } }
#    此后 GET /api/materials/1 库存=7（示例按第 1 步的 7），GET /api/glass-sheets/1 库存=4

# 4) 已确认单重复提交：返回同一记录，不再调整库存
curl -s -X POST localhost:3000/api/stocktakes/1/confirm
# -> 200 { ok:true, idempotent:true, message:"该盘点单此前已确认…", stocktake:{ id:1, ... } }

# 5) 列表 / 详情（网页“库存盘点”标签同样可查）
curl -s localhost:3000/api/stocktakes
curl -s localhost:3000/api/stocktakes/1
```

确认失败示例（库存均保持原状）：

```bash
# 预览后库存被其他操作调整（或有计划/订单确认取消导致预留变化）
# -> 409 {"ok":false,"code":"baseline_mismatch",
#         "items":[{"type":"lead","typeName":"铅条原材","specId":1,"name":"6m",
#                   "reason":"stock_changed","reasonText":"系统库存与预览基准不符",
#                   "baselineStock":10,"currentStock":9,
#                   "baselineReserved":0,"currentReserved":0,"countedStock":7}],
#         "stocktake":{...仍为 draft...}}

# 实盘数低于当前已确认预留（如已确认计划预留 5 根，实盘只点到 3 根）
# -> 409 {"ok":false,"code":"baseline_mismatch",
#         "items":[{"type":"lead","reason":"below_reserved","reasonText":"实盘数低于当前预留",
#                   "baselineStock":10,"currentStock":10,
#                   "baselineReserved":5,"currentReserved":5,"countedStock":3}]}

# 同单重复规格 / 实盘为负或小数 / 空单
# -> 400 {"ok":false,"code":"duplicate_spec", ...} / 400 {"ok":false,"error":"实盘总数必须是不小于 0 的整数"}

# 已确认单修改或删除
# -> 409 {"ok":false,"code":"already_confirmed",...} / 409 已确认盘点单为永久记录，不能删除
```

## 分次领料规则（独立计划 / 独立裁片订单 / 整套单）

- **可领对象**：仅 **confirmed** 状态的独立铅条计划、独立裁片订单、整套用料单。草稿、已取消、已替换（replaced）均拒绝；整套单的关联计划/订单必须走 `/api/combo-orders/:id/issues`，从独立入口提交返回 409 `issue_use_combo`。
- **入参**：
  - 统一入口 `POST /api/issues`：`{issueNo, sourceType:'lead_plan'|'cut_order'|'combo', planId|orderId|comboId, leadBars?, sheets?}`（也可省略 `sourceType`，由 `planId/orderId/comboId` 推断）；
  - 便捷入口：`POST /api/plans/:id/issues`、`POST /api/cut-orders/:id/issues`、`POST /api/combo-orders/:id/issues`，路径即来源，只需 `{issueNo, leadBars?, sheets?}`；
  - `issueNo`：1–80 个字母/数字/汉字/`._:-`，由调用方保证唯一；
  - `leadBars`：本次铅条根数（非负整数）；`sheets`：`[{sheetId, count}]` 或 `[{color:"#rrggbb", count}]`，各色本次张数（非负整数）。两者**至少一项大于 0**，数量 0 的项允许（整套单可只领一类）。
- **同事务校验与扣减**：`BEGIN IMMEDIATE` 内依次校验：单据存在且为 confirmed；本次每项 ≤ 该单**尚未领出的余留**（计划 `requiredBars − pickedBars`；订单逐色 `requiredSheets − pickedSheets`）；颜色必须属于该裁片订单；实物库存足以发放。随后**扣减 `lead_materials.stock` / `glass_sheets.stock` 并追加不可变领料行**（一次领料同号多行）。任一项不合法 → 409 `invalid_issue`，`problems[]` 给出每项原因（`over_remaining`/`physical_shortage`/`sheet_not_in_order`/`no_lead_in_source`/`no_glass_in_source`）与余留/本次数量，**整次不生效、库存与记录均不变**。
- **净预留口径（结转）**：领料后 `grossReserved`（已确认预留总量）不变、`picked`（已领）增加，故 `reserved = grossReserved − picked` 为**尚未领出的净预留**，`available = stock − reserved`。新确认/取消/盘点/手工调库全部按此口径：领料既不超卖，也不改变其他单据可再预留的数量；`PATCH` 库存不得低于净预留；盘点实盘数不得低于净预留。
- **幂等与冲突**：同一 `issueNo` 内容一致重试 → 200 `idempotent:true` 返回原记录（不再次扣减）；内容不同（来源/铅条数/各色张数不同）→ 409 `issue_no_conflict`，附首次提交的 `existing` 内容。领料记录**只追加**，不可修改、取消或删除。
- **终态**：有领料记录的独立计划/独立订单/整套单**不能取消**（409 `already_issued`）；有领料记录的独立裁片订单**不能换单**（预览与确认均 409 `already_issued`）。未领料单据行为完全不变（可取消、可换单）。
- **查询**：`GET /api/issues` 全部历史（可 `?source=` 过滤）；`GET /api/issues/:issueNo` 单号详情；三个按单据的 GET 返回净预留汇总（含实物库存）与该单历史。`GET /api/plans`、`/api/cut-orders`、`/api/combo-orders` 及两个库存视图的原字段保持可用，并新增 `pickedBars/remainingBars/issueCount`（铅条）、`pickedSheets/remainingSheets/issueCount`（玻璃）与库存的 `grossReserved/picked/remainingReserved`。

### 分次领料调用示例（curl）

```bash
# 0) 前置：登记库存、发布 v1、确认独立铅条计划 #5（需 3 根）、
#    独立裁片订单 #8（红/绿各 1 张）、整套用料单 #2（关联计划 #9/订单 #10）

# 1) 独立铅条计划分次领料：本次领 2 根（便捷入口）
curl -s -X POST localhost:3000/api/plans/5/issues \
  -H 'Content-Type: application/json' -d '{"issueNo":"LL-20261004-001","leadBars":2}'
# -> 201 { ok:true, idempotent:false, issue:{
#      issueNo:"LL-20261004-001", sourceType:"lead_plan", planId:5,
#      thisTime:{leadBars:2, glass:[]},
#      lead:{ materialId:1, requiredBars:3, thisBars:2,
#             pickedBars:2, remainingBars:1, stockBars:8 } } }

# 2) 独立裁片订单领料：按色（可用 sheetId 或 color；只领红 1 张，绿本次 0）
curl -s -X POST localhost:3000/api/cut-orders/8/issues \
  -H 'Content-Type: application/json' \
  -d '{"issueNo":"GL-20261004-001","sheets":[{"color":"#ff0000","count":1},{"sheetId":2,"count":0}]}'
# -> issue.glass.colors:[{color:"#ff0000",requiredSheets:1,thisSheets:1,pickedSheets:1,remainingSheets:0,stockSheets:4},
#                        {color:"#00ff00",requiredSheets:1,thisSheets:0,pickedSheets:0,remainingSheets:1,stockSheets:5}]

# 3) 整套单：本次只领铅条 1 根（允许只领一类）；下次再只领玻璃
curl -s -X POST localhost:3000/api/combo-orders/2/issues \
  -H 'Content-Type: application/json' -d '{"issueNo":"CB-001","leadBars":1}'
curl -s -X POST localhost:3000/api/combo-orders/2/issues \
  -H 'Content-Type: application/json' -d '{"issueNo":"CB-002","sheets":[{"sheetId":1,"count":1}]}'
# 一次同领两类也可以：'{"issueNo":"CB-003","leadBars":1,"sheets":[{"sheetId":2,"count":1}]}'

# 4) 统一入口（等价写法；sourceType 也可由 planId/orderId/comboId 推断）
curl -s -X POST localhost:3000/api/issues -H 'Content-Type: application/json' \
  -d '{"issueNo":"LL-20261004-002","sourceType":"lead_plan","planId":5,"leadBars":1}'

# 5) 网络重试：同号同内容返回原记录（200, idempotent:true，不再次扣库存）
curl -s -X POST localhost:3000/api/plans/5/issues \
  -H 'Content-Type: application/json' -d '{"issueNo":"LL-20261004-001","leadBars":2}'
# 同号不同内容 → 409
# -> {"ok":false,"code":"issue_no_conflict","issueNo":"LL-20261004-001",
#     "existing":{"sourceType":"lead_plan","planId":5,"leadBars":2,"glass":[]}}

# 6) 查询：全部历史 / 按来源筛选 / 按单号 / 按单据净预留与历史
curl -s localhost:3000/api/issues
curl -s 'localhost:3000/api/issues?source=combo'
curl -s localhost:3000/api/issues/LL-20261004-001
curl -s localhost:3000/api/plans/5/issues
curl -s localhost:3000/api/cut-orders/8/issues
curl -s localhost:3000/api/combo-orders/2/issues
# -> { lead:{requiredBars,pickedBars,remainingBars,stockBars},
#      glass:{totalRequired,totalPicked,totalRemaining,colors:[...]},
#      issues:[{issueNo,sourceType,leadBars,glass:[...],issuedAt}] }
```

非法与终态示例（库存与记录均保持原状）：

```bash
# 缺领料号 / 数量为负或小数 / 全部为 0 / 无来源 → 400
# 超过该单剩余预留（计划还剩 1 根却领 2）→ 409
# -> {"ok":false,"code":"invalid_issue",
#     "problems":[{"kind":"lead","reason":"over_remaining",
#                  "required":3,"picked":2,"remaining":1,"requested":2,...}]}
# 颜色不在该裁片订单内 / 实物库存不足 → 409（sheet_not_in_order / physical_shortage）
# 从独立入口领整套关联单 → 409 {"code":"issue_use_combo","comboId":2}
# 已领料计划取消 / 已领料订单取消或换单 → 409 {"code":"already_issued",...}
# 未知领料号查询 → 404
```

## 玻璃原片瑕疵隔离规则（隔离 / 解除隔离，实物库存不变）

- **用途**：工作室发现玻璃原片有瑕疵（气泡、结石、崩边等）时，把对应张数**隔离封存**，使其不再参与新裁片订单与整套单的可用量；复检合格可**解除隔离**恢复可用。**实物库存 `stock` 不因隔离变化**——隔离只增减各色隔离余额 `quarantined`，实际可用量 = `stock − 净预留（reserved）− quarantined`。
- **入参**：`POST /api/glass-quarantines`
  - `opNo` 唯一操作号：1–80 个字母/数字/汉字/`._:-`，由调用方保证唯一；
  - `action`：`hold`（隔离）或 `release`（解除隔离）；
  - `reason`：非空原因（trim 后 1–200 字）；
  - `items`：至少一项、同次不得重复颜色，每项 `{sheetId, count}` 或 `{color:"#rrggbb", count}`，`count` 必须是**正整数**。
- **划出上限（事务内逐色重核）**：
  - `hold`：本次数量 ≤ `stock − 净预留 − 已隔离`，即只能划出**当前未预留且未隔离**的实物（已被已确认单据预留的实物即使尚未领出也不能隔离，保证已确认单据仍可按原预留领料）；
  - `release`：本次数量 ≤ 该色**隔离余额**。
- **整次不生效**：未知/未登记颜色（404 `color_not_registered`/`sheet_not_found`）、数量非正整数、空原因、缺/非法操作号、非法动作、同色重复（400）、或任一颜色可隔离量/隔离余额不足（409 `shortage`，`problems[]` 逐色给出 `stock/reserved/quarantined/available/requested/shortage`），都**整次回滚**，不写任何隔离记录、不改台账。
- **库存联动口径**：裁片订单确认、裁片换单、整套单确认的可用量均扣除 `quarantined`；领料时实物库存必须足以覆盖**净预留 + 隔离量**（已确认单据仍按原预留领料，隔离张不会被发走）；手工 `PATCH /api/glass-sheets/:id` 库存不得低于 `净预留 + 隔离量`；盘点预览固化隔离基准，确认时隔离量已漂移返回 409 `quarantined_changed`，实盘数低于 `净预留 + 隔离量` 返回 409 `below_reserved`。
- **不可变与台账**：隔离主记录与分色明细（记录各色当次张数与**笔后隔离余额**）只追加、不可改、不可删；每次操作在**同一事务**写台账 `quarantine_hold`（`deltaQuarantined:+n`）或 `quarantine_release`（`deltaQuarantined:-n`），实物与净预留增减为 0，玻璃台账另附 `deltaQuarantined/balanceQuarantined` 两列，逐笔满足“上笔余额 + 本笔增减 = 本笔余额”。
- **幂等与冲突**：同一 `opNo` 同内容（动作、原因、各色数量完全一致，与颜色顺序无关）重试 → 200 `idempotent:true` 返回原记录，不重复变更；任一字段不同（`action`、`reason`、颜色集合或对应数量）→ 409 `op_no_conflict`，响应中的 `existing` 附首次记录的 `id/opNo/action/reason/colors/items`（分色数量及笔后隔离余额）。冲突请求只读取历史记录，**不改变隔离量，也不追加台账流水**。
- **查询**：
  - `GET /api/glass-quarantines`：全部历史（倒序），可 `?sheetId=N`、`?color=%23rrggbb` 过滤，或 `?opNo=...` 按操作号精确查；
  - `GET /api/glass-quarantines/:id`：单条记录及分色明细；操作号/记录不存在 404，非法筛选 400；
  - `GET /api/glass-sheets` 各色视图保持 `stock`（实物库存）与 `reserved`（净预留）原含义，新增 `quarantined`（隔离余额），`available = stock − reserved − quarantined`（实际可用量）。

### 玻璃原片瑕疵隔离调用示例（curl）

```bash
# 0) 前置：红色原片 #1（600×400，实物 10 张）、绿色原片 #2（600×400，实物 8 张）
curl -s localhost:3000/api/glass-sheets
# -> {"ok":true,"sheets":[
#      {"id":1,"color":"#ff0000","width":600,"height":400,"stock":10,
#       "reserved":0,"quarantined":0,"available":10,"grossReserved":0,"picked":0,...},
#      {"id":2,"color":"#00ff00",...,"stock":8,"reserved":0,"quarantined":0,"available":8,...}]}

# 1) 一次隔离两种颜色（红 2 张、绿 1 张），正整数张数 + 非空原因 + 唯一操作号
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-001","action":"hold","reason":"边角气泡、结石",
       "items":[{"color":"#ff0000","count":2},{"sheetId":2,"count":1}]}'
# -> 201 {"ok":true,"idempotent":false,"quarantine":{
#      "id":1,"opNo":"Q-20261005-001","action":"hold","actionText":"隔离","reason":"边角气泡、结石",
#      "items":[
#        {"sheetId":1,"color":"#ff0000","count":2,"balanceQuarantined":2,"stock":10,"reserved":0,"available":8},
#        {"sheetId":2,"color":"#00ff00","count":1,"balanceQuarantined":1,"stock":8,"reserved":0,"available":7}]}}

# 2) 实物库存不变；红 10 张仍在库，但实际可用量只剩 8 张（新裁片订单/整套单按此扣减）
curl -s localhost:3000/api/glass-sheets/1
# -> {"ok":true,"sheet":{"id":1,"color":"#ff0000","stock":10,
#                         "reserved":0,"quarantined":2,"available":8,...}}

# 3) 解除隔离 1 张（不得超过隔离余额）
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-002","action":"release","reason":"复检合格放行",
       "items":[{"color":"#00ff00","count":1}]}'

# 4) 网络重试：同操作号同内容（颜色顺序不同也算同内容）→ 返回原记录，不重复变更
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-001","action":"hold","reason":"边角气泡、结石",
       "items":[{"sheetId":2,"count":1},{"color":"#ff0000","count":2}]}'
# -> 200 {"ok":true,"idempotent":true,"quarantine":{"id":1,...}}

# 5) 同一操作号但 action / reason / 任一颜色或数量不同 → 409；返回已记录内容，且不改隔离量、不写台账
curl -i localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-001","action":"hold","reason":"复检后仍有气泡",
       "items":[{"color":"#ff0000","count":2},{"sheetId":2,"count":1}]}'
# -> HTTP/1.1 409 Conflict
# {"ok":false,"code":"op_no_conflict","opNo":"Q-20261005-001",
#  "existing":{"id":1,"opNo":"Q-20261005-001","action":"hold","actionText":"隔离",
#              "reason":"边角气泡、结石",
#              "colors":[{"sheetId":1,"count":2},{"sheetId":2,"count":1}],
#              "items":[{"sheetId":1,"color":"#ff0000","count":2,"balanceQuarantined":2},
#                       {"sheetId":2,"color":"#00ff00","count":1,"balanceQuarantined":1}]}}
# 下面两种也同样返回 409：action 改为 release，或红色数量改为 1/换成别的颜色
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-001","action":"release","reason":"边角气泡、结石",
       "items":[{"color":"#ff0000","count":2},{"sheetId":2,"count":1}]}'
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-20261005-001","action":"hold","reason":"边角气泡、结石",
       "items":[{"color":"#ff0000","count":1},{"sheetId":2,"count":1}]}'

# 6) 隔离/解除历史：全部、按颜色、按操作号、按记录 id
curl -s localhost:3000/api/glass-quarantines
curl -s 'localhost:3000/api/glass-quarantines?color=%23ff0000'
curl -s 'localhost:3000/api/glass-quarantines?sheetId=2'
curl -s 'localhost:3000/api/glass-quarantines?opNo=Q-20261005-001'
curl -s localhost:3000/api/glass-quarantines/1
# 台账中可查隔离增减与笔后余额（玻璃另含隔离两列）
curl -s 'localhost:3000/api/ledger?type=glass&specId=1'
# -> entries 含 {"eventType":"quarantine_hold","deltaStock":0,"deltaReserved":0,
#                "deltaQuarantined":2,"balanceStock":10,"balanceReserved":0,"balanceQuarantined":2,...}
```

非法与整次失败示例（均不写记录、不改隔离量与台账）：

```bash
# 未知颜色 / 未登记规格 → 404
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-X1","action":"hold","reason":"x","items":[{"color":"#123456","count":1}]}'
# -> 404 {"ok":false,"code":"color_not_registered","color":"#123456",...}

# 数量非正整数 / 空原因 / 缺操作号 / 同色重复 → 400
curl -s localhost:3000/api/glass-quarantines -H 'Content-Type: application/json' \
  -d '{"opNo":"Q-X2","action":"hold","reason":"x","items":[{"color":"#ff0000","count":0}]}'
# -> 400 各色张数必须是正整数（≥1）

# 可隔离量不足（红：实物 10 − 净预留 0 − 已隔离 2 = 8，却要隔离 9）
# -> 409 {"ok":false,"code":"shortage","problems":[
#      {"kind":"hold","color":"#ff0000","stock":10,"reserved":0,"quarantined":2,
#       "available":8,"requested":9,"shortage":1,"reason":"over_free",
#       "reasonText":"可隔离量仅 8 张（实物 10 − 净预留 0 − 已隔离 2），本次 9 张"}]}

# 解除超过隔离余额（红仅隔离 2 张却解除 3 张）
# -> 409 {"code":"shortage","problems":[{"kind":"release","reason":"over_quarantined",
#       "quarantined":2,"requested":3,"shortage":1,...}]}

# 多色其一不足 → 整次回滚（另一色也不变）

# 同一操作号不同内容 → 409；existing 给出已记录 action、reason、colors 和分色 items
# -> {"ok":false,"code":"op_no_conflict","opNo":"Q-20261005-001",
#     "existing":{"id":1,"opNo":"Q-20261005-001","action":"hold","actionText":"隔离",
#                 "reason":"边角气泡、结石",
#                 "colors":[{"sheetId":1,"count":2},{"sheetId":2,"count":1}],
#                 "items":[{"sheetId":1,"color":"#ff0000","count":2,"balanceQuarantined":2},
#                          {"sheetId":2,"color":"#00ff00","count":1,"balanceQuarantined":1}]}}

# 手工调库低于 净预留 + 隔离量 → 409
curl -s -X PATCH localhost:3000/api/glass-sheets/1 -H 'Content-Type: application/json' \
  -d '{"stock":1}'
# -> 409 {"code":"stock_below_reserved","reserved":0,"quarantined":2,"floor":2,
#         "error":"库存不得小于净预留与瑕疵隔离量之和（净预留 0 + 瑕疵隔离 2 = 2 张）"}
```

## 库存台账规则（按规格追溯实物库存与净预留）

- **查询维度**：`GET /api/ledger?type=lead|glass&specId=N&from=&to=`。`type` 必填（`lead` 铅条原材 / `glass` 玻璃原片），`specId` 必填（规格 id，取自 `GET /api/materials` / `GET /api/glass-sheets`）；`from`/`to` 可选，支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:MM[:SS]`（空格或 `T` 分隔），日期级 `from` 按当天 `00:00:00` 起、`to` 按当天 `23:59:59` 止（区间右闭）。网页“库存台账”标签提供同样的筛选与逐笔表格。
- **逐笔内容**：发生时间、业务来源（事件 + 单据/操作号等说明）、**实物库存增减**、**净预留增减**（玻璃另含**瑕疵隔离增减**）、**笔后实物余额**、**笔后净预留余额**（玻璃另含**笔后隔离余额**），按发生顺序（台账 id）升序；响应另附该规格当前结存（玻璃为实物/净预留/隔离/可用，铅条无隔离字段、隔离恒为 0）。无记录返回 `entries: []`（不报错）；类型/规格/时间非法或区间颠倒返回 400，规格不存在返回 404。
- **记账时点（与业务同一事务）**：原材/原片**登记**（`register`，期初库存起账）与**手工调库**（`adjust`，仅库存实际变化时记）；独立铅条计划/独立裁片订单/**整套单**的**确认与取消**（`plan_*`/`order_*`/`combo_*`，净预留增减）；**裁片换单**（`replace_out` 旧单退出 + `replace_in` 新单接替，同一事务按先释放后接替两笔记）；**盘点确认**（`stocktake`，实物按实盘调整）；**领料确认**（`issue`，实物与净预留同步核减）；**玻璃瑕疵隔离/解除**（`quarantine_hold`/`quarantine_release`，仅隔离量增减、实物与净预留不动）。任一步失败整体回滚，**预览、失败回滚与幂等重试均不留下重复流水**。
- **基线口径**：已有数据库**首次启用**时，按各规格**当前实物库存与净预留**写一条 `baseline` 基线（旧业务**不倒推**，隔离量自启用后从首笔隔离流水起算，旧库升级时历史隔离余额自动并入规格当前隔离列）；全新库无规格不写基线；**新登记规格从 `register` 登记流水起账**。此后每规格逐笔满足“上笔余额 + 本笔增减 = 本笔余额”（玻璃含隔离轴），末笔余额即当前结存，可顺序核对。
- **口径**：实物库存 = `lead_materials.stock` / `glass_sheets.stock`；净预留 = 已确认预留总量 − 已领出量（与库存接口的 `reserved` 同口径）；隔离余额 = `glass_sheets.quarantined`（仅玻璃，铅条恒 0）；玻璃实际可用量 = 实物库存 − 净预留 − 隔离余额。台账时间为服务器 UTC（与系统其他时间一致）。

### 库存台账调用示例（curl）

```bash
# 0) 前置：已有业务库（首次启用自动建立基线），或新登记规格产生 register 流水

# 1) 查某铅条规格全部流水（网页“库存台账”标签同源）
curl -s 'localhost:3000/api/ledger?type=lead&specId=1'
# -> { ok:true, ledger:{ materialType:"lead", materialTypeText:"铅条原材",
#      specId:1, specName:"6m 通用铅条", specDetail:"定尺 6000 mm", unit:"根",
#      from:null, to:null, current:{stock:14,reserved:4,available:10}, count:4,
#      entries:[
#        { id:1, occurredAt:"2026-10-04 09:14:38", eventType:"baseline", eventText:"启用台账基线",
#          sourceType:"system", sourceId:null,
#          sourceLabel:"启用台账基线（按当前实物库存与净预留起账，此前业务不倒推）",
#          deltaStock:0, deltaReserved:0, balanceStock:12, balanceReserved:4 },
#        { id:2, eventType:"adjust",    eventText:"手工调库",   deltaStock:+3, deltaReserved:0,  balanceStock:15, balanceReserved:4, ... },
#        { id:3, eventType:"plan_confirm", eventText:"铅条计划确认", deltaStock:0, deltaReserved:+1, balanceStock:15, balanceReserved:5,
#          sourceType:"lead_plan", sourceId:2, sourceLabel:"铅条计划 #2「…」确认：预留 1 根" },
#        { id:4, eventType:"issue",     eventText:"领料出库",   deltaStock:-1, deltaReserved:-1, balanceStock:14, balanceReserved:4,
#          sourceType:"issue", sourceId:7, sourceLabel:"领料 LL-001（铅条计划 #2）：铅条出库 1 根" } ] } }

# 2) 查某玻璃原片规格在指定时间范围内的流水
curl -s 'localhost:3000/api/ledger?type=glass&specId=1&from=2026-10-01&to=2026-10-04'
# 也支持到分/秒：from=2026-10-04 08:30 / to=2026-10-04T18:00:00（URL 需编码空格）

# 3) 无记录：返回空结果（200，entries 为空）
curl -s 'localhost:3000/api/ledger?type=lead&specId=1&from=2099-01-01'
# -> { ok:true, ledger:{ ..., count:0, entries:[] } }

# 4) 非法筛选：明确报错
curl -s 'localhost:3000/api/ledger?type=wood&specId=1'
# -> 400 {"ok":false,"error":"材料类型 type 必须是 lead（铅条原材）或 glass（玻璃原片）"}
curl -s 'localhost:3000/api/ledger?type=lead&specId=99'
# -> 404 {"ok":false,"error":"铅条原材规格 #99 不存在"}
curl -s 'localhost:3000/api/ledger?type=lead&specId=1&from=2026-01-02&to=2026-01-01'
# -> 400 {"ok":false,"error":"起始时间不能晚于结束时间（from=2026-01-02 00:00:00，to=2026-01-01 23:59:59）"}
```

## 铅条生产排产规则

- **长度单位**：所有长度（定尺、切段、刀损、余料）内部都以 **0.01 mm 的整数倍**精确运算，接口接受至多两位小数的毫米数；超过精度（如 `6000.005`）直接拒绝。
- **切段来源**：仅来自所选发布版本 `snapshot.leadList` 的 `internal`（内部公共边）与 `frameBars`（四根外框），按 `件数` 逐件复制，段不可拼接、不可跨件合并。
- **装箱**：切段先按长度降序、同长按清单顺序排序，再依次放入第一根剩余容量足够的原材；每段占位 = 成品长度 + 一刀损耗。某段 `成品 + 刀损 > 定尺` 时整单拒绝（返回 422 与该段信息）。
- **库存口径**：`available = stock − 所有已确认计划的 requiredBars 之和`。预览与草稿都不占库存；只有确认才预留。
- **并发**：确认使用 SQLite `BEGIN IMMEDIATE` 写事务，读取库存→核对缺口→置为 confirmed 在同一事务内完成，并发确认最多售出实际库存。

## 两版铅条核对规则

- **比较对象**：同一图纸的两个已发布版本（只读快照）。较早版 / 较晚版按版本号自动确定，`fromVersion` 与 `toVersion` 填反也会归一，不会把“沿用”错算成“取消+新增”。
- **分类口径（纯几何）**：把两版每根铅条放到同一根**无向直线**上，以沿直线的参数区间表示其空间覆盖：
  - 两版区间重叠的原子段 = **沿用（kept）**；
  - 仅较早版覆盖 = **取消（removed）**；仅较晚版覆盖 = **新增（added）**；
  - 部分重叠时以双方端点为界**拆分**为沿用/取消/新增三段。
- **不产生虚假差异的归一**：直线与方向无向归一（端点反向、清单顺序无关）；同一版同一直线上相接的区间先合并，因此 **T 接处“一侧整边、另一侧数段”** 等纯分段变化相互抵消；同一直线上两段不连续时中间空隙保留，不会被错误合并。
- **比较范围**：内部公共边（按几何直线自动分组）与四根外框（上/下/左/右分别核对；外框由窗框固定，同图纸两版通常四框全部沿用）。
- **精度**：直线分组与区间运算在“放大 100 倍”的整数坐标上精确完成（端点均为整数毫米）；段长为欧氏长度，**各类合计先对各段原始长度求和，再四舍五入到 0.01 mm**（斜线段可能出现 3 段各 1.41 mm、合计 4.24 mm 而非 4.23 mm 的情形，属预期）。
- **报错**：版本不存在返回 404；两个发布版不属于同一图纸（含窗框尺寸不一致）返回 400/422；接口不写数据库，**发布快照、生产计划、库存根数都不受影响**。

### 两版核对调用示例（curl）

```bash
# 方式一（GET，版本号）：核对 1 号图纸 v1 → v2
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=2'
# -> { ok:true, meta:{ earlier:{version:1}, later:{version:2}, width,height },
#      diff:{ internal:{ kept:[{from,to,length}], removed:[...], added:[...], counts, totals },
#              frame:{"上框":{kept,removed,added,counts,totals}, ...}, frameOrder,
#              frameTotals, frameCounts, totals, counts } }

# 填反版本号也会自动归位（earlier 恒为较早版）
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=2&toVersion=1'

# 方式二（POST，发布版 id）
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":2}'

# 版本不存在
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=99'
# -> 404 {"ok":false,"error":"发布版 v99 不存在"}

# 两个发布版不属于同一图纸
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":8}'
# -> 400 {"ok":false,"error":"两个发布版不属于同一图纸，不能核对铅条",
#         "designIdA":1,"designIdB":3}
```

响应中 `diff.totals` 为“内部公共边 + 四根外框”的总合计，`diff.internal.totals`、
`diff.frameTotals` 为分项合计；每个合计都含 `kept/removed/added` 三个长度（mm，
两位小数），`counts` 为对应段数。

## 1:1 分张打印规则

- **输入（全部整数毫米）**：`paperWidth`/`paperHeight` 纸张宽高（必须为正）、`margin` 四边统一留白（可为 0）、`overlap` 相邻页重叠宽度（必须为正）。
- **可打印区域**：`(paperWidth − 2·margin) × (paperHeight − 2·margin)`；非正时整单拒绝（`printable_not_positive`）。重叠必须**严格小于**可打印区域的**每一条**边长，否则拒绝（`overlap_too_large`）。
- **分页步距**：某方向内容长 `L`、可打印长 `p`、重叠 `o`，步距为 `p − o`；页数 `n = L ≤ p ? 1 : ceil((L − o)/(p − o))`，因此任意相邻页重叠不少于 `o`，末页覆盖末端恰好到窗框边。
- **编号**：行自下而上（对应图纸 y 轴正方向）、列自左而右；页码先行内从左到右、再从下到上，`page = (row−1)·cols + col`。
- **拼接标记**：每页四边给出存在相邻页的方向、邻页页码、重叠带范围（相邻两页对同一拼接边算出的范围**完全相同**），长边上沿带长 1/4、1/2、3/4 放置红色对位十字（短边放正中一个），并标注十字的图纸坐标。
- **SVG 内容**：根元素 `width="<paperWidth>mm" height="<paperHeight>mm"`、`viewBox` 同值，打印按 1:1；玻璃片多边形、编号/面积、颜色与外框矩形全部来自发布快照；整页图纸内容套在 `clipPath`（即可打印区域）内，跨页轮廓自然裁切；重叠带在两页以相同图纸坐标重复绘制；页内含 0–100 mm 的**毫米校准标尺**（可打印区域过窄时改竖尺）与“实际大小/100%、勿缩放”提示。
- **页数上限**：`cols × rows > 200` 时返回 422（`too_many_pages`，附 `cols/rows/totalPages`），**不输出任何部分页面**。
- **只读**：两个接口均不写数据库，草稿、发布快照、生产计划、库存都不受影响。

### 分张打印调用示例（curl）

```bash
# 1) 生成拼接预览（A4、四边留白 10mm、相邻页重叠 15mm）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":15}'
# -> { ok:true, preview:{ designId, version, publicationId,
#      print:{ paper:{width,height}, margin, overlap,
#              printable:{width,height}, content:{width,height},
#              cols, rows, totalPages, pageNumbering,
#              pages:[ { page,row,col,rows,cols,
#                        coverage:{x0,y0,x1,y1,width,height},
#                        seams:[{edge,direction,paperCoord,drawingCoord,neighborPage,
#                                overlap:{x0,y0,x1,y1,width,height},
#                                crosses:[{x,y}]}],
#                        svgUrl } ] } } }

# 2) 下载第 1 页 SVG（参数须与预览一致；返回 image/svg+xml，物理尺寸 mm）
curl -s -G localhost:3000/api/designs/1/publications/1/print/page \
  --data-urlencode 'paperWidth=210' --data-urlencode 'paperHeight=297' \
  --data-urlencode 'margin=10' --data-urlencode 'overlap=15' \
  --data-urlencode 'page=1' -o page-1.svg

# 非法参数：可打印尺寸非正（留白 200 ≥ 半边长）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":200,"overlap":5}'
# -> 400 {"ok":false,"code":"printable_not_positive", ...}

# 非法参数：重叠不小于可打印边长（可打印 190×277）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":190}'
# -> 400 {"ok":false,"code":"overlap_too_large", ...}

# 页数超过 200（5mm 纸、1mm 留白 → 3×3 可打印，600×400 图纸 = 200×134 页）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":5,"paperHeight":5,"margin":1,"overlap":1}'
# -> 422 {"ok":false,"code":"too_many_pages","cols":200,"rows":134,"totalPages":26800,"maxPages":200}

# 版本不存在 / 页码越界
curl -s -X POST localhost:3000/api/designs/1/publications/99/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":15}'
# -> 404 {"ok":false,"error":"发布版 v99 不存在"}
curl -s -G localhost:3000/api/designs/1/publications/1/print/page \
  --data-urlencode 'paperWidth=210' --data-urlencode 'paperHeight=297' \
  --data-urlencode 'margin=10' --data-urlencode 'overlap=15' \
  --data-urlencode 'page=99'
# -> 400 {"ok":false,"error":"页码必须是 1–8 之间的整数"}
```

### HTTP 调用示例（curl）

```bash
# 1) 登记原材：定尺 6000.00 mm、库存 10 根
curl -s localhost:3000/api/materials -H 'Content-Type: application/json' \
  -d '{"name":"6m 通用铅条","length":6000,"stock":10}'
# -> {"ok":true,"material":{"id":1,"name":"6m 通用铅条","length":6000,"stock":10,"reserved":0,"available":10,...}}

# 2) 查可用库存（reserved=已确认计划预留，available=还可用于新计划）
curl -s localhost:3000/api/materials

# 3) 排产预览（publicationId 取自发布接口返回的 id；不落库、不占库存）
curl -s localhost:3000/api/plans/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'
# -> preview.layout.bars[]：每根原材的 cuts（件次/切段名/成品长/刀损）、remainder 余料；
#    requiredBars 需用根数、availableBars 可用、shortage 缺口、feasible 是否可确认

# 4) 建草稿计划
curl -s localhost:3000/api/plans -H 'Content-Type: application/json' \
  -d '{"name":"三联窗订单","publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'

# 5) 确认（库存足够才成功；缺口返回 409 + shortage）
curl -s -X POST localhost:3000/api/plans/1/confirm
# 6) 取消（释放预留；重复取消返回 409 且不再次改库存）
curl -s -X POST localhost:3000/api/plans/1/cancel
# 7) 查全部计划与可用库存
curl -s localhost:3000/api/plans
curl -s localhost:3000/api/materials
```

非法输入示例（均返回 400，库存不变）：定尺 `0`/负数、库存 `-1`、件数 `0`/`1.5`、刀损 `-0.01`、长度精度超过 0.01 mm。

## 目录结构

```
Dockerfile               容器镜像（含 better-sqlite3 编译环境）
docker-compose.yml       一键启动 + 数据卷持久化
src/
  server.js              Express 入口与 API（图纸/发布/两版核对/跨图复用/原材/生产计划/玻璃裁片/裁片换单/整套用料单/库存盘点/分次领料/库存台账）
  db.js                  SQLite 初始化与数据访问（铅条与玻璃原片原子预留、裁片换单与整套单原子事务、盘点基准重核与一次更新、分次领料同事务扣实物与净预留/幂等/终态保护、库存台账同事务写入与基线迁移、跨图复用预览指纹与整批确认事务；旧库自动迁移）
  geometry.js            精确几何校验、覆盖/缺口分析、铅条合并
  leaddiff.js            两版铅条核对（整数直线分组、区间沿用/取消/新增、拆分）
  cutting.js             铅条切段排产（0.01mm 整数运算、FFD、刀损）
  printsheet.js          1:1 分张打印（整数毫米分页、拼接标记、逐页 SVG/毫米标尺）
  sheetnest.js           玻璃裁片排样（整数/BigInt 精确净距、90°旋转、左下角首次适应、60 张上限）
  importpieces.js        跨图复用（参数解析、绕源原点 90° 旋转+整数平移、批量越界/重叠校验、草稿指纹、预览汇总）
public/
  index.html / style.css / app.js   单页前端（Canvas 编辑器/发布视图/跨图复用/版本核对/分张打印/铅条生产/玻璃裁片/整套备料/库存盘点/分次领料/库存台账）
test/
  geometry.test.js       几何算法测试（node --test）
  leaddiff.test.js       两版核对：反向/顺序/T接归一、部分重叠拆分、斜向合计舍入、非同图纸报错
  cutting.test.js        切段解析与 FFD 排产测试
  printsheet.test.js     分张分页/重叠坐标一致/页数上限/SVG 物理尺寸与裁剪测试
  print.api.test.js      分张打印端到端（预览/逐页 SVG、非法参数整单拒绝、404/422、只读）
  plans.api.test.js      生产计划端到端测试（含并发不超卖、快照绑定）
  diff.api.test.js       两版核对端到端测试（GET/POST、404/400、只读不改变快照/计划/库存）
  sheetnest.test.js      裁片排样算法测试（旋转/越板/精确净距/缺色/上限/件次/确定性）
  cutorders.api.test.js  裁片订单端到端（登记/预览/整单拒绝、多色原子预留、并发不超卖、快照绑定）
  cutreplace.test.js     换单端到端（预览只读、原子换单、短缺回滚、幂等/冲突、旧单终态、并发不超卖、换单链）
  comboorders.api.test.js 整套用料单端到端（预览只读、两类原子预留/短缺回滚、幂等/冲突、关联单锁定、取消各释放一次、并发不超卖、快照绑定、独立入口不受影响）
  stocktakes.api.test.js 库存盘点端到端（预览固化基准不改库存、基准不符/低于预留整单拒绝、一次更新、重复提交幂等、盘点后独立/整套单口径、并发不双重调整、调整入口继续可用）
  issues.api.test.js    分次领料端到端（三类单据分次领/只领一类、同事务扣实物与净预留、超剩余整单回滚、同号幂等/冲突、已领料不可取消/不可换单、盘点与调库按净预留结转、并发不超领、历史查询、旧入口字段保持）
  ledger.api.test.js    库存台账端到端（旧库首启基线不倒推、登记起账、调库/确认/取消/换单/整套/盘点/领料同事务记账、失败回滚与幂等重试不留重复流水、顺序核对至当前余额、时间范围过滤、非法筛选报错、空结果）
  importpieces.api.test.js 跨图复用端到端（选片/旋转平移、预览不落草稿、越界/重叠逐片拒绝、共边/T接允许、确认整批赋新号保留原色、预览后编辑 draft_changed、重复确认不重复写片、源快照/库存不变、含复用片草稿可发布）
```
