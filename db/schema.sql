-- Deal Journey Dashboard Schema

CREATE TABLE IF NOT EXISTS systems (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(50)  NOT NULL UNIQUE,
  status     VARCHAR(20)  NOT NULL DEFAULT 'online',  -- online | degraded | offline
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS middleware_components (
  id                 SERIAL PRIMARY KEY,
  system_id          INT          NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  name               VARCHAR(100) NOT NULL,
  latency_ms         DECIMAL(10, 2),
  throughput_per_sec DECIMAL(14, 3),
  messages_in        BIGINT,
  messages_out       BIGINT,
  status             VARCHAR(20)  NOT NULL DEFAULT 'online',
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One canonical record per deal (source of truth for deal properties)
CREATE TABLE IF NOT EXISTS deals (
  correlation_id UUID           PRIMARY KEY,       -- unique deal identifier
  volume_mwh     DECIMAL(12, 3) NOT NULL,          -- energy volume (MWh) — grid commitment
  delivery_start TIMESTAMPTZ,                      -- when energy starts flowing (snapped to 1 hour)
  product        VARCHAR(20),
  counterparty   VARCHAR(40),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()  -- when deal first entered VAT-P
);

CREATE INDEX IF NOT EXISTS idx_deals_delivery ON deals(delivery_start);
CREATE INDEX IF NOT EXISTS idx_deals_created  ON deals(created_at DESC);

-- One row per system event — the deal's journey through the pipeline
CREATE TABLE IF NOT EXISTS deal_journey (
  id             BIGSERIAL    PRIMARY KEY,
  correlation_id UUID         NOT NULL REFERENCES deals(correlation_id) ON DELETE CASCADE,
  system_id      INT          NOT NULL REFERENCES systems(id),
  status         VARCHAR(20)  NOT NULL DEFAULT 'processed',  -- processed | failed | pending
  error_message  TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()          -- when deal reached this system
);

CREATE INDEX IF NOT EXISTS idx_dj_correlation    ON deal_journey(correlation_id);
CREATE INDEX IF NOT EXISTS idx_dj_system_created ON deal_journey(system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dj_created        ON deal_journey(created_at DESC);

CREATE TABLE IF NOT EXISTS deal_aggregations (
  id             BIGSERIAL    PRIMARY KEY,
  agg_id         UUID         NOT NULL,
  stage          VARCHAR(20)  NOT NULL,
  correlation_id UUID         NOT NULL REFERENCES deals(correlation_id) ON DELETE CASCADE,
  delivery_day   DATE,
  delivery_period TIMESTAMPTZ,
  product        VARCHAR(20),
  counterparty   VARCHAR(40),
  window_start   TIMESTAMPTZ  NOT NULL,           -- start of the 1-min aggregation window
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dagg_agg_id ON deal_aggregations(agg_id);
CREATE INDEX IF NOT EXISTS idx_dagg_stage  ON deal_aggregations(stage, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_dagg_corr   ON deal_aggregations(correlation_id);
