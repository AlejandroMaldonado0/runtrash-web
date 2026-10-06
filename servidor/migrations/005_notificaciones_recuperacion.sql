-- Centro de notificaciones y recuperacion de contrasena

CREATE TABLE IF NOT EXISTS notificaciones (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo VARCHAR(40) NOT NULL DEFAULT 'info',
  titulo VARCHAR(160) NOT NULL,
  mensaje VARCHAR(400) NOT NULL DEFAULT '',
  referencia_tipo VARCHAR(40),
  referencia_id INTEGER,
  leida BOOLEAN NOT NULL DEFAULT FALSE,
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_recuperaciones (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash VARCHAR(255) NOT NULL,
  expira TIMESTAMPTZ NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0,
  usado BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notificaciones_usuario_fecha_idx
  ON notificaciones (usuario_id, fecha DESC);
CREATE INDEX IF NOT EXISTS notificaciones_usuario_leida_idx
  ON notificaciones (usuario_id, leida) WHERE leida = FALSE;
CREATE INDEX IF NOT EXISTS password_recuperaciones_usuario_idx
  ON password_recuperaciones (usuario_id, expira DESC);

-- Limpieza de codigos de recuperacion vencidos o ya usados
DELETE FROM password_recuperaciones
WHERE usado = TRUE OR expira < NOW() - INTERVAL '1 day';
