CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  nit VARCHAR(32) NOT NULL UNIQUE,
  correo VARCHAR(254) NOT NULL,
  fecha_registro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  correo VARCHAR(254) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  tipo_usuario VARCHAR(20) NOT NULL,
  codigo_operario VARCHAR(50),
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  fecha_registro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  nit_empresa VARCHAR(50),
  zona_asignada VARCHAR(100),
  activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS reportes (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  tipo VARCHAR(40) NOT NULL,
  descripcion VARCHAR(100),
  ubicacion VARCHAR(300) NOT NULL,
  latitud DOUBLE PRECISION,
  longitud DOUBLE PRECISION,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  operario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imagen_url VARCHAR(500),
  localidad VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS sesiones (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL UNIQUE,
  expira TIMESTAMPTZ NOT NULL,
  creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS configuracion_sistema (
  clave VARCHAR(100) PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nombre VARCHAR(160);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nit VARCHAR(32);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS correo VARCHAR(254);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS fecha_registro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_operario VARCHAR(50);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nit_empresa VARCHAR(50);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona_asignada VARCHAR(100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_registro TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE usuarios SET activo = TRUE WHERE activo IS NULL;
ALTER TABLE usuarios ALTER COLUMN activo SET DEFAULT TRUE;
ALTER TABLE usuarios ALTER COLUMN activo SET NOT NULL;
UPDATE usuarios SET correo = LOWER(BTRIM(correo)) WHERE correo IS NOT NULL;
UPDATE usuarios SET nombre = BTRIM(nombre) WHERE nombre IS NOT NULL;
UPDATE reportes SET estado = LOWER(BTRIM(estado)) WHERE estado IS NOT NULL;
UPDATE reportes SET estado = 'pendiente' WHERE estado IS NULL OR BTRIM(estado) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_tipo_usuario_check'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_tipo_usuario_check
      CHECK (tipo_usuario IN ('ciudadano', 'operario', 'empresa', 'admin')) NOT VALID;
  END IF;
END $$;
ALTER TABLE usuarios VALIDATE CONSTRAINT usuarios_tipo_usuario_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reportes_estado_check'
  ) THEN
    ALTER TABLE reportes
      ADD CONSTRAINT reportes_estado_check
      CHECK (estado IN ('pendiente', 'en proceso', 'completado')) NOT VALID;
  END IF;
END $$;
ALTER TABLE reportes VALIDATE CONSTRAINT reportes_estado_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_empresa_fk'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_empresa_fk
      FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reportes_usuario_fk'
  ) THEN
    ALTER TABLE reportes
      ADD CONSTRAINT reportes_usuario_fk
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reportes_operario_fk'
  ) THEN
    ALTER TABLE reportes
      ADD CONSTRAINT reportes_operario_fk
      FOREIGN KEY (operario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS empresas_nit_unique_idx
  ON empresas (nit);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_correo_unique_idx
  ON usuarios (LOWER(correo));
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_codigo_operario_unique_idx
  ON usuarios (codigo_operario)
  WHERE codigo_operario IS NOT NULL AND BTRIM(codigo_operario) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_nit_empresa_unique_idx
  ON usuarios (nit_empresa)
  WHERE nit_empresa IS NOT NULL AND BTRIM(nit_empresa) <> '';
CREATE INDEX IF NOT EXISTS usuarios_empresa_tipo_idx ON usuarios (empresa_id, tipo_usuario);
CREATE INDEX IF NOT EXISTS usuarios_activo_idx ON usuarios (activo) WHERE activo = TRUE;
CREATE INDEX IF NOT EXISTS reportes_usuario_fecha_idx ON reportes (usuario_id, fecha DESC);
CREATE INDEX IF NOT EXISTS reportes_operario_fecha_idx ON reportes (operario_id, fecha DESC);
CREATE INDEX IF NOT EXISTS reportes_localidad_estado_idx ON reportes (localidad, estado);
CREATE INDEX IF NOT EXISTS reportes_fecha_idx ON reportes (fecha DESC);
CREATE INDEX IF NOT EXISTS sesiones_token_idx ON sesiones (token);
CREATE INDEX IF NOT EXISTS sesiones_usuario_expira_idx ON sesiones (usuario_id, expira DESC);

INSERT INTO configuracion_sistema (clave, valor)
VALUES
  ('limite_reportes_diarios', '5'),
  ('limite_ruta', '15'),
  ('retencion_dias', '90'),
  ('distancia_gps_maxima', '20')
ON CONFLICT (clave) DO NOTHING;
