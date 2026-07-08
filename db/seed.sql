-- Seed: systems
INSERT INTO systems (name, status) VALUES
  ('PACE',  'online'),
  ('VAT-P', 'online'),
  ('NEON',  'online'),
  ('Endur', 'degraded')
ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW();

-- Seed: middleware components
DO $$
DECLARE
  v_pace  INT := (SELECT id FROM systems WHERE name = 'PACE');
  v_vatp  INT := (SELECT id FROM systems WHERE name = 'VAT-P');
  v_neon  INT := (SELECT id FROM systems WHERE name = 'NEON');
  v_endur INT := (SELECT id FROM systems WHERE name = 'Endur');
BEGIN
  DELETE FROM middleware_components;

  -- PACE
  INSERT INTO middleware_components (system_id, name, latency_ms, throughput_per_sec, status) VALUES
    (v_pace, 'Deal Intake',    0.8,   6100.25, 'online'),
    (v_pace, 'Validation Svc', 2.1,   5300.87, 'online'),
    (v_pace, 'Enrichment Bus', 4.3,   4800.12, 'online');

  -- VAT-P
  INSERT INTO middleware_components (system_id, name, latency_ms, throughput_per_sec, status) VALUES
    (v_vatp, 'Message Queue',  1.7,   5761.38, 'online'),
    (v_vatp, 'Trade Validator',10.2,  3649.81, 'online'),
    (v_vatp, 'Price Feed',     39.1,  2850.09, 'online');

  -- NEON
  INSERT INTO middleware_components (system_id, name, latency_ms, throughput_per_sec, status) VALUES
    (v_neon, 'Order Router',   1.0,   4022.68, 'online'),
    (v_neon, 'Risk Engine',    4.7,   4493.73, 'online'),
    (v_neon, 'Position Mgr',   4.7,   3573.69, 'online');

  -- Endur
  INSERT INTO middleware_components (system_id, name, latency_ms, throughput_per_sec, status) VALUES
    (v_endur, 'Settlement Eng.', 169.8, 818.22, 'degraded'),
    (v_endur, 'Book Manager',    5.5,   3293.13, 'online'),
    (v_endur, 'Confirm. Service', NULL, NULL,    'offline');
END $$;
