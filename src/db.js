'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 一张图纸（窗框固定）；草稿内容在 pieces 表中就地编辑
    CREATE TABLE IF NOT EXISTS designs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      width_mm    INTEGER NOT NULL CHECK (width_mm  > 0),
      height_mm   INTEGER NOT NULL CHECK (height_mm > 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 草稿拼片：编号在一张图纸内递增且永不复用
    CREATE TABLE IF NOT EXISTS pieces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      piece_no    INTEGER NOT NULL,
      color       TEXT    NOT NULL,
      polygon     TEXT    NOT NULL,           -- JSON [[x,y],...] 整数毫米
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, piece_no)
    );

    -- 发布版：不可变快照，版本号在一张图纸内递增
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      snapshot    TEXT    NOT NULL,           -- 完整快照 JSON
      published_at TEXT   NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, version)
    );

    -- 铅条原材：一种规格（定尺长度）一行，登记库存根数
    CREATE TABLE IF NOT EXISTS lead_materials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,    -- 规格名（如“6m 通用铅条”）
      length_h    INTEGER NOT NULL CHECK (length_h > 0),   -- 定尺，整数“厘”（0.01mm）
      stock       INTEGER NOT NULL CHECK (stock >= 0),     -- 库存根数（不会为负）
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 铅条生产计划：草稿不预留库存；confirmed 原子预留；canceled 释放。
    -- 绑定发布快照（publication 不可变）；草稿变化/新版本均不影响已确认计划。
    CREATE TABLE IF NOT EXISTS lead_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled')),
      publication_id   INTEGER NOT NULL REFERENCES publications(id),
      design_id        INTEGER NOT NULL,
      version          INTEGER NOT NULL,
      material_id      INTEGER NOT NULL REFERENCES lead_materials(id),
      material_name    TEXT    NOT NULL,       -- 快照：确认时的规格名
      material_length_h INTEGER NOT NULL,      -- 快照：建计划时的定尺（厘）
      copies           INTEGER NOT NULL CHECK (copies > 0),
      kerf_h           INTEGER NOT NULL CHECK (kerf_h >= 0),  -- 每刀损耗（厘）
      required_bars    INTEGER NOT NULL CHECK (required_bars > 0),
      segment_count    INTEGER NOT NULL,
      layout           TEXT    NOT NULL,       -- 切段方案 JSON（毫米，排产结果快照）
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at     TEXT,
      canceled_at      TEXT,
      combo_id         INTEGER                 -- 非空=整套单关联计划（仅随整套单取消），NULL=独立计划
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_design ON pieces(design_id);
    CREATE INDEX IF NOT EXISTS idx_pub_design    ON publications(design_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON lead_plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_pub     ON lead_plans(publication_id);
    CREATE INDEX IF NOT EXISTS idx_plans_mat     ON lead_plans(material_id);

    -- 彩色玻璃原片：每种颜色一行规格（宽×高，整数毫米 1–2000）+ 库存张数
    -- quarantined 为因瑕疵隔离的张数：实物库存不随隔离变化，仅从新单可用量中扣除
    CREATE TABLE IF NOT EXISTS glass_sheets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      color       TEXT    NOT NULL UNIQUE,        -- 归一化小写 #rrggbb
      width_mm    INTEGER NOT NULL CHECK (width_mm  BETWEEN 1 AND 2000),
      height_mm   INTEGER NOT NULL CHECK (height_mm BETWEEN 1 AND 2000),
      stock       INTEGER NOT NULL CHECK (stock >= 0),
      quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 裁片订单：草稿不占库存；confirmed 原子预留各色原片；canceled 释放。
    -- confirmed 订单换单成功后置为 replaced（旧单退出预留、不可再取消/修改/删除，仅可查阅）。
    -- 绑定发布快照（publication 不可变）；草稿变化/再发布不影响已确认订单。
    CREATE TABLE IF NOT EXISTS cut_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
      publication_id INTEGER NOT NULL REFERENCES publications(id),
      design_id     INTEGER NOT NULL,
      version       INTEGER NOT NULL,
      copies        INTEGER NOT NULL CHECK (copies > 0),
      gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
      layout        TEXT    NOT NULL,             -- 完整排样方案 JSON（含逐张放置坐标/轮廓）
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at  TEXT,
      canceled_at   TEXT,
      replaced_at   TEXT,
      combo_id      INTEGER                   -- 非空=整套单关联订单（仅随整套单取消，禁止改/换单/删），NULL=独立订单
    );

    -- 换单记录：一张已确认旧单（old_order_id）在同一事务内退出预留，
    -- 由按同一图纸另一已发布版本排出的新单（new_order_id，创建即 confirmed）接替。
    -- 幂等键：同一旧单只有一条记录；相同目标版本/件数/间距重试返回原新单，不同参数冲突。
    CREATE TABLE IF NOT EXISTS cut_order_replacements (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      old_order_id          INTEGER NOT NULL REFERENCES cut_orders(id),
      new_order_id          INTEGER NOT NULL REFERENCES cut_orders(id),
      target_publication_id INTEGER NOT NULL REFERENCES publications(id),
      copies                INTEGER NOT NULL CHECK (copies > 0),
      gap_mm                INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (old_order_id),
      UNIQUE (new_order_id)
    );

    -- 订单分色明细：确认时按色预留 required_sheets 张（原子）。
    -- sheet_color/width_mm/height_mm 为建单时快照；规格宽高属于身份不可改。
    CREATE TABLE IF NOT EXISTS cut_order_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES cut_orders(id) ON DELETE CASCADE,
      sheet_id        INTEGER NOT NULL REFERENCES glass_sheets(id),
      sheet_color     TEXT    NOT NULL,
      sheet_width_mm  INTEGER NOT NULL,
      sheet_height_mm INTEGER NOT NULL,
      required_sheets INTEGER NOT NULL CHECK (required_sheets > 0)
    );

    -- 整套用料单：一次确认同时预留铅条原材与各色玻璃原片。
    -- 确认在同一事务内核验并创建“关联的生产计划 + 裁片订单”（均创建即 confirmed）；
    -- 取消在同一事务内把两者置为 canceled，两类预留各释放一次。
    -- request_key 为客户端幂等键：重复确认（重试）返回原整套单，不重复预留库存。
    -- 关联的计划/订单只能随整套单存在/取消，不能从原独立入口单独取消、修改、换单或删除。
    CREATE TABLE IF NOT EXISTS combo_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      status      TEXT    NOT NULL CHECK (status IN ('confirmed','canceled')),
      request_key TEXT    NOT NULL UNIQUE,
      publication_id INTEGER NOT NULL REFERENCES publications(id),
      design_id   INTEGER NOT NULL,
      version     INTEGER NOT NULL,
      copies      INTEGER NOT NULL CHECK (copies > 0),
      kerf_h      INTEGER NOT NULL CHECK (kerf_h >= 0),
      gap_mm      INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      material_id INTEGER NOT NULL REFERENCES lead_materials(id),
      required_bars   INTEGER NOT NULL CHECK (required_bars > 0),
      total_sheets    INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
      lead_plan_id    INTEGER NOT NULL,
      cut_order_id    INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      canceled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_combo_status ON combo_orders(status);
    CREATE INDEX IF NOT EXISTS idx_combo_pub    ON combo_orders(publication_id);

    CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
    CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_sheet   ON cut_order_items(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_order   ON cut_order_items(order_id);

    -- 库存盘点单：一张单同时盘点若干铅条原材规格与玻璃原片规格。
    -- 预览即建草稿并固化各项“预览基准”（系统库存/已确认预留），预览本身不改库存；
    -- 确认在同一事务内按基准重核全部项：任一项基准已不符或实盘数低于当前预留则整单不生效；
    -- 全部通过才一次更新各规格库存，并保留原值、实盘值与确认时间。
    CREATE TABLE IF NOT EXISTS stocktakes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      status       TEXT    NOT NULL CHECK (status IN ('draft','confirmed')),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT
    );

    -- 盘点项：type='lead' 为铅条原材（spec_id -> lead_materials.id）；
    -- type='glass' 为玻璃原片（spec_id -> glass_sheets.id）。同单同类型规格唯一。
    -- 预览时固化基线库存与已确认预留；确认后保留原值与实盘值（永久记录，库存之后再变也不回写）。
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id      INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      type              TEXT    NOT NULL CHECK (type IN ('lead','glass')),
      spec_id           INTEGER NOT NULL,
      spec_name         TEXT    NOT NULL,       -- 铅条规格名；玻璃存颜色
      spec_length_h     INTEGER,                -- 仅铅条：定尺（厘），身份快照
      spec_width_mm     INTEGER,                -- 仅玻璃：宽（mm），身份快照
      spec_height_mm    INTEGER,                -- 仅玻璃：高（mm），身份快照
      baseline_stock    INTEGER NOT NULL,       -- 预览时系统库存
      baseline_reserved INTEGER NOT NULL,       -- 预览时已确认独立单+整套单预留
      baseline_quarantined INTEGER NOT NULL DEFAULT 0, -- 仅玻璃：预览时瑕疵隔离余额（铅条恒 0）
      counted_stock     INTEGER NOT NULL CHECK (counted_stock >= 0), -- 实盘总数
      UNIQUE (stocktake_id, type, spec_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stockitems_st ON stocktake_items(stocktake_id);

    -- 领料记录：工作室按已确认的独立铅条计划 / 独立裁片订单 / 整套用料单分次领料。
    -- 一次确认在同一事务内扣减实物库存（stock）与对应预留（记录行不可变、不可取消）。
    -- issue_no 为调用方提供的唯一领料号（同号同内容重试返回原记录，同号不同内容冲突）。
    -- 一次领料可能同时领铅条与多色玻璃（多行同一 issue_no），故 issue_no 不加 UNIQUE；
    -- 唯一性由 BEGIN IMMEDIATE 写事务 + 同号查重保证（并发请求被写锁串行化）。
    CREATE TABLE IF NOT EXISTS stock_issues (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_no        TEXT    NOT NULL,
      source_type     TEXT    NOT NULL CHECK (source_type IN ('lead_plan','cut_order','combo')),
      plan_id         INTEGER,                       -- 铅条计划（独立计划或整套关联计划）
      order_id        INTEGER,                       -- 裁片订单（独立订单或整套关联订单）
      combo_id        INTEGER,                       -- 整套单 id（整套领料时非空）
      material_id     INTEGER,                       -- 铅条规格
      lead_bars       INTEGER NOT NULL DEFAULT 0 CHECK (lead_bars >= 0),
      sheet_id        INTEGER,                       -- 玻璃原片规格（一条一行某色）
      sheet_color     TEXT,
      sheets_count    INTEGER NOT NULL DEFAULT 0 CHECK (sheets_count >= 0),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_issues_plan   ON stock_issues(plan_id);
    CREATE INDEX IF NOT EXISTS idx_issues_order  ON stock_issues(order_id);
    CREATE INDEX IF NOT EXISTS idx_issues_combo  ON stock_issues(combo_id);
    CREATE INDEX IF NOT EXISTS idx_issues_mat    ON stock_issues(material_id);
    CREATE INDEX IF NOT EXISTS idx_issues_sheet  ON stock_issues(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_issues_no     ON stock_issues(issue_no);

    -- 跨图纸拼片复用预览：从一份已发布快照选片（piece_nos），绕源图纸原点旋转
    -- 0/90/180/270 并整数毫米平移后准备写入目标图纸草稿。
    -- 预览即落库（status=pending），保存目标草稿指纹 draft_fingerprint；
    -- 确认时在同一写事务内重算指纹——预览后草稿被编辑（增删改任一片）则指纹不符，
    -- 返回 409 draft_changed 整批不写入，须重新预览。确认成功后 status=confirmed，
    -- 整批拼片在同一事务内赋予目标图纸的新编号（保留原色），本记录不可再确认。
    CREATE TABLE IF NOT EXISTS piece_imports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      status            TEXT    NOT NULL CHECK (status IN ('pending','confirmed')),
      target_design_id  INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      publication_id    INTEGER NOT NULL REFERENCES publications(id),
      source_design_id  INTEGER NOT NULL,
      source_version    INTEGER NOT NULL,
      rotation          INTEGER NOT NULL CHECK (rotation IN (0,90,180,270)),
      dx_mm             INTEGER NOT NULL,
      dy_mm             INTEGER NOT NULL,
      piece_nos         TEXT    NOT NULL,           -- JSON [来源片号...]（不重复）
      items             TEXT    NOT NULL,           -- JSON：逐片来源编号/原色/旋转/平移/转换后轮廓
      draft_fingerprint TEXT    NOT NULL,           -- 预览时目标草稿指纹
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at      TEXT,
      confirmed_pieces  TEXT                        -- 确认后 JSON：[{pieceNo,sourcePieceNo,color,polygon}]
    );

    CREATE INDEX IF NOT EXISTS idx_pieceimports_design ON piece_imports(target_design_id);
    CREATE INDEX IF NOT EXISTS idx_pieceimports_status ON piece_imports(status);

    -- 玻璃原片瑕疵隔离单（不可变）：一次操作选一种或多种已登记颜色，
    -- 对每种颜色提交正整数张数与非空原因，整单原子生效。
    -- action='hold' 隔离：只能划出当前“未预留（净）且未隔离”的实物（stock − 净预留 − 已隔离）；
    -- action='release' 解除隔离：不得超过该色隔离余额。实物库存 stock 不随隔离变化。
    -- op_no 为调用方提供的唯一操作号：同号同内容重试返回原记录，同号异内容冲突。
    CREATE TABLE IF NOT EXISTS glass_quarantines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      op_no       TEXT    NOT NULL UNIQUE,
      action      TEXT    NOT NULL CHECK (action IN ('hold','release')),
      reason      TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 隔离单分色明细（不可变）：一次操作各色一行，记录该色当次张数与笔后隔离余额。
    CREATE TABLE IF NOT EXISTS glass_quarantine_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      quarantine_id     INTEGER NOT NULL REFERENCES glass_quarantines(id),
      sheet_id          INTEGER NOT NULL REFERENCES glass_sheets(id),
      sheet_color       TEXT    NOT NULL,
      sheets_count      INTEGER NOT NULL CHECK (sheets_count > 0),
      balance_quarantined INTEGER NOT NULL CHECK (balance_quarantined >= 0),
      UNIQUE (quarantine_id, sheet_id)
    );

    CREATE INDEX IF NOT EXISTS idx_quarantine_items_sheet ON glass_quarantine_items(sheet_id);
  `);

  // 旧库迁移：早期 cut_orders 的状态 CHECK 不含 'replaced'，也没有 replaced_at 列。
  // 按 SQLite 官方表重建流程改表（保留全部行与 id；cut_order_items 通过 FK 关联，重建期间关闭 FK 检查）。
  // 必须先于 combo_id 加列迁移：表重建不带 combo_id，随后统一补列。
  migrateCutOrders();

  // 旧库迁移：早期 lead_plans / cut_orders 没有 combo_id（整套单关联）列。
  migrateComboColumn('lead_plans');
  migrateComboColumn('cut_orders');
  // 关联列索引（新库/旧库统一在此创建，确保列已存在）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plans_combo ON lead_plans(combo_id);
    CREATE INDEX IF NOT EXISTS idx_cutorders_combo ON cut_orders(combo_id);
  `);

  // 早期领料表 issue_no 带 UNIQUE（一次领料多行需同号）；检测到旧定义则重建。
  migrateStockIssues();

  // 库存台账：首次启用（表不存在）时建表并为既有规格写基线行；此后由业务同事务写入。
  migrateLedger();

  // 旧库迁移：glass_sheets 补 quarantined（瑕疵隔离余额）列；
  // stock_ledger 补隔离增减/笔后余额列并扩展 event_type CHECK 以容纳隔离/解除流水。
  migrateGlassQuarantine();
  migrateLedgerQuarantineColumns();
  // 盘点项补“预览时隔离余额”基准列（旧草稿盘点单按 0 起算）。
  migrateStocktakeQuarantineColumn();

  return db;
}

// 库存台账（stock_ledger）：按“材料类型 + 规格”逐笔记录实物库存与净预留的增减及笔后余额。
// 首次启用（旧库升级）时建表，并按各规格当前实物库存与净预留写 baseline 基线行
// （旧业务不倒推）；全新库没有任何规格则不写基线，新登记规格从 register 流水起账。
// 建表与基线写在同一事务，避免半截状态；表已存在则什么都不做。
function migrateLedger() {
  const existed = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='stock_ledger'").get();
  if (existed) return;
  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE stock_ledger (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        material_type    TEXT    NOT NULL CHECK (material_type IN ('lead','glass')),
        spec_id          INTEGER NOT NULL,           -- lead_materials.id 或 glass_sheets.id
        spec_name        TEXT    NOT NULL,           -- 规格名快照（铅条规格名 / 玻璃颜色）
        event_type       TEXT    NOT NULL CHECK (event_type IN (
          'baseline','register','adjust',
          'plan_confirm','plan_cancel',
          'order_confirm','order_cancel',
          'replace_out','replace_in',
          'combo_confirm','combo_cancel',
          'stocktake','issue',
          'quarantine_hold','quarantine_release')),
        delta_stock      INTEGER NOT NULL,           -- 实物库存增减（正=入/增，负=出/减）
        delta_reserved   INTEGER NOT NULL,           -- 净预留增减（已确认预留 − 已领出）
        delta_quarantined INTEGER NOT NULL DEFAULT 0,-- 瑕疵隔离量增减（仅玻璃；隔离 +n / 解除 −n）
        balance_stock    INTEGER NOT NULL,           -- 笔后实物库存
        balance_reserved INTEGER NOT NULL,           -- 笔后净预留
        balance_quarantined INTEGER NOT NULL DEFAULT 0, -- 笔后瑕疵隔离余额（仅玻璃；铅条恒 0）
        source_type      TEXT    NOT NULL,           -- system/material/glass_sheet/lead_plan/cut_order/combo/stocktake/issue/quarantine
        source_id        INTEGER,                    -- 业务单据 id（领料为 stock_issues 行 id）
        source_label     TEXT    NOT NULL,           -- 业务来源展示文本
        created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ledger_spec ON stock_ledger(material_type, spec_id, id);
      CREATE INDEX idx_ledger_time ON stock_ledger(created_at);
    `);
    for (const m of db.prepare('SELECT id FROM lead_materials ORDER BY id').all()) {
      writeLedgerRow({
        materialType: 'lead', specId: m.id, eventType: 'baseline',
        deltaStock: 0, deltaReserved: 0,
        sourceType: 'system', sourceId: null,
        sourceLabel: '启用台账基线（按当前实物库存与净预留起账，此前业务不倒推）',
      });
    }
    for (const s of db.prepare('SELECT id FROM glass_sheets ORDER BY id').all()) {
      writeLedgerRow({
        materialType: 'glass', specId: s.id, eventType: 'baseline',
        deltaStock: 0, deltaReserved: 0,
        sourceType: 'system', sourceId: null,
        sourceLabel: '启用台账基线（按当前实物库存与净预留起账，此前业务不倒推）',
      });
    }
  });
  txn.immediate();
}

// 台账写入：必须在业务变更的同一事务内、且业务变更已应用之后调用。
// 笔后余额直接取该规格当前实物库存、净预留与瑕疵隔离余额（变更后的真实值），
// 因此同一规格逐笔按 id 顺序核对（上笔余额 + 本笔增减 = 本笔余额）恒成立。
// 铅条规格没有隔离量：deltaQuarantined 恒 0、balance_quarantined 恒 0。
function writeLedgerRow(e) {
  const d = getDb();
  let specName;
  let stock;
  let reserved;
  let quarantined = 0;
  if (e.materialType === 'lead') {
    const m = d.prepare('SELECT name, stock FROM lead_materials WHERE id = ?').get(e.specId);
    specName = m.name;
    stock = m.stock;
    reserved = leadNetReservedInTx(e.specId);
  } else {
    const s = d.prepare('SELECT color, stock, quarantined FROM glass_sheets WHERE id = ?').get(e.specId);
    specName = s.color;
    stock = s.stock;
    reserved = glassNetReservedInTx(e.specId);
    quarantined = s.quarantined;
  }
  d.prepare(`INSERT INTO stock_ledger
    (material_type, spec_id, spec_name, event_type, delta_stock, delta_reserved, delta_quarantined,
     balance_stock, balance_reserved, balance_quarantined, source_type, source_id, source_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.materialType, e.specId, specName, e.eventType,
      e.deltaStock, e.deltaReserved, e.deltaQuarantined || 0,
      stock, reserved, quarantined,
      e.sourceType, e.sourceId ?? null, e.sourceLabel);
}

// 旧库迁移：glass_sheets 补瑕疵隔离余额列 quarantined（默认 0；CHECK 非负）。
function migrateGlassQuarantine() {
  const cols = db.prepare('PRAGMA table_info(glass_sheets)').all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('quarantined')) {
    db.exec('ALTER TABLE glass_sheets ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0');
  }
}

// 旧库迁移：stock_ledger 早期没有 delta_quarantined / balance_quarantined 列，
// 且 event_type 的 CHECK 不含 quarantine_hold / quarantine_release。
// 按 SQLite 官方表重建流程改表（旧行两列回填 0；此前没有任何隔离流水，顺序核对仍成立）。
function migrateLedgerQuarantineColumns() {
  const existed = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='stock_ledger'").get();
  if (!existed) return; // 全新库：建表语句已含新列
  const cols = db.prepare('PRAGMA table_info(stock_ledger)').all().map((c) => c.name);
  if (cols.includes('delta_quarantined') && cols.includes('balance_quarantined')) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      ALTER TABLE stock_ledger RENAME TO stock_ledger_old;
      CREATE TABLE stock_ledger (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        material_type    TEXT    NOT NULL CHECK (material_type IN ('lead','glass')),
        spec_id          INTEGER NOT NULL,
        spec_name        TEXT    NOT NULL,
        event_type       TEXT    NOT NULL CHECK (event_type IN (
          'baseline','register','adjust',
          'plan_confirm','plan_cancel',
          'order_confirm','order_cancel',
          'replace_out','replace_in',
          'combo_confirm','combo_cancel',
          'stocktake','issue',
          'quarantine_hold','quarantine_release')),
        delta_stock      INTEGER NOT NULL,
        delta_reserved   INTEGER NOT NULL,
        delta_quarantined INTEGER NOT NULL DEFAULT 0,
        balance_stock    INTEGER NOT NULL,
        balance_reserved INTEGER NOT NULL,
        balance_quarantined INTEGER NOT NULL DEFAULT 0,
        source_type      TEXT    NOT NULL,
        source_id        INTEGER,
        source_label     TEXT    NOT NULL,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO stock_ledger
        (id, material_type, spec_id, spec_name, event_type,
         delta_stock, delta_reserved, delta_quarantined,
         balance_stock, balance_reserved, balance_quarantined,
         source_type, source_id, source_label, created_at)
      SELECT id, material_type, spec_id, spec_name, event_type,
         delta_stock, delta_reserved, 0,
         balance_stock, balance_reserved, 0,
         source_type, source_id, source_label, created_at
      FROM stock_ledger_old;
      DROP TABLE stock_ledger_old;
      CREATE INDEX idx_ledger_spec ON stock_ledger(material_type, spec_id, id);
      CREATE INDEX idx_ledger_time ON stock_ledger(created_at);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// 旧库迁移：stocktake_items 补 baseline_quarantined 列（玻璃盘点项的预览隔离基准）。
function migrateStocktakeQuarantineColumn() {
  const cols = db.prepare('PRAGMA table_info(stocktake_items)').all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('baseline_quarantined')) {
    db.exec('ALTER TABLE stocktake_items ADD COLUMN baseline_quarantined INTEGER NOT NULL DEFAULT 0');
  }
}

// 旧库迁移：stock_issues.issue_no 早期为 UNIQUE，重建为普通列 + 索引（唯一性改由写事务保证）。
function migrateStockIssues() {  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_issues'").get();
  if (!ddl || !/issue_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddl.sql || '')) return;
  db.exec(`
    ALTER TABLE stock_issues RENAME TO stock_issues_old;
    CREATE TABLE stock_issues (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_no        TEXT    NOT NULL,
      source_type     TEXT    NOT NULL CHECK (source_type IN ('lead_plan','cut_order','combo')),
      plan_id         INTEGER,
      order_id        INTEGER,
      combo_id        INTEGER,
      material_id     INTEGER,
      lead_bars       INTEGER NOT NULL DEFAULT 0 CHECK (lead_bars >= 0),
      sheet_id        INTEGER,
      sheet_color     TEXT,
      sheets_count    INTEGER NOT NULL DEFAULT 0 CHECK (sheets_count >= 0),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO stock_issues
      (id, issue_no, source_type, plan_id, order_id, combo_id, material_id, lead_bars,
       sheet_id, sheet_color, sheets_count, created_at)
    SELECT id, issue_no, source_type, plan_id, order_id, combo_id, material_id, lead_bars,
       sheet_id, sheet_color, sheets_count, created_at FROM stock_issues_old;
    DROP TABLE stock_issues_old;
    CREATE INDEX IF NOT EXISTS idx_issues_plan  ON stock_issues(plan_id);
    CREATE INDEX IF NOT EXISTS idx_issues_order ON stock_issues(order_id);
    CREATE INDEX IF NOT EXISTS idx_issues_combo ON stock_issues(combo_id);
    CREATE INDEX IF NOT EXISTS idx_issues_mat   ON stock_issues(material_id);
    CREATE INDEX IF NOT EXISTS idx_issues_sheet ON stock_issues(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_issues_no    ON stock_issues(issue_no);
  `);
}

// 为旧库补 combo_id 列（NULL = 独立计划/订单；非空 = 属于某整套单，受整单状态机约束）。
// 不建 FK 约束（整套单与关联单在同一事务内先后插入，且历史表不带该列），由应用层保证一致。
function migrateComboColumn(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('combo_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN combo_id INTEGER`);
  }
}

function migrateCutOrders() {
  const cols = db.prepare("PRAGMA table_info(cut_orders)").all().map((c) => c.name);
  if (cols.length === 0 || cols.includes('replaced_at')) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE cut_orders_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
        publication_id INTEGER NOT NULL REFERENCES publications(id),
        design_id     INTEGER NOT NULL,
        version       INTEGER NOT NULL,
        copies        INTEGER NOT NULL CHECK (copies > 0),
        gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
        total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
        layout        TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        confirmed_at  TEXT,
        canceled_at   TEXT,
        replaced_at   TEXT
      );
      INSERT INTO cut_orders_new
        (id, name, status, publication_id, design_id, version, copies, gap_mm, total_sheets,
         layout, created_at, updated_at, confirmed_at, canceled_at)
      SELECT id, name, status, publication_id, design_id, version, copies, gap_mm, total_sheets,
         layout, created_at, updated_at, confirmed_at, canceled_at
      FROM cut_orders;
      DROP TABLE cut_orders;
      ALTER TABLE cut_orders_new RENAME TO cut_orders;
      CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
      CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// ---------- designs ----------

function createDesign({ name, width, height }) {
  const info = getDb()
    .prepare('INSERT INTO designs (name, width_mm, height_mm) VALUES (?, ?, ?)')
    .run(name, width, height);
  return getDesign(info.lastInsertRowid);
}

function getDesign(id) {
  return getDb().prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

function listDesigns() {
  return getDb().prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pieces p WHERE p.design_id = d.id) AS piece_count,
      (SELECT MAX(version) FROM publications pu WHERE pu.design_id = d.id) AS latest_version
    FROM designs d ORDER BY d.id
  `).all();
}

// ---------- pieces ----------

function rowToPiece(row) {
  return {
    id: row.id,
    pieceNo: row.piece_no,
    color: row.color,
    polygon: JSON.parse(row.polygon),
    createdAt: row.created_at,
  };
}

function listPieces(designId) {
  return getDb()
    .prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
    .all(designId)
    .map(rowToPiece);
}

function getPiece(designId, pieceId) {
  const row = getDb()
    .prepare('SELECT * FROM pieces WHERE id = ? AND design_id = ?')
    .get(pieceId, designId);
  return row ? rowToPiece(row) : null;
}

function nextPieceNo(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
    .get(designId);
  return row.n;
}

function addPiece(designId, { color, polygon }) {
  const pieceNo = nextPieceNo(designId);
  const info = getDb()
    .prepare('INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)')
    .run(designId, pieceNo, color, JSON.stringify(polygon));
  touchDesign(designId);
  return getPiece(designId, info.lastInsertRowid);
}

function updatePiece(designId, pieceId, { color, polygon }) {
  const existing = getPiece(designId, pieceId);
  if (!existing) return null;
  getDb().prepare('UPDATE pieces SET color = ?, polygon = ? WHERE id = ? AND design_id = ?')
    .run(color, JSON.stringify(polygon), pieceId, designId);
  touchDesign(designId);
  return getPiece(designId, pieceId);
}

function deletePiece(designId, pieceId) {
  const info = getDb()
    .prepare('DELETE FROM pieces WHERE id = ? AND design_id = ?')
    .run(pieceId, designId);
  if (info.changes) touchDesign(designId);
  return info.changes > 0;
}

function replaceAllPieces(designId, pieces) {
  // 目前未使用；保留以便整单导入
  const tx = getDb().transaction((rows) => {
    getDb().prepare('DELETE FROM pieces WHERE design_id = ?').run(designId);
    for (const pc of rows) addPiece(designId, pc);
  });
  tx(pieces);
}

function touchDesign(designId) {
  getDb().prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?").run(designId);
}

// ---------- publications ----------

function publishVersion(designId, snapshot) {
  const next = nextVersion(designId);
  const info = getDb()
    .prepare('INSERT INTO publications (design_id, version, snapshot) VALUES (?, ?, ?)')
    .run(designId, next, JSON.stringify(snapshot));
  return getPublication(designId, info.lastInsertRowid);
}

function nextVersion(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE design_id = ?')
    .get(designId);
  return row.v;
}

function getPublication(designId, pubId) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE id = ? AND design_id = ?')
    .get(pubId, designId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function getPublicationByVersion(designId, version) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE design_id = ? AND version = ?')
    .get(designId, version);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function listPublications(designId) {
  return getDb()
    .prepare('SELECT id, version, published_at FROM publications WHERE design_id = ? ORDER BY version DESC')
    .all(designId)
    .map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
}

// ---------- 铅条原材 ----------

function rowToMaterial(row) {
  return {
    id: row.id,
    name: row.name,
    length: row.length_h / 100,          // 毫米
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各规格当前已被已确认计划预留的根数
function reservedMap() {
  const rows = getDb()
    .prepare(`SELECT material_id AS id, COALESCE(SUM(required_bars), 0) AS reserved
              FROM lead_plans WHERE status = 'confirmed' GROUP BY material_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listMaterials() {
  return getDb()
    .prepare('SELECT * FROM lead_materials ORDER BY id')
    .all()
    .map((r) => {
      const m = rowToMaterial(r);
      const used = reservedMap().get(r.id) || 0;
      const picked = leadPickedForMaterial(r.id);
      m.reserved = used - picked;       // 尚未领出的预留量（净预留）
      m.grossReserved = used;           // 已确认单预留总量
      m.picked = picked;                // 已领出根数
      m.remainingReserved = used - picked;
      m.available = m.stock - m.reserved;
      return m;
    });
}

function getMaterialRow(id) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(id);
}

function getMaterial(id) {
  const row = getMaterialRow(id);
  if (!row) return null;
  const m = rowToMaterial(row);
  const gross = getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(id).n;
  const picked = leadPickedForMaterial(id);
  m.grossReserved = gross;
  m.picked = picked;
  m.remainingReserved = gross - picked;
  m.reserved = gross - picked; // 尚未领出的预留量（净预留）
  m.available = m.stock - m.reserved;
  return m;
}

function getMaterialByName(name) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE name = ?').get(name) || null;
}

function createMaterial({ name, lengthH, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const info = d.prepare('INSERT INTO lead_materials (name, length_h, stock) VALUES (?, ?, ?)')
      .run(name, lengthH, stock);
    const id = info.lastInsertRowid;
    // 新登记规格从登记余额起记账
    writeLedgerRow({
      materialType: 'lead', specId: id, eventType: 'register',
      deltaStock: stock, deltaReserved: 0,
      sourceType: 'material', sourceId: id,
      sourceLabel: `登记铅条规格「${name}」（期初库存 ${stock} 根）`,
    });
    return id;
  });
  const id = txn.immediate();
  return getMaterial(id);
}

// 仅允许改名称与库存根数（定尺属于规格身份，改定尺请新建规格）。
// 库存校验在事务中完成：不得小于已预留根数，库存永不为负由 CHECK 兜底。
function updateMaterial(id, { name, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getMaterialRow(id);
    if (!row) return { code: 'not_found' };
    const gross = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(id).n;
    const reserved = gross - leadPickedForMaterial(id);
    if (stock !== undefined && stock < reserved) {
      return { code: 'stock_below_reserved', reserved };
    }
    if (name !== undefined) {
      const dup = d.prepare('SELECT id FROM lead_materials WHERE name = ? AND id <> ?').get(name, id);
      if (dup) return { code: 'name_taken' };
      d.prepare("UPDATE lead_materials SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    }
    if (stock !== undefined) {
      d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
      // 手工调库：仅库存实际变化时记台账（仅改名不产生流水）
      if (stock !== row.stock) {
        writeLedgerRow({
          materialType: 'lead', specId: id, eventType: 'adjust',
          deltaStock: stock - row.stock, deltaReserved: 0,
          sourceType: 'material', sourceId: id,
          sourceLabel: `手工调库「${name !== undefined ? name : row.name}」：库存 ${row.stock} → ${stock} 根`,
        });
      }
    }
    return { code: 'ok', material: getMaterial(id) };
  });
  return txn.immediate();
}

// ---------- 铅条生产计划 ----------

function getPublicationById(pubId) {
  const row = getDb().prepare('SELECT * FROM publications WHERE id = ?').get(pubId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function createPlan(p) {
  const info = getDb()
    .prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout));
  return getPlan(info.lastInsertRowid);
}

function getPlanRow(id) {
  return getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    materialId: row.material_id,
    materialName: row.material_name,
    materialLength: row.material_length_h / 100,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    requiredBars: row.required_bars,
    segmentCount: row.segment_count,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
    comboId: row.combo_id ?? null,
  };
}

function getPlan(id) {
  return rowToPlan(getPlanRow(id));
}

function listPlans() {
  return getDb().prepare('SELECT * FROM lead_plans ORDER BY id DESC').all().map(rowToPlan);
}

function updatePlanDraft(id, p) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
  getDb()
    .prepare(`UPDATE lead_plans SET
       name = ?, publication_id = ?, design_id = ?, version = ?, material_id = ?,
       material_name = ?, material_length_h = ?, copies = ?, kerf_h = ?,
       required_bars = ?, segment_count = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout), id);
  return { code: 'ok', plan: getPlan(id) };
}

// 确认：原子预留库存。BEGIN IMMEDIATE 取写锁，保证多个计划并发确认绝不超卖。
function confirmPlan(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getPlanRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: row.combo_id }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'plan_canceled' }; }

    const mat = getMaterialRow(row.material_id);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    // 规格定尺在建计划后被改动属于不支持的身份变更（当前接口禁止改定尺），双保险
    if (mat.length_h !== row.material_length_h) {
      d.exec('ROLLBACK'); return { code: 'material_changed' };
    }
    const gross = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(row.material_id).n;
    const available = mat.stock - (gross - leadPickedForMaterial(row.material_id));
    if (row.required_bars > available) {
      d.exec('ROLLBACK');
      return { code: 'shortage', available, required: row.required_bars, shortage: row.required_bars - available };
    }
    d.prepare(`UPDATE lead_plans
      SET status = 'confirmed', material_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(mat.name, id);
    writeLedgerRow({
      materialType: 'lead', specId: row.material_id, eventType: 'plan_confirm',
      deltaStock: 0, deltaReserved: row.required_bars,
      sourceType: 'lead_plan', sourceId: id,
      sourceLabel: `铅条计划 #${id}「${row.name}」确认：预留 ${row.required_bars} 根`,
    });
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认计划会释放预留；重复取消不会再次改变库存。
function cancelPlan(id) {
  const d = getDb();
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  if (planHasIssues(row.id)) return { code: 'already_issued', picked: leadPickedForPlan(row.id) };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    writeLedgerRow({
      materialType: 'lead', specId: row.material_id, eventType: 'plan_cancel',
      deltaStock: 0, deltaReserved: -row.required_bars,
      sourceType: 'lead_plan', sourceId: id,
      sourceLabel: `铅条计划 #${id}「${row.name}」取消：释放预留 ${row.required_bars} 根`,
    });
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deletePlan(id) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  getDb().prepare('DELETE FROM lead_plans WHERE id = ?').run(id);
  return { code: 'ok' };
}

// ---------- 彩色玻璃原片 ----------

function rowToGlassSheet(row, reserved = 0) {
  return {
    id: row.id,
    color: row.color,
    width: row.width_mm,
    height: row.height_mm,
    stock: row.stock,
    reserved,
    quarantined: row.quarantined || 0,          // 因瑕疵隔离的张数（实物仍在库）
    // 实际可用量：扣除尚未领出的净预留与瑕疵隔离量（实物库存不因隔离变化）
    available: row.stock - reserved - (row.quarantined || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各颜色已被已确认订单预留的张数（总量）
function glassReservedMap() {
  const rows = getDb()
    .prepare(`SELECT i.sheet_id AS id, COALESCE(SUM(i.required_sheets), 0) AS reserved
              FROM cut_order_items i
              JOIN cut_orders o ON o.id = i.order_id
              WHERE o.status = 'confirmed'
              GROUP BY i.sheet_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

// 各颜色已领出张数
function glassPickedMap() {
  const rows = getDb()
    .prepare(`SELECT sheet_id AS id, COALESCE(SUM(sheets_count),0) AS picked
              FROM stock_issues WHERE sheet_id IS NOT NULL GROUP BY sheet_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.picked);
  return m;
}

function listGlassSheets() {
  const reserved = glassReservedMap();
  const picked = glassPickedMap();
  return getDb().prepare('SELECT * FROM glass_sheets ORDER BY color').all()
    .map((r) => {
      const gross = reserved.get(r.id) || 0;
      const got = picked.get(r.id) || 0;
      const s = rowToGlassSheet(r, gross - got);
      s.grossReserved = gross;
      s.picked = got;
      s.remainingReserved = gross - got;
      return s;
    });
}

// 以颜色键取规格（含库存视图）
function glassSheetMapByColor() {
  const m = new Map();
  for (const s of listGlassSheets()) m.set(s.color, s);
  return m;
}

function getGlassSheetRow(id) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE id = ?').get(id);
}

function getGlassSheetByColorRow(color) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE color = ?').get(color);
}

function getGlassSheet(id) {
  const row = getGlassSheetRow(id);
  if (!row) return null;
  const gross = getDb()
    .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
              FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
              WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
  const picked = glassPickedForSheet(id);
  const s = rowToGlassSheet(row, gross - picked); // reserved=尚未领出的预留量（净预留）
  s.grossReserved = gross;
  s.picked = picked;
  s.remainingReserved = gross - picked;
  return s;
}

function createGlassSheet({ color, width, height, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const info = d.prepare('INSERT INTO glass_sheets (color, width_mm, height_mm, stock) VALUES (?, ?, ?, ?)')
      .run(color, width, height, stock);
    const id = info.lastInsertRowid;
    // 新登记规格从登记余额起记账
    writeLedgerRow({
      materialType: 'glass', specId: id, eventType: 'register',
      deltaStock: stock, deltaReserved: 0,
      sourceType: 'glass_sheet', sourceId: id,
      sourceLabel: `登记玻璃原片 ${color}（${width}×${height}mm，期初库存 ${stock} 张）`,
    });
    return id;
  });
  const id = txn.immediate();
  return getGlassSheet(id);
}

// 仅允许调整库存张数（颜色/宽高均属规格身份）；库存不得低于净预留与瑕疵隔离量之和。
function updateGlassSheetStock(id, stock) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getGlassSheetRow(id);
    if (!row) return { code: 'not_found' };
    const gross = d
      .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
                FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
                WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
    const reserved = gross - glassPickedForSheet(id);
    const floor = reserved + row.quarantined;
    if (stock < floor) {
      return { code: 'stock_below_reserved', reserved, quarantined: row.quarantined, floor };
    }
    d.prepare("UPDATE glass_sheets SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    // 手工调库：仅库存实际变化时记台账
    if (stock !== row.stock) {
      writeLedgerRow({
        materialType: 'glass', specId: id, eventType: 'adjust',
        deltaStock: stock - row.stock, deltaReserved: 0,
        sourceType: 'glass_sheet', sourceId: id,
        sourceLabel: `手工调库 ${row.color}：库存 ${row.stock} → ${stock} 张`,
      });
    }
    return { code: 'ok', sheet: getGlassSheet(id) };
  });
  return txn.immediate();
}

// ---------- 裁片订单 ----------

function rowToCutOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    gap: row.gap_mm,
    totalSheets: row.total_sheets,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
    replacedAt: row.replaced_at || null,
    comboId: row.combo_id ?? null,
  };
}

function getCutOrderRow(id) {
  return getDb().prepare('SELECT * FROM cut_orders WHERE id = ?').get(id);
}

function getCutOrder(id) {
  return rowToCutOrder(getCutOrderRow(id));
}

function listCutOrders() {
  return getDb().prepare('SELECT * FROM cut_orders ORDER BY id DESC').all().map(rowToCutOrder);
}

function listCutOrderItems(orderId) {
  return getDb().prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(orderId)
    .map((r) => ({
      sheetId: r.sheet_id,
      color: r.sheet_color,
      sheetWidth: r.sheet_width_mm,
      sheetHeight: r.sheet_height_mm,
      requiredSheets: r.required_sheets,
    }));
}

// 建草稿订单。items: [{sheetId,color,width,height,requiredSheets}]
function createCutOrder(o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const info = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout));
    const id = info.lastInsertRowid;
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return id;
  });
  const id = txn();
  return getCutOrder(id);
}

function updateCutOrderDraft(id, o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getCutOrderRow(id);
    if (!row) return { code: 'not_found' };
    if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
    if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
    d.prepare(`UPDATE cut_orders SET
       name = ?, publication_id = ?, design_id = ?, version = ?, copies = ?, gap_mm = ?,
       total_sheets = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout), id);
    d.prepare('DELETE FROM cut_order_items WHERE order_id = ?').run(id);
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return { code: 'ok', order: getCutOrder(id) };
  });
  return txn();
}

// 确认：在一个 BEGIN IMMEDIATE 事务中逐色核对并原子预留，任一颜色不足则整单失败。
function confirmCutOrder(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getCutOrderRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: row.combo_id }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }
    if (row.status === 'replaced') { d.exec('ROLLBACK'); return { code: 'order_replaced' }; }

    const items = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(id);
    const shortages = [];
    for (const it of items) {
      const sheet = getGlassSheetRow(it.sheet_id);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.sheet_color };
      }
      // 宽高身份双保险
      if (sheet.width_mm !== it.sheet_width_mm || sheet.height_mm !== it.sheet_height_mm) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.sheet_color };
      }
      const gross = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheet_id).n;
      // 新单可预留量 = 实物库存 − 净预留 − 瑕疵隔离量
      const available = sheet.stock - (gross - glassPickedForSheet(it.sheet_id)) - sheet.quarantined;
      if (it.required_sheets > available) {
        shortages.push({
          color: it.sheet_color,
          required: it.required_sheets,
          available,
          shortage: it.required_sheets - available,
        });
      }
    }
    if (shortages.length) {
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }
    d.prepare(`UPDATE cut_orders
      SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(id);
    for (const it of items) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheet_id, eventType: 'order_confirm',
        deltaStock: 0, deltaReserved: it.required_sheets,
        sourceType: 'cut_order', sourceId: id,
        sourceLabel: `裁片订单 #${id}「${row.name}」确认：${it.sheet_color} 预留 ${it.required_sheets} 张`,
      });
    }
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认订单释放预留；重复取消不会再次改库存。
function cancelCutOrder(id) {
  const d = getDb();
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  if (row.status === 'replaced') return { code: 'order_replaced' };
  if (orderHasIssues(row.id)) return { code: 'already_issued' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE cut_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    const items = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(id);
    for (const it of items) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheet_id, eventType: 'order_cancel',
        deltaStock: 0, deltaReserved: -it.required_sheets,
        sourceType: 'cut_order', sourceId: id,
        sourceLabel: `裁片订单 #${id}「${row.name}」取消：${it.sheet_color} 释放预留 ${it.required_sheets} 张`,
      });
    }
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deleteCutOrder(id) {
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.combo_id) return { code: 'combo_locked', comboId: row.combo_id };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  if (row.status === 'replaced') return { code: 'replaced_delete_blocked' };
  getDb().prepare('DELETE FROM cut_orders WHERE id = ?').run(id); // 子表 ON DELETE CASCADE
  return { code: 'ok' };
}

// ---------- 裁片订单换单（已确认旧单 → 同一图纸另一已发布版本的新单） ----------

function getReplacementByOldOrder(oldOrderId) {
  return getDb()
    .prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?')
    .get(oldOrderId) || null;
}

function getReplacementByNewOrder(newOrderId) {
  return getDb()
    .prepare('SELECT * FROM cut_order_replacements WHERE new_order_id = ?')
    .get(newOrderId) || null;
}

// 换单：一个 BEGIN IMMEDIATE 事务内
//   1) 旧单必须仍为 confirmed 且尚未换过；
//   2) 按“释放旧单预留后的库存”逐色核对新单（旧单本身的预留不再占库存）；
//   3) 任一颜色不足 → 回滚，旧单、库存、订单记录全部保持原状并返回各色缺口；
//   4) 充足 → 创建即 confirmed 的新单、旧单置为 replaced（同一原子提交）、写换单记录。
// 幂等：同旧单已有换单记录时，参数一致返回原新单（idempotent）；不一致返回 param_conflict。
// 参数 o: { name, targetPublicationId, designId, version, copies, gap, totalSheets, layout, items }
function replaceCutOrder(oldId, o) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const oldRow = getCutOrderRow(oldId);
    if (!oldRow) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (oldRow.combo_id) { d.exec('ROLLBACK'); return { code: 'combo_locked', comboId: oldRow.combo_id }; }

    // 已换过（旧单此时为 replaced）：相同参数幂等返回原新单；不同参数冲突。
    // 必须先于状态检查，保证“对同一旧单按相同参数重试返回原新单”。
    const existing = d
      .prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?')
      .get(oldId);
    if (existing) {
      d.exec('ROLLBACK');
      const same = existing.target_publication_id === o.targetPublicationId &&
        existing.copies === o.copies && existing.gap_mm === o.gap;
      if (!same) {
        return {
          code: 'param_conflict',
          newOrderId: existing.new_order_id,
          current: {
            targetPublicationId: existing.target_publication_id,
            copies: existing.copies,
            gap: existing.gap_mm,
          },
        };
      }
      return { code: 'idempotent', order: getCutOrder(existing.new_order_id) };
    }

    if (oldRow.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }
    if (oldRow.status === 'draft') { d.exec('ROLLBACK'); return { code: 'order_not_confirmed' }; }
    if (oldRow.status !== 'confirmed') { d.exec('ROLLBACK'); return { code: 'order_replaced' }; }
    // 已领料的独立裁片订单不能换单（已领实物不可逆）
    if (orderHasIssues(oldId)) {
      d.exec('ROLLBACK');
      return { code: 'already_issued' };
    }

    // 逐色核对：把旧单视为即将释放，故可用量 = stock − 其他已确认单预留 + 旧单自身预留
    const shortages = [];
    for (const it of o.items) {
      const sheet = getGlassSheetRow(it.sheetId);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.color };
      }
      if (sheet.width_mm !== it.width || sheet.height_mm !== it.height) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.color };
      }
      const reservedOther = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed' AND co.id <> ?`)
        .get(it.sheetId, oldId).n;
      // 旧单视为即将释放；瑕疵隔离量仍须扣除（隔离不因换单变化）
      const availableAfterRelease = sheet.stock - reservedOther - sheet.quarantined;
      if (it.requiredSheets > availableAfterRelease) {
        shortages.push({
          color: it.color,
          required: it.requiredSheets,
          oldReserved: 0, // 下方统一回填旧单该色预留
          available: availableAfterRelease,
          shortage: it.requiredSheets - availableAfterRelease,
        });
      }
    }
    if (shortages.length) {
      // 回填旧单各色预留与净增减，便于客户端展示
      const oldItems = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ?').all(oldId);
      const oldByColor = new Map(oldItems.map((it) => [it.sheet_color, it.required_sheets]));
      for (const s of shortages) s.oldReserved = oldByColor.get(s.color) || 0;
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }

    // 旧单先退出预留（置为 replaced；原子提交前任何失败都整体回滚）。
    // 台账按“先释放旧单、再记新单”的顺序写入，保证同一颜色两笔流水的笔后余额可顺序核对。
    const rel = d.prepare(`UPDATE cut_orders
      SET status = 'replaced', replaced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(oldId);
    if (rel.changes !== 1) {
      throw new Error('旧单状态在事务内发生意外变化');
    }
    const oldItems = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(oldId);
    for (const it of oldItems) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheet_id, eventType: 'replace_out',
        deltaStock: 0, deltaReserved: -it.required_sheets,
        sourceType: 'cut_order', sourceId: oldId,
        sourceLabel: `裁片订单 #${oldId} 换单退出：${it.sheet_color} 释放预留 ${it.required_sheets} 张`,
      });
    }

    // 创建新单（即 confirmed）
    const ins = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout, confirmed_at)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    const info = ins.run(o.name, o.targetPublicationId, o.designId, o.version,
      o.copies, o.gap, o.totalSheets, JSON.stringify(o.layout));
    const newId = info.lastInsertRowid;
    const insItem = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      insItem.run(newId, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    for (const it of o.items) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheetId, eventType: 'replace_in',
        deltaStock: 0, deltaReserved: it.requiredSheets,
        sourceType: 'cut_order', sourceId: newId,
        sourceLabel: `裁片订单 #${newId} 换单接替（旧单 #${oldId}）：${it.color} 预留 ${it.requiredSheets} 张`,
      });
    }

    d.prepare(`INSERT INTO cut_order_replacements
      (old_order_id, new_order_id, target_publication_id, copies, gap_mm)
      VALUES (?, ?, ?, ?, ?)`).run(oldId, newId, o.targetPublicationId, o.copies, o.gap);

    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(newId), newOrderId: newId };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 整套用料单（铅条 + 玻璃 同一事务一次性核验并预留） ----------

function rowToComboOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    requestKey: row.request_key,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    gap: row.gap_mm,
    materialId: row.material_id,
    requiredBars: row.required_bars,
    totalSheets: row.total_sheets,
    leadPlanId: row.lead_plan_id,
    cutOrderId: row.cut_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canceledAt: row.canceled_at || null,
  };
}

function getComboOrderRow(id) {
  return getDb().prepare('SELECT * FROM combo_orders WHERE id = ?').get(id);
}

function getComboOrder(id) {
  return rowToComboOrder(getComboOrderRow(id));
}

function getComboOrderByRequestKey(requestKey) {
  const row = getDb().prepare('SELECT * FROM combo_orders WHERE request_key = ?').get(requestKey);
  return row ? rowToComboOrder(row) : null;
}

function listComboOrders() {
  return getDb().prepare('SELECT * FROM combo_orders ORDER BY id DESC').all().map(rowToComboOrder);
}

// 确认整套单：一个 BEGIN IMMEDIATE 事务内
//   1) request_key 已存在：参数一致幂等返回原单；不一致返回 request_conflict；
//   2) 铅条原材：定尺身份核对 + 库存核对；
//   3) 玻璃各色：规格宽高身份核对 + 逐色库存核对；
//   4) 任一不足 → 回滚，两类库存、任何记录全部保持原状，返回铅条/各色缺口；
//   5) 充足 → 创建即 confirmed 的关联生产计划、关联裁片订单（含分色项）与整套单，原子提交。
// 参数 c:
//   { name, requestKey, publicationId, designId, version, copies, kerfH, gap,
//     materialId, materialName, materialLengthH, requiredBars, segmentCount, leadLayout,
//     totalSheets, nestLayout, items }
function createComboOrder(c) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    // 幂等 / 冲突（不重复排样、不重复预留）
    const dup = d.prepare('SELECT * FROM combo_orders WHERE request_key = ?').get(c.requestKey);
    if (dup) {
      d.exec('ROLLBACK');
      const same = dup.publication_id === c.publicationId &&
        dup.material_id === c.materialId &&
        dup.copies === c.copies && dup.kerf_h === c.kerfH && dup.gap_mm === c.gap;
      if (!same) {
        return {
          code: 'request_conflict',
          comboId: dup.id,
          current: {
            publicationId: dup.publication_id, materialId: dup.material_id,
            copies: dup.copies, kerf: dup.kerf_h / 100, gap: dup.gap_mm,
          },
        };
      }
      return { code: 'idempotent', combo: rowToComboOrder(dup) };
    }

    // ---- 铅条：身份与库存 ----
    const mat = getMaterialRow(c.materialId);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    if (mat.length_h !== c.materialLengthH) { d.exec('ROLLBACK'); return { code: 'material_changed' }; }
    const leadGross = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(c.materialId).n;
    const leadAvailable = mat.stock - (leadGross - leadPickedForMaterial(c.materialId));
    if (c.requiredBars > leadAvailable) {
      d.exec('ROLLBACK');
      return {
        code: 'shortage',
        lead: { required: c.requiredBars, available: leadAvailable, shortage: c.requiredBars - leadAvailable },
        glass: [],
      };
    }

    // ---- 玻璃：逐色身份与库存 ----
    const glassShortages = [];
    for (const it of c.items) {
      const sheet = getGlassSheetRow(it.sheetId);
      if (!sheet) { d.exec('ROLLBACK'); return { code: 'sheet_missing', color: it.color }; }
      if (sheet.width_mm !== it.width || sheet.height_mm !== it.height) {
        d.exec('ROLLBACK'); return { code: 'sheet_changed', color: it.color };
      }
      const gross = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheetId).n;
      // 新单可预留量 = 实物库存 − 净预留 − 瑕疵隔离量
      const available = sheet.stock - (gross - glassPickedForSheet(it.sheetId)) - sheet.quarantined;
      if (it.requiredSheets > available) {
        glassShortages.push({
          color: it.color, required: it.requiredSheets,
          available, shortage: it.requiredSheets - available,
        });
      }
    }
    if (glassShortages.length) {
      d.exec('ROLLBACK');
      return {
        code: 'shortage',
        lead: { required: c.requiredBars, available: leadAvailable, shortage: 0 },
        glass: glassShortages,
      };
    }

    // ---- 充足：创建关联生产计划（即 confirmed） ----
    const planInfo = d.prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout, confirmed_at, combo_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`)
      .run(c.leadName, c.publicationId, c.designId, c.version, c.materialId,
        c.materialName, c.materialLengthH, c.copies, c.kerfH, c.requiredBars,
        c.segmentCount, JSON.stringify(c.leadLayout));
    const planId = planInfo.lastInsertRowid;

    // ---- 创建关联裁片订单（即 confirmed） ----
    const orderInfo = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout, confirmed_at, combo_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)`)
      .run(c.orderName, c.publicationId, c.designId, c.version, c.copies, c.gap,
        c.totalSheets, JSON.stringify(c.nestLayout));
    const orderId = orderInfo.lastInsertRowid;

    const insItem = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of c.items) {
      insItem.run(orderId, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }

    // ---- 整套单（回填两个关联 id） ----
    const comboInfo = d.prepare(`INSERT INTO combo_orders
      (name, status, request_key, publication_id, design_id, version, copies, kerf_h, gap_mm,
       material_id, required_bars, total_sheets, lead_plan_id, cut_order_id)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.name, c.requestKey, c.publicationId, c.designId, c.version,
        c.copies, c.kerfH, c.gap, c.materialId, c.requiredBars, c.totalSheets, planId, orderId);
    const comboId = comboInfo.lastInsertRowid;

    d.prepare('UPDATE lead_plans SET combo_id = ? WHERE id = ?').run(comboId, planId);
    d.prepare('UPDATE cut_orders SET combo_id = ? WHERE id = ?').run(comboId, orderId);

    // 台账：整套单确认（铅条 + 各色玻璃 同一事务）
    writeLedgerRow({
      materialType: 'lead', specId: c.materialId, eventType: 'combo_confirm',
      deltaStock: 0, deltaReserved: c.requiredBars,
      sourceType: 'combo', sourceId: comboId,
      sourceLabel: `整套单 #${comboId}「${c.name}」确认：铅条预留 ${c.requiredBars} 根（关联计划 #${planId}）`,
    });
    for (const it of c.items) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheetId, eventType: 'combo_confirm',
        deltaStock: 0, deltaReserved: it.requiredSheets,
        sourceType: 'combo', sourceId: comboId,
        sourceLabel: `整套单 #${comboId}「${c.name}」确认：${it.color} 预留 ${it.requiredSheets} 张（关联订单 #${orderId}）`,
      });
    }

    d.exec('COMMIT');
    return { code: 'ok', combo: getComboOrder(comboId) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消整套单：同一事务把关联生产计划与裁片订单同时置为 canceled，
// 两类预留各释放一次；重复取消不重复变更库存。
function cancelComboOrder(id) {
  const d = getDb();
  const row = getComboOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  if (getDb().prepare('SELECT 1 AS x FROM stock_issues WHERE combo_id = ? LIMIT 1').get(id)) {
    return { code: 'already_issued' };
  }
  d.exec('BEGIN IMMEDIATE');
  try {
    // 事务内重读状态，防止并发重复取消/并发领料
    const cur = d.prepare('SELECT * FROM combo_orders WHERE id = ?').get(id);
    if (cur.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'already_canceled' }; }
    if (d.prepare('SELECT 1 AS x FROM stock_issues WHERE combo_id = ? LIMIT 1').get(id)) {
      d.exec('ROLLBACK');
      return { code: 'already_issued' };
    }

    const pn = d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND combo_id = ? AND status = 'confirmed'`).run(cur.lead_plan_id, id);
    const on = d.prepare(`UPDATE cut_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND combo_id = ? AND status = 'confirmed'`).run(cur.cut_order_id, id);
    if (pn.changes !== 1 || on.changes !== 1) {
      throw new Error('整套单关联记录状态异常，取消已回滚');
    }
    d.prepare(`UPDATE combo_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`).run(id);
    // 台账：整套单取消（铅条 + 各色玻璃 各释放一次）
    const planRow = getPlanRow(cur.lead_plan_id);
    writeLedgerRow({
      materialType: 'lead', specId: planRow.material_id, eventType: 'combo_cancel',
      deltaStock: 0, deltaReserved: -cur.required_bars,
      sourceType: 'combo', sourceId: id,
      sourceLabel: `整套单 #${id}「${cur.name}」取消：铅条释放预留 ${cur.required_bars} 根`,
    });
    const comboItems = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(cur.cut_order_id);
    for (const it of comboItems) {
      writeLedgerRow({
        materialType: 'glass', specId: it.sheet_id, eventType: 'combo_cancel',
        deltaStock: 0, deltaReserved: -it.required_sheets,
        sourceType: 'combo', sourceId: id,
        sourceLabel: `整套单 #${id}「${cur.name}」取消：${it.sheet_color} 释放预留 ${it.required_sheets} 张`,
      });
    }
    d.exec('COMMIT');
    return { code: 'ok', combo: getComboOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 库存盘点（铅条 + 玻璃 同一张盘点单） ----------

function rowToStocktake(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
  };
}

function getStocktakeRow(id) {
  return getDb().prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
}

function getStocktake(id) {
  return rowToStocktake(getStocktakeRow(id));
}

function listStocktakes() {
  return getDb().prepare('SELECT * FROM stocktakes ORDER BY id DESC').all().map(rowToStocktake);
}

function listStocktakeItemRows(stocktakeId) {
  return getDb()
    .prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ? ORDER BY id')
    .all(stocktakeId);
}

// 单规格当前“尚未领出的预留量”（净预留 = 已确认预留 − 已领出；独立单与整套单同一口径）。
function leadReservedFor(materialId) {
  return getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(materialId).n - leadPickedForMaterial(materialId);
}

function glassReservedFor(sheetId) {
  return getDb()
    .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
              FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
              WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(sheetId).n
    - glassPickedForSheet(sheetId);
}

// 生成某一项的预览基准（系统库存、已确认预留、规格身份快照）。
// 规格不存在返回 { code:'not_found' }。
function stocktakeBaseline(type, specId) {
  if (type === 'lead') {
    const m = getMaterialRow(specId);
    if (!m) return { code: 'not_found' };
    return {
      specName: m.name, specLengthH: m.length_h,
      specWidthMm: null, specHeightMm: null,
      stock: m.stock, reserved: leadReservedFor(specId),
    };
  }
  const s = getGlassSheetRow(specId);
  if (!s) return { code: 'not_found' };
  return {
    specName: s.color, specLengthH: null,
    specWidthMm: s.width_mm, specHeightMm: s.height_mm,
    stock: s.stock, reserved: glassReservedFor(specId),
    quarantined: s.quarantined,
  };
}

// 建草稿盘点单并固化各项预览基准（同一事务）。
// items: [{type:'lead'|'glass', specId, counted}]（调用方已校验非空、不重复、实盘非负整数）。
function createStocktake({ name, items }) {
  const d = getDb();
  const txn = d.transaction(() => {
    // 取基准（事务内）；规格不存在或同单重复均整体拒绝，不落任何记录
    const rows = items.map((it) => {
      const b = stocktakeBaseline(it.type, it.specId);
      if (b.code === 'not_found') {
        return { fail: { code: 'not_found', type: it.type, specId: it.specId } };
      }
      return { ...it, ...b };
    });
    const failed = rows.find((r) => r.fail);
    if (failed) return failed.fail;

    const info = d.prepare("INSERT INTO stocktakes (name, status) VALUES (?, 'draft')").run(name);
    const id = info.lastInsertRowid;
    const ins = d.prepare(`INSERT INTO stocktake_items
      (stocktake_id, type, spec_id, spec_name, spec_length_h, spec_width_mm, spec_height_mm,
       baseline_stock, baseline_reserved, baseline_quarantined, counted_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(id, r.type, r.specId, r.specName, r.specLengthH, r.specWidthMm, r.specHeightMm,
        r.stock, r.reserved, r.quarantined || 0, r.counted);
    }
    return { code: 'ok', id };
  });
  return txn.immediate();
}

// 修改草稿盘点单（换规格/改实盘数）：按新的项重新固化预览基准。
// 已确认盘点单不可修改；草稿删除后重写全部项。
function updateStocktakeDraft(id, { name, items }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getStocktakeRow(id);
    if (!row) return { code: 'not_found' };
    if (row.status === 'confirmed') return { code: 'already_confirmed' };

    const rows = items.map((it) => {
      const b = stocktakeBaseline(it.type, it.specId);
      if (b.code === 'not_found') {
        return { fail: { code: 'not_found', type: it.type, specId: it.specId } };
      }
      return { ...it, ...b };
    });
    const failed = rows.find((r) => r.fail);
    if (failed) return failed.fail;

    d.prepare("UPDATE stocktakes SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    d.prepare('DELETE FROM stocktake_items WHERE stocktake_id = ?').run(id);
    const ins = d.prepare(`INSERT INTO stocktake_items
      (stocktake_id, type, spec_id, spec_name, spec_length_h, spec_width_mm, spec_height_mm,
       baseline_stock, baseline_reserved, baseline_quarantined, counted_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      ins.run(id, r.type, r.specId, r.specName, r.specLengthH, r.specWidthMm, r.specHeightMm,
        r.stock, r.reserved, r.quarantined || 0, r.counted);
    }
    return { code: 'ok' };
  });
  return txn.immediate();
}

// 确认盘点：一个 BEGIN IMMEDIATE 事务内对所有项重核库存与预留：
//   1) 规格必须仍存在（spec_missing）、规格身份未变（spec_changed：铅条定尺/玻璃宽高）；
//   2) 当前系统库存必须与预览基准一致（stock_changed）；
//   3) 当前已确认预留必须与预览基准一致（reserved_changed）；
//   4) 实盘数不得低于当前预留（below_reserved）；
// 任一项不符即整单不生效（返回全部问题项及原因），全部通过才一次更新各规格库存并置为已确认。
// 已确认单重复确认幂等返回原单（idempotent），不再调整库存。
function confirmStocktake(id) {
  const d = getDb();
  const row = getStocktakeRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'idempotent' };

  d.exec('BEGIN IMMEDIATE');
  try {
    const cur = getStocktakeRow(id);
    if (!cur) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (cur.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'idempotent' }; }

    const itemRows = listStocktakeItemRows(id);
    const problems = [];
    for (const it of itemRows) {
      if (it.type === 'lead') {
        const m = getMaterialRow(it.spec_id);
        if (!m) { problems.push(problem(it, 'spec_missing', '规格已不存在')); continue; }
        if (m.length_h !== it.spec_length_h) {
          problems.push(problem(it, 'spec_changed', '原材定尺与预览基准不一致'));
          continue;
        }
        const reserved = leadReservedFor(it.spec_id);
        if (m.stock !== it.baseline_stock) {
          problems.push(problem(it, 'stock_changed', '系统库存与预览基准不一致（预览后库存已变动）',
            { currentStock: m.stock, currentReserved: reserved }));
          continue;
        }
        if (reserved !== it.baseline_reserved) {
          problems.push(problem(it, 'reserved_changed', '已确认预留与预览基准不一致（预览后有计划/订单确认或取消）',
            { currentStock: m.stock, currentReserved: reserved }));
          continue;
        }
        if (it.counted_stock < reserved) {
          problems.push(problem(it, 'below_reserved', '实盘数低于当前已确认预留，不能按此盘点',
            { currentStock: m.stock, currentReserved: reserved }));
        }
      } else {
        const s = getGlassSheetRow(it.spec_id);
        if (!s) { problems.push(problem(it, 'spec_missing', '颜色原片规格已不存在')); continue; }
        if (s.width_mm !== it.spec_width_mm || s.height_mm !== it.spec_height_mm) {
          problems.push(problem(it, 'spec_changed', '原片宽高与预览基准不一致'));
          continue;
        }
        const reserved = glassReservedFor(it.spec_id);
        const quarantined = s.quarantined;
        if (s.stock !== it.baseline_stock) {
          problems.push(problem(it, 'stock_changed', '系统库存与预览基准不一致（预览后库存已变动）',
            { currentStock: s.stock, currentReserved: reserved, currentQuarantined: quarantined }));
          continue;
        }
        if (reserved !== it.baseline_reserved) {
          problems.push(problem(it, 'reserved_changed', '已确认预留与预览基准不一致（预览后有订单确认或取消）',
            { currentStock: s.stock, currentReserved: reserved, currentQuarantined: quarantined }));
          continue;
        }
        if (quarantined !== (it.baseline_quarantined || 0)) {
          problems.push(problem(it, 'quarantined_changed', '瑕疵隔离量与预览基准不一致（预览后有隔离/解除操作）',
            {
              baselineQuarantined: it.baseline_quarantined || 0,
              currentStock: s.stock, currentReserved: reserved, currentQuarantined: quarantined,
            }));
          continue;
        }
        if (it.counted_stock < reserved + quarantined) {
          problems.push(problem(it, 'below_reserved', '实盘数低于当前净预留与隔离量之和，不能按此盘点',
            { currentStock: s.stock, currentReserved: reserved, currentQuarantined: quarantined }));
        }
      }
    }
    if (problems.length) {
      d.exec('ROLLBACK');
      return { code: 'baseline_mismatch', items: problems };
    }

    // 全部通过：一次更新各规格库存（独立计划、裁片订单与整套单随后按盘点后库存计算可用量）
    for (const it of itemRows) {
      if (it.type === 'lead') {
        d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?")
          .run(it.counted_stock, it.spec_id);
      } else {
        d.prepare("UPDATE glass_sheets SET stock = ?, updated_at = datetime('now') WHERE id = ?")
          .run(it.counted_stock, it.spec_id);
      }
      // 台账：盘点确认（实物库存按实盘数调整；确认时已重核当前库存等于预览基准）
      writeLedgerRow({
        materialType: it.type, specId: it.spec_id, eventType: 'stocktake',
        deltaStock: it.counted_stock - it.baseline_stock, deltaReserved: 0,
        sourceType: 'stocktake', sourceId: id,
        sourceLabel: `盘点单 #${id}「${cur.name}」确认：${it.spec_name} 实盘 ${it.counted_stock}（原系统库存 ${it.baseline_stock}）`,
      });
    }
    d.prepare(`UPDATE stocktakes SET status = 'confirmed', confirmed_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?`).run(id);
    d.exec('COMMIT');
    return { code: 'ok' };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function problem(it, reason, message, extra = {}) {
  return {
    itemId: it.id,
    type: it.type,
    specId: it.spec_id,
    reason,
    message,
    baselineStock: it.baseline_stock,
    baselineReserved: it.baseline_reserved,
    countedStock: it.counted_stock,
    ...extra,
  };
}

// 删除盘点单：仅草稿可删（已确认为永久记录，仅可查阅）。
function deleteStocktake(id) {
  const row = getStocktakeRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  const d = getDb();
  const txn = d.transaction(() => {
    d.prepare('DELETE FROM stocktake_items WHERE stocktake_id = ?').run(id);
    d.prepare('DELETE FROM stocktakes WHERE id = ?').run(id);
  });
  txn();
  return { code: 'ok' };
}

// ---------- 领料（按已确认的独立计划 / 独立裁片订单 / 整套单分次领料） ----------
//
// 口径：领料确认时在同一事务内同时
//   1) 扣减实物库存 lead_materials.stock / glass_sheets.stock；
//   2) 记录不可变领料行 stock_issues（只追加，从不更新/删除）。
// “尚未领出的预留量（净预留）” = 已确认单预留总量 − 已领出量；新确认/盘点/手工调库
// 一律按净预留计算，因此领料不改变其他单据可再预留的可用量。

function getIssueRowsByNo(issueNo) {
  return getDb().prepare('SELECT * FROM stock_issues WHERE issue_no = ? ORDER BY id').all(issueNo);
}

function listIssueRows(filter = {}) {
  const where = [];
  const args = [];
  if (filter.planId) { where.push('plan_id = ?'); args.push(filter.planId); }
  if (filter.orderId) { where.push('order_id = ?'); args.push(filter.orderId); }
  if (filter.comboId) { where.push('combo_id = ?'); args.push(filter.comboId); }
  const sql = 'SELECT * FROM stock_issues' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC';
  return getDb().prepare(sql).all(...args);
}

function listAllIssueRows() {
  // 按领料号分组时倒序取
  return getDb().prepare('SELECT * FROM stock_issues ORDER BY id DESC').all();
}

// 某铅条规格已领出根数
function leadPickedForMaterial(materialId) {
  return getDb()
    .prepare('SELECT COALESCE(SUM(lead_bars),0) AS n FROM stock_issues WHERE material_id = ?')
    .get(materialId).n;
}

// 某玻璃原片规格已领出张数
function glassPickedForSheet(sheetId) {
  return getDb()
    .prepare('SELECT COALESCE(SUM(sheets_count),0) AS n FROM stock_issues WHERE sheet_id = ?')
    .get(sheetId).n;
}

// 某铅条计划（含整套关联计划）已领出根数
function leadPickedForPlan(planId) {
  return getDb()
    .prepare('SELECT COALESCE(SUM(lead_bars),0) AS n FROM stock_issues WHERE plan_id = ?')
    .get(planId).n;
}

// 某裁片订单某颜色已领出张数
function glassPickedForOrderSheet(orderId, sheetId) {
  return getDb()
    .prepare('SELECT COALESCE(SUM(sheets_count),0) AS n FROM stock_issues WHERE order_id = ? AND sheet_id = ?')
    .get(orderId, sheetId).n;
}

function orderHasIssues(orderId) {
  return getDb()
    .prepare('SELECT 1 AS x FROM stock_issues WHERE order_id = ? LIMIT 1')
    .get(orderId) !== undefined;
}

function planHasIssues(planId) {
  return getDb()
    .prepare('SELECT 1 AS x FROM stock_issues WHERE plan_id = ? LIMIT 1')
    .get(planId) !== undefined;
}

// 从一组同号领料行归纳“内容”（用于幂等/冲突比较）：
// { sourceType, planId, orderId, comboId, leadBars, glass: Map(sheetId -> count) }
function issueContentFromRows(rows) {
  const first = rows[0];
  let leadBars = 0;
  const glass = new Map();
  for (const r of rows) {
    leadBars += r.lead_bars;
    if (r.sheet_id !== null) glass.set(r.sheet_id, (glass.get(r.sheet_id) || 0) + r.sheets_count);
  }
  return {
    sourceType: first.source_type,
    planId: first.plan_id,
    orderId: first.order_id,
    comboId: first.combo_id,
    leadBars,
    glass,
  };
}

function issueContentEqual(rows, p) {
  const c = issueContentFromRows(rows);
  if (c.sourceType !== p.sourceType) return false;
  // 整套单以 comboId 为准（行内 plan_id/order_id 为服务端解析的关联单，入参不带）
  if (p.sourceType === 'combo') {
    if (c.comboId !== (p.comboId ?? null)) return false;
  } else if (c.planId !== (p.planId ?? null) || c.orderId !== (p.orderId ?? null)) {
    return false;
  }
  if (c.leadBars !== p.leadBars) return false;
  const want = new Map();
  for (const g of p.glass) want.set(g.sheetId, (want.get(g.sheetId) || 0) + g.count);
  if (c.glass.size !== want.size) return false;
  for (const [sid, n] of want) {
    if (c.glass.get(sid) !== n) return false;
  }
  return true;
}

// 领料确认：一个 BEGIN IMMEDIATE 事务内
//   1) 同领料号已存在 → 内容相同幂等返回；不同返回 issue_no_conflict；
//   2) 单据必须为已确认（独立计划/订单 combo_id 必须为空；整套单 status=confirmed）；
//   3) 数量逐项不得超过该单剩余预留（本次可为 0，整套单允许只领一类）；
//   4) 同事务扣减实物库存并追加不可变领料行；任一项不合法整体回滚。
// p: { issueNo, sourceType:'lead_plan'|'cut_order'|'combo',
//      planId?, orderId?, comboId?, leadBars:integer, glass:[{sheetId,color,count}] }
function createStockIssue(p) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    // ---- 幂等 / 冲突 ----
    const dupRows = d.prepare('SELECT * FROM stock_issues WHERE issue_no = ?').all(p.issueNo);
    if (dupRows.length) {
      d.exec('ROLLBACK');
      if (!issueContentEqual(dupRows, p)) {
        return { code: 'issue_no_conflict', existing: issueContentFromRows(dupRows) };
      }
      return { code: 'idempotent', issueNo: p.issueNo };
    }

    // ---- 解析领料来源 ----
    let planRow = null;
    let orderRow = null;
    let comboRow = null;
    if (p.sourceType === 'lead_plan') {
      planRow = getPlanRow(p.planId);
      if (!planRow) { d.exec('ROLLBACK'); return { code: 'not_found', kind: 'plan' }; }
      if (planRow.combo_id) { d.exec('ROLLBACK'); return { code: 'issue_use_combo', comboId: planRow.combo_id }; }
      if (planRow.status !== 'confirmed') {
        d.exec('ROLLBACK');
        return { code: 'source_not_confirmed', kind: 'plan', status: planRow.status };
      }
    } else if (p.sourceType === 'cut_order') {
      orderRow = getCutOrderRow(p.orderId);
      if (!orderRow) { d.exec('ROLLBACK'); return { code: 'not_found', kind: 'order' }; }
      if (orderRow.combo_id) { d.exec('ROLLBACK'); return { code: 'issue_use_combo', comboId: orderRow.combo_id }; }
      if (orderRow.status !== 'confirmed') {
        d.exec('ROLLBACK');
        return { code: 'source_not_confirmed', kind: 'order', status: orderRow.status };
      }
    } else {
      comboRow = getComboOrderRow(p.comboId);
      if (!comboRow) { d.exec('ROLLBACK'); return { code: 'not_found', kind: 'combo' }; }
      if (comboRow.status !== 'confirmed') {
        d.exec('ROLLBACK');
        return { code: 'source_not_confirmed', kind: 'combo', status: comboRow.status };
      }
      planRow = getPlanRow(comboRow.lead_plan_id);
      orderRow = getCutOrderRow(comboRow.cut_order_id);
      if (!planRow || !orderRow || planRow.status !== 'confirmed' || orderRow.status !== 'confirmed') {
        d.exec('ROLLBACK');
        return { code: 'combo_links_broken' };
      }
    }

    const problems = [];

    // ---- 铅条核对 ----
    if (p.leadBars > 0) {
      if (!planRow) {
        problems.push({ kind: 'lead', reason: 'no_lead_in_source', message: '该单不含铅条预留，不能领取铅条' });
      } else {
        const mat = getMaterialRow(planRow.material_id);
        if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
        const pickedPlan = d
          .prepare('SELECT COALESCE(SUM(lead_bars),0) AS n FROM stock_issues WHERE plan_id = ?')
          .get(planRow.id).n;
        const remainingPlan = planRow.required_bars - pickedPlan;
        if (p.leadBars > remainingPlan) {
          problems.push({
            kind: 'lead', reason: 'over_remaining',
            required: planRow.required_bars, picked: pickedPlan,
            remaining: remainingPlan, requested: p.leadBars,
            message: `本次领取 ${p.leadBars} 根，超过该单尚未领出的预留 ${remainingPlan} 根`,
          });
        }
        // 实物库存必须足以覆盖全部净预留（其中含本单本次要领的部分）
        const netReserved = leadNetReservedInTx(mat.id);
        if (mat.stock < netReserved || mat.stock < p.leadBars) {
          problems.push({
            kind: 'lead', reason: 'physical_shortage',
            stock: mat.stock, requested: p.leadBars,
            message: `铅条实物库存仅 ${mat.stock} 根，不足以发放本次 ${p.leadBars} 根`,
          });
        }
      }
    }

    // ---- 玻璃逐色核对 ----
    const itemRows = orderRow
      ? d.prepare('SELECT * FROM cut_order_items WHERE order_id = ?').all(orderRow.id)
      : [];
    const itemBySheet = new Map(itemRows.map((it) => [it.sheet_id, it]));
    const glassDedup = new Map();
    for (const g of p.glass) glassDedup.set(g.sheetId, (glassDedup.get(g.sheetId) || 0) + g.count);
    for (const [sheetId, count] of glassDedup) {
      if (!orderRow) {
        problems.push({ kind: 'glass', sheetId, reason: 'no_glass_in_source', message: '该单不含玻璃预留，不能领取玻璃原片' });
        continue;
      }
      const item = itemBySheet.get(sheetId);
      if (!item) {
        problems.push({ kind: 'glass', sheetId, reason: 'sheet_not_in_order', message: `原片规格 #${sheetId} 不在该单预留颜色中` });
        continue;
      }
      const sheet = getGlassSheetRow(sheetId);
      if (!sheet) { d.exec('ROLLBACK'); return { code: 'sheet_missing', color: item.sheet_color }; }
      const pickedSheet = d
        .prepare('SELECT COALESCE(SUM(sheets_count),0) AS n FROM stock_issues WHERE order_id = ? AND sheet_id = ?')
        .get(orderRow.id, sheetId).n;
      const remaining = item.required_sheets - pickedSheet;
      if (count > remaining) {
        problems.push({
          kind: 'glass', color: item.sheet_color, sheetId, reason: 'over_remaining',
          required: item.required_sheets, picked: pickedSheet,
          remaining, requested: count,
          message: `${item.sheet_color} 本次领取 ${count} 张，超过该单尚未领出的预留 ${remaining} 张`,
        });
      }
      const netReserved = glassNetReservedInTx(sheetId);
      // 实物库存须足以覆盖全部净预留与瑕疵隔离量（已确认单据仍按原预留领料，隔离量不得被领走）
      if (sheet.stock < netReserved + sheet.quarantined || sheet.stock < count) {
        problems.push({
          kind: 'glass', color: item.sheet_color, sheetId, reason: 'physical_shortage',
          stock: sheet.stock, requested: count,
          message: `${item.sheet_color} 实物库存仅 ${sheet.stock} 张，扣除净预留与瑕疵隔离后不足以发放本次 ${count} 张`,
        });
      }
    }
    if (problems.length) {
      d.exec('ROLLBACK');
      return { code: 'invalid_issue', problems };
    }

    // ---- 扣减实物库存 ----
    if (p.leadBars > 0) {
      const r = d.prepare('UPDATE lead_materials SET stock = stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(p.leadBars, planRow.material_id);
      if (r.changes !== 1) throw new Error('铅条库存扣减失败');
    }
    for (const [sheetId, count] of glassDedup) {
      const r = d.prepare('UPDATE glass_sheets SET stock = stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(count, sheetId);
      if (r.changes !== 1) throw new Error('玻璃库存扣减失败');
    }

    // ---- 追加不可变领料行 ----
    let firstId = null;
    const sourceDesc = p.sourceType === 'lead_plan'
      ? `铅条计划 #${planRow.id}`
      : p.sourceType === 'cut_order'
        ? `裁片订单 #${orderRow.id}`
        : `整套单 #${comboRow.id}`;
    const ins = d.prepare(`INSERT INTO stock_issues
      (issue_no, source_type, plan_id, order_id, combo_id, material_id, lead_bars,
       sheet_id, sheet_color, sheets_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    if (p.leadBars > 0) {
      const info = ins.run(p.issueNo, p.sourceType,
        planRow ? planRow.id : null, orderRow ? orderRow.id : null, comboRow ? comboRow.id : null,
        planRow.material_id, p.leadBars, null, null, 0);
      firstId = info.lastInsertRowid;
      // 台账：领料出库（实物库存与净预留同步核减）
      writeLedgerRow({
        materialType: 'lead', specId: planRow.material_id, eventType: 'issue',
        deltaStock: -p.leadBars, deltaReserved: -p.leadBars,
        sourceType: 'issue', sourceId: info.lastInsertRowid,
        sourceLabel: `领料 ${p.issueNo}（${sourceDesc}）：铅条出库 ${p.leadBars} 根`,
      });
    }
    for (const [sheetId, count] of glassDedup) {
      const item = itemBySheet.get(sheetId);
      const info = ins.run(p.issueNo, p.sourceType,
        planRow ? planRow.id : null, orderRow.id, comboRow ? comboRow.id : null,
        null, 0,
        sheetId, item ? item.sheet_color : null, count);
      if (firstId === null) firstId = info.lastInsertRowid;
      writeLedgerRow({
        materialType: 'glass', specId: sheetId, eventType: 'issue',
        deltaStock: -count, deltaReserved: -count,
        sourceType: 'issue', sourceId: info.lastInsertRowid,
        sourceLabel: `领料 ${p.issueNo}（${sourceDesc}）：${item ? item.sheet_color : `#${sheetId}`} 出库 ${count} 张`,
      });
    }

    d.exec('COMMIT');
    return { code: 'ok', id: firstId, issueNo: p.issueNo };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 事务内：某铅条规格的净预留（已确认预留 − 已领出）
function leadNetReservedInTx(materialId) {
  const d = getDb();
  const gross = d
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(materialId).n;
  return gross - leadPickedForMaterial(materialId);
}

// 事务内：某玻璃规格的净预留
function glassNetReservedInTx(sheetId) {
  const d = getDb();
  const gross = d
    .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
              FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
              WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(sheetId).n;
  return gross - glassPickedForSheet(sheetId);
}

// 某计划的领料汇总（本次/累计/余留在 HTTP 层基于此组装）
function getPlanIssueStats(planId) {
  const row = getPlanRow(planId);
  if (!row) return null;
  const picked = leadPickedForPlan(planId);
  return {
    requiredBars: row.required_bars,
    pickedBars: picked,
    remainingBars: row.required_bars - picked,
  };
}

// 某裁片订单分色领料汇总
function getOrderIssueStats(orderId) {
  const row = getCutOrderRow(orderId);
  if (!row) return null;
  const items = getDb().prepare('SELECT * FROM cut_order_items WHERE order_id = ?').all(orderId);
  const colors = items.map((it) => {
    const picked = glassPickedForOrderSheet(orderId, it.sheet_id);
    return {
      sheetId: it.sheet_id,
      color: it.sheet_color,
      requiredSheets: it.required_sheets,
      pickedSheets: picked,
      remainingSheets: it.required_sheets - picked,
    };
  });
  return {
    totalRequired: colors.reduce((s, c) => s + c.requiredSheets, 0),
    totalPicked: colors.reduce((s, c) => s + c.pickedSheets, 0),
    totalRemaining: colors.reduce((s, c) => s + c.remainingSheets, 0),
    colors,
  };
}

// 整套单领料汇总（铅条取关联计划、玻璃取关联订单）
function getComboIssueStats(comboId) {
  const combo = getComboOrder(comboId);
  if (!combo) return null;
  return {
    lead: getPlanIssueStats(combo.leadPlanId),
    glass: getOrderIssueStats(combo.cutOrderId),
  };
}

// ---------- 玻璃原片瑕疵隔离（隔离 / 解除隔离，记录不可变） ----------
//
// 口径：实物库存 glass_sheets.stock 不随隔离变化；隔离只增加 quarantined。
//   隔离可划出量 = stock − 净预留 − 已隔离（当前未预留且未隔离的实物）；
//   解除不得超过隔离余额。新裁片订单与整套单的可用量均扣除隔离量。
// 一次操作在 BEGIN IMMEDIATE 事务内对一种或多种颜色原子生效；
// op_no 为调用方提供的唯一操作号：同号同内容重试返回原记录，同号异内容冲突。

function rowToQuarantine(row) {
  if (!row) return null;
  return {
    id: row.id,
    opNo: row.op_no,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function getQuarantineRow(id) {
  return getDb().prepare('SELECT * FROM glass_quarantines WHERE id = ?').get(id) || null;
}

function getQuarantineByOpNo(opNo) {
  return getDb().prepare('SELECT * FROM glass_quarantines WHERE op_no = ?').get(opNo) || null;
}

function listQuarantineItemRows(quarantineId) {
  return getDb()
    .prepare('SELECT * FROM glass_quarantine_items WHERE quarantine_id = ? ORDER BY id')
    .all(quarantineId);
}

// 某颜色规格的全部分色明细行（含隔离/解除，按操作顺序升序）
function listQuarantineItemsBySheet(sheetId) {
  return getDb()
    .prepare(`SELECT qi.* FROM glass_quarantine_items qi
              JOIN glass_quarantines q ON q.id = qi.quarantine_id
              WHERE qi.sheet_id = ? ORDER BY qi.id`).all(sheetId);
}

// 隔离单 + 分色明细（含各色笔后隔离余额）
function getQuarantineDetail(id) {
  const row = getQuarantineRow(id);
  if (!row) return null;
  return { ...rowToQuarantine(row), items: listQuarantineItemRows(id).map((it) => ({
    sheetId: it.sheet_id,
    color: it.sheet_color,
    count: it.sheets_count,
    balanceQuarantined: it.balance_quarantined,
  })) };
}

// 隔离历史：可按颜色规格过滤；按操作时间（id）倒序返回。
function listQuarantines({ sheetId = null } = {}) {
  const d = getDb();
  let rows;
  if (sheetId) {
    rows = d.prepare(`SELECT DISTINCT q.* FROM glass_quarantines q
      JOIN glass_quarantine_items qi ON qi.quarantine_id = q.id
      WHERE qi.sheet_id = ? ORDER BY q.id DESC`).all(sheetId);
  } else {
    rows = d.prepare('SELECT * FROM glass_quarantines ORDER BY id DESC').all();
  }
  return rows.map((r) => rowToQuarantine(r));
}

// 归纳一次隔离操作的“内容”（用于同号重试的幂等/冲突比较）：
// { action, reason, colors: Map(sheetId -> count) }
function quarantineContentFromRows(headerRow, itemRows) {
  const colors = new Map();
  for (const it of itemRows) colors.set(it.sheet_id, it.sheets_count);
  return { action: headerRow.action, reason: headerRow.reason, colors };
}

function quarantineContentEqual(headerRow, itemRows, p) {
  const c = quarantineContentFromRows(headerRow, itemRows);
  if (c.action !== p.action || c.reason !== p.reason) return false;
  if (c.colors.size !== p.colors.size) return false;
  for (const [sheetId, count] of p.colors) {
    if (c.colors.get(sheetId) !== count) return false;
  }
  return true;
}

// 提交隔离/解除隔离：一个 BEGIN IMMEDIATE 事务内
//   1) op_no 已存在 → 内容相同幂等返回原记录；不同返回 op_no_conflict；
//   2) hold：逐色数量 ≤ stock − 净预留 − 已隔离；release：逐色数量 ≤ 已隔离余额；
//   3) 整单原子更新各色 quarantined、追加不可变主表/明细行并写台账；
//      任一颜色不足或非法整体回滚。
// p: { opNo, action:'hold'|'release', reason, colors:Map(sheetId -> count) }
function createGlassQuarantine(p) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    // ---- 幂等 / 冲突 ----
    const dup = d.prepare('SELECT * FROM glass_quarantines WHERE op_no = ?').get(p.opNo);
    if (dup) {
      const dupItems = listQuarantineItemRows(dup.id);
      d.exec('ROLLBACK');
      if (!quarantineContentEqual(dup, dupItems, p)) {
        return {
          code: 'op_no_conflict',
          opNo: p.opNo,
          existing: {
            id: dup.id,
            action: dup.action,
            reason: dup.reason,
            colors: [...quarantineContentFromRows(dup, dupItems).colors.entries()]
              .map(([sheetId, count]) => ({ sheetId, count })),
          },
        };
      }
      return { code: 'idempotent', id: dup.id };
    }

    // ---- 逐色校验（全部通过才写入，绝不留部分） ----
    const problems = [];
    const checked = [];
    for (const [sheetId, count] of p.colors) {
      const sheet = getGlassSheetRow(sheetId);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', sheetId };
      }
      const netReserved = glassNetReservedInTx(sheetId);
      if (p.action === 'hold') {
        const free = sheet.stock - netReserved - sheet.quarantined;
        if (count > free) {
          problems.push({
            kind: 'hold', sheetId, color: sheet.color,
            stock: sheet.stock, reserved: netReserved, quarantined: sheet.quarantined,
            available: free, requested: count,
            shortage: count - free,
            reason: 'over_free',
          });
        }
      } else if (count > sheet.quarantined) {
        problems.push({
          kind: 'release', sheetId, color: sheet.color,
          quarantined: sheet.quarantined, requested: count,
          shortage: count - sheet.quarantined,
          reason: 'over_quarantined',
        });
      }
      checked.push({ sheet, count, netReserved });
    }
    if (problems.length) {
      d.exec('ROLLBACK');
      return { code: 'shortage', problems };
    }

    // ---- 写入不可变主记录 ----
    const info = d.prepare('INSERT INTO glass_quarantines (op_no, action, reason) VALUES (?, ?, ?)')
      .run(p.opNo, p.action, p.reason);
    const qid = info.lastInsertRowid;
    const insItem = d.prepare(`INSERT INTO glass_quarantine_items
      (quarantine_id, sheet_id, sheet_color, sheets_count, balance_quarantined)
      VALUES (?, ?, ?, ?, ?)`);
    const actionText = p.action === 'hold' ? '瑕疵隔离' : '解除隔离';
    for (const { sheet, count } of checked) {
      const next = p.action === 'hold' ? sheet.quarantined + count : sheet.quarantined - count;
      d.prepare("UPDATE glass_sheets SET quarantined = ?, updated_at = datetime('now') WHERE id = ?")
        .run(next, sheet.id);
      insItem.run(qid, sheet.id, sheet.color, count, next);
      // 台账：隔离/解除隔离（实物库存与净预留不变，仅隔离量增减）
      writeLedgerRow({
        materialType: 'glass', specId: sheet.id,
        eventType: p.action === 'hold' ? 'quarantine_hold' : 'quarantine_release',
        deltaStock: 0, deltaReserved: 0,
        deltaQuarantined: p.action === 'hold' ? count : -count,
        sourceType: 'quarantine', sourceId: qid,
        sourceLabel: `${actionText} ${p.opNo}：${sheet.color} ${p.action === 'hold' ? '隔离' : '解除隔离'} ${count} 张（原因：${p.reason}）`,
      });
    }

    d.exec('COMMIT');
    return { code: 'ok', id: qid };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 库存台账查询 ----------

// 按“材料类型 + 规格 + 时间范围”逐笔取台账（按 id 升序 = 发生顺序）。
// from/to 为已归一化的 'YYYY-MM-DD HH:MM:SS' 边界（含端点），null 表示不限。
function listLedgerEntries({ materialType, specId, from = null, to = null }) {
  const where = ['material_type = ?', 'spec_id = ?'];
  const args = [materialType, specId];
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at <= ?'); args.push(to); }
  return getDb()
    .prepare(`SELECT * FROM stock_ledger WHERE ${where.join(' AND ')} ORDER BY id`)
    .all(...args);
}

// ---------- 跨图纸拼片复用 ----------

function rowToPieceImport(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    targetDesignId: row.target_design_id,
    publicationId: row.publication_id,
    sourceDesignId: row.source_design_id,
    sourceVersion: row.source_version,
    rotation: row.rotation,
    dx: row.dx_mm,
    dy: row.dy_mm,
    pieceNos: JSON.parse(row.piece_nos),
    items: JSON.parse(row.items),
    draftFingerprint: row.draft_fingerprint,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
    confirmedPieces: row.confirmed_pieces ? JSON.parse(row.confirmed_pieces) : null,
  };
}

function createPieceImport(rec) {
  const info = getDb()
    .prepare(`INSERT INTO piece_imports
      (status, target_design_id, publication_id, source_design_id, source_version,
       rotation, dx_mm, dy_mm, piece_nos, items, draft_fingerprint)
      VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rec.targetDesignId, rec.publicationId, rec.sourceDesignId, rec.sourceVersion,
      rec.rotation, rec.dx, rec.dy,
      JSON.stringify(rec.pieceNos), JSON.stringify(rec.items), rec.draftFingerprint);
  return getPieceImport(info.lastInsertRowid);
}

function getPieceImportRow(id) {
  return getDb().prepare('SELECT * FROM piece_imports WHERE id = ?').get(id);
}

function getPieceImport(id) {
  return rowToPieceImport(getPieceImportRow(id));
}

function listPieceImports(filter = {}) {
  const where = [];
  const args = [];
  if (filter.targetDesignId !== undefined) {
    where.push('target_design_id = ?');
    args.push(filter.targetDesignId);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    args.push(filter.status);
  }
  const sql = 'SELECT * FROM piece_imports' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id DESC';
  return getDb().prepare(sql).all(...args).map(rowToPieceImport);
}

function deletePieceImport(id) {
  const row = getPieceImportRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status !== 'pending') return { code: 'not_pending', status: row.status };
  getDb().prepare('DELETE FROM piece_imports WHERE id = ?').run(id);
  return { code: 'ok' };
}

// 确认复用预览：在同一 BEGIN IMMEDIATE 写事务内
//   1) 预览仍 pending、目标图纸仍在；
//   2) 目标草稿指纹与预览基准一致（预览后被编辑则 draft_changed，整批不写入）；
//   3) 几何校验 fns.checkGeometry(frame, existingPieces, items) 必须通过；
//   4) 整批插入目标草稿，按片号顺序赋予目标图纸的新编号（保留原色），更新图纸时间。
// fns.checkFingerprint(existingPieces, expected) 返回 true/false；
// fns.checkGeometry(...) 返回 { ok:true } 或 { ok:false, problems:[...] }。
// 任一步失败整体回滚；确认成功后预览置为 confirmed，不能再次确认。
function confirmPieceImport(id, fns = {}) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getPieceImportRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.status === 'confirmed') {
      d.exec('ROLLBACK');
      return { code: 'already_confirmed', pieceImport: rowToPieceImport(row) };
    }

    const design = d.prepare('SELECT * FROM designs WHERE id = ?').get(row.target_design_id);
    if (!design) { d.exec('ROLLBACK'); return { code: 'target_not_found' }; }

    const existing = d.prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
      .all(row.target_design_id)
      .map((r) => ({ id: r.id, pieceNo: r.piece_no, color: r.color, polygon: JSON.parse(r.polygon) }));

    if (fns.checkFingerprint && !fns.checkFingerprint(existing, row.draft_fingerprint)) {
      d.exec('ROLLBACK');
      return { code: 'draft_changed' };
    }

    const items = JSON.parse(row.items);
    const frame = { width: design.width_mm, height: design.height_mm };
    if (fns.checkGeometry) {
      const geometry = fns.checkGeometry(frame, existing, items);
      if (!geometry || geometry.ok === false) {
        d.exec('ROLLBACK');
        return { code: 'geometry_conflict', problems: (geometry && geometry.problems) || [] };
      }
    }

    // 整批插入：顺序沿用预览 items（即请求 pieceNos 顺序），编号依次递增
    let nextNo = d.prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
      .get(design.id).n;
    const insertStmt = d.prepare(
      'INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)');
    const confirmedPieces = [];
    for (const it of items) {
      insertStmt.run(design.id, nextNo, it.color, JSON.stringify(it.polygon));
      confirmedPieces.push({
        pieceNo: nextNo,
        sourcePieceNo: it.sourcePieceNo,
        color: it.color,
        polygon: it.polygon,
      });
      nextNo += 1;
    }
    touchDesign(design.id);
    d.prepare(`UPDATE piece_imports
      SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_pieces = ?
      WHERE id = ?`).run(JSON.stringify(confirmedPieces), id);

    d.exec('COMMIT');
    return { code: 'ok', pieceImport: getPieceImport(id), confirmedPieces };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  init, getDb,
  createDesign, getDesign, listDesigns,
  listPieces, getPiece, addPiece, updatePiece, deletePiece, replaceAllPieces,
  publishVersion, getPublication, getPublicationByVersion, getPublicationById, listPublications,
  listMaterials, getMaterial, getMaterialRow, getMaterialByName, createMaterial, updateMaterial,
  createPlan, getPlan, getPlanRow, listPlans, updatePlanDraft, confirmPlan, cancelPlan, deletePlan,
  listGlassSheets, glassSheetMapByColor, getGlassSheet, getGlassSheetRow, getGlassSheetByColorRow,
  createGlassSheet, updateGlassSheetStock,
  createCutOrder, getCutOrder, getCutOrderRow, listCutOrders, listCutOrderItems, updateCutOrderDraft,
  confirmCutOrder, cancelCutOrder, deleteCutOrder,
  getReplacementByOldOrder, getReplacementByNewOrder, replaceCutOrder,
  createComboOrder, getComboOrder, listComboOrders, cancelComboOrder,
  createStocktake, updateStocktakeDraft, confirmStocktake, deleteStocktake,
  getStocktake, getStocktakeRow, listStocktakes, listStocktakeItemRows,
  leadReservedFor, glassReservedFor,
  createStockIssue, getIssueRowsByNo, listIssueRows, listAllIssueRows,
  leadPickedForMaterial, glassPickedForSheet, leadPickedForPlan, glassPickedForOrderSheet,
  orderHasIssues, planHasIssues, getPlanIssueStats, getOrderIssueStats, getComboIssueStats,
  listLedgerEntries,
  createGlassQuarantine, getQuarantineRow, getQuarantineByOpNo, getQuarantineDetail,
  listQuarantines, listQuarantineItemRows, listQuarantineItemsBySheet,
  createPieceImport, getPieceImport, getPieceImportRow, listPieceImports,
  deletePieceImport, confirmPieceImport,
};
