INSERT INTO empresas (nombre, nit, correo)
SELECT DISTINCT ON (u.nit_empresa)
    u.nombre,
    u.nit_empresa,
    u.correo
FROM usuarios u
WHERE u.tipo_usuario = 'empresa'
  AND u.nit_empresa IS NOT NULL
  AND BTRIM(u.nit_empresa) <> ''
ORDER BY u.nit_empresa, u.id
ON CONFLICT (nit) DO NOTHING;

UPDATE usuarios u
SET empresa_id = e.id
FROM empresas e
WHERE u.tipo_usuario = 'empresa'
  AND u.empresa_id IS NULL
  AND u.nit_empresa = e.nit;
